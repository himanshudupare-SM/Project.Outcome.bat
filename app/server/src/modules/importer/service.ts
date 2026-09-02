import {
  type DryRunReport,
  type ImportMapping,
  type ImportRun,
  type ImportStats,
  type JiraCredentials,
  type JiraProjectSummary,
  type StatusCategory,
} from '@outcome/shared';
import { orgDb, withOrg, type Queryable } from '../../platform/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.js';
import { logger } from '../../platform/logger.js';
import type { OrgCtx } from '../../platform/ctx.js';
import { requireOrgRole, requireProjectRole } from '../auth/policy.js';
import { recordEvent } from '../activity/service.js';
import { notify } from '../notifications/service.js';
import { resolveProject } from '../../http/context.js';
import * as projectsService from '../projects/service.js';
import * as tasksService from '../tasks/service.js';
import { JiraClient, httpTransport, type JiraIssue, type JiraTransport } from './jira-client.js';

/**
 * Jira import. Deliberately not a Jira clone: it maps Jira's model onto ours
 * and reports, per record, what happened. Anything it cannot represent is
 * listed rather than silently dropped (see the parity gap report in docs).
 */

type TransportFactory = (creds: JiraCredentials) => Promise<JiraTransport>;
let transportFactory: TransportFactory = httpTransport;

/** Tests inject a fixture transport. */
export function setJiraTransportFactory(factory: TransportFactory | null): void {
  transportFactory = factory ?? httpTransport;
}

function emptyStats(): ImportStats {
  return { imported: {}, skipped: {}, failed: {}, duplicates: 0, unmappedStatuses: [], unmappedUsers: [] };
}

const bump = (bucket: Record<string, number>, key: string, by = 1): void => {
  bucket[key] = (bucket[key] ?? 0) + by;
};

export async function listJiraProjects(
  ctx: OrgCtx,
  credentials: JiraCredentials,
): Promise<JiraProjectSummary[]> {
  requireOrgRole(ctx, 'admin');
  const client = new JiraClient(await transportFactory(credentials));
  return client.listProjects();
}

/** Suggest a mapping so the review screen starts from something sensible. */
export async function suggestMapping(
  ctx: OrgCtx,
  credentials: JiraCredentials,
  projectKey: string,
): Promise<{
  statuses: Record<string, StatusCategory>;
  priorities: Record<string, 'urgent' | 'high' | 'medium' | 'low' | 'none'>;
  users: Record<string, string | null>;
  userNames: Record<string, string>;
  unmapped: { statuses: string[]; users: string[] };
}> {
  requireOrgRole(ctx, 'admin');
  const client = new JiraClient(await transportFactory(credentials));
  const issues = await client.listIssues(projectKey);

  const statuses: Record<string, StatusCategory> = {};
  const priorities: Record<string, 'urgent' | 'high' | 'medium' | 'low' | 'none'> = {};
  const users: Record<string, string | null> = {};
  const userNames: Record<string, string> = {};
  const unmappedStatuses: string[] = [];
  const unmappedUsers: string[] = [];

  const { rows: members } = await orgDb(ctx.orgId).query<{ id: string; name: string; email: string }>(
    `SELECT u.id, u.name, u.email FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND u.deleted_at IS NULL`,
    [ctx.orgId],
  );

  for (const issue of issues) {
    if (!(issue.statusName in statuses)) {
      const guess = guessStatusCategory(issue.statusName);
      if (guess) statuses[issue.statusName] = guess;
      else unmappedStatuses.push(issue.statusName);
    }
    if (issue.priorityName && !(issue.priorityName in priorities)) {
      priorities[issue.priorityName] = guessPriority(issue.priorityName);
    }
    if (issue.assigneeAccountId && !(issue.assigneeAccountId in users)) {
      userNames[issue.assigneeAccountId] = issue.assigneeName ?? issue.assigneeAccountId;
      const match = members.find(
        (m) => m.name.toLowerCase() === (issue.assigneeName ?? '').toLowerCase(),
      );
      users[issue.assigneeAccountId] = match?.id ?? null;
      if (!match) unmappedUsers.push(issue.assigneeName ?? issue.assigneeAccountId);
    }
  }
  return {
    statuses,
    priorities,
    users,
    userNames,
    unmapped: { statuses: [...new Set(unmappedStatuses)], users: [...new Set(unmappedUsers)] },
  };
}

function guessStatusCategory(name: string): StatusCategory | null {
  const lower = name.toLowerCase();
  if (/(^|\b)(done|closed|resolved|complete|shipped)\b/.test(lower)) return 'done';
  if (/\b(blocked|impediment|on hold)\b/.test(lower)) return 'blocked';
  if (/\b(review|qa|testing|verify)\b/.test(lower)) return 'in_review';
  if (/\b(in progress|doing|development|started)\b/.test(lower)) return 'in_progress';
  if (/\b(to ?do|selected|ready|open|new)\b/.test(lower)) return 'todo';
  if (/\b(backlog|icebox|triage)\b/.test(lower)) return 'backlog';
  return null;
}

function guessPriority(name: string): 'urgent' | 'high' | 'medium' | 'low' | 'none' {
  const lower = name.toLowerCase();
  if (/\b(blocker|critical|highest|p0)\b/.test(lower)) return 'urgent';
  if (/\b(major|high|p1)\b/.test(lower)) return 'high';
  if (/\b(medium|normal|p2)\b/.test(lower)) return 'medium';
  if (/\b(minor|low|trivial|lowest|p3|p4)\b/.test(lower)) return 'low';
  return 'none';
}

interface RunRow {
  id: string;
  status: ImportRun['status'];
  mapping: unknown;
  stats: unknown;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

async function mapRun(ctx: OrgCtx, row: RunRow): Promise<ImportRun> {
  const { rows: counts } = await orgDb(ctx.orgId).query<{ total: number; processed: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status <> 'pending')::int AS processed
       FROM import_items WHERE import_run_id = $1`,
    [row.id],
  );
  const stats = (row.stats as ImportStats | null) ?? emptyStats();
  return {
    id: row.id,
    kind: 'jira',
    status: row.status,
    mapping: (row.mapping as ImportMapping | null) ?? null,
    stats,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    totalItems: counts[0]?.total ?? 0,
    processedItems: counts[0]?.processed ?? 0,
  };
}

/**
 * Fetch, plan and (unless dryRun) write. Everything is planned before any
 * write, so the preview the user approved is the plan that executes.
 */
export async function runImport(
  ctx: OrgCtx,
  credentials: JiraCredentials,
  mapping: ImportMapping,
  dryRun: boolean,
): Promise<{ run: ImportRun; report: DryRunReport }> {
  requireOrgRole(ctx, 'admin');

  const client = new JiraClient(await transportFactory(credentials));
  const issues = await client.listIssues(mapping.projectKey);
  if (issues.length === 0) {
    throw new ValidationError(`Jira project ${mapping.projectKey} has no issues to import`);
  }

  // Resolve or create the destination project.
  let target: { id: string; key: string; role: 'lead' | 'member' | 'viewer' | null };
  let targetName: string;
  if (mapping.targetProjectId) {
    const resolved = await resolveProject(ctx, mapping.targetProjectId);
    requireProjectRole(ctx, resolved.role, 'lead');
    target = resolved;
    const { rows } = await orgDb(ctx.orgId).query<{ name: string }>(
      'SELECT name FROM projects WHERE id = $1',
      [resolved.id],
    );
    targetName = rows[0]?.name ?? resolved.key;
  } else if (dryRun) {
    // Nothing is created during a dry run, so describe the intent instead.
    target = { id: '00000000-0000-0000-0000-000000000000', key: mapping.projectKey, role: 'lead' };
    targetName = `${mapping.projectKey} (new project)`;
  } else {
    const created = await projectsService.createProject(ctx, {
      name: `${mapping.projectKey} (imported from Jira)`,
      description: `Imported from Jira project ${mapping.projectKey}.`,
      key: mapping.projectKey.slice(0, 10),
      teamId: null,
      leadId: ctx.userId,
      targetDate: null,
    });
    target = { id: created.id, key: created.key, role: 'lead' };
    targetName = created.name;
  }

  // Existing titles for duplicate detection.
  const existingTitles = new Set<string>();
  if (mapping.targetProjectId) {
    const { rows } = await orgDb(ctx.orgId).query<{ title: string }>(
      'SELECT lower(title) AS title FROM tasks WHERE project_id = $1 AND deleted_at IS NULL',
      [target.id],
    );
    for (const row of rows) existingTitles.add(row.title);
  }

  const report: DryRunReport = {
    runId: '00000000-0000-0000-0000-000000000000',
    targetProjectId: mapping.targetProjectId ? target.id : null,
    targetProjectName: targetName,
    willCreate: {},
    conflicts: [],
    unsupported: [],
  };
  const stats = emptyStats();

  const epics = issues.filter((i) => i.issueType.toLowerCase() === 'epic');
  const parents = issues.filter((i) => !i.isSubtask && i.issueType.toLowerCase() !== 'epic');
  const subtasks = mapping.includeSubtasks ? issues.filter((i) => i.isSubtask) : [];

  // ---- plan ----
  for (const issue of issues) {
    if (!(issue.statusName in mapping.statuses)) {
      report.conflicts.push({
        kind: 'unmapped_status',
        externalId: issue.key,
        detail: `Status "${issue.statusName}" is not mapped`,
        resolution: 'Imported into Backlog',
      });
      if (!stats.unmappedStatuses.includes(issue.statusName)) {
        stats.unmappedStatuses.push(issue.statusName);
      }
    }
    if (issue.assigneeAccountId && mapping.users[issue.assigneeAccountId] == null) {
      const label = issue.assigneeName ?? issue.assigneeAccountId;
      report.conflicts.push({
        kind: 'unmapped_user',
        externalId: issue.key,
        detail: `Assignee "${label}" has no matching account`,
        resolution: 'Imported unassigned',
      });
      if (!stats.unmappedUsers.includes(label)) stats.unmappedUsers.push(label);
    }
    if (existingTitles.has(issue.summary.toLowerCase())) {
      report.conflicts.push({
        kind: 'duplicate_title',
        externalId: issue.key,
        detail: `A task titled "${issue.summary}" already exists`,
        resolution: 'Skipped',
      });
      stats.duplicates += 1;
    }
    if (issue.attachmentCount > 0) {
      report.unsupported.push(
        `${issue.key}: ${issue.attachmentCount} attachment(s) — Jira attachments are not imported`,
      );
    }
    if (issue.isSubtask && !mapping.includeSubtasks) {
      report.conflicts.push({
        kind: 'unsupported',
        externalId: issue.key,
        detail: 'Subtask excluded by the mapping',
        resolution: 'Skipped',
      });
    }
  }
  bump(report.willCreate, 'epic', epics.length);
  bump(
    report.willCreate,
    'task',
    parents.filter((i) => !existingTitles.has(i.summary.toLowerCase())).length,
  );
  bump(report.willCreate, 'subtask', subtasks.length);
  if (mapping.includeComments) {
    bump(report.willCreate, 'comment', issues.reduce((sum, i) => sum + i.comments.length, 0));
  }

  // ---- persist the run so progress and results are inspectable ----
  const run = await withOrg(ctx.orgId, async (tx) => {
    const { rows } = await tx.query<RunRow>(
      `INSERT INTO import_runs (org_id, kind, status, mapping, stats, started_by)
       VALUES ($1, 'jira', $2, $3, $4, $5)
       RETURNING id, status, mapping, stats, created_at, updated_at, finished_at`,
      [
        ctx.orgId,
        dryRun ? 'dry_run' : 'running',
        JSON.stringify(mapping),
        JSON.stringify(stats),
        ctx.userId,
      ],
    );
    const row = rows[0]!;
    for (const issue of issues) {
      await tx.query(
        `INSERT INTO import_items (import_run_id, entity_type, external_id, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (import_run_id, entity_type, external_id) DO NOTHING`,
        [
          row.id,
          issue.issueType.toLowerCase() === 'epic' ? 'epic' : issue.isSubtask ? 'subtask' : 'task',
          issue.key,
          JSON.stringify({ summary: issue.summary, status: issue.statusName }),
        ],
      );
    }
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'import_run',
      entityId: row.id,
      projectId: mapping.targetProjectId ? target.id : null,
      action: dryRun ? 'dry_run_started' : 'started',
      data: { jiraProject: mapping.projectKey, issueCount: issues.length },
    });
    return row;
  });
  report.runId = run.id;

  if (dryRun) {
    await withOrg(ctx.orgId, async (tx) => {
      await tx.query(
        `UPDATE import_runs SET status = 'completed', stats = $2, finished_at = now(), updated_at = now()
          WHERE id = $1`,
        [run.id, JSON.stringify(stats)],
      );
    });
    return { run: await mapRun(ctx, { ...run, status: 'completed' }), report };
  }

  // ---- execute ----
  await executeImport(ctx, run.id, target, mapping, { epics, parents, subtasks }, existingTitles, stats);
  const { rows } = await orgDb(ctx.orgId).query<RunRow>(
    `SELECT id, status, mapping, stats, created_at, updated_at, finished_at
       FROM import_runs WHERE id = $1`,
    [run.id],
  );
  return { run: await mapRun(ctx, rows[0]!), report };
}

async function executeImport(
  ctx: OrgCtx,
  runId: string,
  target: { id: string; key: string; role: 'lead' | 'member' | 'viewer' | null },
  mapping: ImportMapping,
  grouped: { epics: JiraIssue[]; parents: JiraIssue[]; subtasks: JiraIssue[] },
  existingTitles: Set<string>,
  stats: ImportStats,
): Promise<void> {
  const { rows: statuses } = await orgDb(ctx.orgId).query<{ id: string; category: StatusCategory }>(
    'SELECT id, category FROM statuses WHERE project_id = $1',
    [target.id],
  );
  const statusByCategory = new Map(statuses.map((s) => [s.category, s.id]));
  const fallbackStatus = statusByCategory.get('backlog') ?? statuses[0]?.id;
  if (!fallbackStatus) throw new ValidationError('The destination project has no statuses');

  const statusIdFor = (name: string): string => {
    const category = mapping.statuses[name];
    return (category && statusByCategory.get(category)) ?? fallbackStatus;
  };
  const labelCache = new Map<string, string>();
  const epicIdByKey = new Map<string, string>();
  const taskIdByKey = new Map<string, string>();

  const markItem = async (
    entityType: string,
    externalId: string,
    status: 'imported' | 'skipped' | 'failed',
    targetId: string | null,
    error: string | null,
  ): Promise<void> => {
    await withOrg(ctx.orgId, async (tx) => {
      await tx.query(
        `UPDATE import_items
            SET status = $3, target_id = $4, error = $5, attempts = attempts + 1, updated_at = now()
          WHERE import_run_id = $1 AND external_id = $2 AND entity_type = $6`,
        [runId, externalId, status, targetId, error, entityType],
      );
    });
  };

  const resolveLabels = async (names: string[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const name of names) {
      const key = name.toLowerCase();
      let id = labelCache.get(key);
      if (!id) {
        const label = await tasksService.createLabel(ctx, name, '#6b7280');
        id = label.id;
        labelCache.set(key, id);
      }
      ids.push(id);
    }
    return ids;
  };

  // Epics become epics.
  for (const issue of grouped.epics) {
    try {
      const epic = await projectsService.createEpic(ctx, target, {
        name: issue.summary,
        description: issue.description,
        targetDate: issue.dueDate,
      });
      epicIdByKey.set(issue.key, epic.id);
      bump(stats.imported, 'epic');
      await markItem('epic', issue.key, 'imported', epic.id, null);
    } catch (err) {
      bump(stats.failed, 'epic');
      await markItem('epic', issue.key, 'failed', null, (err as Error).message);
      logger.warn({ err, issue: issue.key }, 'epic import failed');
    }
  }

  // Then top-level issues, then subtasks (which need their parents).
  for (const [entityType, list] of [
    ['task', grouped.parents],
    ['subtask', grouped.subtasks],
  ] as const) {
    for (const issue of list) {
      if (existingTitles.has(issue.summary.toLowerCase())) {
        bump(stats.skipped, entityType);
        await markItem(entityType, issue.key, 'skipped', null, 'A task with this title already exists');
        continue;
      }
      const parentId = issue.parentKey ? taskIdByKey.get(issue.parentKey) : undefined;
      if (entityType === 'subtask' && issue.parentKey && !parentId) {
        bump(stats.skipped, entityType);
        await markItem(entityType, issue.key, 'skipped', null, `Parent ${issue.parentKey} was not imported`);
        continue;
      }
      try {
        const task = await tasksService.createTask(
          ctx,
          target,
          {
            title: issue.summary,
            description: buildDescription(issue),
            statusId: statusIdFor(issue.statusName),
            priority: issue.priorityName ? (mapping.priorities[issue.priorityName] ?? 'none') : 'none',
            assigneeId: issue.assigneeAccountId ? (mapping.users[issue.assigneeAccountId] ?? null) : null,
            dueDate: issue.dueDate,
            estimateDays: null,
            epicId: issue.epicKey ? (epicIdByKey.get(issue.epicKey) ?? null) : null,
            parentId: parentId ?? null,
            labelIds: await resolveLabels(issue.labels),
          },
          { source: 'import' },
        );
        taskIdByKey.set(issue.key, task.id);
        bump(stats.imported, entityType);
        await markItem(entityType, issue.key, 'imported', task.id, null);

        if (mapping.includeComments) {
          for (const comment of issue.comments) {
            try {
              // Jira authors have no account here, so attribution is preserved
              // in the body rather than faked against a local user.
              await addImportedComment(ctx, task.id, comment);
              bump(stats.imported, 'comment');
            } catch (err) {
              bump(stats.failed, 'comment');
              logger.warn({ err, issue: issue.key }, 'comment import failed');
            }
          }
        }
      } catch (err) {
        bump(stats.failed, entityType);
        await markItem(entityType, issue.key, 'failed', null, (err as Error).message);
        logger.warn({ err, issue: issue.key }, 'issue import failed');
      }
    }
  }

  // Dependencies last: both ends must exist.
  for (const issue of [...grouped.parents, ...grouped.subtasks]) {
    const blockedId = taskIdByKey.get(issue.key);
    if (!blockedId) continue;
    for (const blockingKey of issue.blockedByKeys) {
      const blockingId = taskIdByKey.get(blockingKey);
      if (!blockingId) continue;
      try {
        await tasksService.addDependency(ctx, blockedId, blockingId);
        bump(stats.imported, 'dependency');
      } catch (err) {
        // A Jira link that would cycle here is reported, not fatal.
        if (err instanceof ConflictError) {
          bump(stats.skipped, 'dependency');
          continue;
        }
        bump(stats.failed, 'dependency');
      }
    }
  }

  const failedTotal = Object.values(stats.failed).reduce((a, b) => a + b, 0);
  await withOrg(ctx.orgId, async (tx) => {
    await tx.query(
      `UPDATE import_runs SET status = $2, stats = $3, finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [runId, failedTotal > 0 ? 'completed_with_errors' : 'completed', JSON.stringify(stats)],
    );
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'system',
      actorId: ctx.userId,
      entityType: 'import_run',
      entityId: runId,
      projectId: target.id,
      action: 'completed',
      data: { stats: stats as unknown as Record<string, unknown> },
    });
    await notify(tx, {
      orgId: ctx.orgId,
      userIds: [ctx.userId],
      type: 'import.finished',
      actorId: null,
      projectId: target.id,
      data: { runId, imported: stats.imported, failed: stats.failed },
    });
  });
}

/** Keep Jira's own reference and reporter, so imported work stays traceable. */
function buildDescription(issue: JiraIssue): string {
  const header = `Imported from Jira ${issue.key}${issue.reporterName ? ` (reported by ${issue.reporterName})` : ''}.`;
  return issue.description ? `${issue.description}\n\n---\n${header}` : header;
}

async function addImportedComment(
  ctx: OrgCtx,
  taskId: string,
  comment: { author: string; body: string; createdAt: string },
): Promise<void> {
  await withOrg(ctx.orgId, async (tx: Queryable) => {
    await tx.query(
      `INSERT INTO comments (org_id, task_id, author_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ctx.orgId,
        taskId,
        ctx.userId,
        `**${comment.author}** wrote in Jira on ${comment.createdAt.slice(0, 10)}:\n\n${comment.body}`,
        comment.createdAt,
      ],
    );
  });
}

export async function listRuns(ctx: OrgCtx): Promise<ImportRun[]> {
  requireOrgRole(ctx, 'admin');
  const { rows } = await orgDb(ctx.orgId).query<RunRow>(
    `SELECT id, status, mapping, stats, created_at, updated_at, finished_at
       FROM import_runs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [ctx.orgId],
  );
  return Promise.all(rows.map((row) => mapRun(ctx, row)));
}

export async function getRun(ctx: OrgCtx, id: string): Promise<ImportRun> {
  requireOrgRole(ctx, 'admin');
  const { rows } = await orgDb(ctx.orgId).query<RunRow>(
    `SELECT id, status, mapping, stats, created_at, updated_at, finished_at
       FROM import_runs WHERE id = $1 AND org_id = $2`,
    [id, ctx.orgId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('Import run');
  return mapRun(ctx, row);
}

export async function listItems(ctx: OrgCtx, runId: string, onlyFailed = false) {
  await getRun(ctx, runId);
  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    entity_type: string;
    external_id: string;
    status: string;
    target_id: string | null;
    error: string | null;
    attempts: number;
    payload: { summary?: string };
  }>(
    `SELECT id, entity_type, external_id, status, target_id, error, attempts, payload
       FROM import_items WHERE import_run_id = $1 ${onlyFailed ? "AND status = 'failed'" : ''}
      ORDER BY entity_type, external_id
      LIMIT 500`,
    [runId],
  );
  return rows.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    externalId: r.external_id,
    status: r.status,
    targetId: r.target_id,
    error: r.error,
    attempts: r.attempts,
    summary: r.payload?.summary ?? '',
  }));
}

/** Retry only the records that failed, using the run's stored mapping. */
export async function retryFailed(
  ctx: OrgCtx,
  runId: string,
  credentials: JiraCredentials,
): Promise<ImportRun> {
  requireOrgRole(ctx, 'admin');
  const run = await getRun(ctx, runId);
  if (!run.mapping) throw new ValidationError('That run has no stored mapping to retry with');
  const failed = await listItems(ctx, runId, true);
  if (failed.length === 0) throw new ValidationError('That run has no failed records to retry');

  const client = new JiraClient(await transportFactory(credentials));
  const issues = await client.listIssues(run.mapping.projectKey);
  const wanted = new Set(failed.map((f) => f.externalId));
  const retryIssues = issues.filter((i) => wanted.has(i.key));

  const target = run.mapping.targetProjectId
    ? await resolveProject(ctx, run.mapping.targetProjectId)
    : null;
  if (!target) throw new ValidationError('The destination project for that run no longer exists');
  requireProjectRole(ctx, target.role, 'lead');

  const stats = run.stats;
  await executeImport(
    ctx,
    runId,
    target,
    run.mapping,
    {
      epics: retryIssues.filter((i) => i.issueType.toLowerCase() === 'epic'),
      parents: retryIssues.filter((i) => !i.isSubtask && i.issueType.toLowerCase() !== 'epic'),
      subtasks: retryIssues.filter((i) => i.isSubtask),
    },
    new Set(),
    stats,
  );
  return getRun(ctx, runId);
}

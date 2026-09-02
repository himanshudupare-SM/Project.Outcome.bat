import {
  approveBraindumpInput,
  extractionResultSchema,
  type ApproveBraindumpInput,
  type Braindump,
  type CreateBraindumpInput,
  type ExtractionResult,
  type Task,
} from '@outcome/shared';
import { orgDb, withOrg, type Queryable } from '../../platform/db.js';
import {
  AiUnavailableError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../platform/errors.js';
import { config } from '../../platform/config.js';
import { logger } from '../../platform/logger.js';
import type { OrgCtx } from '../../platform/ctx.js';
import { requireProjectRole } from '../auth/policy.js';
import { recordEvent } from '../activity/service.js';
import { notify } from '../notifications/service.js';
import { resolveProject } from '../../http/context.js';
import * as tasksService from '../tasks/service.js';
import { aiProvider } from './index.js';
import {
  BRAINDUMP_PROMPT_VERSION,
  braindumpSchema,
  braindumpSystem,
  braindumpUser,
} from './prompts/braindump.js';

const CONTEXT_TASK_LIMIT = 60;

interface BraindumpRow {
  id: string;
  user_id: string;
  project_id: string | null;
  source: 'text' | 'voice';
  raw_input: string;
  status: Braindump['status'];
  proposal: unknown;
  error: string | null;
  model: string | null;
  prompt_version: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: BraindumpRow): Braindump {
  const parsed = row.proposal ? extractionResultSchema.safeParse(row.proposal) : null;
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    source: row.source,
    rawInput: row.raw_input,
    status: row.status,
    proposal: parsed?.success ? parsed.data : null,
    error: row.error,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Per-org daily call budget, so a runaway client cannot burn the quota. */
async function assertBudget(ctx: OrgCtx): Promise<void> {
  const { rows } = await orgDb(ctx.orgId).query<{ n: number }>(
    `SELECT count(*)::int AS n FROM braindumps
      WHERE org_id = $1 AND created_at > now() - interval '1 day'`,
    [ctx.orgId],
  );
  if ((rows[0]?.n ?? 0) >= config().AI_DAILY_CALL_BUDGET) {
    throw new RateLimitedError(
      "This organization has reached today's AI processing limit. Try again tomorrow, or add tasks manually.",
    );
  }
}

/**
 * Run extraction. The dump row is created first so a failure is visible and
 * retryable rather than lost, and the raw input is always preserved.
 */
export async function createBraindump(
  ctx: OrgCtx,
  input: CreateBraindumpInput,
): Promise<Braindump> {
  if (input.text.length > config().AI_MAX_INPUT_CHARS) {
    throw new ValidationError(
      `That is longer than the ${config().AI_MAX_INPUT_CHARS.toLocaleString()} character limit. Split it into a couple of dumps.`,
      { text: 'Too long' },
    );
  }
  await assertBudget(ctx);

  let projectId: string | null = null;
  let projectName: string | null = null;
  if (input.projectId) {
    const project = await resolveProject(ctx, input.projectId);
    requireProjectRole(ctx, project.role, 'member');
    projectId = project.id;
    const { rows } = await orgDb(ctx.orgId).query<{ name: string }>(
      'SELECT name FROM projects WHERE id = $1',
      [project.id],
    );
    projectName = rows[0]?.name ?? null;
  }

  const created = await withOrg(ctx.orgId, async (tx) => {
    const { rows } = await tx.query<BraindumpRow>(
      `INSERT INTO braindumps (org_id, user_id, project_id, source, raw_input, status)
       VALUES ($1, $2, $3, $4, $5, 'processing')
       RETURNING *`,
      [ctx.orgId, ctx.userId, projectId, input.source, input.text],
    );
    const row = rows[0]!;
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'braindump',
      entityId: row.id,
      projectId,
      action: 'created',
      data: { source: input.source, chars: input.text.length },
    });
    return row;
  });

  const context = await loadContext(ctx, projectId);
  const provider = aiProvider();

  try {
    const response = await provider.structured({
      promptVersion: BRAINDUMP_PROMPT_VERSION,
      task: 'braindump',
      system: braindumpSystem,
      user: braindumpUser({
        text: input.text,
        today: context.today,
        timezone: context.timezone,
        projectName,
        existingTasks: context.existingTasks,
        members: context.members,
      }),
      schema: braindumpSchema,
    });

    const proposal = sanitizeProposal(response.value);

    const stored = await withOrg(ctx.orgId, async (tx) => {
      const { rows } = await tx.query<BraindumpRow>(
        `UPDATE braindumps
            SET status = 'ready', proposal = $2, model = $3, prompt_version = $4,
                input_tokens = $5, output_tokens = $6, error = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [
          created.id,
          JSON.stringify(proposal),
          response.model,
          BRAINDUMP_PROMPT_VERSION,
          response.inputTokens,
          response.outputTokens,
        ],
      );
      const row = rows[0]!;
      await recordEvent(tx, {
        orgId: ctx.orgId,
        actorType: 'ai',
        actorId: ctx.userId,
        entityType: 'braindump',
        entityId: created.id,
        projectId,
        action: 'extracted',
        data: {
          model: response.model,
          promptVersion: BRAINDUMP_PROMPT_VERSION,
          taskCount: proposal.tasks.length,
          questionCount: proposal.questions.length,
          attempts: response.attempts,
        },
      });
      await notify(tx, {
        orgId: ctx.orgId,
        userIds: [ctx.userId],
        type: 'braindump.ready',
        actorId: null,
        projectId,
        data: { braindumpId: created.id, taskCount: proposal.tasks.length },
      });
      return row;
    });
    return mapRow(stored);
  } catch (err) {
    const message =
      err instanceof AiUnavailableError
        ? (err.detail ?? err.title)
        : 'Extraction failed unexpectedly.';
    logger.error({ err, braindumpId: created.id }, 'braindump extraction failed');
    await withOrg(ctx.orgId, async (tx) => {
      await tx.query(
        `UPDATE braindumps SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [created.id, message],
      );
      await recordEvent(tx, {
        orgId: ctx.orgId,
        actorType: 'system',
        actorId: null,
        entityType: 'braindump',
        entityId: created.id,
        projectId,
        action: 'failed',
        data: { error: message },
      });
    });
    throw err instanceof AiUnavailableError ? err : new AiUnavailableError(message);
  }
}

/**
 * Defence in depth against a bad or adversarial model response: drop tasks
 * with no title, de-duplicate keys, and discard dependency/duplicate
 * references that do not resolve.
 */
function sanitizeProposal(result: ExtractionResult): ExtractionResult {
  const seen = new Set<string>();
  const tasks = result.tasks
    .filter((t) => t.title.trim().length > 0)
    .map((t, i) => {
      let key = t.key.trim() || `t${i + 1}`;
      while (seen.has(key)) key = `${key}_${i}`;
      seen.add(key);
      return { ...t, key, title: t.title.trim() };
    });
  const keys = new Set(tasks.map((t) => t.key));
  const cleaned = tasks.map((t) => ({
    ...t,
    dependsOnKeys: [...new Set(t.dependsOnKeys)].filter((k) => k !== t.key && keys.has(k)),
  }));
  return {
    ...result,
    tasks: cleaned,
    questions: result.questions.filter((q) => q.taskKey === null || keys.has(q.taskKey)),
  };
}

interface DumpContext {
  today: string;
  timezone: string;
  existingTasks: Array<{ ref: string; title: string }>;
  members: Array<{ name: string; email: string }>;
}

/** Context is permission-scoped: only projects the caller can already read. */
async function loadContext(ctx: OrgCtx, projectId: string | null): Promise<DumpContext> {
  const scope = projectId
    ? { clause: 'AND t.project_id = $2', params: [projectId] }
    : ctx.orgRole === 'member'
      ? {
          clause:
            'AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = $2)',
          params: [ctx.userId],
        }
      : { clause: '', params: [] };

  const { rows: tasks } = await orgDb(ctx.orgId).query<{ ref: string; title: string }>(
    `SELECT p.key || '-' || t.number AS ref, t.title
       FROM tasks t JOIN projects p ON p.id = t.project_id
       JOIN statuses s ON s.id = t.status_id
      WHERE t.org_id = $1 AND t.deleted_at IS NULL AND s.category <> 'done' ${scope.clause}
      ORDER BY t.created_at DESC
      LIMIT ${CONTEXT_TASK_LIMIT}`,
    [ctx.orgId, ...scope.params],
  );

  const { rows: members } = await orgDb(ctx.orgId).query<{ name: string; email: string }>(
    `SELECT u.name, u.email FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND u.deleted_at IS NULL ORDER BY u.name LIMIT 100`,
    [ctx.orgId],
  );

  const { rows: tz } = await orgDb(ctx.orgId).query<{ timezone: string }>(
    'SELECT timezone FROM users WHERE id = $1',
    [ctx.userId],
  );

  return {
    today: new Date().toISOString().slice(0, 10),
    timezone: tz[0]?.timezone ?? 'UTC',
    existingTasks: tasks,
    members,
  };
}

export async function getBraindump(ctx: OrgCtx, id: string): Promise<Braindump> {
  const { rows } = await orgDb(ctx.orgId).query<BraindumpRow>(
    'SELECT * FROM braindumps WHERE id = $1 AND org_id = $2',
    [id, ctx.orgId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('Brain dump');
  // A dump is personal: only its author can see the raw input.
  if (row.user_id !== ctx.userId) throw new ForbiddenError('This brain dump belongs to someone else');
  return mapRow(row);
}

export async function listBraindumps(ctx: OrgCtx, limit = 20): Promise<Braindump[]> {
  const { rows } = await orgDb(ctx.orgId).query<BraindumpRow>(
    `SELECT * FROM braindumps WHERE org_id = $1 AND user_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [ctx.orgId, ctx.userId, limit],
  );
  return rows.map(mapRow);
}

export async function discardBraindump(ctx: OrgCtx, id: string): Promise<void> {
  await getBraindump(ctx, id);
  await withOrg(ctx.orgId, async (tx) => {
    await tx.query(
      `UPDATE braindumps SET status = 'discarded', updated_at = now() WHERE id = $1`,
      [id],
    );
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'braindump',
      entityId: id,
      action: 'discarded',
    });
  });
}

export interface ApprovalResult {
  created: Task[];
  dependencyCount: number;
  blockerCount: number;
}

/**
 * Create the tasks a human approved. Nothing here trusts the model's output:
 * the client sends back the (possibly edited) values, and they go through the
 * same validation as a manually created task. Everything is one transaction,
 * so a partial approval can never leave half a plan behind.
 */
export async function approveBraindump(
  ctx: OrgCtx,
  id: string,
  rawInput: ApproveBraindumpInput,
): Promise<ApprovalResult> {
  const input = approveBraindumpInput.parse(rawInput);
  const dump = await getBraindump(ctx, id);
  if (dump.status === 'approved') {
    throw new ConflictError('These tasks have already been created');
  }
  if (dump.status !== 'ready') {
    throw new ConflictError(`This brain dump is ${dump.status} and cannot be approved`);
  }

  const project = await resolveProject(ctx, input.projectId);
  requireProjectRole(ctx, project.role, 'member');

  const keys = new Set(input.tasks.map((t) => t.key));
  const created: Task[] = [];
  const keyToId = new Map<string, string>();
  let dependencyCount = 0;
  let blockerCount = 0;

  // Tasks first (so dependency targets exist), then edges, then blockers.
  for (const approved of input.tasks) {
    const task = await tasksService.createTask(
      ctx,
      project,
      {
        title: approved.title,
        description: approved.description,
        priority: approved.priority,
        assigneeId: approved.assigneeId ?? null,
        dueDate: approved.dueDate ?? null,
        estimateDays: approved.estimateDays ?? null,
        epicId: approved.epicId ?? null,
        parentId: null,
        labelIds: approved.labelIds,
      },
      { source: 'ai', braindumpId: id },
    );
    keyToId.set(approved.key, task.id);
    created.push(task);
  }

  for (const approved of input.tasks) {
    const blockedId = keyToId.get(approved.key);
    if (!blockedId) continue;
    for (const dependsOn of approved.dependsOnKeys) {
      if (!keys.has(dependsOn)) continue;
      const blockingId = keyToId.get(dependsOn);
      if (!blockingId || blockingId === blockedId) continue;
      try {
        await tasksService.addDependency(ctx, blockedId, blockingId);
        dependencyCount += 1;
      } catch (err) {
        // A cycle in the model's suggestion must not fail the whole approval.
        if (err instanceof ConflictError) {
          logger.warn({ braindumpId: id, blockedId, blockingId }, 'skipped cyclic ai dependency');
          continue;
        }
        throw err;
      }
    }
    if (approved.blockerReason) {
      await tasksService.addBlocker(ctx, blockedId, {
        reason: approved.blockerReason,
        expectedResolutionDate: null,
      });
      blockerCount += 1;
    }
  }

  await withOrg(ctx.orgId, async (tx) => {
    await tx.query(
      `UPDATE braindumps SET status = 'approved', updated_at = now() WHERE id = $1`,
      [id],
    );
    // One ai_actions row per created task: the provenance record that says a
    // human approved this specific AI-proposed write.
    for (const [key, taskId] of keyToId) {
      const approved = input.tasks.find((t) => t.key === key)!;
      await recordAiAction(tx, {
        orgId: ctx.orgId,
        braindumpId: id,
        userId: ctx.userId,
        tool: 'create_task',
        input: approved,
        result: { taskId },
      });
    }
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'ai',
      actorId: ctx.userId,
      entityType: 'braindump',
      entityId: id,
      projectId: project.id,
      action: 'approved',
      data: {
        taskCount: created.length,
        dependencyCount,
        blockerCount,
        approvedBy: ctx.userId,
      },
    });
  });

  return { created, dependencyCount, blockerCount };
}

export async function recordAiAction(
  tx: Queryable,
  input: {
    orgId: string;
    braindumpId?: string | null;
    conversationId?: string | null;
    userId: string;
    tool: string;
    input: unknown;
    result: unknown;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO ai_actions
       (org_id, braindump_id, conversation_id, user_id, tool, input, result, status, executed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'executed', now())`,
    [
      input.orgId,
      input.braindumpId ?? null,
      input.conversationId ?? null,
      input.userId,
      input.tool,
      JSON.stringify(input.input),
      JSON.stringify(input.result),
    ],
  );
}

import {
  createTaskInput,
  type Blocker,
  type CreateBlockerInput,
  type CreateTaskInput,
  type Label,
  type MoveTaskInput,
  type StatusCategory,
  type Task,
  type TaskDetail,
  type TaskListQuery,
  type TaskRef,
  type UpdateTaskInput,
} from '@outcome/shared';
import { orgDb, withOrg, type Queryable } from '../../platform/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.js';
import { requireProjectRole } from '../auth/policy.js';
import { diffFields, recordEvent } from '../activity/service.js';
import { notify } from '../notifications/service.js';
import type { OrgCtx } from '../../platform/ctx.js';
import type { ResolvedProject } from '../../http/context.js';

const POSITION_GAP = 1024;

/** Columns every task read shares, so list and detail cannot drift. */
const TASK_SELECT = `
  t.id, t.number, t.project_id, p.key AS project_key, t.epic_id, t.parent_id,
  t.title, t.description, t.status_id, s.name AS status_name, s.category AS status_category,
  t.priority, t.assignee_id, ua.name AS assignee_name, t.due_date, t.estimate_days,
  t.position, t.source, t.braindump_id, t.created_at, t.updated_at, t.completed_at,
  COALESCE(lab.labels, '[]'::json) AS labels,
  COALESCE(sub.total, 0)::int AS subtask_count,
  COALESCE(sub.done, 0)::int AS subtask_done_count,
  COALESCE(cmt.n, 0)::int AS comment_count,
  COALESCE(blk.n, 0)::int AS open_blocker_count,
  COALESCE(dep.n, 0)::int AS blocked_by_open_count`;

const TASK_JOINS = `
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  JOIN statuses s ON s.id = t.status_id
  LEFT JOIN users ua ON ua.id = t.assignee_id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color)
                    ORDER BY l.name) AS labels
      FROM task_labels tl JOIN labels l ON l.id = tl.label_id
     WHERE tl.task_id = t.id) lab ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS total, count(*) FILTER (WHERE ss.category = 'done') AS done
      FROM tasks st JOIN statuses ss ON ss.id = st.status_id
     WHERE st.parent_id = t.id AND st.deleted_at IS NULL) sub ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM comments c WHERE c.task_id = t.id AND c.deleted_at IS NULL) cmt ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM blockers b WHERE b.task_id = t.id AND b.resolved_at IS NULL) blk ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS n
      FROM task_dependencies d
      JOIN tasks bt ON bt.id = d.blocking_task_id AND bt.deleted_at IS NULL
      JOIN statuses bs ON bs.id = bt.status_id
     WHERE d.blocked_task_id = t.id AND bs.category <> 'done') dep ON true`;

function mapTask(r: Record<string, unknown>): Task {
  const number = r['number'] as number;
  const key = r['project_key'] as string;
  return {
    id: r['id'] as string,
    number,
    ref: `${key}-${number}`,
    projectId: r['project_id'] as string,
    projectKey: key,
    epicId: (r['epic_id'] as string | null) ?? null,
    parentId: (r['parent_id'] as string | null) ?? null,
    title: r['title'] as string,
    description: r['description'] as string,
    statusId: r['status_id'] as string,
    statusName: r['status_name'] as string,
    statusCategory: r['status_category'] as StatusCategory,
    priority: r['priority'] as Task['priority'],
    assigneeId: (r['assignee_id'] as string | null) ?? null,
    assigneeName: (r['assignee_name'] as string | null) ?? null,
    dueDate: (r['due_date'] as string | null) ?? null,
    estimateDays: (r['estimate_days'] as number | null) ?? null,
    position: r['position'] as number,
    source: r['source'] as Task['source'],
    braindumpId: (r['braindump_id'] as string | null) ?? null,
    labels: (r['labels'] as Label[]) ?? [],
    subtaskCount: r['subtask_count'] as number,
    subtaskDoneCount: r['subtask_done_count'] as number,
    commentCount: r['comment_count'] as number,
    openBlockerCount: r['open_blocker_count'] as number,
    blockedByOpenCount: r['blocked_by_open_count'] as number,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
    completedAt: (r['completed_at'] as string | null) ?? null,
  };
}

async function resolveStatus(
  tx: Queryable,
  projectId: string,
  statusId: string | undefined,
): Promise<{ id: string; category: StatusCategory }> {
  if (statusId) {
    const { rows } = await tx.query<{ id: string; category: StatusCategory }>(
      'SELECT id, category FROM statuses WHERE id = $1 AND project_id = $2',
      [statusId, projectId],
    );
    const row = rows[0];
    if (!row) throw new ValidationError('That status does not belong to this project', { statusId: 'Unknown status' });
    return row;
  }
  const { rows } = await tx.query<{ id: string; category: StatusCategory }>(
    'SELECT id, category FROM statuses WHERE project_id = $1 ORDER BY position LIMIT 1',
    [projectId],
  );
  const row = rows[0];
  if (!row) throw new ValidationError('This project has no statuses configured');
  return row;
}

/** Assignee must be a member of the org (and, if set, resolvable). */
async function assertOrgMember(tx: Queryable, orgId: string, userId: string): Promise<void> {
  const { rows } = await tx.query(
    'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  if (rows.length === 0) {
    throw new ValidationError('That person is not a member of this organization', {
      assigneeId: 'Not a member',
    });
  }
}

/** Where a task came from, for provenance on AI- and import-created work. */
export interface TaskOrigin {
  source: 'manual' | 'ai' | 'import';
  braindumpId?: string | null;
}

export async function createTask(
  ctx: OrgCtx,
  project: ResolvedProject,
  rawInput: CreateTaskInput,
  origin: TaskOrigin = { source: 'manual' },
): Promise<TaskDetail> {
  requireProjectRole(ctx, project.role, 'member');
  // Re-validate here, not only at the HTTP edge: the importer and the AI
  // approval path call this directly and must obey the same contract.
  const input = createTaskInput.parse(rawInput);

  return withOrg(ctx.orgId, async (tx) => {
    const status = await resolveStatus(tx, project.id, input.statusId);
    if (input.assigneeId) await assertOrgMember(tx, ctx.orgId, input.assigneeId);

    if (input.parentId) {
      const { rows } = await tx.query<{ parent_id: string | null }>(
        'SELECT parent_id FROM tasks WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
        [input.parentId, project.id],
      );
      const parent = rows[0];
      if (!parent) throw new ValidationError('Parent task not found in this project');
      // One level of nesting only: a subtask cannot own subtasks.
      if (parent.parent_id) throw new ValidationError('Subtasks cannot have their own subtasks');
    }
    if (input.epicId) {
      const { rows } = await tx.query('SELECT 1 FROM epics WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL', [
        input.epicId,
        project.id,
      ]);
      if (rows.length === 0) throw new ValidationError('Epic not found in this project');
    }

    // Gapless per-project numbering; the row lock serialises concurrent creates.
    const { rows: counter } = await tx.query<{ next_task_number: number }>(
      `UPDATE project_counters SET next_task_number = next_task_number + 1
        WHERE project_id = $1 RETURNING next_task_number - 1 AS next_task_number`,
      [project.id],
    );
    const number = counter[0]?.next_task_number;
    if (number === undefined) throw new NotFoundError('Project');

    const { rows: positions } = await tx.query<{ pos: number | null }>(
      'SELECT max(position) AS pos FROM tasks WHERE project_id = $1 AND status_id = $2',
      [project.id, status.id],
    );
    const position = (positions[0]?.pos ?? 0) + POSITION_GAP;

    const { rows: created } = await tx.query<{ id: string }>(
      `INSERT INTO tasks (org_id, project_id, epic_id, parent_id, number, title, description,
                          status_id, priority, assignee_id, due_date, estimate_days, position,
                          source, braindump_id, created_by, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               CASE WHEN $17 = 'done' THEN now() ELSE NULL END)
       RETURNING id`,
      [
        ctx.orgId,
        project.id,
        input.epicId ?? null,
        input.parentId ?? null,
        number,
        input.title,
        input.description,
        status.id,
        input.priority,
        input.assigneeId ?? null,
        input.dueDate ?? null,
        input.estimateDays ?? null,
        position,
        origin.source,
        origin.braindumpId ?? null,
        ctx.userId,
        status.category,
      ],
    );
    const taskId = created[0]!.id;

    if (input.labelIds.length > 0) await setLabels(tx, ctx.orgId, taskId, input.labelIds);

    // The creator and the assignee watch the task by default.
    await tx.query(
      `INSERT INTO watchers (task_id, user_id)
       SELECT $1, u FROM unnest($2::uuid[]) AS u ON CONFLICT DO NOTHING`,
      [taskId, [ctx.userId, ...(input.assigneeId ? [input.assigneeId] : [])]],
    );

    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: origin.source === 'manual' ? 'user' : origin.source === 'ai' ? 'ai' : 'system',
      actorId: ctx.userId,
      entityType: 'task',
      entityId: taskId,
      projectId: project.id,
      taskId,
      action: 'created',
      data: { title: input.title, ref: `${project.key}-${number}`, source: origin.source },
    });
    if (input.assigneeId) {
      await notify(tx, {
        orgId: ctx.orgId,
        userIds: [input.assigneeId],
        type: 'task.assigned',
        actorId: ctx.userId,
        projectId: project.id,
        taskId,
      });
    }
    return getDetailTx(tx, ctx, taskId);
  });
}

async function setLabels(
  tx: Queryable,
  orgId: string,
  taskId: string,
  labelIds: string[],
): Promise<void> {
  await tx.query('DELETE FROM task_labels WHERE task_id = $1', [taskId]);
  if (labelIds.length === 0) return;
  const { rows } = await tx.query(
    `INSERT INTO task_labels (task_id, label_id)
     SELECT $1, l.id FROM labels l WHERE l.org_id = $2 AND l.id = ANY($3::uuid[])
     RETURNING label_id`,
    [taskId, orgId, labelIds],
  );
  if (rows.length !== new Set(labelIds).size) {
    throw new ValidationError('One or more labels do not exist in this organization');
  }
}

export async function listTasks(
  ctx: OrgCtx,
  query: TaskListQuery,
  project: ResolvedProject | null,
): Promise<{ items: Task[]; nextCursor: string | null }> {
  const params: unknown[] = [ctx.orgId];
  const where = ['t.org_id = $1', 't.deleted_at IS NULL', 'p.deleted_at IS NULL'];

  if (project) {
    requireProjectRole(ctx, project.role, 'viewer');
    params.push(project.id);
    where.push(`t.project_id = $${params.length}`);
  } else if (ctx.orgRole === 'member') {
    // Cross-project reads are limited to the caller's projects.
    params.push(ctx.userId);
    where.push(
      `EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = $${params.length})`,
    );
  }

  if (query.statusId) {
    params.push(query.statusId);
    where.push(`t.status_id = $${params.length}`);
  }
  if (query.statusCategory) {
    params.push(query.statusCategory);
    where.push(`s.category = $${params.length}`);
  }
  if (query.assigneeId === 'none') {
    where.push('t.assignee_id IS NULL');
  } else if (query.assigneeId) {
    params.push(query.assigneeId === 'me' ? ctx.userId : query.assigneeId);
    where.push(`t.assignee_id = $${params.length}`);
  }
  if (query.epicId === 'none') {
    where.push('t.epic_id IS NULL');
  } else if (query.epicId) {
    params.push(query.epicId);
    where.push(`t.epic_id = $${params.length}`);
  }
  if (query.priority) {
    params.push(query.priority);
    where.push(`t.priority = $${params.length}`);
  }
  if (query.labelId) {
    params.push(query.labelId);
    where.push(`EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = $${params.length})`);
  }
  if (query.parent === 'roots') where.push('t.parent_id IS NULL');
  if (query.blocked) {
    where.push(`(blk.n > 0 OR dep.n > 0 OR s.category = 'blocked')`);
  }
  if (query.q) {
    params.push(query.q);
    where.push(
      `(t.search @@ websearch_to_tsquery('english', $${params.length}) OR t.title ILIKE '%' || $${params.length} || '%')`,
    );
  }
  if (query.cursor) {
    const [createdAt, id] = query.cursor.split('|');
    if (!createdAt || !id) throw new ValidationError('Invalid cursor');
    params.push(createdAt, id);
    where.push(`(t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(query.limit + 1);

  const { rows } = await orgDb(ctx.orgId).query<Record<string, never>>(
    `SELECT ${TASK_SELECT} ${TASK_JOINS}
      WHERE ${where.join(' AND ')}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const mapped = rows.slice(0, query.limit).map((r) => mapTask(r as unknown as Record<string, unknown>));
  const last = rows[query.limit - 1] as unknown as Record<string, unknown> | undefined;
  return {
    items: mapped,
    nextCursor:
      rows.length > query.limit && last ? `${String(last['created_at'])}|${String(last['id'])}` : null,
  };
}

/** Board payload: statuses in order, each with its ordered cards. */
export async function board(
  ctx: OrgCtx,
  project: ResolvedProject,
): Promise<{ statusId: string; tasks: Task[] }[]> {
  requireProjectRole(ctx, project.role, 'viewer');
  const { rows: statuses } = await orgDb(ctx.orgId).query<{ id: string }>(
    'SELECT id FROM statuses WHERE project_id = $1 ORDER BY position',
    [project.id],
  );
  const { rows } = await orgDb(ctx.orgId).query<Record<string, never>>(
    `SELECT ${TASK_SELECT} ${TASK_JOINS}
      WHERE t.org_id = $1 AND t.project_id = $2 AND t.parent_id IS NULL AND t.deleted_at IS NULL
      ORDER BY s.position, t.position, t.created_at`,
    [ctx.orgId, project.id],
  );
  const tasks = rows.map((r) => mapTask(r as unknown as Record<string, unknown>));
  return statuses.map((s) => ({
    statusId: s.id,
    tasks: tasks.filter((t) => t.statusId === s.id),
  }));
}

export async function getTaskByRef(
  ctx: OrgCtx,
  project: ResolvedProject,
  number: number,
): Promise<TaskDetail> {
  requireProjectRole(ctx, project.role, 'viewer');
  const { rows } = await orgDb(ctx.orgId).query<{ id: string }>(
    'SELECT id FROM tasks WHERE project_id = $1 AND number = $2 AND deleted_at IS NULL',
    [project.id, number],
  );
  const id = rows[0]?.id;
  if (!id) throw new NotFoundError('Task');
  return withOrg(ctx.orgId, (tx) => getDetailTx(tx, ctx, id));
}

export async function getTask(ctx: OrgCtx, taskId: string): Promise<TaskDetail> {
  const access = await taskAccess(ctx, taskId);
  requireProjectRole(ctx, access.projectRole, 'viewer');
  return withOrg(ctx.orgId, (tx) => getDetailTx(tx, ctx, taskId));
}

export interface TaskAccess {
  taskId: string;
  projectId: string;
  projectKey: string;
  projectRole: TaskDetail extends never ? never : import('@outcome/shared').ProjectRole | null;
  assigneeId: string | null;
  statusCategory: StatusCategory;
  number: number;
}

/** Load a task plus the caller's role in its project (404 when invisible). */
export async function taskAccess(ctx: OrgCtx, taskId: string): Promise<TaskAccess> {
  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    project_id: string;
    project_key: string;
    role: import('@outcome/shared').ProjectRole | null;
    assignee_id: string | null;
    category: StatusCategory;
    number: number;
  }>(
    `SELECT t.id, t.project_id, p.key AS project_key, pm.role, t.assignee_id,
            s.category, t.number
       FROM tasks t
       JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
       JOIN statuses s ON s.id = t.status_id
       LEFT JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = $3
      WHERE t.id = $1 AND t.org_id = $2 AND t.deleted_at IS NULL`,
    [taskId, ctx.orgId, ctx.userId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('Task');
  return {
    taskId: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectRole: row.role,
    assigneeId: row.assignee_id,
    statusCategory: row.category,
    number: row.number,
  };
}

async function getDetailTx(tx: Queryable, ctx: OrgCtx, taskId: string): Promise<TaskDetail> {
  const { rows } = await tx.query<Record<string, never>>(
    `SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.id = $1 AND t.org_id = $2 AND t.deleted_at IS NULL`,
    [taskId, ctx.orgId],
  );
  const row = rows[0] as unknown as Record<string, unknown> | undefined;
  if (!row) throw new NotFoundError('Task');
  const base = mapTask(row);

  const { rows: subs } = await tx.query<Record<string, never>>(
    `SELECT ${TASK_SELECT} ${TASK_JOINS}
      WHERE t.parent_id = $1 AND t.deleted_at IS NULL ORDER BY t.position, t.created_at`,
    [taskId],
  );
  const { rows: blockerRows } = await tx.query<{
    id: string;
    task_id: string;
    reason: string;
    expected_resolution_date: string | null;
    created_by: string;
    created_at: string;
    resolved_at: string | null;
  }>(
    `SELECT id, task_id, reason, expected_resolution_date, created_by, created_at, resolved_at
       FROM blockers WHERE task_id = $1 ORDER BY resolved_at NULLS FIRST, created_at DESC`,
    [taskId],
  );
  const refs = async (direction: 'blockedBy' | 'blocks'): Promise<TaskRef[]> => {
    const [selectCol, matchCol] =
      direction === 'blockedBy'
        ? ['d.blocking_task_id', 'd.blocked_task_id']
        : ['d.blocked_task_id', 'd.blocking_task_id'];
    const { rows: r } = await tx.query<{
      id: string;
      ref: string;
      title: string;
      category: StatusCategory;
    }>(
      `SELECT o.id, p.key || '-' || o.number AS ref, o.title, s.category
         FROM task_dependencies d
         JOIN tasks o ON o.id = ${selectCol} AND o.deleted_at IS NULL
         JOIN projects p ON p.id = o.project_id
         JOIN statuses s ON s.id = o.status_id
        WHERE ${matchCol} = $1
        ORDER BY o.number`,
      [taskId],
    );
    return r.map((x) => ({ id: x.id, ref: x.ref, title: x.title, statusCategory: x.category }));
  };
  const { rows: watchers } = await tx.query<{ user_id: string }>(
    'SELECT user_id FROM watchers WHERE task_id = $1',
    [taskId],
  );

  return {
    ...base,
    subtasks: subs.map((r) => mapTask(r as unknown as Record<string, unknown>)),
    blockers: blockerRows.map(
      (b): Blocker => ({
        id: b.id,
        taskId: b.task_id,
        reason: b.reason,
        expectedResolutionDate: b.expected_resolution_date,
        createdBy: b.created_by,
        createdAt: b.created_at,
        resolvedAt: b.resolved_at,
      }),
    ),
    blockedBy: await refs('blockedBy'),
    blocks: await refs('blocks'),
    watcherIds: watchers.map((w) => w.user_id),
  };
}

export interface UpdateOptions {
  /**
   * Runs inside the update transaction. A board move uses this to allocate
   * its position under a lock, so two simultaneous drops cannot read the same
   * `max(position)` and land on top of each other.
   */
  resolvePosition?: (tx: Queryable, statusId: string) => Promise<number>;
}

export async function updateTask(
  ctx: OrgCtx,
  taskId: string,
  input: UpdateTaskInput,
  options: UpdateOptions = {},
): Promise<TaskDetail> {
  const access = await taskAccess(ctx, taskId);
  requireProjectRole(ctx, access.projectRole, 'member');

  return withOrg(ctx.orgId, async (tx) => {
    // Lock the task row on its own: with a JOIN in a FOR UPDATE read, a
    // concurrent update makes Postgres re-check the join against a stale
    // tuple and the row disappears — which surfaced as a spurious 404 when
    // two people moved the same card at once.
    const { rows: beforeRows } = await tx.query<Record<string, never>>(
      `SELECT title, description, status_id, priority, assignee_id, epic_id,
              due_date, estimate_days
         FROM tasks
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [taskId, ctx.orgId],
    );
    const before = beforeRows[0] as unknown as Record<string, unknown> | undefined;
    if (!before) throw new NotFoundError('Task');

    const { rows: currentStatus } = await tx.query<{ category: StatusCategory }>(
      'SELECT category FROM statuses WHERE id = $1',
      [before['status_id']],
    );
    before['status_category'] = currentStatus[0]?.category ?? 'backlog';

    let newCategory = before['status_category'] as StatusCategory;
    if (input.statusId !== undefined) {
      const status = await resolveStatus(tx, access.projectId, input.statusId);
      newCategory = status.category;
    }
    if (input.assigneeId) await assertOrgMember(tx, ctx.orgId, input.assigneeId);
    if (input.epicId) {
      const { rows } = await tx.query(
        'SELECT 1 FROM epics WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
        [input.epicId, access.projectId],
      );
      if (rows.length === 0) throw new ValidationError('Epic not found in this project');
    }

    const sets: string[] = [];
    const params: unknown[] = [taskId, ctx.orgId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.title !== undefined) push('title', input.title);
    if (input.description !== undefined) push('description', input.description);
    if (input.statusId !== undefined) push('status_id', input.statusId);
    if (input.priority !== undefined) push('priority', input.priority);
    if (input.assigneeId !== undefined) push('assignee_id', input.assigneeId);
    if (input.epicId !== undefined) push('epic_id', input.epicId);
    if (input.dueDate !== undefined) push('due_date', input.dueDate);
    if (input.estimateDays !== undefined) push('estimate_days', input.estimateDays);
    if (options.resolvePosition) {
      const statusForPosition = input.statusId ?? (before['status_id'] as string);
      push('position', await options.resolvePosition(tx, statusForPosition));
    } else if (input.position !== undefined) {
      push('position', input.position);
    }

    // completed_at tracks the done category, so analytics never guess.
    if (input.statusId !== undefined) {
      const wasDone = before['status_category'] === 'done';
      if (newCategory === 'done' && !wasDone) sets.push('completed_at = now()');
      if (newCategory !== 'done' && wasDone) sets.push('completed_at = NULL');
    }

    if (sets.length > 0) {
      await tx.query(
        `UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND org_id = $2`,
        params,
      );
    }
    if (input.labelIds !== undefined) await setLabels(tx, ctx.orgId, taskId, input.labelIds);

    const changes = diffFields(
      before,
      {
        title: input.title,
        description: input.description,
        status_id: input.statusId,
        priority: input.priority,
        assignee_id: input.assigneeId,
        epic_id: input.epicId,
        due_date: input.dueDate,
        estimate_days: input.estimateDays,
      },
      ['title', 'description', 'status_id', 'priority', 'assignee_id', 'epic_id', 'due_date', 'estimate_days'],
    );
    if (changes.length > 0) {
      await recordEvent(tx, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        entityType: 'task',
        entityId: taskId,
        projectId: access.projectId,
        taskId,
        action: 'updated',
        data: { changes },
      });
    }

    if (input.assigneeId && input.assigneeId !== before['assignee_id']) {
      await tx.query('INSERT INTO watchers (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        taskId,
        input.assigneeId,
      ]);
      await notify(tx, {
        orgId: ctx.orgId,
        userIds: [input.assigneeId],
        type: 'task.assigned',
        actorId: ctx.userId,
        projectId: access.projectId,
        taskId,
      });
    }
    if (input.statusId !== undefined && input.statusId !== before['status_id']) {
      const { rows: watchers } = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM watchers WHERE task_id = $1',
        [taskId],
      );
      await notify(tx, {
        orgId: ctx.orgId,
        userIds: watchers.map((w) => w.user_id),
        type: 'task.status_changed',
        actorId: ctx.userId,
        projectId: access.projectId,
        taskId,
        data: { to: newCategory },
      });
      // Finishing a task frees whatever was waiting on it.
      if (newCategory === 'done') await notifyDependents(tx, ctx, taskId, access.projectId);
    }
    return getDetailTx(tx, ctx, taskId);
  });
}

async function notifyDependents(
  tx: Queryable,
  ctx: OrgCtx,
  taskId: string,
  projectId: string,
): Promise<void> {
  const { rows } = await tx.query<{ id: string; assignee_id: string | null }>(
    `SELECT bt.id, bt.assignee_id
       FROM task_dependencies d
       JOIN tasks bt ON bt.id = d.blocked_task_id AND bt.deleted_at IS NULL
      WHERE d.blocking_task_id = $1`,
    [taskId],
  );
  for (const row of rows) {
    if (!row.assignee_id) continue;
    await notify(tx, {
      orgId: ctx.orgId,
      userIds: [row.assignee_id],
      type: 'dependency.cleared',
      actorId: ctx.userId,
      projectId,
      taskId: row.id,
      data: { clearedTaskId: taskId },
    });
  }
}

/**
 * Board drag: place a task in a column between two neighbours.
 *
 * The position is derived server-side from the neighbour ids, and allocated
 * inside the update transaction while holding a per-column advisory lock:
 * without that, simultaneous drops each read the same `max(position)` and end
 * up sharing one position, which makes the column order non-deterministic.
 */
export async function moveTask(
  ctx: OrgCtx,
  taskId: string,
  input: MoveTaskInput,
): Promise<TaskDetail> {
  const access = await taskAccess(ctx, taskId);
  requireProjectRole(ctx, access.projectRole, 'member');

  return updateTask(
    ctx,
    taskId,
    { statusId: input.statusId },
    {
      resolvePosition: async (tx, statusId) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `move:${access.projectId}:${statusId}`,
        ]);

        const neighbourPos = async (id: string | null | undefined): Promise<number | null> => {
          if (!id) return null;
          const { rows } = await tx.query<{ position: number }>(
            'SELECT position FROM tasks WHERE id = $1 AND status_id = $2 AND deleted_at IS NULL',
            [id, statusId],
          );
          return rows[0]?.position ?? null;
        };
        // Columns render in ascending position, so the card above the drop
        // point has the smaller position and the card below the larger one.
        const abovePos = await neighbourPos(input.beforeTaskId);
        const belowPos = await neighbourPos(input.afterTaskId);

        if (abovePos !== null && belowPos !== null) return (abovePos + belowPos) / 2;
        if (abovePos !== null) return abovePos + POSITION_GAP; // dropped at the bottom
        if (belowPos !== null) return belowPos - POSITION_GAP; // dropped at the top
        const { rows } = await tx.query<{ pos: number | null }>(
          'SELECT max(position) AS pos FROM tasks WHERE project_id = $1 AND status_id = $2 AND deleted_at IS NULL',
          [access.projectId, statusId],
        );
        return (rows[0]?.pos ?? 0) + POSITION_GAP;
      },
    },
  );
}

export async function deleteTask(ctx: OrgCtx, taskId: string): Promise<void> {
  const access = await taskAccess(ctx, taskId);
  requireProjectRole(ctx, access.projectRole, 'member');
  await withOrg(ctx.orgId, async (tx) => {
    await tx.query(
      `UPDATE tasks SET deleted_at = now(), updated_at = now()
        WHERE (id = $1 OR parent_id = $1) AND org_id = $2 AND deleted_at IS NULL`,
      [taskId, ctx.orgId],
    );
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'task',
      entityId: taskId,
      projectId: access.projectId,
      taskId,
      action: 'deleted',
    });
  });
}

// ------------------------------------------------------------------ deps

export async function addDependency(
  ctx: OrgCtx,
  blockedTaskId: string,
  blockingTaskId: string,
): Promise<void> {
  const blocked = await taskAccess(ctx, blockedTaskId);
  requireProjectRole(ctx, blocked.projectRole, 'member');
  const blocking = await taskAccess(ctx, blockingTaskId);
  requireProjectRole(ctx, blocking.projectRole, 'viewer');
  if (blockedTaskId === blockingTaskId) {
    throw new ValidationError('A task cannot block itself');
  }

  await withOrg(ctx.orgId, async (tx) => {
    // Serialize dependency writes for this project: the cycle check below
    // reads the graph, so two edges added at the same instant could each see
    // an acyclic graph and together create a cycle.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `deps:${blocked.projectId}`,
    ]);

    // Reject cycles: the new edge is invalid if `blocked` already reaches
    // `blocking` transitively.
    const { rows: cycle } = await tx.query<{ exists: boolean }>(
      `WITH RECURSIVE reach(id) AS (
         SELECT blocked_task_id FROM task_dependencies WHERE blocking_task_id = $1
         UNION
         SELECT d.blocked_task_id FROM task_dependencies d JOIN reach r ON d.blocking_task_id = r.id
       )
       SELECT EXISTS (SELECT 1 FROM reach WHERE id = $2) AS exists`,
      [blockedTaskId, blockingTaskId],
    );
    if (cycle[0]?.exists) {
      throw new ConflictError('That dependency would create a cycle');
    }
    await tx.query(
      `INSERT INTO task_dependencies (org_id, blocking_task_id, blocked_task_id, created_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [ctx.orgId, blockingTaskId, blockedTaskId, ctx.userId],
    );
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'task',
      entityId: blockedTaskId,
      projectId: blocked.projectId,
      taskId: blockedTaskId,
      action: 'dependency_added',
      data: { blockingTaskId, blockingRef: `${blocking.projectKey}-${blocking.number}` },
    });
  });
}

export async function removeDependency(
  ctx: OrgCtx,
  blockedTaskId: string,
  blockingTaskId: string,
): Promise<void> {
  const blocked = await taskAccess(ctx, blockedTaskId);
  requireProjectRole(ctx, blocked.projectRole, 'member');
  await withOrg(ctx.orgId, async (tx) => {
    const { rowCount } = await tx.query(
      `DELETE FROM task_dependencies
        WHERE org_id = $1 AND blocked_task_id = $2 AND blocking_task_id = $3`,
      [ctx.orgId, blockedTaskId, blockingTaskId],
    );
    if (rowCount === 0) throw new NotFoundError('Dependency');
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'task',
      entityId: blockedTaskId,
      projectId: blocked.projectId,
      taskId: blockedTaskId,
      action: 'dependency_removed',
      data: { blockingTaskId },
    });
  });
}

// --------------------------------------------------------------- blockers

export async function addBlocker(
  ctx: OrgCtx,
  taskId: string,
  input: CreateBlockerInput,
): Promise<Blocker> {
  const access = await taskAccess(ctx, taskId);
  requireProjectRole(ctx, access.projectRole, 'member');

  return withOrg(ctx.orgId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      created_at: string;
    }>(
      `INSERT INTO blockers (org_id, task_id, reason, expected_resolution_date, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [ctx.orgId, taskId, input.reason, input.expectedResolutionDate ?? null, ctx.userId],
    );
    const row = rows[0]!;
    // A blocked task moves to the blocked column so the board tells the truth.
    await tx.query(
      `UPDATE tasks SET status_id = s.id, updated_at = now()
         FROM statuses s
        WHERE tasks.id = $1 AND s.project_id = tasks.project_id AND s.category = 'blocked'
          AND (SELECT category FROM statuses WHERE id = tasks.status_id) NOT IN ('blocked', 'done')`,
      [taskId],
    );
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'blocker',
      entityId: row.id,
      projectId: access.projectId,
      taskId,
      action: 'created',
      data: { reason: input.reason },
    });
    const { rows: watchers } = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM watchers WHERE task_id = $1',
      [taskId],
    );
    await notify(tx, {
      orgId: ctx.orgId,
      userIds: [...watchers.map((w) => w.user_id), ...(access.assigneeId ? [access.assigneeId] : [])],
      type: 'blocker.created',
      actorId: ctx.userId,
      projectId: access.projectId,
      taskId,
      data: { reason: input.reason },
    });
    return {
      id: row.id,
      taskId,
      reason: input.reason,
      expectedResolutionDate: input.expectedResolutionDate ?? null,
      createdBy: ctx.userId,
      createdAt: row.created_at,
      resolvedAt: null,
    };
  });
}

export async function resolveBlocker(ctx: OrgCtx, blockerId: string): Promise<void> {
  const { rows } = await orgDb(ctx.orgId).query<{ task_id: string }>(
    'SELECT task_id FROM blockers WHERE id = $1 AND org_id = $2 AND resolved_at IS NULL',
    [blockerId, ctx.orgId],
  );
  const taskId = rows[0]?.task_id;
  if (!taskId) throw new NotFoundError('Open blocker');
  const access = await taskAccess(ctx, taskId);
  requireProjectRole(ctx, access.projectRole, 'member');

  await withOrg(ctx.orgId, async (tx) => {
    await tx.query(
      'UPDATE blockers SET resolved_at = now(), resolved_by = $2 WHERE id = $1',
      [blockerId, ctx.userId],
    );
    // With no blockers left, return the task to "todo" rather than guessing.
    await tx.query(
      `UPDATE tasks SET status_id = s.id, updated_at = now()
         FROM statuses s
        WHERE tasks.id = $1 AND s.project_id = tasks.project_id AND s.category = 'todo'
          AND (SELECT category FROM statuses WHERE id = tasks.status_id) = 'blocked'
          AND NOT EXISTS (SELECT 1 FROM blockers b WHERE b.task_id = $1 AND b.resolved_at IS NULL)`,
      [taskId],
    );
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'blocker',
      entityId: blockerId,
      projectId: access.projectId,
      taskId,
      action: 'resolved',
    });
    const { rows: watchers } = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM watchers WHERE task_id = $1',
      [taskId],
    );
    await notify(tx, {
      orgId: ctx.orgId,
      userIds: watchers.map((w) => w.user_id),
      type: 'blocker.resolved',
      actorId: ctx.userId,
      projectId: access.projectId,
      taskId,
    });
  });
}

export async function listOpenBlockers(ctx: OrgCtx, project: ResolvedProject | null) {
  const params: unknown[] = [ctx.orgId];
  const where = ['b.org_id = $1', 'b.resolved_at IS NULL', 't.deleted_at IS NULL'];
  if (project) {
    requireProjectRole(ctx, project.role, 'viewer');
    params.push(project.id);
    where.push(`t.project_id = $${params.length}`);
  } else if (ctx.orgRole === 'member') {
    params.push(ctx.userId);
    where.push(
      `EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = $${params.length})`,
    );
  }
  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    task_id: string;
    task_ref: string;
    task_title: string;
    reason: string;
    expected_resolution_date: string | null;
    created_at: string;
    age_days: number;
    created_by_name: string;
    assignee_name: string | null;
    downstream_count: number;
  }>(
    `SELECT b.id, b.task_id, p.key || '-' || t.number AS task_ref, t.title AS task_title,
            b.reason, b.expected_resolution_date, b.created_at,
            EXTRACT(DAY FROM now() - b.created_at)::int AS age_days,
            cu.name AS created_by_name, au.name AS assignee_name,
            (WITH RECURSIVE down(id) AS (
               SELECT blocked_task_id FROM task_dependencies WHERE blocking_task_id = t.id
               UNION
               SELECT d.blocked_task_id FROM task_dependencies d JOIN down ON d.blocking_task_id = down.id)
             SELECT count(*)::int FROM down) AS downstream_count
       FROM blockers b
       JOIN tasks t ON t.id = b.task_id
       JOIN projects p ON p.id = t.project_id
       JOIN users cu ON cu.id = b.created_by
       LEFT JOIN users au ON au.id = t.assignee_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.created_at`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    taskRef: r.task_ref,
    taskTitle: r.task_title,
    reason: r.reason,
    expectedResolutionDate: r.expected_resolution_date,
    createdAt: r.created_at,
    ageDays: r.age_days,
    createdByName: r.created_by_name,
    assigneeName: r.assignee_name,
    downstreamCount: r.downstream_count,
  }));
}

// ----------------------------------------------------------------- labels

export async function listLabels(ctx: OrgCtx): Promise<Label[]> {
  const { rows } = await orgDb(ctx.orgId).query<Label>(
    'SELECT id, name, color FROM labels WHERE org_id = $1 ORDER BY name',
    [ctx.orgId],
  );
  return rows;
}

export async function createLabel(ctx: OrgCtx, name: string, color: string): Promise<Label> {
  const { rows } = await orgDb(ctx.orgId).query<Label>(
    `INSERT INTO labels (org_id, name, color) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, lower(name)) DO UPDATE SET color = EXCLUDED.color
     RETURNING id, name, color`,
    [ctx.orgId, name, color],
  );
  return rows[0]!;
}

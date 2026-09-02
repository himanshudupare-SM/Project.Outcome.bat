import type { ActivityEvent } from '@outcome/shared';
import { type Queryable, orgDb } from '../../platform/db.js';
import type { OrgCtx } from '../../platform/ctx.js';

export interface RecordEventInput {
  orgId: string;
  actorType: 'user' | 'ai' | 'system';
  actorId: string | null;
  entityType: string;
  entityId: string;
  projectId?: string | null;
  taskId?: string | null;
  action: string;
  data?: Record<string, unknown>;
}

/**
 * Append-only audit/activity write. Always called inside the same
 * transaction as the change it describes, so the log cannot drift.
 */
export async function recordEvent(tx: Queryable, input: RecordEventInput): Promise<void> {
  await tx.query(
    `INSERT INTO activity_events
       (org_id, actor_type, actor_id, entity_type, entity_id, project_id, task_id, action, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.orgId,
      input.actorType,
      input.actorId,
      input.entityType,
      input.entityId,
      input.projectId ?? null,
      input.taskId ?? null,
      input.action,
      JSON.stringify(input.data ?? {}),
    ],
  );
}

/** Diff two records into one field-change event payload per changed field. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): Array<{ field: string; old: unknown; new: unknown }> {
  const changes: Array<{ field: string; old: unknown; new: unknown }> = [];
  for (const field of fields) {
    if (!(field in after)) continue;
    const oldValue = before[field] ?? null;
    const newValue = after[field] ?? null;
    if (String(oldValue) !== String(newValue)) {
      changes.push({ field, old: oldValue, new: newValue });
    }
  }
  return changes;
}

export async function listActivity(
  ctx: OrgCtx,
  opts: { projectId?: string; taskId?: string; limit: number; cursor?: string },
): Promise<{ items: ActivityEvent[]; nextCursor: string | null }> {
  const params: unknown[] = [ctx.orgId];
  const where = ['e.org_id = $1'];

  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`e.project_id = $${params.length}`);
  }
  if (opts.taskId) {
    params.push(opts.taskId);
    where.push(`e.task_id = $${params.length}`);
  }
  if (opts.cursor) {
    params.push(Number(opts.cursor));
    where.push(`e.id < $${params.length}`);
  }
  // Non-admins only see activity for projects they can access.
  if (ctx.orgRole === 'member') {
    params.push(ctx.userId);
    where.push(`(e.project_id IS NULL OR EXISTS (
      SELECT 1 FROM project_members pm
       WHERE pm.project_id = e.project_id AND pm.user_id = $${params.length}))`);
  }
  params.push(opts.limit + 1);

  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    actor_type: 'user' | 'ai' | 'system';
    actor_id: string | null;
    actor_name: string | null;
    entity_type: string;
    entity_id: string;
    project_id: string | null;
    task_id: string | null;
    task_ref: string | null;
    action: string;
    data: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT e.id::text AS id, e.actor_type, e.actor_id, u.name AS actor_name,
            e.entity_type, e.entity_id, e.project_id, e.task_id,
            CASE WHEN t.id IS NULL THEN NULL ELSE p.key || '-' || t.number END AS task_ref,
            e.action, e.data, e.created_at
       FROM activity_events e
       LEFT JOIN users u ON u.id = e.actor_id
       LEFT JOIN tasks t ON t.id = e.task_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const items = rows.slice(0, opts.limit).map((r) => ({
    id: r.id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    entityType: r.entity_type,
    entityId: r.entity_id,
    projectId: r.project_id,
    taskId: r.task_id,
    taskRef: r.task_ref,
    action: r.action,
    data: r.data ?? {},
    createdAt: r.created_at,
  }));
  return {
    items,
    nextCursor: rows.length > opts.limit ? items[items.length - 1]!.id : null,
  };
}

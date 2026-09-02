import type { Notification, NotificationType } from '@outcome/shared';
import { type Queryable, orgDb } from '../../platform/db.js';
import type { OrgCtx } from '../../platform/ctx.js';

export interface NotifyInput {
  orgId: string;
  userIds: string[];
  type: NotificationType;
  actorId: string | null;
  projectId?: string | null;
  taskId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Fan out notifications, skipping the actor (nobody needs to be told what
 * they just did) and respecting per-user in-app preferences.
 */
export async function notify(tx: Queryable, input: NotifyInput): Promise<number> {
  const recipients = [...new Set(input.userIds.filter((id) => id && id !== input.actorId))];
  if (recipients.length === 0) return 0;

  const { rows } = await tx.query<{ user_id: string }>(
    `INSERT INTO notifications (org_id, user_id, type, actor_id, project_id, task_id, data)
     SELECT $1, u.id, $2, $3, $4, $5, $6
       FROM unnest($7::uuid[]) AS u(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM notification_prefs np
         WHERE np.user_id = u.id AND np.org_id = $1 AND np.event_type = $2 AND np.in_app = false)
     RETURNING user_id`,
    [
      input.orgId,
      input.type,
      input.actorId,
      input.projectId ?? null,
      input.taskId ?? null,
      JSON.stringify(input.data ?? {}),
      recipients,
    ],
  );
  return rows.length;
}

export async function list(
  ctx: OrgCtx,
  opts: { unreadOnly?: boolean; limit: number; cursor?: string },
): Promise<{ items: Notification[]; nextCursor: string | null; unreadCount: number }> {
  const params: unknown[] = [ctx.orgId, ctx.userId];
  const where = ['n.org_id = $1', 'n.user_id = $2'];
  if (opts.unreadOnly) where.push('n.read_at IS NULL');
  if (opts.cursor) {
    params.push(opts.cursor);
    where.push(`n.created_at < $${params.length}`);
  }
  params.push(opts.limit + 1);

  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    type: NotificationType;
    actor_id: string | null;
    actor_name: string | null;
    project_id: string | null;
    project_key: string | null;
    task_id: string | null;
    task_ref: string | null;
    task_title: string | null;
    data: Record<string, unknown>;
    read_at: string | null;
    created_at: string;
  }>(
    `SELECT n.id, n.type, n.actor_id, a.name AS actor_name, n.project_id, p.key AS project_key,
            n.task_id, CASE WHEN t.id IS NULL THEN NULL ELSE p.key || '-' || t.number END AS task_ref,
            t.title AS task_title, n.data, n.read_at, n.created_at
       FROM notifications n
       LEFT JOIN users a ON a.id = n.actor_id
       LEFT JOIN tasks t ON t.id = n.task_id
       LEFT JOIN projects p ON p.id = COALESCE(t.project_id, n.project_id)
      WHERE ${where.join(' AND ')}
      ORDER BY n.created_at DESC
      LIMIT $${params.length}`,
    params,
  );

  const { rows: counts } = await orgDb(ctx.orgId).query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications
      WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL`,
    [ctx.orgId, ctx.userId],
  );

  const items: Notification[] = rows.slice(0, opts.limit).map((r) => ({
    id: r.id,
    type: r.type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    projectId: r.project_id,
    projectKey: r.project_key,
    taskId: r.task_id,
    taskRef: r.task_ref,
    taskTitle: r.task_title,
    data: r.data ?? {},
    readAt: r.read_at,
    createdAt: r.created_at,
  }));

  return {
    items,
    nextCursor: rows.length > opts.limit ? items[items.length - 1]!.createdAt : null,
    unreadCount: counts[0]?.n ?? 0,
  };
}

export async function markRead(ctx: OrgCtx, ids: string[] | 'all'): Promise<number> {
  if (ids === 'all') {
    const { rowCount } = await orgDb(ctx.orgId).query(
      `UPDATE notifications SET read_at = now()
        WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL`,
      [ctx.orgId, ctx.userId],
    );
    return rowCount;
  }
  if (ids.length === 0) return 0;
  const { rowCount } = await orgDb(ctx.orgId).query(
    `UPDATE notifications SET read_at = now()
      WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL AND id = ANY($3::uuid[])`,
    [ctx.orgId, ctx.userId, ids],
  );
  return rowCount;
}

/** @mention parsing: matches @name-ish tokens, resolved against org members. */
export async function resolveMentions(
  tx: Queryable,
  orgId: string,
  body: string,
): Promise<string[]> {
  const handles = [...body.matchAll(/@([\w][\w.-]{1,60})/g)].map((m) => m[1]!.toLowerCase());
  if (handles.length === 0) return [];
  const { rows } = await tx.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN org_members m ON m.user_id = u.id AND m.org_id = $1
      WHERE u.deleted_at IS NULL
        AND (lower(split_part(u.email, '@', 1)) = ANY($2::text[])
             OR lower(replace(u.name, ' ', '.')) = ANY($2::text[])
             OR lower(split_part(u.name, ' ', 1)) = ANY($2::text[]))`,
    [orgId, handles],
  );
  return rows.map((r) => r.id);
}

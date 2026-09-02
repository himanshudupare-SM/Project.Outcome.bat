import type { Comment, CreateCommentInput } from '@outcome/shared';
import { withOrg, orgDb } from '../../platform/db.js';
import { ForbiddenError, NotFoundError } from '../../platform/errors.js';
import { canModifyOwn, requireProjectRole } from '../auth/policy.js';
import { recordEvent } from '../activity/service.js';
import { notify, resolveMentions } from '../notifications/service.js';
import { taskAccess } from '../tasks/service.js';
import type { OrgCtx } from '../../platform/ctx.js';

/** Authors may edit their own comments for this long; leads can always edit. */
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function editable(ctx: OrgCtx, authorId: string, createdAt: string): boolean {
  if (ctx.userId !== authorId) return false;
  return Date.now() - new Date(createdAt).getTime() < EDIT_WINDOW_MS;
}

export async function list(ctx: OrgCtx, taskId: string): Promise<Comment[]> {
  const access = await taskAccess(ctx, taskId);
  requireProjectRole(ctx, access.projectRole, 'viewer');
  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    task_id: string;
    author_id: string;
    author_name: string;
    body: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT c.id, c.task_id, c.author_id, u.name AS author_name, c.body, c.created_at, c.updated_at
       FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.task_id = $1 AND c.org_id = $2 AND c.deleted_at IS NULL
      ORDER BY c.created_at`,
    [taskId, ctx.orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    authorId: r.author_id,
    authorName: r.author_name,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    editable: editable(ctx, r.author_id, r.created_at),
  }));
}

export async function create(
  ctx: OrgCtx,
  taskId: string,
  input: CreateCommentInput,
): Promise<Comment> {
  const access = await taskAccess(ctx, taskId);
  // Viewers may comment: it is the main way non-members contribute.
  requireProjectRole(ctx, access.projectRole, 'viewer');

  return withOrg(ctx.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string; created_at: string; updated_at: string }>(
      `INSERT INTO comments (org_id, task_id, author_id, body) VALUES ($1, $2, $3, $4)
       RETURNING id, created_at, updated_at`,
      [ctx.orgId, taskId, ctx.userId, input.body],
    );
    const row = rows[0]!;
    await tx.query('INSERT INTO watchers (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      taskId,
      ctx.userId,
    ]);
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'comment',
      entityId: row.id,
      projectId: access.projectId,
      taskId,
      action: 'created',
    });

    const mentioned = await resolveMentions(tx, ctx.orgId, input.body);
    if (mentioned.length > 0) {
      await notify(tx, {
        orgId: ctx.orgId,
        userIds: mentioned,
        type: 'comment.mentioned',
        actorId: ctx.userId,
        projectId: access.projectId,
        taskId,
        data: { commentId: row.id },
      });
    }
    const { rows: watchers } = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM watchers WHERE task_id = $1',
      [taskId],
    );
    const others = watchers.map((w) => w.user_id).filter((id) => !mentioned.includes(id));
    await notify(tx, {
      orgId: ctx.orgId,
      userIds: others,
      type: 'comment.created',
      actorId: ctx.userId,
      projectId: access.projectId,
      taskId,
      data: { commentId: row.id },
    });

    const { rows: authors } = await tx.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [
      ctx.userId,
    ]);
    return {
      id: row.id,
      taskId,
      authorId: ctx.userId,
      authorName: authors[0]?.name ?? '',
      body: input.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      editable: true,
    };
  });
}

export async function update(ctx: OrgCtx, commentId: string, body: string): Promise<Comment> {
  const { rows } = await orgDb(ctx.orgId).query<{ task_id: string; author_id: string; created_at: string }>(
    'SELECT task_id, author_id, created_at FROM comments WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
    [commentId, ctx.orgId],
  );
  const existing = rows[0];
  if (!existing) throw new NotFoundError('Comment');
  const access = await taskAccess(ctx, existing.task_id);
  if (!editable(ctx, existing.author_id, existing.created_at)) {
    throw new ForbiddenError(
      ctx.userId === existing.author_id
        ? 'Comments can only be edited within 24 hours'
        : 'You can only edit your own comments',
    );
  }
  requireProjectRole(ctx, access.projectRole, 'viewer');
  await orgDb(ctx.orgId).query('UPDATE comments SET body = $2, updated_at = now() WHERE id = $1', [commentId, body]);
  const all = await list(ctx, existing.task_id);
  const updated = all.find((c) => c.id === commentId);
  if (!updated) throw new NotFoundError('Comment');
  return updated;
}

export async function remove(ctx: OrgCtx, commentId: string): Promise<void> {
  const { rows } = await orgDb(ctx.orgId).query<{ task_id: string; author_id: string }>(
    'SELECT task_id, author_id FROM comments WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
    [commentId, ctx.orgId],
  );
  const existing = rows[0];
  if (!existing) throw new NotFoundError('Comment');
  const access = await taskAccess(ctx, existing.task_id);
  if (!canModifyOwn(ctx, existing.author_id, access.projectRole)) {
    throw new ForbiddenError('You can only delete your own comments');
  }
  await withOrg(ctx.orgId, async (tx) => {
    await tx.query('UPDATE comments SET deleted_at = now() WHERE id = $1', [commentId]);
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'comment',
      entityId: commentId,
      projectId: access.projectId,
      taskId: existing.task_id,
      action: 'deleted',
    });
  });
}

import { db, orgDb } from '../../platform/db.js';
import type { OrgCtx } from '../../platform/ctx.js';

export interface SearchHit {
  kind: 'task' | 'epic' | 'project' | 'comment';
  id: string;
  title: string;
  subtitle: string | null;
  projectKey: string | null;
  taskRef: string | null;
  taskId: string | null;
  rank: number;
}

/**
 * Federated keyword search. Every branch re-applies the visibility rule for
 * org members (project membership), so search can never leak a project the
 * caller cannot open.
 */
export async function search(
  ctx: OrgCtx,
  q: string,
  kinds: SearchHit['kind'][],
  limit: number,
): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];
  const memberScoped = ctx.orgRole === 'member';
  const visible = (alias: string) =>
    memberScoped
      ? `AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ${alias} AND pm.user_id = $3)`
      : '';
  const params: unknown[] = [ctx.orgId, trimmed];
  if (memberScoped) params.push(ctx.userId);
  params.push(limit);
  const limitParam = `$${params.length}`;

  const parts: string[] = [];
  if (kinds.includes('task')) {
    parts.push(`
      SELECT 'task' AS kind, t.id::text AS id, t.title AS title,
             left(t.description, 160) AS subtitle, p.key AS project_key,
             p.key || '-' || t.number AS task_ref, t.id::text AS task_id,
             ts_rank(t.search, websearch_to_tsquery('english', $2)) + 0.3 AS rank
        FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.org_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL
         AND (t.search @@ websearch_to_tsquery('english', $2) OR t.title ILIKE '%' || $2 || '%')
         ${visible('t.project_id')}`);
  }
  if (kinds.includes('epic')) {
    parts.push(`
      SELECT 'epic', e.id::text, e.name, left(e.description, 160), p.key, NULL, NULL,
             ts_rank(e.search, websearch_to_tsquery('english', $2)) + 0.2
        FROM epics e JOIN projects p ON p.id = e.project_id
       WHERE e.org_id = $1 AND e.deleted_at IS NULL AND p.deleted_at IS NULL
         AND (e.search @@ websearch_to_tsquery('english', $2) OR e.name ILIKE '%' || $2 || '%')
         ${visible('e.project_id')}`);
  }
  if (kinds.includes('project')) {
    parts.push(`
      SELECT 'project', p.id::text, p.name, p.key, p.key, NULL, NULL,
             ts_rank(p.search, websearch_to_tsquery('english', $2)) + 0.5
        FROM projects p
       WHERE p.org_id = $1 AND p.deleted_at IS NULL
         AND (p.search @@ websearch_to_tsquery('english', $2) OR p.name ILIKE '%' || $2 || '%'
              OR p.key ILIKE '%' || $2 || '%')
         ${visible('p.id')}`);
  }
  if (kinds.includes('comment')) {
    parts.push(`
      SELECT 'comment', c.id::text, left(c.body, 120), t.title, p.key,
             p.key || '-' || t.number, t.id::text,
             ts_rank(c.search, websearch_to_tsquery('english', $2))
        FROM comments c
        JOIN tasks t ON t.id = c.task_id AND t.deleted_at IS NULL
        JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
       WHERE c.org_id = $1 AND c.deleted_at IS NULL
         AND c.search @@ websearch_to_tsquery('english', $2)
         ${visible('t.project_id')}`);
  }
  if (parts.length === 0) return [];

  const { rows } = await orgDb(ctx.orgId).query<{
    kind: SearchHit['kind'];
    id: string;
    title: string;
    subtitle: string | null;
    project_key: string | null;
    task_ref: string | null;
    task_id: string | null;
    rank: number;
  }>(
    `SELECT * FROM (${parts.join(' UNION ALL ')}) AS hits
      ORDER BY rank DESC, title
      LIMIT ${limitParam}`,
    params,
  );
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    projectKey: r.project_key,
    taskRef: r.task_ref,
    taskId: r.task_id,
    rank: Number(r.rank),
  }));
}

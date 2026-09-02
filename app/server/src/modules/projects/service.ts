import {
  DEFAULT_STATUSES,
  type CreateEpicInput,
  type CreateProjectInput,
  type Epic,
  type Project,
  type ProjectDetail,
  type ProjectRole,
  type ProjectSummary,
  type Status,
  type UpdateProjectInput,
} from '@outcome/shared';
import { db, isUniqueViolation, withOrg, type Queryable, orgDb } from '../../platform/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.js';
import { requireOrgRole, requireProjectRole } from '../auth/policy.js';
import { recordEvent, diffFields } from '../activity/service.js';
import type { OrgCtx } from '../../platform/ctx.js';
import type { ResolvedProject } from '../../http/context.js';

function deriveKey(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  let key = words.length >= 2 ? words.map((w) => w[0]!).join('') : (words[0] ?? 'PRJ');
  key = key.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (key.length < 2) key = 'PRJ';
  if (!/^[A-Z]/.test(key)) key = `P${key}`.slice(0, 10);
  return key;
}

export async function createProject(ctx: OrgCtx, input: CreateProjectInput): Promise<ProjectDetail> {
  requireOrgRole(ctx, 'member');
  const base = input.key ?? deriveKey(input.name);

  for (let attempt = 0; attempt < 6; attempt++) {
    const key = attempt === 0 ? base : `${base.slice(0, 8)}${attempt + 1}`;
    try {
      return await withOrg(ctx.orgId, async (tx) => {
        const { rows } = await tx.query<{ id: string; created_at: string }>(
          `INSERT INTO projects (org_id, team_id, key, name, description, lead_id, target_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
          [
            ctx.orgId,
            input.teamId ?? null,
            key,
            input.name,
            input.description,
            input.leadId ?? ctx.userId,
            input.targetDate ?? null,
            ctx.userId,
          ],
        );
        const project = rows[0]!;
        await tx.query('INSERT INTO project_counters (project_id) VALUES ($1)', [project.id]);

        for (const [i, s] of DEFAULT_STATUSES.entries()) {
          await tx.query(
            `INSERT INTO statuses (org_id, project_id, name, category, position)
             VALUES ($1, $2, $3, $4, $5)`,
            [ctx.orgId, project.id, s.name, s.category, i],
          );
        }
        // Creator leads by default; a named lead is added as lead too.
        await tx.query(
          `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'lead')
           ON CONFLICT DO NOTHING`,
          [project.id, ctx.userId],
        );
        if (input.leadId && input.leadId !== ctx.userId) {
          await tx.query(
            `INSERT INTO project_members (project_id, user_id, role)
             SELECT $1, m.user_id, 'lead' FROM org_members m
              WHERE m.org_id = $3 AND m.user_id = $2
             ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'lead'`,
            [project.id, input.leadId, ctx.orgId],
          );
        }
        await recordEvent(tx, {
          orgId: ctx.orgId,
          actorType: 'user',
          actorId: ctx.userId,
          entityType: 'project',
          entityId: project.id,
          projectId: project.id,
          action: 'created',
          data: { key, name: input.name },
        });
        return getDetailTx(tx, ctx, project.id, 'lead');
      });
    } catch (err) {
      if (isUniqueViolation(err) && input.key === undefined) continue;
      if (isUniqueViolation(err)) {
        throw new ConflictError(`Project key ${key} is already used`, { key: 'Already in use' });
      }
      throw err;
    }
  }
  throw new ConflictError('Could not allocate a unique project key — pick one explicitly');
}

/** Projects the caller can see: their memberships, or everything for admins. */
export async function listProjects(ctx: OrgCtx, includeArchived = false): Promise<ProjectSummary[]> {
  const visibility =
    ctx.orgRole === 'member'
      ? 'AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2)'
      : '';
  const { rows } = await orgDb(ctx.orgId).query<Record<string, never>>(
    `SELECT p.id, p.key, p.name, p.description, p.team_id, p.lead_id, p.target_date, p.state,
            p.created_at, pmine.role AS role,
            count(t.id) FILTER (WHERE t.id IS NOT NULL AND s.category <> 'done')::int AS open_count,
            count(t.id) FILTER (WHERE s.category = 'done')::int AS done_count,
            count(DISTINCT b.id)::int AS open_blocker_count,
            count(t.id) FILTER (
              WHERE s.category <> 'done' AND t.due_date IS NOT NULL AND t.due_date < current_date
            )::int AS overdue_count
       FROM projects p
       LEFT JOIN project_members pmine ON pmine.project_id = p.id AND pmine.user_id = $2
       LEFT JOIN tasks t ON t.project_id = p.id AND t.deleted_at IS NULL
       LEFT JOIN statuses s ON s.id = t.status_id
       LEFT JOIN blockers b ON b.task_id = t.id AND b.resolved_at IS NULL
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
        ${includeArchived ? '' : "AND p.state = 'active'"}
        ${visibility}
      GROUP BY p.id, pmine.role
      ORDER BY p.created_at DESC`,
    [ctx.orgId, ctx.userId],
  );
  return rows.map((r) => mapSummary(r as unknown as Record<string, unknown>));
}

function mapSummary(r: Record<string, unknown>): ProjectSummary {
  return {
    id: r['id'] as string,
    key: r['key'] as string,
    name: r['name'] as string,
    description: r['description'] as string,
    teamId: (r['team_id'] as string | null) ?? null,
    leadId: (r['lead_id'] as string | null) ?? null,
    targetDate: (r['target_date'] as string | null) ?? null,
    state: r['state'] as 'active' | 'archived',
    role: (r['role'] as ProjectRole | null) ?? null,
    createdAt: r['created_at'] as string,
    openCount: r['open_count'] as number,
    doneCount: r['done_count'] as number,
    openBlockerCount: r['open_blocker_count'] as number,
    overdueCount: r['overdue_count'] as number,
  };
}

export async function getDetail(ctx: OrgCtx, project: ResolvedProject): Promise<ProjectDetail> {
  requireProjectRole(ctx, project.role, 'viewer');
  return withOrg(ctx.orgId, (tx) => getDetailTx(tx, ctx, project.id, project.role));
}

async function getDetailTx(
  tx: Queryable,
  ctx: OrgCtx,
  projectId: string,
  role: ProjectRole | null,
): Promise<ProjectDetail> {
  const { rows } = await tx.query<Record<string, never>>(
    `SELECT id, key, name, description, team_id, lead_id, target_date, state, created_at
       FROM projects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [projectId, ctx.orgId],
  );
  const p = rows[0] as unknown as Record<string, unknown> | undefined;
  if (!p) throw new NotFoundError('Project');

  const { rows: statuses } = await tx.query<{
    id: string;
    name: string;
    category: Status['category'];
    position: number;
  }>(
    'SELECT id, name, category, position FROM statuses WHERE project_id = $1 ORDER BY position',
    [projectId],
  );
  const { rows: members } = await tx.query<{
    user_id: string;
    name: string;
    email: string;
    role: ProjectRole;
  }>(
    `SELECT pm.user_id, u.name, u.email, pm.role
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1 AND u.deleted_at IS NULL ORDER BY u.name`,
    [projectId],
  );

  return {
    id: p['id'] as string,
    key: p['key'] as string,
    name: p['name'] as string,
    description: p['description'] as string,
    teamId: (p['team_id'] as string | null) ?? null,
    leadId: (p['lead_id'] as string | null) ?? null,
    targetDate: (p['target_date'] as string | null) ?? null,
    state: p['state'] as 'active' | 'archived',
    role,
    createdAt: p['created_at'] as string,
    statuses,
    members: members.map((m) => ({ userId: m.user_id, name: m.name, email: m.email, role: m.role })),
  };
}

export async function updateProject(
  ctx: OrgCtx,
  project: ResolvedProject,
  input: UpdateProjectInput,
): Promise<ProjectDetail> {
  requireProjectRole(ctx, project.role, 'lead');
  const { rows: before } = await orgDb(ctx.orgId).query<Record<string, never>>(
    `SELECT name, description, team_id, lead_id, target_date, state FROM projects
      WHERE id = $1 AND org_id = $2`,
    [project.id, ctx.orgId],
  );
  const prev = before[0] as unknown as Record<string, unknown> | undefined;
  if (!prev) throw new NotFoundError('Project');

  const sets: string[] = [];
  const params: unknown[] = [project.id, ctx.orgId];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.name !== undefined) push('name', input.name);
  if (input.description !== undefined) push('description', input.description);
  if (input.teamId !== undefined) push('team_id', input.teamId);
  if (input.leadId !== undefined) push('lead_id', input.leadId);
  if (input.targetDate !== undefined) push('target_date', input.targetDate);
  if (input.state !== undefined) push('state', input.state);
  if (sets.length === 0) throw new ValidationError('No fields to update');

  return withOrg(ctx.orgId, async (tx) => {
    await tx.query(
      `UPDATE projects SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      params,
    );
    const changes = diffFields(
      prev,
      {
        name: input.name,
        description: input.description,
        team_id: input.teamId,
        lead_id: input.leadId,
        target_date: input.targetDate,
        state: input.state,
      } as Record<string, unknown>,
      ['name', 'description', 'team_id', 'lead_id', 'target_date', 'state'],
    );
    if (changes.length > 0) {
      await recordEvent(tx, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        entityType: 'project',
        entityId: project.id,
        projectId: project.id,
        action: 'updated',
        data: { changes },
      });
    }
    return getDetailTx(tx, ctx, project.id, project.role);
  });
}

export async function archiveProject(ctx: OrgCtx, project: ResolvedProject): Promise<void> {
  requireProjectRole(ctx, project.role, 'lead');
  await withOrg(ctx.orgId, async (tx) => {
    await tx.query(
      `UPDATE projects SET state = 'archived', updated_at = now() WHERE id = $1 AND org_id = $2`,
      [project.id, ctx.orgId],
    );
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      action: 'archived',
    });
  });
}

export async function addMember(
  ctx: OrgCtx,
  project: ResolvedProject,
  userId: string,
  role: ProjectRole,
): Promise<void> {
  requireProjectRole(ctx, project.role, 'lead');
  const { rowCount } = await orgDb(ctx.orgId).query(
    `INSERT INTO project_members (project_id, user_id, role)
     SELECT $1, m.user_id, $3 FROM org_members m WHERE m.org_id = $4 AND m.user_id = $2
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [project.id, userId, role, ctx.orgId],
  );
  if (rowCount === 0) throw new ValidationError('That person is not a member of this organization');
}

export async function removeMember(
  ctx: OrgCtx,
  project: ResolvedProject,
  userId: string,
): Promise<void> {
  requireProjectRole(ctx, project.role, 'lead');
  const { rowCount } = await orgDb(ctx.orgId).query(
    'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
    [project.id, userId],
  );
  if (rowCount === 0) throw new NotFoundError('Project member');
}

export async function createEpic(
  ctx: OrgCtx,
  project: ResolvedProject,
  input: CreateEpicInput,
): Promise<Epic> {
  requireProjectRole(ctx, project.role, 'member');
  return withOrg(ctx.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO epics (org_id, project_id, name, description, target_date, position, created_by)
       VALUES ($1, $2, $3, $4, $5,
         COALESCE((SELECT max(position) + 1 FROM epics WHERE project_id = $2), 0), $6)
       RETURNING id`,
      [ctx.orgId, project.id, input.name, input.description, input.targetDate ?? null, ctx.userId],
    );
    const id = rows[0]!.id;
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'epic',
      entityId: id,
      projectId: project.id,
      action: 'created',
      data: { name: input.name },
    });
    return {
      id,
      projectId: project.id,
      name: input.name,
      description: input.description,
      targetDate: input.targetDate ?? null,
      taskCount: 0,
      doneCount: 0,
    };
  });
}

export async function listEpics(ctx: OrgCtx, project: ResolvedProject): Promise<Epic[]> {
  requireProjectRole(ctx, project.role, 'viewer');
  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    project_id: string;
    name: string;
    description: string;
    target_date: string | null;
    task_count: number;
    done_count: number;
  }>(
    `SELECT e.id, e.project_id, e.name, e.description, e.target_date,
            count(t.id)::int AS task_count,
            count(t.id) FILTER (WHERE s.category = 'done')::int AS done_count
       FROM epics e
       LEFT JOIN tasks t ON t.epic_id = e.id AND t.deleted_at IS NULL
       LEFT JOIN statuses s ON s.id = t.status_id
      WHERE e.project_id = $1 AND e.org_id = $2 AND e.deleted_at IS NULL
      GROUP BY e.id
      ORDER BY e.position, e.created_at`,
    [project.id, ctx.orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description,
    targetDate: r.target_date,
    taskCount: r.task_count,
    doneCount: r.done_count,
  }));
}

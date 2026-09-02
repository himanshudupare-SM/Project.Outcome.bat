import type {
  CreateOrgInput,
  CreateTeamInput,
  InviteInput,
  Org,
  OrgMember,
  OrgRole,
  Team,
} from '@outcome/shared';
import { isUniqueViolation, withOrg, withTx, orgDb } from '../../platform/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.js';
import { generateToken, hashToken } from '../../platform/crypto.js';
import { requireOrgRole } from '../auth/policy.js';
import { recordEvent } from '../activity/service.js';
import type { OrgCtx, UserCtx } from '../../platform/ctx.js';

const INVITE_TTL_DAYS = 14;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base.length >= 2 ? base : `org-${generateToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

export async function createOrg(ctx: UserCtx, input: CreateOrgInput): Promise<Org> {
  const desired = input.slug ?? slugify(input.name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? desired : `${desired}-${attempt + 1}`;
    try {
      return await withTx(async (tx) => {
        const { rows } = await tx.query<{ id: string; created_at: string }>(
          `INSERT INTO organizations (name, slug, created_by) VALUES ($1, $2, $3)
           RETURNING id, created_at`,
          [input.name, slug, ctx.userId],
        );
        const org = rows[0]!;
        await tx.query(
          `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [org.id, ctx.userId],
        );
        await tx.query('SELECT set_config($1, $2, true)', ['app.org_id', org.id]);
        await recordEvent(tx, {
          orgId: org.id,
          actorType: 'user',
          actorId: ctx.userId,
          entityType: 'organization',
          entityId: org.id,
          action: 'created',
          data: { name: input.name, slug },
        });
        return {
          id: org.id,
          name: input.name,
          slug,
          role: 'owner' as OrgRole,
          createdAt: org.created_at,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err) && input.slug === undefined) continue;
      if (isUniqueViolation(err)) {
        throw new ConflictError('That URL slug is taken', { slug: 'Already in use' });
      }
      throw err;
    }
  }
  throw new ConflictError('Could not allocate a unique slug — pick one explicitly');
}

export async function listMembers(ctx: OrgCtx): Promise<OrgMember[]> {
  const { rows } = await orgDb(ctx.orgId).query<{
    user_id: string;
    name: string;
    email: string;
    role: OrgRole;
    created_at: string;
  }>(
    `SELECT m.user_id, u.name, u.email, m.role, m.created_at
       FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND u.deleted_at IS NULL
      ORDER BY u.name`,
    [ctx.orgId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    joinedAt: r.created_at,
  }));
}

export async function updateMemberRole(
  ctx: OrgCtx,
  userId: string,
  role: OrgRole,
): Promise<void> {
  requireOrgRole(ctx, 'admin');
  // Only an owner may create or remove owners.
  const { rows } = await orgDb(ctx.orgId).query<{ role: OrgRole }>(
    'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
    [ctx.orgId, userId],
  );
  const current = rows[0];
  if (!current) throw new NotFoundError('Member');
  if ((current.role === 'owner' || role === 'owner') && ctx.orgRole !== 'owner') {
    throw new ValidationError('Only an owner can change owner roles');
  }
  if (current.role === 'owner' && role !== 'owner') {
    const { rows: owners } = await orgDb(ctx.orgId).query<{ n: number }>(
      `SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'`,
      [ctx.orgId],
    );
    if ((owners[0]?.n ?? 0) <= 1) {
      throw new ValidationError('An organization must keep at least one owner');
    }
  }
  await withOrg(ctx.orgId, async (tx) => {
    await tx.query('UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2', [
      ctx.orgId,
      userId,
      role,
    ]);
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'org_member',
      entityId: userId,
      action: 'role_changed',
      data: { from: current.role, to: role },
    });
  });
}

export async function removeMember(ctx: OrgCtx, userId: string): Promise<void> {
  requireOrgRole(ctx, 'admin');
  const { rows } = await orgDb(ctx.orgId).query<{ role: OrgRole }>(
    'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
    [ctx.orgId, userId],
  );
  const current = rows[0];
  if (!current) throw new NotFoundError('Member');
  if (current.role === 'owner') throw new ValidationError('Transfer ownership before removing an owner');
  await withOrg(ctx.orgId, async (tx) => {
    await tx.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [ctx.orgId, userId]);
    await tx.query(
      `DELETE FROM project_members pm USING projects p
        WHERE pm.project_id = p.id AND p.org_id = $1 AND pm.user_id = $2`,
      [ctx.orgId, userId],
    );
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'org_member',
      entityId: userId,
      action: 'removed',
    });
  });
}

export interface CreatedInvite {
  id: string;
  email: string;
  role: 'admin' | 'member';
  expiresAt: string;
  /** Returned once so the caller can surface/send the link. */
  token: string;
}

export async function invite(ctx: OrgCtx, input: InviteInput): Promise<CreatedInvite> {
  requireOrgRole(ctx, 'admin');
  const { rows: existing } = await orgDb(ctx.orgId).query<{ id: string }>(
    `SELECT u.id FROM users u JOIN org_members m ON m.user_id = u.id AND m.org_id = $1
      WHERE u.email = $2`,
    [ctx.orgId, input.email],
  );
  if (existing.length > 0) throw new ConflictError('That person is already a member', { email: 'Already a member' });

  const token = generateToken(32);
  try {
    return await withOrg(ctx.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string; expires_at: string }>(
        `INSERT INTO invitations (org_id, email, role, invited_by, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
         RETURNING id, expires_at`,
        [ctx.orgId, input.email, input.role, ctx.userId, hashToken(token), String(INVITE_TTL_DAYS)],
      );
      const row = rows[0]!;
      await recordEvent(tx, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        entityType: 'invitation',
        entityId: row.id,
        action: 'created',
        data: { email: input.email, role: input.role },
      });
      return { id: row.id, email: input.email, role: input.role, expiresAt: row.expires_at, token };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError('An invitation is already pending for that email', {
        email: 'Invitation pending',
      });
    }
    throw err;
  }
}

export async function listInvitations(ctx: OrgCtx) {
  requireOrgRole(ctx, 'admin');
  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    email: string;
    role: 'admin' | 'member';
    created_at: string;
    expires_at: string;
  }>(
    `SELECT id, email, role, created_at, expires_at FROM invitations
      WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [ctx.orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

export async function revokeInvitation(ctx: OrgCtx, id: string): Promise<void> {
  requireOrgRole(ctx, 'admin');
  const { rowCount } = await orgDb(ctx.orgId).query(
    `UPDATE invitations SET revoked_at = now()
      WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [id, ctx.orgId],
  );
  if (rowCount === 0) throw new NotFoundError('Invitation');
}

/** Accept an invitation as the signed-in user; email must match. */
export async function acceptInvitation(
  ctx: UserCtx,
  token: string,
): Promise<{ orgId: string; slug: string }> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      org_id: string;
      slug: string;
      email: string;
      role: 'admin' | 'member';
    }>(
      `SELECT i.id, i.org_id, o.slug, i.email, i.role
         FROM invitations i JOIN organizations o ON o.id = i.org_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          AND i.expires_at > now() AND o.deleted_at IS NULL
        FOR UPDATE OF i`,
      [hashToken(token)],
    );
    const inv = rows[0];
    if (!inv) throw new NotFoundError('Invitation (it may have expired or been revoked)');

    const { rows: users } = await tx.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
      ctx.userId,
    ]);
    if (users[0]?.email?.toLowerCase() !== inv.email.toLowerCase()) {
      throw new ValidationError('This invitation was sent to a different email address');
    }

    await tx.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [inv.org_id, ctx.userId, inv.role],
    );
    await tx.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [inv.id]);
    await tx.query('SELECT set_config($1, $2, true)', ['app.org_id', inv.org_id]);
    await recordEvent(tx, {
      orgId: inv.org_id,
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'org_member',
      entityId: ctx.userId,
      action: 'joined',
      data: { via: 'invitation', role: inv.role },
    });
    return { orgId: inv.org_id, slug: inv.slug };
  });
}

export async function createTeam(ctx: OrgCtx, input: CreateTeamInput): Promise<Team> {
  requireOrgRole(ctx, 'admin');
  try {
    return await withOrg(ctx.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id',
        [ctx.orgId, input.name],
      );
      const teamId = rows[0]!.id;
      const memberIds = await addTeamMembers(tx, ctx.orgId, teamId, input.memberIds);
      await recordEvent(tx, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        entityType: 'team',
        entityId: teamId,
        action: 'created',
        data: { name: input.name },
      });
      return { id: teamId, name: input.name, memberIds };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A team with that name already exists');
    throw err;
  }
}

async function addTeamMembers(
  tx: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  orgId: string,
  teamId: string,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  // Only org members may be added — silently dropping outsiders keeps the
  // endpoint from becoming a membership oracle.
  const { rows } = await tx.query(
    `INSERT INTO team_members (team_id, user_id)
     SELECT $2, m.user_id FROM org_members m
      WHERE m.org_id = $1 AND m.user_id = ANY($3::uuid[])
     ON CONFLICT DO NOTHING
     RETURNING user_id`,
    [orgId, teamId, userIds],
  );
  return rows.map((r) => r['user_id'] as string);
}

export async function listTeams(ctx: OrgCtx): Promise<Team[]> {
  const { rows } = await orgDb(ctx.orgId).query<{ id: string; name: string; member_ids: string[] | null }>(
    `SELECT t.id, t.name,
            array_remove(array_agg(tm.user_id), NULL) AS member_ids
       FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
      WHERE t.org_id = $1 AND t.deleted_at IS NULL
      GROUP BY t.id, t.name
      ORDER BY t.name`,
    [ctx.orgId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, memberIds: r.member_ids ?? [] }));
}

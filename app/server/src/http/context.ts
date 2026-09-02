import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OrgRole, ProjectRole } from '@outcome/shared';
import { db, orgDb } from '../platform/db.js';
import { AuthRequiredError, ForbiddenError, NotFoundError } from '../platform/errors.js';
import type { OrgCtx, UserCtx } from '../platform/ctx.js';

/** Authenticated user, or 401. Populated by the auth pre-handler. */
export function requireUser(req: FastifyRequest): UserCtx {
  if (!req.userCtx) throw new AuthRequiredError();
  return req.userCtx;
}

/**
 * Resolve the org from the route and confirm membership. An API key is
 * pinned to one org and may not act on any other.
 */
export async function requireOrg(req: FastifyRequest): Promise<OrgCtx> {
  const user = requireUser(req);
  const params = req.params as { orgSlug?: string; orgId?: string };
  const identifier = params.orgSlug ?? params.orgId;
  if (!identifier) throw new NotFoundError('Organization');

  const { rows } = await db.query<{ org_id: string; role: OrgRole }>(
    `SELECT o.id AS org_id, m.role
       FROM organizations o
       JOIN org_members m ON m.org_id = o.id AND m.user_id = $2
      WHERE (o.slug = $1 OR o.id::text = $1) AND o.deleted_at IS NULL`,
    [identifier, user.userId],
  );
  const row = rows[0];
  // A non-member gets the same 404 as a non-existent org: no existence oracle.
  if (!row) throw new NotFoundError('Organization');
  if (req.apiKeyOrgId && req.apiKeyOrgId !== row.org_id) {
    throw new ForbiddenError('This API key is scoped to a different organization');
  }
  return { ...user, orgId: row.org_id, orgRole: row.role };
}

export interface ResolvedProject {
  id: string;
  key: string;
  role: ProjectRole | null;
}

/** Resolve `:projectKey` (or `:projectId`) within the org and the caller's role in it. */
export async function resolveProject(
  ctx: OrgCtx,
  identifier: string,
): Promise<ResolvedProject> {
  const { rows } = await orgDb(ctx.orgId).query<{ id: string; key: string; role: ProjectRole | null }>(
    `SELECT p.id, p.key, pm.role
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $3
      WHERE p.org_id = $1
        AND (upper(p.key) = upper($2) OR p.id::text = $2)
        AND p.deleted_at IS NULL`,
    [ctx.orgId, identifier, ctx.userId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('Project');
  return { id: row.id, key: row.key, role: row.role };
}

export function clientIp(req: FastifyRequest): string | undefined {
  return req.ip;
}

export function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}

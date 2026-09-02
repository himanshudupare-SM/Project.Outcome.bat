import type { OrgRole, ProjectRole } from '@outcome/shared';
import { ForbiddenError } from '../../platform/errors.js';
import type { OrgCtx } from '../../platform/ctx.js';

/**
 * The single place authorization rules live. Services call `require*`
 * before mutating; reads are additionally scoped by membership joins.
 */
const ORG_RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };
const PROJECT_RANK: Record<ProjectRole, number> = { viewer: 1, member: 2, lead: 3 };

export function hasOrgRole(role: OrgRole, atLeast: OrgRole): boolean {
  return ORG_RANK[role] >= ORG_RANK[atLeast];
}

export function requireOrgRole(ctx: OrgCtx, atLeast: OrgRole): void {
  if (!hasOrgRole(ctx.orgRole, atLeast)) {
    throw new ForbiddenError(`This action requires the ${atLeast} role in this organization`);
  }
}

export function hasProjectRole(
  ctx: OrgCtx,
  projectRole: ProjectRole | null,
  atLeast: ProjectRole,
): boolean {
  // Org admins/owners have lead-equivalent authority inside every project.
  if (hasOrgRole(ctx.orgRole, 'admin')) return true;
  if (!projectRole) return false;
  return PROJECT_RANK[projectRole] >= PROJECT_RANK[atLeast];
}

export function requireProjectRole(
  ctx: OrgCtx,
  projectRole: ProjectRole | null,
  atLeast: ProjectRole,
): void {
  if (!hasProjectRole(ctx, projectRole, atLeast)) {
    throw new ForbiddenError(
      projectRole
        ? `This action requires the ${atLeast} role in this project`
        : 'You are not a member of this project',
    );
  }
}

/** Comment/blocker edit rules: author, project lead, or org admin. */
export function canModifyOwn(ctx: OrgCtx, authorId: string, projectRole: ProjectRole | null): boolean {
  return ctx.userId === authorId || hasProjectRole(ctx, projectRole, 'lead');
}

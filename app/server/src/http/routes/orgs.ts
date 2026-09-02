import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createOrgInput,
  createTeamInput,
  inviteInput,
  ORG_ROLES,
  updateMemberRoleInput,
} from '@outcome/shared';
import * as orgs from '../../modules/orgs/service.js';
import { requireOrg, requireUser } from '../context.js';
import { config } from '../../platform/config.js';

export async function registerOrgRoutes(app: FastifyInstance): Promise<void> {
  app.post('/orgs', async (req, reply) => {
    const user = requireUser(req);
    const input = createOrgInput.parse(req.body);
    return reply.status(201).send(await orgs.createOrg(user, input));
  });

  app.get('/orgs/:orgSlug/members', async (req) => {
    const ctx = await requireOrg(req);
    return orgs.listMembers(ctx);
  });

  app.patch('/orgs/:orgSlug/members/:userId', async (req) => {
    const ctx = await requireOrg(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const { role } = updateMemberRoleInput.parse(req.body);
    await orgs.updateMemberRole(ctx, userId, role);
    return { ok: true };
  });

  app.delete('/orgs/:orgSlug/members/:userId', async (req) => {
    const ctx = await requireOrg(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    await orgs.removeMember(ctx, userId);
    return { ok: true };
  });

  app.post('/orgs/:orgSlug/invitations', async (req, reply) => {
    const ctx = await requireOrg(req);
    const input = inviteInput.parse(req.body);
    const created = await orgs.invite(ctx, input);
    // Email delivery is a post-MVP job; the link is returned so the inviter
    // can share it, and the token is never persisted in plaintext.
    return reply.status(201).send({
      id: created.id,
      email: created.email,
      role: created.role,
      expiresAt: created.expiresAt,
      inviteUrl: `${config().APP_URL}/invite/${created.token}`,
    });
  });

  app.get('/orgs/:orgSlug/invitations', async (req) => {
    const ctx = await requireOrg(req);
    return orgs.listInvitations(ctx);
  });

  app.delete('/orgs/:orgSlug/invitations/:id', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await orgs.revokeInvitation(ctx, id);
    return { ok: true };
  });

  app.get('/orgs/:orgSlug/teams', async (req) => {
    const ctx = await requireOrg(req);
    return orgs.listTeams(ctx);
  });

  app.post('/orgs/:orgSlug/teams', async (req, reply) => {
    const ctx = await requireOrg(req);
    const input = createTeamInput.parse(req.body);
    return reply.status(201).send(await orgs.createTeam(ctx, input));
  });

  // Convenience for the UI: the caller's own role, used to gate affordances.
  app.get('/orgs/:orgSlug', async (req) => {
    const ctx = await requireOrg(req);
    return { id: ctx.orgId, role: ctx.orgRole, roles: ORG_ROLES };
  });
}

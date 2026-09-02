import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as notifications from '../../modules/notifications/service.js';
import { search } from '../../modules/search/service.js';
import { listActivity } from '../../modules/activity/service.js';
import { requireOrgRole } from '../../modules/auth/policy.js';
import { requireOrg } from '../context.js';

export async function registerMiscRoutes(app: FastifyInstance): Promise<void> {
  app.get('/orgs/:orgSlug/notifications', async (req) => {
    const ctx = await requireOrg(req);
    const query = z
      .object({
        unreadOnly: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z.string().optional(),
      })
      .parse(req.query);
    return notifications.list(ctx, query);
  });

  app.post('/orgs/:orgSlug/notifications/read', async (req) => {
    const ctx = await requireOrg(req);
    const body = z
      .object({ ids: z.union([z.literal('all'), z.array(z.string().uuid()).max(200)]) })
      .parse(req.body);
    const count = await notifications.markRead(ctx, body.ids);
    return { updated: count };
  });

  app.get('/orgs/:orgSlug/search', async (req) => {
    const ctx = await requireOrg(req);
    const query = z
      .object({
        q: z.string().min(1).max(200),
        kinds: z
          .string()
          .optional()
          .transform((v) =>
            v
              ? (v.split(',').filter((k) =>
                  ['task', 'epic', 'project', 'comment'].includes(k),
                ) as ('task' | 'epic' | 'project' | 'comment')[])
              : (['task', 'epic', 'project', 'comment'] as const).slice(),
          ),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(req.query);
    return { items: await search(ctx, query.q, query.kinds, query.limit) };
  });

  /** Org-wide audit log — admins only. */
  app.get('/orgs/:orgSlug/audit', async (req) => {
    const ctx = await requireOrg(req);
    requireOrgRole(ctx, 'admin');
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
      .parse(req.query);
    return listActivity(ctx, query);
  });
}

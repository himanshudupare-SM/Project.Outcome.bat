import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  approveBraindumpInput,
  askAssistantInput,
  confirmActionInput,
  createBraindumpInput,
} from '@outcome/shared';
import * as braindump from '../../modules/ai/braindump.js';
import * as assistant from '../../modules/ai/assistant.js';
import { requireOrg } from '../context.js';
import { config } from '../../platform/config.js';

const idParam = z.object({ id: z.string().uuid() });

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  // Extraction is expensive; limit it well below the general API allowance.
  const aiLimit = { rateLimit: { max: 20, timeWindow: config().RATE_LIMIT_WINDOW_MS } };

  app.post('/orgs/:orgSlug/braindumps', { config: aiLimit }, async (req, reply) => {
    const ctx = await requireOrg(req);
    const input = createBraindumpInput.parse(req.body);
    return reply.status(201).send(await braindump.createBraindump(ctx, input));
  });

  app.get('/orgs/:orgSlug/braindumps', async (req) => {
    const ctx = await requireOrg(req);
    return braindump.listBraindumps(ctx);
  });

  app.get('/orgs/:orgSlug/braindumps/:id', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    return braindump.getBraindump(ctx, id);
  });

  app.post('/orgs/:orgSlug/braindumps/:id/approve', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    const input = approveBraindumpInput.parse(req.body);
    return braindump.approveBraindump(ctx, id, input);
  });

  app.post('/orgs/:orgSlug/braindumps/:id/discard', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    await braindump.discardBraindump(ctx, id);
    return { ok: true };
  });

  // ---- assistant ----

  app.post('/orgs/:orgSlug/assistant/ask', { config: aiLimit }, async (req) => {
    const ctx = await requireOrg(req);
    const input = askAssistantInput.parse(req.body);
    return assistant.ask(ctx, input);
  });

  app.get('/orgs/:orgSlug/assistant/conversations', async (req) => {
    const ctx = await requireOrg(req);
    return { items: await assistant.listConversations(ctx) };
  });

  app.get('/orgs/:orgSlug/assistant/conversations/:id', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    return assistant.getConversation(ctx, id);
  });

  /** Applying a proposed action requires an explicit confirmation flag. */
  app.post('/orgs/:orgSlug/assistant/actions/confirm', async (req) => {
    const ctx = await requireOrg(req);
    const input = confirmActionInput.parse(req.body);
    return assistant.confirmAction(ctx, input.actionId);
  });

  app.post('/orgs/:orgSlug/assistant/actions/:id/reject', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    await assistant.rejectAction(ctx, id);
    return { ok: true };
  });
}

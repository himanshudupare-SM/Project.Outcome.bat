import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jiraCredentials, startImportInput } from '@outcome/shared';
import * as importer from '../../modules/importer/service.js';
import { requireOrg } from '../context.js';
import { config } from '../../platform/config.js';

const idParam = z.object({ id: z.string().uuid() });

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  // Each call reaches an external host; keep the allowance tight.
  const limit = { rateLimit: { max: 30, timeWindow: config().RATE_LIMIT_WINDOW_MS } };

  app.post('/orgs/:orgSlug/imports/jira/projects', { config: limit }, async (req) => {
    const ctx = await requireOrg(req);
    const credentials = jiraCredentials.parse(req.body);
    return { items: await importer.listJiraProjects(ctx, credentials) };
  });

  app.post('/orgs/:orgSlug/imports/jira/mapping', { config: limit }, async (req) => {
    const ctx = await requireOrg(req);
    const body = z
      .object({ credentials: jiraCredentials, projectKey: z.string().min(1).max(40) })
      .parse(req.body);
    return importer.suggestMapping(ctx, body.credentials, body.projectKey);
  });

  app.post('/orgs/:orgSlug/imports/jira/run', { config: limit }, async (req, reply) => {
    const ctx = await requireOrg(req);
    const input = startImportInput.parse(req.body);
    const result = await importer.runImport(ctx, input.credentials, input.mapping, input.dryRun);
    return reply.status(input.dryRun ? 200 : 201).send(result);
  });

  app.get('/orgs/:orgSlug/imports', async (req) => {
    const ctx = await requireOrg(req);
    return { items: await importer.listRuns(ctx) };
  });

  app.get('/orgs/:orgSlug/imports/:id', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    return importer.getRun(ctx, id);
  });

  app.get('/orgs/:orgSlug/imports/:id/items', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    const query = z.object({ onlyFailed: z.coerce.boolean().default(false) }).parse(req.query);
    return { items: await importer.listItems(ctx, id, query.onlyFailed) };
  });

  app.post('/orgs/:orgSlug/imports/:id/retry', { config: limit }, async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    const credentials = jiraCredentials.parse(req.body);
    return importer.retryFailed(ctx, id, credentials);
  });
}

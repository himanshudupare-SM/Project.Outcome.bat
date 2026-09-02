import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerAiRoutes } from './routes/ai.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (api) => {
      await registerAuthRoutes(api);
      await registerOrgRoutes(api);
      await registerProjectRoutes(api);
      await registerTaskRoutes(api);
      await registerMiscRoutes(api);
      await registerAiRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const { db } = await import('../platform/db.js');
    try {
      await db.query('SELECT 1');
      return { status: 'ready', checks: { database: 'ok' } };
    } catch (err) {
      return reply
        .status(503)
        .send({ status: 'not_ready', checks: { database: (err as Error).message } });
    }
  });
}

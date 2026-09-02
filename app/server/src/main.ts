import './platform/env-load.js';

import { buildApp } from './http/app.js';
import { config, describeConfig } from './platform/config.js';
import { closePool, db } from './platform/db.js';
import { logger } from './platform/logger.js';
import { migrate } from './platform/migrate.js';

const cfg = config();
logger.info({ config: describeConfig(cfg) }, 'starting outcome api');

// Fail fast if the database is unreachable — better than serving 500s.
await db.query('SELECT 1');
if (!cfg.isProd) {
  const applied = await migrate();
  if (applied.length > 0) logger.info({ applied }, 'applied pending migrations');
}

const app = await buildApp();

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closePool();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: cfg.PORT, host: cfg.HOST });

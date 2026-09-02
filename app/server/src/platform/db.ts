import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Thin SQL-first data layer.
 *
 * Tenancy contract: every tenant-scoped query runs inside `withOrg`, which
 * sets `app.org_id` for the transaction so Postgres RLS (0003_rls.sql) can
 * fail closed if an application query ever forgets its org filter.
 */
/** Any object shape a query can return; interfaces need no index signature. */
export type Row = object;
export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

// numeric/int8 as numbers rather than strings (safe for our magnitudes)
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// dates as plain YYYY-MM-DD strings, no timezone shifting
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
/**
 * Timestamps as ISO 8601 strings rather than Date objects.
 *
 * Two bugs this avoids: a driver Date stringifies to a format Postgres cannot
 * parse back (which broke keyset cursors built by interpolating the value),
 * and going through `new Date()` truncates Postgres's microseconds to
 * milliseconds, which makes a cursor compare as older than the row it came
 * from and returns an empty page. So reformat the text in place and keep
 * every digit.
 */
export function timestampToIso(raw: string | null): string | null {
  if (raw === null) return null;
  // '2026-09-02 17:35:22.123456+00' -> '2026-09-02T17:35:22.123456Z'
  return raw
    .replace(' ', 'T')
    .replace(/([+-]\d\d)$/, '$1:00')
    .replace(/\+00:00$/, 'Z');
}
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, timestampToIso);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, timestampToIso);

let poolInstance: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (!poolInstance) {
    poolInstance = new pg.Pool({
      connectionString: config().DATABASE_URL,
      max: config().DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'outcome-api',
    });
    poolInstance.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
  }
  return poolInstance;
}

export async function closePool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}

export const db: Queryable = {
  query: async <T extends Row = Row>(sql: string, params: readonly unknown[] = []) => {
    const res = await pool().query<T>(sql, params as unknown[]);
    return { rows: res.rows, rowCount: res.rowCount ?? 0 };
  },
};

/** Run a function inside a transaction. */
export async function withTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const tx: Queryable = {
      query: async (sql, params = []) => {
        const res = await client.query(sql, params as unknown[]);
        return { rows: res.rows as never[], rowCount: res.rowCount ?? 0 };
      },
    };
    const out = await fn(tx);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run inside a transaction with the tenant context set. All request-scoped
 * data access goes through this, so RLS is always armed.
 */
export async function withOrg<T>(orgId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return withTx(async (tx) => {
    await tx.query('SELECT set_config($1, $2, true)', ['app.org_id', orgId]);
    return fn(tx);
  });
}

/**
 * A Queryable pinned to one organization: each call runs in its own
 * transaction with `app.org_id` set, so reads are RLS-protected too. Use
 * this (not `db`) for anything touching a tenant table.
 */
export function orgDb(orgId: string): Queryable {
  return {
    query: <T extends Row = Row>(sql: string, params: readonly unknown[] = []) =>
      withOrg(orgId, (tx) => tx.query<T>(sql, params)),
  };
}

/** True when the error is a unique-violation on the given constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}

import type { FastifyInstance } from 'fastify';
import { buildApp, CSRF_COOKIE, SESSION_COOKIE } from '../src/http/app.js';
import { db, pool } from '../src/platform/db.js';
import { migrate } from '../src/platform/migrate.js';

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    await migrate();
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function closeApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
  await pool().end();
}

/** Wipe all data (keep schema) so each test file starts clean. */
export async function truncateAll(): Promise<void> {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `public."${r.tablename}"`).join(', ');
  await db.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export interface TestClient {
  userId: string;
  email: string;
  cookies: string;
  csrf: string;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

/** Authenticated request helper that carries session + CSRF like the browser. */
export async function api<T = unknown>(
  client: TestClient | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<ApiResult<T>> {
  const instance = await getApp();
  const headers: Record<string, string> = {};
  if (client) {
    headers['cookie'] = client.cookies;
    headers['x-csrf-token'] = client.csrf;
  }
  const res = await instance.inject({ method, url, payload: payload as never, headers });
  let body: unknown;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body: body as T };
}

function readCookies(res: { cookies: Array<{ name: string; value: string }> }): {
  cookies: string;
  csrf: string;
} {
  const cookies = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf = res.cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? '';
  return { cookies, csrf };
}

export async function signup(
  email: string,
  name = email.split('@')[0]!,
  password = 'test-password-1234',
): Promise<TestClient> {
  const instance = await getApp();
  const res = await instance.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, name, password },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const parsed = JSON.parse(res.body) as { user: { id: string } };
  const { cookies, csrf } = readCookies(res);
  return { userId: parsed.user.id, email, cookies, csrf };
}

export async function login(
  email: string,
  password = 'test-password-1234',
): Promise<TestClient> {
  const instance = await getApp();
  const res = await instance.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const parsed = JSON.parse(res.body) as { user: { id: string } };
  const { cookies, csrf } = readCookies(res);
  return { userId: parsed.user.id, email, cookies, csrf };
}

export { SESSION_COOKIE, CSRF_COOKIE };

/** Create an org + project and return the ids/slugs tests need. */
export async function bootstrapOrgProject(
  client: TestClient,
  orgName = 'Test Org',
  projectName = 'Test Project',
): Promise<{ orgSlug: string; orgId: string; projectKey: string; projectId: string; statuses: Array<{ id: string; category: string; name: string }> }> {
  const org = await api<{ id: string; slug: string }>(client, 'POST', '/api/v1/orgs', {
    name: orgName,
  });
  if (org.status !== 201) throw new Error(`org create failed: ${JSON.stringify(org.body)}`);
  const project = await api<{
    id: string;
    key: string;
    statuses: Array<{ id: string; category: string; name: string }>;
  }>(client, 'POST', `/api/v1/orgs/${org.body.slug}/projects`, { name: projectName });
  if (project.status !== 201) throw new Error(`project create failed: ${JSON.stringify(project.body)}`);
  return {
    orgSlug: org.body.slug,
    orgId: org.body.id,
    projectKey: project.body.key,
    projectId: project.body.id,
    statuses: project.body.statuses,
  };
}

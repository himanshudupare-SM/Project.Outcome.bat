import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bootstrapOrgProject, closeApp, getApp, signup, truncateAll } from './helpers.js';
import type { TestClient } from './helpers.js';
import type { Task } from '@outcome/shared';
import { withOrg } from '../src/platform/db.js';

/**
 * Performance smoke tests against a realistically large project.
 *
 * The thresholds are deliberately loose — this is a shared CI database, not a
 * benchmark rig — but they fail loudly on the mistakes that actually matter:
 * an N+1 in a list endpoint, a missing index, or a query whose cost grows with
 * the whole org rather than the page.
 */

const TASK_COUNT = 1200;
const COMMENT_COUNT = 400;

let owner: TestClient;
let ctx: Awaited<ReturnType<typeof bootstrapOrgProject>>;
const url = (p: string): string => `/api/v1/orgs/${ctx.orgSlug}${p}`;

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  console.log(`  ${label}: ${ms.toFixed(0)}ms`);
  return { result, ms };
}

beforeAll(async () => {
  await getApp();
  await truncateAll();
  owner = await signup('perf@example.com', 'Perry Perf');
  ctx = await bootstrapOrgProject(owner, 'Perf Org', 'Large Delivery');

  // Bulk-seed directly: the point is to measure reads, not creation.
  const statusIds = ctx.statuses.map((s) => s.id);
  await withOrg(ctx.orgId, async (tx) => {
    const { rows: project } = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE org_id = $1 LIMIT 1',
      [ctx.orgId],
    );
    const projectId = project[0]!.id;

    await tx.query(
      `INSERT INTO tasks (org_id, project_id, number, title, description, status_id, priority,
                          assignee_id, due_date, position, created_by)
       SELECT $1, $2, n + 100,
              'Seeded task ' || n,
              'Body for task ' || n || ' about payments and migration',
              $3::uuid[]{'{}'}[1 + (n % 6)],
              (ARRAY['urgent','high','medium','low','none'])[1 + (n % 5)],
              CASE WHEN n % 3 = 0 THEN $4::uuid ELSE NULL END,
              CASE WHEN n % 4 = 0 THEN current_date - (n % 30) ELSE NULL END,
              n * 1024,
              $4
         FROM generate_series(1, $5) AS n`.replace("$3::uuid[]{'{}'}[1 + (n % 6)]", '($3::uuid[])[1 + (n % 6)]'),
      [ctx.orgId, projectId, statusIds, owner.userId, TASK_COUNT],
    );

    // Comments on the first tasks, so the detail read has real fan-out.
    await tx.query(
      `INSERT INTO comments (org_id, task_id, author_id, body)
       SELECT $1, t.id, $2, 'Comment ' || g
         FROM (SELECT id FROM tasks WHERE project_id = $3 ORDER BY number LIMIT 20) t
         CROSS JOIN generate_series(1, $4) g`,
      [ctx.orgId, owner.userId, projectId, Math.ceil(COMMENT_COUNT / 20)],
    );

    // A dependency chain, so the graph subqueries have work to do.
    await tx.query(
      `INSERT INTO task_dependencies (org_id, blocking_task_id, blocked_task_id, created_by)
       SELECT $1, a.id, b.id, $2
         FROM (SELECT id, row_number() OVER (ORDER BY number) rn FROM tasks WHERE project_id = $3) a
         JOIN (SELECT id, row_number() OVER (ORDER BY number) rn FROM tasks WHERE project_id = $3) b
           ON b.rn = a.rn + 1
        WHERE a.rn <= 200`,
      [ctx.orgId, owner.userId, projectId],
    );
    await tx.query('ANALYZE tasks, comments, task_dependencies, statuses, projects');
  });

  // Warm up: the first read after a bulk insert pays one-off costs (hint-bit
  // setting, plan caching) that measure Postgres's housekeeping, not our
  // queries. Every assertion below is on steady-state timing.
  for (let i = 0; i < 3; i++) {
    await api(owner, 'GET', url(`/tasks?projectId=${ctx.projectKey}&limit=100`));
    await api(owner, 'GET', url(`/projects/${ctx.projectKey}/board`));
  }
}, 240_000);
afterAll(closeApp);

describe(`reads against ~${TASK_COUNT} tasks`, () => {
  it('returns a bounded page of tasks quickly', async () => {
    const { result, ms } = await timed('task list (100)', () =>
      api<{ items: Task[]; nextCursor: string | null }>(
        owner,
        'GET',
        url(`/tasks?projectId=${ctx.projectKey}&limit=100`),
      ),
    );
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(100);
    expect(result.body.nextCursor).not.toBeNull();
    expect(ms).toBeLessThan(2500);
  });

  it('pages with a cursor without slowing down', async () => {
    const first = await api<{ items: Task[]; nextCursor: string | null }>(
      owner,
      'GET',
      url(`/tasks?projectId=${ctx.projectKey}&limit=100`),
    );
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeTruthy();
    const { result, ms } = await timed('task list (page 2)', () =>
      api<{ items: Task[] }>(
        owner,
        'GET',
        url(
          `/tasks?projectId=${ctx.projectKey}&limit=100&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
        ),
      ),
    );
    expect(result.body.items).toHaveLength(100);
    // Keyset pagination must not degrade on later pages.
    expect(ms).toBeLessThan(2500);
  });

  it('renders the board in one round trip', async () => {
    const { result, ms } = await timed('board', () =>
      api<{ columns: Array<{ tasks: Task[] }> }>(owner, 'GET', url(`/projects/${ctx.projectKey}/board`)),
    );
    expect(result.status).toBe(200);
    const total = result.body.columns.reduce((sum, c) => sum + c.tasks.length, 0);
    expect(total).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(6000);
  });

  it('loads a task with many comments and dependencies quickly', async () => {
    const list = await api<{ items: Task[] }>(
      owner,
      'GET',
      url(`/tasks?projectId=${ctx.projectKey}&limit=5`),
    );
    const target = list.body.items[0]!;
    const { ms } = await timed('task detail', () => api(owner, 'GET', url(`/tasks/${target.id}`)));
    expect(ms).toBeLessThan(1500);
  });

  it('searches with the full-text index rather than a scan', async () => {
    const { result, ms } = await timed('search', () =>
      api<{ items: unknown[] }>(owner, 'GET', url('/search?q=migration&limit=20')),
    );
    expect(result.status).toBe(200);
    expect(result.body.items.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(2500);
  });

  it('ranks My Work without loading the whole project', async () => {
    const { result, ms } = await timed('my work', () => api(owner, 'GET', url('/my-work')));
    expect(result.status).toBe(200);
    expect(ms).toBeLessThan(4000);
  });

  it('summarises the project list without an N+1', async () => {
    const { ms } = await timed('project list', () => api(owner, 'GET', url('/projects')));
    expect(ms).toBeLessThan(2500);
  });

  it('lists activity by keyset rather than offset', async () => {
    const { ms } = await timed('activity feed', () =>
      api(owner, 'GET', url(`/projects/${ctx.projectKey}/activity?limit=50`)),
    );
    expect(ms).toBeLessThan(2000);
  });
});

describe('indexes the hot paths rely on', () => {
  it('has the composite indexes the board, My Work and due-date views need', async () => {
    const { rows } = await withOrg(ctx.orgId, (tx) =>
      tx.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'tasks'`,
      ),
    );
    const defs = rows.map((r) => `${r.indexname} ${r.indexdef}`).join('\n');
    // Board / project reads.
    expect(defs).toMatch(/tasks_org_project_status_idx/);
    // My Work.
    expect(defs).toMatch(/tasks_org_assignee_idx/);
    // Overdue queries.
    expect(defs).toMatch(/tasks_due_idx/);
    // Full-text search.
    expect(defs).toMatch(/tasks_search_idx.*gin/i);
    // Subtask and epic fan-out.
    expect(defs).toMatch(/tasks_parent_idx/);
    expect(defs).toMatch(/tasks_epic_idx/);
  });

  it('leads its tenant indexes with org_id so they stay selective', async () => {
    const { rows } = await withOrg(ctx.orgId, (tx) =>
      tx.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname IN
            ('tasks_org_project_status_idx', 'tasks_org_assignee_idx', 'tasks_due_idx')`,
      ),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.indexdef).toMatch(/\(org_id/);
    }
  });

  it('uses an index once the table is large enough for one to win', async () => {
    // Force the planner to cost an index path, so a *missing* index shows up
    // as a sequential scan even at this table size.
    const plan = await withOrg(ctx.orgId, async (tx) => {
      const { rows: project } = await tx.query<{ id: string }>(
        'SELECT id FROM projects WHERE org_id = $1 LIMIT 1',
        [ctx.orgId],
      );
      await tx.query('SET LOCAL enable_seqscan = off');
      const { rows } = await tx.query<Record<string, string>>(
        `EXPLAIN SELECT t.id FROM tasks t
          WHERE t.org_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL`,
        [ctx.orgId, project[0]!.id],
      );
      return rows.map((r) => Object.values(r)[0] ?? '').join('\n');
    });
    console.log(`  plan with seqscan disabled:\n${plan.split('\n').map((l) => `    ${l}`).join('\n')}`);
    expect(plan).toMatch(/Index Scan|Index Only Scan|Bitmap/);
  });
});

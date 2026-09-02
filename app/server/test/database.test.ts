import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, truncateAll } from './helpers.js';
import { db, orgDb, withOrg, withTx, isUniqueViolation } from '../src/platform/db.js';
import { migrate } from '../src/platform/migrate.js';

/**
 * Database-level guarantees, tested against the real schema rather than
 * through the API: row-level security, constraints, cascades, soft delete and
 * migration behaviour. These are the invariants the application layer relies
 * on, so they are worth asserting independently of it.
 */

let orgA: string;
let orgB: string;
let userA: string;

beforeAll(async () => {
  await getApp();
  await truncateAll();

  const { rows: users } = await db.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash) VALUES ('a@db.test', 'A', 'x') RETURNING id`,
  );
  userA = users[0]!.id;
  const { rows: orgs } = await db.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, created_by) VALUES ('A', 'db-a', $1), ('B', 'db-b', $1)
     RETURNING id`,
    [userA],
  );
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;
});
afterAll(closeApp);

async function seedProject(orgId: string, key: string): Promise<{ projectId: string; statusId: string }> {
  return withOrg(orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO projects (org_id, key, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, key, `Project ${key}`, userA],
    );
    const projectId = rows[0]!.id;
    await tx.query('INSERT INTO project_counters (project_id) VALUES ($1)', [projectId]);
    const { rows: statuses } = await tx.query<{ id: string }>(
      `INSERT INTO statuses (org_id, project_id, name, category, position)
       VALUES ($1, $2, 'Backlog', 'backlog', 0) RETURNING id`,
      [orgId, projectId],
    );
    return { projectId, statusId: statuses[0]!.id };
  });
}

describe('row-level security', () => {
  it('is enabled and forced on the tenant tables', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1::text[])`,
      [['tasks', 'projects', 'comments', 'blockers', 'activity_events', 'braindumps']],
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} rowsecurity`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} force rowsecurity`).toBe(true);
    }
  });

  it('returns no rows when no organization context is set', async () => {
    const seeded = await seedProject(orgA, 'RLSA');
    await withOrg(orgA, async (tx) => {
      await tx.query(
        `INSERT INTO tasks (org_id, project_id, number, title, status_id, created_by)
         VALUES ($1, $2, 1, 'Secret task', $3, $4)`,
        [orgA, seeded.projectId, seeded.statusId, userA],
      );
    });

    // A plain query, with no app.org_id, must see nothing — fail closed.
    const leaked = await withTx((tx) => tx.query('SELECT id FROM tasks'));
    expect(leaked.rows).toHaveLength(0);
  });

  it('hides another organization rows even with an explicit id filter', async () => {
    const seededB = await seedProject(orgB, 'RLSB');
    await withOrg(orgB, async (tx) => {
      await tx.query(
        `INSERT INTO tasks (org_id, project_id, number, title, status_id, created_by)
         VALUES ($1, $2, 1, 'Org B task', $3, $4)`,
        [orgB, seededB.projectId, seededB.statusId, userA],
      );
    });

    const fromA = await orgDb(orgA).query<{ id: string }>('SELECT id FROM tasks WHERE org_id = $1', [orgB]);
    expect(fromA.rows).toHaveLength(0);

    const fromB = await orgDb(orgB).query<{ id: string }>('SELECT id FROM tasks');
    expect(fromB.rows).toHaveLength(1);
  });

  it('refuses to write a row belonging to another organization', async () => {
    const seededB = await seedProject(orgB, 'RLSC');
    await expect(
      withOrg(orgA, async (tx) => {
        await tx.query(
          `INSERT INTO tasks (org_id, project_id, number, title, status_id, created_by)
           VALUES ($1, $2, 99, 'Cross-tenant write', $3, $4)`,
          [orgB, seededB.projectId, seededB.statusId, userA],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('protects child tables through their parent', async () => {
    const seeded = await seedProject(orgA, 'RLSD');
    const taskId = await withOrg(orgA, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO tasks (org_id, project_id, number, title, status_id, created_by)
         VALUES ($1, $2, 50, 'Watched', $3, $4) RETURNING id`,
        [orgA, seeded.projectId, seeded.statusId, userA],
      );
      const id = rows[0]!.id;
      await tx.query('INSERT INTO watchers (task_id, user_id) VALUES ($1, $2)', [id, userA]);
      return id;
    });

    const fromB = await orgDb(orgB).query('SELECT * FROM watchers WHERE task_id = $1', [taskId]);
    expect(fromB.rows).toHaveLength(0);
    const fromA = await orgDb(orgA).query('SELECT * FROM watchers WHERE task_id = $1', [taskId]);
    expect(fromA.rows).toHaveLength(1);
  });

  it('resets the organization context when a transaction ends', async () => {
    await withOrg(orgA, async (tx) => {
      const { rows } = await tx.query<{ org: string | null }>('SELECT app_current_org() AS org');
      expect(rows[0]!.org).toBe(orgA);
    });
    // The empty-string GUC left behind must resolve to NULL, not error.
    const after = await withTx((tx) => tx.query<{ org: string | null }>('SELECT app_current_org() AS org'));
    expect(after.rows[0]!.org).toBeNull();
  });
});

describe('constraints', () => {
  it('enforces unique task numbers per project', async () => {
    const seeded = await seedProject(orgA, 'UNQ');
    await withOrg(orgA, (tx) =>
      tx.query(
        `INSERT INTO tasks (org_id, project_id, number, title, status_id, created_by)
         VALUES ($1, $2, 7, 'First', $3, $4)`,
        [orgA, seeded.projectId, seeded.statusId, userA],
      ),
    );
    let error: unknown = null;
    try {
      await withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO tasks (org_id, project_id, number, title, status_id, created_by)
           VALUES ($1, $2, 7, 'Duplicate', $3, $4)`,
          [orgA, seeded.projectId, seeded.statusId, userA],
        ),
      );
    } catch (err) {
      error = err;
    }
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('rejects an invalid enum value', async () => {
    const seeded = await seedProject(orgA, 'ENM');
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO tasks (org_id, project_id, number, title, status_id, priority, created_by)
           VALUES ($1, $2, 1, 'Bad priority', $3, 'catastrophic', $4)`,
          [orgA, seeded.projectId, seeded.statusId, userA],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('rejects a self-referencing dependency', async () => {
    const seeded = await seedProject(orgA, 'SELF');
    const taskId = await withOrg(orgA, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO tasks (org_id, project_id, number, title, status_id, created_by)
         VALUES ($1, $2, 1, 'Self', $3, $4) RETURNING id`,
        [orgA, seeded.projectId, seeded.statusId, userA],
      );
      return rows[0]!.id;
    });
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO task_dependencies (org_id, blocking_task_id, blocked_task_id, created_by)
           VALUES ($1, $2, $2, $3)`,
          [orgA, taskId, userA],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('requires an attachment to belong to a task or a comment', async () => {
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO attachments (org_id, uploader_id, file_name, content_type, size_bytes, storage_key)
           VALUES ($1, $2, 'orphan.txt', 'text/plain', 10, 'k/orphan')`,
          [orgA, userA],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe('cascades and soft delete', () => {
  it('cascades project deletion to its tasks', async () => {
    const seeded = await seedProject(orgA, 'CASC');
    await withOrg(orgA, (tx) =>
      tx.query(
        `INSERT INTO tasks (org_id, project_id, number, title, status_id, created_by)
         VALUES ($1, $2, 1, 'Doomed', $3, $4)`,
        [orgA, seeded.projectId, seeded.statusId, userA],
      ),
    );
    await withOrg(orgA, (tx) => tx.query('DELETE FROM projects WHERE id = $1', [seeded.projectId]));
    const { rows } = await orgDb(orgA).query('SELECT id FROM tasks WHERE project_id = $1', [
      seeded.projectId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('keeps a soft-deleted row queryable for restore', async () => {
    const seeded = await seedProject(orgA, 'SOFT');
    const taskId = await withOrg(orgA, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO tasks (org_id, project_id, number, title, status_id, created_by)
         VALUES ($1, $2, 1, 'Recoverable', $3, $4) RETURNING id`,
        [orgA, seeded.projectId, seeded.statusId, userA],
      );
      return rows[0]!.id;
    });
    await withOrg(orgA, (tx) => tx.query('UPDATE tasks SET deleted_at = now() WHERE id = $1', [taskId]));
    const { rows } = await orgDb(orgA).query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM tasks WHERE id = $1',
      [taskId],
    );
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it('lets a project key be reused after the project is soft-deleted', async () => {
    const first = await seedProject(orgA, 'REUSE');
    await withOrg(orgA, (tx) =>
      tx.query('UPDATE projects SET deleted_at = now() WHERE id = $1', [first.projectId]),
    );
    await expect(seedProject(orgA, 'REUSE')).resolves.toBeTruthy();
  });

  it('unassigns rather than deletes a task when its assignee is removed', async () => {
    const seeded = await seedProject(orgA, 'UNAS');
    const { rows: temp } = await db.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ('temp@db.test', 'Temp', 'x') RETURNING id`,
    );
    const tempId = temp[0]!.id;
    const taskId = await withOrg(orgA, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO tasks (org_id, project_id, number, title, status_id, assignee_id, created_by)
         VALUES ($1, $2, 1, 'Assigned', $3, $4, $5) RETURNING id`,
        [orgA, seeded.projectId, seeded.statusId, tempId, userA],
      );
      return rows[0]!.id;
    });
    await db.query('DELETE FROM users WHERE id = $1', [tempId]);
    const { rows } = await orgDb(orgA).query<{ assignee_id: string | null }>(
      'SELECT assignee_id FROM tasks WHERE id = $1',
      [taskId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assignee_id).toBeNull();
  });
});

describe('migrations', () => {
  it('is idempotent when run again', async () => {
    const applied = await migrate();
    expect(applied).toEqual([]);
  });

  it('records every migration file it applied', async () => {
    // Compared against the directory rather than a hardcoded list: a new
    // migration that never ran, or a recorded file that no longer exists,
    // both fail here without anyone having to remember to edit this test.
    const onDisk = readdirSync(new URL('../db/migrations', import.meta.url).pathname)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const { rows } = await db.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    expect(rows.map((r) => r.filename)).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThan(0);
  });
});

describe('search indexes', () => {
  it('maintains the generated search vector automatically', async () => {
    const seeded = await seedProject(orgA, 'SRCH');
    await withOrg(orgA, (tx) =>
      tx.query(
        `INSERT INTO tasks (org_id, project_id, number, title, description, status_id, created_by)
         VALUES ($1, $2, 1, 'Kubernetes autoscaling', 'horizontal pod autoscaler', $3, $4)`,
        [orgA, seeded.projectId, seeded.statusId, userA],
      ),
    );
    const { rows } = await orgDb(orgA).query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks
        WHERE project_id = $1 AND search @@ websearch_to_tsquery('english', 'autoscaler')`,
      [seeded.projectId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bootstrapOrgProject, closeApp, getApp, signup, truncateAll } from './helpers.js';
import type { TestClient } from './helpers.js';
import type { Task, TaskDetail } from '@outcome/shared';
import { withOrg } from '../src/platform/db.js';
import { config } from '../src/platform/config.js';

/**
 * Concurrent-write behaviour. These are the cases that quietly corrupt data
 * in a multi-user tool: two people creating tasks at the same instant, two
 * people dragging the same card, and simultaneous dependency edits.
 */

let owner: TestClient;
let second: TestClient;
let ctx: Awaited<ReturnType<typeof bootstrapOrgProject>>;
const url = (p: string): string => `/api/v1/orgs/${ctx.orgSlug}${p}`;
const statusId = (category: string): string =>
  ctx.statuses.find((s) => s.category === category)!.id;

beforeAll(async () => {
  await getApp();
  await truncateAll();
  owner = await signup('owner@concurrency.test', 'Cora Owner');
  second = await signup('second@concurrency.test', 'Sam Second');
  ctx = await bootstrapOrgProject(owner, 'Concurrency Org', 'Racy Delivery');

  const invite = await api<{ inviteUrl: string }>(owner, 'POST', url('/invitations'), {
    email: 'second@concurrency.test',
    role: 'member',
  });
  await api(second, 'POST', '/api/v1/invitations/accept', {
    token: invite.body.inviteUrl.split('/invite/')[1]!,
  });
  await api(owner, 'POST', url(`/projects/${ctx.projectKey}/members`), {
    userId: second.userId,
    role: 'member',
  });
});
afterAll(closeApp);

describe('concurrent task creation', () => {
  it('gives every task a unique, gapless number under parallel creates', async () => {
    const parallel = 12;
    const results = await Promise.all(
      Array.from({ length: parallel }, (_, i) =>
        api<TaskDetail>(i % 2 === 0 ? owner : second, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
          title: `Parallel task ${i}`,
        }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(parallel);
    // Gapless: the sequence has no holes.
    expect(numbers[numbers.length - 1]! - numbers[0]!).toBe(parallel - 1);
  });
});

describe('concurrent board moves', () => {
  it('leaves the card in exactly one column when two people drag it at once', async () => {
    const task = await api<TaskDetail>(owner, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
      title: 'Contested card',
    });
    const [a, b] = await Promise.all([
      api<TaskDetail>(owner, 'POST', url(`/tasks/${task.body.id}/move`), {
        statusId: statusId('in_progress'),
      }),
      api<TaskDetail>(second, 'POST', url(`/tasks/${task.body.id}/move`), {
        statusId: statusId('in_review'),
      }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const board = await api<{ columns: Array<{ statusId: string; tasks: Task[] }> }>(
      owner,
      'GET',
      url(`/projects/${ctx.projectKey}/board`),
    );
    const appearances = board.body.columns.filter((c) => c.tasks.some((t) => t.id === task.body.id));
    expect(appearances).toHaveLength(1);
    // The surviving column is one of the two requested, not a third state.
    expect([statusId('in_progress'), statusId('in_review')]).toContain(appearances[0]!.statusId);
  });

  it('keeps positions distinct when several cards are dropped at once', async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        api<TaskDetail>(owner, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
          title: `Stacked ${i}`,
          statusId: statusId('todo'),
        }),
      ),
    );
    const moves = await Promise.all(
      created.map((r) =>
        api(owner, 'POST', url(`/tasks/${r.body.id}/move`), { statusId: statusId('blocked') }),
      ),
    );
    expect(moves.every((m) => m.status === 200)).toBe(true);
    const board = await api<{ columns: Array<{ statusId: string; tasks: Task[] }> }>(
      owner,
      'GET',
      url(`/projects/${ctx.projectKey}/board`),
    );
    const column = board.body.columns.find((c) => c.statusId === statusId('blocked'))!;
    const moved = column.tasks.filter((t) => t.title.startsWith('Stacked'));
    expect(moved).toHaveLength(5);
    // Ordering must stay a strict sequence the UI can render deterministically.
    const positions = moved.map((t) => t.position);
    expect(new Set(positions).size).toBe(positions.length);
  });
});

describe('concurrent field edits', () => {
  it('applies both non-conflicting edits', async () => {
    const task = await api<TaskDetail>(owner, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
      title: 'Two editors',
    });
    await Promise.all([
      api(owner, 'PATCH', url(`/tasks/${task.body.id}`), { priority: 'urgent' }),
      api(second, 'PATCH', url(`/tasks/${task.body.id}`), { dueDate: '2026-10-01' }),
    ]);
    const after = await api<TaskDetail>(owner, 'GET', url(`/tasks/${task.body.id}`));
    expect(after.body.priority).toBe('urgent');
    expect(after.body.dueDate).toBe('2026-10-01');
  });

  it('ends with one of the two values when both edit the same field', async () => {
    const task = await api<TaskDetail>(owner, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
      title: 'Same field',
    });
    await Promise.all([
      api(owner, 'PATCH', url(`/tasks/${task.body.id}`), { title: 'Owner wins' }),
      api(second, 'PATCH', url(`/tasks/${task.body.id}`), { title: 'Second wins' }),
    ]);
    const after = await api<TaskDetail>(owner, 'GET', url(`/tasks/${task.body.id}`));
    expect(['Owner wins', 'Second wins']).toContain(after.body.title);
  });

  it('records an activity event for each concurrent change', async () => {
    const task = await api<TaskDetail>(owner, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
      title: 'Audited race',
    });
    await Promise.all([
      api(owner, 'PATCH', url(`/tasks/${task.body.id}`), { priority: 'high' }),
      api(second, 'PATCH', url(`/tasks/${task.body.id}`), { estimateDays: 3 }),
    ]);
    const activity = await api<{ items: Array<{ action: string }> }>(
      owner,
      'GET',
      url(`/tasks/${task.body.id}/activity`),
    );
    expect(activity.body.items.filter((e) => e.action === 'updated').length).toBeGreaterThanOrEqual(2);
  });
});

describe('concurrent dependency writes', () => {
  it('never creates a duplicate edge', async () => {
    const a = await api<TaskDetail>(owner, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
      title: 'Upstream once',
    });
    const b = await api<TaskDetail>(owner, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
      title: 'Downstream once',
    });
    await Promise.all([
      api(owner, 'POST', url(`/tasks/${b.body.id}/dependencies`), { blockingTaskId: a.body.id }),
      api(second, 'POST', url(`/tasks/${b.body.id}/dependencies`), { blockingTaskId: a.body.id }),
    ]);
    const detail = await api<TaskDetail>(owner, 'GET', url(`/tasks/${b.body.id}`));
    expect(detail.body.blockedBy.filter((d) => d.id === a.body.id)).toHaveLength(1);
  });

  it('does not let two simultaneous edges create a cycle', async () => {
    const a = await api<TaskDetail>(owner, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
      title: 'Cycle race A',
    });
    const b = await api<TaskDetail>(owner, 'POST', url(`/projects/${ctx.projectKey}/tasks`), {
      title: 'Cycle race B',
    });
    const [first, secondRes] = await Promise.all([
      api(owner, 'POST', url(`/tasks/${b.body.id}/dependencies`), { blockingTaskId: a.body.id }),
      api(second, 'POST', url(`/tasks/${a.body.id}/dependencies`), { blockingTaskId: b.body.id }),
    ]);
    // At most one direction may exist; a graph with both is a cycle.
    const detailA = await api<TaskDetail>(owner, 'GET', url(`/tasks/${a.body.id}`));
    const detailB = await api<TaskDetail>(owner, 'GET', url(`/tasks/${b.body.id}`));
    const aBlocksB = detailB.body.blockedBy.some((d) => d.id === a.body.id);
    const bBlocksA = detailA.body.blockedBy.some((d) => d.id === b.body.id);
    expect(aBlocksB && bBlocksA).toBe(false);
    expect([first.status, secondRes.status].filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
  });
});

describe('transaction isolation', () => {
  it('rolls back every write when a transaction throws', async () => {
    const before = await api<{ items: Task[] }>(
      owner,
      'GET',
      url(`/tasks?projectId=${ctx.projectKey}&limit=200`),
    );
    await expect(
      withOrg(ctx.orgId, async (tx) => {
        await tx.query(
          `INSERT INTO labels (org_id, name, color) VALUES ($1, 'rollback-label', '#123456')`,
          [ctx.orgId],
        );
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrow('deliberate failure');

    const labels = await api<Array<{ name: string }>>(owner, 'GET', url('/labels'));
    expect(labels.body.some((l) => l.name === 'rollback-label')).toBe(false);
    const after = await api<{ items: Task[] }>(
      owner,
      'GET',
      url(`/tasks?projectId=${ctx.projectKey}&limit=200`),
    );
    expect(after.body.items.length).toBe(before.body.items.length);
  });
});

describe('AI budget accounting', () => {
  /**
   * The budget used to be enforced by counting rows and then writing one, so
   * simultaneous requests could both read a count below the limit and both
   * proceed. These assert the reservation is atomic.
   */
  const budget = config().AI_DAILY_CALL_BUDGET;

  async function setUsedToday(calls: number): Promise<void> {
    await withOrg(ctx.orgId, (tx) =>
      tx.query(
        `INSERT INTO ai_usage_daily (org_id, day, calls)
         VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2)
         ON CONFLICT (org_id, day) DO UPDATE SET calls = EXCLUDED.calls`,
        [ctx.orgId, calls],
      ),
    );
  }

  async function usedToday(): Promise<number> {
    return withOrg(ctx.orgId, async (tx) => {
      const { rows } = await tx.query<{ calls: number }>(
        `SELECT calls FROM ai_usage_daily
          WHERE org_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
        [ctx.orgId],
      );
      return rows[0]?.calls ?? 0;
    });
  }

  it('admits exactly one request for the last slot in the budget', async () => {
    await setUsedToday(budget - 1);

    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        api(owner, 'POST', url('/braindumps'), { text: `Race for the last slot ${i}` }),
      ),
    );
    const accepted = attempts.filter((r) => r.status < 400);
    const refused = attempts.filter((r) => r.status === 429);

    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(4);
    expect(await usedToday()).toBe(budget);
  });

  it('keeps refusing once the budget is spent, for every AI entry point', async () => {
    await setUsedToday(budget);

    const dump = await api(owner, 'POST', url('/braindumps'), { text: 'Anything at all' });
    expect(dump.status).toBe(429);

    const ask = await api(owner, 'POST', url('/assistant/ask'), { question: 'What is blocked?' });
    expect(ask.status).toBe(429);

    // A refused call must not consume a slot, or the counter would drift.
    expect(await usedToday()).toBe(budget);
  });

  it('counts brain dumps and assistant questions against the same budget', async () => {
    await setUsedToday(0);

    await api(owner, 'POST', url('/braindumps'), { text: 'Draft the launch checklist' });
    expect(await usedToday()).toBe(1);

    await api(owner, 'POST', url('/assistant/ask'), { question: 'What is blocked?' });
    expect(await usedToday()).toBe(2);
  });

  it('does not charge a slot for a dump that rolled back', async () => {
    await setUsedToday(0);
    // An oversized input is rejected before the transaction opens.
    const tooLong = await api(owner, 'POST', url('/braindumps'), {
      text: 'x'.repeat(config().AI_MAX_INPUT_CHARS + 1),
    });
    expect(tooLong.status).toBe(400);
    expect(await usedToday()).toBe(0);
  });
});

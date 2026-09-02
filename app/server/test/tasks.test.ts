import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bootstrapOrgProject, closeApp, getApp, signup, truncateAll } from './helpers.js';
import type { TestClient } from './helpers.js';
import type { Task, TaskDetail } from '@outcome/shared';

let owner: TestClient;
let ctx: Awaited<ReturnType<typeof bootstrapOrgProject>>;
const statusId = (category: string): string => {
  const found = ctx.statuses.find((s) => s.category === category);
  if (!found) throw new Error(`no status for ${category}`);
  return found.id;
};
const url = (path: string): string => `/api/v1/orgs/${ctx.orgSlug}${path}`;
const projectUrl = (path: string): string =>
  `/api/v1/orgs/${ctx.orgSlug}/projects/${ctx.projectKey}${path}`;

async function makeTask(title: string, extra: Record<string, unknown> = {}): Promise<TaskDetail> {
  const res = await api<TaskDetail>(owner, 'POST', projectUrl('/tasks'), { title, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  await getApp();
  await truncateAll();
  owner = await signup('lead@example.com', 'Lead');
  ctx = await bootstrapOrgProject(owner, 'Task Org', 'Delivery');
});
afterAll(closeApp);

describe('task creation', () => {
  it('creates a task with only a title and sensible defaults', async () => {
    const task = await makeTask('Write the migration plan');
    expect(task.ref).toBe(`${ctx.projectKey}-1`);
    expect(task.statusCategory).toBe('backlog');
    expect(task.priority).toBe('none');
    expect(task.assigneeId).toBeNull();
    expect(task.labels).toEqual([]);
    expect(task.completedAt).toBeNull();
  });

  it('numbers tasks sequentially per project', async () => {
    const second = await makeTask('Second task');
    expect(second.ref).toBe(`${ctx.projectKey}-2`);
  });

  it('rejects an empty title', async () => {
    const res = await api(owner, 'POST', projectUrl('/tasks'), { title: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects a status from another project', async () => {
    const other = await bootstrapOrgProject(owner, 'Other Org', 'Other Project');
    const res = await api(owner, 'POST', projectUrl('/tasks'), {
      title: 'Wrong status',
      statusId: other.statuses[0]!.id,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an assignee who is not an org member', async () => {
    const stranger = await signup('stranger@example.com', 'Stranger');
    const res = await api(owner, 'POST', projectUrl('/tasks'), {
      title: 'Bad assignee',
      assigneeId: stranger.userId,
    });
    expect(res.status).toBe(400);
  });

  it('supports one level of subtasks and refuses deeper nesting', async () => {
    const parent = await makeTask('Parent task');
    const child = await makeTask('Child task', { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);

    const deep = await api(owner, 'POST', projectUrl('/tasks'), {
      title: 'Grandchild',
      parentId: child.id,
    });
    expect(deep.status).toBe(400);

    const reloaded = await api<TaskDetail>(owner, 'GET', url(`/tasks/${parent.id}`));
    expect(reloaded.body.subtasks).toHaveLength(1);
    expect(reloaded.body.subtaskCount).toBe(1);
  });

  it('attaches labels and rejects unknown ones', async () => {
    const label = await api<{ id: string }>(owner, 'POST', url('/labels'), { name: 'payments' });
    expect(label.status).toBe(201);
    const task = await makeTask('Labelled task', { labelIds: [label.body.id] });
    expect(task.labels.map((l) => l.name)).toEqual(['payments']);

    const bad = await api(owner, 'POST', projectUrl('/tasks'), {
      title: 'Bad label',
      labelIds: ['00000000-0000-0000-0000-000000000000'],
    });
    expect(bad.status).toBe(400);
  });
});

describe('task updates', () => {
  it('records completion time when moved to done and clears it when reopened', async () => {
    const task = await makeTask('Completable');
    const done = await api<TaskDetail>(owner, 'PATCH', url(`/tasks/${task.id}`), {
      statusId: statusId('done'),
    });
    expect(done.body.statusCategory).toBe('done');
    expect(done.body.completedAt).not.toBeNull();

    const reopened = await api<TaskDetail>(owner, 'PATCH', url(`/tasks/${task.id}`), {
      statusId: statusId('todo'),
    });
    expect(reopened.body.completedAt).toBeNull();
  });

  it('writes a field-level activity trail', async () => {
    const task = await makeTask('Audited task');
    await api(owner, 'PATCH', url(`/tasks/${task.id}`), { priority: 'urgent' });
    const activity = await api<{ items: Array<{ action: string; data: Record<string, unknown> }> }>(
      owner,
      'GET',
      url(`/tasks/${task.id}/activity`),
    );
    expect(activity.status).toBe(200);
    const updated = activity.body.items.find((e) => e.action === 'updated');
    expect(updated).toBeDefined();
    expect(JSON.stringify(updated!.data)).toContain('urgent');
  });

  it('rejects an update with no fields', async () => {
    const task = await makeTask('No-op update');
    const res = await api(owner, 'PATCH', url(`/tasks/${task.id}`), {});
    expect(res.status).toBe(400);
  });

  it('soft-deletes a task and its subtasks', async () => {
    const parent = await makeTask('Doomed parent');
    const child = await makeTask('Doomed child', { parentId: parent.id });
    expect((await api(owner, 'DELETE', url(`/tasks/${parent.id}`))).status).toBe(200);
    expect((await api(owner, 'GET', url(`/tasks/${parent.id}`))).status).toBe(404);
    expect((await api(owner, 'GET', url(`/tasks/${child.id}`))).status).toBe(404);
  });
});

describe('board ordering', () => {
  it('places a moved task between its neighbours', async () => {
    const a = await makeTask('Board A', { statusId: statusId('todo') });
    const b = await makeTask('Board B', { statusId: statusId('todo') });
    const c = await makeTask('Board C', { statusId: statusId('backlog') });

    // Drop C between A and B (positions ascend down a column).
    const moved = await api<TaskDetail>(owner, 'POST', url(`/tasks/${c.id}/move`), {
      statusId: statusId('todo'),
      beforeTaskId: a.id,
      afterTaskId: b.id,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.statusCategory).toBe('todo');
    expect(moved.body.position).toBeGreaterThan(a.position);
    expect(moved.body.position).toBeLessThan(b.position);
  });

  it('appends to the bottom when dropped below the last card', async () => {
    const last = await makeTask('Bottom drop', { statusId: statusId('in_review') });
    const mover = await makeTask('Mover', { statusId: statusId('backlog') });
    const moved = await api<TaskDetail>(owner, 'POST', url(`/tasks/${mover.id}/move`), {
      statusId: statusId('in_review'),
      beforeTaskId: last.id,
    });
    expect(moved.body.position).toBeGreaterThan(last.position);
  });

  it('places at the top when dropped above the first card', async () => {
    const first = await makeTask('Top anchor', { statusId: statusId('blocked') });
    const mover = await makeTask('Top mover', { statusId: statusId('backlog') });
    const moved = await api<TaskDetail>(owner, 'POST', url(`/tasks/${mover.id}/move`), {
      statusId: statusId('blocked'),
      afterTaskId: first.id,
    });
    expect(moved.body.position).toBeLessThan(first.position);
  });

  it('returns the board grouped by status in column order', async () => {
    const board = await api<{
      project: { statuses: Array<{ id: string }> };
      columns: Array<{ statusId: string; tasks: unknown[] }>;
    }>(owner, 'GET', projectUrl('/board'));
    expect(board.status).toBe(200);
    expect(board.body.columns.map((c) => c.statusId)).toEqual(
      board.body.project.statuses.map((s) => s.id),
    );
  });
});

describe('dependencies', () => {
  it('links tasks and exposes both directions', async () => {
    const first = await makeTask('Set up sandbox');
    const second = await makeTask('Run integration tests');
    const res = await api(owner, 'POST', url(`/tasks/${second.id}/dependencies`), {
      blockingTaskId: first.id,
    });
    expect(res.status).toBe(201);

    const blocked = await api<TaskDetail>(owner, 'GET', url(`/tasks/${second.id}`));
    expect(blocked.body.blockedBy.map((t) => t.id)).toContain(first.id);
    expect(blocked.body.blockedByOpenCount).toBe(1);

    const blocking = await api<TaskDetail>(owner, 'GET', url(`/tasks/${first.id}`));
    expect(blocking.body.blocks.map((t) => t.id)).toContain(second.id);
  });

  it('refuses a self-dependency', async () => {
    const task = await makeTask('Self blocker');
    const res = await api(owner, 'POST', url(`/tasks/${task.id}/dependencies`), {
      blockingTaskId: task.id,
    });
    expect(res.status).toBe(400);
  });

  it('refuses a cycle', async () => {
    const a = await makeTask('Cycle A');
    const b = await makeTask('Cycle B');
    const c = await makeTask('Cycle C');
    expect((await api(owner, 'POST', url(`/tasks/${b.id}/dependencies`), { blockingTaskId: a.id })).status).toBe(201);
    expect((await api(owner, 'POST', url(`/tasks/${c.id}/dependencies`), { blockingTaskId: b.id })).status).toBe(201);
    const cycle = await api(owner, 'POST', url(`/tasks/${a.id}/dependencies`), { blockingTaskId: c.id });
    expect(cycle.status).toBe(409);
  });

  it('stops counting a dependency once the blocker is done', async () => {
    const upstream = await makeTask('Upstream');
    const downstream = await makeTask('Downstream');
    await api(owner, 'POST', url(`/tasks/${downstream.id}/dependencies`), { blockingTaskId: upstream.id });
    await api(owner, 'PATCH', url(`/tasks/${upstream.id}`), { statusId: statusId('done') });
    const after = await api<TaskDetail>(owner, 'GET', url(`/tasks/${downstream.id}`));
    expect(after.body.blockedByOpenCount).toBe(0);
  });

  it('removes a dependency', async () => {
    const a = await makeTask('Remove dep A');
    const b = await makeTask('Remove dep B');
    await api(owner, 'POST', url(`/tasks/${b.id}/dependencies`), { blockingTaskId: a.id });
    expect((await api(owner, 'DELETE', url(`/tasks/${b.id}/dependencies/${a.id}`))).status).toBe(200);
    const after = await api<TaskDetail>(owner, 'GET', url(`/tasks/${b.id}`));
    expect(after.body.blockedBy).toEqual([]);
  });
});

describe('blockers', () => {
  it('moves a blocked task to the blocked column and back on resolve', async () => {
    const task = await makeTask('Needs credentials', { statusId: statusId('in_progress') });
    const blocker = await api<{ id: string }>(owner, 'POST', url(`/tasks/${task.id}/blockers`), {
      reason: 'Waiting on API credentials from the platform team',
    });
    expect(blocker.status).toBe(201);

    const blocked = await api<TaskDetail>(owner, 'GET', url(`/tasks/${task.id}`));
    expect(blocked.body.statusCategory).toBe('blocked');
    expect(blocked.body.openBlockerCount).toBe(1);

    expect((await api(owner, 'POST', url(`/blockers/${blocker.body.id}/resolve`))).status).toBe(200);
    const after = await api<TaskDetail>(owner, 'GET', url(`/tasks/${task.id}`));
    expect(after.body.statusCategory).toBe('todo');
    expect(after.body.openBlockerCount).toBe(0);
  });

  it('requires a reason', async () => {
    const task = await makeTask('Blocker without reason');
    const res = await api(owner, 'POST', url(`/tasks/${task.id}/blockers`), { reason: '' });
    expect(res.status).toBe(400);
  });

  it('lists open blockers with age and downstream impact', async () => {
    const upstream = await makeTask('Blocked upstream');
    const downstream = await makeTask('Waits on upstream');
    await api(owner, 'POST', url(`/tasks/${downstream.id}/dependencies`), { blockingTaskId: upstream.id });
    await api(owner, 'POST', url(`/tasks/${upstream.id}/blockers`), { reason: 'Vendor has not replied' });

    const list = await api<Array<{ taskId: string; downstreamCount: number; ageDays: number }>>(
      owner,
      'GET',
      projectUrl('/blockers'),
    );
    expect(list.status).toBe(200);
    const found = list.body.find((b) => b.taskId === upstream.id);
    expect(found).toBeDefined();
    expect(found!.downstreamCount).toBe(1);
    expect(found!.ageDays).toBeGreaterThanOrEqual(0);
  });

  it('refuses to resolve an unknown blocker', async () => {
    const res = await api(owner, 'POST', url('/blockers/00000000-0000-0000-0000-000000000000/resolve'));
    expect(res.status).toBe(404);
  });
});

describe('comments', () => {
  it('creates, lists, edits and deletes a comment', async () => {
    const task = await makeTask('Discussable');
    const created = await api<{ id: string; body: string; editable: boolean }>(
      owner,
      'POST',
      url(`/tasks/${task.id}/comments`),
      { body: 'First thought' },
    );
    expect(created.status).toBe(201);
    expect(created.body.editable).toBe(true);

    const listed = await api<Array<{ id: string }>>(owner, 'GET', url(`/tasks/${task.id}/comments`));
    expect(listed.body).toHaveLength(1);

    const edited = await api<{ body: string }>(owner, 'PATCH', url(`/comments/${created.body.id}`), {
      body: 'Second thought',
    });
    expect(edited.body.body).toBe('Second thought');

    expect((await api(owner, 'DELETE', url(`/comments/${created.body.id}`))).status).toBe(200);
    const after = await api<unknown[]>(owner, 'GET', url(`/tasks/${task.id}/comments`));
    expect(after.body).toHaveLength(0);
  });

  it('notifies a mentioned teammate', async () => {
    const mate = await signup('mate@example.com', 'Mate Jones');
    const invite = await api<{ inviteUrl: string }>(owner, 'POST', url('/invitations'), {
      email: 'mate@example.com',
      role: 'member',
    });
    await api(mate, 'POST', '/api/v1/invitations/accept', {
      token: invite.body.inviteUrl.split('/invite/')[1]!,
    });
    await api(owner, 'POST', projectUrl('/members'), { userId: mate.userId, role: 'member' });

    const task = await makeTask('Mention target');
    await api(owner, 'POST', url(`/tasks/${task.id}/comments`), { body: 'Can you look, @mate?' });

    const inbox = await api<{ items: Array<{ type: string }>; unreadCount: number }>(
      mate,
      'GET',
      url('/notifications?unreadOnly=true'),
    );
    expect(inbox.body.items.some((n) => n.type === 'comment.mentioned')).toBe(true);
    expect(inbox.body.unreadCount).toBeGreaterThan(0);
  });

  it('rejects an empty comment', async () => {
    const task = await makeTask('No empty comments');
    const res = await api(owner, 'POST', url(`/tasks/${task.id}/comments`), { body: '  ' });
    expect(res.status).toBe(400);
  });
});

describe('my work prioritization', () => {
  it('explains why each task is ranked', async () => {
    const overdue = await makeTask('Overdue and blocking', {
      assigneeId: owner.userId,
      dueDate: '2020-01-01',
      statusId: statusId('todo'),
    });
    const dependent = await makeTask('Depends on overdue', { assigneeId: owner.userId });
    await api(owner, 'POST', url(`/tasks/${dependent.id}/dependencies`), { blockingTaskId: overdue.id });

    const res = await api<{
      now: Array<{ task: { id: string }; score: number; reasons: string[] }>;
      blockedByMe: Array<{ id: string }>;
    }>(owner, 'GET', url('/my-work'));
    expect(res.status).toBe(200);
    const top = res.body.now[0];
    expect(top).toBeDefined();
    expect(top!.task.id).toBe(overdue.id);
    expect(top!.reasons.join(' ')).toMatch(/overdue/);
    expect(top!.reasons.join(' ')).toMatch(/unblocks/);
    expect(res.body.blockedByMe.map((t) => t.id)).toContain(overdue.id);
  });
});

describe('search', () => {
  it('finds tasks by keyword and returns refs', async () => {
    await makeTask('Kubernetes autoscaling spike');
    const res = await api<{ items: Array<{ kind: string; title: string; taskRef: string | null }> }>(
      owner,
      'GET',
      url('/search?q=autoscaling'),
    );
    expect(res.status).toBe(200);
    const hit = res.body.items.find((i) => i.kind === 'task');
    expect(hit).toBeDefined();
    expect(hit!.title).toContain('autoscaling');
    expect(hit!.taskRef).toMatch(/-\d+$/);
  });

  it('requires a query', async () => {
    const res = await api(owner, 'GET', url('/search?q='));
    expect(res.status).toBe(400);
  });
});


describe('keyset pagination', () => {
  it('walks every task across pages exactly once', async () => {
    const project = await api<{ key: string }>(
      owner,
      'POST',
      `/api/v1/orgs/${ctx.orgSlug}/projects`,
      { name: 'Pagination Project' },
    );
    const key = project.body.key;
    // Created in one burst, so many rows share a timestamp and the id
    // tiebreaker in the cursor is exercised.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        api(owner, 'POST', `/api/v1/orgs/${ctx.orgSlug}/projects/${key}/tasks`, {
          title: `Paged task ${i}`,
        }),
      ),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ projectId: key, limit: '10' });
      if (cursor) query.set('cursor', cursor);
      const res = await api<{ items: Task[]; nextCursor: string | null }>(
        owner,
        'GET',
        `/api/v1/orgs/${ctx.orgSlug}/tasks?${query.toString()}`,
      );
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((t) => t.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('rejects a malformed cursor instead of ignoring it', async () => {
    const res = await api(
      owner,
      'GET',
      `/api/v1/orgs/${ctx.orgSlug}/tasks?projectId=${ctx.projectKey}&cursor=garbage`,
    );
    expect(res.status).toBe(400);
  });

  it('returns timestamps as ISO strings the client can parse', async () => {
    const task = await makeTask('Timestamp shape');
    expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(task.createdAt.endsWith('Z')).toBe(true);
    expect(Number.isNaN(new Date(task.createdAt).getTime())).toBe(false);
  });
});

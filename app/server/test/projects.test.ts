import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeApp, getApp, signup, truncateAll } from './helpers.js';
import type { TestClient } from './helpers.js';
import type { Epic, ProjectDetail, ProjectSummary } from '@outcome/shared';

/** Project settings, membership, epics and archival. */

let owner: TestClient;
let member: TestClient;
let orgSlug: string;
let project: ProjectDetail;
const url = (p: string): string => `/api/v1/orgs/${orgSlug}${p}`;

beforeAll(async () => {
  await getApp();
  await truncateAll();
  owner = await signup('owner@projects.test', 'Pia Owner');
  member = await signup('member@projects.test', 'Mo Member');
  const org = await api<{ slug: string }>(owner, 'POST', '/api/v1/orgs', { name: 'Project Co' });
  orgSlug = org.body.slug;

  const invite = await api<{ inviteUrl: string }>(owner, 'POST', url('/invitations'), {
    email: 'member@projects.test',
    role: 'member',
  });
  await api(member, 'POST', '/api/v1/invitations/accept', {
    token: invite.body.inviteUrl.split('/invite/')[1]!,
  });

  const created = await api<ProjectDetail>(owner, 'POST', url('/projects'), {
    name: 'Checkout Platform Migration',
    description: 'Move checkout to the new provider.',
    targetDate: '2026-12-31',
  });
  expect(created.status).toBe(201);
  project = created.body;
});
afterAll(closeApp);

describe('project creation', () => {
  it('derives a key from the name and seeds the default statuses', () => {
    expect(project.key).toBe('CPM');
    expect(project.statuses.map((s) => s.category)).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'blocked',
      'done',
    ]);
  });

  it('makes the creator a project lead', () => {
    expect(project.role).toBe('lead');
    expect(project.members.find((m) => m.userId === owner.userId)?.role).toBe('lead');
  });

  it('avoids a key collision automatically', async () => {
    const second = await api<ProjectDetail>(owner, 'POST', url('/projects'), {
      name: 'Checkout Platform Migration',
    });
    expect(second.status).toBe(201);
    expect(second.body.key).not.toBe(project.key);
  });

  it('rejects an explicit key that is already used', async () => {
    const res = await api(owner, 'POST', url('/projects'), { name: 'Clash', key: project.key });
    expect(res.status).toBe(409);
  });

  it('rejects a malformed key and an empty name', async () => {
    expect((await api(owner, 'POST', url('/projects'), { name: 'X', key: '1BAD' })).status).toBe(400);
    expect((await api(owner, 'POST', url('/projects'), { name: '   ' })).status).toBe(400);
  });

  it('accepts a lead who is an org member and adds them as lead', async () => {
    const created = await api<ProjectDetail>(owner, 'POST', url('/projects'), {
      name: 'Led By Member',
      leadId: member.userId,
    });
    expect(created.status).toBe(201);
    expect(created.body.members.find((m) => m.userId === member.userId)?.role).toBe('lead');
  });
});

describe('project reads', () => {
  it('is addressable by key, case-insensitively', async () => {
    const lower = await api<ProjectDetail>(owner, 'GET', url(`/projects/${project.key.toLowerCase()}`));
    expect(lower.status).toBe(200);
    expect(lower.body.id).toBe(project.id);
  });

  it('is addressable by id', async () => {
    const byId = await api<ProjectDetail>(owner, 'GET', url(`/projects/${project.id}`));
    expect(byId.status).toBe(200);
  });

  it('404s for an unknown key', async () => {
    expect((await api(owner, 'GET', url('/projects/NOPE'))).status).toBe(404);
  });

  it('summarises counts for the project list', async () => {
    await api(owner, 'POST', url(`/projects/${project.key}/tasks`), { title: 'Open work' });
    const done = project.statuses.find((s) => s.category === 'done')!.id;
    await api(owner, 'POST', url(`/projects/${project.key}/tasks`), {
      title: 'Finished work',
      statusId: done,
    });
    const overdue = await api<{ id: string }>(owner, 'POST', url(`/projects/${project.key}/tasks`), {
      title: 'Late work',
      dueDate: '2020-01-01',
    });
    await api(owner, 'POST', url(`/tasks/${overdue.body.id}/blockers`), { reason: 'Stuck' });

    const list = await api<ProjectSummary[]>(owner, 'GET', url('/projects'));
    const summary = list.body.find((p) => p.id === project.id)!;
    expect(summary.doneCount).toBe(1);
    expect(summary.openCount).toBe(2);
    expect(summary.openBlockerCount).toBe(1);
    expect(summary.overdueCount).toBe(1);
  });

  it('hides projects a plain member is not a member of', async () => {
    const list = await api<ProjectSummary[]>(member, 'GET', url('/projects'));
    expect(list.body.some((p) => p.id === project.id)).toBe(false);
  });
});

describe('project updates', () => {
  it('updates fields and records the change', async () => {
    const res = await api<ProjectDetail>(owner, 'PATCH', url(`/projects/${project.key}`), {
      name: 'Checkout Platform Migration v2',
      description: 'Updated scope.',
      targetDate: '2027-01-15',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Checkout Platform Migration v2');
    expect(res.body.targetDate).toBe('2027-01-15');

    const activity = await api<{ items: Array<{ action: string; data: Record<string, unknown> }> }>(
      owner,
      'GET',
      url(`/projects/${project.key}/activity`),
    );
    const updated = activity.body.items.find((e) => e.action === 'updated');
    expect(updated).toBeDefined();
    expect(JSON.stringify(updated!.data)).toContain('name');
  });

  it('rejects an update with no fields', async () => {
    expect((await api(owner, 'PATCH', url(`/projects/${project.key}`), {})).status).toBe(400);
  });

  it('does not let a non-member update the project', async () => {
    const res = await api(member, 'PATCH', url(`/projects/${project.key}`), { name: 'Hijack' });
    expect(res.status).toBe(403);
  });
});

describe('project membership', () => {
  it('adds, promotes and removes a member', async () => {
    expect(
      (await api(owner, 'POST', url(`/projects/${project.key}/members`), {
        userId: member.userId,
        role: 'viewer',
      })).status,
    ).toBe(201);
    let detail = await api<ProjectDetail>(owner, 'GET', url(`/projects/${project.key}`));
    expect(detail.body.members.find((m) => m.userId === member.userId)?.role).toBe('viewer');

    // Re-adding with a new role updates it rather than failing.
    await api(owner, 'POST', url(`/projects/${project.key}/members`), {
      userId: member.userId,
      role: 'member',
    });
    detail = await api<ProjectDetail>(owner, 'GET', url(`/projects/${project.key}`));
    expect(detail.body.members.find((m) => m.userId === member.userId)?.role).toBe('member');

    expect(
      (await api(owner, 'DELETE', url(`/projects/${project.key}/members/${member.userId}`))).status,
    ).toBe(200);
    expect(
      (await api(owner, 'DELETE', url(`/projects/${project.key}/members/${member.userId}`))).status,
    ).toBe(404);
  });

  it('refuses to add someone who is not in the organization', async () => {
    const stranger = await signup('stranger@projects.test', 'Sid Stranger');
    const res = await api(owner, 'POST', url(`/projects/${project.key}/members`), {
      userId: stranger.userId,
      role: 'member',
    });
    expect(res.status).toBe(400);
  });

  it('requires lead rights to manage membership', async () => {
    await api(owner, 'POST', url(`/projects/${project.key}/members`), {
      userId: member.userId,
      role: 'member',
    });
    const res = await api(member, 'POST', url(`/projects/${project.key}/members`), {
      userId: member.userId,
      role: 'lead',
    });
    expect(res.status).toBe(403);
  });
});

describe('epics', () => {
  it('creates epics and reports task progress', async () => {
    const epic = await api<Epic>(owner, 'POST', url(`/projects/${project.key}/epics`), {
      name: 'Payments',
      description: 'Everything payment related.',
      targetDate: '2026-11-30',
    });
    expect(epic.status).toBe(201);
    expect(epic.body.taskCount).toBe(0);

    const done = project.statuses.find((s) => s.category === 'done')!.id;
    await api(owner, 'POST', url(`/projects/${project.key}/tasks`), {
      title: 'Epic child open',
      epicId: epic.body.id,
    });
    await api(owner, 'POST', url(`/projects/${project.key}/tasks`), {
      title: 'Epic child done',
      epicId: epic.body.id,
      statusId: done,
    });

    const list = await api<Epic[]>(owner, 'GET', url(`/projects/${project.key}/epics`));
    const found = list.body.find((e) => e.id === epic.body.id)!;
    expect(found.taskCount).toBe(2);
    expect(found.doneCount).toBe(1);
  });

  it('rejects an epic from another project on a task', async () => {
    const other = await api<ProjectDetail>(owner, 'POST', url('/projects'), { name: 'Other Project' });
    const otherEpic = await api<Epic>(owner, 'POST', url(`/projects/${other.body.key}/epics`), {
      name: 'Elsewhere',
    });
    const res = await api(owner, 'POST', url(`/projects/${project.key}/tasks`), {
      title: 'Wrong epic',
      epicId: otherEpic.body.id,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty epic name', async () => {
    expect(
      (await api(owner, 'POST', url(`/projects/${project.key}/epics`), { name: ' ' })).status,
    ).toBe(400);
  });
});

describe('archiving', () => {
  it('archives a project and hides it from the default list', async () => {
    const doomed = await api<ProjectDetail>(owner, 'POST', url('/projects'), { name: 'Sunset Project' });
    expect((await api(owner, 'DELETE', url(`/projects/${doomed.body.key}`))).status).toBe(200);

    const active = await api<ProjectSummary[]>(owner, 'GET', url('/projects'));
    expect(active.body.some((p) => p.id === doomed.body.id)).toBe(false);

    const all = await api<ProjectSummary[]>(owner, 'GET', url('/projects?includeArchived=true'));
    const found = all.body.find((p) => p.id === doomed.body.id);
    expect(found?.state).toBe('archived');
  });

  it('requires lead rights to archive', async () => {
    const res = await api(member, 'DELETE', url(`/projects/${project.key}`));
    expect(res.status).toBe(403);
  });
});

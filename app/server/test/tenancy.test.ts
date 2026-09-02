import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bootstrapOrgProject, closeApp, getApp, signup, truncateAll } from './helpers.js';
import type { TestClient } from './helpers.js';

/**
 * Tenant isolation and RBAC. These are the tests that must never regress:
 * a leak here is a cross-customer data breach, not a bug.
 */

let owner: TestClient;
let outsider: TestClient;
let member: TestClient;
let orgA: Awaited<ReturnType<typeof bootstrapOrgProject>>;
let orgB: Awaited<ReturnType<typeof bootstrapOrgProject>>;
let taskInA: { id: string; ref: string };

beforeAll(async () => {
  await getApp();
  await truncateAll();

  owner = await signup('owner@a.com', 'Owner A');
  outsider = await signup('owner@b.com', 'Owner B');
  member = await signup('member@a.com', 'Member A');

  orgA = await bootstrapOrgProject(owner, 'Org A', 'Alpha Project');
  orgB = await bootstrapOrgProject(outsider, 'Org B', 'Beta Project');

  // member joins org A but NOT the project
  const invite = await api<{ inviteUrl: string }>(
    owner,
    'POST',
    `/api/v1/orgs/${orgA.orgSlug}/invitations`,
    { email: 'member@a.com', role: 'member' },
  );
  const token = invite.body.inviteUrl.split('/invite/')[1]!;
  const accepted = await api(member, 'POST', '/api/v1/invitations/accept', { token });
  expect(accepted.status).toBe(200);

  const created = await api<{ id: string; ref: string }>(
    owner,
    'POST',
    `/api/v1/orgs/${orgA.orgSlug}/projects/${orgA.projectKey}/tasks`,
    { title: 'Secret roadmap item' },
  );
  expect(created.status).toBe(201);
  taskInA = created.body;
});
afterAll(closeApp);

describe('cross-organization isolation', () => {
  it('hides another org entirely (404, not 403 — no existence oracle)', async () => {
    const res = await api(outsider, 'GET', `/api/v1/orgs/${orgA.orgSlug}/members`);
    expect(res.status).toBe(404);
  });

  it('refuses to read a task from another org by id', async () => {
    const res = await api(outsider, 'GET', `/api/v1/orgs/${orgB.orgSlug}/tasks/${taskInA.id}`);
    expect(res.status).toBe(404);
  });

  it('refuses to update a task from another org by id', async () => {
    const res = await api(outsider, 'PATCH', `/api/v1/orgs/${orgB.orgSlug}/tasks/${taskInA.id}`, {
      title: 'Hijacked',
    });
    expect(res.status).toBe(404);
  });

  it('refuses to reach another org project through its own org route', async () => {
    const res = await api(
      outsider,
      'GET',
      `/api/v1/orgs/${orgB.orgSlug}/projects/${orgA.projectKey}`,
    );
    expect(res.status).toBe(404);
  });

  it('does not leak another org content through search', async () => {
    const res = await api<{ items: unknown[] }>(
      outsider,
      'GET',
      `/api/v1/orgs/${orgB.orgSlug}/search?q=roadmap`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('does not leak another org tasks through the task list', async () => {
    const res = await api<{ items: Array<{ id: string }> }>(
      outsider,
      'GET',
      `/api/v1/orgs/${orgB.orgSlug}/tasks`,
    );
    expect(res.body.items.some((t) => t.id === taskInA.id)).toBe(false);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await api(null, 'GET', `/api/v1/orgs/${orgA.orgSlug}/tasks`);
    expect(res.status).toBe(401);
  });
});

describe('project-level authorization', () => {
  it('an org member who is not a project member cannot see the project', async () => {
    const res = await api(member, 'GET', `/api/v1/orgs/${orgA.orgSlug}/projects/${orgA.projectKey}`);
    expect(res.status).toBe(403);
  });

  it('an org member cannot see project tasks they have no membership for', async () => {
    const res = await api<{ items: Array<{ id: string }> }>(
      member,
      'GET',
      `/api/v1/orgs/${orgA.orgSlug}/tasks`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('a project viewer can comment but not edit tasks', async () => {
    await api(owner, 'POST', `/api/v1/orgs/${orgA.orgSlug}/projects/${orgA.projectKey}/members`, {
      userId: member.userId,
      role: 'viewer',
    });
    const comment = await api(member, 'POST', `/api/v1/orgs/${orgA.orgSlug}/tasks/${taskInA.id}/comments`, {
      body: 'Question from a viewer',
    });
    expect(comment.status).toBe(201);

    const edit = await api(member, 'PATCH', `/api/v1/orgs/${orgA.orgSlug}/tasks/${taskInA.id}`, {
      title: 'Viewer edit attempt',
    });
    expect(edit.status).toBe(403);
  });

  it('promoting to member allows editing', async () => {
    await api(owner, 'POST', `/api/v1/orgs/${orgA.orgSlug}/projects/${orgA.projectKey}/members`, {
      userId: member.userId,
      role: 'member',
    });
    const edit = await api(member, 'PATCH', `/api/v1/orgs/${orgA.orgSlug}/tasks/${taskInA.id}`, {
      title: 'Member edit',
    });
    expect(edit.status).toBe(200);
  });

  it('a plain member cannot invite people to the org', async () => {
    const res = await api(member, 'POST', `/api/v1/orgs/${orgA.orgSlug}/invitations`, {
      email: 'someone@a.com',
      role: 'member',
    });
    expect(res.status).toBe(403);
  });

  it('a plain member cannot read the org audit log', async () => {
    const res = await api(member, 'GET', `/api/v1/orgs/${orgA.orgSlug}/audit`);
    expect(res.status).toBe(403);
  });

  it('an owner cannot be demoted below the last owner', async () => {
    const res = await api(owner, 'PATCH', `/api/v1/orgs/${orgA.orgSlug}/members/${owner.userId}`, {
      role: 'member',
    });
    expect(res.status).toBe(400);
  });
});

describe('invitation integrity', () => {
  it('rejects an invitation accepted by the wrong account', async () => {
    const invite = await api<{ inviteUrl: string }>(
      owner,
      'POST',
      `/api/v1/orgs/${orgA.orgSlug}/invitations`,
      { email: 'intended@a.com', role: 'member' },
    );
    const token = invite.body.inviteUrl.split('/invite/')[1]!;
    const wrongUser = await signup('wrong@a.com', 'Wrong');
    const res = await api(wrongUser, 'POST', '/api/v1/invitations/accept', { token });
    expect(res.status).toBe(400);
  });

  it('rejects a bogus invitation token', async () => {
    const res = await api(member, 'POST', '/api/v1/invitations/accept', {
      token: 'x'.repeat(43),
    });
    expect(res.status).toBe(404);
  });
});

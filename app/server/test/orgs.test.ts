import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeApp, getApp, signup, truncateAll } from './helpers.js';
import type { TestClient } from './helpers.js';

/** Organization, membership, team and invitation lifecycle. */

let owner: TestClient;
let admin: TestClient;
let member: TestClient;
let orgSlug: string;
const url = (p: string): string => `/api/v1/orgs/${orgSlug}${p}`;

async function join(client: TestClient, email: string, role: 'admin' | 'member'): Promise<void> {
  const invite = await api<{ inviteUrl: string }>(owner, 'POST', url('/invitations'), { email, role });
  expect(invite.status).toBe(201);
  const token = invite.body.inviteUrl.split('/invite/')[1]!;
  expect((await api(client, 'POST', '/api/v1/invitations/accept', { token })).status).toBe(200);
}

beforeAll(async () => {
  await getApp();
  await truncateAll();
  owner = await signup('owner@orgs.test', 'Olga Owner');
  admin = await signup('admin@orgs.test', 'Adam Admin');
  member = await signup('member@orgs.test', 'Mina Member');
  const org = await api<{ slug: string }>(owner, 'POST', '/api/v1/orgs', { name: 'Acme Widgets' });
  expect(org.status).toBe(201);
  orgSlug = org.body.slug;
  await join(admin, 'admin@orgs.test', 'admin');
  await join(member, 'member@orgs.test', 'member');
});
afterAll(closeApp);

describe('organization creation', () => {
  it('derives a slug from the name', () => {
    expect(orgSlug).toBe('acme-widgets');
  });

  it('makes the creator an owner', async () => {
    const me = await api<{ orgs: Array<{ slug: string; role: string }> }>(owner, 'GET', '/api/v1/auth/me');
    expect(me.body.orgs.find((o) => o.slug === orgSlug)?.role).toBe('owner');
  });

  it('avoids a slug collision automatically', async () => {
    const other = await signup('other@orgs.test', 'Otto Other');
    const second = await api<{ slug: string }>(other, 'POST', '/api/v1/orgs', { name: 'Acme Widgets' });
    expect(second.status).toBe(201);
    expect(second.body.slug).not.toBe(orgSlug);
  });

  it('rejects a taken slug when the caller picked it explicitly', async () => {
    const other = await signup('other2@orgs.test', 'Ozzy Other');
    const res = await api(other, 'POST', '/api/v1/orgs', { name: 'Clash', slug: orgSlug });
    expect(res.status).toBe(409);
  });

  it('rejects a malformed slug', async () => {
    const res = await api(owner, 'POST', '/api/v1/orgs', { name: 'Bad', slug: 'Not A Slug!' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty name', async () => {
    expect((await api(owner, 'POST', '/api/v1/orgs', { name: '  ' })).status).toBe(400);
  });
});

describe('membership and roles', () => {
  it('lists members with their roles', async () => {
    const res = await api<Array<{ email: string; role: string }>>(owner, 'GET', url('/members'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.find((m) => m.email === 'admin@orgs.test')?.role).toBe('admin');
  });

  it('lets an admin promote a member', async () => {
    expect(
      (await api(admin, 'PATCH', url(`/members/${member.userId}`), { role: 'admin' })).status,
    ).toBe(200);
    const res = await api<Array<{ userId: string; role: string }>>(owner, 'GET', url('/members'));
    expect(res.body.find((m) => m.userId === member.userId)?.role).toBe('admin');
    // put it back
    await api(owner, 'PATCH', url(`/members/${member.userId}`), { role: 'member' });
  });

  it('does not let an admin create an owner', async () => {
    const res = await api(admin, 'PATCH', url(`/members/${member.userId}`), { role: 'owner' });
    expect(res.status).toBe(400);
  });

  it('does not let an admin demote an owner', async () => {
    const res = await api(admin, 'PATCH', url(`/members/${owner.userId}`), { role: 'member' });
    expect(res.status).toBe(400);
  });

  it('lets an owner appoint a second owner, then step down', async () => {
    expect((await api(owner, 'PATCH', url(`/members/${admin.userId}`), { role: 'owner' })).status).toBe(200);
    expect((await api(owner, 'PATCH', url(`/members/${owner.userId}`), { role: 'admin' })).status).toBe(200);
    const res = await api<Array<{ userId: string; role: string }>>(admin, 'GET', url('/members'));
    expect(res.body.filter((m) => m.role === 'owner')).toHaveLength(1);
    // restore for the remaining tests
    await api(admin, 'PATCH', url(`/members/${owner.userId}`), { role: 'owner' });
    await api(owner, 'PATCH', url(`/members/${admin.userId}`), { role: 'admin' });
  });

  it('refuses to remove an owner', async () => {
    const res = await api(admin, 'DELETE', url(`/members/${owner.userId}`));
    expect(res.status).toBe(400);
  });

  it('does not let a plain member change roles', async () => {
    const res = await api(member, 'PATCH', url(`/members/${admin.userId}`), { role: 'member' });
    expect(res.status).toBe(403);
  });

  it('404s on an unknown member', async () => {
    const res = await api(owner, 'PATCH', url('/members/11111111-1111-4111-8111-111111111111'), {
      role: 'member',
    });
    expect(res.status).toBe(404);
  });

  it('removes a member and their project memberships', async () => {
    const leaver = await signup('leaver@orgs.test', 'Lee Leaver');
    await join(leaver, 'leaver@orgs.test', 'member');
    const project = await api<{ key: string }>(owner, 'POST', url('/projects'), { name: 'Shared Work' });
    await api(owner, 'POST', url(`/projects/${project.body.key}/members`), {
      userId: leaver.userId,
      role: 'member',
    });
    expect((await api(owner, 'DELETE', url(`/members/${leaver.userId}`))).status).toBe(200);
    // The removed user can no longer see the org at all.
    expect((await api(leaver, 'GET', url('/members'))).status).toBe(404);
    const detail = await api<{ members: Array<{ userId: string }> }>(
      owner,
      'GET',
      url(`/projects/${project.body.key}`),
    );
    expect(detail.body.members.map((m) => m.userId)).not.toContain(leaver.userId);
  });
});

describe('invitations', () => {
  it('lists pending invitations and revokes one', async () => {
    const created = await api<{ id: string }>(owner, 'POST', url('/invitations'), {
      email: 'pending@orgs.test',
      role: 'member',
    });
    const list = await api<Array<{ id: string; email: string }>>(owner, 'GET', url('/invitations'));
    expect(list.body.some((i) => i.id === created.body.id)).toBe(true);

    expect((await api(owner, 'DELETE', url(`/invitations/${created.body.id}`))).status).toBe(200);
    const after = await api<Array<{ id: string }>>(owner, 'GET', url('/invitations'));
    expect(after.body.some((i) => i.id === created.body.id)).toBe(false);
    // A revoked invitation cannot be revoked again.
    expect((await api(owner, 'DELETE', url(`/invitations/${created.body.id}`))).status).toBe(404);
  });

  it('refuses a duplicate pending invitation', async () => {
    await api(owner, 'POST', url('/invitations'), { email: 'dupe@orgs.test', role: 'member' });
    const second = await api(owner, 'POST', url('/invitations'), {
      email: 'dupe@orgs.test',
      role: 'member',
    });
    expect(second.status).toBe(409);
  });

  it('refuses to invite an existing member', async () => {
    const res = await api(owner, 'POST', url('/invitations'), {
      email: 'member@orgs.test',
      role: 'member',
    });
    expect(res.status).toBe(409);
  });

  it('does not let a member read pending invitations', async () => {
    expect((await api(member, 'GET', url('/invitations'))).status).toBe(403);
  });

  it('rejects an invitation for an invalid email or role', async () => {
    expect(
      (await api(owner, 'POST', url('/invitations'), { email: 'nope', role: 'member' })).status,
    ).toBe(400);
    expect(
      (await api(owner, 'POST', url('/invitations'), { email: 'x@y.com', role: 'owner' })).status,
    ).toBe(400);
  });
});

describe('teams', () => {
  it('creates a team with members and lists it', async () => {
    const created = await api<{ id: string; name: string; memberIds: string[] }>(
      owner,
      'POST',
      url('/teams'),
      { name: 'Platform', memberIds: [owner.userId, member.userId] },
    );
    expect(created.status).toBe(201);
    expect(created.body.memberIds).toHaveLength(2);

    const list = await api<Array<{ id: string; memberIds: string[] }>>(owner, 'GET', url('/teams'));
    expect(list.body.find((t) => t.id === created.body.id)?.memberIds).toHaveLength(2);
  });

  it('silently ignores non-members rather than leaking whether they exist', async () => {
    const stranger = await signup('stranger@orgs.test', 'Stan Stranger');
    const created = await api<{ memberIds: string[] }>(owner, 'POST', url('/teams'), {
      name: 'Security',
      memberIds: [owner.userId, stranger.userId],
    });
    expect(created.status).toBe(201);
    expect(created.body.memberIds).toEqual([owner.userId]);
  });

  it('refuses a duplicate team name', async () => {
    expect((await api(owner, 'POST', url('/teams'), { name: 'Platform' })).status).toBe(409);
  });

  it('does not let a plain member create a team', async () => {
    expect((await api(member, 'POST', url('/teams'), { name: 'Rogue' })).status).toBe(403);
  });

  it('lets any member read the team list', async () => {
    expect((await api(member, 'GET', url('/teams'))).status).toBe(200);
  });
});

describe('org lookup endpoint', () => {
  it('reports the caller role', async () => {
    const res = await api<{ role: string }>(member, 'GET', url(''));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('member');
  });

  it('404s for an org the caller does not belong to', async () => {
    const stranger = await signup('nobody@orgs.test', 'Nemo Nobody');
    expect((await api(stranger, 'GET', url(''))).status).toBe(404);
  });
});

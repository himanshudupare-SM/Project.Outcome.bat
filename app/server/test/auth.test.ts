import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeApp, getApp, login, signup, truncateAll, SESSION_COOKIE } from './helpers.js';
import { hashPassword, verifyPassword } from '../src/platform/crypto.js';

beforeAll(async () => {
  await getApp();
  await truncateAll();
});
afterAll(closeApp);

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
  });

  it('produces a different hash for the same password (unique salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('signup and login', () => {
  it('signs up, sets a session, and returns the user', async () => {
    const client = await signup('alice@example.com', 'Alice');
    expect(client.cookies).toContain(SESSION_COOKIE);
    const me = await api<{ user: { email: string }; orgs: unknown[] }>(client, 'GET', '/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('alice@example.com');
    expect(me.body.orgs).toEqual([]);
  });

  it('rejects a duplicate email', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'alice@example.com', name: 'Alice2', password: 'test-password-1234' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a weak password with a field error', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'weak@example.com', name: 'Weak', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { fields: Record<string, string> }).fields).toHaveProperty('password');
  });

  it('does not reveal whether an account exists', async () => {
    const app = await getApp();
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'test-password-1234' },
    });
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'alice@example.com', password: 'wrong-password-9999' },
    });
    expect(missing.statusCode).toBe(400);
    expect(wrongPassword.statusCode).toBe(400);
    const missingBody = JSON.parse(missing.body) as { detail: string };
    const wrongBody = JSON.parse(wrongPassword.body) as { detail: string };
    expect(missingBody.detail).toBe(wrongBody.detail);
  });

  it('requires authentication for /auth/me', async () => {
    const res = await api(null, 'GET', '/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('logs out and invalidates the session', async () => {
    const client = await login('alice@example.com');
    expect((await api(client, 'POST', '/api/v1/auth/logout')).status).toBe(200);
    const after = await api(client, 'GET', '/api/v1/auth/me');
    expect(after.status).toBe(401);
  });

  it('rejects a state-changing request without the CSRF header', async () => {
    const client = await login('alice@example.com');
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      payload: { name: 'No CSRF Org' },
      headers: { cookie: client.cookies }, // cookie present, header missing
    });
    expect(res.statusCode).toBe(403);
    expect((JSON.parse(res.body) as { type: string }).type).toBe('csrf_failed');
  });

  it('changing the password revokes other sessions but keeps the current one', async () => {
    const first = await login('alice@example.com');
    const second = await login('alice@example.com');
    const changed = await api(second, 'POST', '/api/v1/auth/change-password', {
      currentPassword: 'test-password-1234',
      newPassword: 'brand-new-password-99',
    });
    expect(changed.status).toBe(200);
    expect((await api(second, 'GET', '/api/v1/auth/me')).status).toBe(200);
    expect((await api(first, 'GET', '/api/v1/auth/me')).status).toBe(401);
  });
});

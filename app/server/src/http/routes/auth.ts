import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loginInput, password, signupInput } from '@outcome/shared';
import { config } from '../../platform/config.js';
import { generateToken } from '../../platform/crypto.js';
import * as auth from '../../modules/auth/service.js';
import * as orgs from '../../modules/orgs/service.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../app.js';
import { noStore, requireUser } from '../context.js';

function setAuthCookies(reply: import('fastify').FastifyReply, token: string): void {
  const cfg = config();
  const common = {
    path: '/',
    sameSite: 'lax' as const,
    secure: cfg.COOKIE_SECURE,
    maxAge: auth.SESSION_TTL_DAYS * 24 * 60 * 60,
  };
  // Session cookie is httpOnly; the CSRF cookie must be readable by JS so the
  // client can echo it in a header (double-submit).
  reply.setCookie(SESSION_COOKIE, token, { ...common, httpOnly: true });
  reply.setCookie(CSRF_COOKIE, generateToken(16), { ...common, httpOnly: false });
}

function clearAuthCookies(reply: import('fastify').FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const authLimit = {
    rateLimit: { max: config().AUTH_RATE_LIMIT_MAX, timeWindow: config().RATE_LIMIT_WINDOW_MS },
  };

  app.post('/auth/signup', { config: authLimit }, async (req, reply) => {
    const input = signupInput.parse(req.body);
    await auth.signup(input);
    const { token, user } = await auth.login(
      { email: input.email, password: input.password },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    setAuthCookies(reply, token);
    noStore(reply);
    return reply.status(201).send(await auth.me(user.userId));
  });

  app.post('/auth/login', { config: authLimit }, async (req, reply) => {
    const input = loginInput.parse(req.body);
    const { token, user } = await auth.login(input, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setAuthCookies(reply, token);
    noStore(reply);
    return auth.me(user.userId);
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.userCtx?.sessionId) await auth.logout(req.userCtx.sessionId);
    clearAuthCookies(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req, reply) => {
    const user = requireUser(req);
    noStore(reply);
    return auth.me(user.userId);
  });

  app.post('/auth/change-password', { config: authLimit }, async (req) => {
    const user = requireUser(req);
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: password })
      .parse(req.body);
    await auth.changePassword(user.userId, body.currentPassword, body.newPassword, user.sessionId);
    return { ok: true };
  });

  app.post('/auth/logout-all', async (req, reply) => {
    const user = requireUser(req);
    await auth.logoutAll(user.userId);
    clearAuthCookies(reply);
    return { ok: true };
  });

  app.post('/invitations/accept', async (req) => {
    const user = requireUser(req);
    const body = z.object({ token: z.string().min(10) }).parse(req.body);
    return orgs.acceptInvitation(user, body.token);
  });
}

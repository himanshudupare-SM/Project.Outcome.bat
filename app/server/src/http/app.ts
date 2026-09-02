import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from '../platform/config.js';
import { loggerOptions } from '../platform/logger.js';
import { AppError, RateLimitedError } from '../platform/errors.js';
import { resolveApiKey, resolveSession } from '../modules/auth/service.js';
import type { UserCtx } from '../platform/ctx.js';
import { registerRoutes } from './routes.js';

export const SESSION_COOKIE = 'outcome_session';
export const CSRF_COOKIE = 'outcome_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    userCtx: UserCtx | null;
    apiKeyOrgId: string | null;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = config();
  const app = Fastify({
    logger: loggerOptions(),
    trustProxy: cfg.isProd,
    bodyLimit: 1024 * 1024, // 1 MB; attachments go straight to object storage
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: cfg.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  await app.register(cookie, { secret: cfg.SESSION_SECRET });

  await app.register(rateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_MAX,
    timeWindow: cfg.RATE_LIMIT_WINDOW_MS,
    // Authenticated callers are bucketed per user; anonymous per IP.
    keyGenerator: (req: FastifyRequest) => req.userCtx?.userId ?? req.ip,
    // Tests exercise many requests quickly; limiting there only adds flakes.
    enableDraftSpec: true,
    skipOnError: true,
    allowList: () => cfg.isTest,
  });

  app.decorateRequest('userCtx', null);
  app.decorateRequest('apiKeyOrgId', null);

  // ---- authentication: session cookie or personal API key ----
  app.addHook('onRequest', async (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const resolved = await resolveApiKey(auth.slice(7).trim());
      if (resolved) {
        req.userCtx = {
          userId: resolved.userId,
          sessionId: null,
          apiKeyId: resolved.apiKeyId,
          requestId: req.id,
        };
        req.apiKeyOrgId = resolved.orgId;
      }
      return;
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await resolveSession(token);
    if (session) {
      req.userCtx = {
        userId: session.userId,
        sessionId: session.sessionId,
        apiKeyId: null,
        requestId: req.id,
      };
    }
  });

  // ---- CSRF: double-submit cookie for browser sessions ----
  // API-key callers are exempt (no ambient credential to ride on).
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (req.userCtx?.apiKeyId) return;
    if (!req.cookies[SESSION_COOKIE]) return; // unauthenticated: login/signup
    const cookieToken = req.cookies[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER];
    if (!cookieToken || typeof headerToken !== 'string' || headerToken !== cookieToken) {
      throw new AppError(
        403,
        'csrf_failed',
        'Request blocked',
        'This request could not be verified. Reload the page and try again.',
      );
    }
  });

  // ---- one error mapper for the whole API (must precede route plugins) ----
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of err.issues) fields[issue.path.join('.') || '_'] = issue.message;
      return reply.status(400).send({
        type: 'validation_error',
        title: 'Invalid request',
        status: 400,
        detail: 'Some fields need attention',
        fields,
        requestId,
      });
    }
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err, requestId }, 'app error');
      return reply.status(err.status).send({
        type: err.type,
        title: err.title,
        status: err.status,
        detail: err.detail,
        fields: err.fields,
        requestId,
      });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      const e = new RateLimitedError();
      return reply.status(429).send({ type: e.type, title: e.title, status: 429, detail: e.detail, requestId });
    }
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({
        type: 'request_error',
        title: 'Request failed',
        status: statusCode,
        detail: (err as Error).message,
        requestId,
      });
    }
    req.log.error({ err, requestId }, 'unhandled error');
    return reply.status(500).send({
      type: 'internal_error',
      title: 'Something went wrong',
      status: 500,
      detail: 'An unexpected error occurred. Quote this reference to support.',
      requestId,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      type: 'not_found',
      title: 'Not found',
      status: 404,
      detail: `No route for ${req.method} ${req.url}`,
      requestId: req.id,
    });
  });

  // Registered last: Fastify only applies error/not-found handlers to plugin
  // contexts created after they are set.
  await registerRoutes(app);

  return app;
}

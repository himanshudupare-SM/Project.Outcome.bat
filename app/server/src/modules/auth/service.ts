import type { LoginInput, MeResponse, OrgRole, SignupInput } from '@outcome/shared';
import { db, isUniqueViolation, withTx, type Queryable } from '../../platform/db.js';
import {
  ConflictError,
  RateLimitedError,
  ValidationError,
  AuthRequiredError,
} from '../../platform/errors.js';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../../platform/crypto.js';

export const SESSION_TTL_DAYS = 30;
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_WINDOW_MIN = 15;

export interface SessionUser {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  email_verified_at: string | null;
  timezone: string;
}

export async function signup(input: SignupInput): Promise<{ userId: string }> {
  const passwordHash = await hashPassword(input.password);
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [input.email, input.name, passwordHash],
    );
    return { userId: rows[0]!.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError('An account with this email already exists', {
        email: 'Already registered',
      });
    }
    throw err;
  }
}

/**
 * Password login. Failures are counted per account over a rolling window so
 * credential stuffing is throttled independently of the IP rate limiter, and
 * the error message never reveals whether the account exists.
 */
export async function login(
  input: LoginInput,
  meta: { ip?: string; userAgent?: string },
): Promise<{ token: string; user: SessionUser }> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, name, email, password_hash, email_verified_at, timezone
       FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [input.email],
  );
  const user = rows[0];

  if (user) {
    const { rows: attempts } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM login_attempts
        WHERE user_id = $1 AND succeeded = false AND created_at > now() - ($2 || ' minutes')::interval`,
      [user.id, String(LOCKOUT_WINDOW_MIN)],
    );
    if ((attempts[0]?.n ?? 0) >= MAX_FAILED_ATTEMPTS) {
      throw new RateLimitedError(
        `Too many failed sign-in attempts. Try again in ${LOCKOUT_WINDOW_MIN} minutes.`,
      );
    }
  }

  const ok = user ? await verifyPassword(input.password, user.password_hash) : false;

  if (user) {
    await db.query(
      `INSERT INTO login_attempts (user_id, ip, succeeded) VALUES ($1, $2, $3)`,
      [user.id, meta.ip ?? null, ok],
    );
  }
  if (!user || !ok) throw new ValidationError('Incorrect email or password');

  const session = await createSession(user.id, meta);
  return {
    token: session.token,
    user: { userId: user.id, sessionId: session.id, name: user.name, email: user.email },
  };
}

export async function createSession(
  userId: string,
  meta: { ip?: string; userAgent?: string },
  tx: Queryable = db,
): Promise<{ id: string; token: string }> {
  const token = generateToken(32);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
     RETURNING id`,
    [userId, hashToken(token), meta.ip ?? null, meta.userAgent?.slice(0, 400) ?? null, String(SESSION_TTL_DAYS)],
  );
  return { id: rows[0]!.id, token };
}

/** Resolve a session cookie to a user, sliding the expiry forward. */
export async function resolveSession(token: string): Promise<SessionUser | null> {
  const { rows } = await db.query<{
    session_id: string;
    user_id: string;
    name: string;
    email: string;
  }>(
    `UPDATE sessions s
        SET last_seen_at = now(),
            expires_at = now() + ($2 || ' days')::interval
       FROM users u
      WHERE s.token_hash = $1
        AND s.user_id = u.id
        AND s.expires_at > now()
        AND u.deleted_at IS NULL
      RETURNING s.id AS session_id, u.id AS user_id, u.name, u.email`,
    [hashToken(token), String(SESSION_TTL_DAYS)],
  );
  const row = rows[0];
  if (!row) return null;
  return { userId: row.user_id, sessionId: row.session_id, name: row.name, email: row.email };
}

export async function logout(sessionId: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function logoutAll(userId: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function resolveApiKey(
  presented: string,
): Promise<{ userId: string; orgId: string; apiKeyId: string } | null> {
  const { rows } = await db.query<{ id: string; user_id: string; org_id: string }>(
    `UPDATE api_keys k SET last_used_at = now()
       FROM users u
      WHERE k.token_hash = $1 AND k.revoked_at IS NULL
        AND k.user_id = u.id AND u.deleted_at IS NULL
      RETURNING k.id, k.user_id, k.org_id`,
    [hashToken(presented)],
  );
  const row = rows[0];
  return row ? { userId: row.user_id, orgId: row.org_id, apiKeyId: row.id } : null;
}

export async function me(userId: string): Promise<MeResponse> {
  const { rows: users } = await db.query<UserRow>(
    `SELECT id, name, email, password_hash, email_verified_at, timezone
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  const user = users[0];
  if (!user) throw new AuthRequiredError('Your account is no longer available');

  const { rows: orgs } = await db.query<{
    id: string;
    name: string;
    slug: string;
    role: OrgRole;
  }>(
    `SELECT o.id, o.name, o.slug, m.role
       FROM org_members m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND o.deleted_at IS NULL
      ORDER BY o.created_at`,
    [userId],
  );

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      timezone: user.timezone,
      emailVerified: user.email_verified_at !== null,
    },
    orgs,
  };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId: string | null,
): Promise<void> {
  const { rows } = await db.query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId],
  );
  const row = rows[0];
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    throw new ValidationError('Current password is incorrect', { currentPassword: 'Incorrect' });
  }
  const hash = await hashPassword(newPassword);
  await withTx(async (tx) => {
    await tx.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, userId]);
    // Changing a password invalidates every other session.
    if (keepSessionId) {
      await tx.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [userId, keepSessionId]);
    } else {
      await tx.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    }
  });
}

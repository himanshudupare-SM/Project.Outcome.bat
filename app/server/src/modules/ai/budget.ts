import { RateLimitedError } from '../../platform/errors.js';
import { config } from '../../platform/config.js';
import type { Queryable } from '../../platform/db.js';
import type { OrgCtx } from '../../platform/ctx.js';

/**
 * Per-org daily AI call budget, so a runaway client cannot burn the quota.
 *
 * Reservation is a single statement: the upsert increments and returns the new
 * total, so two simultaneous requests cannot both see a count below the limit.
 * A count-then-insert would race, and making that atomic would mean holding a
 * lock across the model call — serializing every AI request in the org behind
 * a network round trip.
 *
 * A reserved slot is consumed even if the provider then fails. That is
 * deliberate: a failed call still costs the provider quota, and refunding it
 * would reopen the race it exists to close.
 */
export async function reserveAiCall(tx: Queryable, ctx: OrgCtx): Promise<number> {
  const budget = config().AI_DAILY_CALL_BUDGET;
  const { rows } = await tx.query<{ calls: number }>(
    `INSERT INTO ai_usage_daily (org_id, day, calls)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (org_id, day)
       DO UPDATE SET calls = ai_usage_daily.calls + 1, updated_at = now()
     RETURNING calls`,
    [ctx.orgId],
  );
  const used = rows[0]!.calls;
  if (used > budget) {
    throw new RateLimitedError(
      "This organization has reached today's AI processing limit. Try again tomorrow, or add tasks manually.",
    );
  }
  return budget - used;
}

/** Calls used today, for surfacing remaining budget without reserving one. */
export async function aiCallsUsedToday(tx: Queryable, orgId: string): Promise<number> {
  const { rows } = await tx.query<{ calls: number }>(
    `SELECT calls FROM ai_usage_daily
      WHERE org_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
    [orgId],
  );
  return rows[0]?.calls ?? 0;
}

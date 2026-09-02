import { describe, expect, it } from 'vitest';
import { timestampToIso } from '../src/platform/db.js';
import { generateToken, hashToken, constantTimeEquals } from '../src/platform/crypto.js';

/** Platform helpers, unit-tested without a database. */

describe('timestamp formatting', () => {
  it('converts a Postgres timestamptz to ISO without losing microseconds', () => {
    expect(timestampToIso('2026-09-02 17:35:22.123456+00')).toBe('2026-09-02T17:35:22.123456Z');
  });

  it('keeps a non-UTC offset in ISO form', () => {
    expect(timestampToIso('2026-09-02 17:35:22.5+05')).toBe('2026-09-02T17:35:22.5+05:00');
  });

  it('handles a whole-second value and null', () => {
    expect(timestampToIso('2026-09-02 17:35:22+00')).toBe('2026-09-02T17:35:22Z');
    expect(timestampToIso(null)).toBeNull();
  });

  it('produces something both Date and Postgres can read back', () => {
    const iso = timestampToIso('2026-09-02 17:35:22.123456+00')!;
    // Date truncates to milliseconds, which is fine for display...
    expect(new Date(iso).toISOString()).toBe('2026-09-02T17:35:22.123Z');
    // ...but the string itself still carries the full precision a cursor needs.
    expect(iso).toContain('.123456');
  });
});

describe('token helpers', () => {
  it('generates distinct, url-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken(32)));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically and irreversibly', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'much-longer-value')).toBe(false);
  });
});

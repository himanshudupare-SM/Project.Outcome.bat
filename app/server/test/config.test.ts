import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '../src/platform/config.js';

/**
 * Configuration validation. A misconfigured deploy should die at boot with a
 * clear message rather than serve traffic in an unsafe state.
 */

const base = {
  DATABASE_URL: 'postgres://user:pw@localhost:5432/db',
  SESSION_SECRET: 'a'.repeat(32),
};

describe('required values', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = loadConfig(base);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3001);
    expect(config.AI_PROVIDER).toBe('fake');
    expect(config.isProd).toBe(false);
  });

  it('names every missing required value at once', () => {
    let message = '';
    try {
      loadConfig({});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('SESSION_SECRET');
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'too-short' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...base, PORT: '99999' })).toThrow(/PORT/);
  });

  it('rejects a malformed APP_URL', () => {
    expect(() => loadConfig({ ...base, APP_URL: 'not-a-url' })).toThrow(/APP_URL/);
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL/);
  });
});

describe('safety guards', () => {
  it('requires a secure cookie in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    ).toThrow(/COOKIE_SECURE/);
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' }).isProd,
    ).toBe(true);
  });

  it('requires an API key when the real AI provider is selected', () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(
      loadConfig({ ...base, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' }).AI_PROVIDER,
    ).toBe('anthropic');
  });

  it('rejects an unknown AI provider rather than falling back silently', () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'mystery' })).toThrow(/AI_PROVIDER/);
  });
});

describe('redaction', () => {
  it('never reveals secrets in the boot summary', () => {
    const config = loadConfig({
      ...base,
      DATABASE_URL: 'postgres://dbuser:sup3rs3cret@db.internal:5432/outcome',
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-very-secret',
    });
    const summary = JSON.stringify(describeConfig(config));
    expect(summary).not.toContain('sup3rs3cret');
    expect(summary).not.toContain('sk-ant-very-secret');
    expect(summary).not.toContain(config.SESSION_SECRET);
    // The non-secret parts stay useful for debugging.
    expect(summary).toContain('db.internal');
    expect(summary).toContain('dbuser');
  });
});

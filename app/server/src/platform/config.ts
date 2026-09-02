import { z } from 'zod';

/**
 * Fail-fast typed configuration. Nothing in the app reads process.env
 * directly, so a misconfigured deploy dies at boot with a clear message
 * instead of failing mysteriously under load.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be >= 32 chars'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  AI_PROVIDER: z.enum(['fake', 'anthropic']).default('fake'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(100).default(40_000),
  AI_DAILY_CALL_BUDGET: z.coerce.number().int().min(1).default(500),
  EMAIL_PROVIDER: z.enum(['console']).default('console'),
});

export type Config = Omit<z.infer<typeof schema>, 'NODE_ENV'> & {
  NODE_ENV: 'development' | 'test' | 'production';
  isProd: boolean;
  isTest: boolean;
};

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const value = parsed.data;
  if (value.AI_PROVIDER === 'anthropic' && !value.ANTHROPIC_API_KEY) {
    throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }
  if (value.NODE_ENV === 'production' && !value.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  return {
    ...value,
    isProd: value.NODE_ENV === 'production',
    isTest: value.NODE_ENV === 'test',
  };
}

export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Redacted view for boot logs. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    NODE_ENV: c.NODE_ENV,
    PORT: c.PORT,
    APP_URL: c.APP_URL,
    DATABASE_URL: c.DATABASE_URL.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@'),
    AI_PROVIDER: c.AI_PROVIDER,
    ANTHROPIC_API_KEY: c.ANTHROPIC_API_KEY ? '***' : undefined,
    SESSION_SECRET: '***',
    LOG_LEVEL: c.LOG_LEVEL,
  };
}

import { pino, type LoggerOptions } from 'pino';
import { config } from './config.js';

/**
 * Shared pino options. Handed to Fastify (which builds its own instance for
 * request logging) and used for the standalone logger below, so redaction
 * rules can never diverge between the two.
 */
export function loggerOptions(): LoggerOptions {
  return {
    level: config().LOG_LEVEL,
    // Never log credentials or tokens, whatever a caller passes.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        '*.password',
        'token',
        '*.token',
        'credentials',
        'credentials_encrypted',
      ],
      censor: '[redacted]',
    },
  };
}

/** For boot, jobs and scripts — outside the request lifecycle. */
export const logger = pino(loggerOptions());
export type Logger = typeof logger;

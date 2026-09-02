import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
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
    ],
    censor: '[redacted]',
  },
});
export type Logger = typeof logger;

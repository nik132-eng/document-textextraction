import { Injectable, type LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';

/**
 * PHI rule (00 §4): log ids, statuses, counts, durations and error codes only.
 * Redaction is a backstop; callers must not pass values, text or file names.
 */
export function createRootLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'idp-engine-poc' },
    redact: {
      paths: [
        '*.value',
        '*.text',
        '*.groundingText',
        '*.apiKey',
        '*.authorization',
        '*.Authorization',
        '*.filename',
        '*.originalname',
      ],
      censor: '[redacted]',
    },
  });
}

type Level = 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal';

/** Routes Nest's Logger calls into pino as structured JSON. */
@Injectable()
export class PinoNestLogger implements LoggerService {
  constructor(private readonly root: Logger) {}

  log(message: unknown, ...rest: unknown[]) {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.write('fatal', message, rest);
  }

  private write(level: Level, message: unknown, rest: unknown[]) {
    const last = rest.at(-1);
    const context = typeof last === 'string' ? last : undefined;
    if (message instanceof Error) {
      this.root[level]({ context, err: { name: message.name, message: message.message } });
    } else if (message !== null && typeof message === 'object') {
      this.root[level]({ context, ...(message as Record<string, unknown>) });
    } else {
      this.root[level]({ context }, String(message));
    }
  }
}

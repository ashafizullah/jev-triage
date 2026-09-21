import { pino } from "pino";
import type { Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  level?: string;
  /** Disable output entirely (used by tests and the report CLI). */
  silent?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? "info";
  return pino({
    level,
    enabled: options.silent !== true,
    // The bundled logger is used by CLI entry points; Probot supplies its own for webhooks.
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

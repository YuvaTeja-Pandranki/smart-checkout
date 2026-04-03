/**
 * Structured logger — writes JSON to stdout so CloudWatch can index fields.
 * SPEC.md §11: No PII (payment tokens, raw card data) should appear in logs.
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  // Using process.stdout.write keeps logs as single-line JSON (CloudWatch friendly)
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  info: (message: string, fields?: Record<string, unknown>) => log('INFO', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log('WARN', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log('ERROR', message, fields),
};

import type { SqlError } from '@shared/types';

/** Error with a machine readable code the renderer can react to (e.g. PASSWORD_REQUIRED). */
export class KsError extends Error {
  constructor(
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'KsError';
  }
}

export function toSqlError(e: unknown, sql?: string): SqlError {
  if (e && typeof e === 'object') {
    const x = e as { sqlMessage?: string; message?: string; code?: string; errno?: number; sqlState?: string; sql?: string };
    return {
      message: x.sqlMessage || x.message || String(e),
      code: x.code,
      errno: x.errno,
      sqlState: x.sqlState,
      sql: sql ?? x.sql
    };
  }
  return { message: String(e), sql };
}

const FATAL_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_SOCKET_CLOSED',
  'ER_SERVER_SHUTDOWN'
]);

export function isFatalConnectionError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const x = e as { fatal?: boolean; code?: string };
  return x.fatal === true || (x.code !== undefined && FATAL_CODES.has(x.code));
}

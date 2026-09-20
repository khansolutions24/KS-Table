// Thin promise wrapper around a mysql2 connection with row streaming,
// multiple result sets (CALL) and an optional row limit.

import fs from 'node:fs';
import type { Duplex } from 'node:stream';
import mysql from 'mysql2';
import type { Connection, ConnectionOptions, FieldPacket, QueryError, ResultSetHeader } from 'mysql2';
import type { CellValue, ConnectionConfig } from '@shared/types';

export interface RawRows {
  kind: 'rows';
  fields: FieldPacket[];
  rows: unknown[][];
  truncated: boolean;
}

export interface RawOk {
  kind: 'ok';
  affectedRows: number;
  insertId: string;
  changedRows: number;
  warningStatus: number;
  info: string;
  serverStatus: number;
}

export type RawResult = RawRows | RawOk;

export interface RunOptions {
  values?: unknown[];
  /** Keep at most this many rows per result set (0 = all) */
  maxRows?: number;
  /** Called once when a result set hits maxRows */
  onTruncate?: () => void;
}

/**
 * Common surface of SqlConn (direct / SSH, real mysql2 socket) and HttpConn (query-level
 * HTTP tunnel, see httpConn.ts) — everything in Session/db/* goes through this so both
 * transports are interchangeable. `.raw` is the escape hatch for mysql2-specific streaming
 * (backup, bulk export); HttpConn's `.raw` throws a clear error instead of supporting it.
 */
export interface DbConn {
  readonly threadId: number;
  readonly isDead: boolean;
  readonly raw: Connection;
  run(sql: string, opts?: RunOptions): Promise<RawResult[]>;
  ping(): Promise<void>;
  end(): Promise<void>;
  destroy(): void;
}

const ER_QUERY_INTERRUPTED = 1317;
const SERVER_STATUS_IN_TRANS = 1;

export class SqlConn implements DbConn {
  private dead = false;

  constructor(private readonly c: Connection) {
    c.on('error', () => {
      this.dead = true;
    });
    c.on('end', () => {
      this.dead = true;
    });
  }

  get threadId(): number {
    return this.c.threadId ?? 0;
  }

  get isDead(): boolean {
    return this.dead;
  }

  get raw(): Connection {
    return this.c;
  }

  run(sql: string, opts: RunOptions = {}): Promise<RawResult[]> {
    return new Promise<RawResult[]>((resolve, reject) => {
      const results: RawResult[] = [];
      const maxRows = opts.maxRows ?? 0;
      let current: RawRows | null = null;
      let truncatedAny = false;
      let settled = false;

      const q = this.c.query({ sql, values: opts.values, rowsAsArray: true });

      q.on('fields', (fields: FieldPacket[] | undefined) => {
        // mysql2 emits 'fields' with undefined before an OK packet (statement without result set)
        if (!fields) return;
        current = { kind: 'rows', fields, rows: [], truncated: false };
        results.push(current);
      });

      q.on('result', (row: unknown) => {
        if (Array.isArray(row)) {
          if (!current) {
            current = { kind: 'rows', fields: [], rows: [], truncated: false };
            results.push(current);
          }
          if (maxRows > 0 && current.rows.length >= maxRows) {
            if (!current.truncated) {
              current.truncated = true;
              truncatedAny = true;
              opts.onTruncate?.();
            }
            return;
          }
          current.rows.push(row);
        } else if (row && typeof row === 'object') {
          const h = row as ResultSetHeader & { changedRows?: number };
          results.push({
            kind: 'ok',
            affectedRows: h.affectedRows ?? 0,
            insertId: String(h.insertId ?? 0),
            changedRows: h.changedRows ?? 0,
            warningStatus: h.warningStatus ?? 0,
            info: h.info ?? '',
            serverStatus: h.serverStatus ?? 0
          });
          current = null;
        }
      });

      q.on('error', (err: QueryError) => {
        if (settled) return;
        settled = true;
        if (truncatedAny && err.errno === ER_QUERY_INTERRUPTED) {
          resolve(results);
          return;
        }
        (err as QueryError & { partialResults?: RawResult[] }).partialResults = results;
        reject(err);
      });

      q.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(results);
      });
    });
  }

  ping(): Promise<void> {
    return new Promise((resolve, reject) => this.c.ping((err) => (err ? reject(err) : resolve())));
  }

  end(): Promise<void> {
    return new Promise((resolve) => {
      if (this.dead) {
        this.destroy();
        resolve();
        return;
      }
      const t = setTimeout(() => {
        this.destroy();
        resolve();
      }, 2000);
      this.c.end(() => {
        clearTimeout(t);
        this.dead = true;
        resolve();
      });
    });
  }

  destroy(): void {
    this.dead = true;
    try {
      this.c.destroy();
    } catch {
      // ignore
    }
  }
}

export function inTransaction(results: RawResult[], previous: boolean): boolean {
  let state = previous;
  for (const r of results) if (r.kind === 'ok') state = (r.serverStatus & SERVER_STATUS_IN_TRANS) !== 0;
  return state;
}

export function buildOptions(cfg: ConnectionConfig, password: string, stream?: Duplex): ConnectionOptions {
  const o: ConnectionOptions = {
    host: cfg.host || '127.0.0.1',
    port: cfg.port || 3306,
    user: cfg.user,
    password,
    charset: 'UTF8MB4_UNICODE_CI',
    connectTimeout: (cfg.connectTimeout || 15) * 1000,
    compress: cfg.useCompression,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
    multipleStatements: false,
    flags: ['-FOUND_ROWS'],
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    typeCast: (field, next) => (field.type === 'GEOMETRY' ? field.buffer() : next())
  };
  if (cfg.socketPath && !stream) {
    o.socketPath = cfg.socketPath;
    delete o.host;
    delete o.port;
  }
  if (stream) o.stream = stream;
  if (cfg.ssl.enabled) {
    const read = (p: string) => (p ? fs.readFileSync(p, 'utf8') : undefined);
    o.ssl = {
      ca: read(cfg.ssl.ca),
      cert: read(cfg.ssl.cert),
      key: read(cfg.ssl.key),
      passphrase: cfg.ssl.passphrase || undefined,
      ciphers: cfg.ssl.cipher || undefined,
      rejectUnauthorized: cfg.ssl.verifyServerCert,
      verifyIdentity: cfg.ssl.verifyIdentity
    };
  }
  return o;
}

export function openConnection(opts: ConnectionOptions): Promise<SqlConn> {
  return new Promise<SqlConn>((resolve, reject) => {
    let done = false;
    const c = mysql.createConnection(opts);
    c.once('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
    c.connect((err) => {
      if (done) return;
      done = true;
      if (err) {
        try {
          c.destroy();
        } catch {
          // ignore
        }
        reject(err);
      } else {
        resolve(new SqlConn(c));
      }
    });
  });
}

/** Convert driver values to transport values: numbers → strings, objects → JSON, Buffers kept. */
export function normalizeRows(rows: unknown[][]): CellValue[][] {
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (v === null || typeof v === 'string' || v instanceof Uint8Array) continue;
      if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') row[i] = String(v);
      else if (v instanceof Date) row[i] = v.toISOString();
      else row[i] = JSON.stringify(v);
    }
  }
  return rows as CellValue[][];
}

/** Rows of a result set as objects keyed by column label (for metadata queries). */
export function rowsToObjects<T = Record<string, unknown>>(r: RawRows): T[] {
  const names = r.fields.map((f) => f.name);
  return r.rows.map((row) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) {
      const v = row[i];
      o[names[i]] = v instanceof Uint8Array && !(names[i] in o) ? Buffer.from(v).toString('utf8') : v;
    }
    return o as T;
  });
}

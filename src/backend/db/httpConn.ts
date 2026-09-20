// Query-level HTTP tunnel client: talks to ks_tunnel.php over plain HTTP requests
// instead of a raw TCP/SSH socket. One statement per request, mirroring how
// SqlConn.run() is always called (see driver.ts: multipleStatements is off).
//
// Implements the same surface as SqlConn (threadId, isDead, raw, run/ping/end/destroy)
// so Session and the rest of the backend can use either without caring which.

import mysql from 'mysql2';
import type { Connection, FieldPacket } from 'mysql2';
import type { HttpTunnelConfig } from '@shared/types';
import { tr } from '@shared/i18n';
import { firstKeyword } from '@shared/sql/splitter';
import { KsError } from '../errors';
import type { DbConn, RawOk, RawResult, RawRows, RunOptions } from './driver';

const REQUEST_TIMEOUT_MS = 45000;

export interface HttpTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  charset: string;
}

type WireValue = string | null | { __b64: string };
interface WireField {
  name: string;
  orgName: string;
  table: string;
  orgTable: string;
  schema: string;
  type: number;
  flags: number;
  charsetNr: number;
  length: number;
  decimals: number;
}
interface WireRows {
  kind: 'rows';
  fields: WireField[];
  rows: WireValue[][];
  truncated: boolean;
}
interface WireOk {
  kind: 'ok';
  affectedRows: number;
  insertId: string;
  changedRows: number;
  warningStatus: number;
  info: string;
}
type WireResult = WireRows | WireOk;
interface WireOkResponse {
  ok: true;
  results?: WireResult[];
  threadId?: number;
  serverInfo?: string;
  inTransaction?: boolean;
}
type WireResponse = WireOkResponse | { ok: false; error: { message: string; errno?: number; sqlState?: string; fatal?: boolean } };

const SERVER_STATUS_IN_TRANS = 1;

class TunnelTransportError extends KsError {
  fatal = true;
}

async function request(http: HttpTunnelConfig, body: Record<string, unknown>): Promise<WireOkResponse> {
  if (!http.url) {
    throw new TunnelTransportError(tr('Für den HTTP-Tunnel ist keine URL eingetragen.', 'No URL is set for the HTTP tunnel.'), 'HTTP_TUNNEL_ERROR');
  }
  const json = JSON.stringify(body);
  const useBase64 = !!http.base64;
  const headers: Record<string, string> = {
    'Content-Type': useBase64 ? 'text/plain; charset=utf-8' : 'application/json',
    'X-Ks-Encoding': useBase64 ? 'base64' : 'plain'
  };
  if (http.authUser || http.authPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${http.authUser}:${http.authPassword ?? ''}`).toString('base64')}`;
  }
  const payload = useBase64 ? Buffer.from(json, 'utf8').toString('base64') : json;

  let res: Response;
  try {
    res = await fetch(http.url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    throw new TunnelTransportError(tr('HTTP-Tunnel nicht erreichbar: {m}', 'HTTP tunnel unreachable: {m}', { m: (e as Error).message }), 'HTTP_TUNNEL_ERROR');
  }
  if (res.status === 401) {
    throw new TunnelTransportError(tr('HTTP-Tunnel: Benutzer oder Passwort falsch.', 'HTTP tunnel: wrong user or password.'), 'HTTP_TUNNEL_AUTH');
  }
  const text = await res.text();
  let data: WireResponse;
  try {
    data = JSON.parse(text) as WireResponse;
  } catch {
    throw new TunnelTransportError(
      tr('Ungültige Antwort des HTTP-Tunnel-Skripts (HTTP {s}).', 'Invalid response from the HTTP tunnel script (HTTP {s}).', { s: res.status }),
      'HTTP_TUNNEL_ERROR'
    );
  }
  if (!data.ok) {
    const err = data.error;
    if (err.fatal) throw new TunnelTransportError(err.message, 'HTTP_TUNNEL_ERROR');
    const e = new Error(err.message) as Error & { errno?: number; sqlState?: string };
    e.errno = err.errno;
    e.sqlState = err.sqlState;
    throw e;
  }
  return data;
}

function fromWireValue(v: WireValue): string | null | Uint8Array {
  if (v === null || typeof v === 'string') return v;
  return Buffer.from(v.__b64, 'base64');
}

/** Duck-types as mysql2's FieldPacket well enough for fieldTypes.ts's toResultColumn(). */
function toFieldPacket(f: WireField): FieldPacket {
  return {
    name: f.name,
    orgName: f.orgName,
    table: f.table,
    orgTable: f.orgTable,
    schema: f.schema,
    db: f.schema,
    type: f.type,
    flags: f.flags,
    charsetNr: f.charsetNr,
    length: f.length,
    decimals: f.decimals
  } as unknown as FieldPacket;
}

function toRawResult(r: WireResult, inTransaction: boolean): RawResult {
  if (r.kind === 'ok') {
    const ok: RawOk = {
      kind: 'ok',
      affectedRows: r.affectedRows,
      insertId: r.insertId,
      changedRows: r.changedRows,
      warningStatus: r.warningStatus,
      info: r.info,
      serverStatus: inTransaction ? SERVER_STATUS_IN_TRANS : 0
    };
    return ok;
  }
  const rows: RawRows = {
    kind: 'rows',
    fields: r.fields.map(toFieldPacket),
    rows: r.rows.map((row) => row.map(fromWireValue)),
    truncated: r.truncated
  };
  return rows;
}

export class HttpConn implements DbConn {
  private dead = false;
  private database: string | null = null;

  private constructor(
    private readonly http: HttpTunnelConfig,
    private readonly target: HttpTarget,
    readonly threadId: number
  ) {}

  get isDead(): boolean {
    return this.dead;
  }

  get raw(): Connection {
    throw new KsError(
      tr(
        'Diese Aktion benötigt eine direkte oder SSH-Verbindung; der HTTP-Tunnel unterstützt kein Streaming großer Ergebnismengen.',
        'This action needs a direct or SSH connection; the HTTP tunnel does not support streaming large result sets.'
      )
    );
  }

  static async open(http: HttpTunnelConfig, target: HttpTarget): Promise<HttpConn> {
    const res = await request(http, { action: 'connect', ...target });
    const threadId = typeof res.threadId === 'number' ? res.threadId : 0;
    return new HttpConn(http, target, threadId);
  }

  async run(sql: string, opts: RunOptions = {}): Promise<RawResult[]> {
    const text = opts.values && opts.values.length ? mysql.format(sql, opts.values as unknown[] as Parameters<typeof mysql.format>[1]) : sql;
    let res: WireOkResponse;
    try {
      res = await request(this.http, {
        action: 'query',
        ...this.target,
        database: this.database ?? '',
        sql: text,
        maxRows: opts.maxRows ?? 0
      });
    } catch (e) {
      if (e instanceof TunnelTransportError) this.dead = true;
      throw e;
    }
    this.trackUse(text);
    const inTransaction = !!res.inTransaction;
    const results = (res.results ?? []).map((r) => toRawResult(r, inTransaction));
    if (opts.maxRows && opts.onTruncate) {
      for (const r of results) if (r.kind === 'rows' && r.truncated) opts.onTruncate();
    }
    return results;
  }

  private trackUse(sql: string): void {
    if (firstKeyword(sql) !== 'USE') return;
    const m = /^\s*use\s+(`(?:[^`]|``)+`|[^\s;]+)/i.exec(sql);
    if (!m) return;
    let db = m[1];
    if (db.startsWith('`')) db = db.slice(1, -1).replace(/``/g, '`');
    this.database = db;
  }

  async ping(): Promise<void> {
    try {
      await request(this.http, { action: 'ping', ...this.target });
    } catch (e) {
      this.dead = true;
      throw e;
    }
  }

  async end(): Promise<void> {
    this.dead = true;
    await request(this.http, { action: 'close', ...this.target }).catch(() => undefined);
  }

  destroy(): void {
    this.dead = true;
    void request(this.http, { action: 'close', ...this.target }).catch(() => undefined);
  }
}

export function openHttpConnection(http: HttpTunnelConfig, target: HttpTarget): Promise<HttpConn> {
  return HttpConn.open(http, target);
}

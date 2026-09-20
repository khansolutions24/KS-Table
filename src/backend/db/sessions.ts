// Sessions: one dedicated MySQL connection each (query tabs, table viewers, navigator).
// SSH tunnels are shared per connection profile.

import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { ConnectionConfig, ConnectionTestResult, Credentials, ServerInfo, SessionInfo } from '@shared/types';
import { tr } from '@shared/i18n';
import { quoteId } from '@shared/sql/quote';
import { firstKeyword, splitStatements } from '@shared/sql/splitter';
import { KsError, isFatalConnectionError } from '../errors';
import { emit } from '../events';
import {
  buildOptions,
  inTransaction,
  openConnection,
  rowsToObjects,
  type DbConn,
  type RawOk,
  type RawResult,
  type RawRows,
  type RunOptions
} from './driver';
import { openHttpConnection } from './httpConn';
import { SshTunnel } from './tunnel';

export interface ConnectionSource {
  get(id: string): ConnectionConfig;
}

export function parseServerInfo(version: string, comment: string): ServerInfo {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const versionNumber = m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
  const type = /mariadb/i.test(`${version} ${comment}`) ? 'mariadb' : 'mysql';
  return { version, versionNumber, versionComment: comment, type };
}

async function initConnection(conn: DbConn, cfg: ConnectionConfig): Promise<ServerInfo> {
  const res = await conn.run('SELECT VERSION(), @@version_comment');
  const r = res[0] as RawRows;
  const server = parseServerInfo(String(r.rows[0]?.[0] ?? ''), String(r.rows[0]?.[1] ?? ''));
  const enc = (cfg.encoding || 'utf8mb4').trim();
  if (/^[a-z0-9_]+$/i.test(enc) && enc.toLowerCase() !== 'utf8mb4') await conn.run(`SET NAMES ${enc}`);
  if (server.type === 'mysql' && server.versionNumber >= 80000) {
    // always report fresh table statistics (row counts, sizes) in information_schema
    await conn.run('SET SESSION information_schema_stats_expiry = 0').catch(() => undefined);
  }
  if (cfg.timezone) await conn.run('SET time_zone = ?', { values: [cfg.timezone] });
  if (cfg.readOnly) await conn.run('SET SESSION TRANSACTION READ ONLY');
  for (const st of splitStatements(cfg.initSql || '')) await conn.run(st.sql);
  return server;
}

const EMPTY_OK: RawOk = { kind: 'ok', affectedRows: 0, insertId: '0', changedRows: 0, warningStatus: 0, info: '', serverStatus: 0 };

export class Session {
  lastUsed = Date.now();
  inTransaction = false;
  /** Increases with every statement; used to make KILL QUERY race free */
  statementSeq = 0;
  private busy = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    public config: ConnectionConfig,
    public conn: DbConn,
    public server: ServerInfo,
    public database: string | null,
    private readonly mgr: SessionManager
  ) {
    const iv = config.keepAliveInterval;
    if (iv > 0) this.keepAliveTimer = setInterval(() => void this.keepAlive(), iv * 1000);
  }

  get connectionId(): string {
    return this.config.id;
  }

  get threadId(): number {
    return this.conn.threadId;
  }

  get isBusy(): boolean {
    return this.busy > 0;
  }

  info(): SessionInfo {
    return {
      sessionId: this.id,
      connectionId: this.connectionId,
      threadId: this.threadId,
      server: this.server,
      database: this.database
    };
  }

  async run(sql: string, opts?: RunOptions): Promise<RawResult[]> {
    this.lastUsed = Date.now();
    this.busy++;
    this.statementSeq++;
    try {
      if (this.conn.isDead) await this.reconnect();
      let res: RawResult[];
      try {
        res = await this.conn.run(sql, opts);
      } catch (e) {
        if (isFatalConnectionError(e) && !this.inTransaction) {
          await this.reconnect();
          res = await this.conn.run(sql, opts);
        } else {
          if (isFatalConnectionError(e)) this.inTransaction = false;
          throw e;
        }
      }
      this.inTransaction = inTransaction(res, this.inTransaction);
      this.trackUse(sql);
      return res;
    } finally {
      this.busy--;
      this.lastUsed = Date.now();
    }
  }

  /** First result set as objects */
  async rows<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]> {
    const res = await this.run(sql, { values });
    const r = res.find((x): x is RawRows => x.kind === 'rows');
    return r ? rowsToObjects<T>(r) : [];
  }

  /** First result set (raw arrays) */
  async rowset(sql: string, values?: unknown[]): Promise<RawRows> {
    const res = await this.run(sql, { values });
    return res.find((x): x is RawRows => x.kind === 'rows') ?? { kind: 'rows', fields: [], rows: [], truncated: false };
  }

  async exec(sql: string, values?: unknown[]): Promise<RawOk> {
    const res = await this.run(sql, { values });
    return res.find((x): x is RawOk => x.kind === 'ok') ?? EMPTY_OK;
  }

  async useDatabase(db: string): Promise<void> {
    await this.run(`USE ${quoteId(db)}`);
    this.database = db;
  }

  private trackUse(sql: string): void {
    if (firstKeyword(sql) !== 'USE') return;
    const m = /^\s*use\s+(`(?:[^`]|``)+`|[^\s;]+)/i.exec(sql);
    if (!m) return;
    let db = m[1];
    if (db.startsWith('`')) db = db.slice(1, -1).replace(/``/g, '`');
    this.database = db;
  }

  private async keepAlive(): Promise<void> {
    if (this.busy > 0 || this.conn.isDead) return;
    if (Date.now() - this.lastUsed < this.config.keepAliveInterval * 800) return;
    try {
      await this.conn.ping();
    } catch {
      // reconnect lazily on next use
    }
  }

  async reconnect(): Promise<void> {
    const old = this.conn;
    const { conn, server } = await this.mgr.connect(this.config);
    old.destroy();
    this.conn = conn;
    this.server = server;
    this.inTransaction = false;
    if (this.database) {
      try {
        await conn.run(`USE ${quoteId(this.database)}`);
      } catch {
        this.database = null;
      }
    }
    emit('session:lost', {
      sessionId: this.id,
      connectionId: this.connectionId,
      message: tr('Verbindung wurde wiederhergestellt.', 'Connection was re-established.')
    });
  }

  async close(): Promise<void> {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    await this.conn.end();
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private tunnels = new Map<string, SshTunnel>();
  private creds = new Map<string, Credentials>();

  constructor(private readonly source: ConnectionSource) {}

  forgetCredentials(connectionId: string): void {
    this.creds.delete(connectionId);
  }

  private secrets(cfg: ConnectionConfig, extra?: Credentials, fromConfig = false) {
    const cached = this.creds.get(cfg.id) ?? {};
    const password = extra?.password ?? cached.password ?? (cfg.savePassword || fromConfig ? (cfg.password ?? '') : undefined);
    if (password === undefined) {
      throw new KsError(tr('Für „{n}“ ist ein Passwort erforderlich.', 'A password is required for "{n}".', { n: cfg.name }), 'PASSWORD_REQUIRED');
    }
    let sshPassword = '';
    let sshPassphrase = '';
    if (cfg.ssh.enabled) {
      if (cfg.ssh.authMethod === 'password') {
        const p = extra?.sshPassword ?? cached.sshPassword ?? (cfg.ssh.savePassword || fromConfig ? (cfg.ssh.password ?? '') : undefined);
        if (p === undefined) {
          throw new KsError(tr('SSH-Passwort erforderlich', 'SSH password required'), 'SSH_PASSWORD_REQUIRED');
        }
        sshPassword = p;
      } else if (cfg.ssh.authMethod === 'publicKey') {
        sshPassphrase = extra?.sshPassphrase ?? cached.sshPassphrase ?? (cfg.ssh.savePassphrase || fromConfig ? (cfg.ssh.passphrase ?? '') : '');
      }
    }
    return { password, sshPassword, sshPassphrase };
  }

  /** Raw connection for a profile; the SSH tunnel is shared per profile unless `ownTunnel` is passed. */
  async connect(
    cfg: ConnectionConfig,
    extra?: Credentials,
    opts: { ownTunnel?: SshTunnel; fromConfig?: boolean } = {}
  ): Promise<{ conn: DbConn; server: ServerInfo }> {
    const s = this.secrets(cfg, extra, opts.fromConfig);
    let conn: DbConn;
    if (cfg.http.enabled) {
      // query-level tunnel: no raw socket/stream, see httpConn.ts
      conn = await openHttpConnection(cfg.http, {
        host: cfg.host,
        port: cfg.port || 3306,
        user: cfg.user,
        password: s.password,
        charset: (cfg.encoding || 'utf8mb4').trim()
      });
    } else {
      let stream: Duplex | undefined;
      if (cfg.ssh.enabled) {
        let t = opts.ownTunnel ?? this.tunnels.get(cfg.id);
        if (!t || t.closed) {
          t = new SshTunnel(cfg.ssh, { password: s.sshPassword, passphrase: s.sshPassphrase });
          if (!opts.ownTunnel) this.tunnels.set(cfg.id, t);
        }
        stream = await t.forward(cfg.host, cfg.port);
      }
      conn = await openConnection(buildOptions(cfg, s.password, stream));
    }
    try {
      const server = await initConnection(conn, cfg);
      return { conn, server };
    } catch (e) {
      conn.destroy();
      throw e;
    }
  }

  async open(connectionId: string, database?: string | null, extra?: Credentials): Promise<Session> {
    const cfg = this.source.get(connectionId);
    const { conn, server } = await this.connect(cfg, extra);
    if (extra && Object.keys(extra).length) this.creds.set(connectionId, { ...this.creds.get(connectionId), ...extra });
    const session = new Session(randomUUID(), cfg, conn, server, null, this);
    this.sessions.set(session.id, session);
    if (database) {
      try {
        await session.useDatabase(database);
      } catch (e) {
        await this.close(session.id);
        throw e;
      }
    }
    return session;
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new KsError(tr('Sitzung nicht gefunden (Verbindung geschlossen?)', 'Session not found (connection closed?)'), 'NO_SESSION');
    return s;
  }

  forConnection(connectionId: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.connectionId === connectionId);
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.close().catch(() => undefined);
    this.dropTunnelIfUnused(s.connectionId);
  }

  async closeConnection(connectionId: string): Promise<void> {
    for (const s of this.forConnection(connectionId)) await this.close(s.id);
    this.dropTunnelIfUnused(connectionId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    for (const t of this.tunnels.values()) t.close();
    this.tunnels.clear();
  }

  private dropTunnelIfUnused(connectionId: string): void {
    if (this.forConnection(connectionId).length) return;
    const t = this.tunnels.get(connectionId);
    if (t) {
      t.close();
      this.tunnels.delete(connectionId);
    }
  }

  /** KILL QUERY for the statement currently running in a session (separate connection). */
  async killQuery(session: Session): Promise<void> {
    const { conn } = await this.connect(session.config);
    try {
      await conn.run(`KILL QUERY ${session.threadId}`);
    } finally {
      await conn.end();
    }
  }

  async listDatabases(cfg: ConnectionConfig): Promise<string[]> {
    const s = { password: cfg.ssh.password ?? '', passphrase: cfg.ssh.passphrase ?? '' };
    const tunnel = cfg.ssh.enabled ? new SshTunnel(cfg.ssh, s) : undefined;
    try {
      const { conn } = await this.connect(cfg, undefined, { ownTunnel: tunnel, fromConfig: true });
      try {
        const res = await conn.run('SHOW DATABASES');
        const r = res.find((x): x is RawRows => x.kind === 'rows');
        return r ? r.rows.map((row) => String(row[0])) : [];
      } finally {
        await conn.end();
      }
    } finally {
      tunnel?.close();
    }
  }

  async test(cfg: ConnectionConfig): Promise<ConnectionTestResult> {
    const t0 = Date.now();
    const s = { password: cfg.ssh.password ?? '', passphrase: cfg.ssh.passphrase ?? '' };
    const tunnel = cfg.ssh.enabled ? new SshTunnel(cfg.ssh, s) : undefined;
    try {
      const { conn, server } = await this.connect(cfg, undefined, { ownTunnel: tunnel, fromConfig: true });
      await conn.end();
      return { serverVersion: server.version, versionComment: server.versionComment, durationMs: Date.now() - t0 };
    } finally {
      tunnel?.close();
    }
  }
}

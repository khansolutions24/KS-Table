// Targets of a data transfer: a database (statements are executed) or an SQL script file.

import fs from 'node:fs/promises';
import path from 'node:path';
import iconv from 'iconv-lite';
import type { ServerType } from '@shared/types';
import { tr } from '@shared/i18n';
import { qname, quoteId, quoteString } from '@shared/sql/quote';
import { fileEncoding, type SyncFileEncoding } from '@shared/sync/encodings';
import { scriptStatement } from '@shared/sync/sqlText';
import type { BackendContext } from '../../api';
import { KsError } from '../../errors';
import { str } from '../../db/meta';
import { closeSyncSession, nameLookup, openSyncSession, schemaExists, type SyncSession } from './common';

/** Session settings stored with views / routines / triggers / events */
export interface ObjectSettings {
  sqlMode: string | null;
  timeZone: string | null;
}

export interface DataScope {
  transaction: boolean;
  lock: boolean;
}

export interface TransferSink {
  readonly kind: 'database' | 'file';
  /** Schema for qualified names ('' = unqualified statements) */
  readonly schema: string;
  readonly serverType: ServerType;
  /** Size limit of one extended INSERT */
  readonly maxStatementBytes: number;
  exec(sql: string): Promise<void>;
  /** CREATE of a view / routine / trigger / event under the object's sql_mode and time zone */
  execObject(sql: string, settings: ObjectSettings): Promise<void>;
  /** Lookup of existing base tables and views (file: nothing exists) */
  existingTables(): Promise<(name: string) => string | undefined>;
  /** Column names of an existing target table */
  columnsOf(table: string): Promise<string[]>;
  beginData(table: string, scope: DataScope): Promise<void>;
  endData(ok: boolean): Promise<void>;
  comment(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface SinkOptions {
  createDatabase: boolean;
  disableFkChecks: boolean;
  maxStatementKB: number;
  /** Character set / collation for CREATE DATABASE (null = server default) */
  charset: { charset: string; collation: string } | null;
}

function charsetClause(cs: SinkOptions['charset']): string {
  if (!cs?.charset) return '';
  return ` CHARACTER SET ${cs.charset}${cs.collation ? ` COLLATE ${cs.collation}` : ''}`;
}

// ───────────────────────── database ─────────────────────────

export class DbSink implements TransferSink {
  readonly kind = 'database';
  private scope: DataScope | null = null;

  private constructor(
    private readonly ctx: BackendContext,
    private readonly ss: SyncSession,
    readonly schema: string,
    readonly maxStatementBytes: number
  ) {}

  get serverType(): ServerType {
    return this.ss.s.server.type;
  }

  static async open(
    ctx: BackendContext,
    connectionId: string,
    database: string,
    o: SinkOptions,
    log: (msg: string) => void
  ): Promise<DbSink> {
    const ss = await openSyncSession(ctx, connectionId, null, 'lenient');
    try {
      if (!(await schemaExists(ss.s, database))) {
        if (!o.createDatabase) {
          throw new KsError(tr('Die Zieldatenbank „{d}“ existiert nicht.', 'The target database "{d}" does not exist.', { d: database }));
        }
        await ss.s.exec(`CREATE DATABASE IF NOT EXISTS ${quoteId(database)}${charsetClause(o.charset)}`);
        log(tr('Datenbank „{d}“ wurde erstellt.', 'Database "{d}" was created.', { d: database }));
      }
      await ss.s.useDatabase(database);
      if (o.disableFkChecks) await ss.s.exec('SET FOREIGN_KEY_CHECKS = 0');
      const maxBytes = Math.max(16 * 1024, Math.min(o.maxStatementKB * 1024, ss.maxPacket - 8 * 1024));
      return new DbSink(ctx, ss, database, maxBytes);
    } catch (e) {
      await closeSyncSession(ctx, ss);
      throw e;
    }
  }

  async exec(sql: string): Promise<void> {
    await this.ss.s.exec(sql);
  }

  async execObject(sql: string, st: ObjectSettings): Promise<void> {
    const s = this.ss.s;
    const mode = st.sqlMode !== null && st.sqlMode !== this.ss.sqlMode ? st.sqlMode : null;
    if (mode !== null) await s.exec('SET SESSION sql_mode = ?', [mode]);
    if (st.timeZone) await s.exec('SET SESSION time_zone = ?', [st.timeZone]);
    try {
      await s.exec(sql);
    } finally {
      if (mode !== null) await s.exec('SET SESSION sql_mode = ?', [this.ss.sqlMode]).catch(() => undefined);
      if (st.timeZone) await s.exec("SET SESSION time_zone = '+00:00'").catch(() => undefined);
    }
  }

  async existingTables(): Promise<(name: string) => string | undefined> {
    const rows = await this.ss.s.rows<Record<string, unknown>>('SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [
      this.schema
    ]);
    return nameLookup(rows.map((r) => str(r.n)));
  }

  async columnsOf(table: string): Promise<string[]> {
    const rows = await this.ss.s.rows<Record<string, unknown>>(
      'SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [this.schema, table]
    );
    return rows.map((r) => str(r.n));
  }

  async beginData(table: string, scope: DataScope): Promise<void> {
    const s = this.ss.s;
    if (scope.lock) {
      if (scope.transaction) await s.exec('SET autocommit = 0');
      await s.exec(`LOCK TABLES ${qname(this.schema, table)} WRITE`);
    } else if (scope.transaction) await s.exec('START TRANSACTION');
    this.scope = scope;
  }

  async endData(ok: boolean): Promise<void> {
    const scope = this.scope;
    this.scope = null;
    if (!scope) return;
    const s = this.ss.s;
    if (scope.transaction) await s.exec(ok ? 'COMMIT' : 'ROLLBACK');
    if (scope.lock) {
      await s.exec('UNLOCK TABLES');
      if (scope.transaction) await s.exec('SET autocommit = 1');
    }
  }

  async comment(): Promise<void> {
    // nothing to do for a database target
  }

  async close(): Promise<void> {
    if (this.scope) await this.endData(false).catch(() => undefined);
    await closeSyncSession(this.ctx, this.ss);
  }
}

// ───────────────────────── SQL file ─────────────────────────

const FLUSH_CHARS = 1 << 20;

export class FileSink implements TransferSink {
  readonly kind = 'file';
  private buf: string[] = [];
  private bufLen = 0;
  private scope: DataScope | null = null;

  private constructor(
    private readonly fh: fs.FileHandle,
    readonly schema: string,
    private readonly enc: SyncFileEncoding,
    readonly serverType: ServerType,
    readonly maxStatementBytes: number,
    private readonly fkOff: boolean
  ) {}

  static async open(
    file: string,
    encodingId: string,
    database: string,
    serverType: ServerType,
    o: SinkOptions,
    header: string[]
  ): Promise<FileSink> {
    if (!file.trim()) throw new KsError(tr('Bitte eine Zieldatei angeben.', 'Please choose a target file.'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const fh = await fs.open(file, 'w');
    const enc = fileEncoding(encodingId);
    const sink = new FileSink(fh, database, enc, serverType, Math.max(16 * 1024, o.maxStatementKB * 1024), o.disableFkChecks);
    if (enc.bom) await fh.write(Buffer.from([0xef, 0xbb, 0xbf]));
    for (const h of header) sink.write(`-- ${h}\n`);
    sink.write('\n');
    sink.write(`SET NAMES ${enc.mysql};\n`);
    sink.write("SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n");
    sink.write("SET TIME_ZONE = '+00:00';\n");
    if (o.disableFkChecks) sink.write('SET FOREIGN_KEY_CHECKS = 0;\n');
    if (database) {
      if (o.createDatabase) sink.write(`CREATE DATABASE IF NOT EXISTS ${quoteId(database)}${charsetClause(o.charset)};\n`);
      sink.write(`USE ${quoteId(database)};\n`);
    }
    sink.write('\n');
    return sink;
  }

  private write(text: string): void {
    this.buf.push(text);
    this.bufLen += text.length;
  }

  private async flush(force = false): Promise<void> {
    if (!this.buf.length || (!force && this.bufLen < FLUSH_CHARS)) return;
    const text = this.buf.join('');
    this.buf = [];
    this.bufLen = 0;
    await this.fh.write(iconv.encode(text, this.enc.iconv));
  }

  async exec(sql: string): Promise<void> {
    this.write(scriptStatement(sql));
    await this.flush();
  }

  async execObject(sql: string, st: ObjectSettings): Promise<void> {
    if (st.sqlMode !== null) this.write(`SET SESSION sql_mode = ${quoteString(st.sqlMode)};\n`);
    if (st.timeZone) this.write(`SET SESSION time_zone = ${quoteString(st.timeZone)};\n`);
    this.write(scriptStatement(sql));
    if (st.sqlMode !== null) this.write("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO';\n");
    if (st.timeZone) this.write("SET SESSION time_zone = '+00:00';\n");
    await this.flush();
  }

  async existingTables(): Promise<(name: string) => string | undefined> {
    return () => undefined;
  }

  async columnsOf(): Promise<string[]> {
    return [];
  }

  async beginData(table: string, scope: DataScope): Promise<void> {
    if (scope.lock) {
      if (scope.transaction) this.write('SET autocommit = 0;\n');
      this.write(`LOCK TABLES ${this.schema ? qname(this.schema, table) : quoteId(table)} WRITE;\n`);
    } else if (scope.transaction) this.write('START TRANSACTION;\n');
    this.scope = scope;
  }

  async endData(ok: boolean): Promise<void> {
    const scope = this.scope;
    this.scope = null;
    if (!scope) return;
    if (scope.transaction) this.write(ok ? 'COMMIT;\n' : 'ROLLBACK;\n');
    if (scope.lock) {
      this.write('UNLOCK TABLES;\n');
      if (scope.transaction) this.write('SET autocommit = 1;\n');
    }
    await this.flush();
  }

  async comment(text: string): Promise<void> {
    this.write(`\n-- ${text.replace(/\r?\n/g, ' ')}\n`);
  }

  async close(): Promise<void> {
    try {
      if (this.scope) await this.endData(false);
      if (this.fkOff) this.write('\nSET FOREIGN_KEY_CHECKS = 1;\n');
      await this.flush(true);
    } finally {
      await this.fh.close();
    }
  }
}

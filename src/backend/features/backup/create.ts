// Creating a backup archive (*.ksbak): DDL per object, data as chunked INSERT files, manifest.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { ZipFile } from 'yazl';
import type { BackupManifest, BackupObjectType, BackupOptions, BackupProfile, BackupResult, ManifestObject } from '@shared/apis/backup';
import { tr } from '@shared/i18n';
import { qname, quoteId } from '@shared/sql/quote';
import { BACKUP_EXT, backupTimestamp, backupTypeLabel, normalizeBackupOptions, objectKey } from '@shared/backup/options';
import { formatBytes, formatDuration, formatNumber, safeFileName } from '@shared/util';
import type { BackendContext } from '../../api';
import { KsError } from '../../errors';
import type { Session } from '../../db/sessions';
import { platform } from '../../platform';
import type { TaskContext } from '../../tasks';
import { backupFolder, captureDdl, colKind, FORMAT, FORMAT_VERSION, MANIFEST, pad, valueLiteral } from './common';

const ROWS_PER_INSERT = 1000;
const STATEMENT_BYTES = 512 * 1024;
const CHUNK_BYTES = 16 * 1024 * 1024;
const TYPE_ORDER: BackupObjectType[] = ['table', 'function', 'procedure', 'view', 'trigger', 'event'];

interface InvItem {
  type: BackupObjectType;
  name: string;
  table?: string;
  engine?: string | null;
  comment?: string;
  estRows?: number;
}

type Row = Record<string, unknown>;
const s2 = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

async function inventory(s: Session, db: string): Promise<InvItem[]> {
  const out: InvItem[] = [];
  const tables = await s.rows<Row>(
    `SELECT TABLE_NAME AS n, TABLE_TYPE AS t, ENGINE AS e, TABLE_COMMENT AS c, TABLE_ROWS AS r
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED', 'VIEW')
      ORDER BY TABLE_NAME`,
    [db]
  );
  for (const r of tables) {
    if (s2(r.t) === 'VIEW') out.push({ type: 'view', name: s2(r.n) });
    else out.push({ type: 'table', name: s2(r.n), engine: r.e === null ? null : s2(r.e), comment: s2(r.c), estRows: Number(r.r ?? 0) || 0 });
  }
  const routines = await s.rows<Row>(
    `SELECT ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE IN ('FUNCTION', 'PROCEDURE') ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
    [db]
  );
  for (const r of routines) out.push({ type: s2(r.t) === 'FUNCTION' ? 'function' : 'procedure', name: s2(r.n) });
  const triggers = await s.rows<Row>(
    `SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER`,
    [db]
  );
  for (const r of triggers) out.push({ type: 'trigger', name: s2(r.n), table: s2(r.t) });
  const events = await s.rows<Row>('SELECT EVENT_NAME AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME', [db]);
  for (const r of events) out.push({ type: 'event', name: s2(r.n) });
  return out;
}

function selectObjects(inv: InvItem[], o: BackupOptions, t: TaskContext): InvItem[] {
  let list: InvItem[];
  if (o.selection === 'all') {
    list = inv.filter((i) => o.types[i.type]);
  } else {
    const have = new Set(inv.map((i) => objectKey(i).toLowerCase()));
    for (const ref of o.objects) {
      if (!have.has(objectKey(ref).toLowerCase())) {
        t.log('warn', tr('{t} „{n}“ existiert nicht mehr und wird übersprungen.', '{t} "{n}" no longer exists and is skipped.', { t: backupTypeLabel(ref.type), n: ref.name }));
      }
    }
    const want = new Set(o.objects.map((r) => objectKey(r).toLowerCase()));
    list = inv.filter((i) => want.has(objectKey(i).toLowerCase()));
  }
  // views, routines, triggers and events consist of structure only
  if (!o.structure) list = list.filter((i) => i.type === 'table');
  return list.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
}

/** Orders views so that a view is created after the views it reads from; fills dependsOn. */
function orderViews(objects: ManifestObject[], ddl: Map<ManifestObject, string>): ManifestObject[] {
  const views = objects.filter((o) => o.type === 'view');
  if (views.length < 2) return objects;
  const byName = new Map(views.map((v) => [v.name.toLowerCase(), v]));
  for (const v of views) {
    const body = (ddl.get(v) ?? '').replace(/^[\s\S]*?\bVIEW\s+`(?:[^`]|``)*`\s+AS\b/i, '');
    const deps = views.filter((w) => w !== v && body.includes(quoteId(w.name)));
    if (deps.length) v.dependsOn = deps.map((w) => w.name);
  }
  const sorted: ManifestObject[] = [];
  const done = new Set<ManifestObject>();
  let rest = views;
  while (rest.length) {
    const ready = rest.filter((v) => (v.dependsOn ?? []).every((d) => {
      const w = byName.get(d.toLowerCase());
      return !w || done.has(w);
    }));
    for (const v of ready.length ? ready : [rest[0]]) {
      sorted.push(v);
      done.add(v);
    }
    rest = rest.filter((v) => !done.has(v));
  }
  let i = 0;
  return objects.map((o) => (o.type === 'view' ? sorted[i++] : o));
}

/** Writes INSERT lines into consecutive archive entries; waits while the archive is busy (back pressure). */
class ChunkWriter {
  readonly files: string[] = [];
  private stream: PassThrough | null = null;
  private bytes = 0;

  constructor(
    private readonly zip: ZipFile,
    private readonly prefix: string,
    private readonly level: number,
    private readonly failed: Promise<never>
  ) {}

  async write(text: string): Promise<void> {
    if (!this.stream) {
      const name = `${this.prefix}-${pad(this.files.length + 1)}.sql`;
      this.stream = new PassThrough({ highWaterMark: 1 << 20 });
      this.zip.addReadStream(this.stream, name, { compressionLevel: this.level });
      this.files.push(name);
      this.bytes = 0;
    }
    const buf = Buffer.from(text, 'utf8');
    this.bytes += buf.length;
    if (!this.stream.write(buf)) await Promise.race([once(this.stream, 'drain'), this.failed]);
    if (this.bytes >= CHUNK_BYTES) this.finish();
  }

  finish(): void {
    this.stream?.end();
    this.stream = null;
  }
}

async function dumpTable(
  s: Session,
  db: string,
  obj: ManifestObject,
  index: number,
  zip: ZipFile,
  level: number,
  failed: Promise<never>,
  t: TaskContext,
  onRows: (rows: number) => void
): Promise<number> {
  const cols = await s.rows<Row>(
    `SELECT COLUMN_NAME AS n, DATA_TYPE AS d, GENERATION_EXPRESSION AS g FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [db, obj.name]
  );
  // generated columns are computed by the server; invisible columns are included explicitly
  const data = cols.filter((c) => !s2(c.g));
  obj.columns = data.map((c) => s2(c.n));
  obj.rows = 0;
  if (!data.length) return 0;
  const kinds = data.map((c) => colKind(s2(c.d)));
  const list = obj.columns.map(quoteId).join(',');
  const prefix = `INSERT INTO ${quoteId(obj.name)} (${list}) VALUES `;
  const writer = new ChunkWriter(zip, `data/${pad(index)}`, level, failed);
  const stream = s.conn.raw.query({ sql: `SELECT ${list} FROM ${qname(db, obj.name)}`, rowsAsArray: true }).stream({ highWaterMark: 1000 });
  let batch: string[] = [];
  let bytes = 0;
  let rows = 0;
  for await (const row of stream as AsyncIterable<unknown[]>) {
    let tuple = '(';
    for (let i = 0; i < row.length; i++) {
      if (i) tuple += ',';
      tuple += valueLiteral(row[i], kinds[i]);
    }
    tuple += ')';
    batch.push(tuple);
    bytes += tuple.length;
    rows++;
    if (batch.length >= ROWS_PER_INSERT || bytes >= STATEMENT_BYTES) {
      await writer.write(`${prefix}${batch.join(',')};\n`);
      batch = [];
      bytes = 0;
      t.throwIfCancelled();
      onRows(rows);
    }
  }
  if (batch.length) await writer.write(`${prefix}${batch.join(',')};\n`);
  writer.finish();
  obj.dataFiles = writer.files;
  obj.rows = rows;
  return rows;
}

async function targetFile(dir: string, fileName: string): Promise<string> {
  const custom = fileName.trim().replace(/\.ksbak$/i, '');
  if (custom) return path.join(dir, safeFileName(custom) + BACKUP_EXT);
  const base = backupTimestamp();
  for (let i = 0; ; i++) {
    const p = path.join(dir, (i ? `${base}_${i}` : base) + BACKUP_EXT);
    const exists = await fsp.stat(p).then(() => true, () => false);
    if (!exists) return p;
  }
}

export async function runBackup(ctx: BackendContext, profile: BackupProfile, t: TaskContext): Promise<BackupResult> {
  const o = normalizeBackupOptions(profile.options);
  const { connectionId, database } = profile;
  if (!connectionId || !database) {
    throw new KsError(tr('Verbindung und Datenbank der Sicherung fehlen.', 'Connection and database of the backup are missing.'));
  }
  if (!o.structure && !o.data) throw new KsError(tr('Weder Struktur noch Daten ausgewählt.', 'Neither structure nor data selected.'));
  const started = Date.now();
  const s = await ctx.sessions.open(connectionId, database);
  let ok = false;
  let tmp = '';
  let out: fs.WriteStream | null = null;
  try {
    t.log('info', tr('Sicherung der Datenbank „{db}“ ({c}) gestartet', 'Backup of database "{db}" ({c}) started', { db: database, c: s.config.name }));
    t.progress(null, tr('Objekte werden ermittelt …', 'Collecting objects …'));
    for (const sql of ['SET SESSION net_write_timeout = 3600', 'SET SESSION net_read_timeout = 3600']) await s.exec(sql).catch(() => undefined);
    await s.exec("SET time_zone = '+00:00'");
    const schema = (
      await s.rows<Row>('SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database])
    )[0];
    if (!schema) throw new KsError(tr('Die Datenbank „{db}“ existiert nicht.', 'Database "{db}" does not exist.', { db: database }));
    const inv = await inventory(s, database);
    const items = selectObjects(inv, o, t);
    if (!items.length) throw new KsError(tr('Es wurden keine Objekte zum Sichern gefunden.', 'No objects to back up were found.'));
    t.log('info', tr('{n} Objekte ausgewählt', '{n} objects selected', { n: items.length }));

    let locked = false;
    let inTx = false;
    if (o.consistency === 'snapshot') {
      await s.exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await s.exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
      inTx = true;
    }

    // structure
    let objects: ManifestObject[] = [];
    const ddl = new Map<ManifestObject, string>();
    for (const it of items) {
      t.throwIfCancelled();
      const obj: ManifestObject = { type: it.type, name: it.name, ddlFile: '', dataFiles: [], rows: null };
      if (it.table) obj.table = it.table;
      if (it.type === 'table') {
        obj.engine = it.engine ?? null;
        obj.comment = it.comment ?? '';
      }
      if (o.structure) {
        const c = await captureDdl(s, database, it.type, it.name);
        ddl.set(obj, c.ddl);
        if (it.type !== 'table') {
          if (c.sqlMode !== undefined) obj.sqlMode = c.sqlMode;
          if (c.collationConnection) obj.collationConnection = c.collationConnection;
          if (c.timeZone) obj.timeZone = c.timeZone;
        }
      }
      objects.push(obj);
    }
    objects = orderViews(objects, ddl);
    if (o.structure) t.log('info', tr('Struktur von {n} Objekten gelesen', 'Structure of {n} objects read', { n: objects.length }));

    const tables = objects.filter((x) => x.type === 'table');
    if (o.data && o.consistency === 'lock' && tables.length) {
      await s.exec(`LOCK TABLES ${tables.map((x) => `${qname(database, x.name)} READ LOCAL`).join(', ')}`);
      locked = true;
      t.log('info', tr('{n} Tabellen gesperrt (READ)', '{n} tables locked (READ)', { n: tables.length }));
    }

    // archive
    const dir = backupFolder(connectionId, database);
    await fsp.mkdir(dir, { recursive: true });
    const file = await targetFile(dir, o.fileName);
    tmp = `${file}.${process.pid}.tmp`;
    const zip = new ZipFile();
    const stream = fs.createWriteStream(tmp);
    out = stream;
    const failed = new Promise<never>((_, reject) => {
      zip.on('error', reject);
      stream.on('error', reject);
    });
    failed.catch(() => undefined);
    const closed = new Promise<void>((resolve) => stream.on('close', resolve));
    zip.outputStream.pipe(stream);
    const level = o.compression;

    objects.forEach((obj, i) => {
      const text = ddl.get(obj);
      if (text === undefined) return;
      obj.ddlFile = `ddl/${pad(i + 1)}-${obj.type}.sql`;
      zip.addBuffer(Buffer.from(text, 'utf8'), obj.ddlFile, { compressionLevel: level });
    });

    let totalRows = 0;
    if (o.data) {
      const est = new Map(items.filter((i) => i.type === 'table').map((i) => [i.name, i.estRows ?? 0]));
      const estTotal = Math.max(1, [...est.values()].reduce((a, b) => a + b, 0));
      for (const obj of tables) {
        t.throwIfCancelled();
        t.progress(Math.min(0.99, totalRows / estTotal), obj.name);
        const base = totalRows;
        const rows = await dumpTable(s, database, obj, objects.indexOf(obj) + 1, zip, level, failed, t, (r) =>
          t.progress(Math.min(0.99, (base + r) / estTotal), `${obj.name}: ${formatNumber(r)}`)
        );
        totalRows += rows;
        t.log('info', tr('Daten von „{n}“ gesichert: {r} Datensätze', 'Data of "{n}" saved: {r} records', { n: obj.name, r: formatNumber(rows) }));
      }
    }
    if (locked) {
      await s.exec('UNLOCK TABLES');
      locked = false;
    }
    if (inTx) {
      await s.exec('COMMIT');
      inTx = false;
    }

    const manifest: BackupManifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      app: `KS Table ${platform().appVersion}`,
      created: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      server: { version: s.server.version, type: s.server.type },
      connectionName: s.config.name,
      database,
      charset: s2(schema.cs),
      collation: s2(schema.co),
      comment: o.comment,
      options: { selection: o.selection, structure: o.structure, data: o.data, consistency: o.consistency, compression: level },
      objects,
      totals: { objects: objects.length, rows: totalRows }
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), MANIFEST, { compressionLevel: level });
    zip.end();
    await Promise.race([closed, failed]);
    out = null;
    await fsp.rm(file, { force: true });
    await fsp.rename(tmp, file);
    tmp = '';
    const st = await fsp.stat(file);
    const durationMs = Date.now() - started;
    t.progress(1);
    t.log(
      'success',
      tr('Sicherung erstellt: {f} ({s}, {o} Objekte, {r} Datensätze, {d})', 'Backup created: {f} ({s}, {o} objects, {r} records, {d})', {
        f: file,
        s: formatBytes(st.size),
        o: objects.length,
        r: formatNumber(totalRows),
        d: formatDuration(durationMs)
      })
    );
    ok = true;
    return { file, objects: objects.length, rows: totalRows, size: st.size, durationMs };
  } finally {
    // an interrupted row stream leaves the connection unusable; the server releases locks and the snapshot
    if (!ok) s.conn.destroy();
    await ctx.sessions.close(s.id);
    out?.destroy();
    if (tmp) await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

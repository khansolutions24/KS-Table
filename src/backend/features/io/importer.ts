// Import task: reads the sources, converts the values and writes them with batched statements.

import type { ColumnMeta, FieldDef } from '@shared/types';
import type { ImportFieldMap, ImportMode, ImportProfile, ImportResult, ImportSourceSpec } from '@shared/apis/io';
import { tr } from '@shared/i18n';
import { formatNumber } from '@shared/util';
import { newField, newTableDesign } from '@shared/defaults';
import { qname, quoteId } from '@shared/sql/quote';
import { createTableSql } from '@shared/sql/ddl';
import { defaultImportAdvanced, defaultImportOptions } from '@shared/io/defaults';
import type { BackendContext } from '../../api';
import type { TaskContext } from '../../tasks';
import type { Session } from '../../db/sessions';
import type { RawOk } from '../../db/driver';
import { columns as loadColumns } from '../../db/meta';
import { KsError, isFatalConnectionError, toSqlError } from '../../errors';
import { openSource, type SourceReader } from './readers';
import { ConversionError, makeConverter, type Converter, type SourceValue } from './convert';

const MAX_ERROR_LOG = 500;
const KEY_MODES = new Set<ImportMode>(['update', 'appendUpdate', 'appendNoUpdate', 'delete']);

export function modeLabel(m: ImportMode): string {
  switch (m) {
    case 'append':
      return tr('Anfügen', 'Append');
    case 'update':
      return tr('Aktualisieren', 'Update');
    case 'appendUpdate':
      return tr('Anfügen/Aktualisieren', 'Append/Update');
    case 'appendNoUpdate':
      return tr('Anfügen ohne Aktualisierung', 'Append without update');
    case 'delete':
      return tr('Löschen', 'Delete');
    case 'copy':
      return tr('Kopieren', 'Copy');
  }
}

export function sourceLabel(src: Pick<ImportSourceSpec, 'file' | 'sheet'>): string {
  const base = src.file.split(/[\\/]/).pop() ?? src.file;
  return src.sheet ? `${base} [${src.sheet}]` : base;
}

/** Fills missing settings with defaults and checks the profile. */
export function normalizeImportProfile(p: ImportProfile): ImportProfile {
  if (!p || typeof p !== 'object') throw new KsError(tr('Ungültiges Importprofil.', 'Invalid import profile.'));
  const format = p.format ?? 'csv';
  const out: ImportProfile = {
    version: 1,
    connectionId: String(p.connectionId ?? ''),
    database: String(p.database ?? ''),
    format,
    encoding: p.encoding || 'utf8',
    options: { ...defaultImportOptions(format), ...(p.options ?? {}) },
    sources: Array.isArray(p.sources) ? p.sources : [],
    mode: p.mode ?? 'append',
    advanced: { ...defaultImportAdvanced(), ...(p.advanced ?? {}) }
  };
  if (!out.connectionId) throw new KsError(tr('Keine Verbindung angegeben.', 'No connection specified.'));
  if (!out.database) throw new KsError(tr('Keine Zieldatenbank angegeben.', 'No target database specified.'));
  if (!out.sources.length) throw new KsError(tr('Keine Quelldateien angegeben.', 'No source files specified.'));
  for (const s of out.sources) {
    if (!s.file) throw new KsError(tr('Eine Quelle hat keinen Dateinamen.', 'A source has no file name.'));
    if (!s.table?.trim()) throw new KsError(tr('Für „{s}“ ist keine Zieltabelle angegeben.', 'No target table for "{s}".', { s: sourceLabel(s) }));
    if (!s.fields?.some((f) => f.target)) {
      throw new KsError(tr('Für „{s}“ ist kein Feld zugeordnet.', 'No field is mapped for "{s}".', { s: sourceLabel(s) }));
    }
  }
  return out;
}

interface Stats {
  read: number;
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
  errors: number;
}

interface Target {
  map: ImportFieldMap;
  col: ColumnMeta;
  conv: Converter;
  keyConv: Converter;
  src: number;
}

const TEXT_KEY_TYPES = new Set(['TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'JSON']);

/** Rough maximum row size in bytes (utf8mb4) for the 65 535 byte limit */
function fieldBytes(f: FieldDef): number {
  const t = f.type.toUpperCase();
  const len = Number(f.length) || 0;
  if (t === 'VARCHAR') return (len || 255) * 4 + 2;
  if (t === 'CHAR') return (len || 1) * 4;
  if (t === 'VARBINARY') return (len || 255) + 2;
  if (t === 'BINARY') return len || 1;
  if (t === 'DECIMAL') return Math.ceil((len || 10) / 2) + 1;
  if (t === 'BIGINT' || t === 'DOUBLE' || t === 'DATETIME') return 8;
  if (t === 'INT' || t === 'FLOAT' || t === 'TIMESTAMP') return 4;
  if (t === 'DATE' || t === 'MEDIUMINT') return 3;
  if (t === 'TIME') return 6;
  if (t === 'SMALLINT') return 2;
  if (t === 'TINYINT' || t === 'YEAR') return 1;
  return 12;
}

function buildNewTable(db: string, spec: ImportSourceSpec, t: TaskContext): string {
  const maps = spec.fields.filter((f) => f.target);
  const design = newTableDesign(db);
  design.name = spec.table.trim();
  design.fields = maps.map((m) => {
    let type = (m.type || 'VARCHAR').toUpperCase();
    let length = m.length ?? '';
    if (m.key && TEXT_KEY_TYPES.has(type)) {
      t.log('info', tr('Schlüsselfeld „{f}“: {t} wird als VARCHAR(255) angelegt.', 'Key field "{f}": {t} is created as VARCHAR(255).', { f: m.target, t: type }));
      type = 'VARCHAR';
      length = '255';
    }
    if (type === 'VARCHAR' && !length) length = '255';
    return newField({ name: m.target, type, length, decimals: m.decimals ?? '', notNull: m.key });
  });
  design.primaryKey = maps.filter((m) => m.key).map((m) => m.target);
  // keep the row size below the InnoDB limit: widest VARCHAR columns become TEXT
  let total = design.fields.reduce((a, f) => a + fieldBytes(f), 0);
  const candidates = design.fields.filter((f) => f.type === 'VARCHAR' && !design.primaryKey.includes(f.name)).sort((a, b) => fieldBytes(b) - fieldBytes(a));
  for (const f of candidates) {
    if (total <= 65000) break;
    total -= fieldBytes(f) - 12;
    f.type = 'TEXT';
    f.length = '';
  }
  return createTableSql(design, { qualified: true, triggers: false })[0];
}

function parseInsertInfo(ok: RawOk, rows: number): { ins: number; dup: number } {
  const m = /Records:\s*(\d+)\s+Duplicates:\s*(\d+)/i.exec(ok.info);
  if (m) {
    const dup = Number(m[2]);
    return { ins: Number(m[1]) - dup, dup };
  }
  if (rows === 1) return ok.affectedRows === 1 ? { ins: 1, dup: 0 } : { ins: 0, dup: 1 };
  return { ins: ok.affectedRows, dup: 0 };
}

function matchedRows(ok: RawOk): number {
  const m = /Rows matched:\s*(\d+)/i.exec(ok.info);
  return m ? Number(m[1]) : ok.affectedRows;
}

/** Errors that make continuing pointless (connection gone, transaction rolled back by the server) */
function isAbortError(e: unknown, inTx: boolean): boolean {
  const errno = (e as { errno?: number })?.errno;
  return isFatalConnectionError(e) || (inTx && (errno === 1213 || errno === 1205));
}

class SourceImport {
  private errorsLogged = 0;

  constructor(
    private readonly s: Session,
    private readonly p: ImportProfile,
    private readonly spec: ImportSourceSpec,
    private readonly t: TaskContext,
    private readonly stats: Stats,
    private readonly inTx: boolean,
    private readonly maxBytes: number,
    private readonly progress: (reader: SourceReader) => void
  ) {}

  private logError(rowNo: number | null, msg: string): void {
    this.stats.errors++;
    if (this.errorsLogged < MAX_ERROR_LOG) {
      this.t.log('error', rowNo !== null ? tr('Datensatz {n}: {m}', 'Record {n}: {m}', { n: rowNo, m: msg }) : msg);
    } else if (this.errorsLogged === MAX_ERROR_LOG) {
      this.t.log('warn', tr('Weitere Fehler werden nicht mehr einzeln protokolliert.', 'Further errors are not logged individually.'));
    }
    this.errorsLogged++;
  }

  /** Handles an error of one record: logs it, or aborts when errors must not be skipped */
  private recordError(rowNo: number, e: unknown): void {
    if (isAbortError(e, this.inTx)) throw e;
    const msg = e instanceof ConversionError ? e.message : toSqlError(e).message;
    if (!this.p.advanced.continueOnError) {
      throw new KsError(tr('Datensatz {n} ({s}): {m}', 'Record {n} ({s}): {m}', { n: rowNo, s: sourceLabel(this.spec), m: msg }));
    }
    this.logError(rowNo, msg);
  }

  async run(): Promise<void> {
    const { s, p, spec, t } = this;
    const db = p.database;
    const table = spec.table.trim();
    const tbl = qname(db, table);
    const cols = await loadColumns(s, db, table);
    if (!cols.length) throw new KsError(tr('Die Tabelle „{t}“ wurde nicht gefunden.', 'Table "{t}" was not found.', { t: table }));
    const byName = new Map(cols.map((c) => [c.name.toLowerCase(), c]));
    const used = new Set<string>();
    const targets: Target[] = [];
    for (const m of spec.fields) {
      if (!m.target) continue;
      const col = byName.get(m.target.toLowerCase());
      if (!col) throw new KsError(tr('Das Feld „{f}“ existiert nicht in der Tabelle „{t}“.', 'Field "{f}" does not exist in table "{t}".', { f: m.target, t: table }));
      if (col.generationExpression || /(VIRTUAL|STORED) GENERATED/i.test(col.extra)) {
        t.log('warn', tr('„{f}“ ist ein berechnetes Feld und wird übersprungen.', '"{f}" is a generated column and is skipped.', { f: col.name }));
        continue;
      }
      if (used.has(col.name.toLowerCase())) throw new KsError(tr('Das Zielfeld „{f}“ ist mehrfach zugeordnet.', 'Target field "{f}" is mapped more than once.', { f: col.name }));
      used.add(col.name.toLowerCase());
      targets.push({
        map: m,
        col,
        conv: makeConverter(col, p.options, p.format, s.server),
        keyConv: makeConverter(col, p.options, p.format, s.server, true),
        src: -1
      });
    }
    const mode = p.mode;
    const keys = targets.filter((x) => x.map.key);
    const others = targets.filter((x) => !x.map.key);
    if (KEY_MODES.has(mode) && !keys.length) {
      throw new KsError(
        tr('Der Modus „{m}“ benötigt mindestens ein Schlüsselfeld (Quelle „{s}“).', 'Mode "{m}" needs at least one key field (source "{s}").', { m: modeLabel(mode), s: sourceLabel(spec) })
      );
    }
    if (mode === 'update' && !others.length) {
      throw new KsError(tr('Es sind keine Felder zum Aktualisieren zugeordnet (nur Schlüsselfelder).', 'No fields to update are mapped (only key fields).'));
    }
    let uniqueKey = false;
    if (mode === 'appendUpdate' || mode === 'appendNoUpdate') {
      const idx = await s.rows<{ idx: string; col: string | null }>(
        `SELECT INDEX_NAME AS idx, COLUMN_NAME AS col FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0 ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [db, table]
      );
      const sets = new Map<string, string[]>();
      for (const r of idx) {
        if (!sets.has(r.idx)) sets.set(r.idx, []);
        sets.get(r.idx)!.push(r.col === null ? '\0' : String(r.col).toLowerCase());
      }
      const want = keys.map((k) => k.col.name.toLowerCase()).sort().join('\n');
      uniqueKey = [...sets.values()].some((c) => c.slice().sort().join('\n') === want);
    }

    const reader = await openSource(p.format, spec.file, spec.sheet, p.encoding, p.options);
    t.log('info', tr('Importiere {s} → {t} ({m})', 'Importing {s} → {t} ({m})', { s: sourceLabel(spec), t: table, m: modeLabel(mode) }));

    if (mode === 'copy') {
      const ok = await s.exec(`DELETE FROM ${tbl}`);
      this.stats.deleted += ok.affectedRows;
      t.log('info', tr('{n} vorhandene Datensätze gelöscht.', '{n} existing records deleted.', { n: formatNumber(ok.affectedRows) }));
    }

    const colList = targets.map((x) => quoteId(x.col.name)).join(', ');
    const insertHead = `INSERT INTO ${tbl} (${colList}) VALUES `;
    let insertTail = '';
    const alias = s.server.type === 'mysql' && s.server.versionNumber >= 80019;
    if (uniqueKey && mode === 'appendUpdate') {
      const upd = others.length ? others : keys;
      insertTail = alias
        ? ` AS ks_new ON DUPLICATE KEY UPDATE ${upd.map((x) => `${quoteId(x.col.name)} = ks_new.${quoteId(x.col.name)}`).join(', ')}`
        : ` ON DUPLICATE KEY UPDATE ${upd.map((x) => `${quoteId(x.col.name)} = VALUES(${quoteId(x.col.name)})`).join(', ')}`;
    } else if (uniqueKey && mode === 'appendNoUpdate') {
      const k = quoteId(keys[0].col.name);
      insertTail = ` ON DUPLICATE KEY UPDATE ${k} = ${k}`;
    }
    const batchedInsert = mode === 'append' || mode === 'copy' || uniqueKey;
    const rowsPer = Math.max(1, Math.floor(p.advanced.rowsPerStatement) || 1);
    const whereKey = (vals: string[]) => keys.map((k, i) => `${quoteId(k.col.name)} <=> ${vals[i]}`).join(' AND ');

    let batch: string[] = [];
    let batchRows: number[] = [];
    let batchLen = 0;

    const countInsert = (ok: RawOk, rows: number) => {
      const r = parseInsertInfo(ok, rows);
      if (mode === 'appendUpdate') {
        this.stats.inserted += r.ins;
        this.stats.updated += r.dup;
      } else if (mode === 'appendNoUpdate') {
        // "ON DUPLICATE KEY UPDATE k = k" changes nothing: affected rows = inserted rows
        this.stats.inserted += ok.affectedRows;
        this.stats.skipped += rows - ok.affectedRows;
      } else this.stats.inserted += ok.affectedRows;
    };

    const flushInsert = async () => {
      if (!batch.length) return;
      const rows = batch;
      const nums = batchRows;
      batch = [];
      batchRows = [];
      batchLen = 0;
      try {
        countInsert(await s.exec(insertHead + rows.join(',\n') + insertTail), rows.length);
      } catch (e) {
        if (rows.length === 1) {
          this.recordError(nums[0], e);
          return;
        }
        if (isAbortError(e, this.inTx)) throw e;
        // find the failing records: one statement per record
        for (let i = 0; i < rows.length; i++) {
          try {
            countInsert(await s.exec(insertHead + rows[i] + insertTail), 1);
          } catch (e2) {
            this.recordError(nums[i], e2);
          }
        }
      }
    };

    const deleteChunk = async (rows: string[][], nums: number[]) => {
      let where: string;
      if (keys.length === 1) {
        const col = quoteId(keys[0].col.name);
        const vals = rows.map((r) => r[0]);
        const nonNull = vals.filter((v) => v !== 'NULL');
        const parts: string[] = [];
        if (nonNull.length) parts.push(`${col} IN (${nonNull.join(', ')})`);
        if (nonNull.length < vals.length) parts.push(`${col} IS NULL`);
        where = parts.join(' OR ');
      } else where = rows.map((r) => `(${whereKey(r)})`).join(' OR ');
      try {
        this.stats.deleted += (await s.exec(`DELETE FROM ${tbl} WHERE ${where}`)).affectedRows;
      } catch (e) {
        if (rows.length === 1 || isAbortError(e, this.inTx)) {
          this.recordError(nums[0], e);
          return;
        }
        for (let i = 0; i < rows.length; i++) {
          try {
            this.stats.deleted += (await s.exec(`DELETE FROM ${tbl} WHERE ${whereKey(rows[i])}`)).affectedRows;
          } catch (e2) {
            this.recordError(nums[i], e2);
          }
        }
      }
    };
    let delRows: string[][] = [];
    let delNums: number[] = [];
    let delLen = 0;
    const flushDelete = async () => {
      if (!delRows.length) return;
      const rows = delRows;
      const nums = delNums;
      delRows = [];
      delNums = [];
      delLen = 0;
      await deleteChunk(rows, nums);
    };

    const resolveFields = () => {
      for (const x of targets) {
        if (x.src >= 0) continue;
        let i = reader.fields.indexOf(x.map.source);
        if (i < 0) {
          const low = x.map.source.toLowerCase();
          i = reader.fields.findIndex((f) => f.toLowerCase() === low);
        }
        x.src = i;
      }
    };
    const value = (x: Target, vals: SourceValue[]) => (x.src >= 0 ? vals[x.src] : undefined);

    for await (const recs of reader.records()) {
      t.throwIfCancelled();
      resolveFields();
      for (const rec of recs) {
        this.stats.read++;
        if (rec.error) {
          this.recordError(rec.rowNo, new ConversionError(rec.error));
          continue;
        }
        try {
          if (mode === 'delete') {
            const kv = keys.map((k) => k.keyConv(value(k, rec.values)));
            delRows.push(kv);
            delNums.push(rec.rowNo);
            delLen += kv.reduce((a, v) => a + v.length + 12, 0);
            if (delRows.length >= Math.min(rowsPer, 1000) || delLen >= this.maxBytes) await flushDelete();
            continue;
          }
          if (batchedInsert) {
            const row = `(${targets.map((x) => x.conv(value(x, rec.values))).join(', ')})`;
            if (batch.length && (batch.length >= rowsPer || batchLen + row.length + insertHead.length + insertTail.length > this.maxBytes)) await flushInsert();
            batch.push(row);
            batchRows.push(rec.rowNo);
            batchLen += row.length + 2;
            continue;
          }
          // record by record: update / append-update / append-no-update without a unique key
          const kv = keys.map((k) => k.keyConv(value(k, rec.values)));
          if (mode === 'update' || mode === 'appendUpdate') {
            const set = (others.length ? others : keys).map((x) => `${quoteId(x.col.name)} = ${x.conv(value(x, rec.values))}`).join(', ');
            const ok = await s.exec(`UPDATE ${tbl} SET ${set} WHERE ${whereKey(kv)}`);
            const matched = matchedRows(ok);
            if (matched > 0) {
              this.stats.updated += matched;
              continue;
            }
            if (mode === 'update') {
              this.stats.skipped++;
              continue;
            }
          } else {
            const exists = await s.rowset(`SELECT 1 FROM ${tbl} WHERE ${whereKey(kv)} LIMIT 1`);
            if (exists.rows.length) {
              this.stats.skipped++;
              continue;
            }
          }
          const ok = await s.exec(`${insertHead}(${targets.map((x) => x.conv(value(x, rec.values))).join(', ')})`);
          this.stats.inserted += ok.affectedRows;
        } catch (e) {
          this.recordError(rec.rowNo, e);
        }
      }
      this.progress(reader);
    }
    await flushInsert();
    await flushDelete();
    this.progress(reader);
  }
}

export async function runImport(ctx: BackendContext, profile: ImportProfile, t: TaskContext): Promise<ImportResult> {
  const p = normalizeImportProfile(profile);
  const stats: Stats = { read: 0, inserted: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };
  const created: string[] = [];
  const s = await ctx.sessions.open(p.connectionId, p.database);
  let inTx = false;
  try {
    if (p.advanced.disableFkChecks) await s.exec('SET FOREIGN_KEY_CHECKS = 0');
    const packet = Number((await s.rowset('SELECT @@max_allowed_packet')).rows[0]?.[0] ?? 0) || 16 * 1024 * 1024;
    const maxBytes = Math.max(16 * 1024, Math.min((p.advanced.maxStatementKB || 1024) * 1024, packet - 4096));

    // new tables are created before the transaction starts (DDL commits implicitly)
    for (const spec of p.sources) {
      if (!spec.newTable) continue;
      const name = spec.table.trim();
      const exists = await s.rows('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [p.database, name]);
      if (exists.length) {
        t.log('warn', tr('Die Tabelle „{t}“ existiert bereits – die Daten werden in die vorhandene Tabelle importiert.', 'Table "{t}" already exists – the data is imported into the existing table.', { t: name }));
        continue;
      }
      const sql = buildNewTable(p.database, spec, t);
      await s.exec(sql);
      created.push(name);
      t.log('info', tr('Tabelle „{t}“ angelegt.', 'Table "{t}" created.', { t: name }));
    }

    if (p.advanced.transaction) {
      await s.exec('START TRANSACTION');
      inTx = true;
    }
    let totalBytes = 0;
    for (const spec of p.sources) totalBytes += await import('./files').then((m) => m.fileSize(spec.file)).catch(() => 0);
    let doneBytes = 0;
    for (const spec of p.sources) {
      t.throwIfCancelled();
      const before = stats.errors;
      const counted = { bytes: 0 };
      const job = new SourceImport(s, p, spec, t, stats, inTx, maxBytes, (reader) => {
        counted.bytes = reader.bytesRead();
        const frac = totalBytes > 0 ? Math.min(1, (doneBytes + counted.bytes) / totalBytes) : null;
        t.progress(frac, tr('{n} Datensätze gelesen · {s}', '{n} records read · {s}', { n: formatNumber(stats.read), s: sourceLabel(spec) }));
      });
      try {
        await job.run();
      } catch (e) {
        if (!p.advanced.continueOnError || isAbortError(e, inTx) || (e as Error)?.name === 'CancelledError') throw e;
        stats.errors++;
        t.log('error', `${sourceLabel(spec)}: ${toSqlError(e).message}`);
      }
      doneBytes += counted.bytes;
      if (stats.errors > before) t.log('warn', tr('{n} Fehler in „{s}“.', '{n} errors in "{s}".', { n: stats.errors - before, s: sourceLabel(spec) }));
    }
    if (inTx) {
      await s.exec('COMMIT');
      inTx = false;
    }
    t.log(
      stats.errors ? 'warn' : 'success',
      tr(
        'Import beendet: {r} gelesen, {i} eingefügt, {u} aktualisiert, {d} gelöscht, {k} übersprungen, {e} Fehler.',
        'Import finished: {r} read, {i} inserted, {u} updated, {d} deleted, {k} skipped, {e} errors.',
        {
          r: formatNumber(stats.read),
          i: formatNumber(stats.inserted),
          u: formatNumber(stats.updated),
          d: formatNumber(stats.deleted),
          k: formatNumber(stats.skipped),
          e: formatNumber(stats.errors)
        }
      )
    );
    return { sources: p.sources.length, ...stats, createdTables: created };
  } catch (e) {
    if (inTx) {
      await s.exec('ROLLBACK').catch(() => undefined);
      t.log('warn', tr('Die Transaktion wurde zurückgesetzt.', 'The transaction was rolled back.'));
    }
    throw e;
  } finally {
    await ctx.sessions.close(s.id);
  }
}

// Data synchronization: compares the rows of mapped tables (source vs target) by a key and deploys
// DELETE / UPDATE / INSERT statements that make the target equal to the source.
//
// Comparison: both tables are read in chunks inside consistent snapshots. Keys whose server order can
// be reproduced exactly (numbers, temporal values, binary strings) are compared with a streaming merge;
// other keys (strings, enums …) with a hash join on collation-normalized key values. Only the keys of
// differing rows are kept in memory; row values are fetched again for the detail view and deployment.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import iconv from 'iconv-lite';
import type {
  DataCompareResult,
  DataCompareTable,
  DataDiffKind,
  DataDiffPage,
  DataSyncDeployResult,
  DataSyncDeployTableResult,
  DataSyncMapping,
  DataSyncOptions,
  DataSyncPrepareResult,
  DataSyncProfile,
  DataSyncScriptResult,
  DataSyncTableSelection,
  DsColumn,
  DsTable,
  SyncEndpoint
} from '@shared/apis/sync';
import type { CellValue, ColumnMeta } from '@shared/types';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { qname, quoteId, quoteString } from '@shared/sql/quote';
import { normalizeDataSyncOptions, normalizeDataSyncProfile } from '@shared/sync/defaults';
import { fileEncoding } from '@shared/sync/encodings';
import {
  canonicalValue,
  compareMergeKeys,
  keyPartNormalizer,
  keyString,
  mergeClass,
  sqlLiteral,
  toCellValue,
  valueClass,
  valuesEqual,
  type MergeClass,
  type ValueClass
} from '@shared/sync/values';
import { formatDateTime, formatDuration, formatNumber } from '@shared/util';
import type { BackendContext } from '../../api';
import { KsError } from '../../errors';
import { str, tables } from '../../db/meta';
import type { Session } from '../../db/sessions';
import { CancelledError, type TaskContext } from '../../tasks';
import {
  buildInserts,
  closeSyncSession,
  errorText,
  fkParents,
  isGeneratedColumn,
  nameLookup,
  openSyncSession,
  pagingKey,
  readRows,
  tableColumns,
  topoSort,
  uniqueKeys,
  type KeyDef,
  type SyncSession
} from './common';

type Row = Record<string, unknown>;
type KeyTuple = CellValue[];

interface TableState {
  info: DataCompareTable;
  srcTable: string;
  tgtTable: string;
  srcCols: ColumnMeta[];
  tgtCols: ColumnMeta[];
  srcCls: ValueClass[];
  tgtCls: ValueClass[];
  keyIdx: number[];
  /** Key normalizers (target collation) used to match rows */
  norms: ((v: unknown) => string)[];
  inserts: KeyTuple[];
  deletes: KeyTuple[];
  updates: { src: KeyTuple; tgt: KeyTuple }[];
}

interface CompareEntry {
  id: string;
  source: SyncEndpoint;
  target: SyncEndpoint;
  tables: TableState[];
}

const compares = new Map<string, CompareEntry>();
const FETCH = 5000;
const KEY_BATCH = 400;

function entryOf(id: string): CompareEntry {
  const e = compares.get(id);
  if (!e) throw new KsError(tr('Das Vergleichsergebnis ist nicht mehr verfügbar – bitte erneut vergleichen.', 'The comparison result is no longer available – please compare again.'));
  return e;
}

export function releaseCompare(id: string): void {
  compares.delete(id);
}

function validateEndpoints(source: SyncEndpoint, target: SyncEndpoint): void {
  if (!source.connectionId || !source.database) throw new KsError(tr('Bitte Quellverbindung und -datenbank wählen.', 'Please choose the source connection and database.'));
  if (!target.connectionId || !target.database) throw new KsError(tr('Bitte Zielverbindung und -datenbank wählen.', 'Please choose the target connection and database.'));
  if (source.connectionId === target.connectionId && source.database.toLowerCase() === target.database.toLowerCase()) {
    throw new KsError(tr('Quelle und Ziel dürfen nicht dieselbe Datenbank sein.', 'Source and target must not be the same database.'));
  }
}

// ───────────────────────── prepare ─────────────────────────

async function describeSchema(s: Session, db: string): Promise<DsTable[]> {
  const tbl = (await tables(s, db)).filter((t) => t.type === 'BASE TABLE');
  const rows = await s.rows<Row>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS n, DATA_TYPE AS d, COLUMN_TYPE AS ct, IS_NULLABLE AS nl, EXTRA AS x, GENERATION_EXPRESSION AS g
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [db]
  );
  const keys = await uniqueKeys(s, db);
  const cols = new Map<string, DsColumn[]>();
  for (const r of rows) {
    const t = str(r.t);
    if (!cols.has(t)) cols.set(t, []);
    cols.get(t)!.push({
      name: str(r.n),
      dataType: str(r.d).toLowerCase(),
      columnType: str(r.ct),
      nullable: str(r.nl) === 'YES',
      generated: !!str(r.g) || /\b(VIRTUAL|STORED|PERSISTENT)\s+GENERATED\b/i.test(str(r.x))
    });
  }
  return tbl.map((t) => {
    const k = keys.get(t.name) ?? [];
    return {
      name: t.name,
      rows: t.rows,
      columns: cols.get(t.name) ?? [],
      primaryKey: k.find((x) => x.name === 'PRIMARY')?.columns ?? [],
      uniqueKeys: k.filter((x) => x.name !== 'PRIMARY' && x.columns.length).map((x) => ({ name: x.name, columns: x.columns, nullable: x.nullable }))
    };
  });
}

export async function prepareDataSync(ctx: BackendContext, source: SyncEndpoint, target: SyncEndpoint): Promise<DataSyncPrepareResult> {
  validateEndpoints(source, target);
  const out: DataSyncPrepareResult = { source: [], target: [] };
  for (const side of ['source', 'target'] as const) {
    const ep = side === 'source' ? source : target;
    const ss = await openSyncSession(ctx, ep.connectionId, ep.database, 'read');
    try {
      out[side] = await describeSchema(ss.s, ep.database);
    } finally {
      await closeSyncSession(ctx, ss);
    }
  }
  return out;
}

// ───────────────────────── compare ─────────────────────────

interface Resolved {
  srcCols: ColumnMeta[];
  tgtCols: ColumnMeta[];
  keyIdx: number[];
}

function resolveMapping(m: DataSyncMapping, srcAll: ColumnMeta[], tgtAll: ColumnMeta[], srcKeys: KeyDef[]): Resolved {
  const writable = tgtAll.filter((c) => !isGeneratedColumn(c));
  const tFind = nameLookup(writable.map((c) => c.name));
  const tByName = new Map(writable.map((c) => [c.name, c]));
  const sFind = nameLookup(srcAll.map((c) => c.name));
  const sByName = new Map(srcAll.map((c) => [c.name, c]));
  const mapCol = (name: string): ColumnMeta | undefined => {
    const t = tFind(m.columnMap[name] ?? name);
    return t ? tByName.get(t) : undefined;
  };
  let key: string[] = [];
  for (const k of m.key) {
    const n = sFind(k);
    if (!n) throw new KsError(tr('Schlüsselfeld „{c}“ existiert in der Quelltabelle nicht.', 'Key field "{c}" does not exist in the source table.', { c: k }));
    key.push(n);
  }
  if (!key.length) key = srcKeys.find((k) => k.name === 'PRIMARY')?.columns ?? srcKeys.find((k) => !k.nullable && k.columns.length)?.columns ?? [];
  if (!key.length) {
    throw new KsError(tr('Die Tabelle hat keinen Primärschlüssel – bitte Schlüsselfelder festlegen.', 'The table has no primary key – please choose key fields.'));
  }
  const wanted = new Set<string>(key);
  if (m.columns.length) {
    for (const c of m.columns) {
      const n = sFind(c);
      if (n && !isGeneratedColumn(sByName.get(n)!)) wanted.add(n);
    }
  } else {
    for (const c of srcAll) if (!isGeneratedColumn(c) && mapCol(c.name)) wanted.add(c.name);
  }
  const srcCols: ColumnMeta[] = [];
  const tgtCols: ColumnMeta[] = [];
  for (const c of srcAll) {
    if (!wanted.has(c.name)) continue;
    const t = mapCol(c.name);
    if (!t) {
      if (key.includes(c.name)) throw new KsError(tr('Schlüsselfeld „{c}“ fehlt in der Zieltabelle.', 'Key field "{c}" is missing in the target table.', { c: c.name }));
      if (m.columns.length) throw new KsError(tr('Feld „{c}“ fehlt in der Zieltabelle.', 'Field "{c}" is missing in the target table.', { c: c.name }));
      continue;
    }
    srcCols.push(c);
    tgtCols.push(t);
  }
  const keyIdx = key.map((k) => srcCols.findIndex((c) => c.name === k));
  return { srcCols, tgtCols, keyIdx };
}

const isUniqueOn = (keys: KeyDef[], cols: string[]) =>
  keys.some((k) => !k.nullable && k.columns.length === cols.length && k.columns.every((c) => cols.some((x) => x.toLowerCase() === c.toLowerCase())));

/** Streams chunks of a generator with read-ahead */
class Cursor {
  private rows: unknown[][] = [];
  private i = 0;
  private pending: Promise<IteratorResult<unknown[][]>> | null;

  constructor(private readonly gen: AsyncGenerator<unknown[][]>) {
    this.pending = gen.next();
  }

  async current(): Promise<unknown[] | null> {
    while (this.i >= this.rows.length) {
      if (!this.pending) return null;
      const r = await this.pending;
      if (r.done) {
        this.pending = null;
        return null;
      }
      this.rows = r.value;
      this.i = 0;
      this.pending = this.gen.next();
    }
    return this.rows[this.i];
  }

  advance(): void {
    this.i++;
  }

  async close(): Promise<void> {
    this.pending?.catch(() => undefined);
    this.pending = null;
    await this.gen.return(undefined).catch(() => undefined);
  }
}

function fingerprint(row: unknown[], n: number, cls: ValueClass[]): string {
  const h = crypto.createHash('sha1');
  for (let i = 0; i < n; i++) {
    const c = canonicalValue(row[i], cls[i]);
    h.update(c === null ? ' N' : `S${c}`);
    h.update('');
  }
  return h.digest('base64');
}

const normKey = (vals: unknown[], norms: ((v: unknown) => string)[]) => vals.map((v, j) => norms[j](v)).join('');

async function compareTable(
  src: Session,
  tgt: Session,
  ep: { source: SyncEndpoint; target: SyncEndpoint },
  st: TableState,
  srcAll: ColumnMeta[],
  tgtAll: ColumnMeta[],
  srcKeys: KeyDef[],
  tgtKeys: KeyDef[],
  t: TaskContext,
  onRows: (n: number) => void
): Promise<void> {
  const { keyIdx, srcCols, tgtCols } = st;
  const n = srcCols.length;
  const srcKeyNames = keyIdx.map((i) => srcCols[i].name);
  const tgtKeyNames = keyIdx.map((i) => tgtCols[i].name);
  const sClasses = keyIdx.map((i) => mergeClass(srcCols[i].dataType));
  const tClasses = keyIdx.map((i) => mergeClass(tgtCols[i].dataType));
  const merge =
    sClasses.every((c, j) => c !== null && c === tClasses[j] && (c !== 'bin' || srcCols[keyIdx[j]].columnType === tgtCols[keyIdx[j]].columnType)) &&
    isUniqueOn(srcKeys, srcKeyNames) &&
    isUniqueOn(tgtKeys, tgtKeyNames);
  st.info.method = merge ? 'merge' : 'hash';
  const tuple = (row: unknown[]) => keyIdx.map((i) => toCellValue(row[i]));
  let seen = 0;
  const tick = (k: number) => {
    seen += k;
    if (seen >= 2000) {
      onRows(seen);
      seen = 0;
      t.throwIfCancelled();
    }
  };

  if (merge) {
    const classes = sClasses as MergeClass[];
    const sc = new Cursor(readRows(src, { schema: ep.source.database, table: st.srcTable, columns: srcCols.map((c) => c.name), meta: srcCols, key: srcKeyNames, fetchSize: FETCH }));
    const tc = new Cursor(readRows(tgt, { schema: ep.target.database, table: st.tgtTable, columns: tgtCols.map((c) => c.name), meta: tgtCols, key: tgtKeyNames, fetchSize: FETCH }));
    try {
      for (;;) {
        const a = await sc.current();
        const b = await tc.current();
        if (!a && !b) break;
        const c = !a ? 1 : !b ? -1 : compareMergeKeys(keyIdx.map((i) => a[i]), keyIdx.map((i) => b[i]), classes);
        if (c < 0) {
          st.inserts.push(tuple(a!));
          sc.advance();
          tick(1);
        } else if (c > 0) {
          st.deletes.push(tuple(b!));
          tc.advance();
          tick(1);
        } else {
          let same = true;
          for (let i = 0; i < n && same; i++) same = valuesEqual(a![i], b![i], st.srcCls[i], st.tgtCls[i]);
          if (same) st.info.identical++;
          else st.updates.push({ src: tuple(a!), tgt: tuple(b!) });
          sc.advance();
          tc.advance();
          tick(2);
        }
      }
    } finally {
      await sc.close();
      await tc.close();
    }
  } else {
    const map = new Map<string, { key: KeyTuple; fp: string }>();
    const read = async (s: Session, db: string, table: string, cols: ColumnMeta[], all: ColumnMeta[], keys: KeyDef[], fn: (row: unknown[]) => void) => {
      const select = [...cols];
      const page = pagingKey(all, keys);
      for (const k of page ?? []) if (!select.some((c) => c.name === k)) select.push(all.find((c) => c.name === k)!);
      for await (const rows of readRows(s, { schema: db, table, columns: select.map((c) => c.name), meta: select, key: page, fetchSize: FETCH })) {
        for (const row of rows) fn(row);
        tick(rows.length);
      }
    };
    await read(src, ep.source.database, st.srcTable, srcCols, srcAll, srcKeys, (row) => {
      const k = normKey(keyIdx.map((i) => row[i]), st.norms);
      if (map.has(k)) {
        throw new KsError(tr('Der Schlüssel ist in der Quelltabelle nicht eindeutig ({v}).', 'The key is not unique in the source table ({v}).', { v: keyString(tuple(row)) }));
      }
      map.set(k, { key: tuple(row), fp: fingerprint(row, n, st.srcCls) });
    });
    await read(tgt, ep.target.database, st.tgtTable, tgtCols, tgtAll, tgtKeys, (row) => {
      const k = normKey(keyIdx.map((i) => row[i]), st.norms);
      const e = map.get(k);
      if (!e) {
        st.deletes.push(tuple(row));
        return;
      }
      map.delete(k);
      if (e.fp === fingerprint(row, n, st.tgtCls)) st.info.identical++;
      else st.updates.push({ src: e.key, tgt: tuple(row) });
    });
    for (const e of map.values()) st.inserts.push(e.key);
  }
  onRows(seen);
  st.info.onlySource = st.inserts.length;
  st.info.onlyTarget = st.deletes.length;
  st.info.different = st.updates.length;
}

async function compareAll(ctx: BackendContext, p: DataSyncProfile, t: TaskContext, prog: (f: number, msg: string) => void): Promise<CompareEntry> {
  validateEndpoints(p.source, p.target);
  const entry: CompareEntry = { id: newId('dc'), source: p.source, target: p.target, tables: [] };
  let src: SyncSession | null = null;
  let tgt: SyncSession | null = null;
  try {
    src = await openSyncSession(ctx, p.source.connectionId, p.source.database, 'read');
    tgt = await openSyncSession(ctx, p.target.connectionId, p.target.database, 'read');
    const sTables = (await tables(src.s, p.source.database)).filter((x) => x.type === 'BASE TABLE');
    const tTables = (await tables(tgt.s, p.target.database)).filter((x) => x.type === 'BASE TABLE');
    const sFind = nameLookup(sTables.map((x) => x.name));
    const tFind = nameLookup(tTables.map((x) => x.name));
    const mappings: DataSyncMapping[] = [];
    const used = new Set<string>();
    for (const m of p.mappings) {
      const s = sFind(m.source);
      if (!s) {
        t.log('warn', tr('Quelltabelle „{t}“ existiert nicht und wird übersprungen.', 'Source table "{t}" does not exist and is skipped.', { t: m.source }));
        continue;
      }
      if (used.has(s)) continue;
      used.add(s);
      mappings.push({ ...m, source: s });
    }
    if (p.autoMap) {
      const excluded = new Set(p.excluded.map((x) => x.toLowerCase()));
      for (const x of sTables) {
        if (used.has(x.name) || excluded.has(x.name.toLowerCase()) || !tFind(x.name)) continue;
        mappings.push({ source: x.name, target: x.name, key: [], columns: [], columnMap: {} });
      }
    }
    if (!mappings.length) throw new KsError(tr('Keine Tabellen zum Vergleichen ausgewählt.', 'No tables selected for comparison.'));
    const sKeys = await uniqueKeys(src.s, p.source.database);
    const tKeys = await uniqueKeys(tgt.s, p.target.database);
    const estimate = (name: string, list: typeof sTables) => list.find((x) => x.name === name)?.rows ?? 0;
    let total = 0;
    for (const m of mappings) total += estimate(m.source, sTables) + estimate(tFind(m.target) ?? '', tTables);
    total = Math.max(1, total);
    let done = 0;
    await src.s.exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    await tgt.s.exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    for (let i = 0; i < mappings.length; i++) {
      const m = mappings[i];
      t.throwIfCancelled();
      const info: DataCompareTable = {
        index: i,
        source: m.source,
        target: tFind(m.target) ?? m.target,
        key: [],
        columns: [],
        targetColumns: [],
        onlySource: 0,
        onlyTarget: 0,
        different: 0,
        identical: 0,
        method: 'merge',
        error: null,
        durationMs: 0
      };
      const st: TableState = {
        info,
        srcTable: m.source,
        tgtTable: info.target,
        srcCols: [],
        tgtCols: [],
        srcCls: [],
        tgtCls: [],
        keyIdx: [],
        norms: [],
        inserts: [],
        deletes: [],
        updates: []
      };
      entry.tables.push(st);
      const t0 = Date.now();
      prog(done / total, tr('Vergleiche {t} …', 'Comparing {t} …', { t: m.source }));
      try {
        const tgtName = tFind(m.target);
        if (!tgtName) throw new KsError(tr('Die Zieltabelle „{t}“ existiert nicht.', 'The target table "{t}" does not exist.', { t: m.target }));
        const srcAll = await tableColumns(src.s, p.source.database, m.source);
        const tgtAll = await tableColumns(tgt.s, p.target.database, tgtName);
        const r = resolveMapping(m, srcAll, tgtAll, sKeys.get(m.source) ?? []);
        Object.assign(st, r);
        st.srcCls = r.srcCols.map((c) => valueClass(c.dataType));
        st.tgtCls = r.tgtCols.map((c) => valueClass(c.dataType));
        st.norms = r.keyIdx.map((k) => keyPartNormalizer(r.tgtCols[k].dataType, r.tgtCols[k].collation));
        info.key = r.keyIdx.map((k) => r.srcCols[k].name);
        info.columns = r.srcCols.map((c) => c.name);
        info.targetColumns = r.tgtCols.map((c) => c.name);
        await compareTable(src.s, tgt.s, p, st, srcAll, tgtAll, sKeys.get(m.source) ?? [], tKeys.get(tgtName) ?? [], t, (k) => {
          done += k;
          prog(Math.min(0.999, done / total), `${m.source}: ${formatNumber(done)}`);
        });
        t.log(
          'info',
          tr('{t}: {i} nur in Quelle, {u} verschieden, {d} nur im Ziel, {s} identisch', '{t}: {i} only in source, {u} different, {d} only in target, {s} identical', {
            t: m.source,
            i: formatNumber(info.onlySource),
            u: formatNumber(info.different),
            d: formatNumber(info.onlyTarget),
            s: formatNumber(info.identical)
          })
        );
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        st.inserts = [];
        st.deletes = [];
        st.updates = [];
        info.onlySource = info.onlyTarget = info.different = info.identical = 0;
        info.error = errorText(e);
        t.log('error', `${m.source}: ${info.error}`);
      }
      info.durationMs = Date.now() - t0;
    }
  } finally {
    await closeSyncSession(ctx, src);
    await closeSyncSession(ctx, tgt);
  }
  compares.set(entry.id, entry);
  while (compares.size > 6) compares.delete(compares.keys().next().value as string);
  return entry;
}

function compareResult(e: CompareEntry, durationMs: number): DataCompareResult {
  return { compareId: e.id, source: e.source, target: e.target, tables: e.tables.map((x) => x.info), durationMs };
}

export function startDataCompare(ctx: BackendContext, input: DataSyncProfile): string {
  const p = normalizeDataSyncProfile(input);
  return ctx.tasks.start('dataCompare', tr('Datenvergleich', 'Data comparison'), async (t) => {
    const t0 = Date.now();
    t.log('info', tr('Vergleiche {s} → {d} …', 'Comparing {s} → {d} …', { s: p.source.database, d: p.target.database }));
    const e = await compareAll(ctx, p, t, (f, msg) => t.progress(f, msg));
    const res = compareResult(e, Date.now() - t0);
    t.log('success', tr('Vergleich abgeschlossen in {t}.', 'Comparison finished in {t}.', { t: formatDuration(res.durationMs) }));
    return res;
  });
}

// ───────────────────────── rows by key ─────────────────────────

function keyCond(col: ColumnMeta, cls: ValueClass, v: CellValue): string {
  if (v === null) return `${quoteId(col.name)} IS NULL`;
  if (cls === 'float' && typeof v === 'string') return `CAST(${quoteId(col.name)} AS CHAR) = ${quoteString(v)}`;
  return `${quoteId(col.name)} = ${sqlLiteral(v, cls)}`;
}

function keyWhere(cols: ColumnMeta[], cls: ValueClass[], keys: KeyTuple[]): string {
  const simple = cls.every((c) => c !== 'float') && !keys.some((k) => k.some((v) => v === null));
  if (simple && cols.length === 1) return `${quoteId(cols[0].name)} IN (${keys.map((k) => sqlLiteral(k[0], cls[0])).join(', ')})`;
  if (simple) {
    return `(${cols.map((c) => quoteId(c.name)).join(', ')}) IN (${keys.map((k) => `(${k.map((v, j) => sqlLiteral(v, cls[j])).join(', ')})`).join(', ')})`;
  }
  return keys.map((k) => `(${cols.map((c, j) => keyCond(c, cls[j], k[j])).join(' AND ')})`).join(' OR ');
}

/** Rows of the synchronized columns for the given keys, keyed by normalized key */
async function fetchByKeys(s: Session, db: string, table: string, cols: ColumnMeta[], cls: ValueClass[], st: TableState, keys: KeyTuple[]): Promise<Map<string, unknown[]>> {
  const out = new Map<string, unknown[]>();
  const keyCols = st.keyIdx.map((i) => cols[i]);
  const keyCls = st.keyIdx.map((i) => cls[i]);
  const select = cols.map((c) => quoteId(c.name)).join(', ');
  for (let i = 0; i < keys.length; i += KEY_BATCH) {
    const batch = keys.slice(i, i + KEY_BATCH);
    const r = await s.rowset(`SELECT ${select} FROM ${qname(db, table)} WHERE ${keyWhere(keyCols, keyCls, batch)}`);
    for (const row of r.rows) out.set(normKey(st.keyIdx.map((k) => row[k]), st.norms), row);
  }
  return out;
}

export async function dataDiffRows(ctx: BackendContext, id: string, index: number, kind: DataDiffKind, offset: number, limit: number): Promise<DataDiffPage> {
  const e = entryOf(id);
  const st = e.tables[index];
  if (!st) throw new KsError(tr('Tabelle nicht gefunden.', 'Table not found.'));
  const list = kind === 'insert' ? st.inserts : kind === 'delete' ? st.deletes : st.updates;
  const page = list.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, Math.min(limit, 5000)));
  const out: DataDiffPage = { total: list.length, columns: st.info.columns, sourceMeta: st.srcCols, targetMeta: st.tgtCols, rows: [] };
  if (!page.length) return out;
  let src: SyncSession | null = null;
  let tgt: SyncSession | null = null;
  try {
    let srcRows = new Map<string, unknown[]>();
    let tgtRows = new Map<string, unknown[]>();
    if (kind !== 'delete') {
      src = await openSyncSession(ctx, e.source.connectionId, e.source.database, 'read');
      const keys = kind === 'insert' ? (page as KeyTuple[]) : (page as TableState['updates']).map((u) => u.src);
      srcRows = await fetchByKeys(src.s, e.source.database, st.srcTable, st.srcCols, st.srcCls, st, keys);
    }
    if (kind !== 'insert') {
      tgt = await openSyncSession(ctx, e.target.connectionId, e.target.database, 'read');
      const keys = kind === 'delete' ? (page as KeyTuple[]) : (page as TableState['updates']).map((u) => u.tgt);
      tgtRows = await fetchByKeys(tgt.s, e.target.database, st.tgtTable, st.tgtCols, st.tgtCls, st, keys);
    }
    const cells = (r: unknown[] | undefined): CellValue[] | null => (r ? r.map(toCellValue) : null);
    for (const item of page) {
      if (kind === 'update') {
        const u = item as TableState['updates'][number];
        out.rows.push({ key: keyString(u.src), source: cells(srcRows.get(normKey(u.src, st.norms))), target: cells(tgtRows.get(normKey(u.tgt, st.norms))) });
      } else {
        const k = item as KeyTuple;
        const nk = normKey(k, st.norms);
        out.rows.push({ key: keyString(k), source: kind === 'insert' ? cells(srcRows.get(nk)) : null, target: kind === 'delete' ? cells(tgtRows.get(nk)) : null });
      }
    }
  } finally {
    await closeSyncSession(ctx, src);
    await closeSyncSession(ctx, tgt);
  }
  return out;
}

// ───────────────────────── deployment statements ─────────────────────────

interface Unit {
  st: TableState;
  ops: DataDiffKind[];
  excluded: Set<string>;
}

function planUnits(e: CompareEntry, selection: DataSyncTableSelection[], o: DataSyncOptions, parents: Map<string, Set<string>>): Unit[] {
  const chosen: Unit[] = [];
  for (const sel of selection) {
    const st = e.tables[sel.index];
    if (!st || st.info.error) continue;
    const ops: DataDiffKind[] = [];
    if (o.delete && sel.delete && st.deletes.length) ops.push('delete');
    if (o.update && sel.update && st.updates.length) ops.push('update');
    if (o.insert && sel.insert && st.inserts.length) ops.push('insert');
    if (ops.length) chosen.push({ st, ops, excluded: new Set(sel.excluded) });
  }
  const byTarget = new Map(chosen.map((u) => [u.st.tgtTable, u]));
  const order = topoSort([...byTarget.keys()], (n) => parents.get(n) ?? []).map((n) => byTarget.get(n)!);
  if (o.disableFkChecks) return order;
  // with foreign key checks: delete children first, then update / insert parents first
  const units: Unit[] = [];
  for (const u of [...order].reverse()) if (u.ops.includes('delete')) units.push({ ...u, ops: ['delete'] });
  for (const u of order) {
    const ops = u.ops.filter((x) => x !== 'delete');
    if (ops.length) units.push({ ...u, ops });
  }
  return units;
}

interface Stmt {
  kind: DataDiffKind;
  sql: string;
  rows: number;
}

async function* unitStatements(e: CompareEntry, u: Unit, src: Session, tgt: Session): AsyncGenerator<Stmt> {
  const st = u.st;
  const tref = qname(e.target.database, st.tgtTable);
  const tKeyCols = st.keyIdx.map((i) => st.tgtCols[i]);
  const tKeyCls = st.keyIdx.map((i) => st.tgtCls[i]);
  if (u.ops.includes('delete')) {
    const keys = st.deletes.filter((k) => !u.excluded.has(keyString(k)));
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500);
      yield { kind: 'delete', sql: `DELETE FROM ${tref} WHERE ${keyWhere(tKeyCols, tKeyCls, batch)}`, rows: batch.length };
    }
  }
  if (u.ops.includes('update')) {
    const pairs = st.updates.filter((x) => !u.excluded.has(keyString(x.src)));
    for (let i = 0; i < pairs.length; i += KEY_BATCH) {
      const batch = pairs.slice(i, i + KEY_BATCH);
      const a = await fetchByKeys(src, e.source.database, st.srcTable, st.srcCols, st.srcCls, st, batch.map((x) => x.src));
      const b = await fetchByKeys(tgt, e.target.database, st.tgtTable, st.tgtCols, st.tgtCls, st, batch.map((x) => x.tgt));
      for (const p of batch) {
        const sr = a.get(normKey(p.src, st.norms));
        const tr0 = b.get(normKey(p.tgt, st.norms));
        if (!sr || !tr0) continue;
        const sets: string[] = [];
        for (let c = 0; c < st.srcCols.length; c++) {
          if (!valuesEqual(sr[c], tr0[c], st.srcCls[c], st.tgtCls[c])) sets.push(`${quoteId(st.tgtCols[c].name)} = ${sqlLiteral(sr[c], st.srcCls[c])}`);
        }
        if (!sets.length) continue;
        yield {
          kind: 'update',
          sql: `UPDATE ${tref} SET ${sets.join(', ')} WHERE ${tKeyCols.map((c, j) => keyCond(c, tKeyCls[j], p.tgt[j])).join(' AND ')}`,
          rows: 1
        };
      }
    }
  }
  if (u.ops.includes('insert')) {
    const keys = st.inserts.filter((k) => !u.excluded.has(keyString(k)));
    const names = st.tgtCols.map((c) => c.name);
    for (let i = 0; i < keys.length; i += KEY_BATCH) {
      const batch = keys.slice(i, i + KEY_BATCH);
      const a = await fetchByKeys(src, e.source.database, st.srcTable, st.srcCols, st.srcCls, st, batch);
      const rows = batch.map((k) => a.get(normKey(k, st.norms))).filter((r): r is unknown[] => !!r);
      const stmts = buildInserts(tref, names, st.srcCls, rows, { verb: 'INSERT', extended: true, rowsPerStatement: 200, maxBytes: 1 << 20 });
      for (let j = 0; j < stmts.length; j++) yield { kind: 'insert', sql: stmts[j], rows: j === 0 ? rows.length : 0 };
    }
  }
}

function unitLabel(u: Unit): string {
  const ops = u.ops.map((o) => (o === 'insert' ? 'INSERT' : o === 'update' ? 'UPDATE' : 'DELETE')).join(', ');
  return `${tr('Tabelle', 'Table')} ${u.st.tgtTable} (${ops})`;
}

interface Sessions {
  src: SyncSession;
  tgt: SyncSession;
}

async function withSessions<T>(ctx: BackendContext, e: CompareEntry, fn: (ss: Sessions) => Promise<T>): Promise<T> {
  let src: SyncSession | null = null;
  let tgt: SyncSession | null = null;
  try {
    src = await openSyncSession(ctx, e.source.connectionId, e.source.database, 'read');
    tgt = await openSyncSession(ctx, e.target.connectionId, e.target.database, 'strict');
    return await fn({ src, tgt });
  } finally {
    await closeSyncSession(ctx, src);
    await closeSyncSession(ctx, tgt);
  }
}

/** Writes the deployment script through `emit` (returns false to stop). */
async function generateScript(
  e: CompareEntry,
  selection: DataSyncTableSelection[],
  o: DataSyncOptions,
  ss: Sessions,
  charset: string,
  emit: (text: string) => Promise<boolean>
): Promise<{ statements: number; complete: boolean }> {
  const units = planUnits(e, selection, o, await fkParents(ss.tgt.s, e.target.database));
  const head = [
    `-- ${tr('KS Table – Datensynchronisation', 'KS Table – Data synchronization')}`,
    `-- ${tr('Quelle', 'Source')}: ${ss.src.s.config.name} / ${e.source.database}`,
    `-- ${tr('Ziel', 'Target')}: ${ss.tgt.s.config.name} / ${e.target.database}`,
    `-- ${tr('Erstellt', 'Created')}: ${formatDateTime(Date.now())}`,
    '',
    `SET NAMES ${charset};`,
    "SET TIME_ZONE = '+00:00';",
    `SET SESSION sql_mode = ${quoteString(ss.tgt.sqlMode)};`
  ];
  if (o.disableFkChecks) head.push('SET FOREIGN_KEY_CHECKS = 0;');
  let statements = 0;
  if (!(await emit(`${head.join('\n')}\n`))) return { statements, complete: false };
  for (const u of units) {
    if (!(await emit(`\n-- ${unitLabel(u)}\n${o.useTransaction ? 'START TRANSACTION;\n' : ''}`))) return { statements, complete: false };
    for await (const st of unitStatements(e, u, ss.src.s, ss.tgt.s)) {
      statements++;
      if (!(await emit(`${st.sql};\n`))) return { statements, complete: false };
    }
    if (o.useTransaction && !(await emit('COMMIT;\n'))) return { statements, complete: false };
  }
  if (o.disableFkChecks) await emit('\nSET FOREIGN_KEY_CHECKS = 1;\n');
  return { statements, complete: true };
}

export async function dataSyncScript(
  ctx: BackendContext,
  id: string,
  selection: DataSyncTableSelection[],
  options: DataSyncOptions,
  maxBytes: number
): Promise<DataSyncScriptResult> {
  const e = entryOf(id);
  const o = normalizeDataSyncOptions(options);
  const limit = Math.max(64 * 1024, Math.min(maxBytes || 4 << 20, 64 << 20));
  const parts: string[] = [];
  let bytes = 0;
  const r = await withSessions(ctx, e, (ss) =>
    generateScript(e, selection, o, ss, 'utf8mb4', async (text) => {
      if (bytes + text.length > limit) return false;
      parts.push(text);
      bytes += text.length;
      return true;
    })
  );
  const sql = parts.join('');
  return { sql, truncated: !r.complete, statements: r.statements, bytes: Buffer.byteLength(sql) };
}

export function startDataSyncSave(
  ctx: BackendContext,
  id: string,
  selection: DataSyncTableSelection[],
  options: DataSyncOptions,
  file: string,
  encodingId: string
): string {
  const e = entryOf(id);
  const o = normalizeDataSyncOptions(options);
  if (!file.trim()) throw new KsError(tr('Bitte eine Zieldatei angeben.', 'Please choose a target file.'));
  return ctx.tasks.start('dataSyncScript', tr('Synchronisationsskript speichern', 'Save synchronization script'), async (t) => {
    const enc = fileEncoding(encodingId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const fh = await fs.open(file, 'w');
    let bytes = 0;
    try {
      if (enc.bom) await fh.write(Buffer.from([0xef, 0xbb, 0xbf]));
      t.progress(null, file);
      const r = await withSessions(ctx, e, (ss) =>
        generateScript(e, selection, o, ss, enc.mysql, async (text) => {
          const buf = iconv.encode(text, enc.iconv);
          bytes += buf.length;
          await fh.write(buf);
          t.throwIfCancelled();
          return true;
        })
      );
      t.log('success', tr('{n} Anweisungen gespeichert: {f}', '{n} statements saved: {f}', { n: formatNumber(r.statements), f: file }));
      return { statements: r.statements, bytes, path: file };
    } finally {
      await fh.close();
    }
  });
}

async function deploy(ctx: BackendContext, e: CompareEntry, selection: DataSyncTableSelection[], o: DataSyncOptions, t: TaskContext, prog: (f: number, msg: string) => void): Promise<DataSyncDeployResult> {
  const t0 = Date.now();
  const result: DataSyncDeployResult = { tables: [], errors: 0, durationMs: 0 };
  const perTable = new Map<TableState, DataSyncDeployTableResult>();
  await withSessions(ctx, e, async ({ src, tgt }) => {
    if (o.disableFkChecks) await tgt.s.exec('SET FOREIGN_KEY_CHECKS = 0');
    const units = planUnits(e, selection, o, await fkParents(tgt.s, e.target.database));
    let total = 0;
    for (const u of units) for (const op of u.ops) total += op === 'insert' ? u.st.inserts.length : op === 'update' ? u.st.updates.length : u.st.deletes.length;
    total = Math.max(1, total);
    let done = 0;
    for (const u of units) {
      t.throwIfCancelled();
      let r = perTable.get(u.st);
      if (!r) {
        r = { source: u.st.srcTable, target: u.st.tgtTable, inserted: 0, updated: 0, deleted: 0, error: null };
        perTable.set(u.st, r);
        result.tables.push(r);
      }
      const counts = { insert: 0, update: 0, delete: 0 };
      prog(done / total, unitLabel(u));
      try {
        if (o.useTransaction) await tgt.s.exec('START TRANSACTION');
        for await (const st of unitStatements(e, u, src.s, tgt.s)) {
          const ok = await tgt.s.exec(st.sql);
          counts[st.kind] += ok.affectedRows;
          done += st.rows;
          prog(Math.min(0.999, done / total), `${u.st.tgtTable}: ${formatNumber(done)} / ${formatNumber(total)}`);
          t.throwIfCancelled();
        }
        if (o.useTransaction) await tgt.s.exec('COMMIT');
        r.inserted += counts.insert;
        r.updated += counts.update;
        r.deleted += counts.delete;
        t.log(
          'success',
          tr('{t}: {i} eingefügt, {u} aktualisiert, {d} gelöscht', '{t}: {i} inserted, {u} updated, {d} deleted', {
            t: u.st.tgtTable,
            i: formatNumber(counts.insert),
            u: formatNumber(counts.update),
            d: formatNumber(counts.delete)
          })
        );
      } catch (err) {
        if (o.useTransaction) await tgt.s.exec('ROLLBACK').catch(() => undefined);
        if (err instanceof CancelledError) throw err;
        if (!o.useTransaction) {
          r.inserted += counts.insert;
          r.updated += counts.update;
          r.deleted += counts.delete;
        }
        const msg = errorText(err);
        r.error = r.error ? `${r.error}; ${msg}` : msg;
        result.errors++;
        t.log('error', `${u.st.tgtTable}: ${msg}`);
        if (!o.continueOnError) throw new KsError(tr('Synchronisation abgebrochen: {m}', 'Synchronization stopped: {m}', { m: msg }));
      }
    }
  });
  result.durationMs = Date.now() - t0;
  return result;
}

export function startDataSyncDeploy(ctx: BackendContext, id: string, selection: DataSyncTableSelection[], options: DataSyncOptions): string {
  const e = entryOf(id);
  const o = normalizeDataSyncOptions(options);
  return ctx.tasks.start('dataSyncDeploy', tr('Datensynchronisation ausführen', 'Run data synchronization'), async (t) => {
    t.log('info', tr('Synchronisiere {s} → {d} …', 'Synchronizing {s} → {d} …', { s: e.source.database, d: e.target.database }));
    const r = await deploy(ctx, e, selection, o, t, (f, msg) => t.progress(f, msg));
    if (r.errors) throw new KsError(tr('Synchronisation beendet, {n} Tabelle(n) mit Fehlern.', 'Synchronization finished, {n} table(s) failed.', { n: r.errors }));
    t.log('success', tr('Synchronisation abgeschlossen in {t}.', 'Synchronization finished in {t}.', { t: formatDuration(r.durationMs) }));
    return r;
  });
}

/** Headless runner (batch jobs): compare and deploy every difference allowed by the options. */
export async function runDataSyncProfile(ctx: BackendContext, input: unknown, t: TaskContext): Promise<DataSyncDeployResult> {
  const p = normalizeDataSyncProfile(input);
  const e = await compareAll(ctx, p, t, (f, msg) => t.progress(f * 0.5, msg));
  try {
    const failed = e.tables.filter((x) => x.info.error);
    const selection = e.tables.map((x) => ({ index: x.info.index, insert: true, update: true, delete: true, excluded: [] }));
    const r = await deploy(ctx, e, selection, p.options, t, (f, msg) => t.progress(0.5 + f * 0.5, msg));
    const errors = r.errors + failed.length;
    if (errors) throw new KsError(tr('Datensynchronisation mit {n} Fehler(n) beendet.', 'Data synchronization finished with {n} error(s).', { n: errors }));
    t.log('success', tr('Datensynchronisation abgeschlossen.', 'Data synchronization finished.'));
    return r;
  } finally {
    releaseCompare(e.id);
  }
}

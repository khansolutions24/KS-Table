// Backend helpers shared by data transfer, data synchronization and structure synchronization.

import type { SyncObjectList } from '@shared/apis/sync';
import type { ColumnMeta, ObjectKind, TableDesign } from '@shared/types';
import { tr } from '@shared/i18n';
import { qname, quoteId } from '@shared/sql/quote';
import { sqlLiteral, valueClass, type ValueClass } from '@shared/sync/values';
import type { BackendContext } from '../../api';
import { KsError, toSqlError } from '../../errors';
import { extractParenthesized, loadTableDesign, parseCreateTable } from '../../db/design';
import { columns as loadColumns, events, routines, str, tables, triggers, views } from '../../db/meta';
import type { Session } from '../../db/sessions';

type Row = Record<string, unknown>;

export function errorText(e: unknown): string {
  return toSqlError(e).message;
}

// ───────────────────────── sessions ─────────────────────────

/** 'read': plain; 'lenient': accepts every value the source accepted (transfer); 'strict': server mode (data sync) */
export type SessionKind = 'read' | 'lenient' | 'strict';

export interface SyncSession {
  s: Session;
  /** sql_mode set for this session (restored after per-object modes) */
  sqlMode: string;
  lowerCaseNames: boolean;
  maxPacket: number;
}

// quoting / escaping of generated SQL relies on backticks and backslash escapes
const REMOVE_ALWAYS = new Set(['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES', 'ANSI']);
const REMOVE_LENIENT = new Set(['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'NO_ZERO_DATE', 'NO_ZERO_IN_DATE', 'TRADITIONAL']);

export async function openSyncSession(ctx: BackendContext, connectionId: string, database: string | null, kind: SessionKind): Promise<SyncSession> {
  const s = await ctx.sessions.open(connectionId, database);
  try {
    await s.exec('SET NAMES utf8mb4');
    await s.exec("SET SESSION time_zone = '+00:00'");
    const r = (await s.rows<Row>('SELECT @@SESSION.sql_mode AS m, @@lower_case_table_names AS l, @@max_allowed_packet AS p'))[0] ?? {};
    let modes = str(r.m)
      .split(',')
      .map((m) => m.trim().toUpperCase())
      .filter((m) => m && !REMOVE_ALWAYS.has(m));
    if (kind === 'lenient') modes = modes.filter((m) => !REMOVE_LENIENT.has(m));
    if (kind !== 'read' && !modes.includes('NO_AUTO_VALUE_ON_ZERO')) modes.push('NO_AUTO_VALUE_ON_ZERO');
    const sqlMode = modes.join(',');
    await s.exec('SET SESSION sql_mode = ?', [sqlMode]);
    return { s, sqlMode, lowerCaseNames: Number(r.l ?? 0) !== 0, maxPacket: Number(r.p ?? 0) || 16 * 1024 * 1024 };
  } catch (e) {
    await ctx.sessions.close(s.id);
    throw e;
  }
}

export async function closeSyncSession(ctx: BackendContext, ss: SyncSession | null | undefined): Promise<void> {
  if (ss) await ctx.sessions.close(ss.s.id).catch(() => undefined);
}

export async function schemaExists(s: Session, db: string): Promise<boolean> {
  const r = await s.rows<Row>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db]);
  return r.length > 0;
}

export async function schemaCharset(s: Session, db: string): Promise<{ charset: string; collation: string }> {
  const r = (await s.rows<Row>(
    'SELECT DEFAULT_CHARACTER_SET_NAME AS c, DEFAULT_COLLATION_NAME AS o FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [db]
  ))[0];
  return { charset: str(r?.c), collation: str(r?.o) };
}

// ───────────────────────── objects ─────────────────────────

export interface KeyDef {
  name: string;
  columns: string[];
  /** at least one column is nullable */
  nullable: boolean;
}

/** Unique keys (PRIMARY first) of all tables of a schema, keyed by table name */
export async function uniqueKeys(s: Session, db: string, table?: string): Promise<Map<string, KeyDef[]>> {
  const rows = await s.rows<Row>(
    `SELECT TABLE_NAME AS t, INDEX_NAME AS i, COLUMN_NAME AS c, NULLABLE AS n
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? ${table ? 'AND TABLE_NAME = ?' : ''} AND NON_UNIQUE = 0
      ORDER BY TABLE_NAME, INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
    table ? [db, table] : [db]
  );
  const out = new Map<string, KeyDef[]>();
  for (const r of rows) {
    const t = str(r.t);
    const list = out.get(t) ?? [];
    if (!out.has(t)) out.set(t, list);
    let k = list.find((x) => x.name === str(r.i));
    if (!k) {
      k = { name: str(r.i), columns: [], nullable: false };
      list.push(k);
    }
    // functional key parts have no column: such keys are not usable
    if (r.c === null || r.c === undefined) k.nullable = true;
    else k.columns.push(str(r.c));
    if (str(r.n) === 'YES') k.nullable = true;
  }
  return out;
}

export async function listObjects(s: Session, db: string): Promise<SyncObjectList> {
  const tbl = await tables(s, db);
  const keys = await uniqueKeys(s, db);
  const vw = await views(s, db);
  const rt = await routines(s, db);
  const tg = await triggers(s, db);
  const ev = await events(s, db);
  return {
    tables: tbl
      .filter((t) => t.type === 'BASE TABLE')
      .map((t) => ({
        name: t.name,
        rows: t.rows,
        engine: t.engine,
        hasKey: (keys.get(t.name) ?? []).some((k) => !k.nullable && k.columns.length > 0),
        comment: t.comment
      })),
    views: vw.map((v) => v.name),
    functions: rt.filter((r) => r.type === 'FUNCTION').map((r) => r.name),
    procedures: rt.filter((r) => r.type === 'PROCEDURE').map((r) => r.name),
    triggers: tg.map((t) => ({ name: t.name, table: t.table })),
    events: ev.map((e) => e.name)
  };
}

export interface CreateInfo {
  sql: string;
  /** sql_mode stored with routines / triggers / events */
  sqlMode: string | null;
  /** time zone stored with events */
  timeZone: string | null;
}

const SHOW_KW: Record<ObjectKind, string> = {
  table: 'TABLE',
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  trigger: 'TRIGGER',
  event: 'EVENT'
};

export async function showCreate(s: Session, db: string, kind: ObjectKind, name: string): Promise<CreateInfo> {
  const r = await s.rowset(`SHOW CREATE ${SHOW_KW[kind]} ${qname(db, name)}`);
  const col = (n: string) => r.fields.findIndex((f) => f.name.toLowerCase() === n);
  const textIdx = r.fields.findIndex((f) => /^create (table|view|function|procedure|event)$/i.test(f.name) || f.name === 'SQL Original Statement');
  const row = r.rows[0];
  const v = textIdx >= 0 && row ? row[textIdx] : null;
  if (v === null || v === undefined) {
    throw new KsError(tr('Keine Berechtigung, die Definition von „{n}“ zu lesen.', 'No privilege to read the definition of "{n}".', { n: name }));
  }
  const text = v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v);
  const mi = col('sql_mode');
  const ti = col('time_zone');
  return { sql: text, sqlMode: mi >= 0 && row ? str(row[mi]) : null, timeZone: ti >= 0 && row ? str(row[ti]) : null };
}

/**
 * Table design with expressions taken from SHOW CREATE TABLE: information_schema returns generated column
 * and expression default texts with backslash-escaped quotes, which cannot be executed as SQL.
 */
export async function loadDesign(s: Session, db: string, table: string): Promise<TableDesign> {
  const design = await loadTableDesign(s, db, table);
  fixDesign(design, (await showCreate(s, db, 'table', table)).sql);
  return design;
}

export function fixDesign(d: TableDesign, create: string): void {
  const parsed = parseCreateTable(create);
  for (const f of d.fields) {
    const line = parsed.columnLines.get(f.name);
    if (!line) continue;
    if (f.generated) {
      const pos = line.search(/\bGENERATED\s+ALWAYS\s+AS\s*\(/i);
      if (pos >= 0) {
        const inner = extractParenthesized(line, pos).trim();
        if (inner) f.generatedExpr = inner;
      }
    } else if (f.defaultKind === 'expression' && f.defaultValue.includes("\\'")) {
      const m = /\bDEFAULT\s*\(/i.exec(line);
      if (m) {
        const inner = extractParenthesized(line, m.index).trim();
        if (inner) f.defaultValue = `(${inner})`;
      }
    }
  }
  for (const ix of d.indexes) for (const p of ix.fields) if (p.expr && p.expr.includes("\\'")) p.expr = p.expr.replace(/\\(['\\])/g, '$1');
}

export const isGeneratedColumn = (m: ColumnMeta): boolean =>
  !!m.generationExpression || /\b(VIRTUAL|STORED|PERSISTENT)\s+GENERATED\b/i.test(m.extra);

export function tableColumns(s: Session, db: string, table: string): Promise<ColumnMeta[]> {
  return loadColumns(s, db, table);
}

/** Columns usable for keyset paging (same order for ORDER BY and > comparisons) */
function keysetSafe(m: ColumnMeta): boolean {
  const c = valueClass(m.dataType);
  if (c === 'int' || c === 'dec' || c === 'date' || c === 'datetime' || c === 'time' || c === 'year') return true;
  return m.dataType === 'char' || m.dataType === 'varchar' || m.dataType === 'binary' || m.dataType === 'varbinary';
}

/** Key for keyset paging: first unique key without NULLs and with safe types, else null (LIMIT paging) */
export function pagingKey(cols: ColumnMeta[], keys: KeyDef[]): string[] | null {
  const byName = new Map(cols.map((c) => [c.name, c]));
  for (const k of keys) {
    if (k.nullable || !k.columns.length) continue;
    if (k.columns.every((c) => byName.has(c) && keysetSafe(byName.get(c)!) && !byName.get(c)!.nullable)) return k.columns;
  }
  return null;
}

// ───────────────────────── reading rows ─────────────────────────

export interface ReadSpec {
  schema: string;
  table: string;
  /** Selected columns in order */
  columns: string[];
  /** Metadata of the selected columns (literals for keyset values) */
  meta: ColumnMeta[];
  /** Keyset paging columns (part of `columns`), null = LIMIT offset paging */
  key: string[] | null;
  /** Row filter without WHERE */
  where?: string;
  fetchSize: number;
}

function keysetCondition(key: string[], vals: unknown[], classes: ValueClass[]): string {
  const ors: string[] = [];
  for (let i = 0; i < key.length; i++) {
    const parts: string[] = [];
    for (let j = 0; j < i; j++) parts.push(`${quoteId(key[j])} = ${sqlLiteral(vals[j], classes[j])}`);
    parts.push(`${quoteId(key[i])} > ${sqlLiteral(vals[i], classes[i])}`);
    ors.push(parts.length > 1 ? `(${parts.join(' AND ')})` : parts[0]);
  }
  return ors.length > 1 ? `(${ors.join(' OR ')})` : ors[0];
}

/** Reads a table in chunks (keyset paging on a unique key, otherwise LIMIT paging). */
export async function* readRows(s: Session, spec: ReadSpec): AsyncGenerator<unknown[][]> {
  const cols = spec.columns.map(quoteId).join(', ');
  const from = qname(spec.schema, spec.table);
  const filter = spec.where?.trim() ? `(${spec.where.trim()})` : '';
  const size = Math.max(1, Math.floor(spec.fetchSize));
  if (spec.key && spec.key.length) {
    const idx = spec.key.map((k) => spec.columns.indexOf(k));
    if (idx.some((i) => i < 0)) throw new Error(`key column missing in select list of ${spec.table}`);
    const classes = idx.map((i) => valueClass(spec.meta[i]?.dataType ?? 'varchar'));
    const order = spec.key.map(quoteId).join(', ');
    let last: unknown[] | null = null;
    for (;;) {
      const conds: string[] = [];
      if (filter) conds.push(filter);
      if (last) conds.push(keysetCondition(spec.key, last, classes));
      const r = await s.rowset(`SELECT ${cols} FROM ${from}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${size}`);
      if (!r.rows.length) return;
      yield r.rows;
      if (r.rows.length < size) return;
      const lr = r.rows[r.rows.length - 1];
      last = idx.map((i) => lr[i]);
    }
  }
  let offset = 0;
  for (;;) {
    const r = await s.rowset(`SELECT ${cols} FROM ${from}${filter ? ` WHERE ${filter}` : ''} LIMIT ${offset}, ${size}`);
    if (!r.rows.length) return;
    yield r.rows;
    if (r.rows.length < size) return;
    offset += r.rows.length;
  }
}

/** Runs `fn` for every chunk while the next chunk is already being read (source and target run in parallel). */
export async function forEachChunk(gen: AsyncGenerator<unknown[][]>, fn: (rows: unknown[][]) => Promise<void>): Promise<void> {
  let next = gen.next();
  try {
    for (;;) {
      const r = await next;
      if (r.done) return;
      next = gen.next();
      await fn(r.value);
    }
  } catch (e) {
    next.catch(() => undefined);
    await gen.return(undefined).catch(() => undefined);
    throw e;
  }
}

// ───────────────────────── writing rows ─────────────────────────

export interface InsertOptions {
  verb: 'INSERT' | 'INSERT IGNORE' | 'REPLACE';
  extended: boolean;
  rowsPerStatement: number;
  maxBytes: number;
}

/**
 * INSERT statements for rows; `pick` maps statement columns to row indexes (default: same order).
 * Extended inserts are limited by rowsPerStatement and maxBytes (larger rows are sent alone).
 */
export function buildInserts(table: string, columns: string[], classes: ValueClass[], rows: unknown[][], o: InsertOptions, pick?: number[]): string[] {
  const head = `${o.verb} INTO ${table} (${columns.map(quoteId).join(', ')}) VALUES `;
  const headBytes = Buffer.byteLength(head);
  const out: string[] = [];
  let cur: string[] = [];
  let bytes = headBytes;
  for (const row of rows) {
    const tuple = `(${classes.map((c, i) => sqlLiteral(row[pick ? pick[i] : i], c)).join(', ')})`;
    if (!o.extended) {
      out.push(head + tuple);
      continue;
    }
    const tb = Buffer.byteLength(tuple) + 2;
    if (cur.length && (cur.length >= o.rowsPerStatement || bytes + tb > o.maxBytes)) {
      out.push(head + cur.join(',\n'));
      cur = [];
      bytes = headBytes;
    }
    cur.push(tuple);
    bytes += tb;
  }
  if (cur.length) out.push(head + cur.join(',\n'));
  return out;
}

// ───────────────────────── ordering / names ─────────────────────────

/** Topological order (dependencies first, ties by name); cycles are broken deterministically. */
export function topoSort(nodes: string[], deps: (n: string) => Iterable<string>): string[] {
  const set = new Set(nodes);
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n, 0);
    children.set(n, []);
  }
  for (const n of nodes) {
    for (const d of new Set(deps(n))) {
      if (d === n || !set.has(d)) continue;
      indeg.set(n, (indeg.get(n) ?? 0) + 1);
      children.get(d)!.push(n);
    }
  }
  const cmp = (a: string, b: string) => a.localeCompare(b);
  const ready = nodes.filter((n) => indeg.get(n) === 0).sort(cmp);
  const done = new Set<string>();
  const out: string[] = [];
  while (out.length < nodes.length) {
    if (!ready.length) ready.push(nodes.filter((n) => !done.has(n)).sort(cmp)[0]);
    ready.sort(cmp);
    const n = ready.shift()!;
    if (done.has(n)) continue;
    done.add(n);
    out.push(n);
    for (const c of children.get(n) ?? []) {
      const v = (indeg.get(c) ?? 0) - 1;
      indeg.set(c, v);
      if (v <= 0 && !done.has(c)) ready.push(c);
    }
  }
  return out;
}

/** Referencing table → referenced tables (foreign keys inside one schema) */
export async function fkParents(s: Session, db: string): Promise<Map<string, Set<string>>> {
  const rows = await s.rows<Row>(
    `SELECT TABLE_NAME AS t, REFERENCED_TABLE_NAME AS r FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND UNIQUE_CONSTRAINT_SCHEMA = ?`,
    [db, db]
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const t = str(r.t);
    if (!out.has(t)) out.set(t, new Set());
    out.get(t)!.add(str(r.r));
  }
  return out;
}

/** Finds names exactly or case-insensitively */
export function nameLookup(names: Iterable<string>): (n: string) => string | undefined {
  const exact = new Set<string>();
  const lower = new Map<string, string>();
  for (const n of names) {
    exact.add(n);
    if (!lower.has(n.toLowerCase())) lower.set(n.toLowerCase(), n);
  }
  return (n) => (exact.has(n) ? n : lower.get(n.toLowerCase()));
}

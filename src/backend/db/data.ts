// Table viewer: paged fetch, row count, applying grid edits.

import type {
  ApplyChangeResult,
  ApplyRequest,
  ApplyResult,
  CellValue,
  ColumnMeta,
  EditValue,
  FetchRequest,
  FetchResult,
  RowChange
} from '@shared/types';
import { tr } from '@shared/i18n';
import { hexLiteral, qname, quoteId, quoteString } from '@shared/sql/quote';
import { toSqlError } from '../errors';
import { normalizeRows } from './driver';
import { toResultColumn } from './fieldTypes';
import { columns as loadColumns, str } from './meta';
import type { Session } from './sessions';

const NUMERIC = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year']);
const SPATIAL = new Set(['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geomcollection', 'geometrycollection']);
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export interface KeyInfo {
  columns: string[];
  kind: 'primary' | 'unique' | 'none';
}

export async function keyInfo(s: Session, schema: string, table: string, meta: ColumnMeta[]): Promise<KeyInfo> {
  const pk = await s.rows<Record<string, unknown>>(
    `SELECT INDEX_NAME AS idx, COLUMN_NAME AS col, NON_UNIQUE AS nonUnique
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0
      ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
    [schema, table]
  );
  const byIndex = new Map<string, (string | null)[]>();
  for (const r of pk) {
    const idx = str(r.idx);
    if (!byIndex.has(idx)) byIndex.set(idx, []);
    byIndex.get(idx)!.push(r.col === null ? null : str(r.col));
  }
  const primary = byIndex.get('PRIMARY');
  if (primary && primary.every((c) => c !== null)) return { columns: primary as string[], kind: 'primary' };
  const notNull = new Set(meta.filter((m) => !m.nullable).map((m) => m.name));
  for (const [idx, cols] of byIndex) {
    if (idx === 'PRIMARY') continue;
    if (cols.every((c) => c !== null && notNull.has(c))) return { columns: cols as string[], kind: 'unique' };
  }
  return { columns: [], kind: 'none' };
}

export function buildSelect(req: FetchRequest): string {
  const where = req.where && req.where.trim() ? ` WHERE ${req.where.trim()}` : '';
  const order = req.orderSql?.trim()
    ? ` ORDER BY ${req.orderSql.trim()}`
    : req.orderBy?.length
      ? ` ORDER BY ${req.orderBy.map((o) => quoteId(o.column) + (o.desc ? ' DESC' : '')).join(', ')}`
      : '';
  const limit =
    req.limit !== null && req.limit !== undefined
      ? ` LIMIT ${Math.max(0, Math.floor(req.offset))}, ${Math.max(0, Math.floor(req.limit))}`
      : '';
  return `SELECT * FROM ${qname(req.schema, req.table)}${where}${order}${limit}`;
}

export async function fetchRows(s: Session, req: FetchRequest): Promise<FetchResult> {
  const sql = buildSelect(req);
  const t0 = Date.now();
  const r = await s.rowset(sql);
  const durationMs = Date.now() - t0;
  const meta = await loadColumns(s, req.schema, req.table);
  const keys = await keyInfo(s, req.schema, req.table, meta);
  return {
    columns: r.fields.map(toResultColumn),
    meta,
    rows: normalizeRows(r.rows),
    keyColumns: keys.columns,
    keyKind: keys.kind,
    sql,
    durationMs
  };
}

export async function countRows(s: Session, schema: string, table: string, where?: string): Promise<number> {
  const w = where && where.trim() ? ` WHERE ${where.trim()}` : '';
  const r = await s.rowset(`SELECT COUNT(*) FROM ${qname(schema, table)}${w}`);
  return Number(r.rows[0]?.[0] ?? 0);
}

function valueSql(v: EditValue | CellValue, m: ColumnMeta | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return hexLiteral(v);
  if (typeof v === 'object') return 'expr' in v ? v.expr : 'DEFAULT';
  if (m && NUMERIC.has(m.dataType) && NUMBER_RE.test(v.trim())) return v.trim();
  if (m && m.dataType === 'bit' && /^[01]+$/.test(v)) return `b'${v}'`;
  return quoteString(v);
}

function whereSql(key: Record<string, CellValue>, meta: Map<string, ColumnMeta>): string {
  const parts: string[] = [];
  for (const [c, v] of Object.entries(key)) {
    const m = meta.get(c);
    if (m && SPATIAL.has(m.dataType)) continue;
    const col = quoteId(c);
    if (v === null) parts.push(`${col} IS NULL`);
    else if (m?.dataType === 'json' && typeof v === 'string') parts.push(`${col} = CAST(${quoteString(v)} AS JSON)`);
    else if (m && (m.dataType === 'float' || m.dataType === 'double' || m.dataType === 'real') && typeof v === 'string') {
      parts.push(`CAST(${col} AS CHAR) = ${quoteString(v)}`);
    } else parts.push(`${col} = ${valueSql(v, m)}`);
  }
  return parts.length ? parts.join(' AND ') : '1 = 1';
}

export function changeSql(table: string, ch: RowChange, meta: Map<string, ColumnMeta>): string {
  if (ch.type === 'insert') {
    const cols = Object.keys(ch.values);
    if (!cols.length) return `INSERT INTO ${table} () VALUES ()`;
    return `INSERT INTO ${table} (${cols.map(quoteId).join(', ')}) VALUES (${cols
      .map((c) => valueSql(ch.values[c], meta.get(c)))
      .join(', ')})`;
  }
  if (ch.type === 'update') {
    const set = Object.entries(ch.values)
      .map(([c, v]) => `${quoteId(c)} = ${valueSql(v, meta.get(c))}`)
      .join(', ');
    return `UPDATE ${table} SET ${set} WHERE ${whereSql(ch.key, meta)} LIMIT 1`;
  }
  return `DELETE FROM ${table} WHERE ${whereSql(ch.key, meta)} LIMIT 1`;
}

async function rereadRow(
  s: Session,
  req: ApplyRequest,
  ch: RowChange,
  insertId: string,
  keys: KeyInfo,
  meta: Map<string, ColumnMeta>
): Promise<CellValue[] | null | undefined> {
  if (ch.type === 'delete' || keys.kind === 'none' || !req.columns.length) return undefined;
  const key: Record<string, CellValue> = {};
  for (const k of keys.columns) {
    const m = meta.get(k);
    if (ch.type === 'insert') {
      const v = ch.values[k];
      if (m?.extra.toLowerCase().includes('auto_increment') && (v === undefined || v === null || (typeof v === 'object' && !(v instanceof Uint8Array)))) {
        if (insertId === '0') return undefined;
        key[k] = insertId;
      } else if (v === undefined || (v !== null && typeof v === 'object' && !(v instanceof Uint8Array))) {
        return undefined;
      } else key[k] = v as CellValue;
    } else {
      const nv = ch.values[k];
      key[k] = nv !== undefined && (nv === null || typeof nv === 'string' || nv instanceof Uint8Array) ? nv : ch.key[k];
    }
  }
  const r = await s.rowset(
    `SELECT ${req.columns.map(quoteId).join(', ')} FROM ${qname(req.schema, req.table)} WHERE ${whereSql(key, meta)} LIMIT 1`
  );
  return r.rows.length ? normalizeRows(r.rows)[0] : null;
}

export async function applyChanges(
  s: Session,
  req: ApplyRequest,
  log: (sql: string, ok: boolean, ms: number, error?: string) => void
): Promise<ApplyResult> {
  const metaList = await loadColumns(s, req.schema, req.table);
  const meta = new Map(metaList.map((m) => [m.name, m]));
  const keys = await keyInfo(s, req.schema, req.table, metaList);
  const table = qname(req.schema, req.table);
  const results: ApplyChangeResult[] = [];
  const ownTx = req.transaction && !s.inTransaction;
  let failed = false;
  if (ownTx) await s.exec('START TRANSACTION');
  for (const ch of req.changes) {
    const sql = changeSql(table, ch, meta);
    const t0 = Date.now();
    try {
      const ok = await s.exec(sql);
      let affected = ok.affectedRows;
      if (ch.type === 'update') {
        const m = /Rows matched:\s*(\d+)/i.exec(ok.info);
        if (m) affected = Number(m[1]);
      }
      if (affected === 0 && ch.type !== 'insert') {
        throw new Error(
          tr(
            'Der Datensatz wurde nicht gefunden (inzwischen geändert oder gelöscht?).',
            'The record was not found (changed or deleted in the meantime?).'
          )
        );
      }
      log(sql, true, Date.now() - t0);
      const row = await rereadRow(s, req, ch, ok.insertId, keys, meta).catch(() => undefined);
      results.push({ ok: true, sql, affectedRows: affected, insertId: ok.insertId, row });
    } catch (e) {
      const err = toSqlError(e, sql);
      log(sql, false, Date.now() - t0, err.message);
      results.push({ ok: false, sql, affectedRows: 0, error: err });
      failed = true;
      if (req.transaction) break;
    }
  }
  if (ownTx) await s.exec(failed ? 'ROLLBACK' : 'COMMIT');
  return { results, committed: !(failed && req.transaction) };
}

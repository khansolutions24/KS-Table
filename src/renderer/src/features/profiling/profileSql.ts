// SQL generation and result parsing for the data profiling tab: per-column statistics,
// most frequent values and value / length / date distributions. Pure functions.

import type { CellValue, ColumnMeta } from '@shared/types';
import { qname, quoteId, quoteString } from '@shared/sql/quote';

export type ColClass = 'number' | 'bit' | 'text' | 'json' | 'date' | 'time' | 'binary' | 'spatial';

type Col = Pick<ColumnMeta, 'name' | 'dataType'>;

const NUMBER = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year']);
const INTEGER = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'year']);
const DATE = new Set(['date', 'datetime', 'timestamp']);
const BINARY = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
const SPATIAL = new Set(['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection']);

/** Text values are compared and shown by this prefix (full values can be megabytes). */
export const TEXT_PREFIX = 200;
const BINARY_PREFIX = 64;
export const TOP_LIMIT = 20;
const HIST_BUCKETS = 20;
/** Integer ranges up to this size get one bucket per value */
const INT_BUCKET_MAX = 30;
/** Date series longer than this are shown without filling gaps */
const DATE_SERIES_MAX = 400;

export function colClass(c: Pick<ColumnMeta, 'dataType'>): ColClass {
  const t = c.dataType.toLowerCase();
  if (NUMBER.has(t)) return 'number';
  if (t === 'bit') return 'bit';
  if (DATE.has(t)) return 'date';
  if (t === 'time') return 'time';
  if (t === 'json') return 'json';
  if (BINARY.has(t)) return 'binary';
  if (SPATIAL.has(t)) return 'spatial';
  return 'text';
}

export const isIntegerType = (c: Pick<ColumnMeta, 'dataType'>): boolean => INTEGER.has(c.dataType.toLowerCase());

export interface ColStats {
  nulls: number;
  distinct: number | null;
  /** '' for text, empty array/object for JSON, 0 bytes for binary */
  empty: number | null;
  zeros: number | null;
  negatives: number | null;
  min: string | null;
  max: string | null;
  avg: number | null;
  stddev: number | null;
  /** characters for text / JSON, bytes for binary / spatial */
  minLen: number | null;
  maxLen: number | null;
  avgLen: number | null;
}

type NumKey = Exclude<keyof ColStats, 'min' | 'max'>;
type Agg = { col: number; key: NumKey | 'min' | 'max'; expr: string };

const COUNTERS = new Set<string>(['nulls', 'empty', 'zeros', 'negatives']);

const decoder = new TextDecoder();

export function cellText(v: CellValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : decoder.decode(v);
}

export function cellNum(v: CellValue | undefined): number | null {
  const s = cellText(v);
  if (s === null || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Rows that are profiled: the whole table or its first `sample` rows. */
export function source(db: string, table: string, columns: string[], sample: number): string {
  if (sample > 0) return `(SELECT ${columns.map(quoteId).join(', ')} FROM ${qname(db, table)} LIMIT ${Math.floor(sample)}) AS s`;
  return `${qname(db, table)} AS s`;
}

function aggregates(c: Col): [Agg['key'], string][] {
  const x = quoteId(c.name);
  const out: [Agg['key'], string][] = [['nulls', `SUM(${x} IS NULL)`]];
  const lengths = (fn: string): [Agg['key'], string][] => [
    ['minLen', `MIN(${fn}(${x}))`],
    ['maxLen', `MAX(${fn}(${x}))`],
    ['avgLen', `AVG(${fn}(${x}))`]
  ];
  switch (colClass(c)) {
    case 'number':
      out.push(
        ['distinct', `COUNT(DISTINCT ${x})`],
        ['min', `MIN(${x})`],
        ['max', `MAX(${x})`],
        ['avg', `AVG(${x})`],
        ['stddev', `STDDEV_POP(${x})`],
        ['zeros', `SUM(${x} = 0)`],
        ['negatives', `SUM(${x} < 0)`]
      );
      break;
    case 'bit':
      out.push(['distinct', `COUNT(DISTINCT ${x})`], ['min', `MIN(${x} + 0)`], ['max', `MAX(${x} + 0)`], ['zeros', `SUM(${x} = 0)`]);
      break;
    case 'date':
    case 'time':
      out.push(['distinct', `COUNT(DISTINCT ${x})`], ['min', `MIN(${x})`], ['max', `MAX(${x})`]);
      break;
    case 'text':
      out.push(
        ['distinct', `COUNT(DISTINCT ${x})`],
        ['empty', `SUM(${x} = '')`],
        ['min', `MIN(LEFT(${x}, ${TEXT_PREFIX}))`],
        ['max', `MAX(LEFT(${x}, ${TEXT_PREFIX}))`],
        ...lengths('CHAR_LENGTH')
      );
      break;
    case 'json':
      out.push(['distinct', `COUNT(DISTINCT ${x})`], ['empty', `SUM(JSON_LENGTH(${x}) = 0)`], ...lengths('CHAR_LENGTH'));
      break;
    case 'binary':
      out.push(['distinct', `COUNT(DISTINCT ${x})`], ['empty', `SUM(OCTET_LENGTH(${x}) = 0)`], ...lengths('OCTET_LENGTH'));
      break;
    case 'spatial':
      out.push(...lengths('OCTET_LENGTH'));
      break;
  }
  return out;
}

function emptyStats(): ColStats {
  return { nulls: 0, distinct: null, empty: null, zeros: null, negatives: null, min: null, max: null, avg: null, stddev: null, minLen: null, maxLen: null, avgLen: null };
}

export interface StatsQuery {
  sql: string;
  parse(row: CellValue[]): { total: number; stats: ColStats[] };
}

/** One row with COUNT(*) followed by the aggregates of every given column. */
export function statsQuery(db: string, table: string, cols: Col[], sample: number): StatsQuery {
  const aggs: Agg[] = [];
  cols.forEach((c, col) => {
    for (const [key, expr] of aggregates(c)) aggs.push({ col, key, expr });
  });
  const select = ['COUNT(*) AS a0', ...aggs.map((a, i) => `${a.expr} AS a${i + 1}`)].join(',\n  ');
  return {
    sql: `SELECT ${select}\nFROM ${source(db, table, cols.map((c) => c.name), sample)}`,
    parse(row) {
      const stats = cols.map(emptyStats);
      aggs.forEach((a, i) => {
        const v = row[i + 1];
        const s = stats[a.col];
        if (a.key === 'min' || a.key === 'max') s[a.key] = cellText(v);
        // SUM() over no rows is NULL
        else if (a.key === 'nulls') s.nulls = cellNum(v) ?? 0;
        else s[a.key] = cellNum(v) ?? (COUNTERS.has(a.key) ? 0 : null);
      });
      return { total: cellNum(row[0]) ?? 0, stats };
    }
  };
}

/** Expression that is grouped and shown for "most frequent values". */
export function valueExpr(c: Col): string {
  const x = quoteId(c.name);
  switch (colClass(c)) {
    case 'bit':
      return `${x} + 0`;
    case 'text':
    case 'json':
      return `LEFT(${x}, ${TEXT_PREFIX})`;
    case 'binary':
      return `HEX(LEFT(${x}, ${BINARY_PREFIX}))`;
    case 'spatial':
      return `LEFT(ST_AsText(${x}), ${TEXT_PREFIX})`;
    default:
      return x;
  }
}

export function topValuesSql(db: string, table: string, c: Col, sample: number, limit = TOP_LIMIT): string {
  return `SELECT ${valueExpr(c)} AS __ks_v, COUNT(*) AS __ks_n FROM ${source(db, table, [c.name], sample)} GROUP BY __ks_v ORDER BY __ks_n DESC, __ks_v LIMIT ${limit}`;
}

/** Number of values that occur exactly once. */
export function uniqueCountSql(db: string, table: string, c: Col, sample: number): string | null {
  if (colClass(c) === 'spatial') return null;
  const x = quoteId(c.name);
  return `SELECT COUNT(*) FROM (SELECT 1 AS __ks_one FROM ${source(db, table, [c.name], sample)} WHERE ${x} IS NOT NULL GROUP BY ${x} HAVING COUNT(*) = 1) AS u`;
}

const hasOrder = (cls: ColClass) => cls === 'number' || cls === 'bit' || cls === 'date' || cls === 'time';
const numeric = (cls: ColClass) => cls === 'number' || cls === 'bit';

export function medianSql(db: string, table: string, c: Col, sample: number, nonNull: number): string | null {
  const cls = colClass(c);
  if (nonNull <= 0 || !hasOrder(cls)) return null;
  const x = quoteId(c.name);
  const e = cls === 'bit' ? `${x} + 0` : x;
  const take = numeric(cls) && nonNull % 2 === 0 ? 2 : 1;
  return `SELECT ${e} FROM ${source(db, table, [c.name], sample)} WHERE ${x} IS NOT NULL ORDER BY ${e} LIMIT ${take} OFFSET ${Math.floor((nonNull - 1) / 2)}`;
}

export function parseMedian(c: Col, rows: CellValue[][]): string | null {
  if (!rows.length) return null;
  if (numeric(colClass(c)) && rows.length === 2) {
    const a = cellNum(rows[0][0]);
    const b = cellNum(rows[1][0]);
    if (a !== null && b !== null) return String((a + b) / 2);
  }
  return cellText(rows[0][0]);
}

export interface HistBucket {
  /** Empty for numeric ranges: format from/to for display */
  label: string;
  n: number;
  from?: number;
  to?: number;
}

export interface HistPlan {
  /** value: distribution of the values, length: of their length, date: per day / month / year */
  mode: 'value' | 'length' | 'date';
  sql: string;
  parse(rows: CellValue[][]): HistBucket[];
}

export function histogramPlan(db: string, table: string, c: Col, sample: number, st: ColStats): HistPlan | null {
  const x = quoteId(c.name);
  const src = source(db, table, [c.name], sample);
  const where = `${x} IS NOT NULL`;
  switch (colClass(c)) {
    case 'number':
      return numericPlan('value', src, x, where, cellNum(st.min), cellNum(st.max), isIntegerType(c));
    case 'bit':
      return numericPlan('value', src, `${x} + 0`, where, cellNum(st.min), cellNum(st.max), true);
    case 'text':
    case 'json':
      return numericPlan('length', src, `CHAR_LENGTH(${x})`, where, st.minLen, st.maxLen, true);
    case 'binary':
    case 'spatial':
      return numericPlan('length', src, `OCTET_LENGTH(${x})`, where, st.minLen, st.maxLen, true);
    case 'date':
      return st.min && st.max ? datePlan(src, x, where, st.min, st.max) : null;
    default:
      return null;
  }
}

function numericPlan(mode: HistPlan['mode'], src: string, expr: string, where: string, min: number | null, max: number | null, integer: boolean): HistPlan | null {
  if (min === null || max === null || max < min) return null;
  const tail = `FROM ${src} WHERE ${where} GROUP BY __ks_b ORDER BY __ks_b`;
  if (max === min) {
    return {
      mode,
      sql: `SELECT COUNT(*) AS __ks_n FROM ${src} WHERE ${where}`,
      parse: (rows) => [{ label: '', n: cellNum(rows[0]?.[0]) ?? 0, from: min, to: max }]
    };
  }
  if (integer && max - min + 1 <= INT_BUCKET_MAX) {
    const count = max - min + 1;
    return {
      mode,
      sql: `SELECT ${expr} AS __ks_b, COUNT(*) AS __ks_n ${tail}`,
      parse: (rows) => {
        const out: HistBucket[] = Array.from({ length: count }, (_, i) => ({ label: '', n: 0, from: min + i, to: min + i }));
        for (const r of rows) {
          const b = cellNum(r[0]);
          const k = b === null ? -1 : Math.round(b - min);
          if (k >= 0 && k < count) out[k].n += cellNum(r[1]) ?? 0;
        }
        return out;
      }
    };
  }
  const width = integer ? Math.ceil((max - min + 1) / HIST_BUCKETS) : (max - min) / HIST_BUCKETS;
  const buckets = integer ? Math.ceil((max - min + 1) / width) : HIST_BUCKETS;
  return {
    mode,
    sql: `SELECT GREATEST(0, LEAST(FLOOR((${expr} - ${String(min)}) / ${String(width)}), ${buckets - 1})) AS __ks_b, COUNT(*) AS __ks_n ${tail}`,
    parse: (rows) => {
      const out: HistBucket[] = Array.from({ length: buckets }, (_, i) => {
        const from = min + i * width;
        const to = integer ? Math.min(max, from + width - 1) : i === buckets - 1 ? max : from + width;
        return { label: '', n: 0, from, to };
      });
      for (const r of rows) {
        const k = cellNum(r[0]);
        if (k !== null && k >= 0 && k < buckets) out[k].n += cellNum(r[1]) ?? 0;
      }
      return out;
    }
  };
}

type Ymd = { y: number; m: number; d: number };

function parseYmd(s: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const r = { y: +m[1], m: +m[2], d: +m[3] };
  return r.y < 1 || r.m < 1 || r.d < 1 ? null : r;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function dateSeries(a: Ymd, b: Ymd, unit: 'day' | 'month' | 'year'): string[] | null {
  const out: string[] = [];
  if (unit === 'year') {
    for (let y = a.y; y <= b.y; y++) {
      out.push(pad(y, 4));
      if (out.length > DATE_SERIES_MAX) return null;
    }
  } else if (unit === 'month') {
    for (let y = a.y, m = a.m; y < b.y || (y === b.y && m <= b.m); ) {
      out.push(`${pad(y, 4)}-${pad(m)}`);
      if (out.length > DATE_SERIES_MAX) return null;
      if (m === 12) {
        y++;
        m = 1;
      } else m++;
    }
  } else {
    const end = Date.UTC(b.y, b.m - 1, b.d);
    for (let t = Date.UTC(a.y, a.m - 1, a.d); t <= end; t += 864e5) {
      const d = new Date(t);
      out.push(`${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
      if (out.length > DATE_SERIES_MAX) return null;
    }
  }
  return out;
}

function datePlan(src: string, x: string, where: string, min: string, max: string): HistPlan {
  const a = parseYmd(min);
  const b = parseYmd(max);
  let unit: 'day' | 'month' | 'year' = 'year';
  if (a && b) {
    const days = (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 864e5;
    unit = days <= 62 ? 'day' : days <= 5 * 366 ? 'month' : 'year';
  }
  const fmt = unit === 'day' ? '%Y-%m-%d' : unit === 'month' ? '%Y-%m' : '%Y';
  return {
    mode: 'date',
    sql: `SELECT DATE_FORMAT(${x}, '${fmt}') AS __ks_b, COUNT(*) AS __ks_n FROM ${src} WHERE ${where} GROUP BY __ks_b ORDER BY __ks_b`,
    parse: (rows) => {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const k = cellText(r[0]);
        if (k !== null) counts.set(k, (counts.get(k) ?? 0) + (cellNum(r[1]) ?? 0));
      }
      const series = a && b ? dateSeries(a, b, unit) : null;
      // zero dates ('0000-00-00') or oversized ranges: show only the buckets that exist
      if (!series || [...counts.keys()].some((k) => !series.includes(k))) return [...counts].map(([label, n]) => ({ label, n }));
      return series.map((label) => ({ label, n: counts.get(label) ?? 0 }));
    }
  };
}

/** WHERE condition that selects the rows of one "most frequent values" entry. */
export function valueFilter(c: Col, v: CellValue): string {
  const x = quoteId(c.name);
  const s = cellText(v);
  if (s === null) return `${x} IS NULL`;
  switch (colClass(c)) {
    case 'number':
      return /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s) ? `${x} = ${s}` : `${x} = ${quoteString(s)}`;
    case 'bit':
      return /^\d+$/.test(s) ? `${x} + 0 = ${s}` : `${x} = ${quoteString(s)}`;
    case 'text':
      return [...s].length >= TEXT_PREFIX ? `LEFT(${x}, ${TEXT_PREFIX}) = ${quoteString(s)}` : `${x} = ${quoteString(s)}`;
    case 'json':
    case 'binary':
    case 'spatial':
      return `${valueExpr(c)} = ${quoteString(s)}`;
    default:
      return `${x} = ${quoteString(s)}`;
  }
}

// Value helpers for data transfer / data comparison: type classes, canonical forms used for equality,
// key ordering that matches the server's ORDER BY for merge comparisons, collation-aware key
// normalization and SQL literals. Pure functions (no Node / DOM APIs).

import type { CellValue } from '../types';
import { hexLiteral, quoteString, toHex } from '../sql/quote';

export type ValueClass =
  | 'int'
  | 'dec'
  | 'float'
  | 'date'
  | 'datetime'
  | 'time'
  | 'year'
  | 'bin'
  | 'bit'
  | 'str'
  | 'enum'
  | 'json'
  | 'geo'
  | 'other';

const INT = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);
const BIN = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
const STR = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']);
const GEO = new Set(['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geomcollection', 'geometrycollection']);

export function valueClass(dataType: string): ValueClass {
  const t = dataType.toLowerCase();
  if (INT.has(t)) return 'int';
  if (t === 'decimal' || t === 'numeric') return 'dec';
  if (t === 'float' || t === 'double' || t === 'real') return 'float';
  if (t === 'date') return 'date';
  if (t === 'datetime' || t === 'timestamp') return 'datetime';
  if (t === 'time') return 'time';
  if (t === 'year') return 'year';
  if (BIN.has(t)) return 'bin';
  if (t === 'bit') return 'bit';
  if (STR.has(t)) return 'str';
  if (t === 'enum' || t === 'set') return 'enum';
  if (t === 'json') return 'json';
  if (GEO.has(t)) return 'geo';
  return 'other';
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const PLAIN_DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** 0012.3400 → 12.34, -0.00 → 0 */
export function canonicalDecimal(s: string): string {
  let t = s.trim();
  if (!PLAIN_DECIMAL_RE.test(t)) return t;
  let neg = false;
  if (t[0] === '+' || t[0] === '-') {
    neg = t[0] === '-';
    t = t.slice(1);
  }
  const dot = t.indexOf('.');
  let ip = dot < 0 ? t : t.slice(0, dot);
  let fp = dot < 0 ? '' : t.slice(dot + 1);
  ip = ip.replace(/^0+(?=\d)/, '') || '0';
  fp = fp.replace(/0+$/, '');
  const out = fp ? `${ip}.${fp}` : ip;
  return neg && out !== '0' ? `-${out}` : out;
}

export function compareDecimal(a: string, b: string): number {
  const ca = canonicalDecimal(a);
  const cb = canonicalDecimal(b);
  if (ca === cb) return 0;
  const na = ca.startsWith('-');
  const nb = cb.startsWith('-');
  if (na !== nb) return na ? -1 : 1;
  const [ai, af = ''] = (na ? ca.slice(1) : ca).split('.');
  const [bi, bf = ''] = (nb ? cb.slice(1) : cb).split('.');
  let r: number;
  if (ai.length !== bi.length) r = ai.length < bi.length ? -1 : 1;
  else if (ai !== bi) r = ai < bi ? -1 : 1;
  else {
    const len = Math.max(af.length, bf.length);
    const x = af.padEnd(len, '0');
    const y = bf.padEnd(len, '0');
    r = x === y ? 0 : x < y ? -1 : 1;
  }
  return na ? -r : r;
}

function canonicalInt(s: string): string {
  const t = s.trim();
  if (/^[+-]?\d+$/.test(t)) {
    try {
      return BigInt(t).toString();
    } catch {
      return t;
    }
  }
  return canonicalDecimal(t);
}

/** '12:00:00.500000' → '12:00:00.5', '2024-01-01 10:00:00.000000' → '2024-01-01 10:00:00' */
export function canonicalTemporal(s: string): string {
  const t = s.trim();
  const dot = t.lastIndexOf('.');
  if (dot < 0 || !/^\d*$/.test(t.slice(dot + 1))) return t;
  const frac = t.slice(dot + 1).replace(/0+$/, '');
  return frac ? `${t.slice(0, dot)}.${frac}` : t.slice(0, dot);
}

/** Fraction padded to 6 digits so that string order equals time order */
function paddedTemporal(s: string): string {
  const t = s.trim();
  const dot = t.lastIndexOf('.');
  if (dot < 0 || !/^\d*$/.test(t.slice(dot + 1))) return `${t}.000000`;
  return `${t.slice(0, dot)}.${t.slice(dot + 1).padEnd(6, '0').slice(0, 6)}`;
}

function timeMicros(s: string): bigint | null {
  const m = /^(-)?(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{0,6}))?$/.exec(s.trim());
  if (!m) return null;
  const v =
    ((BigInt(m[2]) * 60n + BigInt(m[3])) * 60n + BigInt(m[4])) * 1_000_000n + BigInt((m[5] ?? '').padEnd(6, '0') || '0');
  return m[1] ? -v : v;
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Canonical text of a value for equality tests (null → null, binaries as hex). */
export function canonicalValue(v: unknown, cls: ValueClass): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) {
    if (cls === 'bit') return `b:${toHex(v).replace(/^(?:00)+(?=[0-9A-F]{2})/, '')}`;
    return `x:${toHex(v)}`;
  }
  const s = asText(v);
  switch (cls) {
    case 'int':
    case 'year':
      return canonicalInt(s);
    case 'dec':
      return canonicalDecimal(s);
    case 'float': {
      const n = Number(s);
      return Number.isFinite(n) ? String(n) : s;
    }
    case 'date':
    case 'datetime':
    case 'time':
      return canonicalTemporal(s);
    default:
      return s;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Equality of two column values with type aware canonicalisation (binaries compared byte-wise). */
export function valuesEqual(a: unknown, b: unknown, clsA: ValueClass, clsB: ValueClass = clsA): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Uint8Array && b instanceof Uint8Array && clsA !== 'bit' && clsB !== 'bit') return bytesEqual(a, b);
  if (clsA !== clsB && numericLike(clsA) && numericLike(clsB)) return canonicalValue(a, 'dec') === canonicalValue(b, 'dec');
  return canonicalValue(a, clsA) === canonicalValue(b, clsB);
}

function numericLike(c: ValueClass): boolean {
  return c === 'int' || c === 'dec' || c === 'year';
}

// ───────────────────────── merge ordering ─────────────────────────

/** Key classes whose server order can be reproduced exactly in JavaScript */
export type MergeClass = 'int' | 'dec' | 'date' | 'datetime' | 'time' | 'bin';

export function mergeClass(dataType: string): MergeClass | null {
  const t = dataType.toLowerCase();
  const c = valueClass(t);
  if (c === 'int' || c === 'year') return 'int';
  if (c === 'dec') return 'dec';
  if (c === 'date') return 'date';
  if (c === 'datetime') return 'datetime';
  if (c === 'time') return 'time';
  if (t === 'binary' || t === 'varbinary') return 'bin';
  return null;
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  return BigInt(asText(v).trim());
}

/** Compares two non-null key values in the order MySQL uses for ORDER BY on such a column. */
export function compareMergeValue(a: unknown, b: unknown, cls: MergeClass): number {
  switch (cls) {
    case 'int': {
      const x = toBigInt(a);
      const y = toBigInt(b);
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'dec':
      return compareDecimal(asText(a), asText(b));
    case 'date':
    case 'datetime': {
      const x = paddedTemporal(asText(a));
      const y = paddedTemporal(asText(b));
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'time': {
      const x = timeMicros(asText(a));
      const y = timeMicros(asText(b));
      if (x === null || y === null) {
        const p = asText(a);
        const q = asText(b);
        return p === q ? 0 : p < q ? -1 : 1;
      }
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'bin': {
      const x = a instanceof Uint8Array ? a : new TextEncoder().encode(asText(a));
      const y = b instanceof Uint8Array ? b : new TextEncoder().encode(asText(b));
      return compareBytes(x, y);
    }
  }
}

export function compareMergeKeys(a: unknown[], b: unknown[], classes: MergeClass[]): number {
  for (let i = 0; i < classes.length; i++) {
    const r = compareMergeValue(a[i], b[i], classes[i]);
    if (r !== 0) return r;
  }
  return 0;
}

// ───────────────────────── key normalization (hash comparison) ─────────────────────────

/**
 * Normalizer for one key column so that values the server treats as equal map to the same text:
 * case-insensitive (_ci) and accent-insensitive collations, PAD SPACE collations (trailing blanks).
 */
export function keyPartNormalizer(dataType: string, collation: string | null): (v: unknown) => string {
  const cls = valueClass(dataType);
  if (cls !== 'str' && cls !== 'enum') {
    return (v) => {
      const c = canonicalValue(v, cls);
      return c === null ? ' ' : c;
    };
  }
  const coll = (collation ?? '').toLowerCase();
  const ci = /_ci$/.test(coll);
  const ai = ci && !/_as_ci$/.test(coll);
  const pad = !!coll && !/_0900_/.test(coll) && !/nopad/.test(coll) && coll !== 'binary';
  return (v) => {
    if (v === null || v === undefined) return ' ';
    let s = v instanceof Uint8Array ? `x:${toHex(v)}` : asText(v);
    if (pad) s = s.replace(/ +$/, '');
    if (ai) s = s.normalize('NFD').replace(/\p{M}/gu, '');
    if (ci) s = s.toLowerCase();
    return s;
  };
}

// ───────────────────────── transport / SQL ─────────────────────────

/** Driver value → CellValue (numbers as strings, binaries kept) */
export function toCellValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Stable text of a key tuple (used to identify rows between compare, preview and deployment) */
export function keyString(tuple: readonly CellValue[]): string {
  return JSON.stringify(tuple.map((v) => (v === null ? null : v instanceof Uint8Array ? { x: toHex(v) } : v)));
}

/** SQL literal for a value read from the server */
export function sqlLiteral(v: unknown, cls: ValueClass): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return hexLiteral(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') {
    if ((cls === 'int' || cls === 'dec' || cls === 'float' || cls === 'year') && NUMBER_RE.test(v)) return v;
    return quoteString(v);
  }
  return quoteString(JSON.stringify(v));
}

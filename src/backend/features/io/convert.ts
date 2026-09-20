// Import value conversion: source values → SQL literals for a target column, and type detection
// for new tables.

import type { ColumnMeta, ServerInfo } from '@shared/types';
import type { ImportFormat, ImportParseOptions, InferredType } from '@shared/apis/io';
import { tr } from '@shared/i18n';
import { quoteString } from '@shared/sql/quote';
import { normalizeNumber, parseUserTemporal } from '@shared/io/datetime';
import type { JsonRaw } from '@shared/io/jsonStream';

/** string, NULL (null), no value in the source (undefined) or exact JSON text */
export type SourceValue = string | null | undefined | JsonRaw;

export class ConversionError extends Error {}

export type Converter = (v: SourceValue) => string;

export const TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);
const INT_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);
const NUM_TYPES = new Set(['decimal', 'numeric', 'float', 'double', 'real', 'year']);
export const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
export const GEOMETRY_TYPES = new Set([
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geomcollection', 'geometrycollection'
]);
const WKT_RE = /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION|GEOMCOLLECTION)\s*(\(|EMPTY)/i;

export function valueText(v: string | JsonRaw): string {
  return typeof v === 'string' ? v : v.raw;
}

function isJsonText(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export function decodeBinary(s: string, enc: ImportParseOptions['binaryEncoding']): Buffer {
  if (enc === 'base64') {
    const b = s.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b)) throw new ConversionError(tr('Ungültige Base64-Daten', 'Invalid Base64 data'));
    return Buffer.from(b, 'base64');
  }
  if (enc === 'hex') {
    const h = s.replace(/\s+/g, '').replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) throw new ConversionError(tr('Ungültige Hexadezimal-Daten', 'Invalid hexadecimal data'));
    return Buffer.from(h, 'hex');
  }
  return Buffer.from(s, 'utf8');
}

const hexLit = (b: Buffer) => `X'${b.toString('hex').toUpperCase()}'`;

/**
 * Converter for a target column.
 * forWhere: values are used in a WHERE condition (key match) – never produces DEFAULT.
 */
export function makeConverter(col: ColumnMeta, o: ImportParseOptions, format: ImportFormat, srv: ServerInfo, forWhere = false): Converter {
  const t = col.dataType;
  const isText = TEXT_TYPES.has(t);
  // no value in the source: NULL when allowed, '' for text, otherwise the column default
  const missing = forWhere || col.nullable ? 'NULL' : isText ? "''" : 'DEFAULT';
  const emptyNonText = forWhere || col.nullable ? 'NULL' : 'DEFAULT';

  if (isText) {
    return (v) => (v === undefined ? missing : v === null ? 'NULL' : quoteString(valueText(v)));
  }
  if (INT_TYPES.has(t) || NUM_TYPES.has(t)) {
    return (v) => {
      if (v === undefined) return missing;
      if (v === null) return 'NULL';
      const s = valueText(v);
      if (!s.trim()) return emptyNonText;
      if (/^\s*true\s*$/i.test(s)) return '1';
      if (/^\s*false\s*$/i.test(s)) return '0';
      const n = normalizeNumber(s, typeof v === 'string' ? o.decimalSymbol : '.');
      return n !== null ? n : quoteString(s);
    };
  }
  if (t === 'bit') {
    return (v) => {
      if (v === undefined) return missing;
      if (v === null) return 'NULL';
      const s = valueText(v).trim();
      if (!s) return emptyNonText;
      if (/^true$/i.test(s)) return '1';
      if (/^false$/i.test(s)) return '0';
      if (/^\d+$/.test(s) || /^b'[01]*'$/i.test(s) || /^0x[0-9a-f]+$/i.test(s)) return s;
      return quoteString(s);
    };
  }
  if (t === 'date' || t === 'datetime' || t === 'timestamp' || t === 'time') {
    const target = t === 'date' ? 'date' : t === 'time' ? 'time' : 'datetime';
    return (v) => {
      if (v === undefined) return missing;
      if (v === null) return 'NULL';
      const s = valueText(v);
      if (!s.trim()) return emptyNonText;
      return quoteString(parseUserTemporal(s, target, o) ?? s.trim());
    };
  }
  if (BINARY_TYPES.has(t)) {
    return (v) => {
      if (v === undefined) return missing;
      if (v === null) return 'NULL';
      return hexLit(decodeBinary(valueText(v), o.binaryEncoding));
    };
  }
  if (t === 'json') {
    return (v) => {
      if (v === undefined) return missing;
      if (v === null) return 'NULL';
      if (typeof v !== 'string') return quoteString(v.raw);
      if (!v.trim()) return emptyNonText;
      // strings of JSON files are JSON strings; other sources may contain JSON text
      if (format === 'json') return quoteString(JSON.stringify(v));
      return quoteString(isJsonText(v) ? v : JSON.stringify(v));
    };
  }
  if (GEOMETRY_TYPES.has(t)) {
    const axisOption = srv.type === 'mysql' && srv.versionNumber >= 80012;
    return (v) => {
      if (v === undefined) return missing;
      if (v === null) return 'NULL';
      const s = valueText(v).trim();
      if (!s) return emptyNonText;
      const m = /^SRID=(\d+);([\s\S]*)$/i.exec(s);
      const srid = m ? m[1] : null;
      const body = m ? m[2].trim() : s;
      if (WKT_RE.test(body)) {
        if (!srid || srid === '0') return `ST_GeomFromText(${quoteString(body)}${srid ? ', 0' : ''})`;
        return `ST_GeomFromText(${quoteString(body)}, ${srid}${axisOption ? ", 'axis-order=long-lat'" : ''})`;
      }
      if (/^(0x)?[0-9a-fA-F]+$/.test(body) && body.replace(/^0x/i, '').length % 2 === 0) return hexLit(decodeBinary(body, 'hex'));
      if (o.binaryEncoding === 'base64') return hexLit(decodeBinary(body, 'base64'));
      return `ST_GeomFromText(${quoteString(body)})`;
    };
  }
  return (v) => (v === undefined ? missing : v === null ? 'NULL' : quoteString(valueText(v)));
}

// ───────────────────────── type detection ─────────────────────────

const INT32_MAX = 2147483647n;
const INT32_MIN = -2147483648n;

/** Column type for new tables from sample values of one field. */
export function inferType(values: SourceValue[], o: ImportParseOptions): InferredType {
  let count = 0;
  let maxLen = 0;
  let allBool = true;
  let allInt = true;
  let allNum = true;
  let anyExp = false;
  let intDigits = 0;
  let scale = 0;
  let int32 = true;
  let allDate = true;
  let anyTime = false;
  let fsp = 0;
  let allTime = true;
  let allJson = true;
  const dopt = { dateOrder: o.dateOrder, dateSeparator: o.dateSeparator, timeSeparator: o.timeSeparator };
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const raw = typeof v !== 'string';
    const s = valueText(v);
    if (!s.trim()) continue;
    count++;
    maxLen = Math.max(maxLen, s.length);
    if (!(raw && /^[[{]/.test(s))) allJson = false;
    if (!/^\s*(true|false)\s*$/i.test(s)) allBool = false;
    if (allNum) {
      const n = normalizeNumber(s, raw ? '.' : o.decimalSymbol);
      if (n === null || /^-?0\d/.test(n)) {
        allNum = false;
        allInt = false;
      } else if (/e/i.test(n)) {
        anyExp = true;
        allInt = false;
      } else {
        const [ip, fp] = n.replace('-', '').split('.');
        intDigits = Math.max(intDigits, ip.replace(/^0+(?=\d)/, '').length);
        if (fp !== undefined) {
          allInt = false;
          scale = Math.max(scale, fp.length);
        } else if (int32 && (BigInt(n) > INT32_MAX || BigInt(n) < INT32_MIN)) int32 = false;
      }
    }
    if (allDate || allTime) {
      if (allDate) {
        const d = parseUserTemporal(s, 'datetime', dopt);
        if (d === null || !/^\d{4}-/.test(s.trim()) && /^\d+$/.test(s.trim())) allDate = false;
        else if (d.includes(' ')) {
          anyTime = true;
          const f = /\.(\d+)$/.exec(d);
          if (f) fsp = Math.max(fsp, f[1].length);
        }
      }
      if (allTime) {
        const onlyTime = /^\s*-?\d{1,3}[:.]\d{1,2}([:.]\d{1,2}([.,]\d+)?)?\s*([AaPp][Mm])?\s*$/.test(s);
        const tm = onlyTime ? parseUserTemporal(s, 'time', dopt) : null;
        if (!tm) allTime = false;
        else {
          const f = /\.(\d+)$/.exec(tm);
          if (f) fsp = Math.max(fsp, f[1].length);
        }
      }
    }
  }
  const tp = (type: string, length = '', decimals = ''): InferredType => ({ type, length, decimals });
  if (!count) return tp('VARCHAR', '255');
  if (allJson) return tp('JSON');
  if (allBool) return tp('TINYINT', '1');
  if (allNum && allInt) {
    if (int32 && intDigits <= 10) return tp('INT');
    if (intDigits <= 18) return tp('BIGINT');
    if (intDigits <= 65) return tp('DECIMAL', String(intDigits), '0');
  } else if (allNum && !anyExp) {
    const s = Math.min(scale, 30);
    const p = Math.max(intDigits + s, 1);
    if (p <= 65) return tp('DECIMAL', String(p), String(s));
    return tp('DOUBLE');
  } else if (allNum) return tp('DOUBLE');
  if (allTime) return tp('TIME', fsp ? String(Math.min(fsp, 6)) : '');
  if (allDate) return anyTime ? tp('DATETIME', fsp ? String(Math.min(fsp, 6)) : '') : tp('DATE');
  if (maxLen <= 255) return tp('VARCHAR', '255');
  if (maxLen <= 16383) return tp('TEXT');
  if (maxLen <= 4194303) return tp('MEDIUMTEXT');
  return tp('LONGTEXT');
}

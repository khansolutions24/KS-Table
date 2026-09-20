// Identifier and literal quoting for MySQL / MariaDB.

import type { CellValue, EditValue } from '../types';

export function quoteId(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** `schema`.`name` (schema omitted when empty) */
export function qname(schema: string | null | undefined, name: string): string {
  return schema ? `${quoteId(schema)}.${quoteId(name)}` : quoteId(name);
}

const ESCAPES: Record<string, string> = {
  '\0': '\\0',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
  '\x1a': '\\Z',
  '"': '\\"',
  "'": "\\'",
  '\\': '\\\\'
};

export function quoteString(s: string): string {
  return "'" + s.replace(/[\0\b\t\n\r\x1a"'\\]/g, (c) => ESCAPES[c]) + "'";
}

/** Escape % and _ for use inside a LIKE pattern (the result still needs quoteString). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

const HEX = '0123456789ABCDEF';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX[b >> 4] + HEX[b & 15];
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
  const len = clean.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function hexLiteral(bytes: Uint8Array): string {
  return `X'${toHex(bytes)}'`;
}

const NUMERIC_TYPES = new Set([
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'REAL', 'YEAR'
]);

export function isNumericType(typeName: string): boolean {
  return NUMERIC_TYPES.has(typeName.toUpperCase());
}

const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * SQL literal for a value. Numbers are left unquoted when `numeric` is set
 * and the text is a valid number.
 */
export function literal(v: CellValue | EditValue | undefined, numeric = false): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') {
    if (numeric && NUMBER_RE.test(v)) return v;
    return quoteString(v);
  }
  if (v instanceof Uint8Array) return hexLiteral(v);
  if ('expr' in v) return v.expr;
  return 'DEFAULT';
}

/** Parse the member list of an ENUM(...) / SET(...) column type. */
export function parseEnumValues(columnType: string): string[] {
  const m = /^\s*(?:enum|set)\s*\((.*)\)\s*$/is.exec(columnType);
  if (!m) return [];
  const body = m[1];
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === "'") {
      let s = '';
      i++;
      while (i < body.length) {
        const c = body[i];
        if (c === "'" && body[i + 1] === "'") {
          s += "'";
          i += 2;
        } else if (c === '\\' && i + 1 < body.length) {
          s += body[i + 1];
          i += 2;
        } else if (c === "'") {
          i++;
          break;
        } else {
          s += c;
          i++;
        }
      }
      out.push(s);
    } else {
      i++;
    }
  }
  return out;
}

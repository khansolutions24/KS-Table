// Query parameters: `:name` placeholders in SQL text (outside strings, quoted identifiers and comments).
// Values are substituted as SQL literals before the script is sent to the server.

import { tr } from '@shared/i18n';
import { quoteString } from '@shared/sql/quote';

export interface ParamRef {
  name: string;
  /** offset of the ':' */
  start: number;
  /** offset right after the name */
  end: number;
}

/** auto = number when it looks like one, otherwise text; raw = inserted unchanged (SQL expression) */
export type ParamMode = 'auto' | 'text' | 'number' | 'raw' | 'null';

export interface ParamValue {
  mode: ParamMode;
  value: string;
}

const NAME_RE = /:([A-Za-z_][A-Za-z0-9_]*)/y;
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
/** numbers without leading zeros ("007" stays text in auto mode) */
const PLAIN_NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?(e[+-]?\d+)?$/i;

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/** All placeholder occurrences, in text order. */
export function findParams(sql: string): ParamRef[] {
  const out: ParamRef[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        const d = sql[j];
        if (d === '\\' && c !== '`') {
          j += 2;
          continue;
        }
        if (d === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '#' || (c === '-' && sql[i + 1] === '-' && (i + 2 >= n || isSpace(sql[i + 2])))) {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    // `:=` (assignment), `label:` and `a::b` are not parameters
    if (c === ':' && !(i > 0 && /[\w$:@.]/.test(sql[i - 1]))) {
      NAME_RE.lastIndex = i;
      const m = NAME_RE.exec(sql);
      if (m) {
        out.push({ name: m[1], start: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Distinct parameter names in order of first appearance. */
export function paramNames(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of findParams(sql)) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r.name);
  }
  return out;
}

/** Validation message for a value, or null when it is fine. */
export function validateParam(v: ParamValue): string | null {
  if (v.mode === 'number' && !NUMBER_RE.test(v.value.trim())) {
    return tr('„{v}“ ist keine gültige Zahl.', '"{v}" is not a valid number.', { v: v.value });
  }
  if (v.mode === 'raw' && !v.value.trim()) return tr('Bitte einen SQL-Ausdruck eingeben.', 'Please enter an SQL expression.');
  return null;
}

/** SQL literal for a parameter value. */
export function paramLiteral(v: ParamValue): string {
  switch (v.mode) {
    case 'null':
      return 'NULL';
    case 'raw':
      return v.value.trim();
    case 'number': {
      const t = v.value.trim();
      if (!NUMBER_RE.test(t)) throw new Error(validateParam(v) ?? 'invalid number');
      return t;
    }
    case 'text':
      return quoteString(v.value);
    default: {
      const t = v.value.trim();
      return PLAIN_NUMBER_RE.test(t) ? t : quoteString(v.value);
    }
  }
}

/** Replaces every placeholder that has a value; unknown names stay untouched. */
export function substituteParams(sql: string, values: Record<string, ParamValue>): string {
  const refs = findParams(sql);
  if (!refs.length) return sql;
  let out = '';
  let pos = 0;
  for (const r of refs) {
    const v = values[r.name];
    if (!v) continue;
    out += sql.slice(pos, r.start) + paramLiteral(v);
    pos = r.end;
  }
  return out + sql.slice(pos);
}

// Text helpers for rewriting SHOW CREATE output of views, routines, triggers and events:
// removing DEFINER clauses, re-qualifying schema references, renaming the created object and
// detecting statements that need a DELIMITER in scripts. Strings and comments are never touched.

import { qname, quoteId } from '../sql/quote';

export type SqlTokType = 'ws' | 'comment' | 'string' | 'qid' | 'word' | 'punct';

export interface SqlTok {
  type: SqlTokType;
  text: string;
  start: number;
  end: number;
}

/** Word characters: ASCII letters, digits, _ and $ plus every non-ASCII character */
const WORD_CH = /[\w$]|[^\x00-\x7F]/;
const SPACE_CH = /\s/;

/** Splits SQL into whitespace, comments, strings, `quoted identifiers`, words and punctuation. */
export function tokenizeSqlText(sql: string): SqlTok[] {
  const out: SqlTok[] = [];
  const n = sql.length;
  let i = 0;
  const push = (type: SqlTokType, start: number, end: number) => out.push({ type, text: sql.slice(start, end), start, end });
  while (i < n) {
    const c = sql[i];
    const start = i;
    if (SPACE_CH.test(c)) {
      while (i < n && SPACE_CH.test(sql[i])) i++;
      push('ws', start, i);
    } else if (c === '#' || (c === '-' && sql[i + 1] === '-' && (i + 2 >= n || SPACE_CH.test(sql[i + 2])))) {
      while (i < n && sql[i] !== '\n') i++;
      push('comment', start, i);
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      push('comment', start, i);
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = Math.min(j + 1, n);
      push('string', start, i);
    } else if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '`') {
          if (sql[j + 1] === '`') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = Math.min(j + 1, n);
      push('qid', start, i);
    } else if (WORD_CH.test(c)) {
      while (i < n && WORD_CH.test(sql[i])) i++;
      push('word', start, i);
    } else {
      i++;
      push('punct', start, i);
    }
  }
  return out;
}

/** Identifier text of a word or `quoted` token */
export function identText(t: SqlTok): string {
  if (t.type !== 'qid') return t.text;
  const inner = t.text.length > 1 && t.text.endsWith('`') ? t.text.slice(1, -1) : t.text.slice(1);
  return inner.replace(/``/g, '`');
}

function nextSig(toks: SqlTok[], from: number): number {
  for (let i = Math.max(0, from); i < toks.length; i++) if (toks[i].type !== 'ws' && toks[i].type !== 'comment') return i;
  return -1;
}

const isIdent = (t: SqlTok | undefined): t is SqlTok => !!t && (t.type === 'qid' || t.type === 'word');
const isPunct = (t: SqlTok | undefined, p: string): boolean => !!t && t.type === 'punct' && t.text === p;

interface Rep {
  start: number;
  end: number;
  text: string;
}

function applyReps(sql: string, reps: Rep[]): string {
  if (!reps.length) return sql;
  const sorted = [...reps].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos) continue;
    out += sql.slice(pos, r.start) + r.text;
    pos = r.end;
  }
  return out + sql.slice(pos);
}

const OBJECT_KW = new Set(['TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'EVENT']);

/** Index of the object keyword of a CREATE statement (first VIEW / FUNCTION / … word). */
function objectKeywordIndex(toks: SqlTok[]): number {
  let significant = 0;
  for (let i = 0; i < toks.length && significant < 80; i++) {
    const t = toks[i];
    if (t.type === 'ws' || t.type === 'comment') continue;
    significant++;
    if (t.type === 'word' && OBJECT_KW.has(t.text.toUpperCase())) return i;
  }
  return -1;
}

/** Object keyword (upper case) of a CREATE statement, '' if none. */
export function createObjectKeyword(sql: string): string {
  const toks = tokenizeSqlText(sql);
  const i = objectKeywordIndex(toks);
  return i < 0 ? '' : toks[i].text.toUpperCase();
}

/** Last token index of an account (user@host or CURRENT_USER[()]) starting at token j, -1 if not an account. */
function accountEnd(toks: SqlTok[], j: number): number {
  const t = toks[j];
  if (!t) return -1;
  if (t.type === 'word' && t.text.toUpperCase() === 'CURRENT_USER') {
    if (isPunct(toks[j + 1], '(') && isPunct(toks[j + 2], ')')) return j + 2;
    return j;
  }
  if (t.type !== 'qid' && t.type !== 'string' && t.type !== 'word') return -1;
  if (!isPunct(toks[j + 1], '@')) return j;
  let k = j + 2;
  const h = toks[k];
  if (!h) return -1;
  if (h.type === 'qid' || h.type === 'string') return k;
  while (k + 1 < toks.length && toks[k + 1].type !== 'ws' && toks[k + 1].type !== 'comment') k++;
  return k;
}

/** DEFINER value of a CREATE statement (e.g. `root`@`localhost`), '' if none. */
export function definerOf(sql: string): string {
  const toks = tokenizeSqlText(sql);
  const kw = objectKeywordIndex(toks);
  const limit = kw < 0 ? Math.min(toks.length, 120) : kw;
  for (let i = 0; i < limit; i++) {
    const t = toks[i];
    if (t.type !== 'word' || t.text.toUpperCase() !== 'DEFINER') continue;
    let j = nextSig(toks, i + 1);
    if (j < 0 || !isPunct(toks[j], '=')) continue;
    j = nextSig(toks, j + 1);
    const end = accountEnd(toks, j);
    if (end < 0) return '';
    return sql.slice(toks[j].start, toks[end].end);
  }
  return '';
}

/** Removes the DEFINER = … clause of a CREATE VIEW / FUNCTION / PROCEDURE / TRIGGER / EVENT statement. */
export function stripDefiner(sql: string): string {
  const toks = tokenizeSqlText(sql);
  const kw = objectKeywordIndex(toks);
  const limit = kw < 0 ? Math.min(toks.length, 120) : kw;
  for (let i = 0; i < limit; i++) {
    const t = toks[i];
    if (t.type !== 'word' || t.text.toUpperCase() !== 'DEFINER') continue;
    let j = nextSig(toks, i + 1);
    if (j < 0 || !isPunct(toks[j], '=')) continue;
    j = nextSig(toks, j + 1);
    const end = accountEnd(toks, j);
    if (end < 0) return sql;
    let stop = toks[end].end;
    for (let k = end + 1; k < toks.length && toks[k].type === 'ws'; k++) stop = toks[k].end;
    return sql.slice(0, t.start) + sql.slice(stop);
  }
  return sql;
}

/** Identifier (optionally qualified: a.b) starting at token i */
function identSpan(toks: SqlTok[], i: number): { first: number; last: number; parts: string[] } | null {
  const t = toks[i];
  if (i < 0 || !isIdent(t)) return null;
  const n2 = toks[i + 2];
  if (isPunct(toks[i + 1], '.') && isIdent(n2)) return { first: i, last: i + 2, parts: [identText(t), identText(n2)] };
  return { first: i, last: i, parts: [identText(t)] };
}

/**
 * Replaces the name of the created object with `schema`.`name` (just `name` when schema is empty).
 * For triggers pass `table`: the table after ON is replaced the same way.
 */
export function renameCreate(sql: string, schema: string, name: string, table?: string): string {
  const toks = tokenizeSqlText(sql);
  const kw = objectKeywordIndex(toks);
  if (kw < 0) return sql;
  const id = identSpan(toks, nextSig(toks, kw + 1));
  if (!id) return sql;
  const reps: Rep[] = [{ start: toks[id.first].start, end: toks[id.last].end, text: schema ? qname(schema, name) : quoteId(name) }];
  if (table !== undefined) {
    for (let i = id.last + 1; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'word' && t.text.toUpperCase() === 'ON') {
        const ts = identSpan(toks, nextSig(toks, i + 1));
        if (ts) reps.push({ start: toks[ts.first].start, end: toks[ts.last].end, text: schema ? qname(schema, table) : quoteId(table) });
        break;
      }
    }
  }
  return applyReps(sql, reps);
}

/** Name parts of the created object (['schema', 'name'] or ['name']) */
export function createdObjectName(sql: string): string[] {
  const toks = tokenizeSqlText(sql);
  const kw = objectKeywordIndex(toks);
  if (kw < 0) return [];
  return identSpan(toks, nextSig(toks, kw + 1))?.parts ?? [];
}

export interface RequalifyOptions {
  /** Maps the object name that follows the schema (e.g. renamed / case converted tables) */
  mapName?: (name: string) => string;
  /** Compare schema names case-insensitively (default true) */
  caseInsensitive?: boolean;
}

/**
 * Replaces qualified references `from`.`x` with `to`.`x` (or removes the qualifier when `to` is empty).
 * Works for quoted and unquoted identifiers; strings and comments are left alone.
 */
export function requalify(sql: string, from: string, to: string, opts: RequalifyOptions = {}): string {
  if (!from) return sql;
  const ci = opts.caseInsensitive !== false;
  const eq = (a: string) => (ci ? a.toLowerCase() === from.toLowerCase() : a === from);
  const toks = tokenizeSqlText(sql);
  const reps: Rep[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!isIdent(t) || !eq(identText(t))) continue;
    const prev = toks[i - 1];
    if (isPunct(prev, '.') || isPunct(prev, '@')) continue;
    const dot = toks[i + 1];
    const next = toks[i + 2];
    if (!isPunct(dot, '.') || !isIdent(next)) continue;
    if (to) reps.push({ start: t.start, end: t.end, text: quoteId(to) });
    else reps.push({ start: t.start, end: dot.end, text: '' });
    if (opts.mapName) {
      const name = identText(next);
      const mapped = opts.mapName(name);
      if (mapped !== name) reps.push({ start: next.start, end: next.end, text: quoteId(mapped) });
    }
    i += 2;
  }
  return applyReps(sql, reps);
}

/** Names referenced as `schema`.`name` in a statement (used for view dependency order). */
export function qualifiedRefs(sql: string, schema: string): Set<string> {
  const out = new Set<string>();
  const toks = tokenizeSqlText(sql);
  const s = schema.toLowerCase();
  for (let i = 0; i + 2 < toks.length; i++) {
    const t = toks[i];
    if (!isIdent(t) || identText(t).toLowerCase() !== s) continue;
    if (isPunct(toks[i - 1], '.')) continue;
    if (isPunct(toks[i + 1], '.') && isIdent(toks[i + 2])) out.add(identText(toks[i + 2]).toLowerCase());
  }
  return out;
}

/** CREATE … → CREATE OR REPLACE … (views) */
export function withOrReplace(sql: string): string {
  const toks = tokenizeSqlText(sql);
  const i = nextSig(toks, 0);
  if (i < 0 || toks[i].type !== 'word' || toks[i].text.toUpperCase() !== 'CREATE') return sql;
  const j = nextSig(toks, i + 1);
  if (j >= 0 && toks[j].type === 'word' && toks[j].text.toUpperCase() === 'OR') return sql;
  return `${sql.slice(0, toks[i].end)} OR REPLACE${sql.slice(toks[i].end)}`;
}

/** Stored programs (routines, triggers, events) need a DELIMITER in scripts. */
export function needsDelimiter(sql: string): boolean {
  const toks = tokenizeSqlText(sql);
  const i = nextSig(toks, 0);
  if (i < 0 || toks[i].type !== 'word' || toks[i].text.toUpperCase() !== 'CREATE') return false;
  const kw = createObjectKeyword(sql);
  return kw === 'FUNCTION' || kw === 'PROCEDURE' || kw === 'TRIGGER' || kw === 'EVENT';
}

/** Statement text for a script file (stored programs wrapped in DELIMITER ;;). */
export function scriptStatement(sql: string): string {
  const s = sql.trim().replace(/;+\s*$/, '');
  if (needsDelimiter(s)) return `DELIMITER ;;\n${s};;\nDELIMITER ;\n`;
  return `${s};\n`;
}

/** Line endings and trailing blanks normalized (for text comparisons). */
export function normalizeDdlText(sql: string): string {
  return sql
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

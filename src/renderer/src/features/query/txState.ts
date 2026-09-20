// Transaction state of a query tab session, tracked on the client from the executed statements
// (the server does not report it through the query API).

import { firstKeyword } from '@shared/sql/splitter';

export interface TxState {
  autocommit: boolean;
  /** a transaction is (probably) open on the session */
  open: boolean;
}

export interface ExecutedStatement {
  sql: string;
  ok: boolean;
  errno?: number;
}

/** Statements that commit an open transaction implicitly (MySQL / MariaDB). */
const IMPLICIT_COMMIT = new Set([
  'ALTER',
  'RENAME',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'LOCK',
  'UNLOCK',
  'ANALYZE',
  'CACHE',
  'CHECK',
  'FLUSH',
  'OPTIMIZE',
  'REPAIR',
  'RESET',
  'INSTALL',
  'UNINSTALL',
  'CHANGE',
  'STOP'
]);

/** Statements that start a transaction implicitly when autocommit is off. */
const DATA_STATEMENTS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CALL', 'WITH', 'TABLE', 'HANDLER', 'DO', 'VALUES', 'EXECUTE']);

const ER_LOCK_DEADLOCK = 1213;

/** Same length as the input: comments become spaces, quoted contents become '_' (quotes are kept). */
export function maskSql(sql: string): string {
  let out = '';
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
      const end = Math.min(j + 1, n);
      out += c + '_'.repeat(Math.max(0, end - i - 2)) + (end - i >= 2 ? sql[end - 1] : '');
      i = end;
      continue;
    }
    if (c === '#' || (c === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2])))) {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? n : e;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out += sql.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const AUTOCOMMIT_RE =
  /(?:^\s*SET\s+|,\s*)(GLOBAL\s+|PERSIST\s+|PERSIST_ONLY\s+|SESSION\s+|LOCAL\s+)?(@@(?:(GLOBAL|PERSIST|PERSIST_ONLY|SESSION|LOCAL)\.)?)?AUTOCOMMIT\s*:?=\s*('[^']*'|\w+)/gi;

/** New session autocommit value set by a SET statement (true / false), null when not touched. */
export function autocommitAssignment(sql: string): boolean | null {
  const masked = maskSql(sql);
  let result: boolean | null = null;
  AUTOCOMMIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AUTOCOMMIT_RE.exec(masked))) {
    const scope = (m[1] ?? m[3] ?? '').trim().toUpperCase();
    if (scope && scope !== 'SESSION' && scope !== 'LOCAL') continue;
    const end = m.index + m[0].length;
    const raw = sql.slice(end - m[4].length, end).replace(/'/g, '').trim().toUpperCase();
    if (raw === '1' || raw === 'ON' || raw === 'TRUE' || raw === 'DEFAULT') result = true;
    else if (raw === '0' || raw === 'OFF' || raw === 'FALSE') result = false;
  }
  return result;
}

const dataStatement = (s: TxState): TxState => (s.autocommit || s.open ? s : { ...s, open: true });

/** State after one executed statement. */
export function nextTxState(s: TxState, sql: string, ok: boolean, errno?: number): TxState {
  if (!ok) return errno === ER_LOCK_DEADLOCK ? { ...s, open: false } : s;
  const m = maskSql(sql);
  const kw = firstKeyword(m);
  const has = (re: RegExp) => re.test(m);
  switch (kw) {
    case 'START':
      return has(/^[\s(]*START\s+TRANSACTION\b/i) ? { ...s, open: true } : { ...s, open: false };
    case 'BEGIN':
      return has(/^[\s(]*BEGIN\s+NOT\s+ATOMIC\b/i) ? dataStatement(s) : { ...s, open: true };
    case 'COMMIT':
    case 'ROLLBACK':
      if (kw === 'ROLLBACK' && has(/^[\s(]*ROLLBACK\s+(WORK\s+)?TO\b/i)) return s;
      if (has(/\bAND\s+CHAIN\b/i) && !has(/\bAND\s+NO\s+CHAIN\b/i)) return { ...s, open: true };
      return { ...s, open: false };
    case 'SET': {
      if (has(/^[\s(]*SET\s+PASSWORD\b/i)) return { ...s, open: false };
      const ac = autocommitAssignment(sql);
      if (ac === null) return s;
      if (ac) return s.autocommit ? s : { autocommit: true, open: false };
      return { ...s, autocommit: false };
    }
    case 'CREATE':
    case 'DROP':
      return has(/^[\s(]*(CREATE|DROP)\s+TEMPORARY\b/i) ? s : { ...s, open: false };
    case 'LOAD':
      return has(/^[\s(]*LOAD\s+INDEX\b/i) ? { ...s, open: false } : dataStatement(s);
    default:
      if (IMPLICIT_COMMIT.has(kw)) return { ...s, open: false };
      if (DATA_STATEMENTS.has(kw)) return dataStatement(s);
      return s;
  }
}

export function foldTxState(s: TxState, statements: ExecutedStatement[]): TxState {
  return statements.reduce((acc, st) => nextTxState(acc, st.sql, st.ok, st.errno), s);
}

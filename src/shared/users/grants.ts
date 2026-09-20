// SHOW GRANTS parser and GRANT / REVOKE generation for privilege differences.

import type { AccountRef, PrivGrant, PrivLevel, PrivTarget, RoleGrant, UserStatement } from '../apis/users';
import { quoteId } from '../sql/quote';
import { GRANT_OPTION, compareTargets, comparePrivs, grantOptionApplies, isDynamicName, normalizeGrants, sortPrivs, targetKey } from './privileges';

// ───────────────────────── tokenizer ─────────────────────────

type Tok = { t: 'word' | 'id' | 'str' | 'punct'; v: string };

const STR_ESC: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '`') {
      let v = '';
      i++;
      while (i < n) {
        if (s[i] === '`') {
          if (s[i + 1] === '`') {
            v += '`';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += s[i++];
      }
      out.push({ t: 'id', v });
      continue;
    }
    if (c === "'" || c === '"') {
      let v = '';
      i++;
      while (i < n) {
        const d = s[i];
        if (d === '\\' && i + 1 < n) {
          v += STR_ESC[s[i + 1]] ?? s[i + 1];
          i += 2;
          continue;
        }
        if (d === c) {
          if (s[i + 1] === c) {
            v += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += d;
        i++;
      }
      out.push({ t: 'str', v });
      continue;
    }
    if (c === ',' || c === '(' || c === ')' || c === '.' || c === '@') {
      out.push({ t: 'punct', v: c });
      i++;
      continue;
    }
    let j = i;
    while (j < n && !' \t\n\r,().@`\'"'.includes(s[j])) j++;
    out.push({ t: 'word', v: s.slice(i, j) });
    i = j;
  }
  return out;
}

const isWord = (t: Tok | undefined, w: string) => !!t && t.t === 'word' && t.v.toUpperCase() === w;
const isPunct = (t: Tok | undefined, p: string) => !!t && t.t === 'punct' && t.v === p;

/** account at position i: name [@ host]; returns the account and the next position */
function readAccount(toks: Tok[], i: number): { acct: AccountRef; next: number } | null {
  const a = toks[i];
  if (!a || a.t === 'punct') return null;
  if (isPunct(toks[i + 1], '@')) {
    const h = toks[i + 2];
    if (!h || h.t === 'punct') return null;
    return { acct: { user: a.v, host: h.v }, next: i + 3 };
  }
  return { acct: { user: a.v, host: '' }, next: i + 1 };
}

function hasSequence(toks: Tok[], from: number, words: string[]): boolean {
  for (let i = from; i + words.length <= toks.length; i++) {
    if (words.every((w, k) => isWord(toks[i + k], w))) return true;
  }
  return false;
}

interface PrivItem {
  name: string;
  columns: string[] | null;
}

export interface ParsedGrants {
  grants: PrivGrant[];
  /** Roles granted to the account */
  roles: RoleGrant[];
}

function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.user === b.user && a.host.toLowerCase() === b.host.toLowerCase();
}

/**
 * Parses SHOW GRANTS output of one account (MySQL 5.7 / 8.x, MariaDB 10.x / 11.x).
 * `expandAll(level)` returns the privileges of "ALL PRIVILEGES" on a level.
 * Lines of other grantees, PROXY grants, partial revokes and SET DEFAULT ROLE lines are ignored.
 */
export function parseShowGrants(lines: string[], account: AccountRef, expandAll: (level: PrivLevel) => string[]): ParsedGrants {
  const grants: PrivGrant[] = [];
  const roles: RoleGrant[] = [];
  for (const line of lines) {
    const toks = tokenize(line);
    if (!isWord(toks[0], 'GRANT')) continue;
    // find the first top-level ON / TO
    let k = 1;
    let depth = 0;
    for (; k < toks.length; k++) {
      const t = toks[k];
      if (isPunct(t, '(')) depth++;
      else if (isPunct(t, ')')) depth--;
      else if (depth === 0 && (isWord(t, 'ON') || isWord(t, 'TO'))) break;
    }
    if (k >= toks.length) continue;

    if (isWord(toks[k], 'TO')) {
      // role grant: GRANT r1, r2 TO acct [WITH ADMIN OPTION]
      const g = readAccount(toks, k + 1);
      if (!g || !sameAccount(g.acct, account)) continue;
      const admin = hasSequence(toks, g.next, ['WITH', 'ADMIN', 'OPTION']);
      let i = 1;
      while (i < k) {
        const r = readAccount(toks, i);
        if (!r) {
          i++;
          continue;
        }
        roles.push({ ...r.acct, admin });
        i = r.next;
        if (isPunct(toks[i], ',')) i++;
      }
      continue;
    }

    // privilege items
    const items: PrivItem[] = [];
    let words: string[] = [];
    let cols: string[] | null = null;
    const flush = () => {
      if (words.length) items.push({ name: words.join(' ').toUpperCase(), columns: cols });
      words = [];
      cols = null;
    };
    for (let i = 1; i < k; i++) {
      const t = toks[i];
      if (isPunct(t, ',')) {
        flush();
      } else if (isPunct(t, '(')) {
        cols = [];
        for (i++; i < k && !isPunct(toks[i], ')'); i++) {
          if (toks[i].t !== 'punct') cols.push(toks[i].v);
        }
      } else if (t.t === 'word') {
        words.push(t.v);
      }
    }
    flush();
    if (items.some((it) => it.name === 'PROXY')) continue;

    // target: [FUNCTION|PROCEDURE|TABLE] db.name | db.* | *.*
    let p = k + 1;
    let routineType: PrivTarget['routineType'] = '';
    if (isWord(toks[p], 'FUNCTION') || isWord(toks[p], 'PROCEDURE')) {
      routineType = toks[p].v.toUpperCase() as 'FUNCTION' | 'PROCEDURE';
      p++;
    } else if (isWord(toks[p], 'TABLE')) {
      p++;
    }
    const first = toks[p];
    if (!first || first.t === 'punct') continue;
    let db = '';
    let name = '';
    let level: PrivLevel;
    if (isPunct(toks[p + 1], '.')) {
      const second = toks[p + 2];
      if (!second) continue;
      const firstStar = first.t === 'word' && first.v === '*';
      const secondStar = second.t === 'word' && second.v === '*';
      if (firstStar && secondStar) level = 'global';
      else if (secondStar) {
        level = 'database';
        db = first.v;
      } else {
        level = routineType ? 'routine' : 'table';
        db = first.v;
        name = second.v;
      }
      p += 3;
    } else if (first.t === 'word' && first.v === '*') {
      // "ON *" = current database; not produced by SHOW GRANTS
      continue;
    } else {
      continue;
    }
    if (!isWord(toks[p], 'TO')) continue;
    const g = readAccount(toks, p + 1);
    if (!g || !sameAccount(g.acct, account)) continue;
    const withGrant = hasSequence(toks, g.next, ['WITH', 'GRANT', 'OPTION']);

    const target: PrivTarget = { level, db, name, column: '', routineType: level === 'routine' ? routineType : '' };
    const objPrivs: string[] = [];
    for (const it of items) {
      if (it.columns && (level === 'table' || level === 'routine')) {
        for (const c of it.columns) grants.push({ level: 'column', db, name, column: c, routineType: '', privs: [it.name] });
        continue;
      }
      if (it.name === 'USAGE') continue;
      if (it.name === 'ALL' || it.name === 'ALL PRIVILEGES') objPrivs.push(...expandAll(level));
      else objPrivs.push(it.name);
    }
    if (withGrant && grantOptionApplies(level)) {
      // MySQL lists dynamic global privileges in their own line; the level's grant option is taken from the static line
      const onlyDynamic = level === 'global' && items.length > 0 && items.every((it) => !it.columns && isDynamicName(it.name));
      if (!onlyDynamic) objPrivs.push(GRANT_OPTION);
    }
    if (objPrivs.length) grants.push({ ...target, privs: objPrivs });
  }
  return { grants: normalizeGrants(grants), roles: dedupeRoles(roles) };
}

function dedupeRoles(list: RoleGrant[]): RoleGrant[] {
  const map = new Map<string, RoleGrant>();
  for (const r of list) {
    const k = `${r.user}@${r.host}`;
    const cur = map.get(k);
    map.set(k, cur ? { ...cur, admin: cur.admin || r.admin } : r);
  }
  return [...map.values()];
}

// ───────────────────────── SQL generation ─────────────────────────

/** ON clause of a grant target */
export function targetSql(t: PrivTarget): string {
  switch (t.level) {
    case 'global':
      return '*.*';
    case 'database':
      return `${quoteId(t.db)}.*`;
    case 'routine':
      return `${t.routineType || 'PROCEDURE'} ${quoteId(t.db)}.${quoteId(t.name)}`;
    default:
      return `${quoteId(t.db)}.${quoteId(t.name)}`;
  }
}

export interface GrantChange {
  target: PrivTarget;
  added: string[];
  removed: string[];
}

export function diffGrants(orig: PrivGrant[], cur: PrivGrant[]): GrantChange[] {
  const o = new Map(normalizeGrants(orig).map((g) => [targetKey(g), g]));
  const c = new Map(normalizeGrants(cur).map((g) => [targetKey(g), g]));
  const keys = new Set([...o.keys(), ...c.keys()]);
  const out: GrantChange[] = [];
  for (const k of keys) {
    const a = new Set(o.get(k)?.privs ?? []);
    const b = new Set(c.get(k)?.privs ?? []);
    const added = sortPrivs([...b].filter((x) => !a.has(x)));
    const removed = sortPrivs([...a].filter((x) => !b.has(x)));
    if (!added.length && !removed.length) continue;
    const g = (c.get(k) ?? o.get(k))!;
    out.push({ target: { level: g.level, db: g.db, name: g.name, column: g.column, routineType: g.routineType }, added, removed });
  }
  return out.sort((x, y) => compareTargets(x.target, y.target));
}

function columnList(byPriv: Map<string, string[]>): string {
  return [...byPriv.entries()]
    .sort((a, b) => comparePrivs(a[0], b[0]))
    .map(([p, cols]) => `${p} (${cols.map(quoteId).join(', ')})`)
    .join(', ');
}

/**
 * GRANT / REVOKE statements that turn `orig` into `cur` for one account.
 * REVOKE statements come first. Column privileges are combined per table.
 */
export function grantStatements(account: string, orig: PrivGrant[], cur: PrivGrant[], serverType: 'mysql' | 'mariadb'): UserStatement[] {
  const changes = diffGrants(orig, cur);
  const revokes: string[] = [];
  const grants: string[] = [];
  // column level: table → privilege → columns
  const colRevoke = new Map<string, { t: PrivTarget; m: Map<string, string[]> }>();
  const colGrant = new Map<string, { t: PrivTarget; m: Map<string, string[]> }>();
  const addCol = (map: typeof colRevoke, t: PrivTarget, privs: string[]) => {
    const tableKey = `${t.db}|${t.name}`;
    let e = map.get(tableKey);
    if (!e) {
      e = { t: { level: 'table', db: t.db, name: t.name, column: '', routineType: '' }, m: new Map() };
      map.set(tableKey, e);
    }
    for (const p of privs) {
      const cols = e.m.get(p) ?? [];
      if (!cols.includes(t.column)) cols.push(t.column);
      e.m.set(p, cols);
    }
  };
  // the server drops column privileges together with a revoked table privilege of the same type
  const tableRevoked = new Map<string, Set<string>>();
  for (const ch of changes) {
    if (ch.target.level !== 'table') continue;
    const lost = ch.removed.filter((p) => p !== GRANT_OPTION);
    if (lost.length) tableRevoked.set(`${ch.target.db}|${ch.target.name}`, new Set(lost));
  }
  for (const cg of normalizeGrants(cur)) {
    const lost = cg.level === 'column' ? tableRevoked.get(`${cg.db}|${cg.name}`) : undefined;
    const again = lost ? cg.privs.filter((p) => lost.has(p)) : [];
    if (again.length) addCol(colGrant, cg, again);
  }
  for (const ch of changes) {
    const t = ch.target;
    if (t.level === 'column') {
      const covered = tableRevoked.get(`${t.db}|${t.name}`);
      const rem = ch.removed.filter((p) => p !== GRANT_OPTION && !covered?.has(p));
      const add = ch.added.filter((p) => p !== GRANT_OPTION);
      if (rem.length) addCol(colRevoke, t, rem);
      if (add.length) addCol(colGrant, t, add);
      continue;
    }
    const on = targetSql(t);
    if (ch.removed.length) revokes.push(`REVOKE ${ch.removed.join(', ')} ON ${on} FROM ${account}`);
    const addPrivs = ch.added.filter((p) => p !== GRANT_OPTION);
    const addGo = ch.added.includes(GRANT_OPTION) && grantOptionApplies(t.level);
    if (addPrivs.length) grants.push(`GRANT ${addPrivs.join(', ')} ON ${on} TO ${account}${addGo ? ' WITH GRANT OPTION' : ''}`);
    else if (addGo) {
      grants.push(serverType === 'mysql' ? `GRANT GRANT OPTION ON ${on} TO ${account}` : `GRANT USAGE ON ${on} TO ${account} WITH GRANT OPTION`);
    }
  }
  for (const { t, m } of colRevoke.values()) revokes.push(`REVOKE ${columnList(m)} ON ${targetSql(t)} FROM ${account}`);
  for (const { t, m } of colGrant.values()) grants.push(`GRANT ${columnList(m)} ON ${targetSql(t)} TO ${account}`);
  return [...revokes, ...grants].map((sql) => ({ sql, display: sql }));
}

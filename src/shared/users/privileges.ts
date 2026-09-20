// Privilege catalog helpers: SHOW PRIVILEGES rows → privilege definitions with their grant levels.

import type { PrivGrant, PrivilegeDef, PrivLevel, PrivTarget } from '../apis/users';

export const GRANT_OPTION = 'GRANT OPTION';

const DB_LEVEL = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'REFERENCES', 'INDEX', 'ALTER', 'CREATE TEMPORARY TABLES',
  'LOCK TABLES', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'EVENT', 'TRIGGER',
  'DELETE HISTORY', 'SHOW CREATE ROUTINE'
]);
const TABLE_LEVEL = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'REFERENCES', 'INDEX', 'ALTER', 'CREATE VIEW', 'SHOW VIEW',
  'TRIGGER', 'DELETE HISTORY'
]);
const COLUMN_LEVEL = new Set(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']);
const ROUTINE_LEVEL = new Set(['EXECUTE', 'ALTER ROUTINE', 'SHOW CREATE ROUTINE']);
/** Entries of SHOW PRIVILEGES that are not ordinary privileges */
const SKIP = new Set(['USAGE', 'PROXY', GRANT_OPTION]);

/** Display order of object privileges (database / table / column / routine level) */
export const OBJECT_PRIV_ORDER = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW',
  'TRIGGER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'EVENT',
  'DELETE HISTORY', 'SHOW CREATE ROUTINE'
];

export const LEVEL_ORDER: PrivLevel[] = ['global', 'database', 'table', 'column', 'routine'];

/** Dynamic privileges (MySQL 8) are reported in upper case with underscores, static ones capitalized. */
export function isDynamicName(name: string): boolean {
  return /^[A-Z0-9_]+$/.test(name) && name.includes('_');
}

export function levelsOf(name: string, context: string, dynamic: boolean): PrivLevel[] {
  const levels: PrivLevel[] = ['global'];
  if (dynamic) return levels;
  const known = DB_LEVEL.has(name) || TABLE_LEVEL.has(name) || ROUTINE_LEVEL.has(name);
  if (known) {
    if (DB_LEVEL.has(name)) levels.push('database');
    if (TABLE_LEVEL.has(name)) levels.push('table');
    if (COLUMN_LEVEL.has(name)) levels.push('column');
    if (ROUTINE_LEVEL.has(name)) levels.push('routine');
    return levels;
  }
  // unknown static privilege of a newer server version: derive the levels from the context text
  const c = context.toLowerCase();
  const tables = c.includes('tables');
  const routines = c.includes('functions') || c.includes('procedures');
  if (tables || routines || c.includes('databases')) levels.push('database');
  if (tables) levels.push('table');
  if (routines) levels.push('routine');
  return levels;
}

export interface ShowPrivilegesRow {
  privilege: string;
  context: string;
  comment: string;
}

export function buildPrivilegeDefs(rows: ShowPrivilegesRow[]): PrivilegeDef[] {
  const out: PrivilegeDef[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const raw = r.privilege.trim();
    const name = raw.toUpperCase();
    if (!name || SKIP.has(name) || seen.has(name)) continue;
    seen.add(name);
    const dynamic = /^[A-Z0-9_]+$/.test(raw) && raw.includes('_');
    out.push({ name, context: r.context, comment: r.comment, dynamic, levels: levelsOf(name, r.context, dynamic) });
  }
  return out;
}

function orderIndex(name: string): number {
  const i = OBJECT_PRIV_ORDER.indexOf(name);
  return i < 0 ? 1000 : i;
}

/** Stable privilege order: known object privileges first, then static, then dynamic ones alphabetically. */
export function comparePrivs(a: string, b: string): number {
  if (a === GRANT_OPTION) return b === GRANT_OPTION ? 0 : 1;
  if (b === GRANT_OPTION) return -1;
  const d = orderIndex(a) - orderIndex(b);
  if (d) return d;
  const da = isDynamicName(a) ? 1 : 0;
  const db = isDynamicName(b) ? 1 : 0;
  if (da !== db) return da - db;
  return a.localeCompare(b);
}

export function sortPrivs(privs: Iterable<string>): string[] {
  return [...new Set(privs)].sort(comparePrivs);
}

/** Privileges (without GRANT OPTION) that can be granted on a level */
export function privsForLevel(defs: PrivilegeDef[], level: PrivLevel): string[] {
  const names = defs.filter((d) => d.levels.includes(level)).map((d) => d.name);
  if (level === 'global') {
    const stat = names.filter((n) => !defs.find((d) => d.name === n)?.dynamic);
    const dyn = names.filter((n) => defs.find((d) => d.name === n)?.dynamic).sort((a, b) => a.localeCompare(b));
    return [...stat, ...dyn];
  }
  return names.sort(comparePrivs);
}

export function grantOptionApplies(level: PrivLevel): boolean {
  return level !== 'column';
}

/** Target of a grant as key (level|db|name|column|routine type) */
export function targetKey(t: PrivTarget): string {
  return `${t.level}|${t.db}|${t.name}|${t.column}|${t.routineType}`;
}

export function compareTargets(a: PrivTarget, b: PrivTarget): number {
  return (
    LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) ||
    a.db.localeCompare(b.db) ||
    a.name.localeCompare(b.name) ||
    a.routineType.localeCompare(b.routineType) ||
    a.column.localeCompare(b.column)
  );
}

export function makeTarget(level: PrivLevel, db = '', name = '', column = '', routineType: PrivTarget['routineType'] = ''): PrivTarget {
  return { level, db: level === 'global' ? '' : db, name: level === 'global' || level === 'database' ? '' : name, column: level === 'column' ? column : '', routineType: level === 'routine' ? routineType : '' };
}

/** Database patterns in grants escape _ and % with a backslash (`ks\_shop`); returns the plain name. */
export function unescapeDbPattern(db: string): string {
  return db.replace(/\\([_%\\])/g, '$1');
}

/** The database pattern contains an unescaped % (matches several databases) */
export function isDbWildcard(db: string): boolean {
  for (let i = 0; i < db.length; i++) {
    if (db[i] === '\\') i++;
    else if (db[i] === '%') return true;
  }
  return false;
}

/** Does a grant target (database pattern as stored) refer to the given database? */
export function dbMatches(pattern: string, database: string): boolean {
  return pattern === database || unescapeDbPattern(pattern) === database;
}

/** Normalizes a grant list: merges duplicate targets, removes empty entries, sorts. */
export function normalizeGrants(list: PrivGrant[]): PrivGrant[] {
  const map = new Map<string, PrivGrant>();
  for (const g of list) {
    const k = targetKey(g);
    const cur = map.get(k);
    if (cur) cur.privs = sortPrivs([...cur.privs, ...g.privs]);
    else map.set(k, { ...g, privs: sortPrivs(g.privs) });
  }
  return [...map.values()].filter((g) => g.privs.length > 0).sort(compareTargets);
}

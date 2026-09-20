// User, role and privilege management (MySQL 5.7 / 8.x, MariaDB 10.x / 11.x).
// Account properties come from mysql.user (+ mysql.global_priv on MariaDB), privileges from SHOW GRANTS,
// role edges from mysql.role_edges / mysql.default_roles (MySQL) or mysql.roles_mapping (MariaDB).

import type {
  AccountDetails,
  AccountGrants,
  AccountRef,
  AccountSummary,
  PrivilegeDef,
  RoleGrant,
  SslRequire,
  UsersApi,
  UsersServerInfo
} from '@shared/apis/users';
import { tr } from '@shared/i18n';
import { quoteId, quoteString } from '@shared/sql/quote';
import { parseShowGrants } from '@shared/users/grants';
import { buildPrivilegeDefs, privsForLevel } from '@shared/users/privileges';
import { accountLabel, maskSecret } from '@shared/users/statements';
import type { BackendContext } from '../api';
import type { Session } from '../db/sessions';
import { KsError, toSqlError } from '../errors';

type Row = Record<string, unknown>;

function col(r: Row, name: string): unknown {
  if (name in r) return r[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(r)) if (k.toLowerCase() === lower) return r[k];
  return undefined;
}

const str = (v: unknown): string =>
  v === null || v === undefined ? '' : v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v);
const num = (v: unknown): number => {
  const x = Number(str(v));
  return Number.isFinite(x) ? x : 0;
};
const yes = (v: unknown): boolean => str(v).toUpperCase() === 'Y';
const nullableNum = (v: unknown): number | null => (v === null || v === undefined || str(v) === '' ? null : num(v));

const MYSQL_SYSTEM = new Set(['mysql.sys', 'mysql.session', 'mysql.infoschema']);

function isSystemAccount(user: string, host: string, maria: boolean): boolean {
  if (host.toLowerCase() !== 'localhost') return false;
  return maria ? user === 'mariadb.sys' : MYSQL_SYSTEM.has(user);
}

function parseJson(v: unknown): Record<string, unknown> | null {
  const s = str(v);
  if (!s) return null;
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function commentOf(attrs: Record<string, unknown> | null): string {
  const meta = attrs?.metadata;
  if (meta && typeof meta === 'object') return str((meta as Record<string, unknown>).comment);
  return '';
}

const isMaria = (s: Session) => s.server.type === 'mariadb';

async function privilegeCatalog(s: Session): Promise<PrivilegeDef[]> {
  const r = await s.rowset('SHOW PRIVILEGES');
  return buildPrivilegeDefs(r.rows.map((row) => ({ privilege: str(row[0]), context: str(row[1]), comment: str(row[2]) })));
}

async function defaultPlugin(s: Session): Promise<string> {
  if (isMaria(s)) return 'mysql_native_password';
  try {
    const r = await s.rows<Row>('SELECT @@default_authentication_plugin AS p');
    const p = str(r[0]?.p);
    if (p) return p;
  } catch {
    // variable removed in MySQL 8.4
  }
  try {
    const r = await s.rows<Row>('SELECT @@authentication_policy AS p');
    const first = str(r[0]?.p).split(',')[0].trim().replace(/^\*:?/, '');
    if (first) return first;
  } catch {
    // MySQL < 8.0.27
  }
  return s.server.versionNumber >= 80000 ? 'caching_sha2_password' : 'mysql_native_password';
}

async function serverInfo(s: Session): Promise<UsersServerInfo> {
  const maria = isMaria(s);
  const v = s.server.versionNumber;
  const privileges = await privilegeCatalog(s);
  let plugins: string[] = [];
  try {
    const rows = await s.rows<Row>(
      "SELECT PLUGIN_NAME AS name FROM information_schema.PLUGINS WHERE PLUGIN_TYPE = 'AUTHENTICATION' AND PLUGIN_STATUS = 'ACTIVE' ORDER BY PLUGIN_NAME"
    );
    plugins = rows.map((r) => str(r.name)).filter(Boolean);
  } catch {
    plugins = [];
  }
  const def = await defaultPlugin(s);
  if (maria && !plugins.includes('mysql_native_password')) plugins.unshift('mysql_native_password');
  if (def && !plugins.includes(def)) plugins.unshift(def);
  const cur = await s.rows<Row>('SELECT CURRENT_USER() AS u');
  return {
    serverType: maria ? 'mariadb' : 'mysql',
    version: v,
    roles: maria ? v >= 100005 : v >= 80000,
    defaultRoles: maria ? (v >= 100100 ? 'single' : 'none') : v >= 80000 ? 'multi' : 'none',
    roleHost: !maria,
    renameRole: !maria,
    accountLock: maria ? v >= 100402 : v >= 50706,
    passwordExpire: maria ? v >= 100403 : v >= 50706,
    passwordOptions: !maria && v >= 80013,
    failedLogin: !maria && v >= 80019,
    comment: !maria && v >= 80021,
    maxStatementTime: maria && v >= 100100,
    plugins,
    defaultPlugin: def,
    privileges,
    currentUser: str(cur[0]?.u)
  };
}

async function roleEdgeSources(s: Session): Promise<Set<string>> {
  if (isMaria(s) || s.server.versionNumber < 80000) return new Set();
  try {
    const rows = await s.rows<Row>('SELECT DISTINCT FROM_USER AS u, FROM_HOST AS h FROM mysql.role_edges');
    return new Set(rows.map((r) => `${str(r.u)}@${str(r.h).toLowerCase()}`));
  } catch {
    return new Set();
  }
}

async function mariaLocks(s: Session, user?: string, host?: string): Promise<Map<string, { locked: boolean; lifetime: number | null }>> {
  const map = new Map<string, { locked: boolean; lifetime: number | null }>();
  try {
    const where = user !== undefined ? ' WHERE User = ? AND Host = ?' : '';
    const rows = await s.rows<Row>(
      `SELECT User AS u, Host AS h, JSON_VALUE(Priv, '$.account_locked') AS l, JSON_VALUE(Priv, '$.password_lifetime') AS p FROM mysql.global_priv${where}`,
      user !== undefined ? [user, host] : undefined
    );
    for (const r of rows) {
      const p = str(r.p);
      map.set(`${str(r.u)}@${str(r.h).toLowerCase()}`, {
        locked: ['true', '1'].includes(str(r.l).toLowerCase()),
        lifetime: p === '' || Number(p) < 0 ? null : Number(p)
      });
    }
  } catch {
    // MariaDB < 10.4 (no global_priv) or missing privilege
  }
  return map;
}

async function listAccounts(s: Session): Promise<AccountSummary[]> {
  const maria = isMaria(s);
  const rows = await s.rows<Row>('SELECT * FROM mysql.user');
  const sources = await roleEdgeSources(s);
  const locks = maria ? await mariaLocks(s) : new Map<string, { locked: boolean; lifetime: number | null }>();
  return rows
    .map((r) => {
      const user = str(col(r, 'User'));
      const host = str(col(r, 'Host'));
      const key = `${user}@${host.toLowerCase()}`;
      const auth = str(col(r, 'authentication_string')) || (maria ? str(col(r, 'Password')) : '');
      const locked = maria ? (locks.get(key)?.locked ?? false) : yes(col(r, 'account_locked'));
      const expired = yes(col(r, 'password_expired'));
      const isRole = maria ? yes(col(r, 'is_role')) : (locked && expired && !auth) || (!auth && sources.has(key));
      return {
        user,
        host,
        isRole,
        plugin: isRole ? '' : str(col(r, 'plugin')),
        locked: isRole ? false : locked,
        passwordExpired: isRole ? false : expired,
        comment: commentOf(parseJson(col(r, 'User_attributes'))),
        system: isSystemAccount(user, host, maria)
      };
    })
    .sort((a, b) => Number(a.isRole) - Number(b.isRole) || a.user.localeCompare(b.user) || a.host.localeCompare(b.host));
}

function accountLiteral(s: Session, a: AccountRef): string {
  return isMaria(s) && a.host === '' ? quoteId(a.user) : `${quoteString(a.user)}@${quoteString(a.host)}`;
}

async function showGrantsLines(s: Session, a: AccountRef): Promise<string[]> {
  const r = await s.rowset(`SHOW GRANTS FOR ${accountLiteral(s, a)}`);
  return r.rows.map((row) => str(row[0]));
}

async function loadDetails(s: Session, user: string, host: string): Promise<AccountDetails> {
  const maria = isMaria(s);
  const v = s.server.versionNumber;
  const rows = await s.rows<Row>('SELECT * FROM mysql.user WHERE User = ? AND Host = ?', [user, host]);
  if (!rows.length) {
    throw new KsError(tr('Das Konto „{a}“ wurde nicht gefunden.', 'The account "{a}" was not found.', { a: accountLabel({ user, host }) }), 'ACCOUNT_NOT_FOUND');
  }
  const r = rows[0];
  const auth = str(col(r, 'authentication_string')) || (maria ? str(col(r, 'Password')) : '');
  let locked = yes(col(r, 'account_locked'));
  let lifetime = nullableNum(col(r, 'password_lifetime'));
  if (maria) {
    const m = (await mariaLocks(s, user, host)).get(`${user}@${host.toLowerCase()}`);
    locked = m?.locked ?? false;
    lifetime = m?.lifetime ?? null;
  }
  const expired = yes(col(r, 'password_expired'));
  let isRole = maria ? yes(col(r, 'is_role')) : locked && expired && !auth;

  const ref: AccountRef = { user, host };
  const defs = await privilegeCatalog(s);
  const lines = await showGrantsLines(s, ref);
  const parsed = parseShowGrants(lines, ref, (level) => privsForLevel(defs, level));

  let roles: RoleGrant[] = parsed.roles;
  let members: RoleGrant[] = [];
  let defaultRoles: AccountRef[] = [];
  if (!maria && v >= 80000) {
    try {
      const e = await s.rows<Row>('SELECT FROM_USER AS u, FROM_HOST AS h, WITH_ADMIN_OPTION AS a FROM mysql.role_edges WHERE TO_USER = ? AND TO_HOST = ?', [user, host]);
      roles = e.map((x) => ({ user: str(x.u), host: str(x.h), admin: yes(x.a) }));
      const m = await s.rows<Row>('SELECT TO_USER AS u, TO_HOST AS h, WITH_ADMIN_OPTION AS a FROM mysql.role_edges WHERE FROM_USER = ? AND FROM_HOST = ?', [user, host]);
      members = m.map((x) => ({ user: str(x.u), host: str(x.h), admin: yes(x.a) }));
      const d = await s.rows<Row>('SELECT DEFAULT_ROLE_USER AS u, DEFAULT_ROLE_HOST AS h FROM mysql.default_roles WHERE USER = ? AND HOST = ?', [user, host]);
      defaultRoles = d.map((x) => ({ user: str(x.u), host: str(x.h) }));
      if (!isRole && !auth && members.length) isRole = true;
    } catch {
      // no access to the role tables – keep the roles from SHOW GRANTS
    }
  } else if (maria && v >= 100005) {
    try {
      const e = await s.rows<Row>('SELECT Role AS r, Admin_option AS a FROM mysql.roles_mapping WHERE User = ? AND Host = ?', [user, host]);
      roles = e.map((x) => ({ user: str(x.r), host: '', admin: yes(x.a) }));
      if (isRole) {
        const m = await s.rows<Row>('SELECT User AS u, Host AS h, Admin_option AS a FROM mysql.roles_mapping WHERE Role = ?', [user]);
        members = m.map((x) => ({ user: str(x.u), host: str(x.h), admin: yes(x.a) }));
      }
    } catch {
      // keep the roles from SHOW GRANTS
    }
    const dr = str(col(r, 'default_role'));
    if (dr) defaultRoles = [{ user: dr, host: '' }];
  }

  const sslType = str(col(r, 'ssl_type')).toUpperCase();
  const ssl: SslRequire = sslType === 'ANY' ? 'SSL' : sslType === 'X509' ? 'X509' : sslType === 'SPECIFIED' ? 'SPECIFIED' : 'NONE';
  const attrs = parseJson(col(r, 'User_attributes'));
  const lockingRaw = attrs?.Password_locking;
  const locking = lockingRaw && typeof lockingRaw === 'object' ? (lockingRaw as Record<string, unknown>) : {};
  const requireCurrent = col(r, 'Password_require_current');
  return {
    user,
    host,
    isRole,
    plugin: isRole ? '' : str(col(r, 'plugin')),
    hasPassword: !!auth,
    passwordExpired: isRole ? false : expired,
    locked: isRole ? false : locked,
    expirePolicy: lifetime === null ? 'default' : lifetime === 0 ? 'never' : 'interval',
    expireDays: lifetime && lifetime > 0 ? lifetime : 90,
    maxQueries: num(col(r, 'max_questions')),
    maxUpdates: num(col(r, 'max_updates')),
    maxConnections: num(col(r, 'max_connections')),
    maxUserConnections: num(col(r, 'max_user_connections')),
    maxStatementTime: maria ? num(col(r, 'max_statement_time')) : 0,
    ssl,
    sslCipher: str(col(r, 'ssl_cipher')),
    x509Issuer: str(col(r, 'x509_issuer')),
    x509Subject: str(col(r, 'x509_subject')),
    comment: commentOf(attrs),
    passwordHistory: nullableNum(col(r, 'Password_reuse_history')),
    passwordReuseDays: nullableNum(col(r, 'Password_reuse_time')),
    requireCurrent: requireCurrent === null || requireCurrent === undefined || str(requireCurrent) === '' ? 'default' : yes(requireCurrent) ? 'required' : 'optional',
    failedLoginAttempts: num(locking.failed_login_attempts),
    passwordLockDays: num(locking.password_lock_time_days),
    roles,
    defaultRoles,
    members,
    grants: parsed.grants,
    showGrants: lines
  };
}

export function createUsersApi(ctx: BackendContext): UsersApi {
  const S = (id: string) => ctx.sessions.get(id);
  return {
    serverInfo: (sid) => serverInfo(S(sid)),
    list: (sid) => listAccounts(S(sid)),
    details: (sid, user, host) => loadDetails(S(sid), user, host),
    showGrants: (sid, user, host) => showGrantsLines(S(sid), { user, host }),
    allGrants: async (sid) => {
      const s = S(sid);
      const accounts = await listAccounts(s);
      const defs = await privilegeCatalog(s);
      const out: AccountGrants[] = [];
      for (const a of accounts) {
        const base = { user: a.user, host: a.host, isRole: a.isRole, system: a.system };
        try {
          const lines = await showGrantsLines(s, a);
          out.push({ ...base, grants: parseShowGrants(lines, a, (level) => privsForLevel(defs, level)).grants });
        } catch (e) {
          out.push({ ...base, grants: [], error: toSqlError(e).message });
        }
      }
      return out;
    },
    apply: async (sid, statements) => {
      const s = S(sid);
      const log = ctx.logFor(s);
      for (let i = 0; i < statements.length; i++) {
        const st = statements[i];
        const t0 = Date.now();
        try {
          await s.run(st.sql);
          log(st.display, true, Date.now() - t0);
        } catch (e) {
          const err = toSqlError(e, st.display);
          const error = { ...err, message: maskSecret(err.message, st) };
          log(st.display, false, Date.now() - t0, error.message);
          return { executed: i, error };
        }
      }
      return { executed: statements.length, error: null };
    }
  };
}

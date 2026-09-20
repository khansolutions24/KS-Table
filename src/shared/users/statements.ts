// CREATE / ALTER / RENAME / DROP statements for accounts and roles (MySQL 5.7+/8.x, MariaDB 10.x/11.x).
// The statements are generated from the difference between the loaded account and the edited draft.

import type { AccountModel, AccountRef, RoleGrant, UserStatement, UsersServerInfo } from '../apis/users';
import { tr } from '../i18n';
import { quoteId, quoteString } from '../sql/quote';
import { grantStatements } from './grants';
import { normalizeGrants } from './privileges';

export interface AccountDraft extends AccountModel {
  /** New password: null / '' = unchanged (a new account without password) */
  password: string | null;
  /** PASSWORD EXPIRE – the user has to change the password at the next login */
  expireNow: boolean;
}

export const PASSWORD_MASK = "'********'";

/** Authentication plugins that authenticate with a password */
export const PASSWORD_PLUGINS = new Set([
  'caching_sha2_password',
  'sha256_password',
  'mysql_native_password',
  'mysql_old_password',
  'ed25519',
  'parsec'
]);

type ServerKind = Pick<UsersServerInfo, 'serverType'>;

export function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.user === b.user && a.host.toLowerCase() === b.host.toLowerCase();
}

export function accountKey(a: AccountRef): string {
  return `${a.user}@${a.host.toLowerCase()}`;
}

/** user@host (MariaDB roles: name only) */
export function accountLabel(a: AccountRef): string {
  return a.host === '' ? a.user : `${a.user}@${a.host}`;
}

/** SQL literal of an account: 'user'@'host'; MariaDB roles as `role` */
export function accountSql(server: ServerKind, a: AccountRef, isRole?: boolean): string {
  if (server.serverType === 'mariadb' && (isRole || a.host === '')) return quoteId(a.user);
  return `${quoteString(a.user)}@${quoteString(a.host)}`;
}

export function newAccountModel(server: UsersServerInfo, isRole: boolean): AccountModel {
  return {
    user: '',
    host: isRole && !server.roleHost ? '' : '%',
    isRole,
    plugin: isRole ? '' : server.defaultPlugin,
    locked: false,
    expirePolicy: 'default',
    expireDays: 90,
    maxQueries: 0,
    maxUpdates: 0,
    maxConnections: 0,
    maxUserConnections: 0,
    maxStatementTime: 0,
    ssl: 'NONE',
    sslCipher: '',
    x509Issuer: '',
    x509Subject: '',
    comment: '',
    passwordHistory: null,
    passwordReuseDays: null,
    requireCurrent: 'default',
    failedLoginAttempts: 0,
    passwordLockDays: 0,
    roles: [],
    defaultRoles: [],
    members: [],
    grants: []
  };
}

export function draftOf(m: AccountModel): AccountDraft {
  return { ...structuredClone(m), password: null, expireNow: false };
}

// ───────────────────────── clauses ─────────────────────────

type Part = { sql: string; display: string };
const plain = (s: string): Part => ({ sql: s, display: s });

function pluginName(p: string): string {
  return /^[A-Za-z0-9_]+$/.test(p) ? p : quoteString(p);
}

const int = (v: number, max = 4294967295) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));

function authPart(server: UsersServerInfo, o: AccountModel | null, d: AccountDraft): Part | null {
  const pw = d.password ?? '';
  const plugin = d.plugin;
  const pluginChanged = !!o && plugin !== '' && plugin !== o.plugin;
  if (server.serverType === 'mysql') {
    if (pw !== '') {
      const head = plugin && (!o || pluginChanged) ? `IDENTIFIED WITH ${pluginName(plugin)} BY ` : 'IDENTIFIED BY ';
      return { sql: head + quoteString(pw), display: head + PASSWORD_MASK };
    }
    if ((!o && plugin && plugin !== server.defaultPlugin) || pluginChanged) return plain(`IDENTIFIED WITH ${pluginName(plugin)}`);
    return null;
  }
  const native = !plugin || plugin === 'mysql_native_password';
  if (pw !== '') {
    if (native) return { sql: `IDENTIFIED BY ${quoteString(pw)}`, display: `IDENTIFIED BY ${PASSWORD_MASK}` };
    const head = `IDENTIFIED VIA ${pluginName(plugin)} USING PASSWORD(`;
    return { sql: `${head}${quoteString(pw)})`, display: `${head}${PASSWORD_MASK})` };
  }
  if ((!o && !native) || pluginChanged) return plain(`IDENTIFIED VIA ${pluginName(plugin)}`);
  return null;
}

export function requireSql(d: AccountModel): string {
  switch (d.ssl) {
    case 'SSL':
      return 'REQUIRE SSL';
    case 'X509':
      return 'REQUIRE X509';
    case 'SPECIFIED': {
      const parts: string[] = [];
      if (d.sslCipher) parts.push(`CIPHER ${quoteString(d.sslCipher)}`);
      if (d.x509Issuer) parts.push(`ISSUER ${quoteString(d.x509Issuer)}`);
      if (d.x509Subject) parts.push(`SUBJECT ${quoteString(d.x509Subject)}`);
      return parts.length ? `REQUIRE ${parts.join(' AND ')}` : 'REQUIRE SSL';
    }
    default:
      return 'REQUIRE NONE';
  }
}

function sslChanged(o: AccountModel, d: AccountModel): boolean {
  if (o.ssl !== d.ssl) return true;
  return d.ssl === 'SPECIFIED' && (o.sslCipher !== d.sslCipher || o.x509Issuer !== d.x509Issuer || o.x509Subject !== d.x509Subject);
}

const RESOURCES: ['maxQueries' | 'maxUpdates' | 'maxConnections' | 'maxUserConnections', string][] = [
  ['maxQueries', 'MAX_QUERIES_PER_HOUR'],
  ['maxUpdates', 'MAX_UPDATES_PER_HOUR'],
  ['maxConnections', 'MAX_CONNECTIONS_PER_HOUR'],
  ['maxUserConnections', 'MAX_USER_CONNECTIONS']
];

function resourceSql(server: UsersServerInfo, o: AccountModel | null, d: AccountModel): string | null {
  const parts: string[] = [];
  for (const [k, kw] of RESOURCES) {
    const v = int(d[k]);
    if (o ? v !== o[k] : v > 0) parts.push(`${kw} ${v}`);
  }
  if (server.maxStatementTime) {
    const v = Math.max(0, Number(d.maxStatementTime) || 0);
    if (o ? v !== o.maxStatementTime : v > 0) parts.push(`MAX_STATEMENT_TIME ${v}`);
  }
  return parts.length ? `WITH ${parts.join(' ')}` : null;
}

function expireSql(d: AccountModel): string {
  if (d.expirePolicy === 'never') return 'PASSWORD EXPIRE NEVER';
  if (d.expirePolicy === 'interval') return `PASSWORD EXPIRE INTERVAL ${Math.max(1, int(d.expireDays, 65535))} DAY`;
  return 'PASSWORD EXPIRE DEFAULT';
}

function passwordOptionParts(server: UsersServerInfo, o: AccountModel | null, d: AccountModel): string[] {
  const out: string[] = [];
  if (server.passwordOptions) {
    if (o ? d.passwordHistory !== o.passwordHistory : d.passwordHistory !== null) {
      out.push(`PASSWORD HISTORY ${d.passwordHistory === null ? 'DEFAULT' : int(d.passwordHistory, 4294967295)}`);
    }
    if (o ? d.passwordReuseDays !== o.passwordReuseDays : d.passwordReuseDays !== null) {
      out.push(d.passwordReuseDays === null ? 'PASSWORD REUSE INTERVAL DEFAULT' : `PASSWORD REUSE INTERVAL ${int(d.passwordReuseDays)} DAY`);
    }
    if (o ? d.requireCurrent !== o.requireCurrent : d.requireCurrent !== 'default') {
      out.push(
        d.requireCurrent === 'required'
          ? 'PASSWORD REQUIRE CURRENT'
          : d.requireCurrent === 'optional'
            ? 'PASSWORD REQUIRE CURRENT OPTIONAL'
            : 'PASSWORD REQUIRE CURRENT DEFAULT'
      );
    }
  }
  if (server.failedLogin) {
    if (o ? d.failedLoginAttempts !== o.failedLoginAttempts : d.failedLoginAttempts > 0) {
      out.push(`FAILED_LOGIN_ATTEMPTS ${int(d.failedLoginAttempts, 32767)}`);
    }
    if (o ? d.passwordLockDays !== o.passwordLockDays : d.passwordLockDays !== 0) {
      out.push(`PASSWORD_LOCK_TIME ${d.passwordLockDays < 0 ? 'UNBOUNDED' : int(d.passwordLockDays, 32767)}`);
    }
  }
  return out;
}

function userOptionParts(server: UsersServerInfo, o: AccountModel | null, d: AccountDraft): Part[] {
  const parts: Part[] = [];
  const auth = authPart(server, o, d);
  if (auth) parts.push(auth);
  if (o ? sslChanged(o, d) : d.ssl !== 'NONE') parts.push(plain(requireSql(d)));
  const res = resourceSql(server, o, d);
  if (res) parts.push(plain(res));
  if (server.accountLock && (o ? o.locked !== d.locked : d.locked)) parts.push(plain(d.locked ? 'ACCOUNT LOCK' : 'ACCOUNT UNLOCK'));
  const expireChanged = o
    ? o.expirePolicy !== d.expirePolicy || (d.expirePolicy === 'interval' && o.expireDays !== d.expireDays)
    : d.expirePolicy !== 'default';
  if (server.passwordExpire && expireChanged) parts.push(plain(expireSql(d)));
  for (const p of passwordOptionParts(server, o, d)) parts.push(plain(p));
  if (server.comment && (o ? o.comment !== d.comment : d.comment !== '')) {
    parts.push(plain(d.comment ? `COMMENT ${quoteString(d.comment)}` : `ATTRIBUTE '{"comment": null}'`));
  }
  return parts;
}

function join(head: string, parts: Part[]): Part {
  return {
    sql: [head, ...parts.map((p) => p.sql)].join(' '),
    display: [head, ...parts.map((p) => p.display)].join(' ')
  };
}

// ───────────────────────── roles ─────────────────────────

function roleDiff(orig: RoleGrant[], cur: RoleGrant[]) {
  const o = new Map(orig.map((r) => [accountKey(r), r]));
  const c = new Map(cur.map((r) => [accountKey(r), r]));
  const removed: RoleGrant[] = [];
  const added: RoleGrant[] = [];
  const adminOn: RoleGrant[] = [];
  const adminOff: RoleGrant[] = [];
  for (const [k, r] of o) if (!c.has(k)) removed.push(r);
  for (const [k, r] of c) {
    const p = o.get(k);
    if (!p) added.push(r);
    else if (p.admin !== r.admin) (r.admin ? adminOn : adminOff).push(r);
  }
  return { removed, added, adminOn, adminOff };
}

/** Roles granted to / revoked from an account. MySQL cannot revoke only the admin option: revoke + grant again. */
function roleGrantStatements(server: ServerKind, grantee: string, orig: RoleGrant[], cur: RoleGrant[]): { sql: string[]; revoked: RoleGrant[] } {
  const { removed, added, adminOn, adminOff } = roleDiff(orig, cur);
  const lit = (r: AccountRef) => accountSql(server, r);
  const out: string[] = [];
  if (server.serverType === 'mariadb') {
    for (const r of removed) out.push(`REVOKE ${lit(r)} FROM ${grantee}`);
    for (const r of adminOff) out.push(`REVOKE ADMIN OPTION FOR ${lit(r)} FROM ${grantee}`);
    for (const r of added.filter((x) => !x.admin)) out.push(`GRANT ${lit(r)} TO ${grantee}`);
    for (const r of [...added.filter((x) => x.admin), ...adminOn]) out.push(`GRANT ${lit(r)} TO ${grantee} WITH ADMIN OPTION`);
    return { sql: out, revoked: removed };
  }
  const revoke = [...removed, ...adminOff];
  const grant = [...added.filter((x) => !x.admin), ...adminOff];
  const grantAdmin = [...added.filter((x) => x.admin), ...adminOn];
  if (revoke.length) out.push(`REVOKE ${revoke.map(lit).join(', ')} FROM ${grantee}`);
  if (grant.length) out.push(`GRANT ${grant.map(lit).join(', ')} TO ${grantee}`);
  if (grantAdmin.length) out.push(`GRANT ${grantAdmin.map(lit).join(', ')} TO ${grantee} WITH ADMIN OPTION`);
  return { sql: out, revoked: revoke };
}

/** Grants of a role to its members */
function memberStatements(server: ServerKind, role: string, orig: RoleGrant[], cur: RoleGrant[]): string[] {
  const { removed, added, adminOn, adminOff } = roleDiff(orig, cur);
  const lit = (r: AccountRef) => accountSql(server, r);
  const out: string[] = [];
  if (server.serverType === 'mariadb') {
    for (const m of removed) out.push(`REVOKE ${role} FROM ${lit(m)}`);
    for (const m of adminOff) out.push(`REVOKE ADMIN OPTION FOR ${role} FROM ${lit(m)}`);
    for (const m of added.filter((x) => !x.admin)) out.push(`GRANT ${role} TO ${lit(m)}`);
    for (const m of [...added.filter((x) => x.admin), ...adminOn]) out.push(`GRANT ${role} TO ${lit(m)} WITH ADMIN OPTION`);
    return out;
  }
  const revoke = [...removed, ...adminOff];
  const grant = [...added.filter((x) => !x.admin), ...adminOff];
  const grantAdmin = [...added.filter((x) => x.admin), ...adminOn];
  if (revoke.length) out.push(`REVOKE ${role} FROM ${revoke.map(lit).join(', ')}`);
  if (grant.length) out.push(`GRANT ${role} TO ${grant.map(lit).join(', ')}`);
  if (grantAdmin.length) out.push(`GRANT ${role} TO ${grantAdmin.map(lit).join(', ')} WITH ADMIN OPTION`);
  return out;
}

function defaultRoleStatements(server: UsersServerInfo, acct: string, o: AccountModel | null, d: AccountDraft, revoked: RoleGrant[]): string[] {
  if (d.isRole || server.defaultRoles === 'none') return [];
  const granted = new Set(d.roles.map(accountKey));
  let cur = d.defaultRoles.filter((r) => granted.has(accountKey(r)));
  if (server.defaultRoles === 'single') cur = cur.slice(0, 1);
  const before = o?.defaultRoles ?? [];
  const key = (l: AccountRef[]) => l.map(accountKey).sort().join('|');
  // a role that is revoked (and granted again) loses its default flag on MySQL
  const lost = revoked.some((r) => cur.some((c) => accountKey(c) === accountKey(r)));
  if (key(cur) === key(before) && !lost) return [];
  if (!o && !cur.length) return [];
  const lit = (r: AccountRef) => accountSql(server, r);
  if (server.defaultRoles === 'single') return [`SET DEFAULT ROLE ${cur.length ? lit(cur[0]) : 'NONE'} FOR ${acct}`];
  return [`SET DEFAULT ROLE ${cur.length ? cur.map(lit).join(', ') : 'NONE'} TO ${acct}`];
}

// ───────────────────────── public API ─────────────────────────

/** Effective account reference of a model (MariaDB roles have no host) */
export function modelRef(server: Pick<UsersServerInfo, 'roleHost'>, m: AccountModel): AccountRef {
  return { user: m.user, host: m.isRole && !server.roleHost ? '' : m.host };
}

/**
 * Statements that create the account (`orig` null) or turn `orig` into the draft:
 * RENAME USER → CREATE / ALTER USER → REVOKE → GRANT → roles → default roles → members → PASSWORD EXPIRE.
 */
export function buildAccountStatements(server: UsersServerInfo, orig: AccountModel | null, d: AccountDraft): UserStatement[] {
  const out: UserStatement[] = [];
  const push = (p: Part | string) => out.push(typeof p === 'string' ? { sql: p, display: p } : p);
  const ref = modelRef(server, d);
  const acct = accountSql(server, ref, d.isRole);

  if (!orig) {
    if (d.isRole) push(`CREATE ROLE ${acct}`);
    else push(join(`CREATE USER ${acct}`, userOptionParts(server, null, d)));
  } else {
    const oref = modelRef(server, orig);
    if (!sameAccount(oref, ref)) push(`RENAME USER ${accountSql(server, oref, orig.isRole)} TO ${acct}`);
    if (!d.isRole) {
      const parts = userOptionParts(server, orig, d);
      if (parts.length) push(join(`ALTER USER ${acct}`, parts));
    }
  }
  out.push(...grantStatements(acct, orig?.grants ?? [], d.grants, server.serverType));
  if (server.roles) {
    const r = roleGrantStatements(server, acct, orig?.roles ?? [], d.roles);
    r.sql.forEach(push);
    defaultRoleStatements(server, acct, orig, d, r.revoked).forEach(push);
    if (d.isRole) memberStatements(server, acct, orig?.members ?? [], d.members).forEach(push);
  }
  if (!d.isRole && d.expireNow && server.passwordExpire) push(`ALTER USER ${acct} PASSWORD EXPIRE`);
  return out;
}

export function dropAccountStatement(server: ServerKind, a: AccountRef, isRole: boolean): UserStatement {
  const sql = server.serverType === 'mariadb' && isRole ? `DROP ROLE ${accountSql(server, a, true)}` : `DROP USER ${accountSql(server, a, false)}`;
  return { sql, display: sql };
}

/** Validation of a draft before saving; returns an error text or null. */
export function validateDraft(server: UsersServerInfo, orig: AccountModel | null, d: AccountDraft, passwordConfirm: string | null): string | null {
  if (!d.user.trim()) return d.isRole ? tr('Bitte einen Rollennamen eingeben.', 'Please enter a role name.') : tr('Bitte einen Benutzernamen eingeben.', 'Please enter a user name.');
  if (d.user !== d.user.trim()) return tr('Der Name darf nicht mit Leerzeichen beginnen oder enden.', 'The name must not start or end with spaces.');
  if ((!d.isRole || server.roleHost) && !d.host.trim()) return tr('Bitte einen Host eingeben (% = alle Hosts).', 'Please enter a host (% = any host).');
  if (orig && d.isRole && !server.renameRole && orig.user !== d.user) {
    return tr('Rollen können auf diesem Server nicht umbenannt werden.', 'Roles cannot be renamed on this server.');
  }
  if (d.isRole) return null;
  if (passwordConfirm !== null && (d.password ?? '') !== passwordConfirm) return tr('Passwort und Bestätigung stimmen nicht überein.', 'Password and confirmation do not match.');
  if (orig && d.plugin && d.plugin !== orig.plugin && PASSWORD_PLUGINS.has(d.plugin) && !d.password) {
    return tr(
      'Beim Wechsel des Authentifizierungs-Plugins muss ein neues Passwort eingegeben werden.',
      'A new password is required when the authentication plugin is changed.'
    );
  }
  if (d.ssl === 'SPECIFIED' && !d.sslCipher && !d.x509Issuer && !d.x509Subject) {
    return tr('Bei „Angegeben“ bitte Cipher, Aussteller oder Betreff eintragen.', 'For "Specified" please enter a cipher, issuer or subject.');
  }
  if (d.expirePolicy === 'interval' && !(d.expireDays >= 1)) return tr('Die Gültigkeitsdauer muss mindestens 1 Tag betragen.', 'The password lifetime must be at least 1 day.');
  return null;
}

/** Canonical JSON of a model (dirty tracking) */
export function modelFingerprint(m: AccountModel, extra?: { password: string | null; expireNow: boolean }): string {
  const refs = (l: RoleGrant[] | AccountRef[]) =>
    [...l].map((r) => ({ user: r.user, host: r.host.toLowerCase(), admin: 'admin' in r ? r.admin : undefined })).sort((a, b) => `${a.user}@${a.host}`.localeCompare(`${b.user}@${b.host}`));
  const specified = m.ssl === 'SPECIFIED';
  const base = {
    ...m,
    // values the server does not keep for the current setting
    expireDays: m.expirePolicy === 'interval' ? m.expireDays : 0,
    sslCipher: specified ? m.sslCipher : '',
    x509Issuer: specified ? m.x509Issuer : '',
    x509Subject: specified ? m.x509Subject : '',
    grants: normalizeGrants(m.grants),
    roles: refs(m.roles),
    defaultRoles: refs(m.defaultRoles),
    members: refs(m.members)
  };
  return JSON.stringify(extra ? { ...base, password: extra.password || null, expireNow: extra.expireNow } : base);
}

/** Masks the password literal of a statement inside a text (e.g. a server error message). */
export function maskSecret(text: string, st: UserStatement): string {
  if (st.sql === st.display) return text;
  const i = st.display.indexOf(PASSWORD_MASK);
  if (i < 0) return text;
  const prefix = st.display.slice(0, i);
  const suffix = st.display.slice(i + PASSWORD_MASK.length);
  if (!st.sql.startsWith(prefix) || !st.sql.endsWith(suffix)) return text;
  const literal = st.sql.slice(i, st.sql.length - suffix.length);
  let out = text.split(literal).join(PASSWORD_MASK);
  const inner = literal.slice(1, -1);
  if (inner.length >= 3) out = out.split(inner).join('********');
  return out;
}

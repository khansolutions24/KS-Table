// User & privilege management API (owned by the users feature).
//
// Accounts are addressed by user + host. MariaDB roles have an empty host.
// Privileges are upper-case GRANT keywords ('SELECT', 'CREATE TEMPORARY TABLES', 'BACKUP_ADMIN' …);
// the grant option of a privilege level is represented by the pseudo privilege 'GRANT OPTION'.

import type { SqlError } from '../types';

export type PrivLevel = 'global' | 'database' | 'table' | 'column' | 'routine';

export interface PrivilegeDef {
  /** GRANT / REVOKE keyword, upper case */
  name: string;
  /** "Context" column of SHOW PRIVILEGES */
  context: string;
  /** Description reported by the server (English) */
  comment: string;
  /** Dynamic privilege (MySQL 8+) */
  dynamic: boolean;
  /** Levels the privilege can be granted on */
  levels: PrivLevel[];
}

export interface AccountRef {
  user: string;
  host: string;
}

export interface AccountSummary extends AccountRef {
  isRole: boolean;
  plugin: string;
  locked: boolean;
  passwordExpired: boolean;
  comment: string;
  /** Internal account of the server (mysql.sys, mysql.session, mariadb.sys …) */
  system: boolean;
}

export interface PrivTarget {
  level: PrivLevel;
  /** Database name or pattern as stored in the grant tables ('' on global level) */
  db: string;
  /** Table / view or routine name ('' on global and database level) */
  name: string;
  /** Column name (column level only) */
  column: string;
  /** Routine type (routine level only) */
  routineType: '' | 'FUNCTION' | 'PROCEDURE';
}

export interface PrivGrant extends PrivTarget {
  /** Granted privileges incl. 'GRANT OPTION' */
  privs: string[];
}

export interface RoleGrant extends AccountRef {
  /** WITH ADMIN OPTION */
  admin: boolean;
}

export type SslRequire = 'NONE' | 'SSL' | 'X509' | 'SPECIFIED';
export type PasswordExpirePolicy = 'default' | 'never' | 'interval';
export type RequireCurrent = 'default' | 'required' | 'optional';

/** Editable properties of an account (user or role). */
export interface AccountModel extends AccountRef {
  isRole: boolean;
  /** Authentication plugin ('' = server default) */
  plugin: string;
  locked: boolean;
  expirePolicy: PasswordExpirePolicy;
  /** Days for expirePolicy 'interval' */
  expireDays: number;
  maxQueries: number;
  maxUpdates: number;
  maxConnections: number;
  maxUserConnections: number;
  /** MariaDB MAX_STATEMENT_TIME in seconds (0 = unlimited) */
  maxStatementTime: number;
  ssl: SslRequire;
  sslCipher: string;
  x509Issuer: string;
  x509Subject: string;
  /** MySQL 8.0.21+ account comment */
  comment: string;
  /** null = server default */
  passwordHistory: number | null;
  /** Days, null = server default */
  passwordReuseDays: number | null;
  requireCurrent: RequireCurrent;
  /** 0 = off */
  failedLoginAttempts: number;
  /** Days, -1 = unbounded, 0 = off */
  passwordLockDays: number;
  /** Roles granted to this account */
  roles: RoleGrant[];
  /** Default roles (subset of roles) */
  defaultRoles: AccountRef[];
  /** Accounts this role is granted to (roles only) */
  members: RoleGrant[];
  grants: PrivGrant[];
}

export interface AccountDetails extends AccountModel {
  /** An authentication string is set */
  hasPassword: boolean;
  /** Password is currently marked as expired */
  passwordExpired: boolean;
  /** SHOW GRANTS output */
  showGrants: string[];
}

export interface AccountGrants extends AccountRef {
  isRole: boolean;
  system: boolean;
  grants: PrivGrant[];
  /** SHOW GRANTS failed for this account */
  error?: string;
}

export interface UsersServerInfo {
  serverType: 'mysql' | 'mariadb';
  /** major * 10000 + minor * 100 + patch */
  version: number;
  /** CREATE ROLE is supported */
  roles: boolean;
  /** MySQL: any number of default roles, MariaDB: one default role */
  defaultRoles: 'none' | 'multi' | 'single';
  /** Roles have a host part (MySQL) */
  roleHost: boolean;
  /** Roles can be renamed with RENAME USER (MySQL) */
  renameRole: boolean;
  accountLock: boolean;
  passwordExpire: boolean;
  /** PASSWORD HISTORY / REUSE INTERVAL / REQUIRE CURRENT */
  passwordOptions: boolean;
  /** FAILED_LOGIN_ATTEMPTS / PASSWORD_LOCK_TIME */
  failedLogin: boolean;
  /** COMMENT '…' on CREATE / ALTER USER */
  comment: boolean;
  /** MAX_STATEMENT_TIME resource option (MariaDB) */
  maxStatementTime: boolean;
  /** Active authentication plugins */
  plugins: string[];
  defaultPlugin: string;
  privileges: PrivilegeDef[];
  currentUser: string;
}

export interface UserStatement {
  sql: string;
  /** Text for the SQL preview and the history log (passwords masked) */
  display: string;
}

export interface UsersApplyResult {
  /** Number of statements executed successfully */
  executed: number;
  /** Error of the first failing statement */
  error: SqlError | null;
}

export interface UsersApi {
  serverInfo(sessionId: string): Promise<UsersServerInfo>;
  /** Accounts and roles of the server */
  list(sessionId: string): Promise<AccountSummary[]>;
  details(sessionId: string, user: string, host: string): Promise<AccountDetails>;
  /** SHOW GRANTS lines of an account */
  showGrants(sessionId: string, user: string, host: string): Promise<string[]>;
  /** Direct privileges of all accounts (privilege manager) */
  allGrants(sessionId: string): Promise<AccountGrants[]>;
  /** Executes account statements one by one, stops at the first error (history gets the masked text) */
  apply(sessionId: string, statements: UserStatement[]): Promise<UsersApplyResult>;
}

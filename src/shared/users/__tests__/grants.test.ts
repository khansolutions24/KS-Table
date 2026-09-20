import { describe, expect, it } from 'vitest';
import type { AccountModel, PrivGrant, PrivLevel, UsersServerInfo } from '../../apis/users';
import { grantStatements, parseShowGrants } from '../grants';
import { buildPrivilegeDefs, GRANT_OPTION, makeTarget, privsForLevel } from '../privileges';
import { buildAccountStatements, draftOf, maskSecret, newAccountModel, validateDraft } from '../statements';

const ROWS: [string, string][] = [
  ['Alter', 'Tables'], ['Alter routine', 'Functions,Procedures'], ['Create', 'Databases,Tables,Indexes'], ['Create routine', 'Databases'],
  ['Create role', 'Server Admin'], ['Create temporary tables', 'Databases'], ['Create view', 'Tables'], ['Create user', 'Server Admin'],
  ['Delete', 'Tables'], ['Drop', 'Databases,Tables'], ['Drop role', 'Server Admin'], ['Event', 'Server Admin'],
  ['Execute', 'Functions,Procedures'], ['File', 'File access on server'], ['Grant option', 'Databases,Tables,Functions,Procedures'],
  ['Index', 'Tables'], ['Insert', 'Tables'], ['Lock tables', 'Databases'], ['Process', 'Server Admin'], ['Proxy', 'Server Admin'],
  ['References', 'Databases,Tables'], ['Reload', 'Server Admin'], ['Replication client', 'Server Admin'], ['Replication slave', 'Server Admin'],
  ['Select', 'Tables'], ['Show databases', 'Server Admin'], ['Show view', 'Tables'], ['Shutdown', 'Server Admin'], ['Super', 'Server Admin'],
  ['Trigger', 'Tables'], ['Create tablespace', 'Server Admin'], ['Update', 'Tables'], ['Usage', 'Server Admin'],
  ['BACKUP_ADMIN', 'Server Admin'], ['SYSTEM_USER', 'Server Admin'], ['SYSTEM_VARIABLES_ADMIN', 'Server Admin']
];
const defs = buildPrivilegeDefs(ROWS.map(([privilege, context]) => ({ privilege, context, comment: '' })));
const expandAll = (l: PrivLevel) => privsForLevel(defs, l);
const U = { user: 'u', host: '%' };

const MYSQL: UsersServerInfo = {
  serverType: 'mysql', version: 80411, roles: true, defaultRoles: 'multi', roleHost: true, renameRole: true, accountLock: true,
  passwordExpire: true, passwordOptions: true, failedLogin: true, comment: true, maxStatementTime: false,
  plugins: ['caching_sha2_password', 'sha256_password'], defaultPlugin: 'caching_sha2_password', privileges: defs, currentUser: 'root@localhost'
};
const MARIA: UsersServerInfo = {
  ...MYSQL, serverType: 'mariadb', version: 110402, defaultRoles: 'single', roleHost: false, renameRole: false, passwordOptions: false,
  failedLogin: false, comment: false, maxStatementTime: true, plugins: ['mysql_native_password', 'ed25519'], defaultPlugin: 'mysql_native_password'
};

const g = (level: PrivLevel, privs: string[], db = '', name = '', column = '', routineType: '' | 'FUNCTION' | 'PROCEDURE' = ''): PrivGrant => ({
  ...makeTarget(level, db, name, column, routineType),
  privs
});

describe('privilege catalog', () => {
  it('derives levels and skips pseudo privileges', () => {
    const names = defs.map((d) => d.name);
    expect(names).not.toContain('USAGE');
    expect(names).not.toContain('PROXY');
    expect(names).not.toContain(GRANT_OPTION);
    expect(defs.find((d) => d.name === 'BACKUP_ADMIN')).toMatchObject({ dynamic: true, levels: ['global'] });
    expect(defs.find((d) => d.name === 'SELECT')?.levels).toEqual(['global', 'database', 'table', 'column']);
    expect(defs.find((d) => d.name === 'EXECUTE')?.levels).toEqual(['global', 'database', 'routine']);
    expect(defs.find((d) => d.name === 'EVENT')?.levels).toEqual(['global', 'database']);
    expect(privsForLevel(defs, 'column')).toEqual(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']);
    expect(privsForLevel(defs, 'routine')).toEqual(['ALTER ROUTINE', 'EXECUTE']);
  });
});

describe('parseShowGrants', () => {
  it('parses database, column and routine privileges (MySQL 8)', () => {
    const p = parseShowGrants(
      [
        'GRANT USAGE ON *.* TO `u`@`%`',
        'GRANT SELECT ON `ks_shop`.* TO `u`@`%`',
        'GRANT SELECT, UPDATE (`name`, `note`) ON `ks_t_admin`.`t1` TO `u`@`%` WITH GRANT OPTION',
        'GRANT EXECUTE, ALTER ROUTINE ON PROCEDURE `ks_t_admin`.`p1` TO `u`@`%` WITH GRANT OPTION',
        'GRANT EXECUTE ON FUNCTION `ks_t_admin`.`f1` TO `u`@`%`'
      ],
      U,
      expandAll
    );
    expect(p.grants).toEqual([
      g('database', ['SELECT'], 'ks_shop'),
      g('table', ['SELECT', GRANT_OPTION], 'ks_t_admin', 't1'),
      g('column', ['UPDATE'], 'ks_t_admin', 't1', 'name'),
      g('column', ['UPDATE'], 'ks_t_admin', 't1', 'note'),
      g('routine', ['EXECUTE'], 'ks_t_admin', 'f1', '', 'FUNCTION'),
      g('routine', ['ALTER ROUTINE', 'EXECUTE', GRANT_OPTION], 'ks_t_admin', 'p1', '', 'PROCEDURE')
    ]);
    expect(p.roles).toEqual([]);
  });

  it('takes the global grant option from the static line only', () => {
    const p = parseShowGrants(
      ['GRANT PROCESS ON *.* TO `u`@`%`', 'GRANT BACKUP_ADMIN,SYSTEM_VARIABLES_ADMIN ON *.* TO `u`@`%` WITH GRANT OPTION'],
      U,
      expandAll
    );
    expect(p.grants).toEqual([g('global', ['PROCESS', 'BACKUP_ADMIN', 'SYSTEM_VARIABLES_ADMIN'])]);
    const q = parseShowGrants(['GRANT RELOAD ON *.* TO `u`@`%` WITH GRANT OPTION', 'GRANT BACKUP_ADMIN ON *.* TO `u`@`%` WITH GRANT OPTION'], U, expandAll);
    expect(q.grants[0].privs).toEqual(['RELOAD', 'BACKUP_ADMIN', GRANT_OPTION]);
  });

  it('handles USAGE with grant option, ALL PRIVILEGES, PROXY and roles', () => {
    const p = parseShowGrants(
      [
        'GRANT USAGE ON `a`.* TO `u`@`%` WITH GRANT OPTION',
        'GRANT ALL PRIVILEGES ON `b`.* TO `u`@`%`',
        "GRANT PROXY ON ``@`` TO `u`@`%` WITH GRANT OPTION",
        'GRANT `r1`@`%`,`r2`@`localhost` TO `u`@`%` WITH ADMIN OPTION',
        'GRANT `r3`@`%` TO `u`@`%`',
        'GRANT SELECT ON `x`.* TO `other`@`%`'
      ],
      U,
      expandAll
    );
    expect(p.grants).toEqual([g('database', [GRANT_OPTION], 'a'), g('database', privsForLevel(defs, 'database'), 'b')]);
    expect(p.roles).toEqual([
      { user: 'r1', host: '%', admin: true },
      { user: 'r2', host: 'localhost', admin: true },
      { user: 'r3', host: '%', admin: false }
    ]);
  });

  it('parses MariaDB output incl. roles without host and quoted escapes', () => {
    const root = parseShowGrants(
      [
        "GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` IDENTIFIED BY PASSWORD '*81F5E21E35407D884A6CD4A731AEBFB6AF209E1B' WITH GRANT OPTION",
        "GRANT PROXY ON ''@'%' TO 'root'@'localhost' WITH GRANT OPTION"
      ],
      { user: 'root', host: 'localhost' },
      expandAll
    );
    expect(root.grants).toHaveLength(1);
    expect(root.grants[0].privs).toContain('SUPER');
    expect(root.grants[0].privs).toContain(GRANT_OPTION);
    const user = parseShowGrants(
      ['GRANT USAGE ON *.* TO `hulda`@`localhost`', 'GRANT `journalist` TO `hulda`@`localhost`', 'SET DEFAULT ROLE `journalist` FOR `hulda`@`localhost`'],
      { user: 'hulda', host: 'localhost' },
      expandAll
    );
    expect(user.roles).toEqual([{ user: 'journalist', host: '', admin: false }]);
    const role = parseShowGrants(['GRANT USAGE ON *.* TO `journalist`', 'GRANT SELECT, INSERT ON `test`.* TO `journalist`'], { user: 'journalist', host: '' }, expandAll);
    expect(role.grants).toEqual([g('database', ['SELECT', 'INSERT'], 'test')]);
    const esc = parseShowGrants(['GRANT SELECT ON `ks\\_shop`.* TO `u`@`%`', 'GRANT SELECT ON `we``ird`.`t``x` TO `u`@`%`'], U, expandAll);
    expect(esc.grants).toEqual([g('database', ['SELECT'], 'ks\\_shop'), g('table', ['SELECT'], 'we`ird', 't`x')]);
  });
});

describe('grantStatements', () => {
  const acct = "'u'@'%'";
  it('grants new privileges, grant option and columns', () => {
    const sql = grantStatements(
      acct,
      [g('database', ['SELECT'], 'ks_shop')],
      [
        g('database', ['SELECT', 'INSERT', GRANT_OPTION], 'ks_shop'),
        g('column', ['SELECT'], 'ks_shop', 't', 'c'),
        g('routine', ['EXECUTE'], 'ks_shop', 'p', '', 'PROCEDURE')
      ],
      'mysql'
    ).map((s) => s.sql);
    expect(sql).toEqual([
      "GRANT INSERT ON `ks_shop`.* TO 'u'@'%' WITH GRANT OPTION",
      "GRANT EXECUTE ON PROCEDURE `ks_shop`.`p` TO 'u'@'%'",
      "GRANT SELECT (`c`) ON `ks_shop`.`t` TO 'u'@'%'"
    ]);
  });

  it('handles a lone grant option per server type and revokes', () => {
    const orig = [g('database', ['SELECT'], 'd')];
    const cur = [g('database', ['SELECT', GRANT_OPTION], 'd')];
    expect(grantStatements(acct, orig, cur, 'mysql')[0].sql).toBe("GRANT GRANT OPTION ON `d`.* TO 'u'@'%'");
    expect(grantStatements(acct, orig, cur, 'mariadb')[0].sql).toBe("GRANT USAGE ON `d`.* TO 'u'@'%' WITH GRANT OPTION");
    expect(grantStatements(acct, [g('database', ['SELECT', 'INSERT', GRANT_OPTION], 'd')], orig, 'mysql')[0].sql).toBe(
      "REVOKE INSERT, GRANT OPTION ON `d`.* FROM 'u'@'%'"
    );
    expect(
      grantStatements(acct, [g('column', ['SELECT', 'UPDATE'], 'd', 't', 'a'), g('column', ['SELECT'], 'd', 't', 'b')], [], 'mysql')[0].sql
    ).toBe("REVOKE SELECT (`a`, `b`), UPDATE (`a`) ON `d`.`t` FROM 'u'@'%'");
    expect(grantStatements(acct, [], [g('global', ['RELOAD', 'BACKUP_ADMIN'])], 'mysql')[0].sql).toBe("GRANT RELOAD, BACKUP_ADMIN ON *.* TO 'u'@'%'");
  });

  it('grants column privileges again that a table-level revoke removes', () => {
    const orig = [g('table', ['UPDATE', 'DELETE'], 'd', 't'), g('column', ['UPDATE'], 'd', 't', 'a'), g('column', ['UPDATE'], 'd', 't', 'b')];
    const cur = [g('table', ['DELETE'], 'd', 't'), g('column', ['UPDATE'], 'd', 't', 'a')];
    expect(grantStatements(acct, orig, cur, 'mysql').map((s) => s.sql)).toEqual([
      "REVOKE UPDATE ON `d`.`t` FROM 'u'@'%'",
      "GRANT UPDATE (`a`) ON `d`.`t` TO 'u'@'%'"
    ]);
  });
});

describe('buildAccountStatements', () => {
  const base = (): AccountModel => ({ ...newAccountModel(MYSQL, false), user: 'u', host: '%' });

  it('creates a MySQL user with options, privileges and default roles', () => {
    const d = draftOf({
      ...base(),
      ssl: 'SPECIFIED',
      sslCipher: 'ECDHE',
      x509Subject: '/CN=u',
      maxQueries: 10,
      maxUserConnections: 2,
      locked: true,
      expirePolicy: 'interval',
      expireDays: 30,
      failedLoginAttempts: 3,
      passwordLockDays: -1,
      comment: 'Ä',
      grants: [g('database', ['SELECT'], 'ks_shop')],
      roles: [{ user: 'r', host: '%', admin: false }],
      defaultRoles: [{ user: 'r', host: '%' }]
    });
    d.password = "p'w";
    d.expireNow = true;
    const st = buildAccountStatements(MYSQL, null, d);
    expect(st.map((s) => s.sql)).toEqual([
      "CREATE USER 'u'@'%' IDENTIFIED WITH caching_sha2_password BY 'p\\'w' REQUIRE CIPHER 'ECDHE' AND SUBJECT '/CN=u' WITH MAX_QUERIES_PER_HOUR 10 MAX_USER_CONNECTIONS 2 ACCOUNT LOCK PASSWORD EXPIRE INTERVAL 30 DAY FAILED_LOGIN_ATTEMPTS 3 PASSWORD_LOCK_TIME UNBOUNDED COMMENT 'Ä'",
      "GRANT SELECT ON `ks_shop`.* TO 'u'@'%'",
      "GRANT 'r'@'%' TO 'u'@'%'",
      "SET DEFAULT ROLE 'r'@'%' TO 'u'@'%'",
      "ALTER USER 'u'@'%' PASSWORD EXPIRE"
    ]);
    expect(st[0].display).toContain("BY '********' REQUIRE");
    expect(st[0].display).not.toContain('p\\');
  });

  it('alters an existing MySQL user incl. rename and role admin change', () => {
    const orig: AccountModel = {
      ...base(),
      comment: 'x',
      locked: true,
      roles: [{ user: 'r', host: '%', admin: true }],
      defaultRoles: [{ user: 'r', host: '%' }],
      grants: [g('global', ['PROCESS'])]
    };
    const d = draftOf(orig);
    d.user = 'u2';
    d.host = 'localhost';
    d.password = 'secret1';
    d.locked = false;
    d.comment = '';
    d.roles = [{ user: 'r', host: '%', admin: false }];
    d.grants = [];
    expect(buildAccountStatements(MYSQL, orig, d).map((s) => s.sql)).toEqual([
      "RENAME USER 'u'@'%' TO 'u2'@'localhost'",
      "ALTER USER 'u2'@'localhost' IDENTIFIED BY 'secret1' ACCOUNT UNLOCK ATTRIBUTE '{\"comment\": null}'",
      "REVOKE PROCESS ON *.* FROM 'u2'@'localhost'",
      "REVOKE 'r'@'%' FROM 'u2'@'localhost'",
      "GRANT 'r'@'%' TO 'u2'@'localhost'",
      "SET DEFAULT ROLE 'r'@'%' TO 'u2'@'localhost'"
    ]);
    expect(buildAccountStatements(MYSQL, orig, draftOf(orig))).toEqual([]);
  });

  it('uses MariaDB syntax for plugins, roles and the default role', () => {
    const role = draftOf({ ...newAccountModel(MARIA, true), user: 'rep' });
    role.members = [{ user: 'u', host: '%', admin: false }];
    expect(buildAccountStatements(MARIA, null, role).map((s) => s.sql)).toEqual(['CREATE ROLE `rep`', "GRANT `rep` TO 'u'@'%'"]);
    const d = draftOf({ ...newAccountModel(MARIA, false), user: 'u', host: '%', plugin: 'ed25519', maxStatementTime: 1.5 });
    d.password = 'geheim!';
    d.roles = [{ user: 'rep', host: '', admin: false }];
    d.defaultRoles = [{ user: 'rep', host: '' }];
    const st = buildAccountStatements(MARIA, null, d);
    expect(st.map((s) => s.sql)).toEqual([
      "CREATE USER 'u'@'%' IDENTIFIED VIA ed25519 USING PASSWORD('geheim!') WITH MAX_STATEMENT_TIME 1.5",
      "GRANT `rep` TO 'u'@'%'",
      "SET DEFAULT ROLE `rep` FOR 'u'@'%'"
    ]);
    expect(st[0].display).toContain("USING PASSWORD('********')");
  });

  it('masks passwords in error texts and validates drafts', () => {
    const st = { sql: "ALTER USER 'x'@'y' IDENTIFIED BZ 'secret123'", display: "ALTER USER 'x'@'y' IDENTIFIED BZ '********'" };
    expect(maskSecret("You have an error near 'BZ 'secret123'' at line 1", st)).toBe("You have an error near 'BZ '********'' at line 1");
    const d = draftOf(base());
    d.password = 'a';
    expect(validateDraft(MYSQL, null, d, 'b')).toBeTruthy();
    expect(validateDraft(MYSQL, null, d, 'a')).toBeNull();
    const orig = base();
    const p = draftOf(orig);
    p.plugin = 'sha256_password';
    expect(validateDraft(MYSQL, orig, p, null)).toBeTruthy();
  });
});

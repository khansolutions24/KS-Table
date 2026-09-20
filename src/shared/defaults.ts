import type { AppSettings, ConnectionConfig, FieldDef, TableDesign, TableOptions, ServerType } from './types';

export function newId(prefix = ''): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rnd}`;
}

export function defaultConnection(type: ServerType = 'mysql'): ConnectionConfig {
  const now = Date.now();
  return {
    id: newId('c'),
    name: '',
    type,
    groupId: null,
    color: null,
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
    savePassword: true,
    autoConnect: false,
    encoding: 'utf8mb4',
    keepAliveInterval: 240,
    useCompression: false,
    socketPath: '',
    timezone: '',
    connectTimeout: 15,
    initSql: '',
    readOnly: false,
    useCustomDatabaseList: false,
    databases: [],
    hideSystemDatabases: false,
    ssl: {
      enabled: false,
      ca: '',
      cert: '',
      key: '',
      passphrase: '',
      cipher: '',
      verifyServerCert: false,
      verifyIdentity: false
    },
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      user: '',
      authMethod: 'password',
      password: '',
      savePassword: true,
      privateKeyPath: '',
      passphrase: '',
      savePassphrase: true
    },
    http: { enabled: false, url: '', base64: false, authUser: '', authPassword: '' },
    notes: '',
    createdAt: now,
    updatedAt: now
  };
}

export function defaultSettings(): AppSettings {
  return {
    language: 'de',
    theme: 'light',
    uiFontSize: 13,
    confirmOnExit: true,
    restoreTabs: true,
    showInfoPane: true,
    showNavigator: true,
    navigatorShowObjects: true,
    editor: {
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 13,
      tabSize: 4,
      insertSpaces: true,
      wordWrap: false,
      lineNumbers: true,
      minimap: false,
      folding: true,
      highlightLine: true,
      autoComplete: true,
      uppercaseKeywords: true,
      autoCloseBrackets: true
    },
    grid: {
      fontSize: 13,
      rowHeight: 26,
      limitRecords: true,
      recordsPerPage: 1000,
      nullText: '(NULL)',
      showRowNumbers: true,
      countMode: 'exact',
      autoApply: true,
      alternateRows: false
    },
    query: {
      maxRows: 50000,
      stopOnError: true,
      autoCommit: true,
      confirmUnsafe: true,
      resultsInNewTab: false
    },
    historyEnabled: true,
    historyMaxEntries: 5000,
    profilesDir: '',
    smtp: { host: '', port: 587, secure: false, user: '', password: '', from: '' }
  };
}

export function defaultTableOptions(): TableOptions {
  return {
    engine: 'InnoDB',
    charset: '',
    collation: '',
    autoIncrement: '',
    rowFormat: '',
    avgRowLength: '',
    maxRows: '',
    minRows: '',
    keyBlockSize: '',
    checksum: false,
    delayKeyWrite: false,
    packKeys: '',
    statsAutoRecalc: '',
    statsPersistent: '',
    statsSamplePages: '',
    tablespace: '',
    compression: '',
    encryption: '',
    dataDirectory: '',
    indexDirectory: '',
    insertMethod: '',
    union: ''
  };
}

export function newField(partial: Partial<FieldDef> = {}): FieldDef {
  return {
    id: newId('f'),
    name: '',
    type: 'VARCHAR',
    length: '255',
    decimals: '',
    values: [],
    notNull: false,
    defaultKind: 'none',
    defaultValue: '',
    comment: '',
    autoIncrement: false,
    unsigned: false,
    zerofill: false,
    binary: false,
    charset: '',
    collation: '',
    onUpdateCurrentTimestamp: false,
    generated: false,
    generatedExpr: '',
    generatedStored: false,
    invisible: false,
    srid: '',
    ...partial
  };
}

export function newTableDesign(schema: string): TableDesign {
  const id = newField({ name: 'id', type: 'INT', length: '', notNull: true, autoIncrement: true, unsigned: true });
  return {
    schema,
    name: '',
    fields: [id],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    checks: [],
    triggers: [],
    options: defaultTableOptions(),
    comment: '',
    partition: ''
  };
}

export const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

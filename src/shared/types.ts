// Types shared by the backend (Node/Electron main) and the renderer.

import type { Lang } from './i18n';

// ───────────────────────── Connections ─────────────────────────

export type ServerType = 'mysql' | 'mariadb';

export interface SslConfig {
  enabled: boolean;
  /** Paths to PEM files */
  ca: string;
  cert: string;
  key: string;
  passphrase?: string;
  cipher: string;
  /** Verify the server certificate against the CA */
  verifyServerCert: boolean;
  /** Also verify that the certificate matches the host name */
  verifyIdentity: boolean;
}

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  authMethod: 'password' | 'publicKey' | 'agent';
  password?: string;
  savePassword: boolean;
  privateKeyPath: string;
  passphrase?: string;
  savePassphrase: boolean;
}

export interface HttpTunnelConfig {
  enabled: boolean;
  /** URL of the ks_tunnel.php script on the web server */
  url: string;
  base64: boolean;
  authUser: string;
  authPassword?: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  type: ServerType;
  groupId: string | null;
  color: string | null;
  host: string;
  port: number;
  user: string;
  password?: string;
  savePassword: boolean;
  // Advanced
  autoConnect: boolean;
  /** Connection character set, e.g. utf8mb4 */
  encoding: string;
  /** Seconds between keep-alive pings, 0 = off */
  keepAliveInterval: number;
  useCompression: boolean;
  /** Named pipe / unix socket path; empty = TCP */
  socketPath: string;
  /** Session time zone, empty = server default */
  timezone: string;
  /** Seconds */
  connectTimeout: number;
  /** Statements executed on every new session (separated by ;) */
  initSql: string;
  readOnly: boolean;
  // Databases
  useCustomDatabaseList: boolean;
  databases: string[];
  hideSystemDatabases: boolean;
  ssl: SslConfig;
  ssh: SshConfig;
  http: HttpTunnelConfig;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionGroup {
  id: string;
  name: string;
  order: number;
}

export interface ConnectionTestResult {
  serverVersion: string;
  versionComment: string;
  durationMs: number;
}

// ───────────────────────── Sessions ─────────────────────────

export interface ServerInfo {
  /** Raw VERSION() string */
  version: string;
  /** major * 10000 + minor * 100 + patch, e.g. 80403 */
  versionNumber: number;
  versionComment: string;
  type: ServerType;
}

export interface SessionInfo {
  sessionId: string;
  connectionId: string;
  threadId: number;
  server: ServerInfo;
  database: string | null;
}

// ───────────────────────── Metadata ─────────────────────────

export type ObjectKind = 'table' | 'view' | 'function' | 'procedure' | 'event' | 'trigger';

export interface SchemaInfo {
  name: string;
  charset: string;
  collation: string;
  system: boolean;
}

export interface TableStatus {
  name: string;
  type: 'BASE TABLE' | 'VIEW' | 'SYSTEM VIEW';
  engine: string | null;
  rowFormat: string | null;
  rows: number | null;
  avgRowLength: number | null;
  dataLength: number | null;
  maxDataLength: number | null;
  indexLength: number | null;
  dataFree: number | null;
  autoIncrement: number | null;
  createTime: string | null;
  updateTime: string | null;
  checkTime: string | null;
  collation: string | null;
  checksum: number | null;
  createOptions: string;
  comment: string;
}

export interface ViewStatus {
  name: string;
  definer: string;
  securityType: string;
  checkOption: string;
  isUpdatable: boolean;
  characterSetClient: string;
  collationConnection: string;
}

export interface RoutineStatus {
  name: string;
  type: 'FUNCTION' | 'PROCEDURE';
  definer: string;
  created: string | null;
  modified: string | null;
  securityType: string;
  comment: string;
  /** Return type (functions only) */
  returns: string | null;
  deterministic: boolean;
  dataAccess: string;
}

export interface EventStatus {
  name: string;
  definer: string;
  timeZone: string;
  eventType: 'ONE TIME' | 'RECURRING';
  executeAt: string | null;
  intervalValue: string | null;
  intervalField: string | null;
  starts: string | null;
  ends: string | null;
  status: string;
  onCompletion: string;
  created: string | null;
  lastAltered: string | null;
  lastExecuted: string | null;
  comment: string;
}

export interface TriggerStatus {
  name: string;
  table: string;
  timing: 'BEFORE' | 'AFTER';
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  statement: string;
  order: number;
  created: string | null;
  definer: string;
}

export interface ColumnMeta {
  name: string;
  position: number;
  /** Lower-case base type, e.g. "varchar" */
  dataType: string;
  /** Full type, e.g. "int unsigned", "enum('a','b')" */
  columnType: string;
  nullable: boolean;
  /** COLUMN_DEFAULT as reported by information_schema */
  defaultValue: string | null;
  /** auto_increment, on update CURRENT_TIMESTAMP, DEFAULT_GENERATED, VIRTUAL GENERATED, ... */
  extra: string;
  key: '' | 'PRI' | 'UNI' | 'MUL';
  charset: string | null;
  collation: string | null;
  comment: string;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  datetimePrecision: number | null;
  generationExpression: string;
  /** Parsed values for enum / set columns */
  enumValues?: string[];
}

export interface CharsetInfo {
  charset: string;
  description: string;
  defaultCollation: string;
  maxLen: number;
}

export interface CollationInfo {
  collation: string;
  charset: string;
  id: number;
  isDefault: boolean;
}

export interface EngineInfo {
  engine: string;
  support: string;
  comment: string;
  transactions: boolean;
}

// ───────────────────────── Query results ─────────────────────────

/** All non-binary values travel as strings (exact for DECIMAL/BIGINT, dates as text). */
export type CellValue = string | null | Uint8Array;

export interface ResultColumn {
  /** Column label as returned (alias) */
  name: string;
  orgName: string;
  table: string;
  orgTable: string;
  schema: string;
  /** MySQL protocol type id */
  typeId: number;
  /** Upper-case type name derived from protocol type, e.g. VARCHAR, INT, BLOB */
  typeName: string;
  flags: number;
  length: number;
  decimals: number;
  charsetNr: number;
  binary: boolean;
  primaryKey: boolean;
  notNull: boolean;
  unsigned: boolean;
  autoIncrement: boolean;
  numeric: boolean;
}

export interface SqlError {
  message: string;
  code?: string;
  errno?: number;
  sqlState?: string;
  sql?: string;
}

export interface StatementResult {
  index: number;
  sql: string;
  kind: 'resultset' | 'ok' | 'error';
  columns?: ResultColumn[];
  rows?: CellValue[][];
  /** The row limit was reached and remaining rows were discarded */
  truncated?: boolean;
  affectedRows?: number;
  changedRows?: number;
  insertId?: string;
  warningCount?: number;
  warnings?: { level: string; code: number; message: string }[];
  info?: string;
  error?: SqlError;
  startedAt: number;
  durationMs: number;
}

/** Passwords entered at connect time when they are not stored in the profile */
export interface Credentials {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

export interface ExecuteOptions {
  /** Maximum rows kept per result set (0 = unlimited) */
  maxRows?: number;
  stopOnError?: boolean;
  /** Initial delimiter for statement splitting */
  delimiter?: string;
  /** Identifier used in query:progress events */
  queryId?: string;
  /** Record statements in the history log (default true) */
  history?: boolean;
  /** Execute the text as one statement without splitting */
  noSplit?: boolean;
}

export interface ExecuteResult {
  results: StatementResult[];
  totalMs: number;
  cancelled: boolean;
  /** Current database after execution (USE statements change it) */
  database: string | null;
}

export interface QueryProgressEvent {
  queryId: string;
  index: number;
  total: number;
  sql: string;
}

// ───────────────────────── Table data ─────────────────────────

export interface SortSpec {
  column: string;
  desc: boolean;
}

export interface FetchRequest {
  schema: string;
  table: string;
  /** Raw filter expression (without WHERE) */
  where?: string;
  orderBy?: SortSpec[];
  /** Raw ORDER BY expression (takes precedence over orderBy) */
  orderSql?: string;
  offset: number;
  /** null = no limit */
  limit: number | null;
}

export interface FetchResult {
  columns: ResultColumn[];
  meta: ColumnMeta[];
  rows: CellValue[][];
  /** Columns identifying a row: primary key, else a NOT NULL unique key, else empty */
  keyColumns: string[];
  keyKind: 'primary' | 'unique' | 'none';
  sql: string;
  durationMs: number;
}

/** Value written to a cell: literal, NULL, binary, raw SQL expression or column default */
export type EditValue = null | string | Uint8Array | { expr: string } | { default: true };

export type RowChange =
  | { type: 'insert'; values: Record<string, EditValue> }
  | { type: 'update'; key: Record<string, CellValue>; values: Record<string, EditValue> }
  | { type: 'delete'; key: Record<string, CellValue> };

export interface ApplyRequest {
  schema: string;
  table: string;
  changes: RowChange[];
  /** Run all changes in one transaction (rollback on first error) */
  transaction: boolean;
  /** Column order for returned rows (re-read after insert/update) */
  columns: string[];
}

export interface ApplyChangeResult {
  ok: boolean;
  sql: string;
  affectedRows: number;
  insertId?: string;
  error?: SqlError;
  /** Fresh row values (same order as ApplyRequest.columns), null if deleted / not found */
  row?: CellValue[] | null;
}

export interface ApplyResult {
  results: ApplyChangeResult[];
  committed: boolean;
}

// ───────────────────────── Table design ─────────────────────────

export type DefaultKind = 'none' | 'null' | 'empty' | 'value' | 'expression';

export interface FieldDef {
  /** Stable client-side id */
  id: string;
  /** Name in the database for existing columns; undefined for new ones */
  origName?: string;
  name: string;
  /** Upper-case base type, e.g. VARCHAR */
  type: string;
  /** Length / precision (as typed), empty if none */
  length: string;
  /** Scale / fractional seconds, empty if none */
  decimals: string;
  /** ENUM / SET members */
  values: string[];
  notNull: boolean;
  defaultKind: DefaultKind;
  /** Literal value (defaultKind 'value') or SQL expression (defaultKind 'expression') */
  defaultValue: string;
  comment: string;
  autoIncrement: boolean;
  unsigned: boolean;
  zerofill: boolean;
  binary: boolean;
  charset: string;
  collation: string;
  onUpdateCurrentTimestamp: boolean;
  /** Generated column */
  generated: boolean;
  generatedExpr: string;
  generatedStored: boolean;
  invisible: boolean;
  srid: string;
}

export type IndexType = 'NORMAL' | 'UNIQUE' | 'FULLTEXT' | 'SPATIAL';

export interface IndexField {
  /** Column name, or empty when expr is used (functional index) */
  name: string;
  /** Prefix length */
  subPart: string;
  order: '' | 'ASC' | 'DESC';
  /** Functional key part expression (MySQL 8.0.13+) */
  expr?: string;
}

export interface IndexDef {
  id: string;
  origName?: string;
  name: string;
  fields: IndexField[];
  type: IndexType;
  method: '' | 'BTREE' | 'HASH';
  comment: string;
  invisible: boolean;
  parser: string;
  keyBlockSize: string;
}

export type FkAction = '' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'SET DEFAULT';

export interface ForeignKeyDef {
  id: string;
  origName?: string;
  name: string;
  fields: string[];
  refSchema: string;
  refTable: string;
  refFields: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
}

export interface CheckDef {
  id: string;
  origName?: string;
  name: string;
  expr: string;
  enforced: boolean;
}

export interface TriggerDef {
  id: string;
  origName?: string;
  name: string;
  timing: 'BEFORE' | 'AFTER';
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  body: string;
  definer: string;
  orderType: '' | 'FOLLOWS' | 'PRECEDES';
  orderOther: string;
}

export interface TableOptions {
  engine: string;
  charset: string;
  collation: string;
  autoIncrement: string;
  rowFormat: string;
  avgRowLength: string;
  maxRows: string;
  minRows: string;
  keyBlockSize: string;
  checksum: boolean;
  delayKeyWrite: boolean;
  packKeys: '' | 'DEFAULT' | '0' | '1';
  statsAutoRecalc: '' | 'DEFAULT' | '0' | '1';
  statsPersistent: '' | 'DEFAULT' | '0' | '1';
  statsSamplePages: string;
  tablespace: string;
  compression: string;
  encryption: '' | 'Y' | 'N';
  dataDirectory: string;
  indexDirectory: string;
  insertMethod: '' | 'NO' | 'FIRST' | 'LAST';
  union: string;
}

export interface TableDesign {
  schema: string;
  name: string;
  /** Name in the database; undefined for a new table */
  origName?: string;
  fields: FieldDef[];
  /** Field names in key order */
  primaryKey: string[];
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  checks: CheckDef[];
  triggers: TriggerDef[];
  options: TableOptions;
  comment: string;
  /** Raw PARTITION BY ... clause, empty if not partitioned */
  partition: string;
}

// ───────────────────────── Tasks (long-running jobs) ─────────────────────────

export type TaskStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface TaskInfo {
  taskId: string;
  kind: string;
  title: string;
  status: TaskStatus;
  /** 0..1, null = indeterminate */
  progress: number | null;
  message: string;
  startedAt: number;
  endedAt?: number;
  /** Task specific result summary */
  result?: unknown;
}

export interface TaskLogEntry {
  taskId: string;
  time: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

// ───────────────────────── History & settings ─────────────────────────

export interface HistoryEntry {
  id: string;
  time: number;
  connectionId: string;
  connectionName: string;
  database: string | null;
  sql: string;
  durationMs: number;
  ok: boolean;
  affectedRows?: number;
  rows?: number;
  error?: string;
}

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  minimap: boolean;
  folding: boolean;
  highlightLine: boolean;
  autoComplete: boolean;
  uppercaseKeywords: boolean;
  autoCloseBrackets: boolean;
}

export interface GridSettings {
  fontSize: number;
  rowHeight: number;
  limitRecords: boolean;
  recordsPerPage: number;
  nullText: string;
  showRowNumbers: boolean;
  /** How to count rows in the table viewer */
  countMode: 'exact' | 'estimate';
  /** Apply edits when the cursor leaves a row (otherwise only on explicit apply) */
  autoApply: boolean;
  alternateRows: boolean;
}

export interface QuerySettings {
  maxRows: number;
  stopOnError: boolean;
  autoCommit: boolean;
  /** Warn before UPDATE/DELETE without WHERE */
  confirmUnsafe: boolean;
  resultsInNewTab: boolean;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  from: string;
}

export interface AppSettings {
  language: Lang;
  theme: 'light' | 'dark' | 'system';
  uiFontSize: number;
  confirmOnExit: boolean;
  restoreTabs: boolean;
  showInfoPane: boolean;
  showNavigator: boolean;
  navigatorShowObjects: boolean;
  editor: EditorSettings;
  grid: GridSettings;
  query: QuerySettings;
  historyEnabled: boolean;
  historyMaxEntries: number;
  /** Folder for saved queries, backups, models, profiles ("" = default in Documents) */
  profilesDir: string;
  smtp: SmtpSettings;
}

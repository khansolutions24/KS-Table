// Data transfer / data synchronization / structure synchronization API (owned by the sync feature).
//
// Long running operations are backend tasks (see TaskPanel); the methods named start… return the task id.
// Saved profiles (api.profiles, kinds 'dataTransfer', 'dataSync', 'structSync') store exactly the
// *Profile objects below; the backend registers headless runners for them (batch jobs).

import type { CellValue, ColumnMeta } from '../types';

// ───────────────────────── Common ─────────────────────────

/** A database on a saved connection */
export interface SyncEndpoint {
  connectionId: string;
  database: string;
}

export type SyncObjectType = 'table' | 'view' | 'function' | 'procedure' | 'trigger' | 'event';

export interface SyncTableEntry {
  name: string;
  /** Estimated number of rows (information_schema) */
  rows: number | null;
  engine: string | null;
  /** Primary key or NOT NULL unique key present */
  hasKey: boolean;
  comment: string;
}

export interface SyncObjectList {
  tables: SyncTableEntry[];
  views: string[];
  functions: string[];
  procedures: string[];
  triggers: { name: string; table: string }[];
  events: string[];
}

// ───────────────────────── Data transfer ─────────────────────────

export type NameCase = 'keep' | 'lower' | 'upper';
export type InsertMode = 'insert' | 'ignore' | 'replace';

export interface TransferOptions {
  // tables
  createTables: boolean;
  dropBeforeCreate: boolean;
  /** Create the target database when it does not exist */
  createDatabase: boolean;
  includeIndexes: boolean;
  includeForeignKeys: boolean;
  includeChecks: boolean;
  includeTriggers: boolean;
  includeAutoIncrement: boolean;
  includePartitions: boolean;
  /** Character set / collation clauses of tables and columns */
  includeCharset: boolean;
  includeEngine: boolean;
  /** Row format, statistics, key block size … */
  includeTableOptions: boolean;
  includeComments: boolean;
  /** DEFINER clauses of views, routines, triggers and events */
  includeDefiner: boolean;
  nameCase: NameCase;
  // records
  createRecords: boolean;
  insertMode: InsertMode;
  /** Multi-row INSERT statements */
  extendedInsert: boolean;
  rowsPerStatement: number;
  /** Size limit of one extended INSERT in KB (larger rows are sent alone) */
  maxStatementKB: number;
  /** Rows read from the source per query */
  fetchSize: number;
  lockSource: boolean;
  lockTarget: boolean;
  /** One transaction per table */
  useTransaction: boolean;
  disableFkChecks: boolean;
  // general
  continueOnError: boolean;
}

export interface TransferObjects {
  /** Transfer every object of the source database, including objects created after the profile was saved */
  all: boolean;
  tables: string[];
  views: string[];
  functions: string[];
  procedures: string[];
  triggers: string[];
  events: string[];
}

export interface TransferTableSetting {
  /** Different table name in the target ('' = source name, the name case option applies) */
  targetName: string;
  /** Row filter (SQL expression without WHERE, '' = all rows) */
  where: string;
}

export type TransferTarget =
  | { kind: 'database'; connectionId: string; database: string }
  /** SQL script; `database` = schema name used in the script ('' = unqualified statements, no USE) */
  | { kind: 'file'; path: string; encoding: string; database: string };

export interface DataTransferProfile {
  version: 1;
  source: SyncEndpoint;
  target: TransferTarget;
  objects: TransferObjects;
  /** Per table settings keyed by source table name */
  tableSettings: Record<string, TransferTableSetting>;
  options: TransferOptions;
}

export interface TransferObjectResult {
  type: SyncObjectType;
  name: string;
  targetName: string;
  status: 'ok' | 'warning' | 'error' | 'skipped';
  /** Transferred records (tables) */
  rows: number;
  message: string;
  durationMs: number;
}

export interface DataTransferResult {
  objects: TransferObjectResult[];
  rows: number;
  errors: number;
  warnings: number;
  durationMs: number;
  /** Stopped early (error without "continue on error", or cancelled) */
  aborted: boolean;
}

// ───────────────────────── Data synchronization ─────────────────────────

export interface DsColumn {
  name: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  generated: boolean;
}

export interface DsTable {
  name: string;
  rows: number | null;
  columns: DsColumn[];
  primaryKey: string[];
  uniqueKeys: { name: string; columns: string[]; nullable: boolean }[];
}

export interface DataSyncPrepareResult {
  source: DsTable[];
  target: DsTable[];
}

export interface DataSyncMapping {
  source: string;
  target: string;
  /** Comparison key (source column names); empty = primary key of the source table */
  key: string[];
  /** Synchronized columns (source names); empty = all common, non-generated columns */
  columns: string[];
  /** Source column → target column where the names differ (default: same name, case-insensitive) */
  columnMap: Record<string, string>;
}

export interface DataSyncOptions {
  /** Insert records that only exist in the source */
  insert: boolean;
  /** Update records that differ */
  update: boolean;
  /** Delete records that only exist in the target */
  delete: boolean;
  continueOnError: boolean;
  /** One transaction per table */
  useTransaction: boolean;
  disableFkChecks: boolean;
}

export interface DataSyncProfile {
  version: 1;
  source: SyncEndpoint;
  target: SyncEndpoint;
  /** Also compare same-named tables that are not listed in `mappings` (e.g. created later) */
  autoMap: boolean;
  /** Source tables that automatic mapping must skip */
  excluded: string[];
  mappings: DataSyncMapping[];
  options: DataSyncOptions;
}

export interface DataCompareTable {
  index: number;
  source: string;
  target: string;
  /** Comparison key (source names) */
  key: string[];
  /** Synchronized columns (source names) */
  columns: string[];
  /** Matching target columns (same order as `columns`) */
  targetColumns: string[];
  onlySource: number;
  onlyTarget: number;
  different: number;
  identical: number;
  method: 'merge' | 'hash';
  error: string | null;
  durationMs: number;
}

export interface DataCompareResult {
  compareId: string;
  source: SyncEndpoint;
  target: SyncEndpoint;
  tables: DataCompareTable[];
  durationMs: number;
}

export type DataDiffKind = 'insert' | 'update' | 'delete';

export interface DataDiffRow {
  /** Stable row key (used to exclude rows from the deployment) */
  key: string;
  source: CellValue[] | null;
  target: CellValue[] | null;
}

export interface DataDiffPage {
  total: number;
  /** Synchronized columns (source names) */
  columns: string[];
  sourceMeta: ColumnMeta[];
  targetMeta: ColumnMeta[];
  rows: DataDiffRow[];
}

export interface DataSyncTableSelection {
  index: number;
  insert: boolean;
  update: boolean;
  delete: boolean;
  /** Row keys (DataDiffRow.key) excluded from the deployment */
  excluded: string[];
}

export interface DataSyncScriptResult {
  sql: string;
  /** The preview was cut at the size limit */
  truncated: boolean;
  statements: number;
  bytes: number;
}

export interface DataSyncDeployTableResult {
  source: string;
  target: string;
  inserted: number;
  updated: number;
  deleted: number;
  error: string | null;
}

export interface DataSyncDeployResult {
  tables: DataSyncDeployTableResult[];
  errors: number;
  durationMs: number;
}

// ───────────────────────── Structure synchronization ─────────────────────────

export interface StructSyncOptions {
  ignoreAutoIncrement: boolean;
  ignoreComments: boolean;
  /** Character sets and collations */
  ignoreCharset: boolean;
  ignoreDefiner: boolean;
  ignoreTableOptions: boolean;
  ignorePartitions: boolean;
  triggers: boolean;
  views: boolean;
  routines: boolean;
  events: boolean;
  /** Select objects that only exist in the target for deletion */
  dropExtra: boolean;
  continueOnError: boolean;
}

export interface StructSyncProfile {
  version: 1;
  source: SyncEndpoint;
  target: SyncEndpoint;
  options: StructSyncOptions;
}

/** create = only in source, drop = only in target, alter = different, same = identical */
export type StructStatus = 'create' | 'drop' | 'alter' | 'same';

/** Deployment order: dropFk → drop → table → routine → view → trigger → event → addFk */
export type StructPhase = 'dropFk' | 'drop' | 'table' | 'routine' | 'view' | 'trigger' | 'event' | 'addFk';

export interface StructStatement {
  phase: StructPhase;
  sql: string;
}

export interface StructDiffItem {
  /** `${type}:${name}` */
  id: string;
  type: SyncObjectType;
  name: string;
  /** Table of a trigger */
  table: string | null;
  status: StructStatus;
  /** Normalized DDL used for the comparison ('' = object missing) */
  sourceDdl: string;
  targetDdl: string;
  statements: StructStatement[];
  /** Human readable differences (tables) */
  details: string[];
  /** Sort key inside a phase (dependency order) */
  order: number;
}

export interface StructCompareResult {
  source: SyncEndpoint;
  target: SyncEndpoint;
  options: StructSyncOptions;
  items: StructDiffItem[];
  durationMs: number;
}

export interface StructDeployStatement {
  sql: string;
  /** Diff item the statement belongs to (null = script level statement) */
  itemId: string | null;
  label: string;
}

export interface StructDeployResult {
  executed: number;
  errors: number;
  failed: { label: string; sql: string; error: string }[];
  durationMs: number;
}

// ───────────────────────── API ─────────────────────────

export interface SyncApi {
  /** Objects of a database (tables with row estimates, views, routines, triggers, events) */
  listObjects(connectionId: string, database: string): Promise<SyncObjectList>;

  /** Starts a data transfer; returns the task id (task result: DataTransferResult) */
  startTransfer(profile: DataTransferProfile): Promise<string>;
  /** Per object summary of a transfer task (also available after errors / cancellation) */
  transferSummary(taskId: string): Promise<DataTransferResult | null>;

  /** Tables, columns and keys of both sides (table mapping) */
  dataSyncPrepare(source: SyncEndpoint, target: SyncEndpoint): Promise<DataSyncPrepareResult>;
  /** Starts the data comparison; returns the task id (task result: DataCompareResult) */
  startDataCompare(profile: DataSyncProfile): Promise<string>;
  /** Differing rows of a compared table (source / target values of the synchronized columns) */
  dataDiffRows(compareId: string, table: number, kind: DataDiffKind, offset: number, limit: number): Promise<DataDiffPage>;
  /** Deployment script for the selection (cut at maxBytes) */
  dataSyncScript(
    compareId: string,
    selection: DataSyncTableSelection[],
    options: DataSyncOptions,
    maxBytes: number
  ): Promise<DataSyncScriptResult>;
  /** Writes the complete deployment script to a file; returns the task id */
  startDataSyncSave(compareId: string, selection: DataSyncTableSelection[], options: DataSyncOptions, path: string, encoding: string): Promise<string>;
  /** Executes the deployment; returns the task id (task result: DataSyncDeployResult) */
  startDataSyncDeploy(compareId: string, selection: DataSyncTableSelection[], options: DataSyncOptions): Promise<string>;
  /** Frees the backend state of a comparison */
  releaseCompare(compareId: string): Promise<void>;

  /** Starts the structure comparison; returns the task id (task result: StructCompareResult) */
  startStructCompare(profile: StructSyncProfile): Promise<string>;
  /** Executes deployment statements on the target; returns the task id (task result: StructDeployResult) */
  startStructDeploy(target: SyncEndpoint, statements: StructDeployStatement[], continueOnError: boolean): Promise<string>;
}

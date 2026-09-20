// Backup / restore / extract SQL API (owned by the backup feature).
//
// A backup is a ZIP archive (*.ksbak) with
//   manifest.json            BackupManifest (format version, server, database, objects, row counts, options)
//   ddl/<nnnn>-<type>.sql    one CREATE statement per object
//   data/<nnnn>-<mmmm>.sql   table data as INSERT statements, one statement per line

import type { ServerType } from '../types';

export type BackupObjectType = 'table' | 'view' | 'function' | 'procedure' | 'trigger' | 'event';

export interface BackupObjectRef {
  type: BackupObjectType;
  name: string;
}

/** none = no locking, lock = LOCK TABLES … READ, snapshot = one transaction with a consistent snapshot (InnoDB) */
export type BackupConsistency = 'none' | 'lock' | 'snapshot';

export interface BackupOptions {
  /** all = every object of the enabled types at run time (also objects created later), custom = `objects` */
  selection: 'all' | 'custom';
  /** Explicit object list (selection "custom") */
  objects: BackupObjectRef[];
  /** Object types included with selection "all" */
  types: Record<BackupObjectType, boolean>;
  structure: boolean;
  data: boolean;
  /** 0 = store only, 1 … 9 = deflate level */
  compression: number;
  consistency: BackupConsistency;
  comment: string;
  /** File name without extension; empty = time stamp YYYYMMDDhhmmss */
  fileName: string;
}

/** Stored with api.profiles.save('backup', name, profile) and executed by automation jobs */
export interface BackupProfile {
  connectionId: string;
  database: string;
  options: BackupOptions;
}

export interface ManifestObject {
  type: BackupObjectType;
  name: string;
  /** Archive entry with the CREATE statement ('' when the structure was not saved) */
  ddlFile: string;
  /** Archive entries with INSERT statements (tables) */
  dataFiles: string[];
  /** Saved records (tables whose data was saved), otherwise null */
  rows: number | null;
  /** Triggers: table of the trigger */
  table?: string;
  /** Session settings the object was created with (views, routines, triggers, events) */
  sqlMode?: string;
  collationConnection?: string;
  /** Events: time zone of the schedule */
  timeZone?: string;
  /** Views: other views of this backup the view reads from (the list is in creation order) */
  dependsOn?: string[];
  /** Tables: columns of the INSERT statements (generated columns excluded) */
  columns?: string[];
  engine?: string | null;
  comment?: string;
}

export interface BackupManifest {
  format: 'ks-table-backup';
  formatVersion: number;
  app: string;
  /** ISO time stamp */
  created: string;
  durationMs: number;
  server: { version: string; type: ServerType };
  connectionName: string;
  database: string;
  charset: string;
  collation: string;
  comment: string;
  options: {
    selection: 'all' | 'custom';
    structure: boolean;
    data: boolean;
    consistency: BackupConsistency;
    compression: number;
  };
  /** In restore order: tables, functions, procedures, views (dependency order), triggers, events */
  objects: ManifestObject[];
  totals: { objects: number; rows: number };
}

export interface BackupFileInfo {
  path: string;
  size: number;
  mtime: number;
  manifest: BackupManifest;
}

export interface RestoreOptions {
  /** Database the objects are restored into */
  targetDatabase: string;
  /** Create the target database when it does not exist (charset / collation of the backup) */
  createDatabase: boolean;
  /** Objects to restore; null = all objects of the backup */
  objects: BackupObjectRef[] | null;
  structure: boolean;
  data: boolean;
  /** Drop existing objects before they are created */
  dropExisting: boolean;
  /** Delete the records of existing tables that are not recreated before inserting */
  emptyTables: boolean;
  /** Insert all records in one transaction (rolled back on error) */
  transaction: boolean;
  continueOnError: boolean;
  disableForeignKeys: boolean;
  /** Keep DEFINER clauses; falls back to the current user when the server refuses them */
  keepDefiner: boolean;
}

export interface ExtractOptions {
  /** Objects to extract; null = all */
  objects: BackupObjectRef[] | null;
  structure: boolean;
  data: boolean;
  /** DROP … IF EXISTS before every CREATE */
  dropStatements: boolean;
  /** Start the script with CREATE DATABASE IF NOT EXISTS / USE */
  createDatabase: boolean;
  /** Database name for CREATE DATABASE / USE */
  databaseName: string;
  keepDefiner: boolean;
}

export interface BackupResult {
  file: string;
  objects: number;
  rows: number;
  size: number;
  durationMs: number;
}

export interface RestoreResult {
  database: string;
  objects: number;
  rows: number;
  errors: number;
  warnings: number;
}

export interface ExtractResult {
  file: string;
  statements: number;
  size: number;
}

export interface BackupApi {
  /** Folder with the backups of a database (<profilesDir>/connections/<id>/<db>/backups) */
  folder(connectionId: string, database: string): Promise<string>;
  /** Manifest and file details of a backup file */
  info(file: string): Promise<BackupFileInfo>;
  /** Starts a backup task and returns its id (TaskInfo.result: BackupResult) */
  start(connectionId: string, database: string, options: BackupOptions): Promise<string>;
  /** Starts a restore task and returns its id (TaskInfo.result: RestoreResult) */
  restore(connectionId: string, file: string, options: RestoreOptions): Promise<string>;
  /** Writes one SQL script from a backup; returns the task id (TaskInfo.result: ExtractResult) */
  extract(file: string, target: string, options: ExtractOptions): Promise<string>;
}

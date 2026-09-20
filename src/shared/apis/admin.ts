// Server monitor and "find in database" API (owned by the admin feature).

export interface ProcessInfo {
  /** Connection (thread) id */
  id: string;
  user: string;
  host: string;
  db: string | null;
  command: string;
  /** Seconds in the current state */
  time: number;
  state: string;
  /** Statement text */
  info: string | null;
  /** Progress in percent (MariaDB, 0 = unknown) */
  progress: number;
}

export interface VariableRow {
  name: string;
  global: string | null;
  session: string | null;
}

export interface StatusRow {
  name: string;
  value: string;
}

export type VariableScope = 'GLOBAL' | 'SESSION' | 'PERSIST';
/** How a new variable value is written: detected, always quoted, or as SQL expression */
export type VariableValueMode = 'auto' | 'string' | 'expression';

export type FindMode = 'contains' | 'exact' | 'prefix' | 'word' | 'regex';
export type FindObjectType = 'table' | 'column' | 'view' | 'function' | 'procedure' | 'trigger' | 'event' | 'index';

export interface FindOptions {
  connectionId: string;
  databases: string[];
  /** Data search: tables per database; a missing entry means all tables */
  tables?: Record<string, string[]>;
  text: string;
  target: 'data' | 'structure';
  mode: FindMode;
  caseSensitive: boolean;
  /** Data search: column types to search */
  columnTypes: { text: boolean; numeric: boolean; temporal: boolean; binary: boolean };
  /** Data search: also search views */
  includeViews: boolean;
  /** Data search: maximum number of rows reported per table */
  maxHitsPerTable: number;
  /** Structure search: object types */
  objectTypes: FindObjectType[];
  searchNames: boolean;
  searchDefinitions: boolean;
  searchComments: boolean;
}

/** Summary of a table with matching rows (always precedes its row hits) */
export interface FindTableHit {
  kind: 'table';
  database: string;
  table: string;
  view: boolean;
  count: number;
  /** More rows match than maxHitsPerTable */
  capped: boolean;
  /** Filter (without WHERE) selecting all matching rows */
  where: string;
  columns: string[];
}

export interface FindRowHit {
  kind: 'row';
  database: string;
  table: string;
  view: boolean;
  matches: { column: string; excerpt: string }[];
  /** Primary key of the row as text ("id = 5"), empty without primary key */
  key: string;
  /** Filter (without WHERE) selecting the row */
  where: string;
}

export interface FindObjectHit {
  kind: 'object';
  database: string;
  objectType: FindObjectType;
  name: string;
  /** Table of a column, trigger or index */
  table: string;
  field: 'name' | 'definition' | 'comment';
  excerpt: string;
}

export type FindHit = FindTableHit | FindRowHit | FindObjectHit;

export interface FindProgress {
  hits: FindHit[];
  /** Offset for the next call */
  next: number;
  /** Task finished and all hits delivered */
  done: boolean;
  /** Hit limit reached, later hits were dropped */
  truncated: boolean;
}

export interface AdminApi {
  processList(sessionId: string): Promise<ProcessInfo[]>;
  /** KILL [QUERY] id */
  kill(sessionId: string, id: string, queryOnly: boolean): Promise<void>;
  variables(sessionId: string): Promise<VariableRow[]>;
  /** SET GLOBAL|SESSION|PERSIST name = value; returns the executed statement */
  setVariable(sessionId: string, scope: VariableScope, name: string, value: string, mode: VariableValueMode): Promise<string>;
  status(sessionId: string): Promise<StatusRow[]>;
  innodbStatus(sessionId: string): Promise<string>;
  /** Starts the search task (own session); returns the task id */
  findStart(options: FindOptions): Promise<string>;
  findHits(taskId: string, from: number): Promise<FindProgress>;
  /** Cancels a running search and frees its hits */
  findDispose(taskId: string): Promise<void>;
}

// Test data generator API (owned by the datagen feature).

import type { CellValue } from '../types';

export type GenKind =
  | 'skip'
  | 'null'
  | 'fixed'
  | 'list'
  | 'enum'
  | 'set'
  | 'foreignKey'
  | 'intRange'
  | 'sequence'
  | 'decimalRange'
  | 'boolean'
  | 'bit'
  | 'date'
  | 'datetime'
  | 'time'
  | 'year'
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'gender'
  | 'email'
  | 'userName'
  | 'phone'
  | 'jobTitle'
  | 'street'
  | 'city'
  | 'zip'
  | 'state'
  | 'country'
  | 'countryCode'
  | 'company'
  | 'department'
  | 'iban'
  | 'bic'
  | 'currency'
  | 'creditCard'
  | 'productName'
  | 'productCategory'
  | 'color'
  | 'url'
  | 'domain'
  | 'ip'
  | 'ipv6'
  | 'mac'
  | 'userAgent'
  | 'uuid'
  | 'words'
  | 'sentence'
  | 'paragraph'
  | 'text'
  | 'slug'
  | 'pattern'
  | 'regex'
  | 'json'
  | 'binary'
  | 'geometry';

export interface GenOptions {
  /** intRange / decimalRange / year: value range; words / sentence: words; paragraph: paragraphs; text / binary: length */
  min?: number;
  max?: number;
  /** decimalRange: fractional digits */
  decimals?: number;
  /** sequence */
  start?: number;
  step?: number;
  /** date 'YYYY-MM-DD' / datetime 'YYYY-MM-DD HH:mm:ss' / time 'HH:mm:ss' range */
  from?: string;
  to?: string;
  /** list / enum / set: candidate values */
  values?: string[];
  /** fixed value */
  value?: string;
  /** pattern ('#' digit, '@' letter A-Z, '?' letter, '*' letter or digit, '\' escapes) or regular expression */
  pattern?: string;
  /** boolean: share of true values in percent */
  truePercent?: number;
  /** email / url: domain */
  domain?: string;
  /** email / userName: built from the names of the same record */
  linked?: boolean;
  /** phone number style */
  style?: 'human' | 'national' | 'international';
  /** uuid with hyphens */
  hyphens?: boolean;
  /** json: keys of the generated object */
  keys?: string[];
  /** foreignKey: referenced table / column; constraint = foreign key name (composite keys share one record) */
  refSchema?: string;
  refTable?: string;
  refColumn?: string;
  constraint?: string;
}

export type TextCase = 'none' | 'lower' | 'upper' | 'proper';

export interface ColumnGenConfig {
  column: string;
  kind: GenKind;
  options: GenOptions;
  /** Share of NULL values in percent (nullable columns) */
  nullPercent: number;
  /** Values must not repeat (unique keys are always respected) */
  unique: boolean;
  textCase: TextCase;
}

export interface DgForeignKey {
  constraint: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

export interface DgColumn {
  name: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  generated: boolean;
  unsigned: boolean;
  /** characters (text) or bytes (binary) */
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  enumValues: string[];
  srid: number | null;
  comment: string;
}

export interface DgUniqueKey {
  name: string;
  columns: string[];
  primary: boolean;
}

export interface DgTable {
  name: string;
  /** Current number of records */
  rows: number;
  /** Next AUTO_INCREMENT value */
  autoIncrement: number | null;
  columns: DgColumn[];
  uniqueKeys: DgUniqueKey[];
  foreignKeys: DgForeignKey[];
  /** Parent tables of the foreign keys (same database, without self references) */
  dependsOn: string[];
}

export interface TableGenConfig {
  table: string;
  enabled: boolean;
  rows: number;
  columns: ColumnGenConfig[];
}

export interface DataGenOptions {
  locale: 'de' | 'en';
  /** Fixed seed for reproducible data; null = different data every run */
  seed: number | null;
  /** Delete existing records of the selected tables first */
  emptyTables: boolean;
  rowsPerInsert: number;
  transaction: boolean;
  continueOnError: boolean;
  disableForeignKeys: boolean;
}

/** Stored with api.profiles.save('dataGen', name, plan) and executed by automation */
export interface DataGenPlan {
  connectionId: string;
  database: string;
  /** In generation order */
  tables: TableGenConfig[];
  options: DataGenOptions;
}

export interface DataGenAnalysis {
  database: string;
  tables: DgTable[];
  /** Table names ordered by foreign key dependencies (parents first) */
  order: string[];
}

export interface DataGenPreview {
  table: string;
  columns: string[];
  rows: CellValue[][];
  error: string | null;
}

export interface DataGenTableResult {
  table: string;
  inserted: number;
  failed: number;
  error: string | null;
}

export interface DataGenResult {
  tables: DataGenTableResult[];
  rows: number;
  errors: number;
  durationMs: number;
}

export interface DataGenApi {
  /** Tables, columns, keys and dependency order of a database */
  analyze(connectionId: string, database: string): Promise<DataGenAnalysis>;
  /** First records of every enabled table – nothing is written */
  preview(plan: DataGenPlan, rows?: number): Promise<DataGenPreview[]>;
  /** Starts the generation task; returns the task id (TaskInfo.result: DataGenResult) */
  start(plan: DataGenPlan): Promise<string>;
}

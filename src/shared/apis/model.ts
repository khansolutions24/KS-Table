// RPC interface of the data modeling feature (ER diagram, reverse engineering,
// model ↔ database synchronization, data dictionary).

import type { TableDesign, TableStatus } from '../types';

export interface DiagramColumn {
  name: string;
  /** Full column type, e.g. "int unsigned", "varchar(255)" */
  type: string;
  nullable: boolean;
  pk: boolean;
  /** Member of a single-column unique index */
  unique: boolean;
  /** Member of any index */
  indexed: boolean;
  autoIncrement: boolean;
  generated: boolean;
  defaultValue: string | null;
  comment: string;
}

export interface DiagramForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface DiagramTable {
  name: string;
  engine: string | null;
  rows: number | null;
  comment: string;
  columns: DiagramColumn[];
  primaryKey: string[];
  /** Column lists of unique indexes */
  uniqueKeys: string[][];
  foreignKeys: DiagramForeignKey[];
}

export interface SchemaDiagram {
  schema: string;
  tables: DiagramTable[];
}

export interface ViewDefinition {
  name: string;
  /** SELECT statement with qualifiers of the view's own database removed */
  definition: string;
  /** '' when unknown, else UNDEFINED | MERGE | TEMPTABLE */
  algorithm: string;
  security: string;
  /** '' | CASCADED | LOCAL */
  checkOption: string;
  definer: string;
  updatable: boolean;
}

export interface RoutineParam {
  mode: string;
  name: string;
  type: string;
}

export interface RoutineInfo {
  name: string;
  type: 'FUNCTION' | 'PROCEDURE';
  params: RoutineParam[];
  returns: string | null;
  body: string;
  comment: string;
  deterministic: boolean;
  dataAccess: string;
  security: string;
  definer: string;
  created: string | null;
  modified: string | null;
}

export interface EventInfo {
  name: string;
  schedule: string;
  status: string;
  body: string;
  comment: string;
  definer: string;
}

export interface DatabaseDictionaryData {
  schema: string;
  charset: string;
  collation: string;
  /** e.g. "MySQL 8.4.11" */
  server: string;
  tables: { status: TableStatus; design: TableDesign }[];
  views: ViewDefinition[];
  routines: RoutineInfo[];
  events: EventInfo[];
}

export interface ModelApi {
  /** Tables, columns, keys and foreign keys of a database for the ER diagram (a few information_schema queries). */
  schemaDiagram(sessionId: string, schema: string): Promise<SchemaDiagram>;
  /** Table designs prepared for modeling / comparison (generated columns and spatial keys normalized). */
  tableDesigns(sessionId: string, schema: string, tables: string[]): Promise<TableDesign[]>;
  /** View definitions of a database (all when `views` is null). */
  viewDefinitions(sessionId: string, schema: string, views?: string[] | null): Promise<ViewDefinition[]>;
  /** Everything needed for the data dictionary of a database. */
  dictionaryData(sessionId: string, schema: string): Promise<DatabaseDictionaryData>;
}

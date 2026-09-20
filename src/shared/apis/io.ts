// Import / export / dump SQL / execute SQL file API (owned by the io feature).
//
// Every long running operation is a backend task (see TaskPanel). The *Profile objects are exactly
// what the wizards store with api.profiles.save(kind, name, data) and what the headless profile
// runners (kinds 'import', 'export', 'dumpSql', 'execSqlFile') receive.

// ───────────────────────── common ─────────────────────────

export type DateOrder = 'YMD' | 'DMY' | 'MDY' | 'YDM' | 'DYM' | 'MYD';

// ───────────────────────── import ─────────────────────────

export type ImportFormat = 'csv' | 'txt' | 'json' | 'xml' | 'xlsx';

export type ImportMode = 'append' | 'update' | 'appendUpdate' | 'appendNoUpdate' | 'delete' | 'copy';

export interface ImportParseOptions {
  /** Record (line) delimiter of delimited text files */
  recordDelimiter: 'auto' | 'crlf' | 'lf' | 'cr';
  /** Field delimiter, e.g. ",", ";", "\t", "|" (may be several characters) */
  fieldDelimiter: string;
  /** Text qualifier ('"', "'" or '' = none) */
  textQualifier: string;
  /** Escape character inside values ('' = qualifier is doubled, or '\\') */
  escapeChar: string;
  /** Row with the field names (1-based, 0 = no field name row) – delimited text and Excel */
  headerRow: number;
  /** First data row (1-based, 0 = directly after the field name row) */
  firstDataRow: number;
  /** Last data row (0 = up to the end) */
  lastDataRow: number;
  /** XML: element that identifies a record */
  xmlRowTag: string;
  /** XML: attributes become fields */
  xmlAttributes: boolean;
  dateOrder: DateOrder;
  dateSeparator: string;
  timeSeparator: string;
  decimalSymbol: string;
  /** Encoding of values imported into binary columns */
  binaryEncoding: 'none' | 'base64' | 'hex';
  /** Unquoted value that stands for NULL (e.g. \N or NULL; '' = none) */
  nullText: string;
  /** Empty strings (also quoted ones) are imported as NULL */
  emptyAsNull: boolean;
  /** Remove leading and trailing white space */
  trim: boolean;
}

export interface ImportPreviewRequest {
  format: ImportFormat;
  file: string;
  /** Excel: sheet name (null = first sheet) */
  sheet: string | null;
  encoding: string;
  options: ImportParseOptions;
  /** Rows returned for display (default 100); type detection always looks at up to 1000 records */
  limit?: number;
}

export interface InferredType {
  /** Upper case base type, e.g. INT, DECIMAL, VARCHAR, DATETIME */
  type: string;
  length: string;
  decimals: string;
}

export interface ImportPreview {
  fields: string[];
  /** Detected column types, parallel to fields */
  types: InferredType[];
  /** Display values (null = NULL, undefined values are sent as null too) */
  rows: (string | null)[][];
  /** Source row number of every preview row */
  rowNumbers: number[];
  /** Records looked at for field names / type detection */
  scanned: number;
  /** The source has more records than scanned */
  more: boolean;
}

export interface XmlElementInfo {
  name: string;
  count: number;
  /** Nesting depth (root element = 1) */
  depth: number;
}

export interface ImportFieldMap {
  /** Field of the source file */
  source: string;
  /** Target column ('' = do not import this field) */
  target: string;
  /** Match key for the key based modes; primary key when a new table is created */
  key: boolean;
  /** New table only: column type (upper case base type), length and decimals */
  type: string;
  length: string;
  decimals: string;
}

export interface ImportSourceSpec {
  file: string;
  /** Excel sheet (null for other formats) */
  sheet: string | null;
  /** Target table */
  table: string;
  /** Create the target table */
  newTable: boolean;
  fields: ImportFieldMap[];
}

export interface ImportAdvancedOptions {
  /** Records per INSERT statement (1 = one statement per record) */
  rowsPerStatement: number;
  /** Maximum size of one statement in KB */
  maxStatementKB: number;
  /** Run the whole import in one transaction */
  transaction: boolean;
  continueOnError: boolean;
  /** SET FOREIGN_KEY_CHECKS = 0 while importing */
  disableFkChecks: boolean;
}

export interface ImportProfile {
  version: 1;
  connectionId: string;
  database: string;
  format: ImportFormat;
  encoding: string;
  options: ImportParseOptions;
  sources: ImportSourceSpec[];
  mode: ImportMode;
  advanced: ImportAdvancedOptions;
}

export interface ImportResult {
  sources: number;
  read: number;
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
  errors: number;
  createdTables: string[];
}

// ───────────────────────── export ─────────────────────────

export type ExportFormat = 'csv' | 'txt' | 'json' | 'xml' | 'html' | 'xlsx' | 'sql' | 'md';

export interface ExportObjectSpec {
  /** Table / view name, or the name used for a query result (file, sheet and SQL table name) */
  name: string;
  kind: 'table' | 'view' | 'query';
  /** File name (without folder); '' = derived from the file name pattern */
  fileName: string;
  /** Exported fields in output order (null = all fields) */
  fields: string[] | null;
}

export interface ExportOptions {
  /** Write a header row with the field names */
  header: boolean;
  fieldDelimiter: string;
  recordDelimiter: 'crlf' | 'lf' | 'cr';
  textQualifier: string;
  /** '' = the qualifier is doubled inside values, otherwise the escape character (e.g. '\\') */
  escapeChar: string;
  /** Quote every value (otherwise only when needed) */
  quoteAll: boolean;
  /** TXT: delimited or fixed width columns */
  txtLayout: 'delimited' | 'fixed';
  /** iconv-lite encoding name; 'utf8bom' = UTF-8 with byte order mark */
  encoding: string;
  /** Text written for NULL in text formats */
  nullText: string;
  /** Date pattern (YYYY, YY, MM, M, DD, D) */
  dateFormat: string;
  /** Time pattern (HH, H, hh, h, mm, ss, SSS…, A) */
  timeFormat: string;
  decimalSeparator: string;
  thousandsSeparator: string;
  /** Write zero numbers as empty value */
  blankIfZero: boolean;
  binaryEncoding: 'hex' | 'base64' | 'none';
  /** Append to an existing file (CSV, TXT, JSON lines, SQL, Markdown) */
  append: boolean;
  continueOnError: boolean;
  jsonLayout: 'array' | 'lines';
  jsonPretty: boolean;
  /** XML: values as attributes of the record element instead of child elements */
  xmlAttributes: boolean;
  sqlCreateTable: boolean;
  sqlDropTable: boolean;
  sqlRowsPerStatement: number;
}

export interface ExportProfile {
  version: 1;
  connectionId: string;
  database: string | null;
  format: ExportFormat;
  /** Source query (objects then contains one entry with kind 'query') */
  query: string | null;
  objects: ExportObjectSpec[];
  outputDir: string;
  /** Pattern for file names: {name}, {db} */
  fileNamePattern: string;
  /** Export all objects into one file (Excel: one sheet per object) */
  sameFile: boolean;
  sameFileName: string;
  /** Append a timestamp to the file names */
  timestamp: boolean;
  timestampFormat: string;
  options: ExportOptions;
}

export interface ExportResult {
  objects: number;
  rows: number;
  files: string[];
  errors: number;
}

// ───────────────────────── dump SQL file ─────────────────────────

export interface DumpObjects {
  tables: string[];
  views: string[];
  functions: string[];
  procedures: string[];
  triggers: string[];
  events: string[];
}

export interface DumpOptions {
  structureOnly: boolean;
  /** DROP … IF EXISTS before every CREATE */
  dropStatements: boolean;
  /** CREATE DATABASE IF NOT EXISTS + USE */
  createDatabase: boolean;
  extendedInsert: boolean;
  maxRowsPerInsert: number;
  maxInsertKB: number;
  /** INSERT with column list */
  completeInsert: boolean;
  binaryAs: 'hex' | 'base64';
  /** Consistent reading: none, InnoDB snapshot or LOCK TABLES … READ */
  consistency: 'none' | 'snapshot' | 'lock';
  /** LOCK TABLES … WRITE around the data of every table in the output */
  addLocks: boolean;
  disableFkChecks: boolean;
  disableUniqueChecks: boolean;
  /** Keep the AUTO_INCREMENT table option */
  autoIncrement: boolean;
  /** SET NAMES utf8mb4 at the beginning */
  charsetHeader: boolean;
  /** Remove DEFINER clauses of views, routines, triggers and events */
  stripDefiner: boolean;
}

export interface DumpProfile {
  version: 1;
  connectionId: string;
  database: string;
  file: string;
  /** null = all objects of the database (determined when the dump runs) */
  objects: DumpObjects | null;
  options: DumpOptions;
}

export interface DumpResult {
  file: string;
  bytes: number;
  tables: number;
  rows: number;
  objects: number;
}

// ───────────────────────── execute SQL file ─────────────────────────

export type ExecTransactionMode = 'autocommit' | 'noAutocommit' | 'transaction';

export interface ExecSqlFileProfile {
  version: 1;
  connectionId: string;
  /** Default database (null = none) */
  database: string | null;
  files: string[];
  /** iconv-lite encoding name or 'auto' (BOM, otherwise UTF-8) */
  encoding: string;
  continueOnError: boolean;
  transactionMode: ExecTransactionMode;
}

export interface ExecSqlFileResult {
  files: number;
  statements: number;
  errors: number;
  bytes: number;
  durationMs: number;
}

// ───────────────────────── RPC ─────────────────────────

export interface IoApi {
  /** Parses the beginning of a source file (preview grid, field names, detected types) */
  previewImport(req: ImportPreviewRequest): Promise<ImportPreview>;
  /** Sheet names of an .xlsx workbook in workbook order */
  xlsxSheets(file: string): Promise<string[]>;
  /** Candidate record elements of an XML file (from the first megabytes) */
  xmlElements(file: string, encoding: string): Promise<XmlElementInfo[]>;
  /** Starts an import task, returns the task id */
  startImport(profile: ImportProfile): Promise<string>;
  /** Column names of a query result (without fetching rows) */
  queryColumns(connectionId: string, database: string | null, sql: string): Promise<string[]>;
  startExport(profile: ExportProfile): Promise<string>;
  startDump(profile: DumpProfile): Promise<string>;
  startExecSqlFile(profile: ExecSqlFileProfile): Promise<string>;
}

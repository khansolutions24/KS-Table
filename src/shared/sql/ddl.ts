// DDL generation for MySQL / MariaDB.
//  • Tables: CREATE TABLE from a TableDesign and ALTER TABLE statements from the difference of two designs
//    (used by the table designer, structure synchronization and the model designer), partition clauses.
//  • Views, stored routines, events and triggers (object designers).

import type { CheckDef, FieldDef, ForeignKeyDef, IndexDef, TableDesign, TableOptions, TriggerDef } from '../types';
import { qname, quoteId, quoteString } from './quote';

export interface DdlOptions {
  serverType?: 'mysql' | 'mariadb';
  /** major * 10000 + minor * 100 + patch; undefined / 0 = assume a current server version */
  serverVersion?: number;
  /** Include DEFINER clauses of triggers */
  includeDefiner?: boolean;
}

const NUMERIC = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'REAL']);
const CHARSET_TYPES = new Set(['CHAR', 'VARCHAR', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'ENUM', 'SET']);
const NO_LITERAL_DEFAULT = new Set([
  'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'JSON', 'GEOMETRY', 'POINT',
  'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON', 'GEOMETRYCOLLECTION', 'GEOMCOLLECTION'
]);
const TEMPORAL_FSP = new Set(['DATETIME', 'TIMESTAMP', 'TIME']);
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const CURRENT_TS_RE = /^(current_timestamp|now|localtime|localtimestamp)(\s*\(\s*\d*\s*\))?$/i;

const isMaria = (o: DdlOptions): boolean => o.serverType === 'mariadb';
const versionAtLeast = (o: DdlOptions, v: number): boolean => !o.serverVersion || o.serverVersion >= v;

export function isNumericType(type: string): boolean {
  return NUMERIC.has(type.toUpperCase());
}

export function supportsCharset(type: string): boolean {
  return CHARSET_TYPES.has(type.toUpperCase());
}

/** Data type part: VARCHAR(255), DECIMAL(10,2) UNSIGNED, ENUM('a','b') CHARACTER SET … COLLATE … */
export function fieldTypeSql(f: FieldDef): string {
  const t = f.type.toUpperCase().trim();
  let s: string;
  if (t === 'ENUM' || t === 'SET') {
    s = `${t}(${f.values.map(quoteString).join(',')})`;
  } else if (f.length && f.decimals) {
    s = `${t}(${f.length},${f.decimals})`;
  } else if (f.length && t !== 'YEAR') {
    s = `${t}(${f.length})`;
  } else {
    s = t;
  }
  if (NUMERIC.has(t)) {
    if (f.unsigned) s += ' UNSIGNED';
    if (f.zerofill) s += ' ZEROFILL';
  }
  if (CHARSET_TYPES.has(t)) {
    if (f.binary) s += ' BINARY';
    if (f.charset) s += ` CHARACTER SET ${f.charset}`;
    if (f.collation) s += ` COLLATE ${f.collation}`;
  }
  return s;
}

export function defaultSql(f: FieldDef, opts: DdlOptions = {}): string | null {
  const t = f.type.toUpperCase();
  switch (f.defaultKind) {
    case 'none':
      return null;
    case 'null':
      return f.notNull ? null : 'NULL';
    case 'empty':
      return NO_LITERAL_DEFAULT.has(t) && !isMaria(opts) ? "('')" : "''";
    case 'value': {
      const v = f.defaultValue;
      if (t === 'BIT' && /^[01]+$/.test(v)) return `b'${v}'`;
      if (NUMERIC.has(t) && NUMBER_RE.test(v.trim())) return v.trim();
      if (NO_LITERAL_DEFAULT.has(t) && !isMaria(opts)) return `(${quoteString(v)})`;
      return quoteString(v);
    }
    case 'expression': {
      const e = f.defaultValue.trim();
      if (!e) return null;
      if (CURRENT_TS_RE.test(e) || e.startsWith('(') || /^b'[01]*'$/i.test(e) || /^0x[0-9a-f]+$/i.test(e) || NUMBER_RE.test(e)) return e;
      if (/^null$/i.test(e)) return 'NULL';
      return isMaria(opts) ? e : `(${e})`;
    }
  }
  return null;
}

/** Column definition without the column name */
export function columnBody(f: FieldDef, opts: DdlOptions = {}): string {
  const t = f.type.toUpperCase();
  const parts: string[] = [fieldTypeSql(f)];
  if (f.generated && f.generatedExpr.trim()) {
    parts.push(`GENERATED ALWAYS AS (${f.generatedExpr.trim()}) ${f.generatedStored ? 'STORED' : 'VIRTUAL'}`);
    // MariaDB does not accept NULL / NOT NULL on generated columns
    if (!isMaria(opts)) parts.push(f.notNull ? 'NOT NULL' : 'NULL');
  } else {
    parts.push(f.notNull ? 'NOT NULL' : 'NULL');
    if (f.srid) parts.push(`SRID ${f.srid}`);
    const d = defaultSql(f, opts);
    if (d !== null) parts.push(`DEFAULT ${d}`);
    if (f.onUpdateCurrentTimestamp && (t === 'TIMESTAMP' || t === 'DATETIME')) {
      parts.push(`ON UPDATE CURRENT_TIMESTAMP${f.length && TEMPORAL_FSP.has(t) ? `(${f.length})` : ''}`);
    }
    if (f.autoIncrement) parts.push('AUTO_INCREMENT');
  }
  if (f.invisible) parts.push('INVISIBLE');
  if (f.comment) parts.push(`COMMENT ${quoteString(f.comment)}`);
  return parts.join(' ');
}

export function columnDefinition(f: FieldDef, opts: DdlOptions = {}): string {
  return `${quoteId(f.name)} ${columnBody(f, opts)}`;
}

function keyParts(ix: IndexDef): string {
  // FULLTEXT / SPATIAL indexes take neither prefix lengths nor a sort order
  const plain = ix.type === 'FULLTEXT' || ix.type === 'SPATIAL';
  return ix.fields
    .map((p) => {
      const order = p.order && !plain ? ` ${p.order}` : '';
      if (p.expr && !p.name) return `(${p.expr})${order}`;
      return `${quoteId(p.name)}${p.subPart && !plain ? `(${p.subPart})` : ''}${order}`;
    })
    .join(', ');
}

function indexOptions(ix: IndexDef, opts: DdlOptions): string {
  const o: string[] = [];
  if (ix.method && ix.type !== 'FULLTEXT' && ix.type !== 'SPATIAL') o.push(`USING ${ix.method}`);
  if (ix.keyBlockSize) o.push(`KEY_BLOCK_SIZE = ${ix.keyBlockSize}`);
  if (ix.parser && ix.type === 'FULLTEXT') o.push(`WITH PARSER ${quoteId(ix.parser)}`);
  if (ix.comment) o.push(`COMMENT ${quoteString(ix.comment)}`);
  if (ix.invisible) o.push(isMaria(opts) ? 'IGNORED' : 'INVISIBLE');
  return o.length ? ` ${o.join(' ')}` : '';
}

const INDEX_KW: Record<IndexDef['type'], string> = { NORMAL: 'INDEX', UNIQUE: 'UNIQUE INDEX', FULLTEXT: 'FULLTEXT INDEX', SPATIAL: 'SPATIAL INDEX' };

/** Index definition as used inside CREATE TABLE and after ADD in ALTER TABLE (an empty name lets the server choose one) */
export function indexDefinition(ix: IndexDef, opts: DdlOptions = {}): string {
  return `${INDEX_KW[ix.type]}${ix.name ? ` ${quoteId(ix.name)}` : ''} (${keyParts(ix)})${indexOptions(ix, opts)}`;
}

/** FOREIGN KEY constraint (an empty name lets the server generate one) */
export function fkDefinition(fk: ForeignKeyDef, tableSchema: string): string {
  const ref = fk.refSchema && fk.refSchema !== tableSchema ? qname(fk.refSchema, fk.refTable) : quoteId(fk.refTable);
  let s = `${fk.name ? `CONSTRAINT ${quoteId(fk.name)} ` : ''}FOREIGN KEY (${fk.fields.map(quoteId).join(', ')}) REFERENCES ${ref} (${fk.refFields.map(quoteId).join(', ')})`;
  if (fk.onDelete) s += ` ON DELETE ${fk.onDelete}`;
  if (fk.onUpdate) s += ` ON UPDATE ${fk.onUpdate}`;
  return s;
}

/** CHECK constraint (an empty name lets the server generate one) */
export function checkDefinition(c: CheckDef, opts: DdlOptions = {}): string {
  return `${c.name ? `CONSTRAINT ${quoteId(c.name)} ` : ''}CHECK (${c.expr})${!c.enforced && !isMaria(opts) ? ' NOT ENFORCED' : ''}`;
}

type OptKey = keyof TableOptions;

function optionClause(k: OptKey, o: TableOptions): string | null {
  const v = o[k];
  switch (k) {
    case 'engine':
      return v ? `ENGINE = ${v}` : null;
    case 'charset':
      return v ? `CHARACTER SET = ${v}` : null;
    case 'collation':
      return v ? `COLLATE = ${v}` : null;
    case 'autoIncrement':
      return v ? `AUTO_INCREMENT = ${v}` : null;
    case 'rowFormat':
      return v ? `ROW_FORMAT = ${v}` : null;
    case 'avgRowLength':
      return v ? `AVG_ROW_LENGTH = ${v}` : null;
    case 'maxRows':
      return v ? `MAX_ROWS = ${v}` : null;
    case 'minRows':
      return v ? `MIN_ROWS = ${v}` : null;
    case 'keyBlockSize':
      return v ? `KEY_BLOCK_SIZE = ${v}` : null;
    case 'checksum':
      return `CHECKSUM = ${v ? 1 : 0}`;
    case 'delayKeyWrite':
      return `DELAY_KEY_WRITE = ${v ? 1 : 0}`;
    case 'packKeys':
      return v ? `PACK_KEYS = ${v}` : null;
    case 'statsAutoRecalc':
      return v ? `STATS_AUTO_RECALC = ${v}` : null;
    case 'statsPersistent':
      return v ? `STATS_PERSISTENT = ${v}` : null;
    case 'statsSamplePages':
      return v ? `STATS_SAMPLE_PAGES = ${v}` : null;
    case 'tablespace':
      return v ? `TABLESPACE ${quoteId(String(v))}` : null;
    case 'compression':
      return v ? `COMPRESSION = ${quoteString(String(v))}` : null;
    case 'encryption':
      return v ? `ENCRYPTION = ${quoteString(String(v))}` : null;
    case 'dataDirectory':
      return v ? `DATA DIRECTORY = ${quoteString(String(v))}` : null;
    case 'indexDirectory':
      return v ? `INDEX DIRECTORY = ${quoteString(String(v))}` : null;
    case 'insertMethod':
      return v ? `INSERT_METHOD = ${v}` : null;
    case 'union':
      return v ? `UNION = (${String(v)})` : null;
  }
  return null;
}

/** ALTER TABLE clause that resets a table option whose value was cleared (null = option cannot be reset) */
function resetClause(k: OptKey): string | null {
  switch (k) {
    case 'rowFormat':
      return 'ROW_FORMAT = DEFAULT';
    case 'avgRowLength':
      return 'AVG_ROW_LENGTH = 0';
    case 'maxRows':
      return 'MAX_ROWS = 0';
    case 'minRows':
      return 'MIN_ROWS = 0';
    case 'keyBlockSize':
      return 'KEY_BLOCK_SIZE = 0';
    case 'packKeys':
      return 'PACK_KEYS = DEFAULT';
    case 'statsAutoRecalc':
      return 'STATS_AUTO_RECALC = DEFAULT';
    case 'statsPersistent':
      return 'STATS_PERSISTENT = DEFAULT';
    case 'statsSamplePages':
      return 'STATS_SAMPLE_PAGES = DEFAULT';
    case 'tablespace':
      return 'TABLESPACE `innodb_file_per_table`';
    case 'compression':
      return "COMPRESSION = 'None'";
    case 'encryption':
      return "ENCRYPTION = 'N'";
    case 'insertMethod':
      return 'INSERT_METHOD = NO';
    case 'union':
      return 'UNION = ()';
    default:
      return null;
  }
}

const OPTION_ORDER: OptKey[] = [
  'engine', 'autoIncrement', 'charset', 'collation', 'rowFormat', 'avgRowLength', 'maxRows', 'minRows', 'keyBlockSize',
  'checksum', 'delayKeyWrite', 'packKeys', 'statsAutoRecalc', 'statsPersistent', 'statsSamplePages', 'tablespace',
  'compression', 'encryption', 'dataDirectory', 'indexDirectory', 'insertMethod', 'union'
];

/** Table options for CREATE TABLE (only non-default values) */
export function createOptionsSql(o: TableOptions, comment: string): string[] {
  const out: string[] = [];
  for (const k of OPTION_ORDER) {
    if ((k === 'checksum' || k === 'delayKeyWrite') && !o[k]) continue;
    const c = optionClause(k, o);
    if (c) out.push(c);
  }
  if (comment) out.push(`COMMENT = ${quoteString(comment)}`);
  return out;
}

export function triggerSql(t: TriggerDef, schema: string, table: string, opts: DdlOptions = {}): string {
  const definer = opts.includeDefiner && t.definer.trim() ? `DEFINER = ${formatDefiner(t.definer)} ` : '';
  const order = t.orderType && t.orderOther ? ` ${t.orderType} ${quoteId(t.orderOther)}` : '';
  return `CREATE ${definer}TRIGGER ${qname(schema, t.name)} ${t.timing} ${t.event} ON ${qname(schema, table)} FOR EACH ROW${order} ${t.body.trim()}`;
}

/** user@host (as shown by information_schema, quoted or not) → `user`@`host`; CURRENT_USER stays as is */
export function formatDefiner(definer: string): string {
  const d = definer.trim();
  if (/^current_user(\s*\(\s*\))?$/i.test(d)) return 'CURRENT_USER';
  const parts = splitDefiner(d);
  if (!parts) return quoteId(unquoteIdent(d));
  return `${quoteId(parts.user)}@${quoteId(parts.host)}`;
}

/** Splits a definer into user and host (quotes removed); null when there is no host part */
export function splitDefiner(definer: string): { user: string; host: string } | null {
  const d = definer.trim();
  // quoted user part may itself contain '@'
  const m = /^(`(?:[^`]|``)*`|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*")@(.+)$/.exec(d);
  if (m) return { user: unquoteIdent(m[1]), host: unquoteIdent(m[2]) };
  const at = d.lastIndexOf('@');
  if (at < 0) return null;
  return { user: unquoteIdent(d.slice(0, at)), host: unquoteIdent(d.slice(at + 1)) };
}

/** Plain user@host form of a definer (for display / comparison) */
export function plainDefiner(definer: string): string {
  const p = splitDefiner(definer);
  return p ? `${p.user}@${p.host}` : unquoteIdent(definer);
}

export interface CreateTableOptions extends DdlOptions {
  ifNotExists?: boolean;
  /** Include FOREIGN KEY constraints inline (default true) */
  foreignKeys?: boolean;
  /** Also return CREATE TRIGGER statements (default true) */
  triggers?: boolean;
  /** Qualify the table name with its schema (default true) */
  qualified?: boolean;
}

export type DdlStepKind = 'createTable' | 'dropTrigger' | 'dropForeignKeys' | 'alterTable' | 'partition' | 'addForeignKeys' | 'createTrigger';

/** One statement of a table change with its purpose (lets callers react to partial success) */
export interface DdlStep {
  kind: DdlStepKind;
  sql: string;
  /** Table name (createTable), trigger name (trigger steps) or constraint names (foreign key steps) */
  names: string[];
}

/** Triggers ordered so that a trigger referenced by FOLLOWS / PRECEDES is created first */
function orderTriggers(list: TriggerDef[]): TriggerDef[] {
  const pending = [...list];
  const out: TriggerDef[] = [];
  while (pending.length) {
    const names = new Set(pending.map((t) => t.name.toLowerCase()));
    let i = pending.findIndex(
      (t) => !t.orderType || !t.orderOther || t.orderOther.toLowerCase() === t.name.toLowerCase() || !names.has(t.orderOther.toLowerCase())
    );
    if (i < 0) i = 0;
    out.push(pending.splice(i, 1)[0]);
  }
  return out;
}

/** CREATE TABLE and CREATE TRIGGER statements for a design, tagged with their purpose */
export function createTableSteps(d: TableDesign, opts: CreateTableOptions = {}): DdlStep[] {
  const lines: string[] = d.fields.map((f) => `  ${columnDefinition(f, opts)}`);
  if (d.primaryKey.length) lines.push(`  PRIMARY KEY (${d.primaryKey.map(quoteId).join(', ')})`);
  for (const ix of d.indexes) lines.push(`  ${indexDefinition(ix, opts)}`);
  if (opts.foreignKeys !== false) for (const fk of d.foreignKeys) lines.push(`  ${fkDefinition(fk, d.schema)}`);
  for (const c of d.checks) lines.push(`  ${checkDefinition(c, opts)}`);
  const name = opts.qualified === false ? quoteId(d.name) : qname(d.schema, d.name);
  const options = createOptionsSql(d.options, d.comment);
  let sql = `CREATE TABLE ${opts.ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (\n${lines.join(',\n')}\n)`;
  if (options.length) sql += ` ${options.join(' ')}`;
  const partition = (d.partition ?? '').trim();
  if (partition) sql += `\n${partition}`;
  const steps: DdlStep[] = [{ kind: 'createTable', sql, names: [d.name] }];
  if (opts.triggers !== false) {
    for (const t of orderTriggers(d.triggers)) steps.push({ kind: 'createTrigger', sql: triggerSql(t, d.schema, d.name, opts), names: [t.name] });
  }
  return steps;
}

/** CREATE TABLE (and CREATE TRIGGER) statements for a design */
export function createTableSql(d: TableDesign, opts: CreateTableOptions = {}): string[] {
  return createTableSteps(d, opts).map((s) => s.sql);
}

/** Foreign keys as separate ALTER TABLE statements (for dumps / model export after all tables exist) */
export function addForeignKeysSql(d: TableDesign): string[] {
  if (!d.foreignKeys.length) return [];
  return [`ALTER TABLE ${qname(d.schema, d.name)}\n  ${d.foreignKeys.map((fk) => `ADD ${fkDefinition(fk, d.schema)}`).join(',\n  ')}`];
}

// ───────────────────────── Identifiers inside expressions ─────────────────────────

/** Removes quotes around an identifier (`a``b` → a`b, "x" → x, 'y' → y) */
export function unquoteIdent(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '`' || q === '"' || q === "'") && t[t.length - 1] === q) {
      const inner = t.slice(1, -1);
      if (q === '`') return inner.replace(/``/g, '`');
      return inner.replace(new RegExp(q + q, 'g'), q).replace(/\\(.)/g, '$1');
    }
  }
  return t;
}

interface ExprToken {
  kind: 'str' | 'id' | 'word' | 'other';
  text: string;
  start: number;
  end: number;
}

function scanExpr(expr: string): ExprToken[] {
  const out: ExprToken[] = [];
  const n = expr.length;
  let i = 0;
  while (i < n) {
    const c = expr[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (expr[j] === '\\') {
          j += 2;
          continue;
        }
        if (expr[j] === c) {
          if (expr[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push({ kind: 'str', text: expr.slice(i, j + 1), start: i, end: Math.min(n, j + 1) });
      i = j + 1;
    } else if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (expr[j] === '`') {
          if (expr[j + 1] === '`') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push({ kind: 'id', text: expr.slice(i, j + 1), start: i, end: Math.min(n, j + 1) });
      i = j + 1;
    } else if (/[A-Za-z0-9_$\u0080-\uffff]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(expr[j])) j++;
      out.push({ kind: 'word', text: expr.slice(i, j), start: i, end: j });
      i = j;
    } else {
      out.push({ kind: 'other', text: c, start: i, end: i + 1 });
      i++;
    }
  }
  return out;
}

/** Lower-case identifiers (quoted and bare words) used in an expression */
export function exprIdentifiers(expr: string): Set<string> {
  const out = new Set<string>();
  for (const t of scanExpr(expr)) {
    if (t.kind === 'id') out.add(unquoteIdent(t.text).toLowerCase());
    else if (t.kind === 'word') out.add(t.text.toLowerCase());
  }
  return out;
}

/** Replaces references to column `oldName` in an expression (strings, qualified names and function calls are left alone) */
export function renameColumnInExpr(expr: string, oldName: string, newName: string): string {
  if (!oldName || oldName === newName) return expr;
  const toks = scanExpr(expr);
  const old = oldName.toLowerCase();
  let out = '';
  let last = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    let match = false;
    if (t.kind === 'id') match = unquoteIdent(t.text).toLowerCase() === old;
    else if (t.kind === 'word' && t.text.toLowerCase() === old) {
      const prev = expr.slice(0, t.start).trimEnd();
      const next = expr.slice(t.end).trimStart();
      match = !prev.endsWith('.') && !prev.endsWith('@') && !next.startsWith('(') && !next.startsWith('.');
    }
    if (match) {
      out += expr.slice(last, t.start) + quoteId(newName);
      last = t.end;
    }
  }
  return out + expr.slice(last);
}

/** Canonical form for comparing clauses: whitespace and keyword / identifier case ignored, string literals kept */
function normalizeWs(s: string): string {
  return scanExpr(s ?? '')
    .filter((t) => !(t.kind === 'other' && /\s/.test(t.text)))
    .map((t) => (t.kind === 'str' ? t.text : t.kind === 'id' ? unquoteIdent(t.text).toLowerCase() : t.text.toLowerCase()))
    .join(' ')
    .replace(/ ?([(),=]) ?/g, '$1')
    .trim();
}

// ───────────────────────── ALTER TABLE diff ─────────────────────────

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function indexSignature(ix: IndexDef): string {
  return `${ix.type}|${ix.method}|${keyParts(ix)}|${ix.comment}|${ix.parser}|${ix.keyBlockSize}`;
}

/** Referential action as the server reports it when none was specified */
function fkAction(a: string, opts: DdlOptions): string {
  return a || (isMaria(opts) ? 'RESTRICT' : 'NO ACTION');
}

function fkSignature(fk: ForeignKeyDef, schema: string, opts: DdlOptions = {}): string {
  return `${fk.fields.join(',')}|${fk.refSchema || schema}|${fk.refTable}|${fk.refFields.join(',')}|${fkAction(fk.onDelete, opts)}|${fkAction(fk.onUpdate, opts)}`;
}

function triggerSignature(t: TriggerDef, opts: DdlOptions = {}): string {
  const order = t.orderType && t.orderOther ? `${t.orderType} ${t.orderOther}` : '';
  const definer = opts.includeDefiner ? `|${t.definer.trim() ? formatDefiner(t.definer) : ''}` : '';
  return `${t.name}|${t.timing}|${t.event}|${t.body.trim()}|${order}${definer}`;
}

/** A nullable column without DEFAULT clause gets DEFAULT NULL – both forms compare equal */
const sameDefaultForm = (f: FieldDef): FieldDef => (!f.notNull && f.defaultKind === 'none' ? { ...f, defaultKind: 'null' } : f);

type GenKind = 'none' | 'virtual' | 'stored';
const genKind = (f: FieldDef): GenKind => (f.generated && f.generatedExpr.trim() ? (f.generatedStored ? 'stored' : 'virtual') : 'none');

/** MySQL cannot MODIFY a column between VIRTUAL and anything else – such columns are dropped and added again */
function needsRecreate(a: FieldDef, b: FieldDef): boolean {
  const ka = genKind(a);
  const kb = genKind(b);
  return ka !== kb && (ka === 'virtual' || kb === 'virtual');
}

export interface AlterOptions extends DdlOptions {
  /** Keep columns / indexes that only exist in `from` (structure sync option) */
  keepDropped?: boolean;
}

/**
 * Statements (with their purpose) that transform table `from` into `to`.
 * Existing objects in `to` are matched through `origName`; objects without origName are new.
 * Order: drop changed triggers → drop foreign keys → one ALTER TABLE (checks, indexes, primary key, columns,
 * options, rename) → partitioning → add foreign keys → create triggers.
 */
export function alterTableSteps(from: TableDesign, to: TableDesign, opts: AlterOptions = {}): DdlStep[] {
  const schema = from.schema;
  const maria = isMaria(opts);
  const oldName = qname(schema, from.name);
  const newTableName = to.name && to.name !== from.name ? to.name : from.name;
  const tableRef = qname(schema, newTableName);
  const steps: DdlStep[] = [];

  // ── columns: matching by origName (first claim wins), renames and re-created columns
  const fromByName = new Map(from.fields.map((f) => [f.name, f]));
  const toByOrig = new Map<string, FieldDef>();
  for (const f of to.fields) if (f.origName && fromByName.has(f.origName) && !toByOrig.has(f.origName)) toByOrig.set(f.origName, f);
  const recreated = new Set<string>();
  for (const [orig, f] of toByOrig) if (needsRecreate(fromByName.get(orig)!, f)) recreated.add(f.name);
  const rename = new Map<string, string>();
  for (const [orig, f] of toByOrig) rename.set(orig, f.name);
  const mapCol = (n: string) => rename.get(n) ?? n;
  const recreatedLower = new Set([...recreated].map((n) => n.toLowerCase()));
  const touchesRecreated = (cols: string[]) => cols.some((c) => recreated.has(c));
  const exprTouchesRecreated = (expr: string) => recreatedLower.size > 0 && [...exprIdentifiers(expr)].some((x) => recreatedLower.has(x));

  // ── triggers that change or disappear are dropped first
  const fromTrig = new Map(from.triggers.map((t) => [t.name, t]));
  const toTrigByOrig = new Map<string, TriggerDef>();
  for (const t of to.triggers) if (t.origName && fromTrig.has(t.origName) && !toTrigByOrig.has(t.origName)) toTrigByOrig.set(t.origName, t);
  const keptTriggers = new Set<TriggerDef>();
  for (const t of from.triggers) {
    const nt = toTrigByOrig.get(t.name);
    if (nt && triggerSignature(nt, opts) === triggerSignature(t, opts)) keptTriggers.add(nt);
    else if (nt || !opts.keepDropped) steps.push({ kind: 'dropTrigger', sql: `DROP TRIGGER ${qname(schema, t.name)}`, names: [t.name] });
  }

  // ── foreign keys: removed / changed ones are dropped in a separate statement
  const selfRef = (fk: ForeignKeyDef) => fk.refTable === from.name && (fk.refSchema || schema) === schema;
  const fkAsRenamed = (fk: ForeignKeyDef): ForeignKeyDef =>
    selfRef(fk)
      ? { ...fk, fields: fk.fields.map(mapCol), refTable: newTableName, refFields: fk.refFields.map(mapCol) }
      : { ...fk, fields: fk.fields.map(mapCol) };
  const toFkByOrig = new Map<string, ForeignKeyDef>();
  for (const fk of to.foreignKeys) if (fk.origName && !toFkByOrig.has(fk.origName)) toFkByOrig.set(fk.origName, fk);
  // MySQL refuses to change the data type of foreign key columns and to drop a primary key a foreign key of the
  // table itself refers to – such foreign keys are dropped before and added again after the table change
  const retyped = new Set<string>();
  for (const [orig, f] of toByOrig) {
    const old = fromByName.get(orig)!;
    if (fieldTypeSql(old) !== fieldTypeSql(f) || old.notNull !== f.notNull) retyped.add(f.name);
  }
  const pkWillChange =
    !sameList(from.primaryKey.map((n) => toByOrig.get(n)?.name ?? ` ${n}`), to.primaryKey) || to.primaryKey.some((n) => recreated.has(n));
  const blocksChange = (fk: ForeignKeyDef) =>
    fk.fields.some((c) => retyped.has(c)) || (fk.refTable === newTableName && (fk.refSchema || schema) === schema && (pkWillChange || fk.refFields.some((c) => retyped.has(c))));
  const dropFks: string[] = [];
  const addFks: ForeignKeyDef[] = [];
  const keptFks = new Set<ForeignKeyDef>();
  for (const fk of from.foreignKeys) {
    const nf = toFkByOrig.get(fk.name);
    if (!nf) {
      if (!opts.keepDropped) dropFks.push(fk.name);
    } else if (nf.name !== fk.name || fkSignature(nf, schema, opts) !== fkSignature(fkAsRenamed(fk), schema, opts) || touchesRecreated(nf.fields) || blocksChange(nf)) {
      dropFks.push(fk.name);
      addFks.push(nf);
      keptFks.add(nf);
    } else keptFks.add(nf);
  }
  for (const fk of to.foreignKeys) if (!keptFks.has(fk)) addFks.push(fk);
  if (dropFks.length) {
    steps.push({ kind: 'dropForeignKeys', sql: `ALTER TABLE ${oldName}\n  ${dropFks.map((n) => `DROP FOREIGN KEY ${quoteId(n)}`).join(',\n  ')}`, names: dropFks });
  }

  const specs: string[] = [];

  // ── checks
  const toCheckByOrig = new Map<string, CheckDef>();
  for (const c of to.checks) if (c.origName && !toCheckByOrig.has(c.origName)) toCheckByOrig.set(c.origName, c);
  const addChecks: CheckDef[] = [];
  const keptChecks = new Set<CheckDef>();
  const dropCheckKw = maria ? 'DROP CONSTRAINT' : 'DROP CHECK';
  for (const c of from.checks) {
    const nc = toCheckByOrig.get(c.name);
    if (!nc) {
      if (!opts.keepDropped) specs.push(`${dropCheckKw} ${quoteId(c.name)}`);
      continue;
    }
    keptChecks.add(nc);
    const sameDef = nc.name === c.name && nc.expr.trim() === c.expr.trim() && !exprTouchesRecreated(nc.expr);
    if (sameDef && nc.enforced !== c.enforced && !maria) {
      specs.push(`ALTER CHECK ${quoteId(c.name)} ${nc.enforced ? 'ENFORCED' : 'NOT ENFORCED'}`);
    } else if (!sameDef || (maria && nc.enforced !== c.enforced)) {
      specs.push(`${dropCheckKw} ${quoteId(c.name)}`);
      addChecks.push(nc);
    }
  }
  for (const c of to.checks) if (!keptChecks.has(c)) addChecks.push(c);

  // ── indexes (dropped before columns change)
  const toIxByOrig = new Map<string, IndexDef>();
  for (const ix of to.indexes) if (ix.origName && !toIxByOrig.has(ix.origName)) toIxByOrig.set(ix.origName, ix);
  const addIndexes: IndexDef[] = [];
  const keptIndexes = new Set<IndexDef>();
  const canRenameIndex = !maria || versionAtLeast(opts, 100502);
  for (const ix of from.indexes) {
    const ni = toIxByOrig.get(ix.name);
    if (!ni) {
      if (!opts.keepDropped) specs.push(`DROP INDEX ${quoteId(ix.name)}`);
      continue;
    }
    keptIndexes.add(ni);
    const asRenamed: IndexDef = { ...ix, fields: ix.fields.map((p) => (p.name ? { ...p, name: mapCol(p.name) } : p)) };
    const renamed = ni.name !== ix.name;
    const visibilityChanged = ni.invisible !== ix.invisible;
    const redefine =
      indexSignature(ni) !== indexSignature(asRenamed) ||
      touchesRecreated(ni.fields.map((p) => p.name)) ||
      ni.fields.some((p) => !!p.expr && !p.name && exprTouchesRecreated(p.expr)) ||
      !ni.name ||
      (renamed && (!canRenameIndex || visibilityChanged));
    if (redefine) {
      specs.push(`DROP INDEX ${quoteId(ix.name)}`);
      addIndexes.push(ni);
    } else {
      if (renamed) specs.push(`RENAME INDEX ${quoteId(ix.name)} TO ${quoteId(ni.name)}`);
      if (visibilityChanged) {
        specs.push(`ALTER INDEX ${quoteId(ni.name)} ${ni.invisible ? (maria ? 'IGNORED' : 'INVISIBLE') : maria ? 'NOT IGNORED' : 'VISIBLE'}`);
      }
    }
  }
  for (const ix of to.indexes) if (!keptIndexes.has(ix)) addIndexes.push(ix);

  // ── primary key
  const fromPk = from.primaryKey.map((n) => (toByOrig.has(n) ? toByOrig.get(n)!.name : fromByName.has(n) ? ` ${n}` : n));
  const pkChanged = !sameList(fromPk, to.primaryKey) || to.primaryKey.some((n) => recreated.has(n));
  if (pkChanged && from.primaryKey.length) specs.push('DROP PRIMARY KEY');

  // ── columns
  for (const f of from.fields) {
    const nf = toByOrig.get(f.name);
    if (!nf) {
      if (!opts.keepDropped) specs.push(`DROP COLUMN ${quoteId(f.name)}`);
    } else if (recreated.has(nf.name)) specs.push(`DROP COLUMN ${quoteId(f.name)}`);
  }

  // simulate the column order after drops and renames
  const current: string[] = from.fields
    .filter((f) => {
      const nf = toByOrig.get(f.name);
      return nf ? !recreated.has(nf.name) : !!opts.keepDropped;
    })
    .map((f) => toByOrig.get(f.name)?.name ?? f.name);
  for (let i = 0; i < to.fields.length; i++) {
    const f = to.fields[i];
    const prev = i === 0 ? null : to.fields[i - 1].name;
    const pos = prev === null ? ' FIRST' : ` AFTER ${quoteId(prev)}`;
    const existing = f.origName && toByOrig.get(f.origName) === f && !recreated.has(f.name) ? fromByName.get(f.origName) : undefined;
    if (!existing) {
      specs.push(`ADD COLUMN ${columnDefinition(f, opts)}${pos}`);
      const at = prev === null ? 0 : current.indexOf(prev) + 1;
      current.splice(at, 0, f.name);
      continue;
    }
    const idx = current.indexOf(f.name);
    const actualPrev = idx <= 0 ? null : current[idx - 1];
    const moved = actualPrev !== prev;
    const renamed = existing.name !== f.name;
    const changed = columnBody(sameDefaultForm(existing), opts) !== columnBody(sameDefaultForm(f), opts);
    if (moved) {
      current.splice(idx, 1);
      const at = prev === null ? 0 : current.indexOf(prev) + 1;
      current.splice(at, 0, f.name);
    }
    if (renamed) specs.push(`CHANGE COLUMN ${quoteId(existing.name)} ${columnDefinition(f, opts)}${moved ? pos : ''}`);
    else if (changed || moved) specs.push(`MODIFY COLUMN ${columnDefinition(f, opts)}${moved ? pos : ''}`);
  }

  if (pkChanged && to.primaryKey.length) specs.push(`ADD PRIMARY KEY (${to.primaryKey.map(quoteId).join(', ')})`);
  for (const ix of addIndexes) specs.push(`ADD ${indexDefinition(ix, opts)}`);
  for (const c of addChecks) specs.push(`ADD ${checkDefinition(c, opts)}`);

  // ── table options
  for (const k of OPTION_ORDER) {
    if (k === 'charset' || k === 'collation') continue;
    if (k === 'autoIncrement' && !to.options.autoIncrement) continue;
    if (String(from.options[k] ?? '') === String(to.options[k] ?? '')) continue;
    const c = optionClause(k, to.options) ?? resetClause(k);
    if (c) specs.push(c);
  }
  if (from.options.charset !== to.options.charset || from.options.collation !== to.options.collation) {
    if (to.options.charset || to.options.collation) {
      specs.push(
        `${to.options.charset ? `CHARACTER SET = ${to.options.charset}` : ''}${to.options.charset && to.options.collation ? ' ' : ''}${to.options.collation ? `COLLATE = ${to.options.collation}` : ''}`
      );
    }
  }
  if ((from.comment ?? '') !== (to.comment ?? '')) specs.push(`COMMENT = ${quoteString(to.comment ?? '')}`);
  if (newTableName !== from.name) specs.push(`RENAME TO ${tableRef}`);

  if (specs.length) steps.push({ kind: 'alterTable', sql: `ALTER TABLE ${oldName}\n  ${specs.join(',\n  ')}`, names: [newTableName] });

  // ── partitioning
  const fromPart = (from.partition ?? '').trim();
  const toPart = (to.partition ?? '').trim();
  if (normalizeWs(fromPart) !== normalizeWs(toPart)) {
    steps.push({
      kind: 'partition',
      sql: toPart ? `ALTER TABLE ${tableRef}\n${toPart}` : `ALTER TABLE ${tableRef} REMOVE PARTITIONING`,
      names: []
    });
  }

  // ── new / changed foreign keys
  if (addFks.length) {
    steps.push({
      kind: 'addForeignKeys',
      sql: `ALTER TABLE ${tableRef}\n  ${addFks.map((fk) => `ADD ${fkDefinition(fk, schema)}`).join(',\n  ')}`,
      names: addFks.map((f) => f.name)
    });
  }

  // ── new / changed triggers
  const create = to.triggers.filter((t) => !keptTriggers.has(t));
  for (const t of orderTriggers(create)) steps.push({ kind: 'createTrigger', sql: triggerSql(t, schema, newTableName, opts), names: [t.name] });
  return steps;
}

/**
 * Statements that transform table `from` into `to`.
 * Existing objects in `to` are matched through `origName`; objects without origName are new.
 */
export function alterTableSql(from: TableDesign, to: TableDesign, opts: AlterOptions = {}): string[] {
  return alterTableSteps(from, to, opts).map((s) => s.sql);
}

/** Prepare a design loaded from another source for diffing: every object gets origName = name. */
export function asExisting(d: TableDesign): TableDesign {
  return {
    ...d,
    origName: d.name,
    fields: d.fields.map((f) => ({ ...f, origName: f.name })),
    indexes: d.indexes.map((i) => ({ ...i, origName: i.name })),
    foreignKeys: d.foreignKeys.map((f) => ({ ...f, origName: f.name })),
    checks: d.checks.map((c) => ({ ...c, origName: c.name })),
    triggers: d.triggers.map((t) => ({ ...t, origName: t.name }))
  };
}

/**
 * Structure sync helper: statements that make `target` look like `source`
 * (both loaded from databases; objects are matched by name, case-insensitively for columns).
 */
export function syncTableSql(source: TableDesign, target: TableDesign, opts: AlterOptions = {}): string[] {
  const tgt = asExisting(target);
  const byLower = new Map(tgt.fields.map((f) => [f.name.toLowerCase(), f.name]));
  const want: TableDesign = {
    ...source,
    schema: target.schema,
    name: target.name,
    origName: target.name,
    fields: source.fields.map((f) => ({ ...f, origName: byLower.get(f.name.toLowerCase()) })),
    indexes: source.indexes.map((i) => ({ ...i, origName: tgt.indexes.some((x) => x.name === i.name) ? i.name : undefined })),
    foreignKeys: source.foreignKeys.map((f) => ({
      ...f,
      refSchema: f.refSchema === source.schema ? target.schema : f.refSchema,
      origName: tgt.foreignKeys.some((x) => x.name === f.name) ? f.name : undefined
    })),
    checks: source.checks.map((c) => ({ ...c, origName: tgt.checks.some((x) => x.name === c.name) ? c.name : undefined })),
    triggers: source.triggers.map((t) => ({ ...t, origName: tgt.triggers.some((x) => x.name === t.name) ? t.name : undefined })),
    options: { ...source.options, autoIncrement: '' }
  };
  const tgtNoAi: TableDesign = { ...tgt, options: { ...tgt.options, autoIncrement: '' } };
  return alterTableSql(tgtNoAi, want, opts);
}

// ───────────────────────── Tokenizer for clause parsing ─────────────────────────

interface Tok {
  t: 'word' | 'str' | 'id' | 'group' | 'punct';
  /** word text, unescaped string / identifier, raw text inside a parenthesis group, punctuation character */
  v: string;
  start: number;
  end: number;
}

/** Index of the parenthesis closing the one at `open` (quote aware), -1 if unbalanced */
function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < s.length) {
        if (s[i] === '\\' && c !== '`') {
          i += 2;
          continue;
        }
        if (s[i] === c) {
          if (s[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tokenize(s: string): Tok[] | null {
  const out: Tok[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n) {
        const d = s[j];
        if (d === '\\' && j + 1 < n) {
          const e = s[j + 1];
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '\0' : e;
          j += 2;
          continue;
        }
        if (d === c) {
          if (s[j + 1] === c) {
            v += c;
            j += 2;
            continue;
          }
          break;
        }
        v += d;
        j++;
      }
      if (j >= n) return null;
      out.push({ t: 'str', v, start: i, end: j + 1 });
      i = j + 1;
    } else if (c === '`') {
      let j = i + 1;
      let v = '';
      while (j < n) {
        if (s[j] === '`') {
          if (s[j + 1] === '`') {
            v += '`';
            j += 2;
            continue;
          }
          break;
        }
        v += s[j];
        j++;
      }
      if (j >= n) return null;
      out.push({ t: 'id', v, start: i, end: j + 1 });
      i = j + 1;
    } else if (c === '(') {
      const e = closingParen(s, i);
      if (e < 0) return null;
      out.push({ t: 'group', v: s.slice(i + 1, e), start: i, end: e + 1 });
      i = e + 1;
    } else if (/[A-Za-z0-9_$.\u0080-\uffff+-]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$.\u0080-\uffff]/.test(s[j])) j++;
      out.push({ t: 'word', v: s.slice(i, j), start: i, end: j });
      i = j;
    } else {
      out.push({ t: 'punct', v: c, start: i, end: i + 1 });
      i++;
    }
  }
  return out;
}

/** Splits `text` at top level separators (outside quotes and parentheses) */
export function splitTopLevel(text: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < text.length) {
        if (text[i] === '\\' && c !== '`') {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const last = text.slice(start);
  if (last.trim() || out.length) out.push(last);
  return out.map((s) => s.trim());
}

// ───────────────────────── Partitioning ─────────────────────────

export type PartitionMethod = 'RANGE' | 'LIST' | 'HASH' | 'KEY';

export interface SubPartitionDef {
  name: string;
  engine: string;
  comment: string;
  dataDirectory: string;
  indexDirectory: string;
  maxRows: string;
  minRows: string;
  tablespace: string;
}

export interface PartitionItemDef extends SubPartitionDef {
  /** RANGE: value list or MAXVALUE (without parentheses); LIST: value list */
  values: string;
  subpartitions: SubPartitionDef[];
}

export interface PartitionDef {
  method: PartitionMethod;
  /** LINEAR HASH / LINEAR KEY */
  linear: boolean;
  /** RANGE COLUMNS / LIST COLUMNS */
  columns: boolean;
  /** Expression (RANGE / LIST / HASH) or column list (KEY, … COLUMNS) */
  expr: string;
  /** KEY ALGORITHM = 1 | 2 ('' = default) */
  keyAlgorithm: string;
  /** PARTITIONS n ('' = from the definitions) */
  count: string;
  subMethod: '' | 'HASH' | 'KEY';
  subLinear: boolean;
  subExpr: string;
  subKeyAlgorithm: string;
  /** SUBPARTITIONS n */
  subCount: string;
  partitions: PartitionItemDef[];
}

export function newPartitionDef(): PartitionDef {
  return {
    method: 'RANGE',
    linear: false,
    columns: false,
    expr: '',
    keyAlgorithm: '',
    count: '',
    subMethod: '',
    subLinear: false,
    subExpr: '',
    subKeyAlgorithm: '',
    subCount: '',
    partitions: []
  };
}

export function newSubPartition(name = ''): SubPartitionDef {
  return { name, engine: '', comment: '', dataDirectory: '', indexDirectory: '', maxRows: '', minRows: '', tablespace: '' };
}

export function newPartitionItem(name = ''): PartitionItemDef {
  return { ...newSubPartition(name), values: '', subpartitions: [] };
}

function partitionOptionsSql(p: SubPartitionDef): string {
  const o: string[] = [];
  if (p.engine) o.push(`ENGINE = ${p.engine}`);
  if (p.comment) o.push(`COMMENT = ${quoteString(p.comment)}`);
  if (p.dataDirectory) o.push(`DATA DIRECTORY = ${quoteString(p.dataDirectory)}`);
  if (p.indexDirectory) o.push(`INDEX DIRECTORY = ${quoteString(p.indexDirectory)}`);
  if (p.maxRows) o.push(`MAX_ROWS = ${p.maxRows}`);
  if (p.minRows) o.push(`MIN_ROWS = ${p.minRows}`);
  if (p.tablespace) o.push(`TABLESPACE = ${quoteId(p.tablespace)}`);
  return o.length ? ` ${o.join(' ')}` : '';
}

function methodSql(method: string, linear: boolean, columns: boolean, algorithm: string, expr: string): string {
  const lin = linear && (method === 'HASH' || method === 'KEY') ? 'LINEAR ' : '';
  const alg = method === 'KEY' && algorithm ? ` ALGORITHM = ${algorithm}` : '';
  const cols = columns && (method === 'RANGE' || method === 'LIST') ? ' COLUMNS' : '';
  return `${lin}${method}${alg}${cols} (${expr.trim()})`;
}

/** PARTITION BY … clause for a partition definition */
export function partitionClauseSql(p: PartitionDef): string {
  let s = `PARTITION BY ${methodSql(p.method, p.linear, p.columns, p.keyAlgorithm, p.expr)}`;
  const hashLike = p.method === 'HASH' || p.method === 'KEY';
  if (hashLike && p.count && !p.partitions.length) s += `\nPARTITIONS ${p.count}`;
  if (p.subMethod) {
    s += `\nSUBPARTITION BY ${methodSql(p.subMethod, p.subLinear, false, p.subKeyAlgorithm, p.subExpr)}`;
    if (p.subCount && !p.partitions.some((x) => x.subpartitions.length)) s += `\nSUBPARTITIONS ${p.subCount}`;
  }
  if (p.partitions.length) {
    const defs = p.partitions.map((x) => {
      let d = `PARTITION ${quoteId(x.name)}`;
      const v = x.values.trim();
      if (p.method === 'RANGE') d += !p.columns && /^maxvalue$/i.test(v) ? ' VALUES LESS THAN MAXVALUE' : ` VALUES LESS THAN (${v})`;
      else if (p.method === 'LIST') d += ` VALUES IN (${v})`;
      d += partitionOptionsSql(x);
      if (p.subMethod && x.subpartitions.length) {
        d += `\n  (${x.subpartitions.map((sp) => `SUBPARTITION ${quoteId(sp.name)}${partitionOptionsSql(sp)}`).join(',\n   ')})`;
      }
      return d;
    });
    s += `\n(${defs.join(',\n ')})`;
  }
  return s;
}

function parsePartitionDefs(text: string, sub: boolean): PartitionItemDef[] | null {
  const toks = tokenize(text);
  if (!toks) return null;
  const out: PartitionItemDef[] = [];
  let i = 0;
  const kw = (w: string) => toks[i]?.t === 'word' && toks[i].v.toUpperCase() === w;
  const eat = (w: string) => (kw(w) ? (i++, true) : false);
  const eatEq = () => {
    if (toks[i]?.t === 'punct' && toks[i].v === '=') i++;
  };
  const value = (): string | null => {
    const t = toks[i];
    if (!t || (t.t !== 'word' && t.t !== 'str' && t.t !== 'id')) return null;
    i++;
    return t.v;
  };
  while (i < toks.length) {
    if (!eat(sub ? 'SUBPARTITION' : 'PARTITION')) return null;
    const nameTok = toks[i];
    if (!nameTok || (nameTok.t !== 'word' && nameTok.t !== 'id')) return null;
    i++;
    const item = newPartitionItem(nameTok.v);
    if (!sub && eat('VALUES')) {
      if (eat('LESS')) {
        if (!eat('THAN')) return null;
        if (toks[i]?.t === 'group') item.values = toks[i++].v.trim();
        else if (eat('MAXVALUE')) item.values = 'MAXVALUE';
        else return null;
      } else if (eat('IN')) {
        if (toks[i]?.t !== 'group') return null;
        item.values = toks[i++].v.trim();
      } else return null;
    }
    for (;;) {
      if (eat('STORAGE')) {
        if (!kw('ENGINE')) return null;
      }
      let v: string | null;
      if (eat('ENGINE')) {
        eatEq();
        if ((v = value()) === null) return null;
        item.engine = v;
      } else if (eat('COMMENT')) {
        eatEq();
        if ((v = value()) === null) return null;
        item.comment = v;
      } else if (eat('DATA')) {
        if (!eat('DIRECTORY')) return null;
        eatEq();
        if ((v = value()) === null) return null;
        item.dataDirectory = v;
      } else if (eat('INDEX')) {
        if (!eat('DIRECTORY')) return null;
        eatEq();
        if ((v = value()) === null) return null;
        item.indexDirectory = v;
      } else if (eat('MAX_ROWS')) {
        eatEq();
        if ((v = value()) === null) return null;
        item.maxRows = v;
      } else if (eat('MIN_ROWS')) {
        eatEq();
        if ((v = value()) === null) return null;
        item.minRows = v;
      } else if (eat('TABLESPACE')) {
        eatEq();
        if ((v = value()) === null) return null;
        item.tablespace = v;
      } else break;
    }
    if (!sub && toks[i]?.t === 'group') {
      const subs = parsePartitionDefs(toks[i++].v, true);
      if (!subs) return null;
      item.subpartitions = subs.map(({ values: _v, subpartitions: _s, ...rest }) => rest);
    }
    out.push(item);
    if (i >= toks.length) break;
    if (toks[i].t !== 'punct' || toks[i].v !== ',') return null;
    i++;
  }
  return out;
}

/**
 * Parses a PARTITION BY clause (as written by SHOW CREATE TABLE or partitionClauseSql).
 * Returns null for clauses the structured editor cannot represent (they stay editable as text).
 */
export function parsePartitionClause(sql: string): PartitionDef | null {
  const text = sql
    .trim()
    .replace(/^\/\*!\d*\s*/, '')
    .replace(/\s*\*\/\s*$/, '');
  if (!text) return null;
  const toks = tokenize(text);
  if (!toks) return null;
  let i = 0;
  const kw = (w: string) => toks[i]?.t === 'word' && toks[i].v.toUpperCase() === w;
  const eat = (w: string) => (kw(w) ? (i++, true) : false);
  if (!eat('PARTITION') || !eat('BY')) return null;
  const p = newPartitionDef();
  const parseMethod = (sub: boolean): boolean => {
    const linear = eat('LINEAR');
    let method: PartitionMethod;
    if (eat('HASH')) method = 'HASH';
    else if (eat('KEY')) method = 'KEY';
    else if (!sub && !linear && eat('RANGE')) method = 'RANGE';
    else if (!sub && !linear && eat('LIST')) method = 'LIST';
    else return false;
    let algorithm = '';
    if (method === 'KEY' && eat('ALGORITHM')) {
      if (toks[i]?.t === 'punct' && toks[i].v === '=') i++;
      if (toks[i]?.t !== 'word') return false;
      algorithm = toks[i++].v;
    }
    const columns = (method === 'RANGE' || method === 'LIST') && eat('COLUMNS');
    if (toks[i]?.t !== 'group') return false;
    const expr = toks[i++].v.trim();
    if (sub) {
      p.subMethod = method as 'HASH' | 'KEY';
      p.subLinear = linear;
      p.subExpr = expr;
      p.subKeyAlgorithm = algorithm;
    } else {
      p.method = method;
      p.linear = linear;
      p.columns = columns;
      p.expr = expr;
      p.keyAlgorithm = algorithm;
    }
    return true;
  };
  if (!parseMethod(false)) return null;
  if (eat('PARTITIONS')) {
    if (toks[i]?.t !== 'word' || !/^\d+$/.test(toks[i].v)) return null;
    p.count = toks[i++].v;
  }
  if (eat('SUBPARTITION')) {
    if (!eat('BY') || !parseMethod(true)) return null;
    if (eat('SUBPARTITIONS')) {
      if (toks[i]?.t !== 'word' || !/^\d+$/.test(toks[i].v)) return null;
      p.subCount = toks[i++].v;
    }
  }
  if (toks[i]?.t === 'group') {
    const defs = parsePartitionDefs(toks[i++].v, false);
    if (!defs) return null;
    p.partitions = defs;
    if (p.subMethod && !p.subCount) {
      const n = defs[0]?.subpartitions.length ?? 0;
      if (n && defs.every((d) => d.subpartitions.length === n)) p.subCount = String(n);
    }
  }
  if (i < toks.length) return null;
  return p;
}

// ───────────────────────── Views ─────────────────────────

export interface ViewDef {
  schema: string;
  name: string;
  /** The SELECT statement */
  definition: string;
  algorithm: '' | 'UNDEFINED' | 'MERGE' | 'TEMPTABLE';
  /** user@host, '' = current user */
  definer: string;
  security: '' | 'DEFINER' | 'INVOKER';
  checkOption: '' | 'CASCADED' | 'LOCAL';
  /** Optional explicit column names */
  columns: string[];
}

/** SELECT text without trailing semicolons / whitespace */
export function stripStatementEnd(sql: string): string {
  let s = sql.trim();
  while (s.endsWith(';')) s = s.slice(0, -1).trimEnd();
  return s;
}

/** CREATE [OR REPLACE] VIEW statement */
export function createViewSql(v: ViewDef, opts: { orReplace?: boolean } = {}): string {
  const head: string[] = ['CREATE'];
  if (opts.orReplace) head.push('OR REPLACE');
  if (v.algorithm) head.push(`ALGORITHM = ${v.algorithm}`);
  if (v.definer.trim()) head.push(`DEFINER = ${formatDefiner(v.definer)}`);
  if (v.security) head.push(`SQL SECURITY ${v.security}`);
  const cols = v.columns.filter((c) => c.trim()).length ? ` (${v.columns.map((c) => quoteId(c.trim())).join(', ')})` : '';
  let sql = `${head.join(' ')} VIEW ${qname(v.schema, v.name)}${cols} AS\n${stripStatementEnd(v.definition)}`;
  if (v.checkOption) sql += `\nWITH ${v.checkOption} CHECK OPTION`;
  return sql;
}

const IDENT_RE = '(?:`(?:[^`]|``)+`|[\\w$\\u0080-\\uffff]+)';
const QUOTED_PART_RE = "(?:`(?:[^`]|``)*`|'(?:[^'\\\\]|\\\\.|'')*'|[^\\s@`']+)";

/** Parses SHOW CREATE VIEW output */
export function parseCreateView(sql: string): Omit<ViewDef, 'schema'> | null {
  const re = new RegExp(
    `^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:ALGORITHM\\s*=\\s*(\\w+)\\s+)?(?:DEFINER\\s*=\\s*(${QUOTED_PART_RE}@${QUOTED_PART_RE})\\s+)?(?:SQL\\s+SECURITY\\s+(\\w+)\\s+)?VIEW\\s+(${IDENT_RE}(?:\\s*\\.\\s*${IDENT_RE})?)\\s*`,
    'i'
  );
  const m = re.exec(sql);
  if (!m) return null;
  let rest = sql.slice(m[0].length);
  let columns: string[] = [];
  if (rest.startsWith('(')) {
    const e = closingParen(rest, 0);
    if (e < 0) return null;
    columns = splitTopLevel(rest.slice(1, e)).map(unquoteIdent);
    rest = rest.slice(e + 1).trimStart();
  }
  const as = /^AS\s/i.exec(rest);
  if (!as) return null;
  let definition = rest.slice(as[0].length).trim();
  let checkOption: ViewDef['checkOption'] = '';
  const co = /\s+WITH\s+(?:(CASCADED|LOCAL)\s+)?CHECK\s+OPTION\s*$/i.exec(definition);
  if (co) {
    checkOption = (co[1]?.toUpperCase() as ViewDef['checkOption']) || 'CASCADED';
    definition = definition.slice(0, co.index).trimEnd();
  }
  const nameParts = m[4].match(new RegExp(IDENT_RE, 'g')) ?? [];
  const alg = (m[1] ?? '').toUpperCase();
  const sec = (m[3] ?? '').toUpperCase();
  return {
    name: unquoteIdent(nameParts[nameParts.length - 1] ?? ''),
    definition,
    algorithm: (['UNDEFINED', 'MERGE', 'TEMPTABLE'].includes(alg) ? alg : '') as ViewDef['algorithm'],
    definer: m[2] ? plainDefiner(m[2]) : '',
    security: (['DEFINER', 'INVOKER'].includes(sec) ? sec : '') as ViewDef['security'],
    checkOption,
    columns
  };
}

// ───────────────────────── Stored routines ─────────────────────────

export interface RoutineParam {
  /** '' for function parameters */
  mode: '' | 'IN' | 'OUT' | 'INOUT';
  name: string;
  /** Data type as written, e.g. VARCHAR(50) CHARSET latin1 */
  type: string;
}

export type RoutineDataAccess = '' | 'CONTAINS SQL' | 'NO SQL' | 'READS SQL DATA' | 'MODIFIES SQL DATA';

export interface RoutineDef {
  schema: string;
  name: string;
  type: 'FUNCTION' | 'PROCEDURE';
  params: RoutineParam[];
  /** RETURNS data type (functions) */
  returns: string;
  /** Routine body: one statement or BEGIN … END */
  body: string;
  /** user@host, '' = current user */
  definer: string;
  security: '' | 'DEFINER' | 'INVOKER';
  dataAccess: RoutineDataAccess;
  deterministic: boolean;
  comment: string;
}

export function routineParamSql(p: RoutineParam, routineType: RoutineDef['type']): string {
  const mode = routineType === 'PROCEDURE' && p.mode ? `${p.mode} ` : '';
  return `${mode}${quoteId(p.name)} ${p.type.trim()}`;
}

/** CREATE FUNCTION / PROCEDURE statement */
export function createRoutineSql(r: RoutineDef): string {
  const definer = r.definer.trim() ? ` DEFINER = ${formatDefiner(r.definer)}` : '';
  let sql = `CREATE${definer} ${r.type} ${qname(r.schema, r.name)}(${r.params.map((p) => routineParamSql(p, r.type)).join(', ')})`;
  if (r.type === 'FUNCTION') sql += ` RETURNS ${r.returns.trim()}`;
  const ch: string[] = [];
  if (r.comment) ch.push(`COMMENT ${quoteString(r.comment)}`);
  if (r.deterministic) ch.push('DETERMINISTIC');
  if (r.dataAccess) ch.push(r.dataAccess);
  if (r.security) ch.push(`SQL SECURITY ${r.security}`);
  for (const c of ch) sql += `\n    ${c}`;
  return `${sql}\n${r.body.trim()}`;
}

export function dropRoutineSql(type: RoutineDef['type'], schema: string, name: string, ifExists = true): string {
  return `DROP ${type} ${ifExists ? 'IF EXISTS ' : ''}${qname(schema, name)}`;
}

/** Parses a parameter list ("IN a INT, OUT `b c` VARCHAR(10)") */
export function parseRoutineParams(text: string, routineType: RoutineDef['type']): RoutineParam[] | null {
  const out: RoutineParam[] = [];
  for (const part of splitTopLevel(text)) {
    if (!part) continue;
    const m = new RegExp(`^(?:(IN|OUT|INOUT)\\s+)?(${IDENT_RE})\\s+([\\s\\S]+)$`, 'i').exec(part);
    if (!m) return null;
    out.push({
      mode: routineType === 'PROCEDURE' ? ((m[1]?.toUpperCase() as RoutineParam['mode']) || 'IN') : '',
      name: unquoteIdent(m[2]),
      type: m[3].trim()
    });
  }
  return out;
}

const CHARACTERISTIC_START = new Set(['COMMENT', 'LANGUAGE', 'NOT', 'DETERMINISTIC', 'CONTAINS', 'NO', 'READS', 'MODIFIES', 'SQL']);

/**
 * Parameters and return type from SHOW CREATE FUNCTION / PROCEDURE output.
 * `body` (information_schema.ROUTINES.ROUTINE_DEFINITION) is removed from the end first when given.
 */
export function parseRoutineHeader(
  createSql: string,
  routineType: RoutineDef['type'],
  body?: string
): { name: string; params: RoutineParam[]; returns: string } | null {
  let header = createSql.trimEnd();
  if (body && header.endsWith(body.trimEnd())) header = header.slice(0, header.length - body.trimEnd().length);
  const m = new RegExp(`\\b${routineType}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT_RE}(?:\\s*\\.\\s*${IDENT_RE})?)\\s*\\(`, 'i').exec(header);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = closingParen(header, open);
  if (close < 0) return null;
  const params = parseRoutineParams(header.slice(open + 1, close), routineType);
  if (!params) return null;
  const nameParts = m[1].match(new RegExp(IDENT_RE, 'g')) ?? [];
  let returns = '';
  if (routineType === 'FUNCTION') {
    const tail = header.slice(close + 1);
    const r = /^\s*RETURNS\s+/i.exec(tail);
    if (!r) return null;
    const typeText = tail.slice(r[0].length);
    const toks = tokenize(typeText);
    if (!toks) return null;
    let end = typeText.length;
    if (body === undefined) {
      // without the body the return type ends at the first characteristic or at the line end
      const nl = typeText.search(/\r?\n/);
      if (nl >= 0) end = nl;
    }
    for (const t of toks) {
      if (t.start >= end) break;
      if (t.t === 'word' && CHARACTERISTIC_START.has(t.v.toUpperCase())) {
        end = t.start;
        break;
      }
    }
    returns = typeText.slice(0, end).trim();
  }
  return { name: unquoteIdent(nameParts[nameParts.length - 1] ?? ''), params, returns };
}

// ───────────────────────── Events ─────────────────────────

export type IntervalUnit =
  | 'YEAR'
  | 'QUARTER'
  | 'MONTH'
  | 'WEEK'
  | 'DAY'
  | 'HOUR'
  | 'MINUTE'
  | 'SECOND'
  | 'YEAR_MONTH'
  | 'DAY_HOUR'
  | 'DAY_MINUTE'
  | 'DAY_SECOND'
  | 'HOUR_MINUTE'
  | 'HOUR_SECOND'
  | 'MINUTE_SECOND';

export const INTERVAL_UNITS: IntervalUnit[] = [
  'YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
  'YEAR_MONTH', 'DAY_HOUR', 'DAY_MINUTE', 'DAY_SECOND', 'HOUR_MINUTE', 'HOUR_SECOND', 'MINUTE_SECOND'
];

export interface IntervalDef {
  value: string;
  unit: IntervalUnit;
}

export type EventStatusKind = 'ENABLE' | 'DISABLE' | 'DISABLE ON SLAVE';

export interface EventDef {
  schema: string;
  name: string;
  scheduleType: 'AT' | 'EVERY';
  /** AT timestamp: literal 'YYYY-MM-DD HH:MM:SS' or CURRENT_TIMESTAMP */
  at: string;
  atIntervals: IntervalDef[];
  every: IntervalDef;
  /** STARTS / ENDS timestamps ('' = none) */
  starts: string;
  startsIntervals: IntervalDef[];
  ends: string;
  endsIntervals: IntervalDef[];
  status: EventStatusKind;
  /** ON COMPLETION PRESERVE */
  preserve: boolean;
  /** user@host, '' = current user */
  definer: string;
  comment: string;
  body: string;
}

/** Interval value: numbers stay unquoted for simple units, compound units ('1:30' HOUR_MINUTE) are quoted */
export function intervalValueSql(value: string, unit: IntervalUnit): string {
  const v = value.trim();
  if (!unit.includes('_') && /^-?\d+$/.test(v)) return v;
  return quoteString(v);
}

const NOW_RE = /^(current_timestamp|now|localtime|localtimestamp|utc_timestamp|sysdate)(\s*\(\s*\d*\s*\))?$/i;

/** Timestamp operand: CURRENT_TIMESTAMP & co. stay as they are, everything else becomes a string literal */
export function timestampSql(ts: string): string {
  const v = ts.trim();
  if (NOW_RE.test(v)) return v.toUpperCase();
  return quoteString(v);
}

function withIntervals(ts: string, list: IntervalDef[]): string {
  return timestampSql(ts) + list.filter((x) => x.value.trim()).map((x) => ` + INTERVAL ${intervalValueSql(x.value, x.unit)} ${x.unit}`).join('');
}

/** ON SCHEDULE part without the keywords: AT … / EVERY … [STARTS …] [ENDS …] */
export function eventScheduleSql(e: EventDef): string {
  if (e.scheduleType === 'AT') return `AT ${withIntervals(e.at, e.atIntervals)}`;
  let s = `EVERY ${intervalValueSql(e.every.value, e.every.unit)} ${e.every.unit}`;
  if (e.starts.trim()) s += ` STARTS ${withIntervals(e.starts, e.startsIntervals)}`;
  if (e.ends.trim()) s += ` ENDS ${withIntervals(e.ends, e.endsIntervals)}`;
  return s;
}

export function eventStatusSql(status: EventStatusKind, opts: DdlOptions = {}): string {
  if (status !== 'DISABLE ON SLAVE') return status;
  return !isMaria(opts) && versionAtLeast(opts, 80022) ? 'DISABLE ON REPLICA' : 'DISABLE ON SLAVE';
}

/** CREATE EVENT statement */
export function createEventSql(e: EventDef, opts: DdlOptions = {}): string {
  const definer = e.definer.trim() ? ` DEFINER = ${formatDefiner(e.definer)}` : '';
  let sql = `CREATE${definer} EVENT ${qname(e.schema, e.name)}\nON SCHEDULE ${eventScheduleSql(e)}\nON COMPLETION ${e.preserve ? '' : 'NOT '}PRESERVE\n${eventStatusSql(e.status, opts)}`;
  if (e.comment) sql += `\nCOMMENT ${quoteString(e.comment)}`;
  return `${sql}\nDO ${e.body.trim()}`;
}

/** ALTER EVENT with the changed clauses only (null when nothing changed) */
export function alterEventSql(from: EventDef, to: EventDef, opts: DdlOptions = {}): string | null {
  const parts: string[] = [];
  if (eventScheduleSql(from) !== eventScheduleSql(to)) parts.push(`ON SCHEDULE ${eventScheduleSql(to)}`);
  if (from.preserve !== to.preserve) parts.push(`ON COMPLETION ${to.preserve ? '' : 'NOT '}PRESERVE`);
  if (to.name !== from.name) parts.push(`RENAME TO ${qname(to.schema, to.name)}`);
  if (from.status !== to.status) parts.push(eventStatusSql(to.status, opts));
  if (from.comment !== to.comment) parts.push(`COMMENT ${quoteString(to.comment)}`);
  if (from.body.trim() !== to.body.trim()) parts.push(`DO ${to.body.trim()}`);
  const definerChanged = plainDefiner(from.definer) !== plainDefiner(to.definer) && !!to.definer.trim();
  if (!parts.length && !definerChanged) return null;
  if (!parts.length) parts.push(`ON COMPLETION ${to.preserve ? '' : 'NOT '}PRESERVE`);
  const definer = definerChanged ? ` DEFINER = ${formatDefiner(to.definer)}` : '';
  return `ALTER${definer} EVENT ${qname(from.schema, from.name)}\n${parts.join('\n')}`;
}

/** Values of an information_schema.EVENTS row (strings as returned by the server, null for NULL) */
export interface EventInfoRow {
  name: string;
  eventType: string | null;
  executeAt: string | null;
  intervalValue: string | null;
  intervalField: string | null;
  starts: string | null;
  ends: string | null;
  status: string | null;
  onCompletion: string | null;
  definer: string | null;
  comment: string | null;
  body: string | null;
}

/** EventDef from an information_schema.EVENTS row (the server stores schedules with resolved timestamps) */
export function eventDefFromInfo(schema: string, r: EventInfoRow): EventDef {
  const status = (r.status ?? '').toUpperCase();
  const unit = (r.intervalField ?? 'DAY').toUpperCase() as IntervalUnit;
  return {
    schema,
    name: r.name,
    scheduleType: (r.eventType ?? '').toUpperCase() === 'ONE TIME' ? 'AT' : 'EVERY',
    at: r.executeAt ?? '',
    atIntervals: [],
    every: { value: unquoteIdent(r.intervalValue ?? '1'), unit: INTERVAL_UNITS.includes(unit) ? unit : 'DAY' },
    starts: r.starts ?? '',
    startsIntervals: [],
    ends: r.ends ?? '',
    endsIntervals: [],
    status: status === 'ENABLED' ? 'ENABLE' : status === 'DISABLED' ? 'DISABLE' : 'DISABLE ON SLAVE',
    preserve: (r.onCompletion ?? '').toUpperCase() === 'PRESERVE',
    definer: plainDefiner(r.definer ?? ''),
    comment: r.comment ?? '',
    body: r.body ?? ''
  };
}

const ROUTINE_CHARACTERISTICS: RegExp[] = [
  /^\s*COMMENT\s+('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*")/i,
  /^\s*LANGUAGE\s+SQL\b/i,
  /^\s*NOT\s+DETERMINISTIC\b/i,
  /^\s*DETERMINISTIC\b/i,
  /^\s*(CONTAINS\s+SQL|NO\s+SQL|READS\s+SQL\s+DATA|MODIFIES\s+SQL\s+DATA)\b/i,
  /^\s*SQL\s+SECURITY\s+(DEFINER|INVOKER)\b/i
];

/** Complete routine definition from SHOW CREATE FUNCTION / PROCEDURE output (null if it cannot be parsed) */
export function parseCreateRoutine(createSql: string, routineType: RoutineDef['type']): Omit<RoutineDef, 'schema'> | null {
  const text = createSql.trim();
  const d = new RegExp(`^CREATE\\s+(?:DEFINER\\s*=\\s*(${QUOTED_PART_RE}@${QUOTED_PART_RE})\\s+)?`, 'i').exec(text);
  const m = new RegExp(`\\b${routineType}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT_RE}(?:\\s*\\.\\s*${IDENT_RE})?)\\s*\\(`, 'i').exec(text);
  if (!d || !m) return null;
  const open = m.index + m[0].length - 1;
  const close = closingParen(text, open);
  if (close < 0) return null;
  const params = parseRoutineParams(text.slice(open + 1, close), routineType);
  if (!params) return null;
  let pos = close + 1;
  let returns = '';
  if (routineType === 'FUNCTION') {
    const r = /^\s*RETURNS\s+/i.exec(text.slice(pos));
    if (!r) return null;
    const start = pos + r[0].length;
    const nl = text.indexOf('\n', start);
    const lineText = text.slice(start, nl < 0 ? text.length : nl);
    const toks = tokenize(lineText) ?? [];
    let end = lineText.length;
    for (const t of toks) {
      if (t.t === 'word' && CHARACTERISTIC_START.has(t.v.toUpperCase())) {
        end = t.start;
        break;
      }
    }
    returns = lineText.slice(0, end).trim();
    pos = start + end;
  }
  const def: Omit<RoutineDef, 'schema'> = {
    name: unquoteIdent((m[1].match(new RegExp(IDENT_RE, 'g')) ?? []).pop() ?? ''),
    type: routineType,
    params,
    returns,
    body: '',
    definer: d[1] ? plainDefiner(d[1]) : '',
    security: '',
    dataAccess: '',
    deterministic: false,
    comment: ''
  };
  for (let guard = 0; guard < 20; guard++) {
    const rest = text.slice(pos);
    let hit: RegExpExecArray | null = null;
    let which = -1;
    for (let k = 0; k < ROUTINE_CHARACTERISTICS.length && !hit; k++) {
      hit = ROUTINE_CHARACTERISTICS[k].exec(rest);
      which = k;
    }
    if (!hit) break;
    pos += hit[0].length;
    if (which === 0) def.comment = unquoteIdent(hit[1]);
    else if (which === 2) def.deterministic = false;
    else if (which === 3) def.deterministic = true;
    else if (which === 4) def.dataAccess = hit[1].toUpperCase().replace(/\s+/g, ' ') as RoutineDataAccess;
    else if (which === 5) def.security = hit[1].toUpperCase() as RoutineDef['security'];
  }
  def.body = text.slice(pos).trim();
  return def.body ? def : null;
}

/** Argument of a routine call (execute dialog) */
export interface RoutineArg {
  value: string;
  isNull: boolean;
  /** Use the value as SQL expression */
  raw: boolean;
}

/** SQL literal for an argument; numbers stay unquoted for numeric parameter types */
export function routineArgSql(p: RoutineParam, a: RoutineArg | undefined): string {
  if (!a || a.isNull) return 'NULL';
  if (a.raw) return a.value.trim() || 'NULL';
  const base = p.type.trim().split(/[\s(]/)[0].toUpperCase();
  const numeric = NUMERIC.has(base) || base === 'YEAR' || base === 'BOOL' || base === 'BOOLEAN';
  if (numeric && NUMBER_RE.test(a.value.trim())) return a.value.trim();
  return quoteString(a.value);
}

/**
 * Statements that execute a routine: SELECT fn(…) for functions; for procedures SET for INOUT / OUT variables,
 * CALL proc(…) and a final SELECT of the output variables.
 */
export function routineCallScript(r: Pick<RoutineDef, 'schema' | 'name' | 'type' | 'params'>, args: RoutineArg[]): string[] {
  if (r.type === 'FUNCTION') {
    return [`SELECT ${qname(r.schema, r.name)}(${r.params.map((p, i) => routineArgSql(p, args[i])).join(', ')}) AS ${quoteId(r.name)}`];
  }
  const pre: string[] = [];
  const callArgs: string[] = [];
  const outs: string[] = [];
  r.params.forEach((p, i) => {
    const mode = p.mode || 'IN';
    if (mode === 'IN') {
      callArgs.push(routineArgSql(p, args[i]));
      return;
    }
    const v = `@_ks_p${i + 1}`;
    pre.push(`SET ${v} = ${mode === 'INOUT' ? routineArgSql(p, args[i]) : 'NULL'}`);
    callArgs.push(v);
    outs.push(`${v} AS ${quoteId(p.name)}`);
  });
  const out = [...pre, `CALL ${qname(r.schema, r.name)}(${callArgs.join(', ')})`];
  if (outs.length) out.push(`SELECT ${outs.join(', ')}`);
  return out;
}

// ───────────────────────── Details from SHOW CREATE TABLE ─────────────────────────

const SQL_ESCAPES: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' };

/** Content of a single-quoted SQL string literal (without the quotes) → text */
export function unescapeSqlString(inner: string): string {
  return inner.replace(/''|\\(.)/g, (m, c: string | undefined) => (m === "''" ? "'" : (SQL_ESCAPES[c!] ?? c!)));
}

function groupAfter(toks: Tok[], words: string[]): Tok | null {
  outer: for (let i = 0; i + words.length < toks.length; i++) {
    for (let j = 0; j < words.length; j++) {
      const t = toks[i + j];
      if (t.t !== 'word' || t.v.toUpperCase() !== words[j]) continue outer;
    }
    const g = toks[i + words.length];
    if (g.t === 'group') return g;
  }
  return null;
}

/**
 * Completes a design loaded from information_schema with details that are only exact in SHOW CREATE TABLE:
 * generated column expressions, expression defaults (MySQL) and functional key parts (information_schema escapes
 * quotes in them). Also clears the generated flag of columns that only have a DEFAULT_GENERATED default and the
 * prefix length the server reports for SPATIAL indexes.
 */
export function refineDesignFromDdl(d: TableDesign, createSql: string, serverType: 'mysql' | 'mariadb' = 'mysql'): TableDesign {
  const cols = new Map<string, Tok[]>();
  const keys = new Map<string, Tok[]>();
  for (const raw of createSql.split('\n').slice(1)) {
    const line = raw.trim();
    if (line.startsWith(')')) break;
    const toks = tokenize(line.replace(/,$/, ''));
    if (!toks?.length) continue;
    if (toks[0].t === 'id') cols.set(toks[0].v, toks);
    else {
      const k = toks.findIndex((t) => t.t === 'word' && /^(KEY|INDEX)$/i.test(t.v));
      if (k >= 0 && toks[k + 1]?.t === 'id') keys.set(toks[k + 1].v, toks.slice(k + 2));
    }
  }
  const fields = d.fields.map((f) => {
    const toks = cols.get(f.name);
    let generatedExpr = f.generatedExpr;
    let defaultValue = f.defaultValue;
    if (toks && generatedExpr.trim()) {
      const g = groupAfter(toks, ['GENERATED', 'ALWAYS', 'AS']) ?? groupAfter(toks, ['AS']);
      if (g) generatedExpr = g.v.trim();
    }
    let defaultKind = f.defaultKind;
    if (toks && serverType === 'mysql' && f.defaultKind === 'expression') {
      const g = groupAfter(toks, ['DEFAULT']);
      if (g) {
        defaultValue = g.v.trim();
        // literal defaults of TEXT / BLOB / JSON columns are stored as expressions: (_utf8mb4'text')
        const lit = /^(?:_[a-z0-9]+\s*)?'((?:[^'\\]|\\.|'')*)'$/i.exec(defaultValue);
        if (lit) {
          defaultValue = unescapeSqlString(lit[1]);
          defaultKind = defaultValue === '' ? 'empty' : 'value';
        }
      }
    }
    return { ...f, generatedExpr, defaultKind, defaultValue, generated: f.generated && !!generatedExpr.trim() };
  });
  const indexes = d.indexes.map((ix) => {
    let fields = ix.type === 'SPATIAL' ? ix.fields.map((p) => ({ ...p, subPart: '' })) : ix.fields;
    const group = keys.get(ix.name)?.find((t) => t.t === 'group');
    if (group && fields.some((p) => p.expr && !p.name)) {
      const parts = splitTopLevel(group.v);
      if (parts.length === fields.length) {
        fields = fields.map((p, i) => {
          if (!p.expr || p.name || !parts[i].startsWith('(')) return p;
          const e = closingParen(parts[i], 0);
          return e > 0 ? { ...p, expr: parts[i].slice(1, e).trim() } : p;
        });
      }
    }
    return fields === ix.fields ? ix : { ...ix, fields };
  });
  return { ...d, fields, indexes };
}

// Table designer model: data type catalog, references while editing, validation and save helpers.
// Pure functions (no React / DOM access) – the designer components build on them.

import type { FieldDef, ForeignKeyDef, IndexDef, ServerInfo, TableDesign } from '@shared/types';
import { newField, newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { parseEnumValues } from '@shared/sql/quote';
import { renameColumnInExpr, type DdlStep } from '@shared/sql/ddl';
import { uniqueName } from '@shared/util';

// ───────────────────────── Data types ─────────────────────────

export type TypeGroup = 'numeric' | 'datetime' | 'string' | 'binary' | 'spatial' | 'other';

export interface TypeInfo {
  name: string;
  group: TypeGroup;
  /** Length / display width: not used, optional or required */
  length: 'no' | 'opt' | 'req';
  defLength?: string;
  /** Scale column applies */
  decimals?: boolean;
  defDecimals?: string;
  /** Fractional seconds precision (kept in FieldDef.length, edited in the decimals column) */
  fsp?: boolean;
  integer?: boolean;
  numeric?: boolean;
  charset?: boolean;
  /** Types that are only offered for some servers */
  server?: (s: ServerInfo) => boolean;
}

const mysqlFrom = (v: number) => (s: ServerInfo) => s.type === 'mysql' && s.versionNumber >= v;
const mariaFrom = (v: number) => (s: ServerInfo) => s.type === 'mariadb' && s.versionNumber >= v;
const INT = (name: string): TypeInfo => ({ name, group: 'numeric', length: 'opt', integer: true, numeric: true });
const TXT = (name: string): TypeInfo => ({ name, group: 'string', length: 'no', charset: true });
const BLB = (name: string): TypeInfo => ({ name, group: 'binary', length: 'no' });
const GEO = (name: string): TypeInfo => ({ name, group: 'spatial', length: 'no' });

export const DATA_TYPES: TypeInfo[] = [
  INT('TINYINT'),
  INT('SMALLINT'),
  INT('MEDIUMINT'),
  INT('INT'),
  INT('BIGINT'),
  { name: 'DECIMAL', group: 'numeric', length: 'opt', defLength: '10', decimals: true, defDecimals: '2', numeric: true },
  { name: 'FLOAT', group: 'numeric', length: 'opt', decimals: true, numeric: true },
  { name: 'DOUBLE', group: 'numeric', length: 'opt', decimals: true, numeric: true },
  { name: 'BIT', group: 'numeric', length: 'opt', defLength: '1' },
  { name: 'BOOLEAN', group: 'numeric', length: 'no' },
  { name: 'DATE', group: 'datetime', length: 'no' },
  { name: 'TIME', group: 'datetime', length: 'no', fsp: true },
  { name: 'DATETIME', group: 'datetime', length: 'no', fsp: true },
  { name: 'TIMESTAMP', group: 'datetime', length: 'no', fsp: true },
  { name: 'YEAR', group: 'datetime', length: 'no' },
  { name: 'CHAR', group: 'string', length: 'opt', defLength: '10', charset: true },
  { name: 'VARCHAR', group: 'string', length: 'req', defLength: '255', charset: true },
  TXT('TINYTEXT'),
  TXT('TEXT'),
  TXT('MEDIUMTEXT'),
  TXT('LONGTEXT'),
  TXT('ENUM'),
  TXT('SET'),
  { name: 'BINARY', group: 'binary', length: 'opt', defLength: '16' },
  { name: 'VARBINARY', group: 'binary', length: 'req', defLength: '255' },
  BLB('TINYBLOB'),
  BLB('BLOB'),
  BLB('MEDIUMBLOB'),
  BLB('LONGBLOB'),
  GEO('GEOMETRY'),
  GEO('POINT'),
  GEO('LINESTRING'),
  GEO('POLYGON'),
  GEO('MULTIPOINT'),
  GEO('MULTILINESTRING'),
  GEO('MULTIPOLYGON'),
  GEO('GEOMETRYCOLLECTION'),
  { name: 'JSON', group: 'other', length: 'no' },
  { name: 'UUID', group: 'other', length: 'no', server: mariaFrom(100700) },
  { name: 'INET4', group: 'other', length: 'no', server: mariaFrom(101000) },
  { name: 'INET6', group: 'other', length: 'no', server: mariaFrom(100500) },
  { name: 'VECTOR', group: 'other', length: 'opt', defLength: '2048', server: mysqlFrom(90000) }
];

const BY_NAME = new Map(DATA_TYPES.map((t) => [t.name, t]));
const ALIASES: Record<string, string> = {
  INTEGER: 'INT',
  NUMERIC: 'DECIMAL',
  DEC: 'DECIMAL',
  FIXED: 'DECIMAL',
  REAL: 'DOUBLE',
  'DOUBLE PRECISION': 'DOUBLE',
  BOOL: 'BOOLEAN',
  GEOMCOLLECTION: 'GEOMETRYCOLLECTION',
  CHARACTER: 'CHAR'
};

export const TYPE_GROUPS: { id: TypeGroup; label: () => string }[] = [
  { id: 'numeric', label: () => tr('Numerisch', 'Numeric') },
  { id: 'datetime', label: () => tr('Datum und Zeit', 'Date and time') },
  { id: 'string', label: () => tr('Zeichenketten', 'Strings') },
  { id: 'binary', label: () => tr('Binärdaten', 'Binary') },
  { id: 'spatial', label: () => tr('Räumlich', 'Spatial') },
  { id: 'other', label: () => tr('Sonstige', 'Other') }
];

/** Catalog entry of a type (unknown types get a permissive default) */
export function typeInfo(type: string): TypeInfo {
  const t = type.trim().toUpperCase();
  return BY_NAME.get(ALIASES[t] ?? t) ?? { name: t, group: 'other', length: 'opt' };
}

export function knownType(type: string): boolean {
  const t = type.trim().toUpperCase();
  return BY_NAME.has(ALIASES[t] ?? t);
}

/** Types offered for a server (version specific ones only when supported) */
export function typesFor(server?: ServerInfo): TypeInfo[] {
  return DATA_TYPES.filter((t) => !t.server || (server ? t.server(server) : false));
}

export function isTemporalOnUpdate(type: string): boolean {
  const t = type.toUpperCase();
  return t === 'DATETIME' || t === 'TIMESTAMP';
}

/** Types that accept an empty string default */
export function acceptsEmptyString(type: string): boolean {
  const g = typeInfo(type).group;
  return g === 'string' || g === 'binary';
}

const CURRENT_RE = /^current_timestamp(\s*\(\s*\d*\s*\))?$/i;

export function isCurrentTimestampDefault(f: FieldDef): boolean {
  return f.defaultKind === 'expression' && CURRENT_RE.test(f.defaultValue.trim());
}

export function currentTimestampValue(f: FieldDef): string {
  return f.length ? `CURRENT_TIMESTAMP(${f.length})` : 'CURRENT_TIMESTAMP';
}

/** Adjusts the attributes of a field to a new base type (keeps what still applies) */
export function changeType(f: FieldDef, type: string): FieldDef {
  let t = type.trim().toUpperCase();
  t = ALIASES[t] ?? t;
  if (t === 'BOOLEAN') return { ...changeType(f, 'TINYINT'), length: '1', unsigned: false, zerofill: false };
  if (t === f.type.toUpperCase()) return f;
  const info = typeInfo(t);
  const old = typeInfo(f.type);
  const n: FieldDef = { ...f, type: t };
  if (info.fsp) n.length = old.fsp ? f.length : '';
  else if (info.length === 'no') n.length = '';
  else if (!(f.length && old.length !== 'no' && !old.fsp && old.group === info.group)) n.length = info.defLength ?? '';
  n.decimals = info.decimals ? (old.decimals ? f.decimals : (info.defDecimals ?? '')) : '';
  n.values = t === 'ENUM' || t === 'SET' ? f.values : [];
  if (!info.numeric) {
    n.unsigned = false;
    n.zerofill = false;
  }
  if (!info.integer) n.autoIncrement = false;
  if (!info.charset) {
    n.charset = '';
    n.collation = '';
    n.binary = false;
  }
  if (!isTemporalOnUpdate(t)) n.onUpdateCurrentTimestamp = false;
  if (info.group !== 'spatial') n.srid = '';
  if (n.defaultKind === 'empty' && !acceptsEmptyString(t)) n.defaultKind = 'none';
  if (isCurrentTimestampDefault(n) && !isTemporalOnUpdate(t)) {
    n.defaultKind = 'none';
    n.defaultValue = '';
  }
  return normalizeField(n);
}

const TYPE_TEXT_RE = /^\s*([a-z][a-z0-9_]*(?:\s+precision)?)\s*(?:\(([\s\S]*)\))?\s*([a-z\s]*)$/i;

/** Applies a type typed into the grid, e.g. "decimal(10,2) unsigned" or "enum('a','b')" */
export function applyTypeText(f: FieldDef, text: string): FieldDef {
  const m = TYPE_TEXT_RE.exec(text);
  if (!m) return { ...f, type: text.trim().toUpperCase() };
  let n = changeType(f, m[1].replace(/\s+/g, ' '));
  const args = m[2];
  if (args !== undefined) {
    if (n.type === 'ENUM' || n.type === 'SET') n = { ...n, values: parseEnumValues(`enum(${args})`) };
    else {
      const [a = '', b = ''] = args.split(',').map((s) => s.trim());
      const info = typeInfo(n.type);
      n = info.fsp ? { ...n, length: a } : { ...n, length: a, decimals: info.decimals ? b : '' };
    }
  }
  const flags = (m[3] ?? '').toUpperCase();
  if (typeInfo(n.type).numeric) {
    if (/\bUNSIGNED\b/.test(flags)) n = { ...n, unsigned: true };
    if (/\bZEROFILL\b/.test(flags)) n = { ...n, zerofill: true };
  }
  return normalizeField(n);
}

/** Keeps dependent attributes consistent after an edit */
export function normalizeField(f: FieldDef): FieldDef {
  let n = f;
  if (isCurrentTimestampDefault(n) && typeInfo(n.type).fsp && n.defaultValue !== currentTimestampValue(n)) n = { ...n, defaultValue: currentTimestampValue(n) };
  if (n.notNull && n.defaultKind === 'null') n = { ...n, defaultKind: 'none' };
  if (n.zerofill && !n.unsigned) n = { ...n, unsigned: true };
  return n;
}

/** Text shown in the type column (type plus length for display in lists) */
export function typeLabel(f: FieldDef): string {
  const t = f.type.toUpperCase();
  if (t === 'ENUM' || t === 'SET') return `${t}(${f.values.length})`;
  if (f.length && f.decimals) return `${t}(${f.length},${f.decimals})`;
  if (f.length) return `${t}(${f.length})`;
  return t;
}

// ───────────────────────── Server capabilities ─────────────────────────

export interface ServerFeatures {
  checks: boolean;
  checkEnforced: boolean;
  invisibleColumns: boolean;
  invisibleIndexes: boolean;
  functionalIndexes: boolean;
  descIndexes: boolean;
  srid: boolean;
  binaryAttr: boolean;
  triggerOrder: boolean;
}

export function serverFeatures(s?: ServerInfo): ServerFeatures {
  const v = s?.versionNumber ?? 80400;
  if (s?.type === 'mariadb') {
    return {
      checks: v >= 100201,
      checkEnforced: false,
      invisibleColumns: v >= 100303,
      invisibleIndexes: v >= 100600,
      functionalIndexes: false,
      descIndexes: v >= 100800,
      srid: false,
      binaryAttr: true,
      triggerOrder: v >= 100203
    };
  }
  return {
    checks: v >= 80016,
    checkEnforced: v >= 80016,
    invisibleColumns: v >= 80023,
    invisibleIndexes: v >= 80000,
    functionalIndexes: v >= 80013,
    descIndexes: v >= 80000,
    srid: v >= 80000,
    binaryAttr: v < 80017,
    triggerOrder: v >= 50702
  };
}

// ───────────────────────── Editing form of a design ─────────────────────────
//
// While editing, the primary key, index parts and foreign key columns refer to fields by their id, so renaming or
// reordering fields never breaks references. A foreign key to the table itself uses SELF_TABLE as refTable.

export const SELF_TABLE = '\u0000self';

export function toEditDesign(d: TableDesign): TableDesign {
  const byName = new Map<string, string>();
  for (const f of d.fields) if (!byName.has(f.name.toLowerCase())) byName.set(f.name.toLowerCase(), f.id);
  const ref = (n: string) => byName.get(n.toLowerCase()) ?? n;
  const tableName = d.origName ?? d.name;
  return {
    ...d,
    primaryKey: d.primaryKey.map(ref),
    indexes: d.indexes.map((ix) => ({ ...ix, fields: ix.fields.map((p) => (p.name ? { ...p, name: ref(p.name) } : p)) })),
    foreignKeys: d.foreignKeys.map((fk) => {
      const self = !!tableName && fk.refTable === tableName && (fk.refSchema || d.schema) === d.schema;
      return self
        ? { ...fk, fields: fk.fields.map(ref), refTable: SELF_TABLE, refSchema: d.schema, refFields: fk.refFields.map(ref) }
        : { ...fk, fields: fk.fields.map(ref) };
    })
  };
}

export function fromEditDesign(e: TableDesign, nameForSelf?: string): TableDesign {
  const byId = new Map(e.fields.map((f) => [f.id, f.name]));
  const nm = (r: string) => byId.get(r) ?? r;
  return {
    ...e,
    primaryKey: e.primaryKey.map(nm),
    indexes: e.indexes.map((ix) => ({ ...ix, fields: ix.fields.map((p) => (p.name ? { ...p, name: nm(p.name) } : p)) })),
    foreignKeys: e.foreignKeys.map((fk) =>
      fk.refTable === SELF_TABLE
        ? { ...fk, fields: fk.fields.map(nm), refTable: nameForSelf ?? e.name, refSchema: e.schema, refFields: fk.refFields.map(nm) }
        : { ...fk, fields: fk.fields.map(nm) }
    )
  };
}

/** Name of a field referenced by id (or the reference itself when it is not an id) */
export function fieldName(e: TableDesign, ref: string): string {
  return e.fields.find((f) => f.id === ref)?.name ?? ref;
}

/** Comparable form of a design (ids removed) for dirty tracking */
export function designKey(d: TableDesign): string {
  return JSON.stringify(d, (k, v) => (k === 'id' ? undefined : v));
}

/** Removes fields and every reference to them (empty indexes / foreign keys disappear, like on the server) */
export function deleteFields(e: TableDesign, ids: Set<string>): TableDesign {
  const fks: ForeignKeyDef[] = [];
  for (const fk of e.foreignKeys) {
    const keep = fk.fields.map((f, i) => !ids.has(f) && !(fk.refTable === SELF_TABLE && ids.has(fk.refFields[i] ?? '')));
    const fields = fk.fields.filter((_, i) => keep[i]);
    if (fields.length) fks.push({ ...fk, fields, refFields: fk.refFields.filter((_, i) => keep[i] || i >= fk.fields.length) });
  }
  return {
    ...e,
    fields: e.fields.filter((f) => !ids.has(f.id)),
    primaryKey: e.primaryKey.filter((r) => !ids.has(r)),
    indexes: e.indexes.map((ix) => ({ ...ix, fields: ix.fields.filter((p) => !ids.has(p.name)) })).filter((ix) => ix.fields.length > 0),
    foreignKeys: fks
  };
}

/** Follows a committed field rename in expressions (generated columns, checks, functional index parts) */
export function renameFieldInExpressions(e: TableDesign, oldName: string, newName: string): TableDesign {
  if (!oldName || !newName || oldName === newName) return e;
  const re = (x: string) => renameColumnInExpr(x, oldName, newName);
  return {
    ...e,
    fields: e.fields.map((f) => (f.generatedExpr ? { ...f, generatedExpr: re(f.generatedExpr) } : f)),
    checks: e.checks.map((c) => ({ ...c, expr: re(c.expr) })),
    indexes: e.indexes.map((ix) => ({ ...ix, fields: ix.fields.map((p) => (p.expr && !p.name ? { ...p, expr: re(p.expr) } : p)) }))
  };
}

/** Triggers whose body mentions a column name (used to warn after a rename – bodies are not rewritten) */
export function triggersMentioning(e: TableDesign, column: string): string[] {
  const re = new RegExp(`(^|[^\\w$])\`?${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?($|[^\\w$])`, 'i');
  return e.triggers.filter((t) => re.test(t.body)).map((t) => t.name);
}

// ───────────────────────── Names ─────────────────────────

const MAX_NAME = 64;
const clip = (s: string) => (s.length > MAX_NAME ? s.slice(0, MAX_NAME) : s);

const INDEX_PREFIX: Record<IndexDef['type'], string> = { NORMAL: 'idx', UNIQUE: 'uq', FULLTEXT: 'ft', SPATIAL: 'sp' };

/** Gives unnamed indexes, foreign keys and checks a readable name (resolved design, i.e. field names) */
export function fillMissingNames(d: TableDesign): TableDesign {
  const table = d.name || 'table';
  const ixNames = d.indexes.map((i) => i.name).filter(Boolean);
  const indexes = d.indexes.map((ix) => {
    if (ix.name) return ix;
    const cols = ix.fields.map((p) => p.name || 'expr').join('_');
    const name = uniqueName(clip(`${INDEX_PREFIX[ix.type]}_${table}_${cols}`), ixNames);
    ixNames.push(name);
    return { ...ix, name };
  });
  const fkNames = d.foreignKeys.map((f) => f.name).filter(Boolean);
  const foreignKeys = d.foreignKeys.map((fk) => {
    if (fk.name) return fk;
    const name = uniqueName(clip(`fk_${table}_${fk.fields.join('_')}`), fkNames);
    fkNames.push(name);
    return { ...fk, name };
  });
  const ckNames = d.checks.map((c) => c.name).filter(Boolean);
  const checks = d.checks.map((c) => {
    if (c.name) return c;
    const name = uniqueName(clip(`chk_${table}_1`).replace(/_1$/, ''), ckNames);
    ckNames.push(name);
    return { ...c, name };
  });
  return { ...d, indexes, foreignKeys, checks };
}

// ───────────────────────── Validation ─────────────────────────

export type DesignSection = 'fields' | 'indexes' | 'foreignKeys' | 'checks' | 'triggers' | 'options';

export interface DesignProblem {
  section: DesignSection;
  /** id of the affected object */
  id?: string;
  message: string;
}

const dupes = (names: string[]) => {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const n of names) {
    const k = n.toLowerCase();
    if (!n) continue;
    if (seen.has(k)) out.add(n);
    seen.add(k);
  }
  return [...out];
};

/** Problems that would make the generated statements fail (resolved design) */
export function validateDesign(d: TableDesign): DesignProblem[] {
  const out: DesignProblem[] = [];
  if (!d.fields.length) out.push({ section: 'fields', message: tr('Die Tabelle braucht mindestens ein Feld.', 'The table needs at least one field.') });
  d.fields.forEach((f, i) => {
    const label = f.name || tr('Feld {n}', 'Field {n}', { n: i + 1 });
    if (!f.name.trim()) out.push({ section: 'fields', id: f.id, message: tr('Feld {n}: Name fehlt.', 'Field {n}: name is missing.', { n: i + 1 }) });
    else if (f.name.length > MAX_NAME) out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: Name ist länger als 64 Zeichen.', 'Field "{n}": name is longer than 64 characters.', { n: f.name }) });
    if (!f.type.trim()) out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: Typ fehlt.', 'Field "{n}": type is missing.', { n: label }) });
    const t = f.type.toUpperCase();
    const info = typeInfo(t);
    if ((t === 'ENUM' || t === 'SET') && !f.values.length) {
      out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: {t} braucht mindestens einen Wert.', 'Field "{n}": {t} needs at least one value.', { n: label, t }) });
    }
    if (info.length === 'req' && !f.length) out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: Länge fehlt.', 'Field "{n}": length is missing.', { n: label }) });
    if ((f.length && !/^\d+$/.test(f.length)) || (f.decimals && !/^\d+$/.test(f.decimals))) {
      out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: Länge und Dezimalstellen müssen Zahlen sein.', 'Field "{n}": length and decimals must be numbers.', { n: label }) });
    } else if (f.length && f.decimals && Number(f.decimals) > Number(f.length)) {
      out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: mehr Dezimalstellen als Stellen.', 'Field "{n}": more decimals than digits.', { n: label }) });
    }
    if (info.fsp && f.length && Number(f.length) > 6) {
      out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: Sekundenbruchteile 0 bis 6.', 'Field "{n}": fractional seconds must be 0 to 6.', { n: label }) });
    }
    if (f.generated && !f.generatedExpr.trim()) {
      out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: Ausdruck der berechneten Spalte fehlt.', 'Field "{n}": generated column expression is missing.', { n: label }) });
    }
    if (f.defaultKind === 'expression' && !f.defaultValue.trim() && !f.generated) {
      out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: Standardausdruck fehlt.', 'Field "{n}": default expression is missing.', { n: label }) });
    }
    if (f.srid && !/^\d+$/.test(f.srid)) out.push({ section: 'fields', id: f.id, message: tr('Feld „{n}“: SRID muss eine Zahl sein.', 'Field "{n}": SRID must be a number.', { n: label }) });
  });
  for (const n of dupes(d.fields.map((f) => f.name))) {
    out.push({ section: 'fields', id: d.fields.find((f) => f.name === n)?.id, message: tr('Der Feldname „{n}“ ist mehrfach vergeben.', 'The field name "{n}" is used more than once.', { n }) });
  }
  const ai = d.fields.filter((f) => f.autoIncrement && !f.generated);
  if (ai.length > 1) out.push({ section: 'fields', id: ai[1].id, message: tr('Nur ein Feld kann Auto Increment sein.', 'Only one field can be auto increment.') });
  if (ai.length === 1) {
    const n = ai[0].name;
    const keyed = d.primaryKey[0] === n || d.indexes.some((ix) => ix.fields[0]?.name === n && ix.type !== 'FULLTEXT' && ix.type !== 'SPATIAL');
    if (!keyed) {
      out.push({
        section: 'fields',
        id: ai[0].id,
        message: tr('Das Auto-Increment-Feld „{n}“ muss erstes Feld eines Schlüssels sein.', 'The auto increment field "{n}" must be the first field of a key.', { n })
      });
    }
  }
  const names = new Set(d.fields.map((f) => f.name.toLowerCase()));
  for (const p of d.primaryKey) {
    if (!names.has(p.toLowerCase())) out.push({ section: 'fields', message: tr('Der Primärschlüssel verweist auf ein fehlendes Feld.', 'The primary key refers to a missing field.') });
  }
  d.indexes.forEach((ix, i) => {
    const label = ix.name || tr('Index {n}', 'Index {n}', { n: i + 1 });
    if (!ix.fields.length) out.push({ section: 'indexes', id: ix.id, message: tr('Index „{n}“ hat keine Felder.', 'Index "{n}" has no fields.', { n: label }) });
    if (ix.name.toUpperCase() === 'PRIMARY') out.push({ section: 'indexes', id: ix.id, message: tr('„PRIMARY“ ist als Indexname reserviert.', '"PRIMARY" is reserved as index name.') });
    for (const p of ix.fields) {
      if (p.name && !names.has(p.name.toLowerCase())) {
        out.push({ section: 'indexes', id: ix.id, message: tr('Index „{n}“ verweist auf das fehlende Feld „{f}“.', 'Index "{n}" refers to the missing field "{f}".', { n: label, f: p.name }) });
      }
      if (!p.name && !p.expr?.trim()) out.push({ section: 'indexes', id: ix.id, message: tr('Index „{n}“ enthält einen leeren Ausdruck.', 'Index "{n}" contains an empty expression.', { n: label }) });
      if (p.subPart && !/^\d+$/.test(p.subPart)) out.push({ section: 'indexes', id: ix.id, message: tr('Index „{n}“: Präfixlänge muss eine Zahl sein.', 'Index "{n}": prefix length must be a number.', { n: label }) });
    }
  });
  for (const n of dupes(d.indexes.map((i) => i.name))) {
    out.push({ section: 'indexes', id: d.indexes.find((i) => i.name === n)?.id, message: tr('Der Indexname „{n}“ ist mehrfach vergeben.', 'The index name "{n}" is used more than once.', { n }) });
  }
  d.foreignKeys.forEach((fk, i) => {
    const label = fk.name || tr('Fremdschlüssel {n}', 'Foreign key {n}', { n: i + 1 });
    if (!fk.fields.length) out.push({ section: 'foreignKeys', id: fk.id, message: tr('„{n}“: keine Felder gewählt.', '"{n}": no fields selected.', { n: label }) });
    if (!fk.refTable) out.push({ section: 'foreignKeys', id: fk.id, message: tr('„{n}“: referenzierte Tabelle fehlt.', '"{n}": referenced table is missing.', { n: label }) });
    else if (fk.refFields.length !== fk.fields.length) {
      out.push({
        section: 'foreignKeys',
        id: fk.id,
        message: tr('„{n}“: gleich viele Felder und referenzierte Felder wählen.', '"{n}": choose as many referenced fields as fields.', { n: label })
      });
    }
    for (const f of fk.fields) if (!names.has(f.toLowerCase())) out.push({ section: 'foreignKeys', id: fk.id, message: tr('„{n}“ verweist auf das fehlende Feld „{f}“.', '"{n}" refers to the missing field "{f}".', { n: label, f }) });
  });
  for (const n of dupes(d.foreignKeys.map((f) => f.name))) {
    out.push({ section: 'foreignKeys', id: d.foreignKeys.find((f) => f.name === n)?.id, message: tr('Der Name „{n}“ ist mehrfach vergeben.', 'The name "{n}" is used more than once.', { n }) });
  }
  d.checks.forEach((c, i) => {
    if (!c.expr.trim()) out.push({ section: 'checks', id: c.id, message: tr('Check {n}: Ausdruck fehlt.', 'Check {n}: expression is missing.', { n: c.name || i + 1 }) });
  });
  for (const n of dupes(d.checks.map((c) => c.name))) {
    out.push({ section: 'checks', id: d.checks.find((c) => c.name === n)?.id, message: tr('Der Checkname „{n}“ ist mehrfach vergeben.', 'The check name "{n}" is used more than once.', { n }) });
  }
  d.triggers.forEach((t, i) => {
    if (!t.name.trim()) out.push({ section: 'triggers', id: t.id, message: tr('Trigger {n}: Name fehlt.', 'Trigger {n}: name is missing.', { n: i + 1 }) });
    if (!t.body.trim()) out.push({ section: 'triggers', id: t.id, message: tr('Trigger „{n}“: Definition fehlt.', 'Trigger "{n}": definition is missing.', { n: t.name || i + 1 }) });
  });
  for (const n of dupes(d.triggers.map((t) => t.name))) {
    out.push({ section: 'triggers', id: d.triggers.find((t) => t.name === n)?.id, message: tr('Der Triggername „{n}“ ist mehrfach vergeben.', 'The trigger name "{n}" is used more than once.', { n }) });
  }
  const numeric: (keyof TableDesign['options'])[] = ['autoIncrement', 'avgRowLength', 'maxRows', 'minRows', 'keyBlockSize', 'statsSamplePages'];
  for (const k of numeric) {
    const v = String(d.options[k] ?? '');
    if (v && !/^\d+$/.test(v)) out.push({ section: 'options', message: tr('Option {k}: nur ganze Zahlen erlaubt.', 'Option {k}: only whole numbers are allowed.', { k }) });
  }
  return out;
}

// ───────────────────────── Save helpers ─────────────────────────

/** After a partially executed save: marks what now exists on the server so the next diff only contains the rest */
export function rebaseAfterPartialSave(edit: TableDesign, steps: DdlStep[], done: number): TableDesign {
  const applied = steps.slice(0, done);
  const kinds = new Set(applied.map((s) => s.kind));
  const e: TableDesign = structuredClone(edit);
  if (kinds.has('createTable') || kinds.has('alterTable')) {
    e.origName = e.name;
    for (const f of e.fields) f.origName = f.name;
    for (const i of e.indexes) i.origName = i.name;
    for (const c of e.checks) c.origName = c.name;
    if (kinds.has('createTable')) for (const fk of e.foreignKeys) fk.origName = fk.name;
  }
  const droppedFks = new Set(applied.filter((s) => s.kind === 'dropForeignKeys').flatMap((s) => s.names));
  for (const fk of e.foreignKeys) if (fk.origName && droppedFks.has(fk.origName)) fk.origName = undefined;
  if (kinds.has('addForeignKeys')) for (const fk of e.foreignKeys) fk.origName = fk.name;
  const droppedTriggers = new Set(applied.filter((s) => s.kind === 'dropTrigger').flatMap((s) => s.names));
  for (const t of e.triggers) if (t.origName && droppedTriggers.has(t.origName)) t.origName = undefined;
  const createdTriggers = new Set(applied.filter((s) => s.kind === 'createTrigger').flatMap((s) => s.names));
  for (const t of e.triggers) if (createdTriggers.has(t.name)) t.origName = t.name;
  return e;
}

function replaceTableName(name: string, oldTable: string, newTable: string): string | null {
  if (!name || !oldTable) return null;
  const i = name.toLowerCase().indexOf(oldTable.toLowerCase());
  return i < 0 ? null : clip(name.slice(0, i) + newTable + name.slice(i + oldTable.length));
}

/**
 * Copy of a design under a new name ("save as"): everything becomes new; names that must be unique in the schema
 * (foreign keys, checks, triggers) are derived from the new table name.
 */
export function copyForSaveAs(d: TableDesign, newName: string, taken: { triggers: string[]; constraints: string[] }): TableDesign {
  const oldName = d.name;
  const constraints = [...taken.constraints];
  const derive = (name: string): string => {
    const n = replaceTableName(name, oldName, newName);
    if (!n || constraints.some((c) => c.toLowerCase() === n.toLowerCase())) return '';
    constraints.push(n);
    return n;
  };
  const triggerNames = [...taken.triggers];
  const triggerMap = new Map<string, string>();
  for (const t of d.triggers) {
    const base = replaceTableName(t.name, oldName, newName) ?? clip(`${t.name}_${newName}`);
    const n = uniqueName(base, triggerNames);
    triggerNames.push(n);
    triggerMap.set(t.name, n);
  }
  return {
    ...d,
    name: newName,
    origName: undefined,
    fields: d.fields.map((f) => ({ ...f, id: newId('f'), origName: undefined })),
    indexes: d.indexes.map((i) => ({ ...i, id: newId('i'), origName: undefined })),
    foreignKeys: d.foreignKeys.map((fk) => ({
      ...fk,
      id: newId('r'),
      origName: undefined,
      name: derive(fk.name),
      refTable: fk.refTable === oldName && (fk.refSchema || d.schema) === d.schema ? newName : fk.refTable
    })),
    checks: d.checks.map((c) => ({ ...c, id: newId('k'), origName: undefined, name: derive(c.name) })),
    triggers: d.triggers.map((t) => ({
      ...t,
      id: newId('t'),
      origName: undefined,
      name: triggerMap.get(t.name) ?? t.name,
      orderOther: t.orderOther ? (triggerMap.get(t.orderOther) ?? t.orderOther) : ''
    })),
    options: { ...d.options, autoIncrement: '' }
  };
}

// ───────────────────────── Field operations (editing form) ─────────────────────────

export function insertFieldAt(e: TableDesign, at: number, f: FieldDef): TableDesign {
  const fields = [...e.fields];
  fields.splice(Math.max(0, Math.min(at, fields.length)), 0, f);
  return { ...e, fields };
}

export function moveFieldTo(e: TableDesign, id: string, to: number): TableDesign {
  const from = e.fields.findIndex((f) => f.id === id);
  if (from < 0) return e;
  const fields = [...e.fields];
  const [f] = fields.splice(from, 1);
  fields.splice(Math.max(0, Math.min(to, fields.length)), 0, f);
  return { ...e, fields };
}

/** Adds the field to the primary key (it becomes NOT NULL) or removes it */
export function togglePrimaryKey(e: TableDesign, id: string): TableDesign {
  if (e.primaryKey.includes(id)) return { ...e, primaryKey: e.primaryKey.filter((x) => x !== id) };
  return {
    ...e,
    primaryKey: [...e.primaryKey, id],
    fields: e.fields.map((f) => (f.id === id ? normalizeField({ ...f, notNull: true }) : f))
  };
}

const CLIPBOARD_TAG = 'ksTableFields';

/** Clipboard text for copying field definitions between designers */
export function fieldsToClipboard(fields: FieldDef[]): string {
  return JSON.stringify({ [CLIPBOARD_TAG]: fields.map(({ id: _id, origName: _orig, ...rest }) => rest) }, null, 1);
}

/** Field definitions from the clipboard (new ids, unique names), null if the text holds none */
export function fieldsFromClipboard(text: string, takenNames: string[]): FieldDef[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = (parsed as Record<string, unknown> | null)?.[CLIPBOARD_TAG];
  if (!Array.isArray(list)) return null;
  const names = [...takenNames];
  return list
    .filter((x): x is Partial<FieldDef> => !!x && typeof x === 'object')
    .map((x) => {
      const f = newField({ ...x, id: newId('f'), origName: undefined });
      f.name = uniqueName(f.name || 'field', names);
      names.push(f.name);
      return f;
    });
}

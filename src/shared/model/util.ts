// Helpers for model designs: key/relationship properties, automatic foreign key indexes,
// type inference for quick field entry and reference maintenance on renames.

import type { FieldDef, ForeignKeyDef, IndexDef, TableDesign } from '../types';
import { newField, newId } from '../defaults';
import { isNumericType } from '../sql/ddl';
import { parseEnumValues } from '../sql/quote';
import { uniqueName } from '../util';
import type { ModelDoc, ModelTable } from './types';

/** Colors offered for tables, notes, layers and relations (readable in light and dark mode). */
export const OBJECT_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#0891b2', '#64748b'];

export const relationKey = (tableId: string, fkId: string): string => `${tableId}/${fkId}`;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameSet = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((x) => b.some((y) => eq(x, y)));

export function findField(d: TableDesign, name: string): FieldDef | undefined {
  return d.fields.find((f) => eq(f.name, name));
}

/** Foreign key columns are the primary key or a unique key → one-to-one relationship. */
export function fkIsUnique(d: TableDesign, fk: ForeignKeyDef): boolean {
  if (sameSet(d.primaryKey, fk.fields)) return true;
  return d.indexes.some((ix) => ix.type === 'UNIQUE' && sameSet(ix.fields.map((p) => p.name), fk.fields));
}

/** At least one foreign key column accepts NULL → the parent is optional. */
export function fkIsOptional(d: TableDesign, fk: ForeignKeyDef): boolean {
  return fk.fields.some((n) => !findField(d, n)?.notNull);
}

/** An index (or the primary key) starts with the given columns, as MySQL requires for foreign keys. */
export function hasLeftmostIndex(d: TableDesign, cols: string[]): boolean {
  const starts = (list: string[]) => cols.length > 0 && cols.length <= list.length && cols.every((c, i) => eq(list[i], c));
  if (starts(d.primaryKey)) return true;
  return d.indexes.some((ix) => ix.type !== 'FULLTEXT' && ix.type !== 'SPATIAL' && ix.fields.every((p) => p.name) && starts(ix.fields.map((p) => p.name)));
}

export function newIndex(name: string, cols: string[], type: IndexDef['type'] = 'NORMAL'): IndexDef {
  return {
    id: newId('i'),
    name,
    type,
    method: '',
    fields: cols.map((c) => ({ name: c, subPart: '', order: '' })),
    comment: '',
    invisible: false,
    parser: '',
    keyBlockSize: ''
  };
}

/** MySQL creates an index (named after the constraint) for foreign keys without a usable one – mirror that. */
export function ensureFkIndexes(d: TableDesign): TableDesign {
  let cur = d;
  for (const fk of d.foreignKeys) {
    if (!fk.fields.length || hasLeftmostIndex(cur, fk.fields)) continue;
    const name = uniqueName(fk.name || fk.fields[0], cur.indexes.map((i) => i.name));
    cur = { ...cur, indexes: [...cur.indexes, newIndex(name, fk.fields)] };
  }
  return cur;
}

// ───────────────────────── Types ─────────────────────────

const INTEGER_TYPES = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT']);

export function isIntegerType(type: string): boolean {
  return INTEGER_TYPES.has(type.toUpperCase());
}

const TYPE_ALIASES: Record<string, Partial<FieldDef>> = {
  INTEGER: { type: 'INT' },
  BOOL: { type: 'TINYINT', length: '1' },
  BOOLEAN: { type: 'TINYINT', length: '1' },
  DEC: { type: 'DECIMAL' },
  NUMERIC: { type: 'DECIMAL' },
  FIXED: { type: 'DECIMAL' },
  REAL: { type: 'DOUBLE' },
  CHARACTER: { type: 'CHAR' },
  SERIAL: { type: 'BIGINT', unsigned: true, notNull: true, autoIncrement: true }
};

/** Parses a type like "varchar(100)", "decimal(10,2) unsigned" or "enum('a','b')". */
export function parseTypeText(text: string): Partial<FieldDef> | null {
  const m = /^\s*([a-z][a-z0-9 ]*?)\s*(?:\((.*)\))?\s*(unsigned)?\s*(zerofill)?\s*$/i.exec(text);
  if (!m) return null;
  let type = m[1].trim().toUpperCase().replace(/\s+/g, ' ');
  if (type === 'DOUBLE PRECISION') type = 'DOUBLE';
  if (/\s/.test(type)) return null;
  const alias = TYPE_ALIASES[type];
  const args = (m[2] ?? '').trim();
  const out: Partial<FieldDef> = { type, length: '', decimals: '', values: [], unsigned: !!m[3], zerofill: !!m[4], ...alias };
  if (type === 'ENUM' || type === 'SET') {
    out.values = parseEnumValues(`enum(${args})`);
    return out;
  }
  if (args) {
    const [a, b] = args.split(',').map((s) => s.trim());
    if (!/^\d+$/.test(a) || (b !== undefined && !/^\d+$/.test(b))) return null;
    out.length = a;
    out.decimals = b ?? '';
  }
  return out;
}

/** Guesses a data type from a column name (quick field entry). */
export function inferType(name: string): Pick<FieldDef, 'type' | 'length' | 'decimals'> {
  const n = name.trim();
  const l = n.toLowerCase();
  if (/^id$|_id$|[a-z0-9]Id$|ID$|^no$|_no$|[a-z0-9]No$|(^|_)(num|nr|qty|number|count)$|[a-z0-9](Num|Qty|Number|Count)$/.test(n) || l === 'age' || l === 'count') {
    return { type: 'INT', length: '', decimals: '' };
  }
  if (/(price|cost|salary|amount)$/.test(l)) return { type: 'DECIMAL', length: '10', decimals: '2' };
  if (/(size|height|width|length|weight|speed|distance)$/.test(l)) return { type: 'DOUBLE', length: '', decimals: '' };
  if (/(date|time)$|_at$/.test(l)) return { type: 'DATETIME', length: '', decimals: '' };
  return { type: 'VARCHAR', length: '255', decimals: '' };
}

/**
 * Quick field entry: "name", "name:type" or "*name[:type]" (asterisk = primary key).
 * Returns null when the text is empty or the type cannot be parsed.
 */
export function parseQuickField(text: string): { field: FieldDef; primary: boolean } | null {
  let t = text.trim();
  if (!t) return null;
  const primary = t.startsWith('*');
  if (primary) t = t.slice(1).trim();
  const colon = t.indexOf(':');
  const name = (colon >= 0 ? t.slice(0, colon) : t).trim();
  if (!name) return null;
  const typeText = colon >= 0 ? t.slice(colon + 1).trim() : '';
  const parsed = typeText ? parseTypeText(typeText) : inferType(name);
  if (!parsed) return null;
  const field = newField({ name, ...parsed });
  if (primary) field.notNull = true;
  return { field, primary };
}

/** Short type text for diagrams: varchar(255), int unsigned, enum('a','b',…) */
export function typeLabel(f: FieldDef): string {
  const t = f.type.toLowerCase();
  let s = t;
  if (t === 'enum' || t === 'set') {
    const v = f.values.map((x) => `'${x}'`).join(',');
    s = `${t}(${v.length > 26 ? `${v.slice(0, 25)}…` : v})`;
  } else if (f.length && f.decimals) s += `(${f.length},${f.decimals})`;
  else if (f.length && t !== 'year') s += `(${f.length})`;
  if (f.unsigned && isNumericType(f.type)) s += ' unsigned';
  return s;
}

// ───────────────────────── Reference maintenance ─────────────────────────

export function tableByName(doc: ModelDoc, name: string): ModelTable | undefined {
  return doc.tables.find((t) => eq(t.design.name, name));
}

export function uniqueTableName(doc: ModelDoc, base: string, ignoreId?: string): string {
  const names = [...doc.tables.filter((t) => t.id !== ignoreId).map((t) => t.design.name), ...doc.views.map((v) => v.name)];
  return uniqueName(base, names);
}

/** Foreign keys of other tables that reference `tableName` (same model schema). */
export function incomingFks(doc: ModelDoc, tableName: string): { table: ModelTable; fk: ForeignKeyDef }[] {
  const out: { table: ModelTable; fk: ForeignKeyDef }[] = [];
  for (const t of doc.tables) for (const fk of t.design.foreignKeys) if (!fk.refSchema && eq(fk.refTable, tableName)) out.push({ table: t, fk });
  return out;
}

/**
 * Applies the effects of changing one table (`before` → `after`) to the other tables of the model:
 * renamed table / columns are followed by the referencing foreign keys, foreign keys whose
 * referenced columns disappeared are removed. Returns the updated table list (with `after` in place).
 */
export function propagateTableChange(doc: ModelDoc, tableId: string, before: TableDesign, after: TableDesign): ModelTable[] {
  const byId = new Map(before.fields.map((f) => [f.id, f.name]));
  const renamed = new Map<string, string>();
  for (const f of after.fields) {
    const old = byId.get(f.id);
    if (old !== undefined && old !== f.name) renamed.set(old.toLowerCase(), f.name);
  }
  const remaining = new Set(after.fields.map((f) => f.name.toLowerCase()));
  const tableRenamed = !eq(before.name, after.name) || before.name !== after.name;
  return doc.tables.map((t) => {
    if (t.id === tableId) {
      // self references follow renames too
      const fks = after.foreignKeys.map((fk) =>
        !fk.refSchema && (eq(fk.refTable, before.name) || eq(fk.refTable, after.name))
          ? { ...fk, refTable: after.name, refFields: fk.refFields.map((c) => renamed.get(c.toLowerCase()) ?? c) }
          : fk
      );
      return { ...t, design: { ...after, foreignKeys: fks.filter((fk) => fk.refTable !== after.name || fk.refFields.every((c) => remaining.has(c.toLowerCase()))) } };
    }
    let changed = false;
    const fks: ForeignKeyDef[] = [];
    for (const fk of t.design.foreignKeys) {
      if (fk.refSchema || !eq(fk.refTable, before.name)) {
        fks.push(fk);
        continue;
      }
      changed = true;
      const refFields = fk.refFields.map((c) => renamed.get(c.toLowerCase()) ?? c);
      if (!refFields.every((c) => remaining.has(c.toLowerCase()))) continue; // referenced column removed
      fks.push({ ...fk, refTable: tableRenamed ? after.name : fk.refTable, refFields });
    }
    return changed ? { ...t, design: { ...t.design, foreignKeys: fks } } : t;
  });
}

/** Foreign keys in other tables that would be removed by `propagateTableChange`. */
export function brokenIncomingFks(doc: ModelDoc, tableId: string, before: TableDesign, after: TableDesign): { table: string; fk: string }[] {
  const byId = new Map(before.fields.map((f) => [f.id, f.name]));
  const renamed = new Map<string, string>();
  for (const f of after.fields) {
    const old = byId.get(f.id);
    if (old !== undefined && old !== f.name) renamed.set(old.toLowerCase(), f.name);
  }
  const remaining = new Set(after.fields.map((f) => f.name.toLowerCase()));
  const out: { table: string; fk: string }[] = [];
  for (const t of doc.tables) {
    if (t.id === tableId) continue;
    for (const fk of t.design.foreignKeys) {
      if (fk.refSchema || !eq(fk.refTable, before.name)) continue;
      if (!fk.refFields.map((c) => renamed.get(c.toLowerCase()) ?? c).every((c) => remaining.has(c.toLowerCase()))) out.push({ table: t.design.name, fk: fk.name });
    }
  }
  return out;
}

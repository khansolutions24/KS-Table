// Model ↔ database synchronization: matches model tables / views with database objects
// (by name, with rename hints from origName), computes the statements that make the database
// match the model and orders them globally so that cross-table dependencies work.

import type { CheckDef, FieldDef, FkAction, ForeignKeyDef, IndexDef, TableDesign, TableOptions, TriggerDef } from '../types';
import { addForeignKeysSql, alterTableSql, asExisting, createTableSql, isNumericType, triggerSql } from '../sql/ddl';
import { qname } from '../sql/quote';
import type { ModelView } from './types';
import { looseExpr, normalizeViewSql, retarget } from './normalize';
import { viewOrder, viewSql } from './forward';
import { isIntegerType } from './util';

export interface DbView {
  name: string;
  definition: string;
  algorithm: string;
  security: string;
  checkOption: string;
}

export interface SyncOptions {
  /** Target database */
  schema: string;
  serverType: 'mysql' | 'mariadb';
  /** Drop columns, indexes, keys and checks that exist only in the database */
  dropColumns: boolean;
  triggers: boolean;
  views: boolean;
  includeDefiner: boolean;
}

/** Global execution phases (cross-table order) */
export const PHASE = {
  dropTrigger: 0,
  dropForeignKey: 1,
  dropView: 2,
  dropTable: 3,
  createTable: 4,
  alterTable: 5,
  addForeignKey: 6,
  createTrigger: 7,
  view: 8
} as const;

export type SyncAction = 'create' | 'alter' | 'drop' | 'same';

export interface SyncStatement {
  sql: string;
  phase: number;
  order: number;
}

export interface SyncItem {
  key: string;
  kind: 'table' | 'view';
  /** Model name (database name for drops) */
  name: string;
  dbName: string | null;
  action: SyncAction;
  statements: SyncStatement[];
  /** Contains DROP TABLE / DROP COLUMN */
  destructive: boolean;
  renamed: boolean;
}

export interface TableMatch {
  model: TableDesign | null;
  dbName: string | null;
  renamed: boolean;
}

const lc = (s: string) => s.toLowerCase();

/** Pairs model tables with database tables (exact name, then origName as rename hint). */
export function matchTables(model: TableDesign[], dbNames: string[]): TableMatch[] {
  const dbByLower = new Map(dbNames.map((n) => [lc(n), n]));
  const claimed = new Set<string>();
  const res: TableMatch[] = model.map((m) => {
    const db = dbByLower.get(lc(m.name));
    if (db) claimed.add(lc(db));
    return { model: m, dbName: db ?? null, renamed: false };
  });
  const own = new Set(model.map((m) => lc(m.name)));
  for (const r of res) {
    if (r.dbName || !r.model?.origName) continue;
    const o = lc(r.model.origName);
    const db = dbByLower.get(o);
    if (db && !claimed.has(o) && !own.has(o)) {
      claimed.add(o);
      r.dbName = db;
      r.renamed = true;
    }
  }
  for (const n of dbNames) if (!claimed.has(lc(n))) res.push({ model: null, dbName: n, renamed: false });
  return res;
}

function matchNames<T extends { name: string; origName?: string }>(items: T[], dbNames: string[]): (string | undefined)[] {
  const dbLower = new Map(dbNames.map((n) => [lc(n), n]));
  const claimed = new Set<string>();
  const res = items.map((i) => {
    const n = dbLower.get(lc(i.name));
    if (n) claimed.add(lc(n));
    return n;
  });
  const own = new Set(items.map((i) => lc(i.name)));
  items.forEach((i, k) => {
    if (res[k] || !i.origName) return;
    const o = lc(i.origName);
    const n = dbLower.get(o);
    if (n && !claimed.has(o) && !own.has(o)) {
      claimed.add(o);
      res[k] = n;
    }
  });
  return res;
}

const sameCase = (name: string, dbName?: string) => (dbName && lc(dbName) === lc(name) ? dbName : name);
const RESTRICTISH = new Set<string>(['', 'RESTRICT', 'NO ACTION']);
const TEMPORAL = new Set(['DATETIME', 'TIMESTAMP', 'TIME']);

function equivAction(m: FkAction, db: FkAction | undefined): FkAction {
  return db !== undefined && RESTRICTISH.has(m) && RESTRICTISH.has(db) ? db : m;
}

/** Adjusts a model field to the database spelling when both mean the same (implicit defaults, display widths …). */
export function equivField(m: FieldDef, db: FieldDef | undefined): FieldDef {
  let f = m;
  const set = (p: Partial<FieldDef>) => {
    f = { ...f, ...p };
  };
  const T = f.type.toUpperCase().trim();
  if (T !== f.type) set({ type: T });
  const generated = f.generated && !!f.generatedExpr.trim();
  if (!generated && (f.generated || f.generatedExpr)) set({ generated: false, generatedExpr: '', generatedStored: false });
  if (!f.notNull && f.defaultKind === 'none' && !generated) set({ defaultKind: 'null' });
  if (f.notNull && f.defaultKind === 'null') set({ defaultKind: 'none' });
  if (T === 'DECIMAL' && !f.length) set({ length: '10', decimals: '0' });
  else if (T === 'DECIMAL' && !f.decimals) set({ decimals: '0' });
  if ((T === 'CHAR' || T === 'BINARY' || T === 'BIT') && !f.length) set({ length: '1' });
  if (TEMPORAL.has(T) && f.length === '0') set({ length: '' });
  if (T === 'YEAR' && f.length) set({ length: '' });
  if (!db) return f;
  const DT = db.type.toUpperCase();
  if (isIntegerType(T) && DT === T && !f.zerofill && !db.zerofill && (f.length === '' || db.length === '')) set({ length: db.length });
  if (generated && db.generated && f.generatedExpr !== db.generatedExpr && looseExpr(f.generatedExpr) === looseExpr(db.generatedExpr)) set({ generatedExpr: db.generatedExpr });
  if (f.defaultKind === 'expression' && db.defaultKind === 'expression' && f.defaultValue !== db.defaultValue && looseExpr(f.defaultValue) === looseExpr(db.defaultValue)) {
    set({ defaultValue: db.defaultValue });
  }
  if (
    f.defaultKind === 'value' &&
    db.defaultKind === 'value' &&
    isNumericType(T) &&
    f.defaultValue !== db.defaultValue &&
    f.defaultValue.trim() !== '' &&
    Number(f.defaultValue) === Number(db.defaultValue)
  ) {
    set({ defaultValue: db.defaultValue });
  }
  if (f.charset && !f.collation && lc(f.charset) === lc(db.charset) && db.collation) set({ charset: db.charset, collation: db.collation });
  return f;
}

function equivOptions(m: TableOptions, db: TableOptions): TableOptions {
  const o = { ...m };
  if (o.engine && lc(o.engine) === lc(db.engine)) o.engine = db.engine;
  if (o.rowFormat && lc(o.rowFormat) === lc(db.rowFormat)) o.rowFormat = db.rowFormat;
  if (o.charset && lc(o.charset) === lc(db.charset)) {
    o.charset = db.charset;
    if (!o.collation) o.collation = db.collation;
  }
  if (o.collation && lc(o.collation) === lc(db.collation)) {
    o.collation = db.collation;
    if (!o.charset) o.charset = db.charset;
  }
  return o;
}

/** ALTER statements that make database table `db` equal to model table `model` (both in the target schema). */
export function tableAlterSql(modelIn: TableDesign, dbIn: TableDesign, o: SyncOptions): string[] {
  const model = o.triggers ? modelIn : { ...modelIn, triggers: [] as TriggerDef[] };
  const db = o.triggers ? dbIn : { ...dbIn, triggers: [] as TriggerDef[] };
  const tgt = asExisting({ ...db, options: { ...db.options, autoIncrement: '' } });
  const fieldOrig = matchNames(model.fields, db.fields.map((f) => f.name));
  const ixOrig = matchNames(model.indexes, db.indexes.map((i) => i.name));
  const fkOrig = matchNames(model.foreignKeys, db.foreignKeys.map((f) => f.name));
  const ckOrig = matchNames(model.checks, db.checks.map((c) => c.name));
  const trOrig = matchNames(model.triggers, db.triggers.map((t) => t.name));
  const renamedFields = new Map<string, string>();
  const fields: FieldDef[] = model.fields.map((f, i) => {
    const orig = fieldOrig[i];
    const dbf = orig ? db.fields.find((x) => x.name === orig) : undefined;
    if (orig && lc(orig) !== lc(f.name)) renamedFields.set(lc(orig), f.name);
    return { ...equivField(f, dbf), origName: orig };
  });
  const indexes: IndexDef[] = model.indexes.map((ix, i) => ({ ...ix, name: sameCase(ix.name, ixOrig[i]), origName: ixOrig[i] }));
  const foreignKeys: ForeignKeyDef[] = model.foreignKeys.map((fk, i) => {
    const d = fkOrig[i] ? db.foreignKeys.find((x) => x.name === fkOrig[i]) : undefined;
    return {
      ...fk,
      name: sameCase(fk.name, fkOrig[i]),
      refSchema: fk.refSchema || db.schema,
      refTable: d && lc(d.refTable) === lc(fk.refTable) ? d.refTable : fk.refTable,
      onDelete: equivAction(fk.onDelete, d?.onDelete),
      onUpdate: equivAction(fk.onUpdate, d?.onUpdate),
      origName: fkOrig[i]
    };
  });
  const checks: CheckDef[] = model.checks.map((c, i) => {
    const d = ckOrig[i] ? db.checks.find((x) => x.name === ckOrig[i]) : undefined;
    const expr = d && d.expr !== c.expr && looseExpr(d.expr) === looseExpr(c.expr) ? d.expr : c.expr;
    return { ...c, expr, name: sameCase(c.name, ckOrig[i]), origName: ckOrig[i] };
  });
  const triggers: TriggerDef[] = model.triggers.map((t, i) => ({ ...t, name: sameCase(t.name, trOrig[i]), origName: trOrig[i] }));
  const want: TableDesign = {
    ...model,
    schema: db.schema,
    name: lc(model.name) === lc(db.name) ? db.name : model.name,
    origName: db.name,
    fields,
    primaryKey: model.primaryKey.map((n) => fields.find((f) => lc(f.name) === lc(n))?.name ?? n),
    indexes,
    foreignKeys,
    checks,
    triggers,
    options: equivOptions({ ...model.options, autoIncrement: '' }, db.options)
  };
  return alterTableSql(tgt, want, { serverType: o.serverType, includeDefiner: o.includeDefiner, keepDropped: !o.dropColumns });
}

/** Phase of a statement generated by alterTableSql. */
export function classifyStatement(sql: string): number {
  if (/^DROP TRIGGER\b/i.test(sql)) return PHASE.dropTrigger;
  if (/^CREATE\b[^\n]*?\bTRIGGER\b/i.test(sql)) return PHASE.createTrigger;
  const m = /^ALTER TABLE [^\n]*\n\s*([\s\S]*)$/.exec(sql);
  if (m) {
    if (/^DROP FOREIGN KEY /i.test(m[1])) return PHASE.dropForeignKey;
    if (/^ADD CONSTRAINT `(?:[^`]|``)*` FOREIGN KEY /i.test(m[1])) return PHASE.addForeignKey;
  }
  return PHASE.alterTable;
}

const DESTRUCTIVE = /\bDROP\s+(TABLE|COLUMN)\b/i;

export interface SyncInput {
  tables: TableMatch[];
  /** Designs of matched database tables, key = lower-case database name */
  dbDesigns: Map<string, TableDesign>;
  modelViews: ModelView[];
  dbViews: DbView[];
}

/** Items (one per table / view) with the statements needed to make the database equal to the model. */
export function planSync(input: SyncInput, o: SyncOptions): SyncItem[] {
  const items: SyncItem[] = [];
  const schema = o.schema;
  input.tables.forEach((m, idx) => {
    if (m.model && !m.dbName) {
      let d = retarget(m.model, schema);
      d = { ...d, options: { ...d.options, autoIncrement: '' } };
      if (!o.triggers) d = { ...d, triggers: [] };
      const [create] = createTableSql({ ...d, foreignKeys: [], triggers: [] }, { serverType: o.serverType });
      const statements: SyncStatement[] = [{ sql: create, phase: PHASE.createTable, order: idx }];
      for (const s of addForeignKeysSql(d)) statements.push({ sql: s, phase: PHASE.addForeignKey, order: idx });
      for (const t of d.triggers) statements.push({ sql: triggerSql(t, schema, d.name, { includeDefiner: o.includeDefiner }), phase: PHASE.createTrigger, order: idx });
      items.push({ key: `table:${lc(d.name)}`, kind: 'table', name: d.name, dbName: null, action: 'create', statements, destructive: false, renamed: false });
    } else if (m.model && m.dbName) {
      const db = input.dbDesigns.get(lc(m.dbName));
      if (!db) return;
      const sql = tableAlterSql(retarget(m.model, schema), db, o);
      items.push({
        key: `table:${lc(m.model.name)}`,
        kind: 'table',
        name: m.model.name,
        dbName: m.dbName,
        action: sql.length ? 'alter' : 'same',
        statements: sql.map((s) => ({ sql: s, phase: classifyStatement(s), order: idx })),
        destructive: sql.some((s) => DESTRUCTIVE.test(s)),
        renamed: m.renamed
      });
    } else if (m.dbName) {
      items.push({
        key: `dbtable:${lc(m.dbName)}`,
        kind: 'table',
        name: m.dbName,
        dbName: m.dbName,
        action: 'drop',
        statements: [{ sql: `DROP TABLE ${qname(schema, m.dbName)}`, phase: PHASE.dropTable, order: idx }],
        destructive: true,
        renamed: false
      });
    }
  });
  if (o.views) {
    const dbv = new Map(input.dbViews.map((v) => [lc(v.name), v]));
    viewOrder(input.modelViews).forEach((v, i) => {
      const d = dbv.get(lc(v.name));
      if (d) dbv.delete(lc(v.name));
      const base = { key: `view:${lc(v.name)}`, kind: 'view' as const, name: v.name, destructive: false, renamed: false };
      if (!d) {
        items.push({ ...base, dbName: null, action: 'create', statements: [{ sql: viewSql(v, schema, false), phase: PHASE.view, order: i }] });
        return;
      }
      const dbDef = normalizeViewSql(d.definition);
      const defSame =
        normalizeViewSql(v.definition) === dbDef || (!!v.syncedAs && v.syncedAs.source === v.definition && normalizeViewSql(v.syncedAs.server) === dbDef);
      const same =
        defSame &&
        (v.algorithm || 'UNDEFINED') === (d.algorithm || 'UNDEFINED').toUpperCase() &&
        (v.security || 'DEFINER') === (d.security || 'DEFINER').toUpperCase() &&
        (v.checkOption || '') === (d.checkOption === 'NONE' ? '' : d.checkOption || '').toUpperCase();
      items.push({
        ...base,
        dbName: d.name,
        action: same ? 'same' : 'alter',
        statements: same ? [] : [{ sql: viewSql({ ...v, name: d.name }, schema, true), phase: PHASE.view, order: i }]
      });
    });
    for (const d of dbv.values()) {
      items.push({
        key: `dbview:${lc(d.name)}`,
        kind: 'view',
        name: d.name,
        dbName: d.name,
        action: 'drop',
        statements: [{ sql: `DROP VIEW ${qname(schema, d.name)}`, phase: PHASE.dropView, order: 0 }],
        destructive: false,
        renamed: false
      });
    }
  }
  return items;
}

/** Statements of the selected items in global execution order. */
export function syncStatements(items: SyncItem[], selected: Set<string>): string[] {
  const all: (SyncStatement & { item: number; seq: number })[] = [];
  items.forEach((it, item) => {
    if (!selected.has(it.key)) return;
    it.statements.forEach((s, seq) => all.push({ ...s, item, seq }));
  });
  all.sort((a, b) => a.phase - b.phase || a.order - b.order || a.item - b.item || a.seq - b.seq);
  return all.map((s) => s.sql);
}

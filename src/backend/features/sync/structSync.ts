// Structure synchronization: compares tables, views, routines, triggers and events of two databases and
// produces the statements that make the target structure equal to the source.

import type {
  StructCompareResult,
  StructDeployResult,
  StructDeployStatement,
  StructDiffItem,
  StructStatement,
  StructSyncOptions,
  StructSyncProfile,
  SyncEndpoint,
  SyncObjectType
} from '@shared/apis/sync';
import type { ObjectKind, TableDesign } from '@shared/types';
import { tr } from '@shared/i18n';
import { addForeignKeysSql, alterTableSteps, asExisting, createTableSql, type DdlStep } from '@shared/sql/ddl';
import { qname } from '@shared/sql/quote';
import { normalizeStructSyncProfile } from '@shared/sync/defaults';
import { buildStructScript } from '@shared/sync/structScript';
import { normalizeDdlText, qualifiedRefs, renameCreate, requalify, stripDefiner, withOrReplace } from '@shared/sync/sqlText';
import { formatDuration } from '@shared/util';
import type { BackendContext } from '../../api';
import { KsError } from '../../errors';
import { CancelledError, type TaskContext } from '../../tasks';
import {
  closeSyncSession,
  errorText,
  listObjects,
  loadDesign,
  nameLookup,
  openSyncSession,
  showCreate,
  topoSort,
  type SyncSession
} from './common';

type OptKey = 'rowFormat' | 'avgRowLength' | 'maxRows' | 'minRows' | 'keyBlockSize' | 'checksum' | 'delayKeyWrite' | 'packKeys' | 'statsAutoRecalc' | 'statsPersistent' | 'statsSamplePages' | 'tablespace' | 'compression' | 'encryption' | 'insertMethod' | 'union';
const OTHER_OPTIONS: OptKey[] = ['rowFormat', 'avgRowLength', 'maxRows', 'minRows', 'keyBlockSize', 'checksum', 'delayKeyWrite', 'packKeys', 'statsAutoRecalc', 'statsPersistent', 'statsSamplePages', 'tablespace', 'compression', 'encryption', 'insertMethod', 'union'];

function validate(p: StructSyncProfile): void {
  const { source, target } = p;
  if (!source.connectionId || !source.database) throw new KsError(tr('Bitte Quellverbindung und -datenbank wählen.', 'Please choose the source connection and database.'));
  if (!target.connectionId || !target.database) throw new KsError(tr('Bitte Zielverbindung und -datenbank wählen.', 'Please choose the target connection and database.'));
  if (source.connectionId === target.connectionId && source.database.toLowerCase() === target.database.toLowerCase()) {
    throw new KsError(tr('Quelle und Ziel dürfen nicht dieselbe Datenbank sein.', 'Source and target must not be the same database.'));
  }
}

/** SHOW CREATE TABLE text for display / comparison (options ignored as requested) */
function tableDdlText(sql: string, o: StructSyncOptions): string {
  let s = sql;
  if (o.ignoreAutoIncrement) s = s.replace(/\s+AUTO_INCREMENT=\d+/i, '');
  if (o.ignorePartitions) s = s.replace(/\n\/\*!50100 PARTITION BY[\s\S]*$/i, '').replace(/\nPARTITION BY[\s\S]*$/i, '');
  if (o.ignoreComments) s = s.replace(/ COMMENT '(?:[^'\\]|\\.|'')*'/g, '').replace(/ COMMENT='(?:[^'\\]|\\.|'')*'/g, '');
  if (o.ignoreCharset) s = s.replace(/ (?:DEFAULT )?(?:CHARSET|CHARACTER SET)[= ]\w+/gi, '').replace(/ COLLATE[= ]\w+/gi, '');
  return normalizeDdlText(s);
}

/** Source design adjusted so that ignored properties keep their target values */
function wantedDesign(source: TableDesign, target: TableDesign, o: StructSyncOptions): TableDesign {
  const tgt = asExisting(target);
  const tField = new Map(tgt.fields.map((f) => [f.name.toLowerCase(), f]));
  const tIndex = new Map(tgt.indexes.map((i) => [i.name, i]));
  const want: TableDesign = {
    ...source,
    schema: target.schema,
    name: target.name,
    origName: target.name,
    fields: source.fields.map((f) => {
      const t = tField.get(f.name.toLowerCase());
      const out = { ...f, origName: t?.name };
      if (t && o.ignoreComments) out.comment = t.comment;
      if (t && o.ignoreCharset) {
        out.charset = t.charset;
        out.collation = t.collation;
      }
      return out;
    }),
    indexes: source.indexes.map((i) => {
      const t = tIndex.get(i.name);
      return { ...i, origName: t ? i.name : undefined, comment: t && o.ignoreComments ? t.comment : i.comment };
    }),
    foreignKeys: source.foreignKeys.map((f) => ({
      ...f,
      refSchema: f.refSchema.toLowerCase() === source.schema.toLowerCase() ? target.schema : f.refSchema,
      origName: tgt.foreignKeys.some((x) => x.name === f.name) ? f.name : undefined
    })),
    checks: source.checks.map((c) => ({ ...c, origName: tgt.checks.some((x) => x.name === c.name) ? c.name : undefined })),
    triggers: [],
    comment: o.ignoreComments ? target.comment : source.comment,
    partition: o.ignorePartitions ? target.partition : source.partition,
    options: { ...source.options }
  };
  if (o.ignoreAutoIncrement) want.options.autoIncrement = '';
  if (o.ignoreCharset) {
    want.options.charset = target.options.charset;
    want.options.collation = target.options.collation;
  }
  if (o.ignoreTableOptions) {
    const w = want.options as unknown as Record<string, unknown>;
    const t = target.options as unknown as Record<string, unknown>;
    for (const k of OTHER_OPTIONS) w[k] = t[k];
  }
  return want;
}

function phaseOf(step: DdlStep): StructStatement['phase'] {
  switch (step.kind) {
    case 'dropForeignKeys':
      return 'dropFk';
    case 'addForeignKeys':
      return 'addFk';
    case 'dropTrigger':
      return 'drop';
    case 'createTrigger':
      return 'trigger';
    default:
      return 'table';
  }
}

const SHOW_KIND: Record<SyncObjectType, ObjectKind> = { table: 'table', view: 'view', function: 'function', procedure: 'procedure', trigger: 'trigger', event: 'event' };
const DROP_KW: Record<SyncObjectType, string> = { table: 'TABLE', view: 'VIEW', function: 'FUNCTION', procedure: 'PROCEDURE', trigger: 'TRIGGER', event: 'EVENT' };
const PHASE: Record<Exclude<SyncObjectType, 'table'>, StructStatement['phase']> = {
  view: 'view',
  function: 'routine',
  procedure: 'routine',
  trigger: 'trigger',
  event: 'event'
};

export async function structCompare(ctx: BackendContext, input: unknown, t: TaskContext): Promise<StructCompareResult> {
  const p = normalizeStructSyncProfile(input);
  validate(p);
  const o = p.options;
  const t0 = Date.now();
  const sdb = p.source.database;
  const tdb = p.target.database;
  const items: StructDiffItem[] = [];
  let src: SyncSession | null = null;
  let tgt: SyncSession | null = null;
  try {
    t.progress(null, tr('Verbinde …', 'Connecting …'));
    src = await openSyncSession(ctx, p.source.connectionId, sdb, 'read');
    tgt = await openSyncSession(ctx, p.target.connectionId, tdb, 'read');
    const ss = src.s;
    const ts = tgt.s;
    const sl = await listObjects(ss, sdb);
    const tl = await listObjects(ts, tdb);
    const opts = { serverType: ts.server.type };

    const total = Math.max(1, sl.tables.length + tl.tables.length + sl.views.length + sl.functions.length + sl.procedures.length + sl.triggers.length + sl.events.length);
    let done = 0;
    const tick = (name: string) => {
      done++;
      t.progress(Math.min(0.99, done / total), name);
      t.throwIfCancelled();
    };
    const fail = (type: SyncObjectType, name: string, e: unknown) => {
      if (e instanceof CancelledError) throw e;
      t.log('error', `${name}: ${errorText(e)}`);
      void type;
    };

    // ── tables
    const sDesigns = new Map<string, TableDesign>();
    const tFind = nameLookup(tl.tables.map((x) => x.name));
    const matchedTargets = new Set<string>();
    for (const x of sl.tables) {
      try {
        const sd = await loadDesign(ss, sdb, x.name);
        sDesigns.set(x.name, sd);
        const sText = tableDdlText((await showCreate(ss, sdb, 'table', x.name)).sql, o);
        const tn = tFind(x.name);
        const item: StructDiffItem = { id: `table:${x.name}`, type: 'table', name: x.name, table: null, status: 'create', sourceDdl: sText, targetDdl: '', statements: [], details: [], order: 0 };
        if (!tn) {
          const d: TableDesign = {
            ...sd,
            schema: tdb,
            triggers: [],
            options: { ...sd.options, autoIncrement: o.ignoreAutoIncrement ? '' : sd.options.autoIncrement },
            foreignKeys: sd.foreignKeys.map((f) => ({ ...f, refSchema: f.refSchema.toLowerCase() === sdb.toLowerCase() ? tdb : f.refSchema }))
          };
          for (const sql of createTableSql(d, { ...opts, foreignKeys: false, triggers: false })) item.statements.push({ phase: 'table', sql });
          for (const sql of addForeignKeysSql(d)) item.statements.push({ phase: 'addFk', sql });
        } else {
          matchedTargets.add(tn);
          const td = await loadDesign(ts, tdb, tn);
          item.name = tn;
          item.targetDdl = tableDdlText((await showCreate(ts, tdb, 'table', tn)).sql, o);
          const want = wantedDesign(sd, td, o);
          const from: TableDesign = { ...asExisting(td), triggers: [], options: { ...td.options, autoIncrement: o.ignoreAutoIncrement ? '' : td.options.autoIncrement } };
          if (!o.ignoreAutoIncrement && want.options.autoIncrement === from.options.autoIncrement) want.options.autoIncrement = '';
          for (const step of alterTableSteps(from, want, opts)) item.statements.push({ phase: phaseOf(step), sql: step.sql });
          item.status = item.statements.length ? 'alter' : 'same';
          item.details = tableDetails(sd, td);
        }
        items.push(item);
      } catch (e) {
        fail('table', x.name, e);
      }
      tick(x.name);
    }
    const tableOrder = topoSort([...sDesigns.keys()], (n) => (sDesigns.get(n)?.foreignKeys ?? []).map((f) => f.refTable));
    for (const it of items) it.order = Math.max(0, tableOrder.indexOf(it.type === 'table' ? (sDesigns.has(it.name) ? it.name : [...sDesigns.keys()].find((k) => k.toLowerCase() === it.name.toLowerCase()) ?? it.name) : it.name));
    for (const x of tl.tables) {
      if (matchedTargets.has(x.name)) continue;
      try {
        const text = tableDdlText((await showCreate(ts, tdb, 'table', x.name)).sql, o);
        items.push({ id: `table:${x.name}`, type: 'table', name: x.name, table: null, status: 'drop', sourceDdl: '', targetDdl: text, statements: [{ phase: 'drop', sql: `DROP TABLE IF EXISTS ${qname(tdb, x.name)}` }], details: [], order: 0 });
      } catch (e) {
        fail('table', x.name, e);
      }
      tick(x.name);
    }

    // ── other objects
    const normalize = (sql: string, schema: string) => normalizeDdlText(requalify(o.ignoreDefiner ? stripDefiner(sql) : sql, schema, ''));
    const compareObjects = async (type: Exclude<SyncObjectType, 'table'>, sNames: string[], tNames: string[], tableOf?: (n: string, side: 'source' | 'target') => string | null) => {
      const find = nameLookup(tNames);
      const matched = new Set<string>();
      const created: StructDiffItem[] = [];
      for (const name of sNames) {
        try {
          const sc = await showCreate(ss, sdb, SHOW_KIND[type], name);
          const tn = find(name);
          const table = tableOf?.(name, 'source') ?? null;
          const targetName = tn ?? name;
          let body = o.ignoreDefiner ? stripDefiner(sc.sql) : sc.sql;
          body = renameCreate(requalify(body, sdb, tdb), tdb, targetName, table ?? undefined);
          if (type === 'view') body = withOrReplace(body);
          const item: StructDiffItem = { id: `${type}:${targetName}`, type, name: targetName, table, status: 'create', sourceDdl: normalize(sc.sql, sdb), targetDdl: '', statements: [], details: [], order: 0 };
          if (tn) {
            matched.add(tn);
            const tc = await showCreate(ts, tdb, SHOW_KIND[type], tn);
            item.targetDdl = normalize(tc.sql, tdb);
            item.status = item.sourceDdl === item.targetDdl ? 'same' : 'alter';
          }
          if (item.status !== 'same') {
            // views are replaced in place (CREATE OR REPLACE), stored programs are dropped and re-created
            if (type !== 'view') item.statements.push({ phase: PHASE[type], sql: `DROP ${DROP_KW[type]} IF EXISTS ${qname(tdb, targetName)}` });
            item.statements.push({ phase: PHASE[type], sql: body });
          }
          items.push(item);
          created.push(item);
          if (type === 'view') viewSql.set(item.id, sc.sql);
        } catch (e) {
          fail(type, name, e);
        }
        tick(name);
      }
      for (const name of tNames) {
        if (matched.has(name)) continue;
        try {
          const tc = await showCreate(ts, tdb, SHOW_KIND[type], name);
          items.push({
            id: `${type}:${name}`,
            type,
            name,
            table: tableOf?.(name, 'target') ?? null,
            status: 'drop',
            sourceDdl: '',
            targetDdl: normalize(tc.sql, tdb),
            statements: [{ phase: 'drop', sql: `DROP ${DROP_KW[type]} IF EXISTS ${qname(tdb, name)}` }],
            details: [],
            order: 0
          });
        } catch (e) {
          fail(type, name, e);
        }
      }
      return created;
    };
    const viewSql = new Map<string, string>();
    if (o.routines) {
      await compareObjects('function', sl.functions, tl.functions);
      await compareObjects('procedure', sl.procedures, tl.procedures);
    }
    if (o.views) {
      const created = await compareObjects('view', sl.views, tl.views);
      const byLower = new Map(created.map((v) => [v.name.toLowerCase(), v]));
      const order = topoSort(
        created.map((v) => v.id),
        (id) => [...qualifiedRefs(viewSql.get(id) ?? '', sdb)].map((r) => byLower.get(r)?.id).filter((x): x is string => !!x)
      );
      for (const v of created) v.order = order.indexOf(v.id);
    }
    if (o.triggers) {
      const tableOf = (n: string, side: 'source' | 'target') => {
        const list = side === 'source' ? sl.triggers : tl.triggers;
        const tr0 = list.find((x) => x.name === n)?.table ?? null;
        if (!tr0 || side === 'target') return tr0;
        return tFind(tr0) ?? tr0;
      };
      await compareObjects('trigger', sl.triggers.map((x) => x.name), tl.triggers.map((x) => x.name), tableOf);
    }
    if (o.events) await compareObjects('event', sl.events, tl.events);
  } finally {
    await closeSyncSession(ctx, src);
    await closeSyncSession(ctx, tgt);
  }
  const counts = { create: 0, alter: 0, drop: 0, same: 0 };
  for (const it of items) counts[it.status]++;
  t.log(
    'success',
    tr('Vergleich abgeschlossen: {c} zu erstellen, {a} zu ändern, {d} nur im Ziel, {s} identisch ({t})', 'Comparison finished: {c} to create, {a} to alter, {d} only in target, {s} identical ({t})', {
      c: counts.create,
      a: counts.alter,
      d: counts.drop,
      s: counts.same,
      t: formatDuration(Date.now() - t0)
    })
  );
  return { source: p.source, target: p.target, options: o, items, durationMs: Date.now() - t0 };
}

function tableDetails(s: TableDesign, t: TableDesign): string[] {
  const out: string[] = [];
  const tf = new Map(t.fields.map((f) => [f.name.toLowerCase(), f]));
  const sf = new Set(s.fields.map((f) => f.name.toLowerCase()));
  for (const f of s.fields) {
    const x = tf.get(f.name.toLowerCase());
    if (!x) out.push(tr('Feld {n} hinzufügen', 'Add field {n}', { n: f.name }));
    else if (JSON.stringify({ ...f, id: '', origName: '' }) !== JSON.stringify({ ...x, id: '', origName: '', name: f.name })) out.push(tr('Feld {n} ändern', 'Modify field {n}', { n: f.name }));
  }
  for (const f of t.fields) if (!sf.has(f.name.toLowerCase())) out.push(tr('Feld {n} entfernen', 'Remove field {n}', { n: f.name }));
  const diffNamed = (a: { name: string }[], b: { name: string }[], add: string, del: string) => {
    const bn = new Set(b.map((x) => x.name));
    const an = new Set(a.map((x) => x.name));
    for (const x of a) if (!bn.has(x.name)) out.push(add.replace('{n}', x.name));
    for (const x of b) if (!an.has(x.name)) out.push(del.replace('{n}', x.name));
  };
  diffNamed(s.indexes, t.indexes, tr('Index {n} hinzufügen', 'Add index {n}'), tr('Index {n} entfernen', 'Remove index {n}'));
  diffNamed(s.foreignKeys, t.foreignKeys, tr('Fremdschlüssel {n} hinzufügen', 'Add foreign key {n}'), tr('Fremdschlüssel {n} entfernen', 'Remove foreign key {n}'));
  diffNamed(s.checks, t.checks, tr('Check {n} hinzufügen', 'Add check {n}'), tr('Check {n} entfernen', 'Remove check {n}'));
  return out;
}

export async function structDeploy(
  ctx: BackendContext,
  target: SyncEndpoint,
  statements: StructDeployStatement[],
  continueOnError: boolean,
  t: TaskContext
): Promise<StructDeployResult> {
  if (!target.connectionId || !target.database) throw new KsError(tr('Bitte Zielverbindung und -datenbank wählen.', 'Please choose the target connection and database.'));
  const t0 = Date.now();
  const res: StructDeployResult = { executed: 0, errors: 0, failed: [], durationMs: 0 };
  const ss = await openSyncSession(ctx, target.connectionId, target.database, 'strict');
  try {
    // events store STARTS / ENDS in the session time zone
    await ss.s.exec('SET SESSION time_zone = @@GLOBAL.time_zone');
    await ss.s.exec('SET FOREIGN_KEY_CHECKS = 0');
    for (let i = 0; i < statements.length; i++) {
      const st = statements[i];
      t.throwIfCancelled();
      t.progress(i / Math.max(1, statements.length), st.label);
      try {
        await ss.s.exec(st.sql);
        res.executed++;
        t.log('info', `${st.label}: ${st.sql.split('\n')[0].slice(0, 160)}`);
      } catch (e) {
        const msg = errorText(e);
        res.errors++;
        res.failed.push({ label: st.label, sql: st.sql, error: msg });
        t.log('error', `${st.label}: ${msg}`);
        if (!continueOnError) throw new KsError(tr('Ausführung abgebrochen: {m}', 'Execution stopped: {m}', { m: msg }));
      }
    }
    await ss.s.exec('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined);
  } finally {
    await closeSyncSession(ctx, ss);
    res.durationMs = Date.now() - t0;
  }
  if (res.errors) throw new KsError(tr('{n} Anweisung(en) fehlgeschlagen.', '{n} statement(s) failed.', { n: res.errors }));
  t.log('success', tr('{n} Anweisungen ausgeführt in {t}.', '{n} statements executed in {t}.', { n: res.executed, t: formatDuration(res.durationMs) }));
  return res;
}

/** Headless runner: compare, then deploy all differences (objects only in the target only with dropExtra). */
export async function runStructSyncProfile(ctx: BackendContext, input: unknown, t: TaskContext): Promise<StructDeployResult> {
  const p = normalizeStructSyncProfile(input);
  const cmp = await structCompare(ctx, p, t);
  const selected = new Set(cmp.items.filter((i) => i.status === 'create' || i.status === 'alter' || (i.status === 'drop' && p.options.dropExtra)).map((i) => i.id));
  const statements = buildStructScript(cmp.items, selected);
  if (!statements.length) {
    t.log('success', tr('Die Strukturen sind identisch.', 'The structures are identical.'));
    return { executed: 0, errors: 0, failed: [], durationMs: 0 };
  }
  return structDeploy(ctx, p.target, statements, p.options.continueOnError, t);
}

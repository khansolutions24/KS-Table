// Data transfer: copies tables (structure and records), views, routines, triggers and events from a
// source database into a target database or an SQL script file.
//
// Order: read definitions → drop target objects → create tables (without foreign keys) → copy records
// (parents first, chunked) → add foreign keys → functions/procedures → views (dependency order) →
// triggers (after the data, so they do not fire during the copy) → events.

import type { DataTransferResult, SyncObjectType, TransferObjectResult } from '@shared/apis/sync';
import type { ColumnMeta, TableDesign } from '@shared/types';
import { defaultTableOptions } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { addForeignKeysSql, createTableSql } from '@shared/sql/ddl';
import { qname, quoteId } from '@shared/sql/quote';
import { convertNameCase, normalizeTransferProfile } from '@shared/sync/defaults';
import { qualifiedRefs, renameCreate, requalify, stripDefiner } from '@shared/sync/sqlText';
import { valueClass } from '@shared/sync/values';
import { formatDateTime, formatDuration, formatNumber } from '@shared/util';
import type { BackendContext } from '../../api';
import { KsError } from '../../errors';
import { CancelledError, type TaskContext } from '../../tasks';
import {
  buildInserts,
  closeSyncSession,
  errorText,
  forEachChunk,
  isGeneratedColumn,
  listObjects,
  loadDesign,
  nameLookup,
  openSyncSession,
  pagingKey,
  readRows,
  schemaCharset,
  showCreate,
  tableColumns,
  topoSort,
  uniqueKeys,
  type CreateInfo,
  type SyncSession
} from './common';
import { DbSink, FileSink, type TransferSink } from './sink';

const summaries = new Map<string, DataTransferResult>();

export function transferSummary(taskId: string): DataTransferResult | null {
  return summaries.get(taskId) ?? null;
}

class TransferAbort extends Error {}

interface TableJob {
  name: string;
  target: string;
  design: TableDesign | null;
  columns: ColumnMeta[];
  key: string[] | null;
  where: string;
  estimate: number;
  total: number;
  created: boolean;
  exists: boolean;
  failed: boolean;
  r: TransferObjectResult;
}

interface ObjectJob {
  type: Exclude<SyncObjectType, 'table'>;
  name: string;
  target: string;
  table: string | null;
  create: CreateInfo | null;
  failed: boolean;
  r: TransferObjectResult;
}

const OBJECT_UNITS = 50;

export async function runDataTransfer(ctx: BackendContext, input: unknown, t: TaskContext): Promise<DataTransferResult> {
  const p = normalizeTransferProfile(input);
  const o = p.options;
  const res: DataTransferResult = { objects: [], rows: 0, errors: 0, warnings: 0, durationMs: 0, aborted: false };
  summaries.set(t.taskId, res);
  if (summaries.size > 30) summaries.delete(summaries.keys().next().value as string);
  const t0 = Date.now();
  const touched = new Set<TransferObjectResult>();

  const db = p.source.database;
  if (!p.source.connectionId || !db) throw new KsError(tr('Bitte Quellverbindung und -datenbank wählen.', 'Please choose the source connection and database.'));
  if (p.target.kind === 'database') {
    if (!p.target.connectionId || !p.target.database.trim()) {
      throw new KsError(tr('Bitte Zielverbindung und -datenbank wählen.', 'Please choose the target connection and database.'));
    }
    if (p.target.connectionId === p.source.connectionId && p.target.database.toLowerCase() === db.toLowerCase()) {
      throw new KsError(tr('Quelle und Ziel dürfen nicht dieselbe Datenbank sein.', 'Source and target must not be the same database.'));
    }
  }
  const targetSchema = p.target.kind === 'database' ? p.target.database.trim() : p.target.database.trim();

  const warn = (msg: string) => {
    res.warnings++;
    t.log('warn', msg);
  };
  const fail = (r: TransferObjectResult, e: unknown) => {
    if (e instanceof CancelledError || e instanceof TransferAbort) throw e;
    const msg = errorText(e);
    touched.add(r);
    if (r.status !== 'error') {
      r.status = 'error';
      res.errors++;
    }
    r.message = r.message && r.status === 'error' && r.message !== msg ? `${r.message}; ${msg}` : msg;
    t.log('error', `${label(r.type)} ${r.name}: ${msg}`);
    if (!o.continueOnError) throw new TransferAbort(msg);
  };
  const newResult = (type: SyncObjectType, name: string, targetName: string): TransferObjectResult => {
    const r: TransferObjectResult = { type, name, targetName, status: 'ok', rows: 0, message: '', durationMs: 0 };
    res.objects.push(r);
    return r;
  };
  const timed = async (r: TransferObjectResult, fn: () => Promise<void>) => {
    const s0 = Date.now();
    touched.add(r);
    try {
      await fn();
    } finally {
      r.durationMs += Date.now() - s0;
    }
  };

  let src: SyncSession | null = null;
  let sink: TransferSink | null = null;
  try {
    t.progress(null, tr('Verbinde …', 'Connecting …'));
    src = await openSyncSession(ctx, p.source.connectionId, db, 'read');
    const s = src.s;
    const list = await listObjects(s, db);

    // ── selection
    const pick = (all: string[], wanted: string[], kind: SyncObjectType): string[] => {
      if (p.objects.all) return all;
      const find = nameLookup(all);
      const out: string[] = [];
      for (const w of wanted) {
        const n = find(w);
        if (n) {
          if (!out.includes(n)) out.push(n);
        } else warn(tr('{k} „{n}“ existiert in der Quelle nicht und wird übersprungen.', '{k} "{n}" does not exist in the source and is skipped.', { k: label(kind), n: w }));
      }
      return out;
    };
    const selTables = pick(list.tables.map((x) => x.name), p.objects.tables, 'table');
    const selViews = pick(list.views, p.objects.views, 'view');
    const selFunctions = pick(list.functions, p.objects.functions, 'function');
    const selProcedures = pick(list.procedures, p.objects.procedures, 'procedure');
    const selTriggers = o.includeTriggers ? pick(list.triggers.map((x) => x.name), p.objects.triggers, 'trigger') : [];
    const selEvents = pick(list.events, p.objects.events, 'event');

    const tableSet = nameLookup(selTables);
    const tableTarget = (n: string) => p.tableSettings[n]?.targetName || convertNameCase(n, o.nameCase);
    /** target name of an object referenced from another object (tables keep their custom names) */
    const mapRef = (n: string) => {
      const tn = tableSet(n);
      return tn ? tableTarget(tn) : convertNameCase(n, o.nameCase);
    };
    const tq = (n: string) => (targetSchema ? qname(targetSchema, n) : quoteId(n));

    // ── read definitions
    t.log('info', tr('Lese Definitionen aus „{d}“ …', 'Reading definitions from "{d}" …', { d: db }));
    const keys = await uniqueKeys(s, db);
    const jobs: TableJob[] = [];
    for (const name of selTables) {
      t.throwIfCancelled();
      const job: TableJob = {
        name,
        target: tableTarget(name),
        design: null,
        columns: [],
        key: null,
        where: p.tableSettings[name]?.where ?? '',
        estimate: list.tables.find((x) => x.name === name)?.rows ?? 0,
        total: 0,
        created: false,
        exists: false,
        failed: false,
        r: newResult('table', name, tableTarget(name))
      };
      jobs.push(job);
      try {
        job.design = await loadDesign(s, db, name);
        job.columns = await tableColumns(s, db, name);
        job.key = pagingKey(job.columns, keys.get(name) ?? []);
      } catch (e) {
        job.failed = true;
        fail(job.r, e);
      }
    }
    const objJobs: ObjectJob[] = [];
    const addObjects = async (type: ObjectJob['type'], names: string[]) => {
      for (const name of names) {
        t.throwIfCancelled();
        const trg = type === 'trigger' ? list.triggers.find((x) => x.name === name) : undefined;
        const job: ObjectJob = {
          type,
          name,
          target: convertNameCase(name, o.nameCase),
          table: trg ? trg.table : null,
          create: null,
          failed: false,
          r: newResult(type, name, convertNameCase(name, o.nameCase))
        };
        objJobs.push(job);
        try {
          job.create = await showCreate(s, db, type, name);
        } catch (e) {
          job.failed = true;
          fail(job.r, e);
        }
      }
    };
    await addObjects('function', selFunctions);
    await addObjects('procedure', selProcedures);
    await addObjects('view', selViews);
    await addObjects('trigger', selTriggers);
    await addObjects('event', selEvents);

    // tables: referenced tables first
    const byName = new Map(jobs.map((j) => [j.name, j]));
    const sameSchema = (x: string) => !x || x.toLowerCase() === db.toLowerCase();
    const ordered = topoSort(
      jobs.map((j) => j.name),
      (n) => (byName.get(n)?.design?.foreignKeys ?? []).filter((fk) => sameSchema(fk.refSchema)).map((fk) => tableSet(fk.refTable) ?? fk.refTable)
    ).map((n) => byName.get(n)!);

    // ── target
    const sinkOpts = {
      createDatabase: o.createDatabase,
      disableFkChecks: o.disableFkChecks,
      maxStatementKB: o.maxStatementKB,
      charset: o.includeCharset ? await schemaCharset(s, db) : null
    };
    if (p.target.kind === 'database') {
      sink = await DbSink.open(ctx, p.target.connectionId, targetSchema, sinkOpts, (m) => t.log('info', m));
    } else {
      sink = await FileSink.open(p.target.path, p.target.encoding, targetSchema, s.server.type, sinkOpts, [
        tr('KS Table – Datenübertragung', 'KS Table – Data transfer'),
        `${tr('Quelle', 'Source')}: ${s.config.name} / ${db}`,
        `${tr('Erstellt', 'Created')}: ${formatDateTime(Date.now())}`
      ]);
    }
    const out = sink;
    t.log('info', p.target.kind === 'database' ? tr('Ziel: Datenbank „{d}“', 'Target: database "{d}"', { d: targetSchema }) : tr('Ziel: Datei {f}', 'Target: file {f}', { f: p.target.path }));

    // progress
    const totalObjects = jobs.length + objJobs.length;
    let doneUnits = 0;
    let totalUnits = Math.max(1, totalObjects * OBJECT_UNITS);
    const step = (msg: string, units = OBJECT_UNITS) => {
      doneUnits += units;
      t.progress(Math.min(0.999, doneUnits / totalUnits), msg);
    };

    // ── drop
    if (o.dropBeforeCreate) {
      const dropKw: Record<ObjectJob['type'], string> = { function: 'FUNCTION', procedure: 'PROCEDURE', view: 'VIEW', trigger: 'TRIGGER', event: 'EVENT' };
      for (const type of ['event', 'trigger', 'view', 'procedure', 'function'] as const) {
        for (const j of objJobs.filter((x) => x.type === type && !x.failed)) {
          t.throwIfCancelled();
          await timed(j.r, async () => {
            try {
              await out.exec(`DROP ${dropKw[type]} IF EXISTS ${tq(j.target)}`);
            } catch (e) {
              j.failed = true;
              fail(j.r, e);
            }
          });
        }
      }
      if (o.createTables) {
        for (const j of [...ordered].reverse()) {
          if (j.failed) continue;
          t.throwIfCancelled();
          await timed(j.r, async () => {
            try {
              await out.exec(`DROP TABLE IF EXISTS ${tq(j.target)}`);
            } catch (e) {
              j.failed = true;
              fail(j.r, e);
            }
          });
        }
      }
    }

    // ── create tables
    const existing = await out.existingTables();
    for (const j of ordered) {
      if (j.failed) continue;
      t.throwIfCancelled();
      await timed(j.r, async () => {
        const found = existing(j.target);
        try {
          if (o.createTables && !found) {
            await out.comment(tr('Tabelle {n}', 'Table {n}', { n: j.target }));
            const d = targetDesign(j.design!, targetSchema, j.target, o);
            for (const sql of createTableSql(d, { serverType: out.serverType, foreignKeys: false, triggers: false, qualified: !!targetSchema })) {
              await out.exec(sql);
            }
            j.created = true;
            j.exists = true;
            t.log('info', tr('Tabelle {n} erstellt', 'Table {n} created', { n: j.target }));
          } else if (found) {
            j.exists = true;
            j.target = found;
            j.r.targetName = found;
            if (o.createTables) {
              j.r.status = 'warning';
              j.r.message = tr('Tabelle existierte bereits – Datensätze wurden angehängt.', 'Table already existed – records were appended.');
              warn(`${found}: ${j.r.message}`);
            }
          } else if (out.kind === 'file') {
            j.exists = true;
          } else {
            throw new KsError(tr('Die Tabelle existiert im Ziel nicht.', 'The table does not exist in the target.'));
          }
        } catch (e) {
          j.failed = true;
          fail(j.r, e);
        }
      });
      step(tr('Tabelle {n}', 'Table {n}', { n: j.target }));
    }

    // ── records
    if (o.createRecords && ordered.some((j) => j.exists && !j.failed)) {
      const copyJobs = ordered.filter((j) => j.exists && !j.failed);
      if (o.lockSource) {
        await s.exec(`LOCK TABLES ${copyJobs.map((j) => `${qname(db, j.name)} READ`).join(', ')}`);
      } else {
        await s.exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
      }
      try {
        for (const j of copyJobs) {
          const where = j.where ? ` WHERE (${j.where})` : '';
          j.total = j.estimate;
          if (j.where || j.estimate < 5_000_000) {
            try {
              j.total = Number((await s.rowset(`SELECT COUNT(*) FROM ${qname(db, j.name)}${where}`)).rows[0]?.[0] ?? 0);
            } catch {
              j.total = j.estimate;
            }
          }
          totalUnits += j.total;
        }
        for (const j of copyJobs) {
          t.throwIfCancelled();
          await timed(j.r, async () => {
            try {
              await copyTable(j);
            } catch (e) {
              fail(j.r, e);
            }
          });
        }
      } finally {
        await s.exec(o.lockSource ? 'UNLOCK TABLES' : 'COMMIT').catch(() => undefined);
      }
    }

    async function copyTable(j: TableJob): Promise<void> {
      let cols = j.columns.filter((c) => !isGeneratedColumn(c));
      let targetNames = cols.map((c) => c.name);
      if (!j.created && out.kind === 'database') {
        const find = nameLookup(await out.columnsOf(j.target));
        const missing = cols.filter((c) => !find(c.name)).map((c) => c.name);
        if (missing.length) warn(tr('{t}: Felder fehlen im Ziel und werden übersprungen: {c}', '{t}: fields missing in the target are skipped: {c}', { t: j.target, c: missing.join(', ') }));
        cols = cols.filter((c) => !!find(c.name));
        targetNames = cols.map((c) => find(c.name)!);
      }
      if (!cols.length) throw new KsError(tr('Keine übertragbaren Felder.', 'No transferable fields.'));
      const select = [...cols];
      for (const k of j.key ?? []) if (!select.some((c) => c.name === k)) select.push(j.columns.find((c) => c.name === k)!);
      const classes = cols.map((c) => valueClass(c.dataType));
      const verb = o.insertMode === 'ignore' ? 'INSERT IGNORE' : o.insertMode === 'replace' ? 'REPLACE' : 'INSERT';
      const ref = tq(j.target);
      const opts = { verb, extended: o.extendedInsert, rowsPerStatement: o.rowsPerStatement, maxBytes: out.maxStatementBytes } as const;
      await out.comment(tr('Datensätze der Tabelle {n}', 'Records of table {n}', { n: j.target }));
      t.log('info', tr('Übertrage Datensätze {s} → {t} …', 'Copying records {s} → {t} …', { s: j.name, t: j.target }));
      await out.beginData(j.target, { transaction: o.useTransaction, lock: o.lockTarget });
      let ok = false;
      let copied = 0;
      try {
        const gen = readRows(src!.s, {
          schema: db,
          table: j.name,
          columns: select.map((c) => c.name),
          meta: select,
          key: j.key,
          where: j.where,
          fetchSize: o.fetchSize
        });
        await forEachChunk(gen, async (rows) => {
          for (const sql of buildInserts(ref, targetNames, classes, rows, opts)) await out.exec(sql);
          copied += rows.length;
          j.r.rows = copied;
          res.rows += rows.length;
          step(`${j.target}: ${formatNumber(copied)} / ${formatNumber(Math.max(copied, j.total))}`, rows.length);
          t.throwIfCancelled();
        });
        ok = true;
      } finally {
        try {
          await out.endData(ok);
        } finally {
          if (!ok && o.useTransaction && out.kind === 'database') {
            res.rows -= copied;
            j.r.rows = 0;
          }
        }
      }
      t.log('success', tr('{t}: {n} Datensätze übertragen', '{t}: {n} records copied', { t: j.target, n: formatNumber(copied) }));
    }

    // ── foreign keys
    if (o.includeForeignKeys) {
      for (const j of ordered) {
        if (!j.created || j.failed || !j.design?.foreignKeys.length) continue;
        t.throwIfCancelled();
        await timed(j.r, async () => {
          const d = targetDesign(j.design!, targetSchema, j.target, o);
          d.foreignKeys = j.design!.foreignKeys.map((fk) => {
            const own = sameSchema(fk.refSchema);
            return { ...fk, origName: undefined, refSchema: own ? targetSchema : fk.refSchema, refTable: own ? mapRef(fk.refTable) : fk.refTable };
          });
          try {
            for (const sql of addForeignKeysSql(d)) await out.exec(sql);
          } catch (e) {
            fail(j.r, e);
          }
        });
      }
    }

    // ── routines, views, triggers, events
    const objectSql = (j: ObjectJob): string => {
      let sql = j.create!.sql;
      if (!o.includeDefiner) sql = stripDefiner(sql);
      sql = requalify(sql, db, targetSchema, { mapName: mapRef });
      const table = j.table ? mapRef(j.table) : undefined;
      return renameCreate(sql, targetSchema, j.target, table);
    };
    const runObjects = async (list: ObjectJob[]) => {
      for (const j of list) {
        if (j.failed || !j.create) continue;
        t.throwIfCancelled();
        await timed(j.r, async () => {
          try {
            await out.execObject(objectSql(j), { sqlMode: j.type === 'view' ? null : j.create!.sqlMode, timeZone: j.type === 'event' ? j.create!.timeZone : null });
            t.log('info', tr('{k} {n} erstellt', '{k} {n} created', { k: label(j.type), n: j.target }));
          } catch (e) {
            j.failed = true;
            fail(j.r, e);
          }
        });
        step(`${label(j.type)} ${j.target}`);
      }
    };
    await runObjects(objJobs.filter((j) => j.type === 'function' || j.type === 'procedure'));
    const views = objJobs.filter((j) => j.type === 'view');
    const viewByLower = new Map(views.map((v) => [v.name.toLowerCase(), v]));
    const viewOrder = topoSort(
      views.map((v) => v.name),
      (n) => {
        const v = views.find((x) => x.name === n);
        if (!v?.create) return [];
        return [...qualifiedRefs(v.create.sql, db)].map((r) => viewByLower.get(r)?.name).filter((x): x is string => !!x);
      }
    );
    await runObjects(viewOrder.map((n) => views.find((v) => v.name === n)!));
    await runObjects(objJobs.filter((j) => j.type === 'trigger'));
    await runObjects(objJobs.filter((j) => j.type === 'event'));
    for (const j of jobs) if (!j.failed) step(j.target, 0);
  } catch (e) {
    res.aborted = true;
    for (const r of res.objects) {
      if (!touched.has(r) && r.status === 'ok') {
        r.status = 'skipped';
        r.message = tr('Nicht ausgeführt', 'Not executed');
      }
    }
    if (e instanceof TransferAbort) throw new KsError(tr('Übertragung abgebrochen: {m}', 'Transfer stopped: {m}', { m: e.message }));
    throw e;
  } finally {
    res.durationMs = Date.now() - t0;
    try {
      if (sink) await sink.close();
    } finally {
      await closeSyncSession(ctx, src);
    }
  }
  t.progress(1, '');
  const summary = tr('{o} Objekte, {r} Datensätze in {t}', '{o} objects, {r} records in {t}', {
    o: res.objects.length,
    r: formatNumber(res.rows),
    t: formatDuration(res.durationMs)
  });
  if (res.errors) {
    throw new KsError(tr('Übertragung beendet, {n} Objekt(e) mit Fehlern ({s}).', 'Transfer finished, {n} object(s) failed ({s}).', { n: res.errors, s: summary }));
  }
  t.log('success', tr('Übertragung abgeschlossen: {s}', 'Transfer finished: {s}', { s: summary }));
  return res;
}

function label(type: SyncObjectType): string {
  switch (type) {
    case 'table':
      return tr('Tabelle', 'Table');
    case 'view':
      return tr('Ansicht', 'View');
    case 'function':
      return tr('Funktion', 'Function');
    case 'procedure':
      return tr('Prozedur', 'Procedure');
    case 'trigger':
      return tr('Trigger', 'Trigger');
    case 'event':
      return tr('Ereignis', 'Event');
  }
}

/** Source design adapted to the target (options, names); foreign keys and triggers are handled separately */
function targetDesign(d: TableDesign, schema: string, name: string, o: ReturnType<typeof normalizeTransferProfile>['options']): TableDesign {
  const base = o.includeTableOptions ? d.options : defaultTableOptions();
  return {
    ...d,
    schema,
    name,
    origName: undefined,
    fields: d.fields.map((f) => ({
      ...f,
      origName: undefined,
      charset: o.includeCharset ? f.charset : '',
      collation: o.includeCharset ? f.collation : '',
      comment: o.includeComments ? f.comment : ''
    })),
    indexes: o.includeIndexes ? d.indexes.map((ix) => ({ ...ix, origName: undefined, comment: o.includeComments ? ix.comment : '' })) : [],
    foreignKeys: [],
    checks: o.includeChecks ? d.checks.map((c) => ({ ...c, origName: undefined })) : [],
    triggers: [],
    comment: o.includeComments ? d.comment : '',
    partition: o.includePartitions ? d.partition : '',
    options: {
      ...base,
      engine: o.includeEngine ? d.options.engine : '',
      charset: o.includeCharset ? d.options.charset : '',
      collation: o.includeCharset ? d.options.collation : '',
      autoIncrement: o.includeAutoIncrement ? d.options.autoIncrement : '',
      dataDirectory: '',
      indexDirectory: ''
    }
  };
}

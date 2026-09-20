// Dump SQL file: structure (and data) of a database as a script for the mysql client or Execute SQL File.

import type { ColumnMeta } from '@shared/types';
import type { DumpObjects, DumpOptions, DumpProfile, DumpResult } from '@shared/apis/io';
import { tr } from '@shared/i18n';
import { formatBytes, formatNumber, formatDateTime } from '@shared/util';
import { qname, quoteId, quoteString } from '@shared/sql/quote';
import { defaultDumpOptions } from '@shared/io/defaults';
import type { BackendContext } from '../../api';
import type { TaskContext } from '../../tasks';
import type { Session } from '../../db/sessions';
import { columns as loadColumns, ddl, events as listEvents, routines as listRoutines, tables as listTables, triggers as listTriggers, views as listViews } from '../../db/meta';
import { KsError } from '../../errors';
import { TextOutput } from './files';
import { streamRows } from './rows';
import { GEOMETRY_TYPES } from './convert';

export function normalizeDumpProfile(p: DumpProfile): DumpProfile {
  if (!p || typeof p !== 'object') throw new KsError(tr('Ungültiges Profil.', 'Invalid profile.'));
  const out: DumpProfile = {
    version: 1,
    connectionId: String(p.connectionId ?? ''),
    database: String(p.database ?? ''),
    file: String(p.file ?? ''),
    objects: p.objects ?? null,
    options: { ...defaultDumpOptions(false), ...(p.options ?? {}) }
  };
  if (!out.connectionId) throw new KsError(tr('Keine Verbindung angegeben.', 'No connection specified.'));
  if (!out.database) throw new KsError(tr('Keine Datenbank angegeben.', 'No database specified.'));
  if (!out.file) throw new KsError(tr('Keine Zieldatei angegeben.', 'No output file specified.'));
  return out;
}

const DEFINER_RE = /\s+DEFINER\s*=\s*(`(?:[^`]|``)*`|'(?:[^']|'')*'|[^\s@]+)@(`(?:[^`]|``)*`|'(?:[^']|'')*'|\S+)/i;

async function allObjects(s: Session, db: string): Promise<DumpObjects> {
  const [t, v, r, tg, e] = await Promise.all([listTables(s, db), listViews(s, db), listRoutines(s, db), listTriggers(s, db), listEvents(s, db)]);
  return {
    tables: t.map((x) => x.name),
    views: v.map((x) => x.name),
    functions: r.filter((x) => x.type === 'FUNCTION').map((x) => x.name),
    procedures: r.filter((x) => x.type === 'PROCEDURE').map((x) => x.name),
    triggers: tg.map((x) => x.name),
    events: e.map((x) => x.name)
  };
}

/** Views ordered so that views used by other views come first */
function orderViews(defs: Map<string, string>): string[] {
  const names = [...defs.keys()];
  const deps = new Map<string, string[]>();
  for (const n of names) {
    const body = defs.get(n)!.replace(/^[\s\S]*?\bVIEW\s+`(?:[^`]|``)+`\s+AS\b/i, '');
    deps.set(
      n,
      names.filter((m) => m !== n && body.includes('`' + m.replace(/`/g, '``') + '`'))
    );
  }
  const out: string[] = [];
  const state = new Map<string, number>();
  const visit = (n: string) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) return; // cycle: keep current order
    state.set(n, 1);
    for (const d of deps.get(n) ?? []) visit(d);
    state.set(n, 2);
    out.push(n);
  };
  names.forEach(visit);
  return out;
}

function valueSql(v: unknown, col: ColumnMeta, o: DumpOptions): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) {
    const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (col.dataType === 'bit') return `b'${[...buf].map((b) => b.toString(2).padStart(8, '0')).join('').replace(/^0+(?=.)/, '') || '0'}'`;
    if (!buf.length) return "''";
    if (o.binaryAs === 'base64' && !GEOMETRY_TYPES.has(col.dataType)) return `FROM_BASE64('${buf.toString('base64')}')`;
    return `0x${buf.toString('hex').toUpperCase()}`;
  }
  const s = String(v);
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year)$/.test(col.dataType) && /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return s;
  return quoteString(s);
}

export async function runDump(ctx: BackendContext, profile: DumpProfile, t: TaskContext): Promise<DumpResult> {
  const p = normalizeDumpProfile(profile);
  const o = p.options;
  const db = p.database;
  const s = await ctx.sessions.open(p.connectionId, db);
  let out: TextOutput | null = null;
  let objectsDone = 0;
  let totalRows = 0;
  try {
    const all = await allObjects(s, db);
    const pick = (want: string[] | undefined, have: string[]) => (want ? have.filter((n) => want.includes(n)) : have);
    const sel: DumpObjects = p.objects
      ? {
          tables: pick(p.objects.tables, all.tables),
          views: pick(p.objects.views, all.views),
          functions: pick(p.objects.functions, all.functions),
          procedures: pick(p.objects.procedures, all.procedures),
          triggers: pick(p.objects.triggers, all.triggers),
          events: pick(p.objects.events, all.events)
        }
      : all;
    const missing = p.objects ? [...p.objects.tables, ...p.objects.views].filter((n) => !all.tables.includes(n) && !all.views.includes(n)) : [];
    for (const n of missing) t.log('warn', tr('„{n}“ wurde nicht gefunden und wird übersprungen.', '"{n}" was not found and is skipped.', { n }));

    // definitions of views and stored programs are read before tables are locked
    // (SHOW CREATE VIEW fails for views that are not part of LOCK TABLES)
    const defs = new Map<string, { def: string; mode: string | null }>();
    const readDef = async (kind: 'VIEW' | 'TRIGGER' | 'FUNCTION' | 'PROCEDURE' | 'EVENT', name: string) => {
      const r = await s.rowset(`SHOW CREATE ${kind} ${qname(db, name)}`);
      const di = r.fields.findIndex((f) => /^create (view|function|procedure|event)$/i.test(f.name) || f.name === 'SQL Original Statement');
      const mi = r.fields.findIndex((f) => f.name === 'sql_mode');
      const raw = di >= 0 ? r.rows[0]?.[di] : null;
      if (raw === null || raw === undefined) {
        throw new KsError(tr('Keine Berechtigung, die Definition von „{n}“ zu lesen.', 'No privilege to read the definition of "{n}".', { n: name }));
      }
      const def = raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : String(raw);
      defs.set(`${kind}:${name}`, { def, mode: mi >= 0 ? String(r.rows[0]?.[mi] ?? '') : null });
    };
    for (const n of sel.views) await readDef('VIEW', n);
    for (const n of sel.triggers) await readDef('TRIGGER', n);
    for (const n of sel.functions) await readDef('FUNCTION', n);
    for (const n of sel.procedures) await readDef('PROCEDURE', n);
    for (const n of sel.events) await readDef('EVENT', n);
    const defOf = (kind: string, name: string) => defs.get(`${kind}:${name}`)!;

    await s.exec("SET SESSION time_zone = '+00:00'");
    await s.exec("SET SESSION sql_mode = ''");
    if (o.consistency === 'snapshot') {
      await s.exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await s.exec('START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */');
    } else if (o.consistency === 'lock' && sel.tables.length) {
      await s.exec(`LOCK TABLES ${sel.tables.map((n) => `${quoteId(n)} READ LOCAL`).join(', ')}`);
    }

    const server = (await s.rowset('SELECT VERSION()')).rows[0]?.[0];
    out = await TextOutput.open(p.file, 'utf8');
    const w = (x: string) => out!.write(x);
    await w(
      `-- KS Table SQL Dump\n-- ${tr('Server', 'Server')}: ${String(server)}\n-- ${tr('Datenbank', 'Database')}: ${db}\n-- ${tr('Erstellt', 'Created')}: ${formatDateTime(Date.now())}\n\n`
    );
    if (o.charsetHeader) await w('SET NAMES utf8mb4;\n');
    await w("SET @OLD_TIME_ZONE=@@TIME_ZONE;\nSET TIME_ZONE='+00:00';\n");
    await w("SET @OLD_SQL_MODE=@@SQL_MODE;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n");
    if (o.disableFkChecks) await w('SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS;\nSET FOREIGN_KEY_CHECKS=0;\n');
    if (o.disableUniqueChecks) await w('SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS;\nSET UNIQUE_CHECKS=0;\n');
    await w('\n');
    if (o.createDatabase) {
      const info = await s.rows<{ cs: string; co: string }>('SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db]);
      const cs = info[0] ? ` DEFAULT CHARACTER SET ${info[0].cs} COLLATE ${info[0].co}` : '';
      await w(`CREATE DATABASE IF NOT EXISTS ${quoteId(db)}${cs};\nUSE ${quoteId(db)};\n\n`);
    }
    const stripDef = (x: string) => (o.stripDefiner ? x.replace(DEFINER_RE, '') : x);
    const totalObjects = sel.tables.length + sel.views.length + sel.functions.length + sel.procedures.length + sel.triggers.length + sel.events.length || 1;
    const estimates = new Map<string, number>();
    if (!o.structureOnly && sel.tables.length) {
      for (const r of await s.rows<{ n: string; r: string | null }>('SELECT TABLE_NAME AS n, TABLE_ROWS AS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [db])) {
        estimates.set(String(r.n), Number(r.r ?? 0));
      }
    }
    const step = (label: string, frac = 0) => t.progress(Math.min(0.999, (objectsDone + frac) / totalObjects), label);

    // tables
    const maxBytes = Math.max(16 * 1024, (o.maxInsertKB || 1024) * 1024);
    const maxRows = o.extendedInsert ? Math.max(1, o.maxRowsPerInsert || 1000) : 1;
    for (const table of sel.tables) {
      t.throwIfCancelled();
      step(table);
      let create = await ddl(s, db, 'table', table);
      if (!o.autoIncrement) create = create.replace(/\s+AUTO_INCREMENT=\d+/, '');
      await w(`--\n-- ${tr('Tabellenstruktur für {t}', 'Table structure for {t}', { t: table })}\n--\n\n`);
      if (o.dropStatements) await w(`DROP TABLE IF EXISTS ${quoteId(table)};\n`);
      await w(`${create};\n\n`);
      if (!o.structureOnly) {
        const cols = (await loadColumns(s, db, table)).filter((c) => !c.generationExpression && !/(VIRTUAL|STORED) GENERATED/i.test(c.extra));
        if (!cols.length) continue;
        const colList = cols.map((c) => quoteId(c.name)).join(', ');
        const head = o.completeInsert || cols.length !== (await loadColumns(s, db, table)).length ? `INSERT INTO ${quoteId(table)} (${colList}) VALUES ` : `INSERT INTO ${quoteId(table)} VALUES `;
        const est = estimates.get(table) ?? 0;
        let rows = 0;
        let started = false;
        let pending: string[] = [];
        let pendingLen = 0;
        const flush = async () => {
          if (!pending.length) return;
          const sql = o.extendedInsert ? `${head}\n${pending.join(',\n')};\n` : pending.map((x) => `${head}${x};\n`).join('');
          pending = [];
          pendingLen = 0;
          await w(sql);
        };
        for await (const batch of streamRows(s, `SELECT ${colList} FROM ${qname(db, table)}`, () => undefined)) {
          t.throwIfCancelled();
          if (!started) {
            started = true;
            await w(`--\n-- ${tr('Daten für {t}', 'Data for {t}', { t: table })}\n--\n\n`);
            if (o.addLocks) await w(`LOCK TABLES ${quoteId(table)} WRITE;\n/*!40000 ALTER TABLE ${quoteId(table)} DISABLE KEYS */;\n`);
          }
          for (const r of batch) {
            const tuple = `(${r.map((v, i) => valueSql(v, cols[i], o)).join(',')})`;
            if (pending.length && (pending.length >= maxRows || pendingLen + tuple.length > maxBytes)) await flush();
            pending.push(tuple);
            pendingLen += tuple.length + 2;
          }
          rows += batch.length;
          step(tr('{t}: {n} Datensätze', '{t}: {n} records', { t: table, n: formatNumber(rows) }), est ? Math.min(0.99, rows / est) : 0.5);
        }
        await flush();
        if (started) {
          if (o.addLocks) await w(`/*!40000 ALTER TABLE ${quoteId(table)} ENABLE KEYS */;\nUNLOCK TABLES;\n`);
          await w('\n');
        }
        totalRows += rows;
        t.log('info', tr('Tabelle {t}: {n} Datensätze', 'Table {t}: {n} records', { t: table, n: formatNumber(rows) }));
      } else t.log('info', tr('Tabelle {t}', 'Table {t}', { t: table }));
      objectsDone++;
    }

    const block = async (title: string, name: string, drop: string, createSql: string, sqlMode: string | null) => {
      await w(`--\n-- ${title}\n--\n\n`);
      if (o.dropStatements) await w(`${drop};\n`);
      if (sqlMode !== null) await w(`SET @saved_sql_mode = @@sql_mode;\nSET sql_mode = ${quoteString(sqlMode)};\n`);
      await w(`DELIMITER ;;\n${stripDef(createSql)} ;;\nDELIMITER ;\n`);
      if (sqlMode !== null) await w('SET sql_mode = @saved_sql_mode;\n');
      await w('\n');
      void name;
    };
    // triggers (after the table data, so that loading the data does not fire them)
    for (const name of sel.triggers) {
      t.throwIfCancelled();
      step(name);
      const d = defOf('TRIGGER', name);
      await block(tr('Trigger {n}', 'Trigger {n}', { n: name }), name, `DROP TRIGGER IF EXISTS ${quoteId(name)}`, d.def, d.mode);
      objectsDone++;
    }

    // views in dependency order
    const viewDefs = new Map<string, string>();
    for (const name of sel.views) viewDefs.set(name, defOf('VIEW', name).def);
    for (const name of orderViews(viewDefs)) {
      t.throwIfCancelled();
      step(name);
      await w(`--\n-- ${tr('Ansicht {n}', 'View {n}', { n: name })}\n--\n\n`);
      if (o.dropStatements) await w(`DROP TABLE IF EXISTS ${quoteId(name)};\nDROP VIEW IF EXISTS ${quoteId(name)};\n`);
      await w(`${stripDef(viewDefs.get(name)!)};\n\n`);
      objectsDone++;
    }

    // routines
    for (const [kind, list] of [['FUNCTION', sel.functions], ['PROCEDURE', sel.procedures]] as const) {
      for (const name of list) {
        t.throwIfCancelled();
        step(name);
        const d = defOf(kind, name);
        const title = kind === 'FUNCTION' ? tr('Funktion {n}', 'Function {n}', { n: name }) : tr('Prozedur {n}', 'Procedure {n}', { n: name });
        await block(title, name, `DROP ${kind} IF EXISTS ${quoteId(name)}`, d.def, d.mode);
        objectsDone++;
      }
    }

    // events
    for (const name of sel.events) {
      t.throwIfCancelled();
      step(name);
      const d = defOf('EVENT', name);
      await block(tr('Ereignis {n}', 'Event {n}', { n: name }), name, `DROP EVENT IF EXISTS ${quoteId(name)}`, d.def, d.mode);
      objectsDone++;
    }

    await w('\n');
    if (o.disableUniqueChecks) await w('SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;\n');
    if (o.disableFkChecks) await w('SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;\n');
    await w('SET SQL_MODE=@OLD_SQL_MODE;\nSET TIME_ZONE=@OLD_TIME_ZONE;\n\n-- ' + tr('Ende der Ausgabe', 'Dump completed') + '\n');
    await out.close();
    const bytes = out.bytes;
    out = null;
    t.log(
      'success',
      tr('SQL-Datei erstellt: {f} ({b}, {o} Objekte, {r} Datensätze)', 'SQL file written: {f} ({b}, {o} objects, {r} records)', {
        f: p.file,
        b: formatBytes(bytes),
        o: objectsDone,
        r: formatNumber(totalRows)
      })
    );
    return { file: p.file, bytes, tables: sel.tables.length, rows: totalRows, objects: objectsDone };
  } catch (e) {
    if (out) await out.abort();
    throw e;
  } finally {
    if (o.consistency === 'lock') await s.exec('UNLOCK TABLES').catch(() => undefined);
    else if (o.consistency === 'snapshot') await s.exec('COMMIT').catch(() => undefined);
    await ctx.sessions.close(s.id);
  }
}

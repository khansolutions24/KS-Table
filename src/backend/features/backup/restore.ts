// Restoring a backup archive into a database.
// Order: drop → tables → data → functions/procedures → views (dependency order) → triggers → events.
// Triggers are created after the data so that inserting the saved records does not fire them.

import type { BackupObjectType, ManifestObject, RestoreOptions, RestoreResult } from '@shared/apis/backup';
import { tr } from '@shared/i18n';
import { quoteId, quoteString } from '@shared/sql/quote';
import { backupTypeLabel, objectKey } from '@shared/backup/options';
import { formatNumber } from '@shared/util';
import type { BackendContext } from '../../api';
import { KsError } from '../../errors';
import type { Session } from '../../db/sessions';
import { CancelledError, type TaskContext } from '../../tasks';
import { DROP_KW, errorText, isDefinerError, isDependencyError, openArchive, stripDefiner, type BackupArchive } from './common';

const BASE_SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';
const NAME_RE = /^[A-Za-z0-9_]+$/;

type Row = Record<string, unknown>;
const low = (v: unknown): string => String(v ?? '').toLowerCase();

export async function runRestore(
  ctx: BackendContext,
  connectionId: string,
  file: string,
  options: RestoreOptions,
  t: TaskContext
): Promise<RestoreResult> {
  const arc = await openArchive(file);
  let s: Session | null = null;
  try {
    s = await ctx.sessions.open(connectionId, null);
    return await new Restorer(s, arc, options, t).run();
  } finally {
    if (s) await ctx.sessions.close(s.id);
    arc.close();
  }
}

class Restorer {
  private readonly stats = { objects: 0, rows: 0, errors: 0, warnings: 0 };
  private readonly existing: Record<BackupObjectType, Set<string>> = {
    table: new Set(),
    view: new Set(),
    function: new Set(),
    procedure: new Set(),
    trigger: new Set(),
    event: new Set()
  };
  /** existing trigger → its table (dropping a table drops its triggers) */
  private readonly triggerTable = new Map<string, string>();
  /** tables created by this restore */
  private readonly created = new Set<string>();
  private origCollation = '';
  private unitsDone = 0;
  private unitsTotal = 1;

  constructor(
    private readonly s: Session,
    private readonly arc: BackupArchive,
    private readonly o: RestoreOptions,
    private readonly t: TaskContext
  ) {}

  async run(): Promise<RestoreResult> {
    const { o, t } = this;
    const m = this.arc.manifest;
    const db = o.targetDatabase.trim() || m.database;
    if (!o.structure && !o.data) throw new KsError(tr('Weder Struktur noch Daten ausgewählt.', 'Neither structure nor data selected.'));
    const wanted = o.objects ? new Set(o.objects.map((x) => objectKey(x))) : null;
    const objs = m.objects.filter((x) => !wanted || wanted.has(objectKey(x)));
    if (!objs.length) throw new KsError(tr('Es wurden keine Objekte zum Wiederherstellen ausgewählt.', 'No objects were selected for restoring.'));
    t.log('info', tr('Wiederherstellung in die Datenbank „{db}“: {n} Objekte', 'Restoring into database "{db}": {n} objects', { db, n: objs.length }));
    t.progress(null);

    await this.ensureDatabase(db, m.charset, m.collation);
    await this.s.useDatabase(db);
    this.origCollation = String((await this.s.rows<Row>('SELECT @@SESSION.collation_connection AS c'))[0]?.c ?? '');
    await this.s.exec(`SET SESSION sql_mode = '${BASE_SQL_MODE}'`);
    await this.s.exec("SET time_zone = '+00:00'");
    if (o.disableForeignKeys) await this.s.exec('SET FOREIGN_KEY_CHECKS = 0');
    await this.loadExisting(db);

    const of = (type: BackupObjectType) => objs.filter((x) => x.type === type);
    const tables = of('table');
    const dataRows = o.data ? tables.reduce((a, x) => a + (x.dataFiles.length ? (x.rows ?? 0) : 0), 0) : 0;
    this.unitsTotal = Math.max(1, (o.structure ? objs.length : 0) + dataRows / 1000);
    try {
      if (o.structure && o.dropExisting) await this.dropPhase(objs);
      if (o.structure) for (const x of tables) await this.create(x);
      if (o.data) await this.dataPhase(tables);
      if (o.structure) {
        for (const x of [...of('function'), ...of('procedure')]) await this.create(x);
        await this.createViews(of('view'));
        for (const x of of('trigger')) await this.create(x);
        for (const x of of('event')) await this.create(x);
      }
    } finally {
      if (o.disableForeignKeys) await this.s.exec('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined);
    }
    const p = { o: this.stats.objects, r: formatNumber(this.stats.rows), e: this.stats.errors };
    if (this.stats.errors) {
      t.log('warn', tr('Wiederherstellung mit {e} Fehlern beendet: {o} Objekte erstellt, {r} Datensätze eingefügt', 'Restore finished with {e} errors: {o} objects created, {r} records inserted', p));
    } else {
      t.log('success', tr('Wiederherstellung abgeschlossen: {o} Objekte erstellt, {r} Datensätze eingefügt', 'Restore finished: {o} objects created, {r} records inserted', p));
    }
    return { database: db, ...this.stats };
  }

  private label(x: { type: BackupObjectType; name: string }): string {
    return tr('{t} „{n}“', '{t} "{n}"', { t: backupTypeLabel(x.type), n: x.name });
  }

  private tick(units: number, message?: string): void {
    this.unitsDone += units;
    this.t.progress(Math.min(0.999, this.unitsDone / this.unitsTotal), message);
  }

  private warn(message: string): void {
    this.stats.warnings++;
    this.t.log('warn', message);
  }

  private fail(what: string, e: unknown, fatal = false): void {
    if (e instanceof CancelledError || this.t.signal.aborted) throw e;
    this.stats.errors++;
    const msg = errorText(e);
    this.t.log('error', `${what}: ${msg}`);
    if (fatal || !this.o.continueOnError) throw new KsError(tr('Wiederherstellung abgebrochen: {m}', 'Restore aborted: {m}', { m: msg }));
  }

  private async attempt(what: string, fn: () => Promise<void>, fatal = false): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      this.fail(what, e, fatal);
      return false;
    }
  }

  private async ensureDatabase(db: string, charset: string, collation: string): Promise<void> {
    const rows = await this.s.rows<Row>('SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db]);
    if (rows.length) return;
    if (!this.o.createDatabase) throw new KsError(tr('Die Zieldatenbank „{db}“ existiert nicht.', 'Target database "{db}" does not exist.', { db }));
    const variants = [
      NAME_RE.test(charset) && NAME_RE.test(collation) ? ` CHARACTER SET ${charset} COLLATE ${collation}` : null,
      NAME_RE.test(charset) ? ` CHARACTER SET ${charset}` : null,
      ''
    ].filter((v): v is string => v !== null);
    let last: unknown = null;
    for (const v of variants) {
      try {
        await this.s.exec(`CREATE DATABASE ${quoteId(db)}${v}`);
        this.t.log('success', tr('Datenbank „{db}“ erstellt', 'Database "{db}" created', { db }));
        return;
      } catch (e) {
        last = e;
        // unknown character set / collation on this server → try without
        if (![1115, 1273, 1253].includes(Number((e as { errno?: number }).errno))) break;
      }
    }
    throw last;
  }

  private async loadExisting(db: string): Promise<void> {
    for (const r of await this.s.rows<Row>('SELECT TABLE_NAME AS n, TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [db])) {
      (String(r.t) === 'VIEW' ? this.existing.view : this.existing.table).add(low(r.n));
    }
    for (const r of await this.s.rows<Row>('SELECT ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [db])) {
      (String(r.t) === 'FUNCTION' ? this.existing.function : this.existing.procedure).add(low(r.n));
    }
    for (const r of await this.s.rows<Row>('SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', [db])) {
      this.existing.trigger.add(low(r.n));
      this.triggerTable.set(low(r.n), low(r.t));
    }
    for (const r of await this.s.rows<Row>('SELECT EVENT_NAME AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?', [db])) {
      this.existing.event.add(low(r.n));
    }
  }

  private exists(x: ManifestObject): boolean {
    const n = low(x.name);
    if (x.type === 'table' || x.type === 'view') return this.existing.table.has(n) || this.existing.view.has(n);
    return this.existing[x.type].has(n);
  }

  private async dropPhase(objs: ManifestObject[]): Promise<void> {
    const order: BackupObjectType[] = ['trigger', 'event', 'view', 'procedure', 'function', 'table'];
    for (const type of order) {
      for (const x of objs.filter((y) => y.type === type)) {
        this.t.throwIfCancelled();
        const n = low(x.name);
        let sql = '';
        let kind: BackupObjectType = type;
        if (type === 'table' || type === 'view') {
          if (this.existing.view.has(n)) kind = 'view';
          else if (this.existing.table.has(n)) kind = 'table';
          else continue;
          sql = `DROP ${DROP_KW[kind]} IF EXISTS ${quoteId(x.name)}`;
        } else if (this.existing[type].has(n)) {
          sql = `DROP ${DROP_KW[type]} IF EXISTS ${quoteId(x.name)}`;
        } else continue;
        const ok = await this.attempt(tr('Löschen von {o}', 'Dropping {o}', { o: this.label({ type: kind, name: x.name }) }), async () => {
          await this.s.exec(sql);
        });
        if (!ok) continue;
        this.existing[kind].delete(n);
        if (kind === 'table') {
          for (const [trg, tbl] of this.triggerTable) if (tbl === n) this.existing.trigger.delete(trg);
        }
      }
    }
    this.t.log('info', tr('Vorhandene Objekte gelöscht', 'Existing objects dropped'));
  }

  private async applySettings(x: ManifestObject): Promise<void> {
    if (x.sqlMode !== undefined) {
      await this.s.exec(`SET SESSION sql_mode = ${quoteString(x.sqlMode)}`).catch(() =>
        this.warn(tr('Der SQL-Modus von {o} wird von diesem Server nicht unterstützt.', 'The SQL mode of {o} is not supported by this server.', { o: this.label(x) }))
      );
    }
    if (x.collationConnection && x.collationConnection !== this.origCollation) {
      await this.s.exec(`SET SESSION collation_connection = ${quoteString(x.collationConnection)}`).catch(() => undefined);
    }
    if (x.type === 'event' && x.timeZone) await this.s.exec(`SET time_zone = ${quoteString(x.timeZone)}`).catch(() => undefined);
  }

  private async resetSettings(x: ManifestObject): Promise<void> {
    await this.s.exec(`SET SESSION sql_mode = '${BASE_SQL_MODE}'`);
    if (x.collationConnection && x.collationConnection !== this.origCollation && this.origCollation) {
      await this.s.exec(`SET SESSION collation_connection = ${quoteString(this.origCollation)}`).catch(() => undefined);
    }
    if (x.type === 'event' && x.timeZone) await this.s.exec("SET time_zone = '+00:00'");
  }

  /** Executes the CREATE statement; throws on error. */
  private async createObject(x: ManifestObject): Promise<void> {
    if (this.exists(x)) {
      this.warn(tr('{o} existiert bereits und wird nicht neu erstellt.', '{o} already exists and is not recreated.', { o: this.label(x) }));
      return;
    }
    if (!x.ddlFile) {
      this.warn(tr('Die Sicherung enthält keine Struktur für {o}.', 'The backup contains no structure for {o}.', { o: this.label(x) }));
      return;
    }
    let ddl = await this.arc.text(x.ddlFile);
    if (!this.o.keepDefiner) ddl = stripDefiner(ddl);
    const settings = x.type !== 'table';
    if (settings) await this.applySettings(x);
    try {
      try {
        await this.s.exec(ddl);
      } catch (e) {
        const plain = stripDefiner(ddl);
        if (!isDefinerError(e) || plain === ddl) throw e;
        this.warn(
          tr(
            'Der DEFINER von {o} wurde vom Server abgelehnt – das Objekt wird mit dem aktuellen Benutzer erstellt.',
            'The server refused the DEFINER of {o} – the object is created with the current user.',
            { o: this.label(x) }
          )
        );
        await this.s.exec(plain);
      }
    } finally {
      if (settings) await this.resetSettings(x);
    }
    this.stats.objects++;
    const n = low(x.name);
    this.existing[x.type].add(n);
    if (x.type === 'table') this.created.add(n);
    this.t.log('info', tr('{o} erstellt', '{o} created', { o: this.label(x) }));
  }

  private async create(x: ManifestObject): Promise<void> {
    this.t.throwIfCancelled();
    await this.attempt(tr('Erstellen von {o}', 'Creating {o}', { o: this.label(x) }), () => this.createObject(x));
    this.tick(1, x.name);
  }

  /** Views may read from other views: creation is retried until no further view can be created. */
  private async createViews(views: ManifestObject[]): Promise<void> {
    let pending = views;
    while (pending.length) {
      const retry: { x: ManifestObject; e: unknown }[] = [];
      for (const x of pending) {
        this.t.throwIfCancelled();
        try {
          await this.createObject(x);
          this.tick(1, x.name);
        } catch (e) {
          if (isDependencyError(e)) retry.push({ x, e });
          else {
            this.fail(tr('Erstellen von {o}', 'Creating {o}', { o: this.label(x) }), e);
            this.tick(1, x.name);
          }
        }
      }
      if (retry.length === pending.length) {
        for (const r of retry) {
          this.fail(tr('Erstellen von {o}', 'Creating {o}', { o: this.label(r.x) }), r.e);
          this.tick(1, r.x.name);
        }
        return;
      }
      pending = retry.map((r) => r.x);
    }
  }

  private async dataPhase(tables: ManifestObject[]): Promise<void> {
    const { o, t } = this;
    const withData = tables.filter((x) => x.dataFiles.length);
    if (!withData.length) return;
    if (o.transaction) await this.s.exec('START TRANSACTION');
    let committed = !o.transaction;
    try {
      for (const x of withData) {
        t.throwIfCancelled();
        const n = low(x.name);
        if (!this.existing.table.has(n)) {
          this.fail(tr('Daten für „{n}“', 'Data for "{n}"', { n: x.name }), new KsError(tr('Die Tabelle existiert nicht.', 'The table does not exist.')), o.transaction);
          this.tick((x.rows ?? 0) / 1000);
          continue;
        }
        if (o.emptyTables && !this.created.has(n)) {
          const ok = await this.attempt(tr('Leeren von „{n}“', 'Emptying "{n}"', { n: x.name }), async () => {
            await this.s.exec(`DELETE FROM ${quoteId(x.name)}`);
          }, o.transaction);
          if (!ok) continue;
        }
        t.log('info', tr('Füge {r} Datensätze in „{n}“ ein …', 'Inserting {r} records into "{n}" …', { r: formatNumber(x.rows ?? 0), n: x.name }));
        let inserted = 0;
        for (const f of x.dataFiles) {
          for await (const line of this.arc.lines(f)) {
            if (!line.trim()) continue;
            t.throwIfCancelled();
            let affected = 0;
            await this.attempt(tr('Daten für „{n}“', 'Data for "{n}"', { n: x.name }), async () => {
              affected = (await this.s.exec(line)).affectedRows;
            }, o.transaction);
            inserted += affected;
            this.stats.rows += affected;
            this.tick(affected / 1000, `${x.name}: ${formatNumber(inserted)}`);
          }
        }
      }
      if (o.transaction) {
        await this.s.exec('COMMIT');
        committed = true;
      }
    } finally {
      if (!committed) {
        await this.s.exec('ROLLBACK').catch(() => undefined);
        t.log('warn', tr('Die eingefügten Datensätze wurden zurückgerollt.', 'The inserted records were rolled back.'));
      }
    }
  }
}

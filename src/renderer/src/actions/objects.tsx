// Actions on database objects (tables, views, routines, events, saved queries, backups).

import { tr } from '@shared/i18n';
import { qname, quoteId } from '@shared/sql/quote';
import { uniqueName } from '@shared/util';
import type { StatementResult } from '@shared/types';
import { api } from '../api/client';
import { alertDialog, confirmDialog, Dialog, errorDialog, openDialog, promptDialog } from '../components/ui/Dialog';
import { Button } from '../components/ui/controls';
import { toast } from '../components/Toast';
import { dirName, joinPath } from '../lib/files';
import { useTabs } from '../store/tabs';
import { getProfile, metaSession, useWorkspace, type DbList } from '../store/workspace';
import { runSql } from './sql';

export type ObjType = 'table' | 'view' | 'function' | 'procedure' | 'event' | 'query' | 'backup';

export interface ObjRef {
  type: ObjType;
  name: string;
  /** file path for saved queries / backups */
  path?: string;
}

export function typeLabel(type: ObjType, plural = false): string {
  switch (type) {
    case 'table':
      return plural ? tr('Tabellen', 'tables') : tr('Tabelle', 'table');
    case 'view':
      return plural ? tr('Ansichten', 'views') : tr('Ansicht', 'view');
    case 'function':
      return plural ? tr('Funktionen', 'functions') : tr('Funktion', 'function');
    case 'procedure':
      return plural ? tr('Prozeduren', 'procedures') : tr('Prozedur', 'procedure');
    case 'event':
      return plural ? tr('Ereignisse', 'events') : tr('Ereignis', 'event');
    case 'query':
      return plural ? tr('Abfragen', 'queries') : tr('Abfrage', 'query');
    default:
      return plural ? tr('Sicherungen', 'backups') : tr('Sicherung', 'backup');
  }
}

export function listOf(type: ObjType): DbList {
  if (type === 'table') return 'tables';
  if (type === 'view') return 'views';
  if (type === 'function' || type === 'procedure') return 'routines';
  if (type === 'event') return 'events';
  if (type === 'query') return 'queries';
  return 'backups';
}

export function refreshObjects(connectionId: string, database: string, types?: ObjType[]): Promise<void> {
  const lists = types ? [...new Set(types.map(listOf))] : undefined;
  return useWorkspace.getState().refreshDatabase(connectionId, database, lists);
}

function sub(connectionId: string, database: string) {
  const p = getProfile(connectionId);
  return `${p?.name ?? ''} / ${database}`;
}

export function openTable(connectionId: string, database: string, table: string, view = false): void {
  useTabs.getState().open({
    kind: 'tableData',
    key: `data:${connectionId}:${database}:${table}`,
    title: `${table} @${database}`,
    icon: view ? 'view' : 'table',
    params: { connectionId, database, table, view },
    connectionId,
    subtitle: sub(connectionId, database)
  });
}

export function designTable(connectionId: string, database: string, table?: string | null): void {
  useTabs.getState().open({
    kind: 'tableDesign',
    key: table ? `design:${connectionId}:${database}:${table}` : undefined,
    title: table ? `${table} @${database} (${tr('Entwurf', 'Design')})` : `${tr('Unbenannt', 'Untitled')} @${database} (${tr('Tabelle', 'Table')})`,
    icon: 'table',
    params: { connectionId, database, table: table ?? null },
    connectionId,
    subtitle: sub(connectionId, database)
  });
}

export function designView(connectionId: string, database: string, view?: string | null): void {
  useTabs.getState().open({
    kind: 'viewDesign',
    key: view ? `viewdesign:${connectionId}:${database}:${view}` : undefined,
    title: view ? `${view} @${database} (${tr('Ansicht', 'View')})` : `${tr('Unbenannt', 'Untitled')} @${database} (${tr('Ansicht', 'View')})`,
    icon: 'view',
    params: { connectionId, database, view: view ?? null },
    connectionId,
    subtitle: sub(connectionId, database)
  });
}

export function designRoutine(connectionId: string, database: string, name: string | null, routineType: 'FUNCTION' | 'PROCEDURE'): void {
  useTabs.getState().open({
    kind: 'routineDesign',
    key: name ? `routine:${connectionId}:${database}:${routineType}:${name}` : undefined,
    title: name ? `${name} @${database}` : `${tr('Unbenannt', 'Untitled')} @${database} (${routineType === 'FUNCTION' ? tr('Funktion', 'Function') : tr('Prozedur', 'Procedure')})`,
    icon: routineType === 'FUNCTION' ? 'function' : 'procedure',
    params: { connectionId, database, name, routineType },
    connectionId,
    subtitle: sub(connectionId, database)
  });
}

export function designEvent(connectionId: string, database: string, name?: string | null): void {
  useTabs.getState().open({
    kind: 'eventDesign',
    key: name ? `event:${connectionId}:${database}:${name}` : undefined,
    title: name ? `${name} @${database}` : `${tr('Unbenannt', 'Untitled')} @${database} (${tr('Ereignis', 'Event')})`,
    icon: 'event',
    params: { connectionId, database, name: name ?? null },
    connectionId,
    subtitle: sub(connectionId, database)
  });
}

const DROP_KW: Partial<Record<ObjType, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  event: 'EVENT'
};

function tabKeysFor(connectionId: string, database: string, o: ObjRef): string[] {
  if (o.type === 'table') return [`data:${connectionId}:${database}:${o.name}`, `design:${connectionId}:${database}:${o.name}`];
  if (o.type === 'view') return [`data:${connectionId}:${database}:${o.name}`, `viewdesign:${connectionId}:${database}:${o.name}`];
  if (o.type === 'function') return [`routine:${connectionId}:${database}:FUNCTION:${o.name}`];
  if (o.type === 'procedure') return [`routine:${connectionId}:${database}:PROCEDURE:${o.name}`];
  if (o.type === 'event') return [`event:${connectionId}:${database}:${o.name}`];
  if (o.type === 'query' && o.path) return [`query:${o.path.toLowerCase()}`];
  return [];
}

async function closeTabsFor(connectionId: string, database: string, objs: ObjRef[]): Promise<boolean> {
  const keys = new Set(objs.flatMap((o) => tabKeysFor(connectionId, database, o)));
  const ids = useTabs.getState().tabs.filter((t) => t.key && keys.has(t.key)).map((t) => t.id);
  return useTabs.getState().closeMany(ids);
}

export async function dropObjects(connectionId: string, database: string, objs: ObjRef[]): Promise<void> {
  if (!objs.length) return;
  const first = objs[0];
  const ok = await confirmDialog({
    title: tr('Löschen', 'Delete'),
    message:
      objs.length === 1
        ? tr('Soll {t} „{n}“ wirklich gelöscht werden?', 'Do you really want to delete {t} "{n}"?', { t: typeLabel(first.type), n: first.name })
        : tr('Sollen {c} Objekte wirklich gelöscht werden?\n\n{list}', 'Do you really want to delete {c} objects?\n\n{list}', {
            c: objs.length,
            list: objs.slice(0, 12).map((o) => `• ${o.name}`).join('\n') + (objs.length > 12 ? '\n…' : '')
          }),
    okLabel: tr('Löschen', 'Delete'),
    danger: true
  });
  if (!ok) return;
  if (!(await closeTabsFor(connectionId, database, objs))) return;
  const tables = objs.filter((o) => o.type === 'table');
  try {
    if (tables.length) await runSql(connectionId, `DROP TABLE ${tables.map((t) => qname(database, t.name)).join(', ')}`);
    for (const o of objs) {
      if (o.type === 'table') continue;
      if (o.type === 'query' || o.type === 'backup') {
        if (o.path) await api.fs.remove(o.path);
      } else {
        await runSql(connectionId, `DROP ${DROP_KW[o.type]} ${qname(database, o.name)}`);
      }
    }
  } catch (e) {
    void errorDialog(e);
  }
  await refreshObjects(connectionId, database, [...new Set(objs.map((o) => o.type))]);
}

export async function emptyTables(connectionId: string, database: string, names: string[], truncate: boolean): Promise<void> {
  const ok = await confirmDialog({
    title: truncate ? tr('Tabelle kürzen', 'Truncate table') : tr('Tabelle leeren', 'Empty table'),
    message: truncate
      ? tr('Alle Datensätze aus {n} entfernen und den Auto-Increment-Zähler zurücksetzen (TRUNCATE)?', 'Remove all records from {n} and reset the auto increment counter (TRUNCATE)?', { n: names.map((x) => `„${x}“`).join(', ') })
      : tr('Alle Datensätze aus {n} löschen (DELETE)?', 'Delete all records from {n} (DELETE)?', { n: names.map((x) => `"${x}"`).join(', ') }),
    okLabel: truncate ? tr('Kürzen', 'Truncate') : tr('Leeren', 'Empty'),
    danger: true
  });
  if (!ok) return;
  try {
    for (const n of names) await runSql(connectionId, `${truncate ? 'TRUNCATE TABLE' : 'DELETE FROM'} ${qname(database, n)}`);
    toast(tr('Erledigt', 'Done'), 'success');
  } catch (e) {
    void errorDialog(e);
  }
  await refreshObjects(connectionId, database, ['table']);
}

export async function duplicateTable(connectionId: string, database: string, name: string, withData: boolean): Promise<void> {
  const tables = useWorkspace.getState().conns[connectionId]?.dbs[database]?.tables ?? [];
  const target = uniqueName(`${name}_copy`, tables.map((t) => t.name));
  try {
    await runSql(connectionId, `CREATE TABLE ${qname(database, target)} LIKE ${qname(database, name)}`);
    if (withData) {
      const cols = (await api.meta.columns(metaSession(connectionId), database, name)).filter((c) => !c.generationExpression);
      const list = cols.map((c) => quoteId(c.name)).join(', ');
      await runSql(connectionId, `INSERT INTO ${qname(database, target)} (${list}) SELECT ${list} FROM ${qname(database, name)}`);
    }
    toast(tr('Tabelle „{n}“ erstellt', 'Table "{n}" created', { n: target }), 'success');
  } catch (e) {
    void errorDialog(e);
  }
  await refreshObjects(connectionId, database, ['table']);
}

export async function renameObject(connectionId: string, database: string, obj: ObjRef): Promise<void> {
  if (obj.type === 'function' || obj.type === 'procedure') {
    await alertDialog({
      message: tr(
        'MySQL kann gespeicherte Routinen nicht umbenennen. Öffnen Sie die Routine im Designer und speichern Sie sie unter einem neuen Namen.',
        'MySQL cannot rename stored routines. Open the routine in the designer and save it under a new name.'
      )
    });
    return;
  }
  const name = await promptDialog({
    title: tr('Umbenennen', 'Rename'),
    label: tr('Neuer Name für {t} „{n}“:', 'New name for {t} "{n}":', { t: typeLabel(obj.type), n: obj.name }),
    value: obj.name,
    validate: (v) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
  });
  if (!name || name === obj.name) return;
  if (!(await closeTabsFor(connectionId, database, [obj]))) return;
  try {
    if (obj.type === 'table' || obj.type === 'view') {
      await runSql(connectionId, `RENAME TABLE ${qname(database, obj.name)} TO ${qname(database, name)}`);
    } else if (obj.type === 'event') {
      await runSql(connectionId, `ALTER EVENT ${qname(database, obj.name)} RENAME TO ${qname(database, name)}`);
    } else if (obj.path) {
      const ext = obj.path.slice(obj.path.lastIndexOf('.'));
      await api.fs.rename(obj.path, joinPath(dirName(obj.path), `${name}${ext}`));
    }
  } catch (e) {
    void errorDialog(e);
  }
  await refreshObjects(connectionId, database, [obj.type]);
}

export type MaintenanceOp = 'ANALYZE' | 'CHECK' | 'OPTIMIZE' | 'REPAIR' | 'CHECKSUM';

export async function maintainTables(connectionId: string, database: string, names: string[], op: MaintenanceOp, option = ''): Promise<void> {
  const sql = `${op} TABLE ${names.map((n) => qname(database, n)).join(', ')}${option ? ` ${option}` : ''}`;
  try {
    const res = await runSql(connectionId, sql);
    const rs = res.results.find((r) => r.kind === 'resultset');
    await showResultTable(tr('Wartung – {op}', 'Maintenance – {op}', { op }), rs);
  } catch (e) {
    void errorDialog(e);
  }
}

function showResultTable(title: string, rs: StatementResult | undefined): Promise<void> {
  return openDialog<void>((close) => (
    <Dialog title={title} width={760} onClose={() => close()} onSubmit={() => close()} footer={<Button type="submit" variant="primary">OK</Button>} noPadding>
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        <table className="ks-table">
          <thead>
            <tr>{rs?.columns?.map((c, i) => <th key={i}>{c.name}</th>)}</tr>
          </thead>
          <tbody>
            {rs?.rows?.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className="selectable">
                    {v === null ? <span className="faint">NULL</span> : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  )).then(() => undefined);
}

export function copyNames(names: string[]): void {
  void navigator.clipboard.writeText(names.join('\n'));
  toast(names.length === 1 ? tr('Name kopiert', 'Name copied') : tr('{n} Namen kopiert', '{n} names copied', { n: names.length }));
}

export async function executeRoutine(connectionId: string, database: string, name: string, routineType: 'FUNCTION' | 'PROCEDURE'): Promise<void> {
  // parameters are asked for by the query tab ("Parameter" prompt) – build a template call
  const { newQuery } = await import('./query');
  try {
    const rs = await api.query.execute(
      metaSession(connectionId),
      `SELECT PARAMETER_NAME, PARAMETER_MODE, DTD_IDENTIFIER FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ${`'${database.replace(/'/g, "''")}'`} AND SPECIFIC_NAME = '${name.replace(/'/g, "''")}' AND ORDINAL_POSITION > 0 ORDER BY ORDINAL_POSITION`,
      { history: false }
    );
    const rows = rs.results[0]?.rows ?? [];
    const params = rows.map((r) => ({ name: String(r[0]), mode: String(r[1] ?? 'IN'), type: String(r[2]) }));
    const args = params.map((p) => (p.mode === 'IN' || routineType === 'FUNCTION' ? `:${p.name}` : `@${p.name}`));
    const call =
      routineType === 'FUNCTION'
        ? `SELECT ${qname(database, name)}(${args.join(', ')});`
        : `CALL ${qname(database, name)}(${args.join(', ')});` +
          (params.some((p) => p.mode !== 'IN') ? `\nSELECT ${params.filter((p) => p.mode !== 'IN').map((p) => `@${p.name}`).join(', ')};` : '');
    newQuery(connectionId, database, call, `${name} – ${tr('Ausführen', 'Execute')}`);
  } catch (e) {
    void errorDialog(e);
  }
}

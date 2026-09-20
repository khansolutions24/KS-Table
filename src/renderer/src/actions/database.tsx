// Database (schema) actions.

import { tr } from '@shared/i18n';
import { quoteId } from '@shared/sql/quote';
import { confirmDialog, errorDialog, openDialog } from '../components/ui/Dialog';
import { toast } from '../components/Toast';
import { DatabaseDialog } from '../features/database/DatabaseDialog';
import { nodeKey, useNav } from '../store/nav';
import { OBJECTS_TAB, useTabs } from '../store/tabs';
import { useWorkspace } from '../store/workspace';
import { runSql } from './sql';

export async function newDatabase(connectionId: string): Promise<void> {
  if (!(await useWorkspace.getState().openConnection(connectionId))) return;
  const name = await openDialog<string>((close) => <DatabaseDialog connectionId={connectionId} onClose={close} />);
  if (!name) return;
  await useWorkspace.getState().refreshConnection(connectionId);
  useNav.getState().setExpanded(nodeKey({ kind: 'connection', connectionId }), true);
  useNav.getState().select(nodeKey({ kind: 'database', connectionId, database: name }));
}

export async function editDatabase(connectionId: string, database: string): Promise<void> {
  if (!(await useWorkspace.getState().openConnection(connectionId))) return;
  const name = await openDialog<string>((close) => (
    <DatabaseDialog connectionId={connectionId} database={database} onClose={close} />
  ));
  if (name) await useWorkspace.getState().refreshConnection(connectionId);
}

export async function dropDatabase(connectionId: string, database: string): Promise<void> {
  const ok = await confirmDialog({
    title: tr('Datenbank löschen', 'Delete database'),
    message: tr(
      'Soll die Datenbank „{n}“ mit allen Tabellen, Daten und Objekten unwiderruflich gelöscht werden?',
      'Do you really want to drop the database "{n}" with all tables, data and objects? This cannot be undone.',
      { n: database }
    ),
    okLabel: tr('Löschen', 'Delete'),
    danger: true
  });
  if (!ok) return;
  const tabIds = useTabs
    .getState()
    .tabs.filter((t) => t.connectionId === connectionId && t.params.database === database && t.id !== OBJECTS_TAB)
    .map((t) => t.id);
  if (!(await useTabs.getState().closeMany(tabIds))) return;
  try {
    await runSql(connectionId, `DROP DATABASE ${quoteId(database)}`);
  } catch (e) {
    void errorDialog(e);
    return;
  }
  useWorkspace.getState().closeDatabase(connectionId, database);
  await useWorkspace.getState().refreshConnection(connectionId);
  useNav.getState().select(nodeKey({ kind: 'connection', connectionId }));
  toast(tr('Datenbank „{n}“ gelöscht', 'Database "{n}" dropped', { n: database }), 'success');
}

export async function openDatabase(connectionId: string, database: string): Promise<boolean> {
  const ok = await useWorkspace.getState().openDatabase(connectionId, database);
  if (ok) {
    useNav.getState().setExpanded(nodeKey({ kind: 'connection', connectionId }), true);
    useNav.getState().setExpanded(nodeKey({ kind: 'database', connectionId, database }), true);
  }
  return ok;
}

export function closeDatabase(connectionId: string, database: string): void {
  useNav.getState().setExpanded(nodeKey({ kind: 'database', connectionId, database }), false);
  useWorkspace.getState().closeDatabase(connectionId, database);
}

export async function toggleDatabase(connectionId: string, database: string): Promise<void> {
  const key = nodeKey({ kind: 'database', connectionId, database });
  const st = useWorkspace.getState().conns[connectionId]?.dbs[database];
  if (!st?.loaded) {
    await openDatabase(connectionId, database);
    return;
  }
  useNav.getState().setExpanded(key, !useNav.getState().expanded[key]);
}

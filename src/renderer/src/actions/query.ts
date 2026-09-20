// Query tabs (SQL editor).

import { tr } from '@shared/i18n';
import { api } from '../api/client';
import { errorDialog } from '../components/ui/Dialog';
import { toast } from '../components/Toast';
import { baseName, pickOpenFile, stripExt } from '../lib/files';
import { currentContext } from '../store/nav';
import { useTabs } from '../store/tabs';
import { getProfile } from '../store/workspace';

let untitled = 0;

export function newQuery(connectionId?: string, database?: string | null, sql = '', title?: string): string | null {
  const ctx = currentContext();
  const cid = connectionId ?? ctx.connectionId;
  const db = database === undefined ? (ctx.database ?? null) : database;
  if (!cid) {
    toast(tr('Bitte zuerst eine Verbindung auswählen.', 'Please select a connection first.'));
    return null;
  }
  untitled++;
  const p = getProfile(cid);
  return useTabs.getState().open({
    kind: 'query',
    title: title ?? `${tr('Unbenannt', 'Untitled')}${untitled > 1 ? ` ${untitled}` : ''} – ${tr('Abfrage', 'Query')}`,
    icon: 'query',
    params: { connectionId: cid, database: db, sql, file: null },
    connectionId: cid,
    subtitle: `${p?.name ?? ''}${db ? ` / ${db}` : ''}`
  });
}

/** Saved query of a database (file in the profiles folder) */
export function openSavedQuery(connectionId: string, database: string, path: string): string {
  const p = getProfile(connectionId);
  return useTabs.getState().open({
    kind: 'query',
    key: `query:${path.toLowerCase()}`,
    title: `${stripExt(baseName(path))} @${database}`,
    icon: 'query',
    params: { connectionId, database, sql: null, file: path, saved: true },
    connectionId,
    subtitle: `${p?.name ?? ''} / ${database}`
  });
}

/** Opens an external .sql file in a new query tab */
export async function openSqlFile(): Promise<void> {
  const ctx = currentContext();
  const file = await pickOpenFile({
    title: tr('SQL-Datei öffnen', 'Open SQL file'),
    filters: [
      { name: 'SQL', extensions: ['sql'] },
      { name: tr('Alle Dateien', 'All files'), extensions: ['*'] }
    ]
  });
  if (!file) return;
  if (!ctx.connectionId) {
    toast(tr('Bitte zuerst eine Verbindung auswählen.', 'Please select a connection first.'));
    return;
  }
  try {
    const stat = await api.fs.stat(file);
    if (!stat.exists) throw new Error(tr('Datei nicht gefunden', 'File not found'));
  } catch (e) {
    void errorDialog(e);
    return;
  }
  useTabs.getState().open({
    kind: 'query',
    key: `query:${file.toLowerCase()}`,
    title: baseName(file),
    icon: 'query',
    params: { connectionId: ctx.connectionId, database: ctx.database ?? null, sql: null, file, saved: false },
    connectionId: ctx.connectionId
  });
}

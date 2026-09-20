// Entry points of tool windows. Each opens a tab whose component is registered by its feature module.

import { tr } from '@shared/i18n';
import { toast } from '../components/Toast';
import { currentContext } from '../store/nav';
import { useTabs } from '../store/tabs';
import { getProfile } from '../store/workspace';

function needConnection(connectionId?: string): string | null {
  const id = connectionId ?? currentContext().connectionId;
  if (!id) {
    toast(tr('Bitte zuerst eine Verbindung auswählen.', 'Please select a connection first.'));
    return null;
  }
  return id;
}

function openTool(kind: string, title: string, icon: string, params: Record<string, unknown>, key?: string, connectionId?: string) {
  return useTabs.getState().open({ kind, title, icon, params, key, connectionId });
}

export function openConsole(connectionId?: string): void {
  const id = needConnection(connectionId);
  if (!id) return;
  const p = getProfile(id);
  openTool('console', `${tr('Konsole', 'Console')} – ${p?.name ?? ''}`, 'console', { connectionId: id, database: currentContext().database ?? null }, undefined, id);
}

export function openServerMonitor(connectionId?: string): void {
  const id = connectionId ?? currentContext().connectionId ?? null;
  openTool('serverMonitor', tr('Serverüberwachung', 'Server Monitor'), 'monitor', { connectionId: id }, 'serverMonitor');
}

export function executeSqlFile(connectionId?: string, database?: string | null): void {
  const id = needConnection(connectionId);
  if (!id) return;
  const db = database === undefined ? (currentContext().database ?? null) : database;
  openTool('execSqlFile', tr('SQL-Datei ausführen', 'Execute SQL File'), 'query', { connectionId: id, database: db }, undefined, id);
}

export function dumpSqlFile(connectionId: string, database: string, tables: string[] | null, structureOnly: boolean): void {
  openTool(
    'dumpSql',
    tr('SQL-Datei ausgeben', 'Dump SQL File'),
    'backup',
    { connectionId, database, tables, structureOnly },
    undefined,
    connectionId
  );
}

export function openDataTransfer(connectionId?: string, database?: string | null, tables?: string[]): void {
  const ctx = currentContext();
  openTool('dataTransfer', tr('Datenübertragung', 'Data Transfer'), 'transfer', {
    connectionId: connectionId ?? ctx.connectionId ?? null,
    database: database ?? ctx.database ?? null,
    tables: tables ?? null
  });
}

export function openDataSync(connectionId?: string, database?: string | null): void {
  const ctx = currentContext();
  openTool('dataSync', tr('Datensynchronisation', 'Data Synchronization'), 'sync', {
    connectionId: connectionId ?? ctx.connectionId ?? null,
    database: database ?? ctx.database ?? null
  });
}

export function openStructSync(connectionId?: string, database?: string | null): void {
  const ctx = currentContext();
  openTool('structSync', tr('Struktursynchronisation', 'Structure Synchronization'), 'structsync', {
    connectionId: connectionId ?? ctx.connectionId ?? null,
    database: database ?? ctx.database ?? null
  });
}

export function openImportWizard(connectionId?: string, database?: string | null, table?: string | null): void {
  const ctx = currentContext();
  const id = needConnection(connectionId);
  if (!id) return;
  openTool('import', tr('Import-Assistent', 'Import Wizard'), 'import', {
    connectionId: id,
    database: database ?? ctx.database ?? null,
    table: table ?? null
  }, undefined, id);
}

export function openExportWizard(connectionId?: string, database?: string | null, tables?: string[] | null, query?: string | null): void {
  const ctx = currentContext();
  const id = needConnection(connectionId);
  if (!id) return;
  openTool('export', tr('Export-Assistent', 'Export Wizard'), 'export', {
    connectionId: id,
    database: database ?? ctx.database ?? null,
    tables: tables ?? null,
    query: query ?? null
  }, undefined, id);
}

export function openBackup(connectionId?: string, database?: string | null): void {
  const ctx = currentContext();
  const id = needConnection(connectionId);
  if (!id) return;
  openTool('backup', tr('Sicherung', 'Backup'), 'backup', { connectionId: id, database: database ?? ctx.database ?? null, mode: 'backup' }, undefined, id);
}

export function restoreBackup(connectionId: string, database: string, file: string): void {
  openTool('backup', tr('Sicherung wiederherstellen', 'Restore Backup'), 'backup', { connectionId, database, mode: 'restore', file }, undefined, connectionId);
}

export function extractBackupSql(connectionId: string, database: string, file: string): void {
  openTool('backup', tr('SQL extrahieren', 'Extract SQL'), 'backup', { connectionId, database, mode: 'extract', file }, undefined, connectionId);
}

export function openAutomation(): void {
  openTool('automation', tr('Automatisierung', 'Automation'), 'automation', {}, 'automation');
}

export function openDataGenerator(connectionId?: string, database?: string | null, tables?: string[]): void {
  const ctx = currentContext();
  const id = needConnection(connectionId);
  if (!id) return;
  openTool('dataGen', tr('Datengenerator', 'Data Generator'), 'datagen', {
    connectionId: id,
    database: database ?? ctx.database ?? null,
    tables: tables ?? null
  }, undefined, id);
}

export function findInDatabase(connectionId?: string, database?: string | null): void {
  const ctx = currentContext();
  const id = needConnection(connectionId);
  if (!id) return;
  openTool('findInDb', tr('Suche in Datenbank', 'Find in Database'), 'search', {
    connectionId: id,
    database: database ?? ctx.database ?? null
  }, undefined, id);
}

export function openHistory(): void {
  openTool('history', tr('Verlaufsprotokoll', 'History Log'), 'history', {}, 'history');
}

export function openSnippets(): void {
  openTool('snippets', tr('Code-Snippets', 'Code Snippets'), 'snippets', {}, 'snippets');
}

export function newModel(): void {
  openTool('model', tr('Neues Modell', 'New Model'), 'model', { file: null });
}

export function reverseToModel(connectionId: string, database: string): void {
  openTool('model', `${tr('Modell', 'Model')} – ${database}`, 'model', { file: null, reverse: { connectionId, database } });
}

export function openCharts(): void {
  openTool('charts', tr('Diagramme', 'Charts'), 'chart', {}, 'charts');
}

export function openOptions(): void {
  openTool('options', tr('Optionen', 'Options'), 'settings', {}, 'options');
}

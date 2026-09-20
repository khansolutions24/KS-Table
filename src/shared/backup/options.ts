// Defaults and labels of the backup feature (shared by backend and renderer).

import type { BackupObjectRef, BackupObjectType, BackupOptions, ExtractOptions, RestoreOptions } from '../apis/backup';
import { tr } from '../i18n';
import { deepMerge } from '../util';

export const BACKUP_EXT = '.ksbak';

export const BACKUP_OBJECT_TYPES: BackupObjectType[] = ['table', 'view', 'function', 'procedure', 'trigger', 'event'];

export function defaultBackupOptions(): BackupOptions {
  return {
    selection: 'all',
    objects: [],
    types: { table: true, view: true, function: true, procedure: true, trigger: true, event: true },
    structure: true,
    data: true,
    compression: 6,
    consistency: 'snapshot',
    comment: '',
    fileName: ''
  };
}

/** Fills missing fields of stored options (older profiles, hand-edited files). */
export function normalizeBackupOptions(o: Partial<BackupOptions> | null | undefined): BackupOptions {
  const merged = deepMerge(defaultBackupOptions(), o ?? {});
  merged.objects = Array.isArray(merged.objects) ? merged.objects.filter((x) => x && typeof x.name === 'string') : [];
  merged.compression = Math.max(0, Math.min(9, Math.round(Number(merged.compression) || 0)));
  if (!['none', 'lock', 'snapshot'].includes(merged.consistency)) merged.consistency = 'snapshot';
  if (merged.selection !== 'custom') merged.selection = 'all';
  return merged;
}

export function defaultRestoreOptions(targetDatabase: string): RestoreOptions {
  return {
    targetDatabase,
    createDatabase: false,
    objects: null,
    structure: true,
    data: true,
    dropExisting: true,
    emptyTables: false,
    transaction: false,
    continueOnError: false,
    disableForeignKeys: true,
    keepDefiner: true
  };
}

export function defaultExtractOptions(databaseName: string): ExtractOptions {
  return {
    objects: null,
    structure: true,
    data: true,
    dropStatements: true,
    createDatabase: false,
    databaseName,
    keepDefiner: true
  };
}

/** Default backup file name: local time stamp YYYYMMDDhhmmss */
export function backupTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function objectKey(o: BackupObjectRef): string {
  return `${o.type}:${o.name}`;
}

export function backupTypeLabel(type: BackupObjectType, plural = false): string {
  switch (type) {
    case 'table':
      return plural ? tr('Tabellen', 'Tables') : tr('Tabelle', 'Table');
    case 'view':
      return plural ? tr('Ansichten', 'Views') : tr('Ansicht', 'View');
    case 'function':
      return plural ? tr('Funktionen', 'Functions') : tr('Funktion', 'Function');
    case 'procedure':
      return plural ? tr('Prozeduren', 'Procedures') : tr('Prozedur', 'Procedure');
    case 'trigger':
      return plural ? tr('Trigger', 'Triggers') : tr('Trigger', 'Trigger');
    default:
      return plural ? tr('Ereignisse', 'Events') : tr('Ereignis', 'Event');
  }
}

export function consistencyLabel(c: BackupOptions['consistency']): string {
  if (c === 'lock') return tr('Tabellen sperren (LOCK TABLES)', 'Lock tables (LOCK TABLES)');
  if (c === 'snapshot') return tr('Konsistenter Snapshot (eine Transaktion, InnoDB)', 'Consistent snapshot (one transaction, InnoDB)');
  return tr('Keine Sperre', 'No locking');
}

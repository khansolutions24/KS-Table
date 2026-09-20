// Backup / restore / extract SQL (namespace api.backup) and the "backup" profile runner for automation.

import path from 'node:path';
import type { BackupApi, BackupProfile } from '@shared/apis/backup';
import { tr } from '@shared/i18n';
import { normalizeBackupOptions } from '@shared/backup/options';
import type { BackendContext } from '../api';
import { KsError } from '../errors';
import { registerProfileRunner } from '../profileRunners';
import { backupFolder, backupInfo } from './backup/common';
import { runBackup } from './backup/create';
import { runExtract } from './backup/extract';
import { runRestore } from './backup/restore';

export { runBackup };

export function normalizeBackupProfile(p: unknown): BackupProfile {
  const x = (p ?? {}) as Partial<BackupProfile>;
  if (!x.connectionId || !x.database) {
    throw new KsError(
      tr('Das Sicherungsprofil ist unvollständig (Verbindung oder Datenbank fehlt).', 'The backup profile is incomplete (connection or database missing).')
    );
  }
  return { connectionId: String(x.connectionId), database: String(x.database), options: normalizeBackupOptions(x.options) };
}

registerProfileRunner('backup', (ctx, profile, task) => runBackup(ctx, normalizeBackupProfile(profile), task));

export function createBackupApi(ctx: BackendContext): BackupApi {
  return {
    folder: async (connectionId, database) => backupFolder(connectionId, database),
    info: (file) => backupInfo(file),
    start: async (connectionId, database, options) =>
      ctx.tasks.start('backup', tr('Sicherung – {db}', 'Backup – {db}', { db: database }), (t) =>
        runBackup(ctx, { connectionId, database, options: normalizeBackupOptions(options) }, t)
      ),
    restore: async (connectionId, file, options) =>
      ctx.tasks.start('restore', tr('Wiederherstellung – {f}', 'Restore – {f}', { f: path.basename(file) }), (t) =>
        runRestore(ctx, connectionId, file, options, t)
      ),
    extract: async (file, target, options) =>
      ctx.tasks.start('extractSql', tr('SQL extrahieren – {f}', 'Extract SQL – {f}', { f: path.basename(file) }), (t) =>
        runExtract(file, target, options, t)
      )
  };
}

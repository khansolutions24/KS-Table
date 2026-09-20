// Sync feature namespace: data transfer, data synchronization and structure synchronization.

import type { SyncApi } from '@shared/apis/sync';
import { tr } from '@shared/i18n';
import type { BackendContext } from '../api';
import { registerProfileRunner } from '../profileRunners';
import { closeSyncSession, listObjects, openSyncSession } from './sync/common';
import {
  dataDiffRows,
  dataSyncScript,
  prepareDataSync,
  releaseCompare,
  runDataSyncProfile,
  startDataCompare,
  startDataSyncDeploy,
  startDataSyncSave
} from './sync/dataSync';
import { runStructSyncProfile, structCompare, structDeploy } from './sync/structSync';
import { runDataTransfer, transferSummary } from './sync/transfer';

registerProfileRunner('dataTransfer', (ctx, profile, task) => runDataTransfer(ctx, profile, task));
registerProfileRunner('dataSync', (ctx, profile, task) => runDataSyncProfile(ctx, profile, task));
registerProfileRunner('structSync', (ctx, profile, task) => runStructSyncProfile(ctx, profile, task));

export function createSyncApi(ctx: BackendContext): SyncApi {
  return {
    async listObjects(connectionId, database) {
      const ss = await openSyncSession(ctx, connectionId, database, 'read');
      try {
        return await listObjects(ss.s, database);
      } finally {
        await closeSyncSession(ctx, ss);
      }
    },
    startTransfer: async (profile) => ctx.tasks.start('dataTransfer', tr('Datenübertragung', 'Data transfer'), (t) => runDataTransfer(ctx, profile, t)),
    transferSummary: async (taskId) => transferSummary(taskId),
    dataSyncPrepare: (source, target) => prepareDataSync(ctx, source, target),
    startDataCompare: async (profile) => startDataCompare(ctx, profile),
    dataDiffRows: (id, table, kind, offset, limit) => dataDiffRows(ctx, id, table, kind, offset, limit),
    dataSyncScript: (id, selection, options, maxBytes) => dataSyncScript(ctx, id, selection, options, maxBytes),
    startDataSyncSave: async (id, selection, options, path, encoding) => startDataSyncSave(ctx, id, selection, options, path, encoding),
    startDataSyncDeploy: async (id, selection, options) => startDataSyncDeploy(ctx, id, selection, options),
    releaseCompare: async (id) => releaseCompare(id),
    startStructCompare: async (profile) => ctx.tasks.start('structCompare', tr('Strukturvergleich', 'Structure comparison'), (t) => structCompare(ctx, profile, t)),
    startStructDeploy: async (target, statements, continueOnError) =>
      ctx.tasks.start('structDeploy', tr('Struktursynchronisation ausführen', 'Run structure synchronization'), (t) =>
        structDeploy(ctx, target, statements, continueOnError, t)
      )
  };
}

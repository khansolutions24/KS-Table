// Import / export / dump SQL / execute SQL file (implementation in ./io/*).

import type { DumpProfile, ExecSqlFileProfile, ExportProfile, ImportProfile, IoApi } from '@shared/apis/io';
import { tr } from '@shared/i18n';
import type { BackendContext } from '../api';
import { registerProfileRunner } from '../profileRunners';
import { runDump, normalizeDumpProfile } from './io/dump';
import { normalizeExecProfile, runExecSqlFile } from './io/execFile';
import { normalizeExportProfile, queryColumnNames, runExport } from './io/exporter';
import { normalizeImportProfile, runImport } from './io/importer';
import { previewSource, xlsxSheetNames, xmlElementStats } from './io/readers';

registerProfileRunner('import', (ctx, profile, task) => runImport(ctx, profile as ImportProfile, task));
registerProfileRunner('export', (ctx, profile, task) => runExport(ctx, profile as ExportProfile, task));
registerProfileRunner('dumpSql', (ctx, profile, task) => runDump(ctx, profile as DumpProfile, task));
registerProfileRunner('execSqlFile', (ctx, profile, task) => runExecSqlFile(ctx, profile as ExecSqlFileProfile, task));

export function createIoApi(ctx: BackendContext): IoApi {
  return {
    previewImport: (req) => previewSource(req),
    xlsxSheets: (file) => xlsxSheetNames(file),
    xmlElements: (file, encoding) => xmlElementStats(file, encoding),
    startImport: async (profile) => {
      const p = normalizeImportProfile(profile);
      return ctx.tasks.start('import', tr('Import nach {d}', 'Import into {d}', { d: p.database }), (t) => runImport(ctx, p, t));
    },
    queryColumns: (connectionId, database, sql) => queryColumnNames(ctx, connectionId, database, sql),
    startExport: async (profile) => {
      const p = normalizeExportProfile(profile);
      return ctx.tasks.start('export', tr('Export', 'Export'), (t) => runExport(ctx, p, t));
    },
    startDump: async (profile) => {
      const p = normalizeDumpProfile(profile);
      return ctx.tasks.start('dumpSql', tr('SQL-Datei ausgeben: {d}', 'Dump SQL file: {d}', { d: p.database }), (t) => runDump(ctx, p, t));
    },
    startExecSqlFile: async (profile) => {
      const p = normalizeExecProfile(profile);
      return ctx.tasks.start('execSqlFile', tr('SQL-Datei ausführen', 'Execute SQL file'), (t) => runExecSqlFile(ctx, p, t));
    }
  };
}

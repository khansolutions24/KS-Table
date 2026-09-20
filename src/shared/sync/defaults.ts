// Default settings and profile normalization for data transfer, data sync and structure sync.
// Used by the tabs (initial state, loading profiles) and by the headless profile runners.

import type {
  DataSyncMapping,
  DataSyncOptions,
  DataSyncProfile,
  DataTransferProfile,
  InsertMode,
  NameCase,
  StructSyncOptions,
  StructSyncProfile,
  SyncEndpoint,
  TransferObjects,
  TransferOptions,
  TransferTableSetting,
  TransferTarget
} from '../apis/sync';
import { isPlainObject } from '../util';

export function defaultTransferOptions(): TransferOptions {
  return {
    createTables: true,
    dropBeforeCreate: true,
    createDatabase: true,
    includeIndexes: true,
    includeForeignKeys: true,
    includeChecks: true,
    includeTriggers: true,
    includeAutoIncrement: true,
    includePartitions: true,
    includeCharset: true,
    includeEngine: true,
    includeTableOptions: true,
    includeComments: true,
    includeDefiner: false,
    nameCase: 'keep',
    createRecords: true,
    insertMode: 'insert',
    extendedInsert: true,
    rowsPerStatement: 500,
    maxStatementKB: 1024,
    fetchSize: 2000,
    lockSource: false,
    lockTarget: false,
    useTransaction: true,
    disableFkChecks: true,
    continueOnError: false
  };
}

export function emptyTransferObjects(): TransferObjects {
  return { all: false, tables: [], views: [], functions: [], procedures: [], triggers: [], events: [] };
}

export function defaultDataSyncOptions(): DataSyncOptions {
  return { insert: true, update: true, delete: true, continueOnError: false, useTransaction: true, disableFkChecks: true };
}

export function defaultStructSyncOptions(): StructSyncOptions {
  return {
    ignoreAutoIncrement: true,
    ignoreComments: false,
    ignoreCharset: false,
    ignoreDefiner: true,
    ignoreTableOptions: false,
    ignorePartitions: false,
    triggers: true,
    views: true,
    routines: true,
    events: true,
    dropExtra: false,
    continueOnError: false
  };
}

// ───────────────────────── normalization helpers ─────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function obj(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

export function normalizeEndpoint(v: unknown): SyncEndpoint {
  const o = obj(v);
  return { connectionId: str(o.connectionId), database: str(o.database) };
}

function booleans<T extends object>(defaults: T, input: unknown): T {
  const o = obj(input);
  const out = { ...defaults } as Record<string, unknown>;
  for (const [k, d] of Object.entries(defaults)) if (typeof d === 'boolean') out[k] = bool(o[k], d);
  return out as T;
}

export function normalizeTransferOptions(input: unknown): TransferOptions {
  const d = defaultTransferOptions();
  const o = obj(input);
  const out = booleans(d, o);
  const nc = o.nameCase;
  out.nameCase = nc === 'lower' || nc === 'upper' || nc === 'keep' ? (nc as NameCase) : d.nameCase;
  const im = o.insertMode;
  out.insertMode = im === 'ignore' || im === 'replace' || im === 'insert' ? (im as InsertMode) : d.insertMode;
  out.rowsPerStatement = int(o.rowsPerStatement, d.rowsPerStatement, 1, 100_000);
  out.maxStatementKB = int(o.maxStatementKB, d.maxStatementKB, 16, 1_048_576);
  out.fetchSize = int(o.fetchSize, d.fetchSize, 50, 100_000);
  return out;
}

export function normalizeTransferProfile(input: unknown): DataTransferProfile {
  const p = obj(input);
  const t = obj(p.target);
  const target: TransferTarget =
    t.kind === 'file'
      ? { kind: 'file', path: str(t.path), encoding: str(t.encoding) || 'utf8', database: str(t.database) }
      : { kind: 'database', connectionId: str(t.connectionId), database: str(t.database) };
  const o = obj(p.objects);
  const objects: TransferObjects = {
    all: bool(o.all, false),
    tables: strings(o.tables),
    views: strings(o.views),
    functions: strings(o.functions),
    procedures: strings(o.procedures),
    triggers: strings(o.triggers),
    events: strings(o.events)
  };
  const tableSettings: Record<string, TransferTableSetting> = {};
  for (const [name, v] of Object.entries(obj(p.tableSettings))) {
    const s = obj(v);
    const setting = { targetName: str(s.targetName).trim(), where: str(s.where).trim() };
    if (setting.targetName || setting.where) tableSettings[name] = setting;
  }
  return {
    version: 1,
    source: normalizeEndpoint(p.source),
    target,
    objects,
    tableSettings,
    options: normalizeTransferOptions(p.options)
  };
}

export function normalizeDataSyncOptions(input: unknown): DataSyncOptions {
  return booleans(defaultDataSyncOptions(), input);
}

export function normalizeDataSyncProfile(input: unknown): DataSyncProfile {
  const p = obj(input);
  const mappings: DataSyncMapping[] = [];
  if (Array.isArray(p.mappings)) {
    for (const m of p.mappings) {
      const o = obj(m);
      const source = str(o.source);
      if (!source) continue;
      const columnMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj(o.columnMap))) if (typeof v === 'string' && v) columnMap[k] = v;
      mappings.push({ source, target: str(o.target) || source, key: strings(o.key), columns: strings(o.columns), columnMap });
    }
  }
  return {
    version: 1,
    source: normalizeEndpoint(p.source),
    target: normalizeEndpoint(p.target),
    autoMap: bool(p.autoMap, false),
    excluded: strings(p.excluded),
    mappings,
    options: normalizeDataSyncOptions(p.options)
  };
}

export function normalizeStructSyncOptions(input: unknown): StructSyncOptions {
  return booleans(defaultStructSyncOptions(), input);
}

export function normalizeStructSyncProfile(input: unknown): StructSyncProfile {
  const p = obj(input);
  return {
    version: 1,
    source: normalizeEndpoint(p.source),
    target: normalizeEndpoint(p.target),
    options: normalizeStructSyncOptions(p.options)
  };
}

/** Object name after the "convert names" option */
export function convertNameCase(name: string, mode: NameCase): string {
  return mode === 'lower' ? name.toLowerCase() : mode === 'upper' ? name.toUpperCase() : name;
}

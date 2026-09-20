// RPC contract between renderer and backend.
// Every method returns a Promise; the renderer calls api.<namespace>.<method>(...)
// which is transported over Electron IPC (desktop) or a WebSocket (npm run dev:web).

import type {
  AppSettings,
  ApplyRequest,
  ApplyResult,
  CharsetInfo,
  CollationInfo,
  ColumnMeta,
  ConnectionConfig,
  ConnectionGroup,
  ConnectionTestResult,
  Credentials,
  EngineInfo,
  EventStatus,
  ExecuteOptions,
  ExecuteResult,
  FetchRequest,
  FetchResult,
  HistoryEntry,
  ObjectKind,
  QueryProgressEvent,
  RoutineStatus,
  SchemaInfo,
  SessionInfo,
  SqlError,
  TableDesign,
  TableStatus,
  TaskInfo,
  TaskLogEntry,
  TriggerStatus,
  ViewStatus
} from './types';

import type { AdminApi, AutomationApi, BackupApi, DataGenApi, IoApi, ModelApi, SyncApi, UsersApi } from './apis/features';
import type { ProfilesApi } from './apis/profiles';
import type { SnippetsApi } from './apis/snippets';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
  multi?: boolean;
}

export interface SaveFileOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export interface AppInfo {
  version: string;
  platform: string;
  isElectron: boolean;
  electronVersion: string;
  nodeVersion: string;
  userDataDir: string;
  documentsDir: string;
  profilesDir: string;
}

export interface AppApi {
  info(): Promise<AppInfo>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  quit(): Promise<void>;
  relaunch(): Promise<void>;
  /** Source of ks_tunnel.php, the script users deploy on their own web server for the HTTP tunnel. */
  tunnelScript(): Promise<string>;
}

export interface WindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  setTitleBarColors(bg: string, fg: string): Promise<void>;
  toggleDevTools(): Promise<void>;
  reload(): Promise<void>;
  /** Native edit command for the focused element (Electron only) */
  editCommand(cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<boolean>;
}

export interface DialogApi {
  openFile(opts: OpenFileOptions): Promise<string[] | null>;
  saveFile(opts: SaveFileOptions): Promise<string | null>;
  openDirectory(opts: { title?: string; defaultPath?: string }): Promise<string | null>;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface FsApi {
  readText(path: string, encoding?: string): Promise<string>;
  writeText(path: string, content: string, encoding?: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ exists: boolean; isDir: boolean; size: number; mtime: number }>;
  list(dir: string): Promise<FileEntry[]>;
  mkdir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface SettingsApi {
  get(): Promise<AppSettings>;
  update(patch: DeepPartial<AppSettings>): Promise<AppSettings>;
}

export interface ConnectionsApi {
  list(): Promise<{ connections: ConnectionConfig[]; groups: ConnectionGroup[] }>;
  save(conn: ConnectionConfig): Promise<ConnectionConfig>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  saveGroup(group: ConnectionGroup): Promise<ConnectionGroup>;
  removeGroup(id: string): Promise<void>;
  test(conn: ConnectionConfig): Promise<ConnectionTestResult>;
  /** Database names reachable with an (unsaved) profile */
  listDatabases(conn: ConnectionConfig): Promise<string[]>;
  /** Passwords are included (encrypted with the passphrase) only when a passphrase is given */
  exportFile(path: string, ids: string[], passphrase: string | null): Promise<number>;
  importFile(path: string, passphrase: string | null): Promise<number>;
}

export interface SessionApi {
  open(connectionId: string, database?: string | null, credentials?: Credentials): Promise<SessionInfo>;
  close(sessionId: string): Promise<void>;
  closeConnection(connectionId: string): Promise<void>;
  useDatabase(sessionId: string, database: string): Promise<void>;
  ping(sessionId: string): Promise<number>;
  info(sessionId: string): Promise<SessionInfo>;
}

export interface CompletionTable {
  name: string;
  type: 'table' | 'view';
  columns: { name: string; type: string }[];
}

export interface MetaApi {
  databases(sessionId: string): Promise<SchemaInfo[]>;
  tables(sessionId: string, schema: string): Promise<TableStatus[]>;
  views(sessionId: string, schema: string): Promise<ViewStatus[]>;
  routines(sessionId: string, schema: string): Promise<RoutineStatus[]>;
  events(sessionId: string, schema: string): Promise<EventStatus[]>;
  triggers(sessionId: string, schema: string, table?: string): Promise<TriggerStatus[]>;
  columns(sessionId: string, schema: string, table: string): Promise<ColumnMeta[]>;
  ddl(sessionId: string, schema: string, kind: ObjectKind, name: string): Promise<string>;
  charsets(sessionId: string): Promise<CharsetInfo[]>;
  collations(sessionId: string): Promise<CollationInfo[]>;
  engines(sessionId: string): Promise<EngineInfo[]>;
  tableDesign(sessionId: string, schema: string, table: string): Promise<TableDesign>;
  completion(sessionId: string, schema: string): Promise<CompletionTable[]>;
}

export interface QueryApi {
  execute(sessionId: string, sql: string, opts?: ExecuteOptions): Promise<ExecuteResult>;
  cancel(sessionId: string): Promise<void>;
}

export interface DataApi {
  fetch(sessionId: string, req: FetchRequest): Promise<FetchResult>;
  count(sessionId: string, schema: string, table: string, where?: string): Promise<number>;
  apply(sessionId: string, req: ApplyRequest): Promise<ApplyResult>;
}

export interface HistoryApi {
  list(filter?: { connectionId?: string; search?: string; limit?: number }): Promise<HistoryEntry[]>;
  clear(): Promise<void>;
}

export interface TasksApi {
  list(): Promise<TaskInfo[]>;
  log(taskId: string): Promise<TaskLogEntry[]>;
  cancel(taskId: string): Promise<void>;
}

export interface Api {
  app: AppApi;
  window: WindowApi;
  dialog: DialogApi;
  fs: FsApi;
  settings: SettingsApi;
  connections: ConnectionsApi;
  session: SessionApi;
  meta: MetaApi;
  query: QueryApi;
  data: DataApi;
  history: HistoryApi;
  tasks: TasksApi;
  profiles: ProfilesApi;
  snippets: SnippetsApi;
  // feature namespaces (see src/shared/apis/features.ts)
  users: UsersApi;
  io: IoApi;
  sync: SyncApi;
  admin: AdminApi;
  backup: BackupApi;
  automation: AutomationApi;
  datagen: DataGenApi;
  model: ModelApi;
}

/** Events pushed from the backend to the renderer. */
export interface EventMap {
  'task:update': TaskInfo;
  'task:log': TaskLogEntry;
  'query:progress': QueryProgressEvent;
  'session:lost': { sessionId: string; connectionId: string; message: string };
  'window:state': { maximized: boolean };
  'history:added': HistoryEntry;
  /** The user tried to close the window; the renderer confirms and calls window.close() */
  'app:close-requested': null;
  /** Renderer-local: the dev backend was restarted, all sessions are gone */
  'backend:restarted': null;
}

export type RpcResponse = { ok: true; value: unknown } | { ok: false; error: SqlError & { name?: string } };

export const IPC_INVOKE = 'ks:invoke';
export const IPC_EVENT = 'ks:event';
export const DEV_WS_PORT = 5199;

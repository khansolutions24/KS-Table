// Connection profiles and their runtime state (navigator session, databases, object lists).

import { create } from 'zustand';
import type {
  ConnectionConfig,
  ConnectionGroup,
  Credentials,
  EventStatus,
  RoutineStatus,
  SchemaInfo,
  ServerInfo,
  SessionInfo,
  TableStatus,
  ViewStatus
} from '@shared/types';
import { tr } from '@shared/i18n';
import { api, errorCode, errorMessage, onEvent, RpcError } from '../api/client';
import { errorDialog, promptDialog } from '../components/ui/Dialog';
import { joinPath } from '../lib/files';

export interface FileItem {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

export type DbList = 'tables' | 'views' | 'routines' | 'events' | 'queries' | 'backups';

export interface DbState {
  loaded: boolean;
  loading: boolean;
  error?: string;
  tables: TableStatus[];
  views: ViewStatus[];
  routines: RoutineStatus[];
  events: EventStatus[];
  queries: FileItem[];
  backups: FileItem[];
}

export interface ConnState {
  status: 'closed' | 'connecting' | 'open' | 'error';
  sessionId?: string;
  server?: ServerInfo;
  error?: string;
  databases: SchemaInfo[];
  dbs: Record<string, DbState>;
}

export class UserCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'UserCancelled';
  }
}

export const isUserCancelled = (e: unknown): boolean => e instanceof UserCancelled;

const emptyDb = (): DbState => ({
  loaded: false,
  loading: false,
  tables: [],
  views: [],
  routines: [],
  events: [],
  queries: [],
  backups: []
});

const closedConn = (): ConnState => ({ status: 'closed', databases: [], dbs: {} });

interface WorkspaceStore {
  profiles: ConnectionConfig[];
  groups: ConnectionGroup[];
  conns: Record<string, ConnState>;
  profilesDir: string;
  loaded: boolean;
  load(): Promise<void>;
  saveProfile(c: ConnectionConfig): Promise<ConnectionConfig>;
  removeProfile(id: string): Promise<void>;
  reorderProfiles(ids: string[]): Promise<void>;
  saveGroup(g: ConnectionGroup): Promise<void>;
  removeGroup(id: string): Promise<void>;
  openConnection(id: string): Promise<boolean>;
  closeConnection(id: string): Promise<void>;
  refreshConnection(id: string): Promise<void>;
  openDatabase(id: string, db: string): Promise<boolean>;
  closeDatabase(id: string, db: string): void;
  refreshDatabase(id: string, db: string, what?: DbList[]): Promise<void>;
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  const setConn = (id: string, patch: Partial<ConnState> | ((c: ConnState) => Partial<ConnState>)) =>
    set((s) => {
      const cur = s.conns[id] ?? closedConn();
      const p = typeof patch === 'function' ? patch(cur) : patch;
      return { conns: { ...s.conns, [id]: { ...cur, ...p } } };
    });

  const setDb = (id: string, db: string, patch: Partial<DbState>) =>
    setConn(id, (c) => ({ dbs: { ...c.dbs, [db]: { ...(c.dbs[db] ?? emptyDb()), ...patch } } }));

  return {
    profiles: [],
    groups: [],
    conns: {},
    profilesDir: '',
    loaded: false,

    load: async () => {
      const [{ connections, groups }, info] = await Promise.all([api.connections.list(), api.app.info()]);
      set({ profiles: connections, groups, profilesDir: info.profilesDir, loaded: true });
      for (const c of connections) if (c.autoConnect) void get().openConnection(c.id);
    },

    saveProfile: async (c) => {
      const saved = await api.connections.save(c);
      set((s) => {
        const exists = s.profiles.some((p) => p.id === saved.id);
        return { profiles: exists ? s.profiles.map((p) => (p.id === saved.id ? saved : p)) : [...s.profiles, saved] };
      });
      return saved;
    },

    removeProfile: async (id) => {
      await api.connections.remove(id);
      set((s) => {
        const conns = { ...s.conns };
        delete conns[id];
        return { profiles: s.profiles.filter((p) => p.id !== id), conns };
      });
    },

    reorderProfiles: async (ids) => {
      await api.connections.reorder(ids);
      const pos = new Map(ids.map((id, i) => [id, i]));
      set((s) => ({ profiles: [...s.profiles].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)) }));
    },

    saveGroup: async (g) => {
      await api.connections.saveGroup(g);
      set((s) => ({ groups: s.groups.some((x) => x.id === g.id) ? s.groups.map((x) => (x.id === g.id ? g : x)) : [...s.groups, g] }));
    },

    removeGroup: async (id) => {
      await api.connections.removeGroup(id);
      set((s) => ({
        groups: s.groups.filter((g) => g.id !== id),
        profiles: s.profiles.map((p) => (p.groupId === id ? { ...p, groupId: null } : p))
      }));
    },

    openConnection: async (id) => {
      const cur = get().conns[id];
      if (cur?.status === 'open') return true;
      setConn(id, { status: 'connecting', error: undefined });
      try {
        const info = await openSessionWithPrompt(id);
        const databases = await api.meta.databases(info.sessionId);
        setConn(id, { status: 'open', sessionId: info.sessionId, server: info.server, databases, dbs: {}, error: undefined });
        return true;
      } catch (e) {
        if (isUserCancelled(e)) {
          setConn(id, closedConn());
          return false;
        }
        setConn(id, { ...closedConn(), status: 'error', error: errorMessage(e) });
        void errorDialog(e, tr('Verbindung fehlgeschlagen', 'Connection failed'));
        return false;
      }
    },

    closeConnection: async (id) => {
      await api.session.closeConnection(id).catch(() => undefined);
      setConn(id, closedConn());
    },

    refreshConnection: async (id) => {
      const c = get().conns[id];
      if (!c || c.status !== 'open' || !c.sessionId) return;
      try {
        const databases = await api.meta.databases(c.sessionId);
        const names = new Set(databases.map((d) => d.name));
        setConn(id, (cur) => ({
          databases,
          dbs: Object.fromEntries(Object.entries(cur.dbs).filter(([k]) => names.has(k)))
        }));
        for (const [db, st] of Object.entries(get().conns[id]?.dbs ?? {})) if (st.loaded) void get().refreshDatabase(id, db);
      } catch (e) {
        void errorDialog(e);
      }
    },

    openDatabase: async (id, db) => {
      if (!(await get().openConnection(id))) return false;
      const st = get().conns[id]?.dbs[db];
      if (st?.loaded) return true;
      await get().refreshDatabase(id, db);
      return !get().conns[id]?.dbs[db]?.error;
    },

    closeDatabase: (id, db) => {
      setConn(id, (c) => {
        const dbs = { ...c.dbs };
        delete dbs[db];
        return { dbs };
      });
    },

    refreshDatabase: async (id, db, what) => {
      const c = get().conns[id];
      if (!c?.sessionId) return;
      const sid = c.sessionId;
      const all: DbList[] = ['tables', 'views', 'routines', 'events', 'queries', 'backups'];
      const lists = what ?? all;
      setDb(id, db, { loading: true, error: undefined });
      const patch: Partial<DbState> = {};
      const dir = get().profilesDir;
      // every list loads independently: one failing query must not hide the others
      const results = await Promise.allSettled(
        lists.map(async (l) => {
          if (l === 'tables') patch.tables = await api.meta.tables(sid, db);
          else if (l === 'views') patch.views = await api.meta.views(sid, db);
          else if (l === 'routines') patch.routines = await api.meta.routines(sid, db);
          else if (l === 'events') patch.events = await api.meta.events(sid, db);
          else if (l === 'queries') patch.queries = await listFiles(queriesDir(dir, id, db), ['.sql']);
          else if (l === 'backups') patch.backups = await listFiles(backupsDir(dir, id, db), ['.ksbak']);
        })
      );
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      setDb(id, db, { ...patch, loaded: true, loading: false, error: failed ? errorMessage(failed.reason) : undefined });
      if (failed) void errorDialog(failed.reason);
      invalidateCompletionCache(id, db);
    }
  };
});

// Dev mode: the backend process restarted (all sessions are gone) → mark every connection closed.
onEvent('backend:restarted', () => {
  useWorkspace.setState({ conns: {} });
});

type Invalidator = (connectionId: string, database?: string) => void;
const invalidators: Invalidator[] = [];

/** Caches that depend on database objects (e.g. SQL completion) register here. */
export function onDatabaseRefresh(fn: Invalidator): void {
  invalidators.push(fn);
}

function invalidateCompletionCache(connectionId: string, database?: string): void {
  for (const fn of invalidators) fn(connectionId, database);
}

async function listFiles(dir: string, exts: string[]): Promise<FileItem[]> {
  const entries = await api.fs.list(dir);
  return entries
    .filter((e) => !e.isDir && exts.some((x) => e.name.toLowerCase().endsWith(x)))
    .map((e) => ({ name: e.name.replace(/\.[^.]+$/, ''), path: e.path, size: e.size, mtime: e.mtime }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function connectionDir(profilesDir: string, connectionId: string): string {
  return joinPath(profilesDir, 'connections', connectionId);
}

export function queriesDir(profilesDir: string, connectionId: string, db: string): string {
  return joinPath(connectionDir(profilesDir, connectionId), db, 'queries');
}

export function backupsDir(profilesDir: string, connectionId: string, db: string): string {
  return joinPath(connectionDir(profilesDir, connectionId), db, 'backups');
}

export function getProfile(id: string): ConnectionConfig | undefined {
  return useWorkspace.getState().profiles.find((p) => p.id === id);
}

export function getConn(id: string): ConnState | undefined {
  return useWorkspace.getState().conns[id];
}

/** Navigator session of an open connection */
export function metaSession(id: string): string {
  const c = useWorkspace.getState().conns[id];
  if (!c?.sessionId) throw new Error(tr('Die Verbindung ist nicht geöffnet.', 'The connection is not open.'));
  return c.sessionId;
}

/** Opens a session and asks for passwords that are not stored in the profile. */
export async function openSessionWithPrompt(connectionId: string, database?: string | null): Promise<SessionInfo> {
  let creds: Credentials | undefined;
  const cfg = getProfile(connectionId);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await api.session.open(connectionId, database ?? null, creds);
    } catch (e) {
      const code = errorCode(e);
      const denied = e instanceof RpcError && e.errno === 1045;
      if (code === 'PASSWORD_REQUIRED' || (denied && cfg && !cfg.savePassword)) {
        const pw = await promptDialog({
          title: tr('Anmeldung', 'Sign in'),
          label: denied
            ? tr('Zugriff verweigert. Passwort für {u}@{h} erneut eingeben:', 'Access denied. Enter the password for {u}@{h} again:', { u: cfg?.user ?? '', h: cfg?.host ?? '' })
            : tr('Passwort für {u}@{h}:', 'Password for {u}@{h}:', { u: cfg?.user ?? '', h: cfg?.host ?? '' }),
          password: true
        });
        if (pw === null) throw new UserCancelled();
        creds = { ...creds, password: pw };
        continue;
      }
      if (code === 'SSH_PASSWORD_REQUIRED') {
        const pw = await promptDialog({
          title: tr('SSH-Anmeldung', 'SSH sign in'),
          label: tr('SSH-Passwort für {u}@{h}:', 'SSH password for {u}@{h}:', { u: cfg?.ssh.user ?? '', h: cfg?.ssh.host ?? '' }),
          password: true
        });
        if (pw === null) throw new UserCancelled();
        creds = { ...creds, sshPassword: pw };
        continue;
      }
      throw e;
    }
  }
  throw new Error(tr('Anmeldung fehlgeschlagen', 'Sign in failed'));
}

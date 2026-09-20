// Navigator selection / expansion state and the "current context" used by toolbar and object pane.

import { create } from 'zustand';

export type Category = 'tables' | 'views' | 'functions' | 'events' | 'queries' | 'backups' | 'users';

export type NodeKind = 'group' | 'connection' | 'database' | 'category' | 'object';

export interface NodeRef {
  kind: NodeKind;
  groupId?: string;
  connectionId?: string;
  database?: string;
  category?: Category;
  /** object name (table, view, routine, event, saved query, backup) */
  name?: string;
  /** routine type for functions/procedures */
  objectType?: 'table' | 'view' | 'function' | 'procedure' | 'event' | 'query' | 'backup';
}

export function nodeKey(n: NodeRef): string {
  switch (n.kind) {
    case 'group':
      return `g:${n.groupId}`;
    case 'connection':
      return `c:${n.connectionId}`;
    case 'database':
      return `d:${n.connectionId}/${n.database}`;
    case 'category':
      return `k:${n.connectionId}/${n.database}/${n.category}`;
    default:
      return `o:${n.connectionId}/${n.database}/${n.category}/${n.objectType}/${n.name}`;
  }
}

export function parseKey(key: string): NodeRef | null {
  const t = key[0];
  const rest = key.slice(2);
  if (t === 'g') return { kind: 'group', groupId: rest };
  if (t === 'c') return { kind: 'connection', connectionId: rest };
  const parts = rest.split('/');
  if (t === 'd') return { kind: 'database', connectionId: parts[0], database: parts[1] };
  if (t === 'k') return { kind: 'category', connectionId: parts[0], database: parts[1], category: parts[2] as Category };
  if (t === 'o') {
    return {
      kind: 'object',
      connectionId: parts[0],
      database: parts[1],
      category: parts[2] as Category,
      objectType: parts[3] as NodeRef['objectType'],
      name: parts.slice(4).join('/')
    };
  }
  return null;
}

interface NavStore {
  selectedKey: string | null;
  expanded: Record<string, boolean>;
  filter: string;
  /** category shown in the objects tab for the current database */
  category: Category;
  select(key: string | null): void;
  setExpanded(key: string, open: boolean): void;
  setFilter(f: string): void;
  setCategory(c: Category): void;
}

export const useNav = create<NavStore>((set) => ({
  selectedKey: null,
  expanded: {},
  filter: '',
  category: 'tables',
  select: (key) =>
    set(() => {
      const ref = key ? parseKey(key) : null;
      const patch: Partial<NavStore> = { selectedKey: key };
      if (ref?.category) patch.category = ref.category;
      else if (ref?.kind === 'database') patch.category = 'tables';
      return patch;
    }),
  setExpanded: (key, open) => set((s) => ({ expanded: { ...s.expanded, [key]: open } })),
  setFilter: (filter) => set({ filter }),
  setCategory: (category) => set({ category })
}));

export interface CurrentContext {
  connectionId?: string;
  database?: string;
  category: Category;
}

export function currentContext(): CurrentContext {
  const s = useNav.getState();
  const ref = s.selectedKey ? parseKey(s.selectedKey) : null;
  return { connectionId: ref?.connectionId, database: ref?.database, category: s.category };
}

export function useCurrentContext(): CurrentContext {
  const selectedKey = useNav((s) => s.selectedKey);
  const category = useNav((s) => s.category);
  const ref = selectedKey ? parseKey(selectedKey) : null;
  return { connectionId: ref?.connectionId, database: ref?.database, category };
}

/** Item shown in the information pane */
export interface InfoTarget {
  connectionId: string;
  database?: string;
  objectType?: NodeRef['objectType'] | 'database' | 'connection';
  name?: string;
}

export const useInfoTarget = create<{ target: InfoTarget | null; set(t: InfoTarget | null): void }>((set) => ({
  target: null,
  set: (target) => set({ target })
}));

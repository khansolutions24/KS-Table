// Document tabs of the main window (objects list, table viewers, designers, queries, tools).

import { create } from 'zustand';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';

export type TabIcon = string;

export interface TabInfo {
  id: string;
  kind: string;
  title: string;
  icon: TabIcon;
  params: Record<string, unknown>;
  /** Tabs with the same key are reused instead of opened twice */
  key?: string;
  dirty?: boolean;
  connectionId?: string;
  /** Tooltip, e.g. connection / database */
  subtitle?: string;
}

export interface TabProps {
  tab: TabInfo;
  active: boolean;
}

type CloseGuard = () => Promise<boolean> | boolean;
const guards = new Map<string, CloseGuard>();

/** A tab component registers a guard that may veto closing (e.g. unsaved changes). */
export function setCloseGuard(tabId: string, guard: CloseGuard | null): void {
  if (guard) guards.set(tabId, guard);
  else guards.delete(tabId);
}

export const OBJECTS_TAB = 'objects';

interface TabsStore {
  tabs: TabInfo[];
  activeId: string;
  open(tab: Omit<TabInfo, 'id'> & { id?: string }): string;
  activate(id: string): void;
  update(id: string, patch: Partial<TabInfo>): void;
  updateParams(id: string, patch: Record<string, unknown>): void;
  close(id: string): Promise<boolean>;
  closeMany(ids: string[]): Promise<boolean>;
  move(id: string, toIndex: number): void;
}

export const useTabs = create<TabsStore>((set, get) => ({
  tabs: [{ id: OBJECTS_TAB, kind: 'objects', title: tr('Objekte', 'Objects'), icon: 'objects', params: {} }],
  activeId: OBJECTS_TAB,

  open: (tab) => {
    const s = get();
    if (tab.key) {
      const existing = s.tabs.find((t) => t.key === tab.key);
      if (existing) {
        set({ activeId: existing.id });
        return existing.id;
      }
    }
    const id = tab.id ?? newId('t');
    const t: TabInfo = { ...tab, id };
    set({ tabs: [...s.tabs, t], activeId: id });
    return id;
  },

  activate: (id) => set({ activeId: id }),

  update: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

  updateParams: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, params: { ...t.params, ...patch } } : t)) })),

  close: async (id) => {
    if (id === OBJECTS_TAB) return false;
    const guard = guards.get(id);
    if (guard) {
      set({ activeId: id });
      if (!(await guard())) return false;
    }
    guards.delete(id);
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) activeId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0]).id;
      return { tabs, activeId };
    });
    return true;
  },

  closeMany: async (ids) => {
    for (const id of ids) {
      if (!(await get().close(id))) return false;
    }
    return true;
  },

  move: (id, toIndex) =>
    set((s) => {
      const tabs = [...s.tabs];
      const from = tabs.findIndex((t) => t.id === id);
      if (from < 1 || toIndex < 1) return s;
      const [t] = tabs.splice(from, 1);
      tabs.splice(Math.min(toIndex, tabs.length), 0, t);
      return { tabs };
    })
}));

export function activeTab(): TabInfo | undefined {
  const s = useTabs.getState();
  return s.tabs.find((t) => t.id === s.activeId);
}

/** Close all tabs belonging to a connection (asks for unsaved changes). */
export async function closeTabsOfConnection(connectionId: string): Promise<boolean> {
  const ids = useTabs.getState().tabs.filter((t) => t.connectionId === connectionId).map((t) => t.id);
  return useTabs.getState().closeMany(ids);
}

// Navigation pane: connection groups → connections → databases → object categories → objects.

import { useMemo, useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { ConnectionConfig, ConnectionGroup } from '@shared/types';
import { emptyNavigatorMenu, menuForNode, newConnectionItems, objRefOf, openNode, refreshNode } from '../actions/menus';
import * as C from '../actions/connection';
import * as D from '../actions/database';
import * as O from '../actions/objects';
import { ObjIcon, type ObjKind } from '../components/icons';
import { Button, IconButton, SearchInput, Spinner } from '../components/ui/controls';
import { promptDialog } from '../components/ui/Dialog';
import { showContextMenu, showMenuBelow } from '../components/ui/Menu';
import { keyCombo } from '../lib/shortcuts';
import { nodeKey, parseKey, useInfoTarget, useNav, type Category, type NodeRef } from '../store/nav';
import { useSettings } from '../store/settings';
import { OBJECTS_TAB, useTabs } from '../store/tabs';
import { getProfile, useWorkspace, type ConnState, type DbState } from '../store/workspace';

interface Row {
  key: string;
  depth: number;
  ref: NodeRef;
  label: string;
  kind: ObjKind;
  dim?: boolean;
  expandable: boolean;
  expanded: boolean;
  loading?: boolean;
  color?: string | null;
  hint?: string;
}

export const CATEGORIES: { id: Category; label: () => string; kind: ObjKind }[] = [
  { id: 'tables', label: () => tr('Tabellen', 'Tables'), kind: 'table' },
  { id: 'views', label: () => tr('Ansichten', 'Views'), kind: 'view' },
  { id: 'functions', label: () => tr('Funktionen', 'Functions'), kind: 'function' },
  { id: 'events', label: () => tr('Ereignisse', 'Events'), kind: 'event' },
  { id: 'queries', label: () => tr('Abfragen', 'Queries'), kind: 'query' },
  { id: 'backups', label: () => tr('Sicherungen', 'Backups'), kind: 'backup' }
];

export function itemsOf(cat: Category, st: DbState): { name: string; type: O.ObjType }[] {
  switch (cat) {
    case 'tables':
      return st.tables.map((t) => ({ name: t.name, type: 'table' }));
    case 'views':
      return st.views.map((v) => ({ name: v.name, type: 'view' }));
    case 'functions':
      return st.routines.map((r) => ({ name: r.name, type: r.type === 'FUNCTION' ? 'function' : 'procedure' }));
    case 'events':
      return st.events.map((e) => ({ name: e.name, type: 'event' }));
    case 'queries':
      return st.queries.map((q) => ({ name: q.name, type: 'query' }));
    case 'backups':
      return st.backups.map((b) => ({ name: b.name, type: 'backup' }));
    default:
      return [];
  }
}

function buildRows(
  profiles: ConnectionConfig[],
  groups: ConnectionGroup[],
  conns: Record<string, ConnState>,
  expanded: Record<string, boolean>,
  filter: string,
  showObjects: boolean
): Row[] {
  const rows: Row[] = [];
  const f = filter.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);

  const pushConn = (p: ConnectionConfig, depth: number) => {
    const cs = conns[p.id];
    const open = cs?.status === 'open';
    const ckey = nodeKey({ kind: 'connection', connectionId: p.id });
    const cexp = open && (expanded[ckey] ?? false);
    rows.push({
      key: ckey,
      depth,
      ref: { kind: 'connection', connectionId: p.id },
      label: p.name,
      kind: p.type === 'mariadb' ? 'connection-mariadb' : 'connection',
      dim: !open,
      expandable: true,
      expanded: cexp,
      loading: cs?.status === 'connecting',
      color: p.color
    });
    if (!cexp || !cs) return;
    for (const db of cs.databases) {
      const ds = cs.dbs[db.name];
      const dref: NodeRef = { kind: 'database', connectionId: p.id, database: db.name };
      const dkey = nodeKey(dref);
      const catRows: Row[] = [];
      let anyMatch = false;
      if (ds?.loaded && showObjects) {
        for (const cat of CATEGORIES) {
          const items = itemsOf(cat.id, ds);
          const filtered = f ? items.filter((i) => match(i.name)) : items;
          if (f && !filtered.length) continue;
          anyMatch = anyMatch || filtered.length > 0;
          const cref: NodeRef = { kind: 'category', connectionId: p.id, database: db.name, category: cat.id };
          const ckey2 = nodeKey(cref);
          const cexp2 = f ? true : !!expanded[ckey2];
          catRows.push({
            key: ckey2,
            depth: depth + 2,
            ref: cref,
            label: cat.label(),
            kind: cat.kind,
            expandable: items.length > 0,
            expanded: cexp2 && items.length > 0,
            hint: items.length ? String(items.length) : undefined
          });
          if (!cexp2) continue;
          for (const it of filtered) {
            const oref: NodeRef = {
              kind: 'object',
              connectionId: p.id,
              database: db.name,
              category: cat.id,
              objectType: it.type,
              name: it.name
            };
            catRows.push({ key: nodeKey(oref), depth: depth + 3, ref: oref, label: it.name, kind: it.type as ObjKind, expandable: false, expanded: false });
          }
        }
      }
      if (f && !match(db.name) && !anyMatch) continue;
      const dexp = !!ds?.loaded && (f ? anyMatch || !!expanded[dkey] : !!expanded[dkey]);
      rows.push({
        key: dkey,
        depth: depth + 1,
        ref: dref,
        label: db.name,
        kind: 'database',
        dim: !ds?.loaded,
        expandable: showObjects || !ds?.loaded,
        expanded: dexp && showObjects,
        loading: ds?.loading
      });
      if (dexp) rows.push(...catRows);
    }
  };

  const sortedGroups = [...groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  for (const g of sortedGroups) {
    const members = profiles.filter((p) => p.groupId === g.id);
    const gref: NodeRef = { kind: 'group', groupId: g.id };
    const gkey = nodeKey(gref);
    const gexp = expanded[gkey] ?? true;
    rows.push({ key: gkey, depth: 0, ref: gref, label: g.name, kind: 'group', expandable: true, expanded: gexp, hint: String(members.length) });
    if (gexp) for (const p of members) pushConn(p, 1);
  }
  const groupIds = new Set(groups.map((g) => g.id));
  for (const p of profiles) if (!p.groupId || !groupIds.has(p.groupId)) pushConn(p, 0);
  return rows;
}

function highlight(label: string, filter: string): ReactNode {
  const f = filter.trim();
  if (!f) return label;
  const i = label.toLowerCase().indexOf(f.toLowerCase());
  if (i < 0) return label;
  return (
    <>
      {label.slice(0, i)}
      <mark>{label.slice(i, i + f.length)}</mark>
      {label.slice(i + f.length)}
    </>
  );
}

export function setInfoFromRef(ref: NodeRef | null): void {
  const t = useInfoTarget.getState();
  if (!ref || !ref.connectionId) {
    t.set(null);
    return;
  }
  if (ref.kind === 'connection') t.set({ connectionId: ref.connectionId, objectType: 'connection' });
  else if (ref.kind === 'database' || ref.kind === 'category') {
    t.set({ connectionId: ref.connectionId, database: ref.database, objectType: 'database', name: ref.database });
  } else if (ref.kind === 'object') {
    t.set({ connectionId: ref.connectionId, database: ref.database, objectType: ref.objectType, name: ref.name });
  }
}

async function deleteNode(ref: NodeRef): Promise<void> {
  if (ref.kind === 'connection') return C.deleteConnection(ref.connectionId!);
  if (ref.kind === 'group') return C.deleteGroup(ref.groupId!);
  if (ref.kind === 'database') return D.dropDatabase(ref.connectionId!, ref.database!);
  const o = objRefOf(ref);
  if (o) return O.dropObjects(ref.connectionId!, ref.database!, [o]);
}

async function renameNode(ref: NodeRef): Promise<void> {
  if (ref.kind === 'group') return C.renameGroup(ref.groupId!);
  if (ref.kind === 'connection') {
    const p = getProfile(ref.connectionId!);
    if (!p) return;
    const name = await promptDialog({ title: tr('Verbindung umbenennen', 'Rename connection'), label: tr('Name', 'Name'), value: p.name });
    if (name && name.trim()) await useWorkspace.getState().saveProfile({ ...p, name: name.trim() });
    return;
  }
  const o = objRefOf(ref);
  if (o) return O.renameObject(ref.connectionId!, ref.database!, o);
}

export function Navigator() {
  const profiles = useWorkspace((s) => s.profiles);
  const groups = useWorkspace((s) => s.groups);
  const conns = useWorkspace((s) => s.conns);
  const loaded = useWorkspace((s) => s.loaded);
  const expanded = useNav((s) => s.expanded);
  const selectedKey = useNav((s) => s.selectedKey);
  const filter = useNav((s) => s.filter);
  const showObjects = useSettings((s) => s.settings.navigatorShowObjects);
  const rows = useMemo(() => buildRows(profiles, groups, conns, expanded, filter, showObjects), [profiles, groups, conns, expanded, filter, showObjects]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 24, overscan: 16 });

  const select = (r: Row) => {
    useNav.getState().select(r.key);
    setInfoFromRef(r.ref);
  };

  const toggle = async (r: Row) => {
    const nav = useNav.getState();
    if (r.ref.kind === 'connection') {
      const st = conns[r.ref.connectionId!]?.status;
      if (st !== 'open') await C.openConnection(r.ref.connectionId!);
      else nav.setExpanded(r.key, !r.expanded);
    } else if (r.ref.kind === 'database') {
      await D.toggleDatabase(r.ref.connectionId!, r.ref.database!);
    } else if (r.expandable) {
      nav.setExpanded(r.key, !r.expanded);
    }
  };

  const move = (i: number) => {
    if (!rows.length) return;
    const idx = Math.max(0, Math.min(rows.length - 1, i));
    select(rows[idx]);
    virt.scrollToIndex(idx, { align: 'auto' });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = rows.findIndex((r) => r.key === selectedKey);
    const r = rows[idx];
    const combo = keyCombo(e);
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (combo) {
      case 'ArrowDown':
        handled();
        move(idx + 1);
        return;
      case 'ArrowUp':
        handled();
        move(idx - 1);
        return;
      case 'Home':
        handled();
        move(0);
        return;
      case 'End':
        handled();
        move(rows.length - 1);
        return;
      case 'PageDown':
        handled();
        move(idx + 15);
        return;
      case 'PageUp':
        handled();
        move(idx - 15);
        return;
    }
    if (!r) return;
    switch (combo) {
      case 'ArrowRight':
        handled();
        if (r.expandable && !r.expanded) void toggle(r);
        else if (r.expanded) move(idx + 1);
        break;
      case 'ArrowLeft':
        handled();
        if (r.expanded) void toggle(r);
        else {
          for (let i = idx - 1; i >= 0; i--) {
            if (rows[i].depth < r.depth) {
              move(i);
              break;
            }
          }
        }
        break;
      case 'Enter':
        handled();
        void openNode(r.ref);
        break;
      case 'F5':
        handled();
        void refreshNode(r.ref);
        break;
      case 'Delete':
        handled();
        void deleteNode(r.ref);
        break;
      case 'F2':
        handled();
        void renameNode(r.ref);
        break;
      case 'Ctrl+C':
        handled();
        O.copyNames([r.label]);
        break;
    }
  };

  return (
    <div className="ks-nav">
      <div className="ks-nav-header">
        <span className="ks-nav-title">{tr('Verbindungen', 'Connections')}</span>
        <IconButton
          icon={<Plus size={15} />}
          title={tr('Neue Verbindung', 'New Connection')}
          onClick={(e) => showMenuBelow(e.currentTarget, newConnectionItems())}
        />
        <IconButton
          icon={<RefreshCw size={14} />}
          title={tr('Aktualisieren (F5)', 'Refresh (F5)')}
          onClick={() => {
            const key = useNav.getState().selectedKey;
            void refreshNode(key ? parseKey(key) : null);
          }}
        />
      </div>
      <div
        className="ks-nav-tree"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('ks-nav-tree-inner')) {
            showContextMenu(e, emptyNavigatorMenu());
          }
        }}
      >
        {!loaded ? (
          <div className="ks-nav-empty">
            <Spinner />
          </div>
        ) : profiles.length === 0 ? (
          <div className="ks-nav-empty">
            <ObjIcon kind="connection" size={34} dim />
            <div>{tr('Noch keine Verbindungen', 'No connections yet')}</div>
            <Button variant="primary" onClick={() => void C.newConnection('mysql')}>
              {tr('Neue Verbindung …', 'New Connection …')}
            </Button>
          </div>
        ) : (
          <div className="ks-nav-tree-inner" style={{ height: virt.getTotalSize() }}>
            {virt.getVirtualItems().map((vi) => {
              const r = rows[vi.index];
              return (
                <div
                  key={r.key}
                  className={clsx('ks-tree-row', r.key === selectedKey && 'selected', r.ref.kind === 'connection' && 'conn')}
                  style={{ transform: `translateY(${vi.start}px)` }}
                  onMouseDown={(e) => {
                    if (e.button === 0 || e.button === 2) select(r);
                    // a click in the tree shows the objects list, even when a table or query tab is active
                    if (e.button === 0) useTabs.getState().activate(OBJECTS_TAB);
                  }}
                  onDoubleClick={() => void openNode(r.ref)}
                  onContextMenu={(e) => {
                    select(r);
                    showContextMenu(e, menuForNode(r.ref));
                  }}
                >
                  <span style={{ width: r.depth * 16, flex: 'none' }} />
                  <span
                    className="ks-tree-twisty"
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      select(r);
                      void toggle(r);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    {r.loading ? <Spinner size={11} /> : r.expandable ? r.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
                  </span>
                  <ObjIcon kind={r.kind} dim={r.dim} size={16} />
                  <span className="ks-tree-label">{highlight(r.label, filter)}</span>
                  {r.color && <span className="ks-tree-color" style={{ background: r.color }} />}
                  {r.hint && <span className="ks-tree-hint">{r.hint}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="ks-nav-footer">
        <SearchInput value={filter} onChange={(v) => useNav.getState().setFilter(v)} placeholder={tr('Objekte filtern', 'Filter objects')} />
      </div>
    </div>
  );
}

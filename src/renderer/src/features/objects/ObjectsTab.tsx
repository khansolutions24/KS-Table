// "Objects" tab: lists databases or the objects of a category, with toolbar and context menus.

import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { FileInput, FileOutput, FolderOpen, LayoutGrid, List, Network, Pencil, Play, Plug, Plus, Trash2, Wrench } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { EventStatus, RoutineStatus, SchemaInfo, TableStatus, ViewStatus } from '@shared/types';
import { formatBytes, formatDateTime, formatNumber } from '@shared/util';
import { categoryMenu, databaseMenu, newConnectionItems, objectMenu, openObject } from '../../actions/menus';
import * as C from '../../actions/connection';
import * as D from '../../actions/database';
import * as O from '../../actions/objects';
import * as Q from '../../actions/query';
import * as T from '../../actions/tools';
import { ObjIcon } from '../../components/icons';
import { ObjectTable, type OTColumn } from '../../components/ObjectTable';
import { Button, EmptyState, IconButton, SearchInput, Spinner, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { showContextMenu, showMenuBelow } from '../../components/ui/Menu';
import { nodeKey, useCurrentContext, useInfoTarget, useNav, type Category } from '../../store/nav';
import type { TabProps } from '../../store/tabs';
import { useWorkspace, type FileItem } from '../../store/workspace';

/** Props of the ER diagram view provided by the model feature (features/model/ErDiagramView.tsx) */
export interface ErViewProps {
  connectionId: string;
  database: string;
  selected: string[];
  onSelect: (tables: string[]) => void;
  onOpen: (table: string) => void;
}

const usersModules = import.meta.glob<{ default: ComponentType<{ connectionId: string }> }>('../users/UsersPane.tsx');
const erModules = import.meta.glob<{ default: ComponentType<ErViewProps> }>('../model/ErDiagramView.tsx');
const UsersPane = usersModules['../users/UsersPane.tsx'] ? lazy(usersModules['../users/UsersPane.tsx']) : null;
const ErView = erModules['../model/ErDiagramView.tsx'] ? lazy(erModules['../model/ErDiagramView.tsx']) : null;

type Item =
  | { k: 'db'; key: string; name: string; data: SchemaInfo }
  | { k: 'table'; key: string; name: string; data: TableStatus }
  | { k: 'view'; key: string; name: string; data: ViewStatus }
  | { k: 'routine'; key: string; name: string; data: RoutineStatus }
  | { k: 'event'; key: string; name: string; data: EventStatus }
  | { k: 'query'; key: string; name: string; data: FileItem }
  | { k: 'backup'; key: string; name: string; data: FileItem };

const dt = (s: string | null | undefined) => (s ? s.replace('T', ' ').slice(0, 19) : '');

function objRef(i: Item): O.ObjRef | null {
  switch (i.k) {
    case 'table':
      return { type: 'table', name: i.name };
    case 'view':
      return { type: 'view', name: i.name };
    case 'routine':
      return { type: i.data.type === 'FUNCTION' ? 'function' : 'procedure', name: i.name };
    case 'event':
      return { type: 'event', name: i.name };
    case 'query':
      return { type: 'query', name: i.name, path: i.data.path };
    case 'backup':
      return { type: 'backup', name: i.name, path: i.data.path };
    default:
      return null;
  }
}

function iconOf(i: Item): ReactNode {
  switch (i.k) {
    case 'db':
      return <ObjIcon kind="database" />;
    case 'routine':
      return <ObjIcon kind={i.data.type === 'FUNCTION' ? 'function' : 'procedure'} />;
    default:
      return <ObjIcon kind={i.k} />;
  }
}

function columnsFor(cat: Category | 'databases'): OTColumn<Item>[] {
  const name: OTColumn<Item> = { id: 'name', label: tr('Name', 'Name'), width: 260, render: (i) => i.name, sortValue: (i) => i.name };
  switch (cat) {
    case 'databases':
      return [
        name,
        { id: 'charset', label: tr('Zeichensatz', 'Character Set'), width: 130, render: (i) => (i.k === 'db' ? i.data.charset : ''), sortValue: (i) => (i.k === 'db' ? i.data.charset : '') },
        { id: 'collation', label: tr('Sortierung', 'Collation'), width: 190, render: (i) => (i.k === 'db' ? i.data.collation : ''), sortValue: (i) => (i.k === 'db' ? i.data.collation : '') }
      ];
    case 'tables': {
      const t = (i: Item) => (i.k === 'table' ? i.data : null);
      return [
        name,
        { id: 'rows', label: tr('Zeilen', 'Rows'), width: 90, align: 'right', render: (i) => formatNumber(t(i)?.rows), sortValue: (i) => t(i)?.rows ?? null },
        { id: 'size', label: tr('Datenlänge', 'Data Length'), width: 100, align: 'right', render: (i) => formatBytes(t(i)?.dataLength), sortValue: (i) => t(i)?.dataLength ?? null },
        { id: 'engine', label: 'Engine', width: 90, render: (i) => t(i)?.engine ?? '', sortValue: (i) => t(i)?.engine ?? '' },
        { id: 'ai', label: 'Auto Increment', width: 110, align: 'right', render: (i) => formatNumber(t(i)?.autoIncrement), sortValue: (i) => t(i)?.autoIncrement ?? null },
        {
          id: 'updated',
          label: tr('Änderungsdatum', 'Modified'),
          width: 150,
          render: (i) => dt(t(i)?.updateTime ?? t(i)?.createTime),
          sortValue: (i) => t(i)?.updateTime ?? t(i)?.createTime ?? ''
        },
        { id: 'collation', label: tr('Sortierung', 'Collation'), width: 160, render: (i) => t(i)?.collation ?? '', sortValue: (i) => t(i)?.collation ?? '' },
        { id: 'comment', label: tr('Kommentar', 'Comment'), width: 260, render: (i) => t(i)?.comment ?? '', sortValue: (i) => t(i)?.comment ?? '' }
      ];
    }
    case 'views': {
      const v = (i: Item) => (i.k === 'view' ? i.data : null);
      return [
        name,
        { id: 'definer', label: 'Definer', width: 170, render: (i) => v(i)?.definer ?? '', sortValue: (i) => v(i)?.definer ?? '' },
        { id: 'security', label: tr('Sicherheit', 'Security'), width: 90, render: (i) => v(i)?.securityType ?? '', sortValue: (i) => v(i)?.securityType ?? '' },
        { id: 'check', label: tr('Prüfoption', 'Check Option'), width: 110, render: (i) => v(i)?.checkOption ?? '', sortValue: (i) => v(i)?.checkOption ?? '' },
        {
          id: 'upd',
          label: tr('Aktualisierbar', 'Updatable'),
          width: 110,
          render: (i) => (v(i)?.isUpdatable ? tr('Ja', 'Yes') : tr('Nein', 'No')),
          sortValue: (i) => (v(i)?.isUpdatable ? 1 : 0)
        }
      ];
    }
    case 'functions': {
      const r = (i: Item) => (i.k === 'routine' ? i.data : null);
      return [
        name,
        {
          id: 'type',
          label: tr('Typ', 'Type'),
          width: 100,
          render: (i) => (r(i)?.type === 'FUNCTION' ? tr('Funktion', 'Function') : tr('Prozedur', 'Procedure')),
          sortValue: (i) => r(i)?.type ?? ''
        },
        { id: 'returns', label: tr('Rückgabetyp', 'Returns'), width: 140, render: (i) => r(i)?.returns ?? '', sortValue: (i) => r(i)?.returns ?? '' },
        { id: 'definer', label: 'Definer', width: 160, render: (i) => r(i)?.definer ?? '', sortValue: (i) => r(i)?.definer ?? '' },
        { id: 'modified', label: tr('Änderungsdatum', 'Modified'), width: 150, render: (i) => dt(r(i)?.modified), sortValue: (i) => r(i)?.modified ?? '' },
        { id: 'comment', label: tr('Kommentar', 'Comment'), width: 240, render: (i) => r(i)?.comment ?? '', sortValue: (i) => r(i)?.comment ?? '' }
      ];
    }
    case 'events': {
      const e = (i: Item) => (i.k === 'event' ? i.data : null);
      const schedule = (x: EventStatus | null) =>
        !x ? '' : x.eventType === 'ONE TIME' ? `AT ${dt(x.executeAt)}` : `EVERY ${x.intervalValue ?? ''} ${x.intervalField ?? ''}`;
      return [
        name,
        { id: 'status', label: tr('Status', 'Status'), width: 100, render: (i) => e(i)?.status ?? '', sortValue: (i) => e(i)?.status ?? '' },
        { id: 'schedule', label: tr('Zeitplan', 'Schedule'), width: 190, render: (i) => schedule(e(i)), sortValue: (i) => schedule(e(i)) },
        { id: 'starts', label: tr('Beginnt', 'Starts'), width: 150, render: (i) => dt(e(i)?.starts), sortValue: (i) => e(i)?.starts ?? '' },
        { id: 'ends', label: tr('Endet', 'Ends'), width: 150, render: (i) => dt(e(i)?.ends), sortValue: (i) => e(i)?.ends ?? '' },
        { id: 'last', label: tr('Zuletzt ausgeführt', 'Last Executed'), width: 150, render: (i) => dt(e(i)?.lastExecuted), sortValue: (i) => e(i)?.lastExecuted ?? '' },
        { id: 'comment', label: tr('Kommentar', 'Comment'), width: 220, render: (i) => e(i)?.comment ?? '', sortValue: (i) => e(i)?.comment ?? '' }
      ];
    }
    default: {
      const f = (i: Item) => (i.k === 'query' || i.k === 'backup' ? i.data : null);
      return [
        name,
        {
          id: 'mtime',
          label: cat === 'backups' ? tr('Erstellt', 'Created') : tr('Änderungsdatum', 'Modified'),
          width: 160,
          render: (i) => (f(i) ? formatDateTime(f(i)!.mtime) : ''),
          sortValue: (i) => f(i)?.mtime ?? 0
        },
        { id: 'size', label: tr('Größe', 'Size'), width: 100, align: 'right', render: (i) => formatBytes(f(i)?.size), sortValue: (i) => f(i)?.size ?? 0 }
      ];
    }
  }
}

const loadingPane = (
  <div className="ks-tab-loading">
    <Spinner size={22} />
  </div>
);

export default function ObjectsTab({ active }: TabProps) {
  const ctx = useCurrentContext();
  const conn = useWorkspace((s) => (ctx.connectionId ? s.conns[ctx.connectionId] : undefined));
  const profile = useWorkspace((s) => s.profiles.find((p) => p.id === ctx.connectionId));
  const dbState = ctx.database && conn ? conn.dbs[ctx.database] : undefined;
  const [mode, setMode] = useState<'detail' | 'list' | 'er'>('detail');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const cid = ctx.connectionId;
  const db = ctx.database;
  const view: Category | 'databases' = ctx.category === 'users' ? 'users' : db ? ctx.category : 'databases';
  const effectiveMode = mode === 'er' && (view !== 'tables' || !ErView) ? 'detail' : mode;

  useEffect(() => {
    if (cid && db && conn?.status === 'open' && !dbState?.loaded && !dbState?.loading) {
      void useWorkspace.getState().openDatabase(cid, db);
    }
  }, [cid, db, conn?.status, dbState?.loaded, dbState?.loading]);

  useEffect(() => setSelected([]), [cid, db, view]);

  const items: Item[] = useMemo(() => {
    if (!conn || conn.status !== 'open') return [];
    const all: Item[] = (() => {
      if (view === 'databases') return conn.databases.map((d) => ({ k: 'db' as const, key: `db:${d.name}`, name: d.name, data: d }));
      if (!dbState) return [];
      switch (view) {
        case 'tables':
          return dbState.tables.map((t) => ({ k: 'table' as const, key: `t:${t.name}`, name: t.name, data: t }));
        case 'views':
          return dbState.views.map((v) => ({ k: 'view' as const, key: `v:${v.name}`, name: v.name, data: v }));
        case 'functions':
          return dbState.routines.map((r) => ({ k: 'routine' as const, key: `r:${r.type}:${r.name}`, name: r.name, data: r }));
        case 'events':
          return dbState.events.map((e) => ({ k: 'event' as const, key: `e:${e.name}`, name: e.name, data: e }));
        case 'queries':
          return dbState.queries.map((q) => ({ k: 'query' as const, key: `q:${q.path}`, name: q.name, data: q }));
        case 'backups':
          return dbState.backups.map((b) => ({ k: 'backup' as const, key: `b:${b.path}`, name: b.name, data: b }));
        default:
          return [];
      }
    })();
    const f = search.trim().toLowerCase();
    return f ? all.filter((i) => i.name.toLowerCase().includes(f)) : all;
  }, [conn, dbState, view, search]);

  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const selItems = selected.map((k) => byKey.get(k)).filter((x): x is Item => !!x);
  const selRefs = selItems.map(objRef).filter((x): x is O.ObjRef => !!x);
  const first = selItems[0];

  useEffect(() => {
    if (!active || !cid) return;
    const t = useInfoTarget.getState();
    if (selItems.length === 1 && first) {
      if (first.k === 'db') t.set({ connectionId: cid, database: first.name, objectType: 'database', name: first.name });
      else {
        const r = objRef(first);
        if (r && db) t.set({ connectionId: cid, database: db, objectType: r.type, name: r.name });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.join('|'), active]);

  if (!cid || !profile) {
    return (
      <div className="ks-objects">
        <EmptyState icon={<ObjIcon kind="connection" size={44} dim />} title={tr('Keine Verbindung ausgewählt', 'No connection selected')}>
          <p>{tr('Wählen Sie links eine Verbindung aus oder legen Sie eine neue an.', 'Select a connection on the left or create a new one.')}</p>
          <Button variant="primary" icon={<Plus size={15} />} onClick={(e) => showMenuBelow(e.currentTarget, newConnectionItems())}>
            {tr('Neue Verbindung', 'New Connection')}
          </Button>
        </EmptyState>
      </div>
    );
  }

  if (conn?.status !== 'open') {
    return (
      <div className="ks-objects">
        <EmptyState icon={<ObjIcon kind="connection" size={44} dim />} title={profile.name}>
          {conn?.status === 'connecting' ? (
            <Spinner size={22} />
          ) : (
            <>
              <p>{conn?.status === 'error' ? conn.error : tr('Die Verbindung ist geschlossen.', 'The connection is closed.')}</p>
              <Button variant="primary" icon={<Plug size={15} />} onClick={() => void C.openConnection(cid)}>
                {tr('Verbindung öffnen', 'Open Connection')}
              </Button>
            </>
          )}
        </EmptyState>
      </div>
    );
  }

  if (view === 'users') {
    return (
      <div className="ks-objects">
        {UsersPane ? (
          <Suspense fallback={loadingPane}>
            <UsersPane connectionId={cid} />
          </Suspense>
        ) : (
          <EmptyState icon={<ObjIcon kind="user" size={40} />} title={tr('Benutzerverwaltung', 'User management')}>
            {tr('Dieses Modul wird gerade entwickelt.', 'This module is under development.')}
          </EmptyState>
        )}
      </div>
    );
  }

  const open = (i: Item) => {
    if (i.k === 'db') {
      useNav.getState().select(nodeKey({ kind: 'database', connectionId: cid, database: i.name }));
      void D.openDatabase(cid, i.name);
      return;
    }
    if (db) openObject(cid, db, objRef(i));
  };

  const onMenu = (e: React.MouseEvent, row: Item | null, keys: string[]) => {
    const rows = keys.map((k) => byKey.get(k)).filter((x): x is Item => !!x);
    if (view === 'databases') {
      if (row?.k === 'db') showContextMenu(e, databaseMenu(cid, row.name));
      return;
    }
    if (!db) return;
    const refs = rows.map(objRef).filter((x): x is O.ObjRef => !!x);
    showContextMenu(e, refs.length ? objectMenu(cid, db, refs) : categoryMenu(cid, db, view as Category));
  };

  const onKey = (combo: string, keys: string[]): boolean => {
    const rows = keys.map((k) => byKey.get(k)).filter((x): x is Item => !!x);
    if (!rows.length) return false;
    if (view === 'databases') {
      if (combo === 'Delete' && rows.length === 1) {
        void D.dropDatabase(cid, rows[0].name);
        return true;
      }
      return false;
    }
    if (!db) return false;
    const refs = rows.map(objRef).filter((x): x is O.ObjRef => !!x);
    if (combo === 'Delete') void O.dropObjects(cid, db, refs);
    else if (combo === 'F2' && refs.length === 1) void O.renameObject(cid, db, refs[0]);
    else if (combo === 'Ctrl+C') O.copyNames(refs.map((r) => r.name));
    else if (combo === 'F5') void O.refreshObjects(cid, db);
    else return false;
    return true;
  };

  const tb = (icon: ReactNode, label: string, onClick: () => void, disabled = false) => (
    <ToolbarButton icon={icon} label={label} onClick={onClick} disabled={disabled} />
  );
  const one = selRefs.length === 1 ? selRefs[0] : null;

  let toolbar: ReactNode = null;
  if (view === 'databases') {
    const d = first?.k === 'db' ? first.name : null;
    toolbar = (
      <>
        {tb(<ObjIcon kind="database" />, tr('Datenbank öffnen', 'Open Database'), () => d && open(first!), !d)}
        {tb(<Plus size={15} />, tr('Neue Datenbank', 'New Database'), () => void D.newDatabase(cid))}
        {tb(<Pencil size={15} />, tr('Datenbank bearbeiten', 'Edit Database'), () => d && void D.editDatabase(cid, d), !d)}
        {tb(<Trash2 size={15} />, tr('Datenbank löschen', 'Delete Database'), () => d && void D.dropDatabase(cid, d), !d)}
      </>
    );
  } else if (db) {
    switch (view) {
      case 'tables':
        toolbar = (
          <>
            {tb(<ObjIcon kind="table" />, tr('Tabelle öffnen', 'Open Table'), () => one && O.openTable(cid, db, one.name), !one)}
            {tb(<Wrench size={15} />, tr('Tabelle entwerfen', 'Design Table'), () => one && O.designTable(cid, db, one.name), !one)}
            {tb(<Plus size={15} />, tr('Neue Tabelle', 'New Table'), () => O.designTable(cid, db, null))}
            {tb(<Trash2 size={15} />, tr('Tabelle löschen', 'Delete Table'), () => void O.dropObjects(cid, db, selRefs), !selRefs.length)}
            <ToolbarSep />
            {tb(<FileInput size={15} />, tr('Import-Assistent', 'Import Wizard'), () => T.openImportWizard(cid, db, one?.name ?? null))}
            {tb(<FileOutput size={15} />, tr('Export-Assistent', 'Export Wizard'), () => T.openExportWizard(cid, db, selRefs.length ? selRefs.map((r) => r.name) : null))}
          </>
        );
        break;
      case 'views':
        toolbar = (
          <>
            {tb(<ObjIcon kind="view" />, tr('Ansicht öffnen', 'Open View'), () => one && O.openTable(cid, db, one.name, true), !one)}
            {tb(<Wrench size={15} />, tr('Ansicht entwerfen', 'Design View'), () => one && O.designView(cid, db, one.name), !one)}
            {tb(<Plus size={15} />, tr('Neue Ansicht', 'New View'), () => O.designView(cid, db, null))}
            {tb(<Trash2 size={15} />, tr('Ansicht löschen', 'Delete View'), () => void O.dropObjects(cid, db, selRefs), !selRefs.length)}
            <ToolbarSep />
            {tb(<FileOutput size={15} />, tr('Export-Assistent', 'Export Wizard'), () => T.openExportWizard(cid, db, selRefs.map((r) => r.name)))}
          </>
        );
        break;
      case 'functions':
        toolbar = (
          <>
            {tb(<Wrench size={15} />, tr('Entwerfen', 'Design'), () => one && O.designRoutine(cid, db, one.name, one.type === 'function' ? 'FUNCTION' : 'PROCEDURE'), !one)}
            <ToolbarButton
              icon={<Plus size={15} />}
              label={tr('Neu', 'New')}
              onDropdown={(e) =>
                showMenuBelow(e.currentTarget, [
                  { label: tr('Funktion', 'Function'), icon: <ObjIcon kind="function" size={14} />, onClick: () => O.designRoutine(cid, db, null, 'FUNCTION') },
                  { label: tr('Prozedur', 'Procedure'), icon: <ObjIcon kind="procedure" size={14} />, onClick: () => O.designRoutine(cid, db, null, 'PROCEDURE') }
                ])
              }
              onClick={() => O.designRoutine(cid, db, null, 'PROCEDURE')}
            />
            {tb(<Trash2 size={15} />, tr('Löschen', 'Delete'), () => void O.dropObjects(cid, db, selRefs), !selRefs.length)}
            {tb(<Play size={15} />, tr('Ausführen', 'Execute'), () => one && void O.executeRoutine(cid, db, one.name, one.type === 'function' ? 'FUNCTION' : 'PROCEDURE'), !one)}
          </>
        );
        break;
      case 'events':
        toolbar = (
          <>
            {tb(<Wrench size={15} />, tr('Ereignis entwerfen', 'Design Event'), () => one && O.designEvent(cid, db, one.name), !one)}
            {tb(<Plus size={15} />, tr('Neues Ereignis', 'New Event'), () => O.designEvent(cid, db, null))}
            {tb(<Trash2 size={15} />, tr('Ereignis löschen', 'Delete Event'), () => void O.dropObjects(cid, db, selRefs), !selRefs.length)}
          </>
        );
        break;
      case 'queries':
        toolbar = (
          <>
            {tb(<FolderOpen size={15} />, tr('Abfrage öffnen', 'Open Query'), () => one?.path && Q.openSavedQuery(cid, db, one.path), !one)}
            {tb(<Plus size={15} />, tr('Neue Abfrage', 'New Query'), () => Q.newQuery(cid, db))}
            {tb(<Trash2 size={15} />, tr('Abfrage löschen', 'Delete Query'), () => void O.dropObjects(cid, db, selRefs), !selRefs.length)}
          </>
        );
        break;
      case 'backups':
        toolbar = (
          <>
            {tb(<Plus size={15} />, tr('Neue Sicherung', 'New Backup'), () => T.openBackup(cid, db))}
            {tb(<ObjIcon kind="backup" />, tr('Wiederherstellen', 'Restore'), () => one?.path && T.restoreBackup(cid, db, one.path), !one)}
            {tb(<FileOutput size={15} />, tr('SQL extrahieren', 'Extract SQL'), () => one?.path && T.extractBackupSql(cid, db, one.path), !one)}
            {tb(<Trash2 size={15} />, tr('Löschen', 'Delete'), () => void O.dropObjects(cid, db, selRefs), !selRefs.length)}
          </>
        );
        break;
    }
  }

  const loading = !!db && (!dbState || dbState.loading) && !dbState?.loaded;
  const tableNames = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((x): x is Item => !!x && x.k === 'table').map((x) => x.name);

  return (
    <div className="ks-objects">
      <Toolbar>
        {toolbar}
        <div className="spacer" />
        <SearchInput value={search} onChange={setSearch} className="ks-objects-search" placeholder={tr('Suchen', 'Search')} />
        <IconButton icon={<List size={15} />} title={tr('Details', 'Detail')} active={effectiveMode === 'detail'} onClick={() => setMode('detail')} />
        <IconButton icon={<LayoutGrid size={15} />} title={tr('Liste', 'List')} active={effectiveMode === 'list'} onClick={() => setMode('list')} />
        {view === 'tables' && ErView && (
          <IconButton icon={<Network size={15} />} title={tr('ER-Diagramm', 'ER Diagram')} active={effectiveMode === 'er'} onClick={() => setMode('er')} />
        )}
      </Toolbar>
      <div className="ks-objects-body">
        {loading ? (
          loadingPane
        ) : effectiveMode === 'er' && ErView && db ? (
          <Suspense fallback={loadingPane}>
            <ErView
              connectionId={cid}
              database={db}
              selected={tableNames(selected)}
              onSelect={(tables) => setSelected(tables.map((t) => `t:${t}`))}
              onOpen={(table) => O.openTable(cid, db, table)}
            />
          </Suspense>
        ) : (
          <ObjectTable<Item>
            columns={columnsFor(view)}
            rows={items}
            rowKey={(i) => i.key}
            nameOf={(i) => i.name}
            iconOf={iconOf}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={open}
            onContextMenu={onMenu}
            onKey={onKey}
            mode={effectiveMode === 'list' ? 'list' : 'detail'}
            empty={<span className="faint">{search ? tr('Keine Treffer', 'No matches') : tr('Keine Objekte', 'No objects')}</span>}
          />
        )}
      </div>
      <div className="ks-objects-status">
        {selItems.length > 1
          ? tr('{s} von {n} Objekten ausgewählt', '{s} of {n} objects selected', { s: selItems.length, n: items.length })
          : first
            ? first.name
            : tr('{n} Objekte', '{n} objects', { n: items.length })}
      </div>
    </div>
  );
}

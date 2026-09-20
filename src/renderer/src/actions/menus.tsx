// Context menus and default (double click) actions for navigator / object pane nodes.

import type { ReactNode } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Copy,
  Dices,
  Eraser,
  ExternalLink,
  FileInput,
  FileOutput,
  FilePlus,
  FolderPlus,
  GitCompare,
  GitCompareArrows,
  Network,
  Palette,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  SquareTerminal,
  Trash2,
  Unplug,
  Users,
  Wrench,
  type LucideIcon
} from 'lucide-react';
import { tr } from '@shared/i18n';
import { api } from '../api/client';
import { ObjIcon } from '../components/icons';
import { SEP, type MenuItem } from '../components/ui/Menu';
import { CONNECTION_COLORS } from '../components/ui/controls';
import { currentContext, nodeKey, useNav, type Category, type NodeRef } from '../store/nav';
import { OBJECTS_TAB, useTabs } from '../store/tabs';
import { getProfile, useWorkspace } from '../store/workspace';
import * as C from './connection';
import * as D from './database';
import * as O from './objects';
import * as Q from './query';
import * as T from './tools';

const ic = (Icon: LucideIcon): ReactNode => <Icon size={14} />;
const oi = (k: Parameters<typeof ObjIcon>[0]['kind']): ReactNode => <ObjIcon kind={k} size={14} />;

export function newConnectionItems(): MenuItem[] {
  return [
    { label: 'MySQL …', icon: oi('connection'), onClick: () => void C.newConnection('mysql') },
    { label: 'MariaDB …', icon: oi('connection-mariadb'), onClick: () => void C.newConnection('mariadb') }
  ];
}

export function connectionMenu(id: string): MenuItem[] {
  const ws = useWorkspace.getState();
  const open = ws.conns[id]?.status === 'open';
  const p = getProfile(id);
  return [
    open
      ? { label: tr('Verbindung schließen', 'Close Connection'), icon: ic(Unplug), onClick: () => void C.closeConnection(id) }
      : { label: tr('Verbindung öffnen', 'Open Connection'), icon: ic(Plug), onClick: () => void C.openConnection(id) },
    SEP,
    { label: tr('Neue Verbindung', 'New Connection'), icon: ic(Plus), submenu: newConnectionItems() },
    { label: tr('Verbindung bearbeiten …', 'Edit Connection …'), icon: ic(Pencil), onClick: () => void C.editConnection(id) },
    { label: tr('Verbindung duplizieren', 'Duplicate Connection'), icon: ic(Copy), onClick: () => void C.duplicateConnection(id) },
    { label: tr('Verbindung löschen', 'Delete Connection'), icon: ic(Trash2), onClick: () => void C.deleteConnection(id) },
    SEP,
    { label: tr('Neue Datenbank …', 'New Database …'), icon: oi('database'), disabled: !open, onClick: () => void D.newDatabase(id) },
    { label: tr('Neue Abfrage', 'New Query'), icon: ic(FilePlus), shortcut: 'Ctrl+Q', onClick: () => Q.newQuery(id, null) },
    { label: tr('Befehlszeilenkonsole', 'Command Line Console'), icon: ic(SquareTerminal), disabled: !open, onClick: () => T.openConsole(id) },
    SEP,
    { label: tr('SQL-Datei ausführen …', 'Execute SQL File …'), icon: ic(FileInput), disabled: !open, onClick: () => T.executeSqlFile(id, null) },
    SEP,
    { label: tr('Benutzer verwalten', 'Manage Users'), icon: ic(Users), disabled: !open, onClick: () => showCategory('users', id) },
    { label: tr('Serverüberwachung', 'Server Monitor'), icon: ic(Activity), onClick: () => T.openServerMonitor(id) },
    SEP,
    {
      label: tr('Farbe', 'Color'),
      icon: ic(Palette),
      submenu: [
        { label: tr('Keine', 'None'), checked: !p?.color, onClick: () => void C.setConnectionColor(id, null) },
        SEP,
        ...CONNECTION_COLORS.map<MenuItem>((c) => ({
          label: c,
          checked: p?.color === c,
          icon: <span className="ks-color-dot" style={{ background: c }} />,
          onClick: () => void C.setConnectionColor(id, c)
        }))
      ]
    },
    {
      label: tr('Gruppe', 'Group'),
      icon: oi('group'),
      submenu: [
        { label: tr('Neue Gruppe …', 'New Group …'), icon: ic(FolderPlus), onClick: () => void C.newGroup(id) },
        SEP,
        { label: tr('(Keine Gruppe)', '(No group)'), checked: !p?.groupId, onClick: () => void C.moveConnectionToGroup(id, null) },
        ...ws.groups.map<MenuItem>((g) => ({
          label: g.name,
          checked: p?.groupId === g.id,
          onClick: () => void C.moveConnectionToGroup(id, g.id)
        }))
      ]
    },
    SEP,
    { label: tr('Aktualisieren', 'Refresh'), icon: ic(RefreshCw), shortcut: 'F5', disabled: !open, onClick: () => void ws.refreshConnection(id) }
  ];
}

export function groupMenu(groupId: string): MenuItem[] {
  return [
    { label: tr('Neue Verbindung', 'New Connection'), icon: ic(Plus), submenu: newConnectionItems() },
    { label: tr('Neue Gruppe …', 'New Group …'), icon: ic(FolderPlus), onClick: () => void C.newGroup() },
    SEP,
    { label: tr('Gruppe umbenennen …', 'Rename Group …'), icon: ic(Pencil), onClick: () => void C.renameGroup(groupId) },
    { label: tr('Gruppe löschen', 'Delete Group'), icon: ic(Trash2), onClick: () => void C.deleteGroup(groupId) }
  ];
}

export function emptyNavigatorMenu(): MenuItem[] {
  return [
    { label: tr('Neue Verbindung', 'New Connection'), icon: ic(Plus), submenu: newConnectionItems() },
    { label: tr('Neue Gruppe …', 'New Group …'), icon: ic(FolderPlus), onClick: () => void C.newGroup() },
    SEP,
    { label: tr('Verbindungen importieren …', 'Import Connections …'), icon: ic(FileInput), onClick: () => void C.importConnections() },
    { label: tr('Verbindungen exportieren …', 'Export Connections …'), icon: ic(FileOutput), onClick: () => void C.exportConnections() }
  ];
}

export function databaseMenu(connectionId: string, database: string): MenuItem[] {
  const st = useWorkspace.getState().conns[connectionId]?.dbs[database];
  return [
    st?.loaded
      ? { label: tr('Datenbank schließen', 'Close Database'), icon: oi('database'), onClick: () => D.closeDatabase(connectionId, database) }
      : { label: tr('Datenbank öffnen', 'Open Database'), icon: oi('database'), onClick: () => void D.openDatabase(connectionId, database) },
    SEP,
    { label: tr('Neue Datenbank …', 'New Database …'), icon: ic(Plus), onClick: () => void D.newDatabase(connectionId) },
    { label: tr('Datenbank bearbeiten …', 'Edit Database …'), icon: ic(Pencil), onClick: () => void D.editDatabase(connectionId, database) },
    { label: tr('Datenbank löschen', 'Delete Database'), icon: ic(Trash2), onClick: () => void D.dropDatabase(connectionId, database) },
    SEP,
    { label: tr('Neue Abfrage', 'New Query'), icon: ic(FilePlus), shortcut: 'Ctrl+Q', onClick: () => Q.newQuery(connectionId, database) },
    { label: tr('Befehlszeilenkonsole', 'Command Line Console'), icon: ic(SquareTerminal), onClick: () => T.openConsole(connectionId) },
    SEP,
    { label: tr('SQL-Datei ausführen …', 'Execute SQL File …'), icon: ic(FileInput), onClick: () => T.executeSqlFile(connectionId, database) },
    {
      label: tr('SQL-Datei ausgeben', 'Dump SQL File'),
      icon: ic(FileOutput),
      submenu: [
        { label: tr('Struktur und Daten …', 'Structure and Data …'), onClick: () => T.dumpSqlFile(connectionId, database, null, false) },
        { label: tr('Nur Struktur …', 'Structure Only …'), onClick: () => T.dumpSqlFile(connectionId, database, null, true) }
      ]
    },
    SEP,
    { label: tr('Datenübertragung …', 'Data Transfer …'), icon: ic(ArrowLeftRight), onClick: () => T.openDataTransfer(connectionId, database) },
    { label: tr('Datensynchronisation …', 'Data Synchronization …'), icon: ic(GitCompareArrows), onClick: () => T.openDataSync(connectionId, database) },
    { label: tr('Struktursynchronisation …', 'Structure Synchronization …'), icon: ic(GitCompare), onClick: () => T.openStructSync(connectionId, database) },
    SEP,
    { label: tr('Sicherung erstellen …', 'Backup …'), icon: oi('backup'), onClick: () => T.openBackup(connectionId, database) },
    { label: tr('Suche in Datenbank …', 'Find in Database …'), icon: ic(Search), onClick: () => T.findInDatabase(connectionId, database) },
    { label: tr('Datengenerator …', 'Data Generator …'), icon: ic(Dices), onClick: () => T.openDataGenerator(connectionId, database) },
    { label: tr('Datenbank in Modell umwandeln', 'Reverse Database to Model'), icon: ic(Network), onClick: () => T.reverseToModel(connectionId, database) },
    SEP,
    { label: tr('Aktualisieren', 'Refresh'), icon: ic(RefreshCw), shortcut: 'F5', onClick: () => void useWorkspace.getState().refreshDatabase(connectionId, database) }
  ];
}

export function categoryMenu(connectionId: string, database: string, category: Category): MenuItem[] {
  const refresh: MenuItem = {
    label: tr('Aktualisieren', 'Refresh'),
    icon: ic(RefreshCw),
    shortcut: 'F5',
    onClick: () => void refreshNode({ kind: 'category', connectionId, database, category })
  };
  switch (category) {
    case 'tables':
      return [
        { label: tr('Neue Tabelle', 'New Table'), icon: oi('table'), onClick: () => O.designTable(connectionId, database, null) },
        SEP,
        { label: tr('Import-Assistent …', 'Import Wizard …'), icon: ic(FileInput), onClick: () => T.openImportWizard(connectionId, database) },
        { label: tr('Export-Assistent …', 'Export Wizard …'), icon: ic(FileOutput), onClick: () => T.openExportWizard(connectionId, database) },
        SEP,
        refresh
      ];
    case 'views':
      return [{ label: tr('Neue Ansicht', 'New View'), icon: oi('view'), onClick: () => O.designView(connectionId, database, null) }, SEP, refresh];
    case 'functions':
      return [
        { label: tr('Neue Funktion', 'New Function'), icon: oi('function'), onClick: () => O.designRoutine(connectionId, database, null, 'FUNCTION') },
        { label: tr('Neue Prozedur', 'New Procedure'), icon: oi('procedure'), onClick: () => O.designRoutine(connectionId, database, null, 'PROCEDURE') },
        SEP,
        refresh
      ];
    case 'events':
      return [{ label: tr('Neues Ereignis', 'New Event'), icon: oi('event'), onClick: () => O.designEvent(connectionId, database, null) }, SEP, refresh];
    case 'queries':
      return [{ label: tr('Neue Abfrage', 'New Query'), icon: oi('query'), onClick: () => Q.newQuery(connectionId, database) }, SEP, refresh];
    case 'backups':
      return [{ label: tr('Neue Sicherung …', 'New Backup …'), icon: oi('backup'), onClick: () => T.openBackup(connectionId, database) }, SEP, refresh];
    default:
      return [refresh];
  }
}

export function objectMenu(connectionId: string, database: string, objs: O.ObjRef[]): MenuItem[] {
  if (!objs.length) return [];
  const first = objs[0];
  const one = objs.length === 1;
  const names = objs.map((o) => o.name);
  const refresh: MenuItem = {
    label: tr('Aktualisieren', 'Refresh'),
    icon: ic(RefreshCw),
    shortcut: 'F5',
    onClick: () => void O.refreshObjects(connectionId, database, [first.type])
  };
  const common: MenuItem[] = [
    { label: tr('Umbenennen …', 'Rename …'), icon: ic(Pencil), shortcut: 'F2', disabled: !one, onClick: () => void O.renameObject(connectionId, database, first) },
    { label: tr('Name kopieren', 'Copy Name'), icon: ic(Copy), shortcut: 'Ctrl+C', onClick: () => O.copyNames(names) }
  ];
  switch (first.type) {
    case 'table':
      return [
        { label: tr('Tabelle öffnen', 'Open Table'), icon: oi('table'), disabled: !one, onClick: () => O.openTable(connectionId, database, first.name) },
        { label: tr('Tabelle entwerfen', 'Design Table'), icon: ic(Wrench), disabled: !one, onClick: () => O.designTable(connectionId, database, first.name) },
        { label: tr('Neue Tabelle', 'New Table'), icon: ic(Plus), onClick: () => O.designTable(connectionId, database, null) },
        { label: tr('Tabelle löschen', 'Delete Table'), icon: ic(Trash2), shortcut: 'Del', onClick: () => void O.dropObjects(connectionId, database, objs) },
        { label: tr('Tabelle leeren', 'Empty Table'), icon: ic(Eraser), onClick: () => void O.emptyTables(connectionId, database, names, false) },
        { label: tr('Tabelle kürzen', 'Truncate Table'), icon: ic(Scissors), onClick: () => void O.emptyTables(connectionId, database, names, true) },
        {
          label: tr('Tabelle duplizieren', 'Duplicate Table'),
          icon: ic(Copy),
          disabled: !one,
          submenu: [
            { label: tr('Struktur und Daten', 'Structure and Data'), onClick: () => void O.duplicateTable(connectionId, database, first.name, true) },
            { label: tr('Nur Struktur', 'Structure Only'), onClick: () => void O.duplicateTable(connectionId, database, first.name, false) }
          ]
        },
        SEP,
        { label: tr('Import-Assistent …', 'Import Wizard …'), icon: ic(FileInput), disabled: !one, onClick: () => T.openImportWizard(connectionId, database, first.name) },
        { label: tr('Export-Assistent …', 'Export Wizard …'), icon: ic(FileOutput), onClick: () => T.openExportWizard(connectionId, database, names) },
        {
          label: tr('SQL-Datei ausgeben', 'Dump SQL File'),
          icon: ic(FileOutput),
          submenu: [
            { label: tr('Struktur und Daten …', 'Structure and Data …'), onClick: () => T.dumpSqlFile(connectionId, database, names, false) },
            { label: tr('Nur Struktur …', 'Structure Only …'), onClick: () => T.dumpSqlFile(connectionId, database, names, true) }
          ]
        },
        { label: tr('Datenübertragung …', 'Data Transfer …'), icon: ic(ArrowLeftRight), onClick: () => T.openDataTransfer(connectionId, database, names) },
        { label: tr('Testdaten generieren …', 'Generate Data …'), icon: ic(Dices), onClick: () => T.openDataGenerator(connectionId, database, names) },
        SEP,
        {
          label: tr('Wartung', 'Maintenance'),
          icon: ic(Wrench),
          submenu: [
            { label: tr('Tabelle analysieren', 'Analyze Table'), onClick: () => void O.maintainTables(connectionId, database, names, 'ANALYZE') },
            { label: tr('Tabelle prüfen', 'Check Table'), onClick: () => void O.maintainTables(connectionId, database, names, 'CHECK') },
            {
              label: tr('Tabelle prüfen (erweitert)', 'Check Table (extended)'),
              onClick: () => void O.maintainTables(connectionId, database, names, 'CHECK', 'EXTENDED')
            },
            { label: tr('Tabelle optimieren', 'Optimize Table'), onClick: () => void O.maintainTables(connectionId, database, names, 'OPTIMIZE') },
            { label: tr('Tabelle reparieren', 'Repair Table'), onClick: () => void O.maintainTables(connectionId, database, names, 'REPAIR') },
            { label: tr('Prüfsumme berechnen', 'Checksum Table'), onClick: () => void O.maintainTables(connectionId, database, names, 'CHECKSUM') }
          ]
        },
        SEP,
        ...common,
        SEP,
        refresh
      ];
    case 'view':
      return [
        { label: tr('Ansicht öffnen', 'Open View'), icon: oi('view'), disabled: !one, onClick: () => O.openTable(connectionId, database, first.name, true) },
        { label: tr('Ansicht entwerfen', 'Design View'), icon: ic(Wrench), disabled: !one, onClick: () => O.designView(connectionId, database, first.name) },
        { label: tr('Neue Ansicht', 'New View'), icon: ic(Plus), onClick: () => O.designView(connectionId, database, null) },
        { label: tr('Ansicht löschen', 'Delete View'), icon: ic(Trash2), shortcut: 'Del', onClick: () => void O.dropObjects(connectionId, database, objs) },
        SEP,
        { label: tr('Export-Assistent …', 'Export Wizard …'), icon: ic(FileOutput), onClick: () => T.openExportWizard(connectionId, database, names) },
        SEP,
        ...common,
        SEP,
        refresh
      ];
    case 'function':
    case 'procedure':
      return [
        {
          label: first.type === 'function' ? tr('Funktion entwerfen', 'Design Function') : tr('Prozedur entwerfen', 'Design Procedure'),
          icon: ic(Wrench),
          disabled: !one,
          onClick: () => O.designRoutine(connectionId, database, first.name, first.type === 'function' ? 'FUNCTION' : 'PROCEDURE')
        },
        {
          label: tr('Ausführen', 'Execute'),
          icon: ic(Play),
          disabled: !one,
          onClick: () => void O.executeRoutine(connectionId, database, first.name, first.type === 'function' ? 'FUNCTION' : 'PROCEDURE')
        },
        { label: tr('Neue Funktion', 'New Function'), icon: oi('function'), onClick: () => O.designRoutine(connectionId, database, null, 'FUNCTION') },
        { label: tr('Neue Prozedur', 'New Procedure'), icon: oi('procedure'), onClick: () => O.designRoutine(connectionId, database, null, 'PROCEDURE') },
        { label: tr('Löschen', 'Delete'), icon: ic(Trash2), shortcut: 'Del', onClick: () => void O.dropObjects(connectionId, database, objs) },
        SEP,
        { label: tr('Name kopieren', 'Copy Name'), icon: ic(Copy), onClick: () => O.copyNames(names) },
        SEP,
        refresh
      ];
    case 'event':
      return [
        { label: tr('Ereignis entwerfen', 'Design Event'), icon: ic(Wrench), disabled: !one, onClick: () => O.designEvent(connectionId, database, first.name) },
        { label: tr('Neues Ereignis', 'New Event'), icon: ic(Plus), onClick: () => O.designEvent(connectionId, database, null) },
        { label: tr('Ereignis löschen', 'Delete Event'), icon: ic(Trash2), shortcut: 'Del', onClick: () => void O.dropObjects(connectionId, database, objs) },
        SEP,
        ...common,
        SEP,
        refresh
      ];
    case 'query':
      return [
        { label: tr('Abfrage öffnen', 'Open Query'), icon: oi('query'), disabled: !one || !first.path, onClick: () => first.path && Q.openSavedQuery(connectionId, database, first.path) },
        { label: tr('Neue Abfrage', 'New Query'), icon: ic(Plus), onClick: () => Q.newQuery(connectionId, database) },
        { label: tr('Abfrage löschen', 'Delete Query'), icon: ic(Trash2), shortcut: 'Del', onClick: () => void O.dropObjects(connectionId, database, objs) },
        SEP,
        ...common,
        { label: tr('Im Explorer anzeigen', 'Show in Explorer'), icon: ic(ExternalLink), disabled: !one, onClick: () => first.path && void api.app.showItemInFolder(first.path) },
        SEP,
        refresh
      ];
    default:
      return [
        { label: tr('Sicherung wiederherstellen …', 'Restore Backup …'), icon: oi('backup'), disabled: !one, onClick: () => first.path && T.restoreBackup(connectionId, database, first.path) },
        { label: tr('SQL extrahieren …', 'Extract SQL …'), icon: ic(FileOutput), disabled: !one, onClick: () => first.path && T.extractBackupSql(connectionId, database, first.path) },
        { label: tr('Neue Sicherung …', 'New Backup …'), icon: ic(Plus), onClick: () => T.openBackup(connectionId, database) },
        { label: tr('Sicherung löschen', 'Delete Backup'), icon: ic(Trash2), shortcut: 'Del', onClick: () => void O.dropObjects(connectionId, database, objs) },
        SEP,
        { label: tr('Im Explorer anzeigen', 'Show in Explorer'), icon: ic(ExternalLink), disabled: !one, onClick: () => first.path && void api.app.showItemInFolder(first.path) },
        SEP,
        refresh
      ];
  }
}

/** Object reference for a navigator node (resolves file paths of saved queries / backups). */
export function objRefOf(ref: NodeRef): O.ObjRef | null {
  if (ref.kind !== 'object' || !ref.objectType || !ref.name || !ref.connectionId || !ref.database) return null;
  const o: O.ObjRef = { type: ref.objectType, name: ref.name };
  if (ref.objectType === 'query' || ref.objectType === 'backup') {
    const st = useWorkspace.getState().conns[ref.connectionId]?.dbs[ref.database];
    const list = ref.objectType === 'query' ? st?.queries : st?.backups;
    o.path = list?.find((f) => f.name === ref.name)?.path;
  }
  return o;
}

export function menuForNode(ref: NodeRef): MenuItem[] {
  switch (ref.kind) {
    case 'group':
      return groupMenu(ref.groupId!);
    case 'connection':
      return connectionMenu(ref.connectionId!);
    case 'database':
      return databaseMenu(ref.connectionId!, ref.database!);
    case 'category':
      return categoryMenu(ref.connectionId!, ref.database!, ref.category!);
    default: {
      const o = objRefOf(ref);
      return o ? objectMenu(ref.connectionId!, ref.database!, [o]) : [];
    }
  }
}

export async function openNode(ref: NodeRef): Promise<void> {
  const nav = useNav.getState();
  const key = nodeKey(ref);
  switch (ref.kind) {
    case 'group':
    case 'category':
      nav.setExpanded(key, !(nav.expanded[key] ?? ref.kind === 'group'));
      return;
    case 'connection': {
      const st = useWorkspace.getState().conns[ref.connectionId!]?.status;
      if (st === 'open') nav.setExpanded(key, !nav.expanded[key]);
      else await C.openConnection(ref.connectionId!);
      return;
    }
    case 'database':
      await D.toggleDatabase(ref.connectionId!, ref.database!);
      return;
    default:
      openObject(ref.connectionId!, ref.database!, objRefOf(ref));
  }
}

export function openObject(connectionId: string, database: string, o: O.ObjRef | null): void {
  if (!o) return;
  switch (o.type) {
    case 'table':
      O.openTable(connectionId, database, o.name);
      break;
    case 'view':
      O.openTable(connectionId, database, o.name, true);
      break;
    case 'function':
      O.designRoutine(connectionId, database, o.name, 'FUNCTION');
      break;
    case 'procedure':
      O.designRoutine(connectionId, database, o.name, 'PROCEDURE');
      break;
    case 'event':
      O.designEvent(connectionId, database, o.name);
      break;
    case 'query':
      if (o.path) Q.openSavedQuery(connectionId, database, o.path);
      break;
    case 'backup':
      if (o.path) T.restoreBackup(connectionId, database, o.path);
      break;
  }
}

export async function refreshNode(ref: NodeRef | null): Promise<void> {
  if (!ref?.connectionId) return;
  const ws = useWorkspace.getState();
  if (ref.kind === 'connection') return ws.refreshConnection(ref.connectionId);
  if (!ref.database) return;
  if (ref.kind === 'database') return ws.refreshDatabase(ref.connectionId, ref.database);
  const cat = ref.category;
  const map: Record<string, O.ObjType> = { tables: 'table', views: 'view', functions: 'function', events: 'event', queries: 'query', backups: 'backup' };
  const type = ref.objectType ?? (cat ? map[cat] : undefined);
  return O.refreshObjects(ref.connectionId, ref.database, type ? [type] : undefined);
}

/** Toolbar "Table / View / Function …" buttons: show a category of the current database. */
export function showCategory(cat: Category, connectionId?: string): void {
  const nav = useNav.getState();
  const ctx = currentContext();
  const cid = connectionId ?? ctx.connectionId;
  if (cat === 'users') {
    if (cid && cid !== ctx.connectionId) nav.select(nodeKey({ kind: 'connection', connectionId: cid }));
    nav.setCategory('users');
  } else if (cid && ctx.database) {
    nav.select(nodeKey({ kind: 'category', connectionId: cid, database: ctx.database, category: cat }));
    void D.openDatabase(cid, ctx.database);
  } else {
    nav.setCategory(cat);
  }
  useTabs.getState().activate(OBJECTS_TAB);
}

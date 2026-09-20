// Menus of the title bar.

import {
  ArrowLeftRight,
  ChartColumn,
  ClipboardPaste,
  Code,
  Copy,
  Dices,
  FileInput,
  FileOutput,
  FilePlus,
  FolderOpen,
  GitCompare,
  GitCompareArrows,
  Info,
  Keyboard,
  Moon,
  Network,
  Redo2,
  RefreshCw,
  Save,
  Scissors,
  Search,
  Settings,
  SquareTerminal,
  Sun,
  Undo2,
  X,
  Activity,
  Clock,
  Timer,
  Star
} from 'lucide-react';
import { tr } from '@shared/i18n';
import { api, isElectron } from '../api/client';
import { newConnectionItems, refreshNode } from '../actions/menus';
import * as C from '../actions/connection';
import * as Q from '../actions/query';
import * as T from '../actions/tools';
import { alertDialog } from '../components/ui/Dialog';
import { SEP, type MenuItem } from '../components/ui/Menu';
import { applyTheme } from '../lib/theme';
import { currentContext, parseKey, useNav } from '../store/nav';
import { getSettings, useSettings } from '../store/settings';
import { OBJECTS_TAB, useTabs } from '../store/tabs';
import { addFavorite, manageFavorites, openFavorite, useFavorites } from '../features/favorites/favorites';
import { openPrivilegeManager } from '../features/users/usersStore';
import { showShortcuts } from './ShortcutsDialog';
import { TabIconView } from './TabArea';

const s14 = { size: 14 };

function edit(cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') {
  if (isElectron) void api.window.editCommand(cmd);
  else document.execCommand(cmd);
}

export function fileMenu(): MenuItem[] {
  const tabs = useTabs.getState();
  return [
    { label: tr('Neue Verbindung', 'New Connection'), submenu: newConnectionItems() },
    { label: tr('Neue Abfrage', 'New Query'), icon: <FilePlus {...s14} />, shortcut: 'Ctrl+Q', onClick: () => Q.newQuery() },
    SEP,
    { label: tr('SQL-Datei öffnen …', 'Open SQL File …'), icon: <FolderOpen {...s14} />, shortcut: 'Ctrl+O', onClick: () => void Q.openSqlFile() },
    {
      label: tr('Speichern', 'Save'),
      icon: <Save {...s14} />,
      shortcut: 'Ctrl+S',
      disabled: tabs.activeId === OBJECTS_TAB,
      onClick: () => window.dispatchEvent(new CustomEvent('ks-command', { detail: 'save' }))
    },
    SEP,
    { label: tr('Verbindungen importieren …', 'Import Connections …'), icon: <FileInput {...s14} />, onClick: () => void C.importConnections() },
    { label: tr('Verbindungen exportieren …', 'Export Connections …'), icon: <FileOutput {...s14} />, onClick: () => void C.exportConnections() },
    SEP,
    {
      label: tr('Tab schließen', 'Close Tab'),
      icon: <X {...s14} />,
      shortcut: 'Ctrl+W',
      disabled: tabs.activeId === OBJECTS_TAB,
      onClick: () => void tabs.close(tabs.activeId)
    },
    { label: tr('Beenden', 'Exit'), onClick: () => void api.window.close() }
  ];
}

export function editMenu(): MenuItem[] {
  return [
    { label: tr('Rückgängig', 'Undo'), icon: <Undo2 {...s14} />, shortcut: 'Ctrl+Z', onClick: () => edit('undo') },
    { label: tr('Wiederholen', 'Redo'), icon: <Redo2 {...s14} />, shortcut: 'Ctrl+Y', onClick: () => edit('redo') },
    SEP,
    { label: tr('Ausschneiden', 'Cut'), icon: <Scissors {...s14} />, shortcut: 'Ctrl+X', onClick: () => edit('cut') },
    { label: tr('Kopieren', 'Copy'), icon: <Copy {...s14} />, shortcut: 'Ctrl+C', onClick: () => edit('copy') },
    { label: tr('Einfügen', 'Paste'), icon: <ClipboardPaste {...s14} />, shortcut: 'Ctrl+V', onClick: () => edit('paste') },
    { label: tr('Alles auswählen', 'Select All'), shortcut: 'Ctrl+A', onClick: () => edit('selectAll') },
    SEP,
    {
      label: tr('Suchen …', 'Find …'),
      icon: <Search {...s14} />,
      shortcut: 'Ctrl+F',
      onClick: () => window.dispatchEvent(new CustomEvent('ks-command', { detail: 'find' }))
    }
  ];
}

export function viewMenu(): MenuItem[] {
  const s = getSettings();
  const upd = useSettings.getState().update;
  const setTheme = (theme: 'light' | 'dark' | 'system') => {
    void upd({ theme });
    applyTheme(theme);
  };
  return [
    { label: tr('Navigationsbereich', 'Navigation Pane'), checked: s.showNavigator, onClick: () => void upd({ showNavigator: !s.showNavigator }) },
    { label: tr('Informationsbereich', 'Information Pane'), checked: s.showInfoPane, onClick: () => void upd({ showInfoPane: !s.showInfoPane }) },
    {
      label: tr('Objekte im Navigationsbereich', 'Objects in Navigation Pane'),
      checked: s.navigatorShowObjects,
      onClick: () => void upd({ navigatorShowObjects: !s.navigatorShowObjects })
    },
    SEP,
    {
      label: tr('Farbschema', 'Theme'),
      icon: s.theme === 'dark' ? <Moon {...s14} /> : <Sun {...s14} />,
      submenu: [
        { label: tr('Hell', 'Light'), checked: s.theme === 'light', onClick: () => setTheme('light') },
        { label: tr('Dunkel', 'Dark'), checked: s.theme === 'dark', onClick: () => setTheme('dark') },
        { label: tr('Wie System', 'System'), checked: s.theme === 'system', onClick: () => setTheme('system') }
      ]
    },
    SEP,
    {
      label: tr('Aktualisieren', 'Refresh'),
      icon: <RefreshCw {...s14} />,
      shortcut: 'F5',
      onClick: () => {
        const key = useNav.getState().selectedKey;
        void refreshNode(key ? parseKey(key) : null);
      }
    },
    SEP,
    { label: tr('Entwicklertools', 'Developer Tools'), shortcut: 'F12', onClick: () => void api.window.toggleDevTools() }
  ];
}

export function favoritesMenu(): MenuItem[] {
  const items = useFavorites.getState().items;
  return [
    { label: tr('Zu Favoriten hinzufügen', 'Add to Favorites'), icon: <Star {...s14} />, onClick: () => void addFavorite() },
    { label: tr('Favoriten verwalten …', 'Manage Favorites …'), disabled: !items.length, onClick: () => void manageFavorites() },
    ...(items.length ? [SEP] : []),
    ...items.map((f): MenuItem => ({ label: f.name, icon: <TabIconView icon={f.icon} size={14} />, onClick: () => void openFavorite(f) }))
  ];
}

export function toolsMenu(): MenuItem[] {
  const ctx = currentContext();
  return [
    { label: tr('Datenübertragung …', 'Data Transfer …'), icon: <ArrowLeftRight {...s14} />, onClick: () => T.openDataTransfer() },
    { label: tr('Datensynchronisation …', 'Data Synchronization …'), icon: <GitCompareArrows {...s14} />, onClick: () => T.openDataSync() },
    { label: tr('Struktursynchronisation …', 'Structure Synchronization …'), icon: <GitCompare {...s14} />, onClick: () => T.openStructSync() },
    SEP,
    { label: tr('Import-Assistent …', 'Import Wizard …'), icon: <FileInput {...s14} />, onClick: () => T.openImportWizard() },
    { label: tr('Export-Assistent …', 'Export Wizard …'), icon: <FileOutput {...s14} />, onClick: () => T.openExportWizard() },
    { label: tr('SQL-Datei ausführen …', 'Execute SQL File …'), icon: <FileInput {...s14} />, onClick: () => T.executeSqlFile() },
    SEP,
    { label: tr('Sicherung …', 'Backup …'), onClick: () => T.openBackup() },
    { label: tr('Automatisierung …', 'Automation …'), icon: <Timer {...s14} />, onClick: () => T.openAutomation() },
    { label: tr('Datengenerator …', 'Data Generator …'), icon: <Dices {...s14} />, onClick: () => T.openDataGenerator() },
    { label: tr('Modell …', 'Model …'), icon: <Network {...s14} />, onClick: () => T.newModel() },
    { label: tr('Diagramme …', 'Charts …'), icon: <ChartColumn {...s14} />, onClick: () => T.openCharts() },
    SEP,
    { label: tr('Serverüberwachung …', 'Server Monitor …'), icon: <Activity {...s14} />, onClick: () => T.openServerMonitor() },
    { label: tr('Rechte-Manager …', 'Privilege Manager …'), disabled: !ctx.connectionId, onClick: () => ctx.connectionId && openPrivilegeManager(ctx.connectionId) },
    { label: tr('Befehlszeilenkonsole', 'Command Line Console'), icon: <SquareTerminal {...s14} />, disabled: !ctx.connectionId, onClick: () => T.openConsole() },
    { label: tr('Suche in Datenbank …', 'Find in Database …'), icon: <Search {...s14} />, disabled: !ctx.connectionId, onClick: () => T.findInDatabase() },
    { label: tr('Verlaufsprotokoll', 'History Log'), icon: <Clock {...s14} />, onClick: () => T.openHistory() },
    { label: tr('Code-Snippets', 'Code Snippets'), icon: <Code {...s14} />, onClick: () => T.openSnippets() },
    SEP,
    { label: tr('Optionen …', 'Options …'), icon: <Settings {...s14} />, onClick: () => T.openOptions() }
  ];
}

export function windowMenu(): MenuItem[] {
  const s = useTabs.getState();
  return [
    ...s.tabs.map<MenuItem>((t) => ({ label: t.title, checked: t.id === s.activeId, onClick: () => s.activate(t.id) })),
    SEP,
    {
      label: tr('Alle Tabs schließen', 'Close All Tabs'),
      disabled: s.tabs.length <= 1,
      onClick: () => void s.closeMany(s.tabs.filter((t) => t.id !== OBJECTS_TAB).map((t) => t.id))
    }
  ];
}

export function helpMenu(): MenuItem[] {
  return [
    { label: tr('Tastenkürzel …', 'Keyboard Shortcuts …'), icon: <Keyboard {...s14} />, onClick: () => void showShortcuts() },
    SEP,
    {
      label: tr('Über KS Table …', 'About KS Table …'),
      icon: <Info {...s14} />,
      onClick: async () => {
        const info = await api.app.info();
        void alertDialog({
          title: tr('Über KS Table', 'About KS Table'),
          message: `KS Table ${info.version}\n${tr('Datenbank-Management für MySQL und MariaDB', 'Database management for MySQL and MariaDB')}\n\nElectron ${info.electronVersion || '–'} · Node ${info.nodeVersion}\n${tr('Einstellungen', 'Settings')}: ${info.userDataDir}\n${tr('Profile', 'Profiles')}: ${info.profilesDir}`
        });
      }
    }
  ];
}

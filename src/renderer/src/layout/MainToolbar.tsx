import { Activity, FilePlus, Server } from 'lucide-react';
import { tr } from '@shared/i18n';
import { newConnectionItems, showCategory } from '../actions/menus';
import * as C from '../actions/connection';
import * as Q from '../actions/query';
import * as T from '../actions/tools';
import { ObjIcon, type ObjKind } from '../components/icons';
import { showMenuBelow } from '../components/ui/Menu';
import { ToolbarButton, ToolbarSep } from '../components/ui/controls';
import { useNav, type Category } from '../store/nav';
import { OBJECTS_TAB, useTabs } from '../store/tabs';

const ICON = 24;

export function MainToolbar() {
  const category = useNav((s) => s.category);
  const objectsActive = useTabs((s) => s.activeId === OBJECTS_TAB);
  const cat = (c: Category, kind: ObjKind, label: string) => (
    <ToolbarButton
      stacked
      icon={<ObjIcon kind={kind} size={ICON} strokeWidth={1.6} />}
      label={label}
      active={objectsActive && category === c}
      onClick={() => showCategory(c)}
    />
  );
  return (
    <div className="ks-maintoolbar">
      <ToolbarButton
        stacked
        icon={<Server size={ICON} strokeWidth={1.6} style={{ color: 'var(--c-mysql)' }} />}
        label={tr('Verbindung', 'Connection')}
        onClick={() => void C.newConnection('mysql')}
        onDropdown={(e) => showMenuBelow(e.currentTarget, newConnectionItems())}
      />
      <ToolbarButton
        stacked
        icon={<FilePlus size={ICON} strokeWidth={1.6} style={{ color: 'var(--c-query)' }} />}
        label={tr('Neue Abfrage', 'New Query')}
        onClick={() => Q.newQuery()}
      />
      <ToolbarSep />
      {cat('tables', 'table', tr('Tabelle', 'Table'))}
      {cat('views', 'view', tr('Ansicht', 'View'))}
      {cat('functions', 'function', tr('Funktion', 'Function'))}
      {cat('events', 'event', tr('Ereignis', 'Event'))}
      {cat('users', 'user', tr('Benutzer', 'User'))}
      {cat('queries', 'query', tr('Abfrage', 'Query'))}
      {cat('backups', 'backup', tr('Sicherung', 'Backup'))}
      <ToolbarSep />
      <ToolbarButton stacked icon={<ObjIcon kind="automation" size={ICON} strokeWidth={1.6} />} label={tr('Automatisierung', 'Automation')} onClick={() => T.openAutomation()} />
      <ToolbarButton stacked icon={<ObjIcon kind="model" size={ICON} strokeWidth={1.6} />} label={tr('Modell', 'Model')} onClick={() => T.newModel()} />
      <ToolbarButton stacked icon={<ObjIcon kind="chart" size={ICON} strokeWidth={1.6} />} label={tr('Diagramme', 'Charts')} onClick={() => T.openCharts()} />
      <ToolbarButton
        stacked
        icon={<Activity size={ICON} strokeWidth={1.6} style={{ color: 'var(--c-event)' }} />}
        label={tr('Überwachung', 'Monitor')}
        onClick={() => T.openServerMonitor()}
      />
    </div>
  );
}

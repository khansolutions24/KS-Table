import { tr } from '@shared/i18n';
import { isElectron } from '../api/client';
import { AppLogo } from '../components/icons';
import { MenuBar, type TopMenu } from '../components/ui/Menu';
import { useTabs } from '../store/tabs';
import { editMenu, favoritesMenu, fileMenu, helpMenu, toolsMenu, viewMenu, windowMenu } from './appMenus';

export function TitleBar() {
  const title = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.title);
  const menus: TopMenu[] = [
    { id: 'file', label: tr('Datei', 'File'), items: fileMenu },
    { id: 'edit', label: tr('Bearbeiten', 'Edit'), items: editMenu },
    { id: 'view', label: tr('Ansicht', 'View'), items: viewMenu },
    { id: 'fav', label: tr('Favoriten', 'Favorites'), items: favoritesMenu },
    { id: 'tools', label: tr('Extras', 'Tools'), items: toolsMenu },
    { id: 'window', label: tr('Fenster', 'Window'), items: windowMenu },
    { id: 'help', label: tr('Hilfe', 'Help'), items: helpMenu }
  ];
  return (
    <div className="ks-titlebar">
      <div className="ks-titlebar-logo">
        <AppLogo size={18} />
      </div>
      <MenuBar menus={menus} />
      <div className="ks-titlebar-title">{title && title !== tr('Objekte', 'Objects') ? `${title} – KS Table` : 'KS Table'}</div>
      {isElectron && <div className="ks-titlebar-controls" />}
    </div>
  );
}

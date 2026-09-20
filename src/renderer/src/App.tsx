import { useEffect } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { tr } from '@shared/i18n';
import { api, onEvent } from './api/client';
import { confirmDialog, DialogHost } from './components/ui/Dialog';
import { MenuHost } from './components/ui/Menu';
import { ToastHost } from './components/Toast';
import { InfoPane } from './layout/InfoPane';
import { MainToolbar } from './layout/MainToolbar';
import { Navigator } from './layout/Navigator';
import { StatusBar } from './layout/StatusBar';
import { TabArea } from './layout/TabArea';
import { TitleBar } from './layout/TitleBar';
import { useGlobalShortcuts } from './lib/shortcuts';
import { getSettings, useSettings } from './store/settings';
import { OBJECTS_TAB, useTabs } from './store/tabs';
import { useWorkspace } from './store/workspace';
import './styles/layout.css';

let closing = false;

async function requestAppClose(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    if (getSettings().confirmOnExit) {
      const ok = await confirmDialog({ title: tr('Beenden', 'Exit'), message: tr('KS Table beenden?', 'Exit KS Table?'), okLabel: tr('Beenden', 'Exit') });
      if (!ok) return;
    }
    const ids = useTabs.getState().tabs.filter((t) => t.id !== OBJECTS_TAB).map((t) => t.id);
    if (!(await useTabs.getState().closeMany(ids))) return;
    await api.window.close();
  } finally {
    closing = false;
  }
}

export function App() {
  const showNav = useSettings((s) => s.settings.showNavigator);
  const showInfo = useSettings((s) => s.settings.showInfoPane);
  useGlobalShortcuts();

  useEffect(() => {
    void useWorkspace.getState().load();
    return onEvent('app:close-requested', () => void requestAppClose());
  }, []);

  return (
    <div className="ks-app" onContextMenu={(e) => e.preventDefault()}>
      <TitleBar />
      <MainToolbar />
      <div className="ks-workspace">
        <Group orientation="horizontal" className="ks-panels">
          {showNav && (
            <Panel id="nav" defaultSize="270px" minSize="170px" maxSize="45%" groupResizeBehavior="preserve-pixel-size">
              <Navigator />
            </Panel>
          )}
          {showNav && <Separator className="ks-splitter" />}
          <Panel id="center" minSize="30%">
            <TabArea />
          </Panel>
          {showInfo && <Separator className="ks-splitter" />}
          {showInfo && (
            <Panel id="info" defaultSize="290px" minSize="200px" maxSize="45%" groupResizeBehavior="preserve-pixel-size">
              <InfoPane />
            </Panel>
          )}
        </Group>
      </div>
      <StatusBar />
      <MenuHost />
      <DialogHost />
      <ToastHost />
    </div>
  );
}

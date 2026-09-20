import { createRoot } from 'react-dom/client';
import '@glideapps/glide-data-grid/dist/index.css';
import './styles/app.css';
import './styles/ui.css';
import './styles/components.css';
import { setLang } from '@shared/i18n';
import { api } from './api/client';
import { useSettings } from './store/settings';
import { useTabs } from './store/tabs';
import { useNav } from './store/nav';
import { useWorkspace } from './store/workspace';
import { applyTheme } from './lib/theme';
import { App } from './App';

if (import.meta.env.DEV) {
  // stores reachable from the devtools console / automated UI checks
  (window as unknown as { __ks: unknown }).__ks = { useTabs, useNav, useWorkspace, useSettings };
}

async function boot(): Promise<void> {
  const settings = await api.settings.get();
  setLang(settings.language);
  document.documentElement.lang = settings.language;
  document.documentElement.style.setProperty('--fs', `${settings.uiFontSize}px`);
  useSettings.setState({ settings, loaded: true });
  applyTheme(settings.theme);
  createRoot(document.getElementById('root')!).render(<App />);
}

boot().catch((err: unknown) => {
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;padding:24px;color:#b91c1c;font:13px Consolas,monospace;white-space:pre-wrap;height:100%;overflow:auto';
  pre.textContent = 'KS Table konnte nicht starten / could not start:\n\n' + (err instanceof Error ? err.stack || err.message : String(err));
  const root = document.getElementById('root');
  if (root) root.replaceChildren(pre);
  else document.body.appendChild(pre);
});

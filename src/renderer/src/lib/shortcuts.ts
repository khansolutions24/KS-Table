import { useEffect } from 'react';
import { api } from '../api/client';
import { hasOpenDialog } from '../components/ui/Dialog';
import { refreshNode } from '../actions/menus';
import { newQuery } from '../actions/query';
import { parseKey, useNav } from '../store/nav';
import { useTabs } from '../store/tabs';

/** Common shape of a DOM KeyboardEvent and glide-data-grid's GridKeyEventArgs. */
export interface KeyComboLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function keyCombo(e: KeyComboLike): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  let k = e.key;
  if (k.length === 1) k = k.toUpperCase();
  if (k === ' ') k = 'Space';
  parts.push(k);
  return parts.join('+');
}

function cycleTab(dir: 1 | -1): void {
  const s = useTabs.getState();
  const i = s.tabs.findIndex((t) => t.id === s.activeId);
  const next = s.tabs[(i + dir + s.tabs.length) % s.tabs.length];
  if (next) s.activate(next.id);
}

/** App wide shortcuts. Components that handle a key themselves call stopPropagation(). */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasOpenDialog()) return;
      const combo = keyCombo(e);
      const tabs = useTabs.getState();
      switch (combo) {
        case 'Ctrl+Q':
          e.preventDefault();
          newQuery();
          break;
        case 'Ctrl+W':
        case 'Ctrl+F4':
          e.preventDefault();
          void tabs.close(tabs.activeId);
          break;
        case 'Ctrl+Tab':
        case 'Ctrl+PageDown':
          e.preventDefault();
          cycleTab(1);
          break;
        case 'Ctrl+Shift+Tab':
        case 'Ctrl+PageUp':
          e.preventDefault();
          cycleTab(-1);
          break;
        case 'F12':
          e.preventDefault();
          void api.window.toggleDevTools();
          break;
        case 'Ctrl+Shift+R':
          e.preventDefault();
          location.reload();
          break;
        case 'F5': {
          e.preventDefault();
          const key = useNav.getState().selectedKey;
          void refreshNode(key ? parseKey(key) : null);
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

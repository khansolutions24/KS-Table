import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

let currentMode: ThemeMode = 'light';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function resolvedTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function applyTheme(mode: ThemeMode): void {
  currentMode = mode;
  const t: ResolvedTheme = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = t;
  void api.window.setTitleBarColors(cssVar('--bg-titlebar'), cssVar('--fg')).catch(() => undefined);
  window.dispatchEvent(new CustomEvent('ks-theme', { detail: t }));
}

media.addEventListener('change', () => {
  if (currentMode === 'system') applyTheme('system');
});

/** Re-renders when the theme changes (for canvas based widgets like the grid or Monaco). */
export function useResolvedTheme(): ResolvedTheme {
  const [t, setT] = useState<ResolvedTheme>(resolvedTheme());
  useEffect(() => {
    const h = () => setT(resolvedTheme());
    window.addEventListener('ks-theme', h);
    return () => window.removeEventListener('ks-theme', h);
  }, []);
  return t;
}

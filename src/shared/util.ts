// Small helpers shared by backend and renderer.

import { locale } from './i18n';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** Recursively merges plain objects; arrays and primitives in `patch` replace values in `base`. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toLocaleString(locale(), { maximumFractionDigits: u === 0 ? 0 : 2 })} ${units[u]}`;
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || isNaN(n)) return '';
  return n.toLocaleString(locale(), { maximumFractionDigits: digits });
}

/** 0.012s style duration used in result summaries */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(3)}s`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function formatDateTime(t: number | Date): string {
  const d = typeof t === 'number' ? new Date(t) : t;
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function uniqueName(base: string, existing: Iterable<string>): string {
  const set = new Set(Array.from(existing, (s) => s.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 1; ; i++) {
    const name = `${base}_${i}`;
    if (!set.has(name.toLowerCase())) return name;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Safe file name from an arbitrary object name */
export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || '_';
}

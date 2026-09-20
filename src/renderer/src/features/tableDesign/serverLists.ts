// Server lists used by the designers (character sets, collations, engines, tables, columns), cached per connection.

import { useEffect, useState } from 'react';
import type { CharsetInfo, CollationInfo, ColumnMeta, EngineInfo } from '@shared/types';
import { api } from '../../api/client';
import { metaSession } from '../../store/workspace';

const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
  let p = fresh ? undefined : (cache.get(key) as Promise<T> | undefined);
  if (!p) {
    const np = Promise.resolve().then(load);
    cache.set(key, np);
    np.catch(() => {
      if (cache.get(key) === np) cache.delete(key);
    });
    p = np;
  }
  return p;
}

export const getCharsets = (cid: string) => cached<CharsetInfo[]>(`cs|${cid}`, () => api.meta.charsets(metaSession(cid)));
export const getCollations = (cid: string) => cached<CollationInfo[]>(`co|${cid}`, () => api.meta.collations(metaSession(cid)));
export const getEngines = (cid: string) => cached<EngineInfo[]>(`en|${cid}`, () => api.meta.engines(metaSession(cid)));

export function getTableNames(cid: string, db: string, fresh = false): Promise<string[]> {
  return cached(`tb|${cid}|${db}`, async () => (await api.meta.tables(metaSession(cid), db)).filter((t) => t.type !== 'VIEW').map((t) => t.name), fresh);
}

export function getColumns(cid: string, db: string, table: string, fresh = false): Promise<ColumnMeta[]> {
  return cached(`col|${cid}|${db}|${table}`, () => api.meta.columns(metaSession(cid), db, table), fresh);
}

/** Forget cached tables / columns of a database (after its tables changed) */
export function invalidateTableLists(cid: string, db: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`tb|${cid}|${db}`) || k.startsWith(`col|${cid}|${db}|`)) cache.delete(k);
}

export interface ServerLists {
  charsets: CharsetInfo[];
  collations: CollationInfo[];
  engines: EngineInfo[];
}

export function useServerLists(cid: string): ServerLists {
  const [lists, setLists] = useState<ServerLists>({ charsets: [], collations: [], engines: [] });
  useEffect(() => {
    let alive = true;
    void Promise.all([getCharsets(cid), getCollations(cid), getEngines(cid)])
      .then(([charsets, collations, engines]) => {
        if (alive) setLists({ charsets, collations, engines });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cid]);
  return lists;
}

/** Options for a character set select ('' = default) */
export function charsetOptions(lists: ServerLists, current: string, defaultLabel: string): { value: string; label: string }[] {
  const out = [{ value: '', label: defaultLabel }, ...lists.charsets.map((c) => ({ value: c.charset, label: `${c.charset} – ${c.description}` }))];
  if (current && !lists.charsets.some((c) => c.charset === current)) out.push({ value: current, label: current });
  return out;
}

/** Options for a collation select filtered by character set ('' = default of the character set) */
export function collationOptions(lists: ServerLists, charset: string, current: string, defaultLabel: string): { value: string; label: string }[] {
  const list = lists.collations.filter((c) => !charset || c.charset === charset);
  const out = [{ value: '', label: defaultLabel }, ...list.map((c) => ({ value: c.collation, label: c.isDefault ? `${c.collation} *` : c.collation }))];
  if (current && !list.some((c) => c.collation === current)) out.push({ value: current, label: current });
  return out;
}

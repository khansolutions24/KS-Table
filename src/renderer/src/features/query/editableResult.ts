// Can a query result be edited like a table viewer? Only when every table-bound column comes from one
// base table (same alias) whose primary key columns are all part of the result.

import type { ColumnMeta, ResultColumn } from '@shared/types';

export interface ResultSource {
  schema: string;
  table: string;
  /** alias used in the query (equals the table name without alias) */
  alias: string;
}

export interface EditableInfo {
  schema: string;
  table: string;
  /** result column index → table column name; null = read-only (expression, duplicate) */
  columnMap: (string | null)[];
  /** primary key columns and the result column index that provides each value */
  key: { name: string; index: number }[];
  /** metadata of the table columns */
  meta: ColumnMeta[];
}

/** The single table all table-bound result columns come from, or null. */
export function singleTableSource(columns: ResultColumn[]): ResultSource | null {
  let src: ResultSource | null = null;
  for (const c of columns) {
    if (!c.orgTable) continue;
    if (!c.schema || !c.orgName) return null;
    if (!src) src = { schema: c.schema, table: c.orgTable, alias: c.table };
    else if (src.schema !== c.schema || src.table !== c.orgTable || src.alias !== c.table) return null;
  }
  return src;
}

/**
 * Editing information for a result whose columns come from `source`; null when the table has no
 * primary key (e.g. a view) or the result does not contain all key columns.
 */
export function resolveEditable(columns: ResultColumn[], source: ResultSource, meta: ColumnMeta[]): EditableInfo | null {
  const pk = meta.filter((m) => m.key === 'PRI').map((m) => m.name);
  if (!pk.length) return null;
  const byName = new Map(meta.map((m) => [m.name.toLowerCase(), m]));
  const seen = new Set<string>();
  const columnMap = columns.map((c) => {
    if (!c.orgTable || !c.orgName || c.orgTable !== source.table || c.table !== source.alias) return null;
    const m = byName.get(c.orgName.toLowerCase());
    if (!m || seen.has(m.name)) return null;
    seen.add(m.name);
    return m.name;
  });
  const key = pk.map((name) => ({ name, index: columnMap.indexOf(name) }));
  if (key.some((k) => k.index < 0)) return null;
  return { schema: source.schema, table: source.table, columnMap, key, meta };
}

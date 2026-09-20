// Session status counters before / after a query ("Status" result tab).
//
// Snapshots A and B are taken right after each other before the query, C after it. (B − A) is the cost of one
// snapshot statement itself and is subtracted: net = (C − B) − (B − A).

import type { CellValue } from '@shared/types';

/** Session scoped counters only (global counters would include other sessions' work). */
export const STATUS_SQL =
  "SHOW SESSION STATUS WHERE Variable_name REGEXP '^(Bytes_received|Bytes_sent|Com_|Created_tmp_|Handler_|Questions$|Select_|Sort_|Table_locks_|Opened_tables$|Slow_queries$)'";

export type StatusSnapshot = Map<string, number>;

export interface StatusDelta {
  name: string;
  delta: number;
  after: number;
}

export function toSnapshot(rows: CellValue[][]): StatusSnapshot {
  const m: StatusSnapshot = new Map();
  for (const r of rows) {
    const name = r[0];
    const value = r[1];
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    const n = Number(value);
    if (value.trim() !== '' && Number.isFinite(n)) m.set(name, n);
  }
  return m;
}

export function statusDelta(a: StatusSnapshot, b: StatusSnapshot, c: StatusSnapshot): StatusDelta[] {
  const out: StatusDelta[] = [];
  for (const [name, cv] of c) {
    const bv = b.get(name);
    if (bv === undefined) continue;
    const av = a.get(name);
    const noise = av === undefined ? 0 : Math.max(0, bv - av);
    out.push({ name, delta: Math.max(0, cv - bv - noise), after: cv });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

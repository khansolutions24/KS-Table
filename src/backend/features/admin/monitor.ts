// Server monitor queries: process list, variables, status, InnoDB status.

import type { ProcessInfo, StatusRow, VariableRow } from '@shared/apis/admin';
import type { Session } from '../../db/sessions';

type Row = Record<string, unknown>;

function col(r: Row, name: string): unknown {
  if (name in r) return r[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(r)) if (k.toLowerCase() === lower) return r[k];
  return undefined;
}

export const str = (v: unknown): string =>
  v === null || v === undefined ? '' : v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
const num = (v: unknown): number => {
  const x = Number(str(v));
  return Number.isFinite(x) ? x : 0;
};

/** performance_schema.processlist (MySQL 8.0.22+, no deprecation warning), else information_schema.PROCESSLIST */
export async function processList(s: Session): Promise<ProcessInfo[]> {
  let rows: Row[] | null = null;
  if (s.server.type === 'mysql' && s.server.versionNumber >= 80022) {
    try {
      rows = await s.rows<Row>('SELECT * FROM performance_schema.processlist');
    } catch {
      rows = null;
    }
  }
  if (!rows) rows = await s.rows<Row>('SELECT * FROM information_schema.PROCESSLIST');
  return rows
    .map((r) => ({
      id: str(col(r, 'ID')),
      user: str(col(r, 'USER')),
      host: str(col(r, 'HOST')),
      db: strOrNull(col(r, 'DB')),
      command: str(col(r, 'COMMAND')),
      time: num(col(r, 'TIME')),
      state: str(col(r, 'STATE')),
      info: strOrNull(col(r, 'INFO')),
      progress: num(col(r, 'PROGRESS'))
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export async function variables(s: Session): Promise<VariableRow[]> {
  const g = await s.rowset('SHOW GLOBAL VARIABLES');
  const ss = await s.rowset('SHOW SESSION VARIABLES');
  const map = new Map<string, VariableRow>();
  for (const row of g.rows) map.set(str(row[0]), { name: str(row[0]), global: strOrNull(row[1]), session: null });
  for (const row of ss.rows) {
    const name = str(row[0]);
    const cur = map.get(name);
    if (cur) cur.session = strOrNull(row[1]);
    else map.set(name, { name, global: null, session: strOrNull(row[1]) });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function status(s: Session): Promise<StatusRow[]> {
  const r = await s.rowset('SHOW GLOBAL STATUS');
  return r.rows.map((row) => ({ name: str(row[0]), value: str(row[1]) }));
}

export async function innodbStatus(s: Session): Promise<string> {
  const r = await s.rowset('SHOW ENGINE INNODB STATUS');
  const idx = r.fields.findIndex((f) => f.name.toLowerCase() === 'status');
  return str(r.rows[0]?.[idx >= 0 ? idx : 2]);
}

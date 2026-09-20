// Streams the rows of a query in batches with back pressure (no full result set in memory).

import type { FieldPacket } from 'mysql2';
import type { CellValue } from '@shared/types';
import type { Session } from '../../db/sessions';

const HIGH_WATER_BATCHES = 4;

/** Converts driver values to transport values (numbers → strings, objects → JSON; buffers kept). */
export function normalizeRow(row: unknown[]): CellValue[] {
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    if (v === null || typeof v === 'string' || v instanceof Uint8Array) continue;
    if (v === undefined) row[i] = null;
    else if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') row[i] = String(v);
    else if (v instanceof Date) row[i] = v.toISOString();
    else row[i] = JSON.stringify(v);
  }
  return row as CellValue[];
}

/**
 * Rows of the first result set of `sql`, delivered in batches. `onFields` is called with the
 * column definitions before the first batch. Rows of further result sets (CALL) are ignored.
 * Stopping the iteration early aborts the query by closing the connection (the session reconnects).
 */
export async function* streamRows(s: Session, sql: string, onFields: (f: FieldPacket[]) => void, batchSize = 500): AsyncGenerator<CellValue[][]> {
  if (s.conn.isDead) await s.reconnect();
  const conn = s.conn.raw;
  const q = conn.query({ sql, rowsAsArray: true });
  let queue: unknown[][] = [];
  let done = false;
  let error: unknown = null;
  let paused = false;
  let sets = 0;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  q.on('fields', (f?: FieldPacket[]) => {
    if (!f) return;
    sets++;
    if (sets === 1) onFields(f);
  });
  q.on('result', (row: unknown) => {
    if (!Array.isArray(row) || sets !== 1) return;
    queue.push(row);
    if (queue.length >= batchSize) {
      if (!paused && queue.length >= batchSize * HIGH_WATER_BATCHES) {
        paused = true;
        conn.pause();
      }
      notify();
    }
  });
  q.on('error', (e: unknown) => {
    error = e;
    done = true;
    notify();
  });
  q.on('end', () => {
    done = true;
    notify();
  });
  try {
    for (;;) {
      if (queue.length >= batchSize || (done && queue.length)) {
        const batch = queue;
        queue = [];
        if (paused) {
          paused = false;
          conn.resume();
        }
        yield batch.map(normalizeRow);
        continue;
      }
      if (error) throw error;
      if (done) return;
      if (paused) {
        paused = false;
        conn.resume();
      }
      await new Promise<void>((r) => (wake = r));
    }
  } finally {
    if (!done) s.conn.destroy();
  }
}

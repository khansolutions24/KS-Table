// Pending edits of an editable query result → row changes for api.data.apply, and merging the results back.

import type { ApplyChangeResult, CellValue, EditValue, RowChange } from '@shared/types';
import type { EditableInfo } from './editableResult';

export interface InsertedRow {
  /** stable id of the new row */
  key: number;
  /** result column index → value */
  values: Record<number, EditValue>;
}

export interface GridEditState {
  /** `${row}:${col}` (row = index into the result rows) → new value */
  edits: Record<string, EditValue>;
  inserted: InsertedRow[];
  /** result row indices marked for deletion */
  deleted: number[];
}

export type ChangeTarget = { kind: 'update' | 'delete'; row: number } | { kind: 'insert'; key: number };

export const emptyEdits = (): GridEditState => ({ edits: {}, inserted: [], deleted: [] });

export const editKey = (row: number, col: number): string => `${row}:${col}`;

export function parseEditKey(k: string): { row: number; col: number } {
  const i = k.indexOf(':');
  return { row: Number(k.slice(0, i)), col: Number(k.slice(i + 1)) };
}

export function pendingCount(s: GridEditState): number {
  const rows = new Set<number>();
  for (const k of Object.keys(s.edits)) rows.add(parseEditKey(k).row);
  for (const r of s.deleted) rows.add(r);
  return rows.size + s.inserted.length;
}

/** Value to display for an edit value */
export function editToCell(v: EditValue): CellValue {
  if (v === null || typeof v === 'string' || v instanceof Uint8Array) return v;
  if ('expr' in v) return v.expr;
  return 'DEFAULT';
}

export function sameCell(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  return false;
}

/** Table columns (in result order) sent as ApplyRequest.columns, with their result column index. */
export function tableColumns(info: EditableInfo): { names: string[]; indices: number[] } {
  const names: string[] = [];
  const indices: number[] = [];
  info.columnMap.forEach((n, i) => {
    if (n) {
      names.push(n);
      indices.push(i);
    }
  });
  return { names, indices };
}

function keyOf(info: EditableInfo, row: CellValue[]): Record<string, CellValue> {
  const key: Record<string, CellValue> = {};
  for (const k of info.key) key[k.name] = row[k.index];
  return key;
}

/** Row changes in apply order: updates, inserts, deletes. */
export function buildChanges(info: EditableInfo, rows: CellValue[][], s: GridEditState): { changes: RowChange[]; targets: ChangeTarget[] } {
  const changes: RowChange[] = [];
  const targets: ChangeTarget[] = [];
  const deleted = new Set(s.deleted);
  const byRow = new Map<number, Record<string, EditValue>>();
  for (const [k, v] of Object.entries(s.edits)) {
    const { row, col } = parseEditKey(k);
    const name = info.columnMap[col];
    if (!name || deleted.has(row) || !rows[row]) continue;
    let values = byRow.get(row);
    if (!values) {
      values = {};
      byRow.set(row, values);
    }
    values[name] = v;
  }
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    changes.push({ type: 'update', key: keyOf(info, rows[row]), values: byRow.get(row)! });
    targets.push({ kind: 'update', row });
  }
  for (const ins of s.inserted) {
    const values: Record<string, EditValue> = {};
    for (const [col, v] of Object.entries(ins.values)) {
      const name = info.columnMap[Number(col)];
      if (name) values[name] = v;
    }
    changes.push({ type: 'insert', values });
    targets.push({ kind: 'insert', key: ins.key });
  }
  for (const row of [...deleted].sort((a, b) => a - b)) {
    if (!rows[row]) continue;
    changes.push({ type: 'delete', key: keyOf(info, rows[row]) });
    targets.push({ kind: 'delete', row });
  }
  return { changes, targets };
}

export interface MergeResult {
  rows: CellValue[][];
  state: GridEditState;
  /** changes that failed (or were rolled back), with their error */
  failed: { target: ChangeTarget; message: string; sql?: string }[];
  applied: number;
}

/**
 * Merges apply results into the rows: updated rows get the re-read values, inserted rows are appended,
 * deleted rows removed. When the transaction was rolled back nothing is merged.
 */
export function mergeApplyResults(
  info: EditableInfo,
  rows: CellValue[][],
  s: GridEditState,
  targets: ChangeTarget[],
  results: ApplyChangeResult[],
  committed: boolean,
  rolledBackMessage: string
): MergeResult {
  const failed: MergeResult['failed'] = [];
  if (!committed) {
    targets.forEach((t, i) => {
      const r = results[i];
      if (r && !r.ok) failed.push({ target: t, message: r.error?.message ?? rolledBackMessage, sql: r.sql });
    });
    if (!failed.length) failed.push({ target: targets[0], message: rolledBackMessage });
    return { rows, state: s, failed, applied: 0 };
  }
  const { indices } = tableColumns(info);
  const width = info.columnMap.length;
  const next = rows.slice();
  const edits = { ...s.edits };
  let inserted = s.inserted.slice();
  const deletedDone = new Set<number>();
  const appended: CellValue[][] = [];
  let applied = 0;

  const fresh = (base: CellValue[], row: CellValue[] | null | undefined): CellValue[] => {
    const out = base.slice();
    if (row) row.forEach((v, j) => (out[indices[j]] = v));
    return out;
  };

  targets.forEach((t, i) => {
    const r = results[i];
    if (!r || !r.ok) {
      failed.push({ target: t, message: r?.error?.message ?? rolledBackMessage, sql: r?.sql });
      return;
    }
    applied++;
    if (t.kind === 'update') {
      let base = next[t.row].slice();
      for (const k of Object.keys(edits)) {
        const { row, col } = parseEditKey(k);
        if (row !== t.row) continue;
        const v = edits[k];
        if (info.columnMap[col] && (v === null || typeof v === 'string' || v instanceof Uint8Array)) base[col] = v;
        delete edits[k];
      }
      if (r.row) base = fresh(base, r.row);
      next[t.row] = base;
    } else if (t.kind === 'insert') {
      const ins = inserted.find((x) => x.key === t.key);
      inserted = inserted.filter((x) => x.key !== t.key);
      const base: CellValue[] = Array.from({ length: width }, (_, c) => {
        const v = info.columnMap[c] ? ins?.values[c] : undefined;
        return v === undefined ? null : v === null || typeof v === 'string' || v instanceof Uint8Array ? v : null;
      });
      appended.push(r.row ? fresh(base, r.row) : base);
    } else {
      deletedDone.add(t.row);
    }
  });

  // drop deleted rows and re-index the remaining edits / deletions
  const remap = new Map<number, number>();
  const kept: CellValue[][] = [];
  next.forEach((row, i) => {
    if (deletedDone.has(i)) return;
    remap.set(i, kept.length);
    kept.push(row);
  });
  const newEdits: Record<string, EditValue> = {};
  for (const [k, v] of Object.entries(edits)) {
    const { row, col } = parseEditKey(k);
    const to = remap.get(row);
    if (to !== undefined) newEdits[editKey(to, col)] = v;
  }
  const newDeleted = s.deleted.filter((r) => !deletedDone.has(r)).map((r) => remap.get(r)).filter((r): r is number => r !== undefined);
  return {
    rows: [...kept, ...appended],
    state: { edits: newEdits, inserted, deleted: newDeleted },
    failed,
    applied
  };
}

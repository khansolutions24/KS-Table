// "Copy as …" formats for query result selections.

import type { CellValue } from '@shared/types';
import { literal, quoteId } from '@shared/sql/quote';
import { editText, type GridColumnDef } from '../../components/grid/cellFormat';

export interface CopyData {
  columns: GridColumnDef[];
  rows: CellValue[][];
}

export function cellText(v: CellValue, c: GridColumnDef, nullText = ''): string {
  return v === null ? nullText : editText(v, c);
}

/** Tab separated values; tabs / line breaks inside values become spaces. */
export function toTsv(d: CopyData, header: boolean, nullText = ''): string {
  const lines: string[] = [];
  if (header) lines.push(d.columns.map((c) => c.title).join('\t'));
  for (const r of d.rows) lines.push(r.map((v, i) => cellText(v, d.columns[i], nullText).replace(/[\t\r\n]+/g, ' ')).join('\t'));
  return lines.join('\n');
}

export function sqlValue(v: CellValue, c: GridColumnDef): string {
  if (v instanceof Uint8Array && c.kind === 'bit') return `b'${editText(v, c)}'`;
  if (v instanceof Uint8Array && c.kind === 'geometry') return `ST_GeomFromText('${editText(v, c)}')`;
  return literal(v, c.numeric);
}

/** INSERT statements; `names` are the column names of the target table (same order as d.columns). */
export function toInsertSql(target: string, names: string[], d: CopyData): string {
  const cols = names.map(quoteId).join(', ');
  return d.rows.map((r) => `INSERT INTO ${target} (${cols}) VALUES (${r.map((v, i) => sqlValue(v, d.columns[i])).join(', ')});`).join('\n');
}

/** UPDATE statements; key columns (indices into d.columns) form the WHERE clause, all others the SET list. */
export function toUpdateSql(target: string, names: string[], d: CopyData, keyIdx: number[]): string {
  const keys = keyIdx.length ? keyIdx : d.columns.map((_, i) => i);
  const setIdx = d.columns.map((_, i) => i).filter((i) => !keyIdx.includes(i));
  return d.rows
    .map((r) => {
      const set = (setIdx.length ? setIdx : keys).map((i) => `${quoteId(names[i])} = ${sqlValue(r[i], d.columns[i])}`).join(', ');
      const where = keys.map((i) => (r[i] === null ? `${quoteId(names[i])} IS NULL` : `${quoteId(names[i])} = ${sqlValue(r[i], d.columns[i])}`)).join(' AND ');
      return `UPDATE ${target} SET ${set} WHERE ${where};`;
    })
    .join('\n');
}

// "Copy as …" formats for grid selections.

import type { CellValue } from '@shared/types';
import { literal, qname, quoteId } from '@shared/sql/quote';
import type { GridColumnDef } from '../../components/grid/cellFormat';
import { editText } from '../../components/grid/cellFormat';

export interface CopySource {
  columns: GridColumnDef[];
  rows: CellValue[][];
}

const text = (v: CellValue, c: GridColumnDef, nullText: string) => (v === null ? nullText : editText(v, c));

export function toTsv(s: CopySource, header: boolean, dataRows = true, nullText = ''): string {
  const lines: string[] = [];
  if (header) lines.push(s.columns.map((c) => c.title).join('\t'));
  if (dataRows) {
    for (const r of s.rows) {
      lines.push(r.map((v, i) => text(v, s.columns[i], nullText).replace(/[\t\r\n]+/g, ' ')).join('\t'));
    }
  }
  return lines.join('\n');
}

function csvCell(v: string, sep: string): string {
  return /["\r\n]/.test(v) || v.includes(sep) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(s: CopySource, header = true, sep = ';'): string {
  const lines: string[] = [];
  if (header) lines.push(s.columns.map((c) => csvCell(c.title, sep)).join(sep));
  for (const r of s.rows) lines.push(r.map((v, i) => csvCell(text(v, s.columns[i], ''), sep)).join(sep));
  return lines.join('\r\n');
}

export function toJson(s: CopySource): string {
  const arr = s.rows.map((r) => {
    const o: Record<string, unknown> = {};
    r.forEach((v, i) => {
      const c = s.columns[i];
      if (v === null) o[c.title] = null;
      else if (v instanceof Uint8Array) o[c.title] = editText(v, c);
      else if (c.numeric && /^-?\d+(\.\d+)?$/.test(v) && Math.abs(Number(v)) < Number.MAX_SAFE_INTEGER) o[c.title] = Number(v);
      else if (c.kind === 'json') {
        try {
          o[c.title] = JSON.parse(v);
        } catch {
          o[c.title] = v;
        }
      } else o[c.title] = v;
    });
    return o;
  });
  return JSON.stringify(arr, null, 2);
}

export function toMarkdown(s: CopySource, nullText = 'NULL'): string {
  const esc = (x: string) => x.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const head = `| ${s.columns.map((c) => esc(c.title)).join(' | ')} |`;
  const sep = `| ${s.columns.map((c) => (c.numeric ? '---:' : '---')).join(' | ')} |`;
  const body = s.rows.map((r) => `| ${r.map((v, i) => esc(text(v, s.columns[i], nullText))).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function valueSql(v: CellValue, c: GridColumnDef): string {
  if (v instanceof Uint8Array && c.kind === 'bit') return `b'${editText(v, c)}'`;
  if (v instanceof Uint8Array && c.kind === 'geometry') return `ST_GeomFromText('${editText(v, c)}')`;
  return literal(v, c.numeric);
}

export function toInsert(schema: string | null, table: string, s: CopySource): string {
  const target = qname(schema, table);
  const cols = s.columns.map((c) => quoteId(c.id)).join(', ');
  return s.rows.map((r) => `INSERT INTO ${target} (${cols}) VALUES (${r.map((v, i) => valueSql(v, s.columns[i])).join(', ')});`).join('\n');
}

/** UPDATE statements; key columns identify the rows (all columns when no key is known). */
export function toUpdate(schema: string | null, table: string, s: CopySource, keyColumns: string[], allColumns?: { columns: GridColumnDef[]; rows: CellValue[][] }): string {
  const target = qname(schema, table);
  return s.rows
    .map((r, ri) => {
      const set = r.map((v, i) => `${quoteId(s.columns[i].id)} = ${valueSql(v, s.columns[i])}`).join(', ');
      const full = allColumns ?? s;
      const fr = allColumns ? allColumns.rows[ri] : r;
      const keys = keyColumns.length ? keyColumns : full.columns.map((c) => c.id);
      const where = keys
        .map((k) => {
          const idx = full.columns.findIndex((c) => c.id === k);
          if (idx < 0) return null;
          const v = fr[idx];
          return v === null ? `${quoteId(k)} IS NULL` : `${quoteId(k)} = ${valueSql(v, full.columns[idx])}`;
        })
        .filter(Boolean)
        .join(' AND ');
      return `UPDATE ${target} SET ${set} WHERE ${where || '1 = 0'};`;
    })
    .join('\n');
}

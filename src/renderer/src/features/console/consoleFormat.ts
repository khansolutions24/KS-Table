// Output of the console in the style of the mysql command line client (ASCII tables, \G, summaries).
// The summary lines intentionally keep the well-known client wording ("3 rows in set (0.01 sec)").

import type { CellValue, ResultColumn, SqlError, StatementResult } from '@shared/types';
import { toHex } from '@shared/sql/quote';
import { firstKeyword } from '@shared/sql/splitter';

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200d
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Width of a text in a monospace terminal (wide CJK / emoji count 2, combining marks 0) */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCombining(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number, right: boolean): string {
  const d = width - displayWidth(s);
  if (d <= 0) return s;
  return right ? ' '.repeat(d) + s : s + ' '.repeat(d);
}

/** Cell value as printed by the client (binary values as hex like --binary-as-hex) */
export function cellText(v: CellValue, inTable: boolean): string {
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array) return v.length ? `0x${toHex(v)}` : '';
  return inTable ? v.replace(/\r\n|\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') : v;
}

export function formatTable(columns: ResultColumn[], rows: CellValue[][]): string {
  const heads = columns.map((c) => c.name);
  const cells = rows.map((r) => columns.map((_, i) => cellText(r[i] ?? null, true)));
  const widths = heads.map((h) => displayWidth(h));
  for (const r of cells) {
    for (let i = 0; i < r.length; i++) {
      const w = displayWidth(r[i]);
      if (w > widths[i]) widths[i] = w;
    }
  }
  const sep = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const right = columns.map((c) => c.numeric);
  const line = (vals: string[], alignRight: boolean) => `| ${vals.map((v, i) => pad(v, widths[i], alignRight && right[i])).join(' | ')} |`;
  const out = [sep, line(heads, false), sep];
  for (const r of cells) out.push(line(r, true));
  out.push(sep);
  return out.join('\n');
}

export function formatVertical(columns: ResultColumn[], rows: CellValue[][]): string {
  const w = Math.max(0, ...columns.map((c) => displayWidth(c.name)));
  const out: string[] = [];
  rows.forEach((r, idx) => {
    out.push(`${'*'.repeat(27)} ${idx + 1}. row ${'*'.repeat(27)}`);
    columns.forEach((c, i) => out.push(`${pad(c.name, w, true)}: ${cellText(r[i] ?? null, false)}`));
  });
  return out.join('\n');
}

export function seconds(ms: number): string {
  return `(${(Math.max(0, ms) / 1000).toFixed(2)} sec)`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function rowsSummary(count: number, ms: number, warnings = 0): string {
  const w = warnings ? `, ${plural(warnings, 'warning')}` : '';
  return count === 0 ? `Empty set${w} ${seconds(ms)}` : `${plural(count, 'row')} in set${w} ${seconds(ms)}`;
}

export function okSummary(affected: number, ms: number, warnings = 0): string {
  const w = warnings ? `, ${plural(warnings, 'warning')}` : '';
  return `Query OK, ${plural(affected, 'row')} affected${w} ${seconds(ms)}`;
}

export function errorLine(e: SqlError): string {
  return e.errno ? `ERROR ${e.errno}${e.sqlState ? ` (${e.sqlState})` : ''}: ${e.message}` : `ERROR: ${e.message}`;
}

export interface FormattedOutput {
  text: string;
  kind: 'result' | 'error';
}

/**
 * Formats one statement result.
 * `truncatedNote` is appended to result sets that hit the row limit.
 */
export function formatStatementResult(
  r: StatementResult,
  opts: { vertical: boolean; showWarnings: boolean; truncatedNote?: string; cancelledNote?: string }
): FormattedOutput {
  if (r.kind === 'error') {
    const e = r.error ?? { message: 'Unknown error' };
    const cancelled = e.errno === 1317 || e.errno === 1927;
    return { kind: 'error', text: `${cancelled && opts.cancelledNote ? `${opts.cancelledNote}\n` : ''}${errorLine(e)}` };
  }
  if (r.kind === 'resultset') {
    const cols = r.columns ?? [];
    const rows = r.rows ?? [];
    const parts: string[] = [];
    if (rows.length) parts.push(opts.vertical ? formatVertical(cols, rows) : formatTable(cols, rows));
    parts.push(rowsSummary(rows.length, r.durationMs, r.warningCount ?? 0));
    if (r.truncated && opts.truncatedNote) parts.push(opts.truncatedNote);
    return { kind: 'result', text: parts.join('\n') };
  }
  if (firstKeyword(r.sql) === 'USE') return { kind: 'result', text: 'Database changed' };
  const lines = [okSummary(r.affectedRows ?? 0, r.durationMs, r.warningCount ?? 0)];
  if (r.info) lines.push(r.info.trim());
  if (opts.showWarnings) for (const w of r.warnings ?? []) lines.push(`${w.level} (Code ${w.code}): ${w.message}`);
  return { kind: 'result', text: lines.join('\n') };
}

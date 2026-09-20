// Export task: streams rows of tables, views or a query into CSV, TXT, JSON, XML, HTML, Excel, SQL or Markdown.

import fs from 'node:fs';
import path from 'node:path';
import type { FieldPacket } from 'mysql2';
import type { CellValue, ResultColumn } from '@shared/types';
import type { ExportFormat, ExportObjectSpec, ExportOptions, ExportProfile, ExportResult } from '@shared/apis/io';
import { tr } from '@shared/i18n';
import { formatNumber, safeFileName } from '@shared/util';
import { qname, quoteId, quoteString } from '@shared/sql/quote';
import { defaultExportOptions, exportExtension, supportsAppend, supportsSameFile } from '@shared/io/defaults';
import { formatNumberText, formatStamp, formatTemporalText } from '@shared/io/datetime';
import { encodeXmlName } from '@shared/io/xmlStream';
import type { BackendContext } from '../../api';
import type { TaskContext } from '../../tasks';
import type { Session } from '../../db/sessions';
import { toResultColumn } from '../../db/fieldTypes';
import { ddl } from '../../db/meta';
import { KsError, toSqlError } from '../../errors';
import { TextOutput } from './files';
import { streamRows } from './rows';

export function normalizeExportProfile(p: ExportProfile): ExportProfile {
  if (!p || typeof p !== 'object') throw new KsError(tr('Ungültiges Exportprofil.', 'Invalid export profile.'));
  const format: ExportFormat = p.format ?? 'csv';
  const out: ExportProfile = {
    version: 1,
    connectionId: String(p.connectionId ?? ''),
    database: p.database ?? null,
    format,
    query: p.query ?? null,
    objects: Array.isArray(p.objects) ? p.objects : [],
    outputDir: p.outputDir ?? '',
    fileNamePattern: p.fileNamePattern || '{name}',
    sameFile: !!p.sameFile && supportsSameFile(format),
    sameFileName: p.sameFileName || 'export',
    timestamp: !!p.timestamp,
    timestampFormat: p.timestampFormat || 'YYYYMMDD_HHmmss',
    options: { ...defaultExportOptions(format), ...(p.options ?? {}) }
  };
  if (!out.connectionId) throw new KsError(tr('Keine Verbindung angegeben.', 'No connection specified.'));
  if (!out.objects.length) throw new KsError(tr('Keine Objekte zum Exportieren ausgewählt.', 'No objects selected for export.'));
  if (!out.outputDir) throw new KsError(tr('Kein Zielordner angegeben.', 'No output folder specified.'));
  if (out.objects.some((o) => o.kind !== 'query') && !out.database) throw new KsError(tr('Keine Datenbank angegeben.', 'No database specified.'));
  if (out.objects.some((o) => o.kind === 'query') && !out.query?.trim()) throw new KsError(tr('Keine Abfrage angegeben.', 'No query specified.'));
  return out;
}

// ───────────────────────── value formatting ─────────────────────────

const RD: Record<ExportOptions['recordDelimiter'], string> = { crlf: '\r\n', lf: '\n', cr: '\r' };

type Kind = 'number' | 'year' | 'date' | 'datetime' | 'time' | 'bit' | 'binary' | 'geometry' | 'json' | 'text';

function kindOf(c: ResultColumn): Kind {
  const t = c.typeName;
  if (t === 'YEAR') return 'year';
  if (t === 'DATE') return 'date';
  if (t === 'DATETIME' || t === 'TIMESTAMP') return 'datetime';
  if (t === 'TIME') return 'time';
  if (t === 'BIT') return 'bit';
  if (t === 'GEOMETRY') return 'geometry';
  if (t === 'JSON') return 'json';
  if (c.binary) return 'binary';
  if (c.numeric) return 'number';
  return 'text';
}

function bytesToInt(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n.toString();
}

function encodeBinary(b: Uint8Array, enc: ExportOptions['binaryEncoding'], kind: Kind): string {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (enc === 'base64') return buf.toString('base64');
  if (enc === 'hex' || kind === 'geometry') return buf.toString('hex').toUpperCase();
  return buf.toString('utf8');
}

interface Col {
  name: string;
  kind: Kind;
  meta: ResultColumn;
}

/** Text of a value (null = NULL); `local` applies number separators and zero blanking */
function cellText(v: CellValue, c: Col, o: ExportOptions, local: boolean): string | null {
  if (v === null) return null;
  if (v instanceof Uint8Array) {
    if (c.kind === 'bit') return bytesToInt(v);
    return encodeBinary(v, o.binaryEncoding, c.kind);
  }
  switch (c.kind) {
    case 'date':
    case 'datetime':
    case 'time':
      return formatTemporalText(v, c.kind, o.dateFormat || 'YYYY-MM-DD', o.timeFormat || 'HH:mm:ss');
    case 'number':
      if (!local) return v;
      if (o.blankIfZero && Number(v) === 0) return '';
      return formatNumberText(v, o.decimalSeparator || '.', o.thousandsSeparator);
    default:
      return v;
  }
}

// ───────────────────────── writers ─────────────────────────

interface Writer {
  /** Called once per object before its rows */
  begin(name: string, cols: Col[]): Promise<void>;
  rows(rows: CellValue[][]): Promise<void>;
  end(): Promise<void>;
  /** Finishes the file */
  close(): Promise<void>;
  abort(): Promise<void>;
}

const XML_INVALID = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g;
const xmlText = (s: string) => s.replace(XML_INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const xmlAttr = (s: string) => xmlText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
const htmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

abstract class TextWriter implements Writer {
  constructor(
    protected readonly out: TextOutput,
    protected readonly o: ExportOptions
  ) {}
  protected cols: Col[] = [];
  protected name = '';
  protected count = 0;

  async begin(name: string, cols: Col[]): Promise<void> {
    this.name = name;
    this.cols = cols;
    this.count = 0;
    await this.head();
  }
  protected abstract head(): Promise<void>;
  protected abstract row(r: CellValue[]): string;
  async rows(rows: CellValue[][]): Promise<void> {
    const parts: string[] = [];
    for (const r of rows) {
      parts.push(this.row(r));
      this.count++;
    }
    await this.out.write(parts.join(''));
  }
  async end(): Promise<void> {
    await this.out.flush();
  }
  async close(): Promise<void> {
    await this.out.close();
  }
  async abort(): Promise<void> {
    await this.out.abort();
  }
}

class DelimitedWriter extends TextWriter {
  private rd = RD[this.o.recordDelimiter] ?? '\r\n';
  private q = this.o.textQualifier;
  private fd = this.o.fieldDelimiter;

  /** Escaping without text qualifier (MySQL style: \n, \t, \N …) */
  private escapeOnly(s: string): string {
    const e = this.o.escapeChar;
    let out = '';
    for (const ch of s) {
      if (ch === e) out += e + e;
      else if (ch === '\n') out += e + 'n';
      else if (ch === '\r') out += e + 'r';
      else if (ch === '\t') out += e + 't';
      else if (ch === '\0') out += e + '0';
      else if (this.fd && ch === this.fd[0]) out += e + ch;
      else out += ch;
    }
    return out;
  }

  private quote(s: string): string {
    const q = this.q;
    const esc = this.o.escapeChar;
    const body = esc ? s.split(esc).join(esc + esc).split(q).join(esc + q) : s.split(q).join(q + q);
    return q + body + q;
  }

  private field(v: string | null): string {
    if (v === null) return this.o.nullText;
    if (!this.q) {
      if (this.o.escapeChar) return this.escapeOnly(v);
      return v;
    }
    const need =
      this.o.quoteAll ||
      v === '' ||
      (this.fd && v.includes(this.fd)) ||
      v.includes(this.q) ||
      /[\r\n]/.test(v) ||
      v !== v.trim() ||
      (this.o.escapeChar && v.includes(this.o.escapeChar)) ||
      (this.o.nullText !== '' && v === this.o.nullText);
    return need ? this.quote(v) : v;
  }

  protected async head(): Promise<void> {
    if (!this.o.header || this.out.existed) return;
    await this.out.write(this.cols.map((c) => this.field(c.name)).join(this.fd) + this.rd);
  }

  protected row(r: CellValue[]): string {
    return r.map((v, i) => this.field(cellText(v, this.cols[i], this.o, true))).join(this.fd) + this.rd;
  }
}

class FixedWriter extends TextWriter {
  private widths: number[] = [];
  private rd = RD[this.o.recordDelimiter] ?? '\r\n';

  private cell(s: string, i: number): string {
    const w = this.widths[i];
    const flat = s.replace(/[\r\n\t]/g, ' ');
    const chars = Array.from(flat);
    const cut = chars.length > w ? chars.slice(0, w).join('') : flat;
    const padding = ' '.repeat(Math.max(0, w - Math.min(chars.length, w)));
    return this.cols[i].kind === 'number' ? padding + cut : cut + padding;
  }

  protected async head(): Promise<void> {
    this.widths = this.cols.map((c) => {
      const m = c.meta;
      let w: number;
      switch (c.kind) {
        case 'date':
          w = Math.max(10, (this.o.dateFormat || '').length);
          break;
        case 'datetime':
          w = Math.max(19, (this.o.dateFormat + ' ' + this.o.timeFormat).length) + (m.decimals > 0 && m.decimals < 31 ? m.decimals + 1 : 0);
          break;
        case 'time':
          w = Math.max(10, (this.o.timeFormat || '').length) + (m.decimals > 0 && m.decimals < 31 ? m.decimals + 1 : 0);
          break;
        case 'number':
        case 'year':
          w = Math.max(m.length + 1, 4);
          break;
        case 'bit':
          w = 20;
          break;
        default:
          w = c.meta.binary ? Math.min(Math.ceil(m.length * 2), 512) : Math.ceil(m.length / 4);
      }
      w = Math.min(Math.max(w, 1), 1000);
      return this.o.header ? Math.max(w, Array.from(c.name).length) : w;
    });
    if (!this.o.header) return;
    await this.out.write(this.cols.map((c, i) => this.cell(c.name, i)).join(' ') + this.rd);
  }

  protected row(r: CellValue[]): string {
    return r.map((v, i) => this.cell(cellText(v, this.cols[i], this.o, true) ?? this.o.nullText, i)).join(' ') + this.rd;
  }
}

class JsonWriter extends TextWriter {
  private objects = 0;
  constructor(
    out: TextOutput,
    o: ExportOptions,
    private readonly multi: boolean
  ) {
    super(out, o);
  }

  private value(v: CellValue, c: Col): string {
    if (v === null) return 'null';
    if (c.kind === 'json' && typeof v === 'string') {
      try {
        const parsed = JSON.parse(v) as unknown;
        return this.o.jsonPretty && this.o.jsonLayout === 'array' ? JSON.stringify(parsed, null, 2).replace(/\n/g, '\n      ') : JSON.stringify(parsed);
      } catch {
        return JSON.stringify(v);
      }
    }
    const t = cellText(v, c, this.o, false)!;
    if ((c.kind === 'number' || c.kind === 'year' || c.kind === 'bit') && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return t;
    return JSON.stringify(t);
  }

  protected async head(): Promise<void> {
    if (this.o.jsonLayout === 'lines') return;
    const pretty = this.o.jsonPretty;
    let s = '';
    if (this.multi) {
      s += this.objects === 0 ? '{' : ',';
      s += `${pretty ? '\n  ' : ''}${JSON.stringify(this.name)}:${pretty ? ' ' : ''}[`;
    } else s += '[';
    this.objects++;
    await this.out.write(s);
  }

  protected row(r: CellValue[]): string {
    const pretty = this.o.jsonPretty && this.o.jsonLayout === 'array';
    const ind = this.multi ? '    ' : '  ';
    const props = r.map((v, i) => `${JSON.stringify(this.cols[i].name)}:${pretty ? ' ' : ''}${this.value(v, this.cols[i])}`);
    if (this.o.jsonLayout === 'lines') return `{${props.join(',')}}\n`;
    const sep = this.count === 0 ? '' : ',';
    if (!pretty) return `${sep}{${props.join(',')}}`;
    return `${sep}\n${ind}{\n${props.map((p) => `${ind}  ${p}`).join(',\n')}\n${ind}}`;
  }

  override async end(): Promise<void> {
    if (this.o.jsonLayout !== 'lines') {
      const pretty = this.o.jsonPretty;
      await this.out.write(this.count && pretty ? `\n${this.multi ? '  ' : ''}]` : ']');
    }
    await this.out.flush();
  }

  override async close(): Promise<void> {
    if (this.o.jsonLayout !== 'lines') {
      if (this.multi) await this.out.write(this.objects ? (this.o.jsonPretty ? '\n}\n' : '}') : '{}');
      else if (!this.objects) await this.out.write('[]');
      else if (this.o.jsonPretty) await this.out.write('\n');
    }
    await this.out.close();
  }
}

class XmlWriter extends TextWriter {
  private started = false;
  constructor(
    out: TextOutput,
    o: ExportOptions,
    private readonly multi: boolean,
    private readonly xmlEncoding: string
  ) {
    super(out, o);
  }
  private tags: string[] = [];

  protected async head(): Promise<void> {
    let s = '';
    if (!this.started) {
      this.started = true;
      s += `<?xml version="1.0" encoding="${this.xmlEncoding}"?>\n`;
      if (this.multi) s += '<DATA xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n';
    }
    this.tags = this.cols.map((c) => encodeXmlName(c.name));
    s += this.multi ? `  <RECORDS name="${xmlAttr(this.name)}">\n` : '<RECORDS xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n';
    await this.out.write(s);
  }

  protected row(r: CellValue[]): string {
    const ind = this.multi ? '    ' : '  ';
    if (this.o.xmlAttributes) {
      const attrs = r
        .map((v, i) => {
          const t = cellText(v, this.cols[i], this.o, true);
          return t === null ? '' : ` ${this.tags[i]}="${xmlAttr(t)}"`;
        })
        .join('');
      return `${ind}<RECORD${attrs}/>\n`;
    }
    const inner = r
      .map((v, i) => {
        const t = cellText(v, this.cols[i], this.o, true);
        const tag = this.tags[i];
        return t === null ? `${ind}  <${tag} xsi:nil="true"/>\n` : `${ind}  <${tag}>${xmlText(t)}</${tag}>\n`;
      })
      .join('');
    return `${ind}<RECORD>\n${inner}${ind}</RECORD>\n`;
  }

  override async end(): Promise<void> {
    await this.out.write(this.multi ? '  </RECORDS>\n' : '</RECORDS>\n');
    await this.out.flush();
  }

  override async close(): Promise<void> {
    if (this.multi) await this.out.write(this.started ? '</DATA>\n' : '<?xml version="1.0"?>\n<DATA/>\n');
    await this.out.close();
  }
}

class HtmlWriter extends TextWriter {
  private started = false;
  constructor(
    out: TextOutput,
    o: ExportOptions,
    private readonly title: string,
    private readonly charset: string
  ) {
    super(out, o);
  }

  protected async head(): Promise<void> {
    let s = '';
    if (!this.started) {
      this.started = true;
      s += `<!DOCTYPE html>
<html>
<head>
<meta charset="${this.charset}">
<title>${htmlText(this.title)}</title>
<style>
body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 13px; color: #1d2228; background: #fff; margin: 24px; }
h2 { font-size: 16px; margin: 24px 0 8px; }
table { border-collapse: collapse; margin-bottom: 8px; }
th, td { border: 1px solid #d5dae1; padding: 4px 8px; vertical-align: top; text-align: left; white-space: pre-wrap; }
th { background: #eef1f5; font-weight: 600; position: sticky; top: 0; }
tr:nth-child(even) td { background: #f8f9fb; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.null { color: #9aa1ab; font-style: italic; }
.count { color: #626a75; font-size: 12px; }
@media (prefers-color-scheme: dark) {
  body { background: #1b1e23; color: #e2e5ea; }
  th, td { border-color: #3f444d; }
  th { background: #2a2e35; }
  tr:nth-child(even) td { background: #23262c; }
  td.null, .count { color: #9ca3ae; }
}
</style>
</head>
<body>
`;
    }
    s += `<h2>${htmlText(this.name)}</h2>\n<table>\n`;
    if (this.o.header) s += `<thead><tr>${this.cols.map((c) => `<th>${htmlText(c.name)}</th>`).join('')}</tr></thead>\n`;
    s += '<tbody>\n';
    await this.out.write(s);
  }

  protected row(r: CellValue[]): string {
    return `<tr>${r
      .map((v, i) => {
        const t = cellText(v, this.cols[i], this.o, true);
        if (t === null) return `<td class="null">${htmlText(this.o.nullText)}</td>`;
        return this.cols[i].kind === 'number' ? `<td class="num">${htmlText(t)}</td>` : `<td>${htmlText(t)}</td>`;
      })
      .join('')}</tr>\n`;
  }

  override async end(): Promise<void> {
    await this.out.write(`</tbody>\n</table>\n<div class="count">${htmlText(tr('{n} Datensätze', '{n} records', { n: formatNumber(this.count) }))}</div>\n`);
    await this.out.flush();
  }

  override async close(): Promise<void> {
    await this.out.write(this.started ? '</body>\n</html>\n' : `<!DOCTYPE html>\n<html><head><meta charset="${this.charset}"></head><body></body></html>\n`);
    await this.out.close();
  }
}

class MarkdownWriter extends TextWriter {
  private first = true;
  private md(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n|\r/g, '<br>');
  }

  protected async head(): Promise<void> {
    let s = this.first && !this.out.existed ? '' : '\n';
    this.first = false;
    s += `## ${this.md(this.name)}\n\n`;
    s += `| ${this.cols.map((c) => this.md(c.name)).join(' | ')} |\n`;
    s += `|${this.cols.map((c) => (c.kind === 'number' ? ' ---: ' : ' --- ')).join('|')}|\n`;
    await this.out.write(s);
  }

  protected row(r: CellValue[]): string {
    return `| ${r.map((v, i) => { const t = cellText(v, this.cols[i], this.o, true); return t === null ? this.md(this.o.nullText) : this.md(t); }).join(' | ')} |\n`;
  }
}

class SqlWriter extends TextWriter {
  private pending: string[] = [];
  private pendingLen = 0;
  private head0 = '';
  constructor(
    out: TextOutput,
    o: ExportOptions,
    private readonly s: Session,
    private readonly db: string | null,
    private readonly kind: ExportObjectSpec['kind'],
    private readonly sourceName: string
  ) {
    super(out, o);
  }

  private literal(v: CellValue, c: Col): string {
    if (v === null) return 'NULL';
    if (v instanceof Uint8Array) {
      if (c.kind === 'bit') return bytesToInt(v);
      return v.length ? `X'${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex').toUpperCase()}'` : "''";
    }
    if ((c.kind === 'number' || c.kind === 'year') && /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)) return v;
    return quoteString(v);
  }

  protected async head(): Promise<void> {
    const tbl = quoteId(this.name);
    let s = this.out.bytes === 0 && !this.out.existed ? `-- ${tr('Exportiert mit KS Table', 'Exported with KS Table')}\nSET NAMES utf8mb4;\n` : '';
    s += `\n-- ${tr('Daten von {n}', 'Data of {n}', { n: this.name })}\n`;
    if (this.o.sqlDropTable) s += `DROP TABLE IF EXISTS ${tbl};\n`;
    if (this.o.sqlCreateTable) {
      if (this.kind === 'table' && this.db) {
        let create = await ddl(this.s, this.db, 'table', this.sourceName);
        if (this.name !== this.sourceName) create = create.replace(/^CREATE TABLE `(?:[^`]|``)+`/, `CREATE TABLE ${tbl}`);
        s += `${this.o.sqlDropTable ? create : create.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ')};\n`;
      } else {
        const defs = this.cols.map((c) => `  ${quoteId(c.name)} ${sqlTypeOf(c.meta)}`);
        s += `CREATE TABLE ${this.o.sqlDropTable ? '' : 'IF NOT EXISTS '}${tbl} (\n${defs.join(',\n')}\n);\n`;
      }
    }
    this.head0 = `INSERT INTO ${tbl} (${this.cols.map((c) => quoteId(c.name)).join(', ')}) VALUES\n`;
    await this.out.write(s);
  }

  protected row(r: CellValue[]): string {
    const tuple = `(${r.map((v, i) => this.literal(v, this.cols[i])).join(', ')})`;
    const per = Math.max(1, this.o.sqlRowsPerStatement || 1);
    let flushed = '';
    if (this.pending.length && (this.pending.length >= per || this.pendingLen + tuple.length > 1024 * 1024)) flushed = this.take();
    this.pending.push(tuple);
    this.pendingLen += tuple.length;
    return flushed;
  }

  private take(): string {
    if (!this.pending.length) return '';
    const s = `${this.head0}${this.pending.join(',\n')};\n`;
    this.pending = [];
    this.pendingLen = 0;
    return s;
  }

  override async end(): Promise<void> {
    await this.out.write(this.take());
    await this.out.flush();
  }
}

function sqlTypeOf(m: ResultColumn): string {
  const t = m.typeName;
  if (['VARCHAR', 'CHAR', 'VARBINARY', 'BINARY'].includes(t)) {
    const len = m.binary ? m.length : Math.max(1, Math.round(m.length / 4));
    return `${t}(${Math.min(Math.max(len, 1), t.startsWith('VAR') ? 16383 : 255)})`;
  }
  if (t === 'DECIMAL') return `DECIMAL(${Math.max(1, m.length - (m.decimals > 0 ? 1 : 0) - (m.unsigned ? 0 : 1))},${m.decimals})`;
  if ((t === 'DATETIME' || t === 'TIMESTAMP' || t === 'TIME') && m.decimals > 0 && m.decimals <= 6) return `${t}(${m.decimals})`;
  if (t === 'BIT') return `BIT(${Math.max(1, m.length)})`;
  if (t === 'ENUM' || t === 'SET' || t === 'NULL' || t === 'UNKNOWN') return 'TEXT';
  return `${t}${m.unsigned && m.numeric ? ' UNSIGNED' : ''}`;
}

type ExcelModule = typeof import('exceljs');

class XlsxWriter implements Writer {
  private wb: InstanceType<ExcelModule['stream']['xlsx']['WorkbookWriter']> | null = null;
  private ws: ReturnType<InstanceType<ExcelModule['stream']['xlsx']['WorkbookWriter']>['addWorksheet']> | null = null;
  private cols: Col[] = [];
  private names = new Set<string>();
  private truncated = false;

  constructor(
    private readonly file: string,
    private readonly o: ExportOptions,
    private readonly t: TaskContext
  ) {}

  private async workbook() {
    if (!this.wb) {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const mod = (await import('exceljs')) as ExcelModule & { default?: ExcelModule };
      const ExcelJS = mod.default ?? mod;
      this.wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: this.file, useStyles: true, useSharedStrings: false });
      this.wb.creator = 'KS Table';
    }
    return this.wb;
  }

  async begin(name: string, cols: Col[]): Promise<void> {
    const wb = await this.workbook();
    let base = name.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet';
    for (let k = 2; this.names.has(base.toLowerCase()); k++) base = `${base.slice(0, 28)}_${k}`;
    this.names.add(base.toLowerCase());
    this.ws = wb.addWorksheet(base, { views: this.o.header ? [{ state: 'frozen', ySplit: 1 }] : [] });
    this.cols = cols;
    this.ws.columns = cols.map((c) => ({ key: c.name, width: Math.min(60, Math.max(10, c.name.length + 2)) }));
    if (this.o.header) {
      const r = this.ws.addRow(cols.map((c) => c.name));
      r.font = { bold: true };
      r.commit();
    }
  }

  private cell(v: CellValue, c: Col): unknown {
    if (v === null) return this.o.nullText === '' ? null : this.o.nullText;
    if (v instanceof Uint8Array) {
      if (c.kind === 'bit') {
        const n = bytesToInt(v);
        return Number.isSafeInteger(Number(n)) ? Number(n) : n;
      }
      return encodeBinary(v, this.o.binaryEncoding, c.kind);
    }
    if (c.kind === 'number' || c.kind === 'year') {
      if (this.o.blankIfZero && Number(v) === 0) return null;
      const n = Number(v);
      const digits = v.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length;
      if (Number.isFinite(n) && (digits <= 15 || /e/i.test(v))) return n;
      return v;
    }
    let s = cellText(v, c, this.o, false) ?? '';
    s = s.replace(XML_INVALID, '');
    if (s.length > 32767) {
      s = s.slice(0, 32767);
      if (!this.truncated) {
        this.truncated = true;
        this.t.log('warn', tr('Werte mit mehr als 32.767 Zeichen wurden für Excel gekürzt.', 'Values longer than 32,767 characters were truncated for Excel.'));
      }
    }
    return s;
  }

  async rows(rows: CellValue[][]): Promise<void> {
    const ws = this.ws!;
    for (const r of rows) ws.addRow(r.map((v, i) => this.cell(v, this.cols[i]))).commit();
    await new Promise((res) => setImmediate(res));
  }

  async end(): Promise<void> {
    this.ws?.commit();
    this.ws = null;
  }

  async close(): Promise<void> {
    const wb = await this.workbook();
    if (!this.names.size) wb.addWorksheet('Sheet1').commit();
    await wb.commit();
  }

  async abort(): Promise<void> {
    try {
      if (this.wb) await this.wb.commit();
    } catch {
      // ignore
    }
    await fs.promises.rm(this.file, { force: true }).catch(() => undefined);
  }
}

// ───────────────────────── task ─────────────────────────

function outputEncoding(o: ExportOptions): { text: string; label: string } {
  const e = o.encoding || 'utf8';
  const label = e === 'utf8' || e === 'utf8bom' ? 'UTF-8' : e.replace(/^windows(\d+)$/, 'windows-$1').replace(/^iso8859(\d+)$/, 'ISO-8859-$1').replace(/^utf16(le|be)$/, 'UTF-16');
  return { text: e, label };
}

async function createWriter(
  p: ExportProfile,
  file: string,
  s: Session,
  t: TaskContext,
  multi: boolean,
  obj: ExportObjectSpec,
  title: string
): Promise<Writer> {
  const o = p.options;
  if (p.format === 'xlsx') return new XlsxWriter(file, o, t);
  const enc = outputEncoding(o);
  const append = o.append && supportsAppend(p.format, o);
  const out = await TextOutput.open(file, enc.text, append);
  switch (p.format) {
    case 'txt':
      return o.txtLayout === 'fixed' ? new FixedWriter(out, o) : new DelimitedWriter(out, o);
    case 'json':
      return new JsonWriter(out, o, multi);
    case 'xml':
      return new XmlWriter(out, o, multi, enc.label);
    case 'html':
      return new HtmlWriter(out, o, title, enc.label);
    case 'md':
      return new MarkdownWriter(out, o);
    case 'sql':
      return new SqlWriter(out, o, s, p.database, obj.kind, obj.name);
    default:
      return new DelimitedWriter(out, o);
  }
}

export function exportFileName(p: ExportProfile, obj: ExportObjectSpec, stamp: string): string {
  let base = obj.fileName?.trim()
    ? obj.fileName.trim().replace(/\.[A-Za-z0-9]{1,5}$/, '')
    : p.fileNamePattern.replace(/\{name\}/g, obj.name).replace(/\{db\}/g, p.database ?? '');
  base = safeFileName(base);
  if (stamp) base += `_${stamp}`;
  return base + exportExtension(p.format, p.options);
}

export async function runExport(ctx: BackendContext, profile: ExportProfile, t: TaskContext): Promise<ExportResult> {
  const p = normalizeExportProfile(profile);
  const o = p.options;
  const stamp = p.timestamp ? safeFileName(formatStamp(p.timestampFormat, new Date())) : '';
  const s = await ctx.sessions.open(p.connectionId, p.database);
  const files: string[] = [];
  let total = 0;
  let errors = 0;
  let shared: Writer | null = null;
  try {
    // row estimates for progress
    const estimates = new Map<string, number>();
    if (p.database) {
      const rows = await s.rows<{ n: string; r: string | null }>(
        'SELECT TABLE_NAME AS n, TABLE_ROWS AS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [p.database]
      );
      for (const r of rows) estimates.set(String(r.n), Number(r.r ?? 0));
    }
    if (p.sameFile) {
      const file = path.join(p.outputDir, safeFileName(p.sameFileName.replace(/\.[A-Za-z0-9]{1,5}$/, '')) + (stamp ? `_${stamp}` : '') + exportExtension(p.format, o));
      shared = await createWriter(p, file, s, t, p.objects.length > 1, p.objects[0], p.sameFileName);
      files.push(file);
    }
    const count = p.objects.length;
    for (let idx = 0; idx < count; idx++) {
      const obj = p.objects[idx];
      t.throwIfCancelled();
      const file = shared ? files[0] : path.join(p.outputDir, exportFileName(p, obj, stamp));
      t.log('info', tr('Exportiere {n} → {f}', 'Exporting {n} → {f}', { n: obj.name, f: file }));
      let writer: Writer | null = shared;
      let rows = 0;
      try {
        const sql =
          obj.kind === 'query'
            ? p.query!.trim().replace(/;\s*$/, '')
            : `SELECT ${obj.fields?.length ? obj.fields.map(quoteId).join(', ') : '*'} FROM ${qname(p.database, obj.name)}`;
        let cols: Col[] = [];
        let proj: number[] | null = null;
        let begun = false;
        const est = estimates.get(obj.name) ?? 0;
        const onFields = (f: FieldPacket[]) => {
          const all = f.map((x) => {
            const meta = toResultColumn(x);
            return { name: meta.name, kind: kindOf(meta), meta };
          });
          if (obj.kind === 'query' && obj.fields?.length) {
            proj = obj.fields.map((n) => all.findIndex((c) => c.name === n)).filter((i) => i >= 0);
            cols = proj.map((i) => all[i]);
          } else cols = all;
        };
        for await (const batch of streamRows(s, sql, onFields)) {
          t.throwIfCancelled();
          if (!begun) {
            if (!writer) writer = await createWriter(p, file, s, t, false, obj, obj.name);
            await writer.begin(obj.name, cols);
            begun = true;
          }
          const pj = proj as number[] | null;
          await writer!.rows(pj ? batch.map((r) => pj.map((i) => r[i])) : batch);
          rows += batch.length;
          const frac = est > 0 ? Math.min(0.99, rows / est) : 0.5;
          t.progress((idx + frac) / count, tr('{n}: {r} Datensätze', '{n}: {r} records', { n: obj.name, r: formatNumber(rows) }));
        }
        if (!begun) {
          if (!cols.length) throw new KsError(tr('Die Abfrage liefert keine Ergebnismenge.', 'The query does not return a result set.'));
          if (!writer) writer = await createWriter(p, file, s, t, false, obj, obj.name);
          await writer.begin(obj.name, cols);
        }
        await writer!.end();
        if (!shared) {
          await writer!.close();
          files.push(file);
        }
        total += rows;
        t.log('info', tr('{n}: {r} Datensätze exportiert.', '{n}: {r} records exported.', { n: obj.name, r: formatNumber(rows) }));
      } catch (e) {
        if (writer && !shared) await writer.abort().catch(() => undefined);
        if ((e as Error)?.name === 'CancelledError' || !o.continueOnError || shared) throw e;
        errors++;
        t.log('error', `${obj.name}: ${toSqlError(e).message}`);
      }
      t.progress((idx + 1) / count);
    }
    if (shared) await shared.close();
    shared = null;
    t.log(errors ? 'warn' : 'success', tr('Export beendet: {n} Datensätze, {f} Datei(en).', 'Export finished: {n} records, {f} file(s).', { n: formatNumber(total), f: files.length }));
    return { objects: count, rows: total, files, errors };
  } catch (e) {
    if (shared) await (shared as Writer).abort().catch(() => undefined);
    throw e;
  } finally {
    await ctx.sessions.close(s.id);
  }
}

/** Column names of a query result */
export async function queryColumnNames(ctx: BackendContext, connectionId: string, database: string | null, sql: string): Promise<string[]> {
  const s = await ctx.sessions.open(connectionId, database);
  try {
    let names: string[] = [];
    const clean = sql.trim().replace(/;\s*$/, '');
    try {
      const r = await s.rowset(`SELECT * FROM (${clean}) AS ks_q LIMIT 0`);
      return r.fields.map((f) => f.name);
    } catch {
      // not a SELECT that can be wrapped (SHOW, CALL …): read the field list of the real statement
    }
    for await (const batch of streamRows(s, clean, (f) => (names = f.map((x) => x.name)), 1)) {
      void batch;
      break;
    }
    return names;
  } finally {
    await ctx.sessions.close(s.id);
  }
}

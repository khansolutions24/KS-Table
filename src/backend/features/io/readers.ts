// Import sources: delimited text, JSON, XML and Excel files read as streams of records.

import fs from 'node:fs';
import yauzl from 'yauzl';
import type { ImportFormat, ImportParseOptions, ImportPreview, ImportPreviewRequest, XmlElementInfo } from '@shared/apis/io';
import { tr } from '@shared/i18n';
import { DelimitedParser, FIELD_NULL, FIELD_UNQUOTED, uniqueFieldNames, type DelimitedRecord } from '@shared/io/delimited';
import { JsonRecordScanner, parseJsonRecord, type JsonCell } from '@shared/io/jsonStream';
import { decodeXmlText, XmlRecordReader, XmlSurvey } from '@shared/io/xmlStream';
import { KsError } from '../../errors';
import { fileSize, readTextChunks, readTextHead } from './files';
import { inferType, valueText, type SourceValue } from './convert';

export interface SourceRecord {
  /** Row / record number in the source */
  rowNo: number;
  /** Values by field index (undefined = no value) */
  values: SourceValue[];
  /** The record could not be read */
  error?: string;
}

export interface SourceReader {
  /** Field names; JSON / XML sources add fields while reading */
  readonly fields: string[];
  readonly totalBytes: number;
  bytesRead(): number;
  records(): AsyncGenerator<SourceRecord[]>;
}

/** Applies trim / NULL / empty rules to a text value */
function textValue(s: string, o: ImportParseOptions): SourceValue {
  const v = o.trim ? s.trim() : s;
  if (v === '' && o.emptyAsNull) return null;
  return v;
}

function delimitedValue(v: string, kind: number, o: ImportParseOptions): SourceValue {
  if (kind === FIELD_NULL) return null;
  const s = o.trim ? v.trim() : v;
  if (kind === FIELD_UNQUOTED) {
    if (o.nullText && s === o.nullText) return null;
    // without NULL notation an unquoted empty value means "no value"
    if (s === '') return o.emptyAsNull ? null : o.nullText || o.escapeChar ? '' : undefined;
  }
  if (s === '' && o.emptyAsNull) return null;
  return s;
}

function rowRange(o: ImportParseOptions): { header: number; first: number; last: number } {
  const header = Math.max(0, Math.floor(o.headerRow || 0));
  const first = o.firstDataRow > 0 ? Math.floor(o.firstDataRow) : header > 0 ? header + 1 : 1;
  return { header, first, last: Math.max(0, Math.floor(o.lastDataRow || 0)) };
}

function growFields(fields: string[], n: number): void {
  while (fields.length < n) fields.push(`F${fields.length + 1}`);
}

class DelimitedSource implements SourceReader {
  fields: string[] = [];
  private read = 0;

  constructor(
    private readonly file: string,
    private readonly encoding: string,
    private readonly o: ImportParseOptions,
    readonly totalBytes: number
  ) {}

  bytesRead(): number {
    return this.read;
  }

  async *records(): AsyncGenerator<SourceRecord[]> {
    const o = this.o;
    const { header, first, last } = rowRange(o);
    const parser = new DelimitedParser({
      fieldDelimiter: o.fieldDelimiter,
      recordDelimiter: o.recordDelimiter,
      qualifier: o.textQualifier,
      escapeChar: o.escapeChar
    });
    let out: SourceRecord[] = [];
    let done = false;
    const onRec = (r: DelimitedRecord): boolean | void => {
      if (r.no === header) {
        this.fields = uniqueFieldNames(r.values);
        return;
      }
      if (r.no < first) return;
      if (last > 0 && r.no > last) {
        done = true;
        return false;
      }
      growFields(this.fields, r.values.length);
      out.push({ rowNo: r.no, values: r.values.map((v, i) => delimitedValue(v, r.kinds[i], o)) });
    };
    for await (const chunk of readTextChunks(this.file, this.encoding, (n) => (this.read += n))) {
      parser.feed(chunk, onRec);
      if (out.length) {
        yield out;
        out = [];
      }
      if (done) return;
    }
    parser.end(onRec);
    if (out.length) yield out;
  }
}

function jsonValue(c: JsonCell, o: ImportParseOptions): SourceValue {
  if (c === null) return null;
  if (typeof c === 'string') return textValue(c, o);
  return c;
}

class JsonSource implements SourceReader {
  fields: string[] = [];
  private index = new Map<string, number>();
  private read = 0;

  constructor(
    private readonly file: string,
    private readonly encoding: string,
    private readonly o: ImportParseOptions,
    readonly totalBytes: number
  ) {}

  bytesRead(): number {
    return this.read;
  }

  private fieldIndex(name: string): number {
    let i = this.index.get(name);
    if (i === undefined) {
      i = this.fields.length;
      this.index.set(name, i);
      this.fields.push(name);
    }
    return i;
  }

  async *records(): AsyncGenerator<SourceRecord[]> {
    const scanner = new JsonRecordScanner();
    let out: SourceRecord[] = [];
    let no = 0;
    const onRaw = (raw: string) => {
      no++;
      try {
        const r = parseJsonRecord(raw);
        const values: SourceValue[] = [];
        r.names.forEach((n, i) => {
          values[this.fieldIndex(n)] = jsonValue(r.values[i], this.o);
        });
        out.push({ rowNo: no, values });
      } catch (e) {
        out.push({ rowNo: no, values: [], error: e instanceof Error ? e.message : String(e) });
      }
    };
    for await (const chunk of readTextChunks(this.file, this.encoding, (n) => (this.read += n))) {
      scanner.feed(chunk, onRaw);
      if (out.length) {
        yield out;
        out = [];
      }
    }
    scanner.end(onRaw);
    if (out.length) yield out;
  }
}

class XmlSource implements SourceReader {
  fields: string[] = [];
  private index = new Map<string, number>();
  private read = 0;

  constructor(
    private readonly file: string,
    private readonly encoding: string,
    private readonly o: ImportParseOptions,
    readonly totalBytes: number
  ) {}

  bytesRead(): number {
    return this.read;
  }

  async *records(): AsyncGenerator<SourceRecord[]> {
    if (!this.o.xmlRowTag) throw new KsError(tr('Bitte das XML-Element wählen, das einen Datensatz darstellt.', 'Please choose the XML element that represents a record.'));
    const reader = new XmlRecordReader({ rowTag: this.o.xmlRowTag, attributes: this.o.xmlAttributes });
    let out: SourceRecord[] = [];
    let no = 0;
    const onRec = (r: { names: string[]; values: (string | null)[] }) => {
      no++;
      const values: SourceValue[] = [];
      r.names.forEach((n, i) => {
        let idx = this.index.get(n);
        if (idx === undefined) {
          idx = this.fields.length;
          this.index.set(n, idx);
          this.fields.push(n);
        }
        const v = r.values[i];
        values[idx] = v === null ? null : textValue(v, this.o);
      });
      out.push({ rowNo: no, values });
    };
    for await (const chunk of readTextChunks(this.file, this.encoding, (n) => (this.read += n), true)) {
      reader.feed(chunk, onRec);
      if (out.length) {
        yield out;
        out = [];
      }
    }
    reader.end(onRec);
    if (out.length) yield out;
  }
}

const pad = (n: number, l = 2) => String(n).padStart(l, '0');

/** Excel date cell (exceljs builds it from the serial number as UTC) → MySQL notation */
function excelDateText(d: Date): string {
  const t = d.getTime();
  if (isNaN(t)) return '';
  let ms = Math.round(t) % 1000;
  if (ms < 0) ms += 1000;
  // floating point noise of Excel serial numbers
  const base = ms <= 1 ? t - ms : ms >= 999 ? t + (1000 - ms) : t;
  const x = new Date(base);
  const frac = ms <= 1 || ms >= 999 ? '' : `.${pad(ms, 3)}`;
  const y = x.getUTCFullYear();
  const mo = x.getUTCMonth() + 1;
  const day = x.getUTCDate();
  const hh = x.getUTCHours();
  const mi = x.getUTCMinutes();
  const ss = x.getUTCSeconds();
  const time = hh || mi || ss || frac ? `${pad(hh)}:${pad(mi)}:${pad(ss)}${frac}` : '';
  if (y === 1899 && mo === 12 && (day === 30 || day === 31)) return time || '00:00:00';
  return `${pad(y, 4)}-${pad(mo)}-${pad(day)}${time ? ` ${time}` : ''}`;
}

export function excelCellText(v: unknown): SourceValue {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)));
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return excelDateText(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((p) => p.text ?? '').join('');
    if ('result' in o) return excelCellText(o.result);
    if ('formula' in o || 'sharedFormula' in o) return undefined;
    if (typeof o.text === 'string') return o.text;
    if ('error' in o) return String(o.error);
    return JSON.stringify(v);
  }
  return String(v);
}

type ExcelModule = typeof import('exceljs');

async function loadExcel(): Promise<ExcelModule> {
  const mod = (await import('exceljs')) as ExcelModule & { default?: ExcelModule };
  return mod.default ?? mod;
}

class XlsxSource implements SourceReader {
  fields: string[] = [];
  private read = 0;

  constructor(
    private readonly file: string,
    private readonly sheet: string | null,
    private readonly o: ImportParseOptions,
    readonly totalBytes: number
  ) {}

  bytesRead(): number {
    return this.read;
  }

  async *records(): AsyncGenerator<SourceRecord[]> {
    const ExcelJS = await loadExcel();
    const o = this.o;
    const { header, first, last } = rowRange(o);
    const stream = fs.createReadStream(this.file, { highWaterMark: 1 << 20 });
    stream.on('data', (c) => (this.read += c.length));
    const wb = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
      worksheets: 'emit',
      sharedStrings: 'cache',
      styles: 'cache',
      hyperlinks: 'ignore',
      entries: 'ignore'
    });
    let index = 0;
    let found = false;
    try {
      for await (const ws of wb) {
        const name = (ws as unknown as { name?: string }).name ?? '';
        const match = this.sheet ? name === this.sheet : index === 0;
        index++;
        if (!match) continue;
        found = true;
        let out: SourceRecord[] = [];
        for await (const row of ws) {
          const no = row.number;
          const vals = row.values as unknown[];
          if (no === header) {
            const names: string[] = [];
            for (let c = 1; c < vals.length; c++) {
              const t = excelCellText(vals[c]);
              names.push(t === undefined || t === null ? '' : valueText(t));
            }
            this.fields = uniqueFieldNames(names);
            continue;
          }
          if (no < first) continue;
          if (last > 0 && no > last) break;
          const values: SourceValue[] = [];
          for (let c = 1; c < vals.length; c++) {
            const t = excelCellText(vals[c]);
            values[c - 1] = typeof t === 'string' ? textValue(t, o) : t;
          }
          growFields(this.fields, values.length);
          out.push({ rowNo: no, values });
          if (out.length >= 500) {
            yield out;
            out = [];
          }
        }
        if (out.length) yield out;
        break;
      }
    } finally {
      stream.destroy();
    }
    if (!found) throw new KsError(tr('Arbeitsblatt „{s}“ nicht gefunden.', 'Worksheet "{s}" not found.', { s: this.sheet ?? '' }));
  }
}

export async function openSource(format: ImportFormat, file: string, sheet: string | null, encoding: string, o: ImportParseOptions): Promise<SourceReader> {
  const size = await fileSize(file);
  switch (format) {
    case 'json':
      return new JsonSource(file, encoding, o, size);
    case 'xml':
      return new XmlSource(file, encoding, o, size);
    case 'xlsx':
      return new XlsxSource(file, sheet, o, size);
    default:
      return new DelimitedSource(file, encoding, o, size);
  }
}

const PREVIEW_SCAN = 1000;

export async function previewSource(req: ImportPreviewRequest): Promise<ImportPreview> {
  const reader = await openSource(req.format, req.file, req.sheet, req.encoding, req.options);
  const limit = Math.max(1, req.limit ?? 100);
  const sample: SourceValue[][] = [];
  const rowNumbers: number[] = [];
  let scanned = 0;
  let more = false;
  outer: for await (const batch of reader.records()) {
    for (const r of batch) {
      if (scanned >= PREVIEW_SCAN) {
        more = true;
        break outer;
      }
      if (r.error) throw new KsError(tr('Datensatz {n}: {m}', 'Record {n}: {m}', { n: r.rowNo, m: r.error }));
      scanned++;
      sample.push(r.values);
      if (rowNumbers.length < limit) rowNumbers.push(r.rowNo);
    }
  }
  const fields = reader.fields.slice();
  const show = (v: SourceValue): string | null => (v === undefined ? '' : v === null ? null : valueText(v));
  const rows = sample.slice(0, limit).map((vals) => fields.map((_, i) => show(vals[i])));
  const types = fields.map((_, i) => inferType(sample.map((vals) => vals[i]), req.options));
  return { fields, types, rows, rowNumbers, scanned, more };
}

/** Sheet names of an .xlsx file (read from xl/workbook.xml without loading the sheets). */
export function xlsxSheetNames(file: string): Promise<string[]> {
  const bad = () => new KsError(tr('Die Datei ist keine gültige Excel-Arbeitsmappe (.xlsx).', 'The file is not a valid Excel workbook (.xlsx).'));
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        reject(err?.message?.includes('end of central directory') ? bad() : (err ?? bad()));
        return;
      }
      let found = false;
      zip.on('error', reject);
      zip.on('end', () => {
        if (!found) reject(bad());
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== 'xl/workbook.xml') {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, (e2, rs) => {
          if (e2 || !rs) {
            zip.close();
            reject(e2 ?? bad());
            return;
          }
          const parts: Buffer[] = [];
          rs.on('data', (c: Buffer) => parts.push(c));
          rs.on('error', reject);
          rs.on('end', () => {
            zip.close();
            const xml = Buffer.concat(parts).toString('utf8');
            const names: string[] = [];
            const re = /<(?:\w+:)?sheet\b[^>]*?\bname\s*=\s*"([^"]*)"/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(xml))) names.push(decodeXmlText(m[1]));
            resolve(names);
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** Element statistics of the beginning of an XML file. */
export async function xmlElementStats(file: string, encoding: string): Promise<XmlElementInfo[]> {
  const { text, complete } = await readTextHead(file, encoding, 4 * 1024 * 1024, true);
  const survey = new XmlSurvey();
  survey.feed(text);
  if (complete) survey.end();
  return survey.result().slice(0, 80);
}

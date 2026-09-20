// Default settings, encodings and small helpers shared by the io wizards and the backend.

import { tr } from '../i18n';
import type {
  DumpOptions,
  ExportFormat,
  ExportOptions,
  ImportAdvancedOptions,
  ImportFormat,
  ImportParseOptions
} from '../apis/io';

export function defaultImportOptions(format: ImportFormat = 'csv'): ImportParseOptions {
  return {
    recordDelimiter: 'auto',
    fieldDelimiter: format === 'txt' ? '\t' : ',',
    textQualifier: '"',
    escapeChar: '',
    headerRow: 1,
    firstDataRow: 0,
    lastDataRow: 0,
    xmlRowTag: '',
    xmlAttributes: true,
    dateOrder: 'YMD',
    dateSeparator: '-',
    timeSeparator: ':',
    decimalSymbol: '.',
    binaryEncoding: 'base64',
    nullText: '',
    emptyAsNull: false,
    trim: false
  };
}

export function defaultImportAdvanced(): ImportAdvancedOptions {
  return { rowsPerStatement: 100, maxStatementKB: 1024, transaction: true, continueOnError: false, disableFkChecks: false };
}

export function defaultExportOptions(format: ExportFormat = 'csv'): ExportOptions {
  return {
    header: true,
    fieldDelimiter: format === 'txt' ? '\t' : ',',
    recordDelimiter: 'crlf',
    textQualifier: '"',
    escapeChar: '',
    quoteAll: false,
    txtLayout: 'delimited',
    encoding: 'utf8',
    nullText: format === 'md' || format === 'html' ? 'NULL' : '',
    dateFormat: 'YYYY-MM-DD',
    timeFormat: 'HH:mm:ss',
    decimalSeparator: '.',
    thousandsSeparator: '',
    blankIfZero: false,
    binaryEncoding: 'base64',
    append: false,
    continueOnError: false,
    jsonLayout: 'array',
    jsonPretty: true,
    xmlAttributes: false,
    sqlCreateTable: false,
    sqlDropTable: false,
    sqlRowsPerStatement: 100
  };
}

export function defaultDumpOptions(structureOnly = false): DumpOptions {
  return {
    structureOnly,
    dropStatements: true,
    createDatabase: false,
    extendedInsert: true,
    maxRowsPerInsert: 1000,
    maxInsertKB: 1024,
    completeInsert: true,
    binaryAs: 'hex',
    consistency: 'snapshot',
    addLocks: false,
    disableFkChecks: true,
    disableUniqueChecks: true,
    autoIncrement: true,
    charsetHeader: true,
    stripDefiner: false
  };
}

export interface EncodingOption {
  value: string;
  label: string;
}

/** Text encodings offered by the wizards (iconv-lite names). */
export function encodingOptions(mode: 'read' | 'write'): EncodingOption[] {
  const list: EncodingOption[] = [];
  if (mode === 'read') list.push({ value: 'auto', label: tr('Automatisch (BOM, sonst UTF-8)', 'Automatic (BOM, else UTF-8)') });
  list.push({ value: 'utf8', label: 'UTF-8' });
  if (mode === 'write') list.push({ value: 'utf8bom', label: tr('UTF-8 mit BOM', 'UTF-8 with BOM') });
  list.push(
    { value: 'utf16le', label: 'UTF-16 LE' },
    { value: 'utf16be', label: 'UTF-16 BE' },
    { value: 'windows1252', label: tr('Windows-1252 (Westeuropäisch)', 'Windows-1252 (Western European)') },
    { value: 'iso88591', label: 'ISO-8859-1 (Latin-1)' },
    { value: 'iso885915', label: 'ISO-8859-15 (Latin-9)' },
    { value: 'windows1250', label: tr('Windows-1250 (Mitteleuropäisch)', 'Windows-1250 (Central European)') },
    { value: 'iso88592', label: 'ISO-8859-2 (Latin-2)' },
    { value: 'windows1251', label: tr('Windows-1251 (Kyrillisch)', 'Windows-1251 (Cyrillic)') },
    { value: 'koi8r', label: 'KOI8-R' },
    { value: 'windows1253', label: tr('Windows-1253 (Griechisch)', 'Windows-1253 (Greek)') },
    { value: 'windows1254', label: tr('Windows-1254 (Türkisch)', 'Windows-1254 (Turkish)') },
    { value: 'windows1256', label: tr('Windows-1256 (Arabisch)', 'Windows-1256 (Arabic)') },
    { value: 'windows1257', label: tr('Windows-1257 (Baltisch)', 'Windows-1257 (Baltic)') },
    { value: 'cp850', label: 'DOS 850' },
    { value: 'cp437', label: 'DOS 437' },
    { value: 'macintosh', label: 'Mac Roman' },
    { value: 'shiftjis', label: 'Shift_JIS' },
    { value: 'eucjp', label: 'EUC-JP' },
    { value: 'gbk', label: 'GBK' },
    { value: 'gb18030', label: 'GB18030' },
    { value: 'big5', label: 'Big5' },
    { value: 'euckr', label: 'EUC-KR' }
  );
  return list;
}

export function exportExtension(format: ExportFormat, o?: Pick<ExportOptions, 'jsonLayout'>): string {
  switch (format) {
    case 'json':
      return o?.jsonLayout === 'lines' ? '.jsonl' : '.json';
    case 'md':
      return '.md';
    default:
      return `.${format}`;
  }
}

/** Formats that can write several objects into one file */
export function supportsSameFile(format: ExportFormat): boolean {
  return format === 'xlsx' || format === 'sql' || format === 'html' || format === 'md' || format === 'xml' || format === 'json';
}

/** Formats that can append to an existing file */
export function supportsAppend(format: ExportFormat, o: Pick<ExportOptions, 'jsonLayout' | 'txtLayout'>): boolean {
  return format === 'csv' || format === 'sql' || format === 'md' || (format === 'txt' && o.txtLayout === 'delimited') || (format === 'json' && o.jsonLayout === 'lines');
}

export function importExtensions(format: ImportFormat): string[] {
  switch (format) {
    case 'csv':
      return ['csv', 'txt'];
    case 'txt':
      return ['txt', 'tsv', 'tab', 'csv', 'dat'];
    case 'json':
      return ['json', 'jsonl', 'ndjson'];
    case 'xml':
      return ['xml'];
    case 'xlsx':
      return ['xlsx'];
  }
}

/** Import format that matches a file name (by extension) */
export function importFormatOf(file: string): ImportFormat | null {
  const ext = /\.([^.\\/]+)$/.exec(file)?.[1]?.toLowerCase() ?? '';
  if (ext === 'csv') return 'csv';
  if (ext === 'txt' || ext === 'tsv' || ext === 'tab') return 'txt';
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'json';
  if (ext === 'xml') return 'xml';
  if (ext === 'xlsx') return 'xlsx';
  return null;
}

/** Column / table name derived from a file or field name */
export function sanitizeName(name: string, fallback = 'imported'): string {
  const s = name
    .trim()
    .replace(/\.[A-Za-z0-9]{1,6}$/, '')
    .replace(/[\s\-./\\]+/g, '_')
    .replace(/[`'"]/g, '')
    .replace(/_+/g, '_')
    .slice(0, 64);
  return s || fallback;
}

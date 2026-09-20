// Automatic generator assignment from table name, column name and data type (backend + UI).

import type { ColumnGenConfig, DataGenOptions, DgColumn, DgTable, GenKind, GenOptions, TableGenConfig } from '../apis/datagen';
import { getLang, tr } from '../i18n';

export const INT_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);
export const DEC_TYPES = new Set(['decimal', 'numeric', 'float', 'double', 'real']);
export const TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']);
export const BIN_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
export const GEO_TYPES = new Set(['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection']);
const BIG_TEXT = new Set(['text', 'mediumtext', 'longtext']);

export type TypeCategory = 'num' | 'bit' | 'date' | 'datetime' | 'time' | 'year' | 'text' | 'bin' | 'json' | 'enum' | 'set' | 'geo';

export function typeCategory(c: DgColumn): TypeCategory {
  const t = c.dataType;
  if (t === 'bit') return 'bit';
  if (INT_TYPES.has(t) || DEC_TYPES.has(t)) return 'num';
  if (t === 'date') return 'date';
  if (t === 'datetime' || t === 'timestamp') return 'datetime';
  if (t === 'time') return 'time';
  if (t === 'year') return 'year';
  if (t === 'json') return 'json';
  if (t === 'enum') return 'enum';
  if (t === 'set') return 'set';
  if (GEO_TYPES.has(t)) return 'geo';
  if (BIN_TYPES.has(t)) return 'bin';
  return 'text';
}

export function defaultDataGenOptions(): DataGenOptions {
  return {
    locale: getLang() === 'en' ? 'en' : 'de',
    seed: null,
    emptyTables: false,
    rowsPerInsert: 100,
    transaction: false,
    continueOnError: false,
    disableForeignKeys: false
  };
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/[^a-z0-9]/g, '');
}

const INT_RANGES: Record<string, [number, number, number]> = {
  tinyint: [-128, 127, 255],
  smallint: [-32768, 32767, 65535],
  mediumint: [-8388608, 8388607, 16777215],
  int: [-2147483648, 2147483647, 4294967295],
  integer: [-2147483648, 2147483647, 4294967295],
  bigint: [-9007199254740991, 9007199254740991, 9007199254740991]
};

export function intBounds(c: DgColumn): [number, number] {
  const r = INT_RANGES[c.dataType] ?? INT_RANGES.bigint;
  return c.unsigned ? [0, r[2]] : [r[0], r[1]];
}

/** [min, max, scale] allowed by DECIMAL(p,s) / FLOAT / DOUBLE */
export function decimalBounds(c: DgColumn): [number, number, number] {
  if (c.dataType === 'decimal' || c.dataType === 'numeric') {
    const s = c.scale ?? 0;
    const p = Math.max(1, c.precision ?? 10);
    const max = Math.pow(10, p - s) - Math.pow(10, -s);
    return [c.unsigned ? 0 : -max, max, s];
  }
  return [c.unsigned ? 0 : -1e9, 1e9, c.scale ?? 2];
}

/** Columns that are never filled by the generator */
export function fixedSkipReason(c: DgColumn): string | null {
  if (c.generated) return tr('Berechnete Spalte', 'Generated column');
  if (c.autoIncrement) return tr('Auto-Inkrement', 'Auto increment');
  return null;
}

const PERSON_TABLES = /(customer|client|user|person|people|employee|staff|member|author|contact|patient|student|kunde|mitarbeiter|benutzer|mitglied|autor|kontakt)/;
const COMPANY_TABLES = /(supplier|vendor|compan|manufacturer|partner|firma|firmen|lieferant|hersteller|store|shop|branch|filiale)/;
const PRODUCT_TABLES = /(product|article|item|artikel|produkt|ware)/;
const CATEGORY_TABLES = /(categor|kategor|group|gruppe)/;

function textKindByName(n: string, tn: string, c: DgColumn): GenKind | null {
  if (/mail/.test(n)) return 'email';
  if (/^(first|given|fore|vor)name|^fname$|firstname/.test(n)) return 'firstName';
  if (/^(last|sur|family|nach)name|^lname$|lastname|surname/.test(n)) return 'lastName';
  if (/fullname|contactperson|contactname|displayname/.test(n)) return 'fullName';
  if (/username|login|nickname|benutzername|screenname/.test(n)) return 'userName';
  if (/phone|^tel|telefon|mobile|handy|^fax/.test(n)) return 'phone';
  if (/street|strasse|address|adresse|anschrift|^addr/.test(n)) return 'street';
  if (/city|stadt|^ort$|wohnort|town/.test(n)) return 'city';
  if (/zip|postcode|postal|^plz$|postleitzahl/.test(n)) return 'zip';
  if (/^state$|province|bundesland|county|^region$/.test(n)) return 'state';
  if (/country|^land$|nation/.test(n)) return (c.maxLength ?? 99) <= 3 ? 'countryCode' : 'country';
  if (/currency|waehrung/.test(n)) return 'currency';
  if (/iban/.test(n)) return 'iban';
  if (/^bic$|swift/.test(n)) return 'bic';
  if (/creditcard|cardnumber|ccnumber/.test(n)) return 'creditCard';
  if (/useragent/.test(n)) return 'userAgent';
  if (/url|website|homepage|webseite|referrer|referer|^link$/.test(n)) return 'url';
  if (/domain|hostname/.test(n)) return 'domain';
  if (/ipv6/.test(n)) return 'ipv6';
  if (/^ip$|ipaddr|ipv4|remoteip|clientip/.test(n)) return 'ip';
  if (/^mac$|macaddr/.test(n)) return 'mac';
  if (/uuid|guid/.test(n)) return 'uuid';
  if (/colou?r|farbe/.test(n)) return 'color';
  if (/gender|^sex$|geschlecht/.test(n)) return 'gender';
  if (/slug/.test(n)) return 'slug';
  if (/password|passwort|^pwd$|hash|secret|token|apikey/.test(n)) return 'regex';
  if (/jobtitle|^job$|position|beruf|occupation/.test(n) || (n === 'title' && PERSON_TABLES.test(tn))) return 'jobTitle';
  if (/department|abteilung|^dept$/.test(n)) return 'department';
  if (/company|firma|organi[sz]ation|supplier|vendor|manufacturer|hersteller|lieferant/.test(n)) return 'company';
  if (n === 'sku' || /(^|[a-z])(no|nr|num|number|nummer|code|sku|ref|reference)$/.test(n)) return 'pattern';
  if (/productname|articlename|produktname|artikelname/.test(n)) return 'productName';
  if (/category|kategorie/.test(n)) return 'productCategory';
  if (/^(description|beschreibung|notes?|notizen|comments?|kommentar|remarks?|bemerkungs?|text|content|inhalt|body|message|nachricht|summary|details?|info)$/.test(n)) {
    return BIG_TEXT.has(c.dataType) || (c.maxLength ?? 0) >= 1000 ? 'paragraph' : 'sentence';
  }
  if (/name$|^name/.test(n)) {
    if (PERSON_TABLES.test(tn)) return 'fullName';
    if (COMPANY_TABLES.test(tn)) return 'company';
    if (PRODUCT_TABLES.test(tn)) return 'productName';
    if (CATEGORY_TABLES.test(tn)) return 'productCategory';
    return 'words';
  }
  if (/title|titel|subject|betreff|headline/.test(n)) return 'sentence';
  return null;
}

function isBooleanColumn(c: DgColumn, n: string): boolean {
  if (c.dataType === 'tinyint' && /^tinyint\(1\)/i.test(c.columnType)) return true;
  if (!INT_TYPES.has(c.dataType)) return false;
  return /^(is|has|can|should|allow)[a-z]/.test(n) || /^(active|enabled|visible|deleted|published|verified|newsletter|aktiv|sichtbar|geloescht)$/.test(n);
}

function isUniqueSingle(t: DgTable, c: DgColumn): boolean {
  return t.uniqueKeys.some((k) => k.columns.length === 1 && k.columns[0] === c.name);
}

export function suggestKind(t: DgTable, c: DgColumn): GenKind {
  if (fixedSkipReason(c)) return 'skip';
  if (t.foreignKeys.some((f) => f.columns.includes(c.name))) return 'foreignKey';
  const n = normalizeName(c.name);
  const tn = normalizeName(t.name);
  switch (typeCategory(c)) {
    case 'geo':
      return 'geometry';
    case 'json':
      return 'json';
    case 'enum':
      return 'enum';
    case 'set':
      return 'set';
    case 'bit':
      return /^bit\(1\)$/i.test(c.columnType) ? 'boolean' : 'bit';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'time':
      return 'time';
    case 'year':
      return 'year';
    case 'bin':
      if (/uuid|guid/.test(n)) return 'uuid';
      if (/^ip|ipaddr/.test(n)) return /ipv6/.test(n) ? 'ipv6' : 'ip';
      return 'binary';
    case 'num':
      if (isBooleanColumn(c, n)) return 'boolean';
      if (INT_TYPES.has(c.dataType)) return isUniqueSingle(t, c) ? 'sequence' : 'intRange';
      return 'decimalRange';
    default: {
      const byName = textKindByName(n, tn, c);
      if (byName) return byName;
      const len = c.maxLength ?? 65535;
      if (len <= 5) return 'regex';
      if (len <= 60) return 'words';
      if (BIG_TEXT.has(c.dataType)) return 'paragraph';
      return 'sentence';
    }
  }
}

function clampRange(lo: number, hi: number, [min, max]: [number, number]): [number, number] {
  const a = Math.max(min, Math.min(max, lo));
  const b = Math.max(min, Math.min(max, hi));
  return a <= b ? [a, b] : [b, a];
}

function intRangeFor(n: string, c: DgColumn): [number, number] {
  let r: [number, number];
  if (/(^|[a-z])(age|alter)$/.test(n)) r = [18, 90];
  else if (/rating|stars|sterne|score|bewertung/.test(n)) r = [1, 5];
  else if (/quantity|qty|menge|anzahl|amount|count|stueck/.test(n)) r = [1, 20];
  else if (/stock|bestand|inventory|lager/.test(n)) r = [0, 1000];
  else if (/lineno|^line|zeile|posnr/.test(n)) r = [1, 50];
  else if (/sort|order|position|priority|prioritaet|rank|reihenfolge/.test(n)) r = [0, 100];
  else if (/year|jahr/.test(n)) r = [1990, 2030];
  else if (/ms$|millis/.test(n)) r = [50, 60000];
  else if (/seconds|sekunden|duration|dauer/.test(n)) r = [1, 3600];
  else if (/percent|pct|prozent|rate/.test(n)) r = [0, 100];
  else if (c.dataType === 'tinyint') r = [0, 100];
  else if (c.dataType === 'smallint') r = [0, 10000];
  else r = [1, 100000];
  return clampRange(r[0], r[1], intBounds(c));
}

function decimalRangeFor(n: string, c: DgColumn): [number, number, number] {
  const [min, max, s] = decimalBounds(c);
  const scale = DEC_TYPES.has(c.dataType) && (c.dataType === 'decimal' || c.dataType === 'numeric') ? s : 2;
  let r: [number, number];
  if (/salary|gehalt|lohn|income|einkommen/.test(n)) r = [20000, 120000];
  else if (/percent|pct|prozent|rate|discount|rabatt|vat|mwst|tax|steuer/.test(n)) r = [0, 25];
  else if (/weight|gewicht|kg$/.test(n)) r = [0.1, 50];
  else if (/^lat|latitude|breitengrad/.test(n)) r = [-90, 90];
  else if (/^lng|^lon|longitude|laengengrad/.test(n)) r = [-180, 180];
  else if (/credit|limit|balance|saldo|guthaben/.test(n)) r = [0, 10000];
  else if (/price|preis|cost|kosten|amount|betrag|total|summe|sum|revenue|umsatz|value|wert/.test(n)) r = [1, 1000];
  else r = [0, 1000];
  const [a, b] = clampRange(r[0], r[1], [min, max]);
  return [a, b, scale];
}

const p2 = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

function dateRangeFor(n: string, c: DgColumn): [string, string] {
  const now = new Date();
  const years = (k: number) => isoDate(new Date(now.getFullYear() + k, now.getMonth(), now.getDate()));
  let r: [string, string];
  if (/birth|geburt|dob/.test(n)) r = ['1940-01-01', '2006-12-31'];
  else if (/due|expir|ablauf|valid|deadline|until|faellig/.test(n)) r = [years(0), years(2)];
  else r = [years(-3), years(0)];
  if (c.dataType === 'timestamp') r = [r[0] < '1970-01-02' ? '1970-01-02' : r[0], r[1] > '2038-01-18' ? '2038-01-18' : r[1]];
  return r;
}

/** Mask for code / number columns, e.g. customer_no CHAR(7) → CU#####, sku CHAR(12) → SKU-######## */
export function maskFor(c: DgColumn, t: DgTable): string {
  const n = normalizeName(c.name);
  const len = Math.max(3, Math.min(c.maxLength ?? 12, 24));
  let prefix = n.endsWith('sku') ? 'SKU-' : (t.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'X') + (len >= 8 ? '-' : '');
  if (prefix.length + 3 > len) prefix = '';
  const digits = c.dataType === 'char' ? len - prefix.length : Math.min(len - prefix.length, 8);
  return prefix + '#'.repeat(Math.max(1, digits));
}

export function defaultOptions(kind: GenKind, c: DgColumn, t: DgTable): GenOptions {
  const n = normalizeName(c.name);
  const len = c.maxLength;
  switch (kind) {
    case 'intRange': {
      const [min, max] = intRangeFor(n, c);
      return { min, max };
    }
    case 'sequence':
      return { start: 1, step: 1 };
    case 'decimalRange': {
      const [min, max, decimals] = decimalRangeFor(n, c);
      return { min, max, decimals };
    }
    case 'boolean':
      return { truePercent: 50 };
    case 'year':
      return { min: 1990, max: 2030 };
    case 'date': {
      const [from, to] = dateRangeFor(n, c);
      return { from, to };
    }
    case 'datetime': {
      const [from, to] = dateRangeFor(n, c);
      return { from: `${from} 00:00:00`, to: `${to} 23:59:59` };
    }
    case 'time':
      return { from: '00:00:00', to: '23:59:59' };
    case 'enum':
    case 'set':
    case 'list':
      return { values: [...c.enumValues] };
    case 'fixed':
      return { value: c.defaultValue ?? '' };
    case 'email':
      return { domain: '', linked: true };
    case 'userName':
      return { linked: true };
    case 'phone':
      return { style: 'human' };
    case 'uuid':
      return { hyphens: len === null || len >= 36 };
    case 'words':
      return { min: 1, max: len !== null && len < 20 ? 1 : 3 };
    case 'sentence':
      return { min: 3, max: len !== null && len < 100 ? 6 : 12 };
    case 'paragraph':
      return { min: 1, max: 3 };
    case 'text':
      return { min: Math.min(5, len ?? 5), max: Math.min(len ?? 50, 50) };
    case 'binary':
      return c.dataType === 'binary' && len ? { min: len, max: len } : { min: Math.min(16, len ?? 16), max: Math.min(len ?? 256, 256) };
    case 'pattern':
      return { pattern: maskFor(c, t) };
    case 'regex':
      return { pattern: /password|passwort|pwd|hash|secret|token|apikey/.test(n) ? `[a-f0-9]{${Math.min(64, len ?? 64)}}` : `[A-Z]{${Math.max(1, Math.min(len ?? 3, 8))}}` };
    case 'json':
      return { keys: getLang() === 'en' ? ['color', 'size', 'weight'] : ['farbe', 'groesse', 'gewicht'] };
    case 'foreignKey': {
      const fk = t.foreignKeys.find((f) => f.columns.includes(c.name));
      if (!fk) return { refSchema: '', refTable: '', refColumn: '', constraint: '' };
      return { refSchema: fk.refSchema, refTable: fk.refTable, refColumn: fk.refColumns[fk.columns.indexOf(c.name)], constraint: fk.constraint };
    }
    default:
      return {};
  }
}

export function suggestColumn(t: DgTable, c: DgColumn): ColumnGenConfig {
  const kind = suggestKind(t, c);
  const fk = t.foreignKeys.find((f) => f.columns.includes(c.name));
  const selfRef = !!fk && fk.refTable.toLowerCase() === t.name.toLowerCase();
  return {
    column: c.name,
    kind,
    options: defaultOptions(kind, c, t),
    nullPercent: kind === 'foreignKey' && selfRef && c.nullable ? 25 : 0,
    unique: kind !== 'skip' && isUniqueSingle(t, c),
    textCase: 'none'
  };
}

export function suggestTable(t: DgTable, rows = 100): TableGenConfig {
  return { table: t.name, enabled: false, rows, columns: t.columns.map((c) => suggestColumn(t, c)) };
}

const COMMON: GenKind[] = ['skip', 'null', 'fixed', 'list', 'foreignKey'];

/** Generators offered for a column (by data type) */
export function compatibleKinds(c: DgColumn): GenKind[] {
  switch (typeCategory(c)) {
    case 'num':
      return [...COMMON, 'intRange', 'sequence', 'decimalRange', 'boolean', 'year', 'pattern', 'regex'];
    case 'bit':
      return [...COMMON, 'boolean', 'bit', 'intRange'];
    case 'date':
      return [...COMMON, 'date'];
    case 'datetime':
      return [...COMMON, 'datetime', 'date'];
    case 'time':
      return [...COMMON, 'time'];
    case 'year':
      return [...COMMON, 'year', 'intRange'];
    case 'json':
      return ['skip', 'null', 'fixed', 'list', 'json'];
    case 'enum':
    case 'set':
      return [...COMMON, 'enum', 'set'];
    case 'geo':
      return ['skip', 'null', 'geometry'];
    case 'bin':
      return [...COMMON, 'binary', 'uuid', 'ip', 'ipv6', 'pattern', 'regex', 'words', 'sentence', 'text'];
    default:
      return [
        ...COMMON,
        'firstName', 'lastName', 'fullName', 'gender', 'email', 'userName', 'phone', 'jobTitle', 'street', 'city', 'zip', 'state', 'country',
        'countryCode', 'company', 'department', 'productName', 'productCategory', 'color', 'iban', 'bic', 'currency', 'creditCard', 'url',
        'domain', 'ip', 'ipv6', 'mac', 'userAgent', 'uuid', 'words', 'sentence', 'paragraph', 'text', 'slug', 'pattern', 'regex', 'json',
        'intRange', 'sequence', 'decimalRange', 'boolean', 'date', 'datetime', 'time', 'year', 'enum'
      ];
  }
}

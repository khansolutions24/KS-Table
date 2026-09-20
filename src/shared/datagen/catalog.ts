// Generator catalog of the data generator: labels, groups and option fields (UI forms, logs).

import type { GenKind } from '../apis/datagen';
import { tr } from '../i18n';

export type GenGroup = 'basic' | 'number' | 'date' | 'person' | 'address' | 'business' | 'internet' | 'text' | 'special';

export type OptionField =
  | { key: 'min' | 'max' | 'decimals' | 'start' | 'step' | 'truePercent'; type: 'number'; label: () => string; min?: number; max?: number }
  | { key: 'from' | 'to'; type: 'date' | 'datetime' | 'time'; label: () => string }
  | { key: 'values' | 'keys'; type: 'list'; label: () => string }
  | { key: 'value' | 'pattern' | 'domain'; type: 'text'; label: () => string; placeholder?: string; hint?: () => string }
  | { key: 'linked' | 'hyphens'; type: 'check'; label: () => string }
  | { key: 'style'; type: 'select'; label: () => string; options: () => { value: string; label: string }[] }
  | { key: 'ref'; type: 'fk'; label: () => string };

export interface GenDef {
  kind: GenKind;
  group: GenGroup;
  label: () => string;
  fields: OptionField[];
  hint?: () => string;
}

const minMax = (lmin: () => string, lmax: () => string, min?: number): OptionField[] => [
  { key: 'min', type: 'number', label: lmin, min },
  { key: 'max', type: 'number', label: lmax, min }
];
const words = () => minMax(() => tr('Wörter mindestens', 'Minimum words'), () => tr('Wörter höchstens', 'Maximum words'), 1);
const values: OptionField = { key: 'values', type: 'list', label: () => tr('Werte (einer pro Zeile)', 'Values (one per line)') };
const linked: OptionField = { key: 'linked', type: 'check', label: () => tr('Aus dem Namen im selben Datensatz bilden', 'Build from the name in the same record') };

export const GENERATORS: GenDef[] = [
  { kind: 'skip', group: 'basic', label: () => tr('Nicht füllen (Standardwert)', 'Do not fill (default value)'), fields: [] },
  { kind: 'null', group: 'basic', label: () => tr('Immer NULL', 'Always NULL'), fields: [] },
  { kind: 'fixed', group: 'basic', label: () => tr('Fester Wert', 'Fixed value'), fields: [{ key: 'value', type: 'text', label: () => tr('Wert', 'Value') }] },
  { kind: 'list', group: 'basic', label: () => tr('Werteliste', 'List of values'), fields: [values] },
  { kind: 'enum', group: 'basic', label: () => tr('ENUM-Wert', 'ENUM value'), fields: [values] },
  { kind: 'set', group: 'basic', label: () => tr('SET-Werte', 'SET values'), fields: [values] },
  {
    kind: 'foreignKey',
    group: 'basic',
    label: () => tr('Fremdschlüssel (vorhandene Werte)', 'Foreign key (existing values)'),
    fields: [{ key: 'ref', type: 'fk', label: () => tr('Referenz', 'Reference') }],
    hint: () =>
      tr(
        'Werte werden aus der referenzierten Spalte gewählt – auch aus Datensätzen, die in diesem Lauf vorher erzeugt werden.',
        'Values are taken from the referenced column – including records generated earlier in this run.'
      )
  },
  { kind: 'intRange', group: 'number', label: () => tr('Ganzzahl (Bereich)', 'Integer (range)'), fields: minMax(() => tr('Von', 'From'), () => tr('Bis', 'To')) },
  {
    kind: 'sequence',
    group: 'number',
    label: () => tr('Fortlaufende Nummer', 'Sequence'),
    fields: [
      { key: 'start', type: 'number', label: () => tr('Startwert', 'Start') },
      { key: 'step', type: 'number', label: () => tr('Schrittweite', 'Increment') }
    ],
    hint: () => tr('Liegt der Startwert unter dem größten vorhandenen Wert, wird danach fortgesetzt.', 'If the start is below the largest existing value, the sequence continues after it.')
  },
  {
    kind: 'decimalRange',
    group: 'number',
    label: () => tr('Dezimalzahl (Bereich)', 'Decimal number (range)'),
    fields: [...minMax(() => tr('Von', 'From'), () => tr('Bis', 'To')), { key: 'decimals', type: 'number', label: () => tr('Nachkommastellen', 'Decimals'), min: 0, max: 30 }]
  },
  { kind: 'boolean', group: 'number', label: () => tr('Wahrheitswert (0/1)', 'Boolean (0/1)'), fields: [{ key: 'truePercent', type: 'number', label: () => tr('Anteil 1 (%)', 'Share of 1 (%)'), min: 0, max: 100 }] },
  { kind: 'bit', group: 'number', label: () => tr('Bitwert (zufällig)', 'Bit value (random)'), fields: [] },
  {
    kind: 'date',
    group: 'date',
    label: () => tr('Datum (Bereich)', 'Date (range)'),
    fields: [
      { key: 'from', type: 'date', label: () => tr('Von', 'From') },
      { key: 'to', type: 'date', label: () => tr('Bis', 'To') }
    ]
  },
  {
    kind: 'datetime',
    group: 'date',
    label: () => tr('Datum und Uhrzeit (Bereich)', 'Date and time (range)'),
    fields: [
      { key: 'from', type: 'datetime', label: () => tr('Von', 'From') },
      { key: 'to', type: 'datetime', label: () => tr('Bis', 'To') }
    ]
  },
  {
    kind: 'time',
    group: 'date',
    label: () => tr('Uhrzeit (Bereich)', 'Time (range)'),
    fields: [
      { key: 'from', type: 'time', label: () => tr('Von', 'From') },
      { key: 'to', type: 'time', label: () => tr('Bis', 'To') }
    ]
  },
  { kind: 'year', group: 'date', label: () => tr('Jahr (Bereich)', 'Year (range)'), fields: minMax(() => tr('Von', 'From'), () => tr('Bis', 'To')) },
  { kind: 'firstName', group: 'person', label: () => tr('Vorname', 'First name'), fields: [] },
  { kind: 'lastName', group: 'person', label: () => tr('Nachname', 'Last name'), fields: [] },
  { kind: 'fullName', group: 'person', label: () => tr('Vollständiger Name', 'Full name'), fields: [] },
  { kind: 'gender', group: 'person', label: () => tr('Geschlecht', 'Gender'), fields: [] },
  {
    kind: 'email',
    group: 'person',
    label: () => tr('E-Mail-Adresse', 'E-mail address'),
    fields: [{ key: 'domain', type: 'text', label: () => tr('Domain', 'Domain'), placeholder: tr('(zufällig)', '(random)') }, linked]
  },
  { kind: 'userName', group: 'person', label: () => tr('Benutzername', 'User name'), fields: [linked] },
  {
    kind: 'phone',
    group: 'person',
    label: () => tr('Telefonnummer', 'Phone number'),
    fields: [
      {
        key: 'style',
        type: 'select',
        label: () => tr('Format', 'Format'),
        options: () => [
          { value: 'human', label: tr('Wie eingegeben', 'As typed') },
          { value: 'national', label: tr('National', 'National') },
          { value: 'international', label: tr('International (+49 …)', 'International (+1 …)') }
        ]
      }
    ]
  },
  { kind: 'jobTitle', group: 'person', label: () => tr('Berufsbezeichnung', 'Job title'), fields: [] },
  { kind: 'street', group: 'address', label: () => tr('Straße und Hausnummer', 'Street address'), fields: [] },
  { kind: 'city', group: 'address', label: () => tr('Ort', 'City'), fields: [] },
  { kind: 'zip', group: 'address', label: () => tr('Postleitzahl', 'ZIP code'), fields: [] },
  { kind: 'state', group: 'address', label: () => tr('Bundesland / Region', 'State / region'), fields: [] },
  { kind: 'country', group: 'address', label: () => tr('Land', 'Country'), fields: [] },
  { kind: 'countryCode', group: 'address', label: () => tr('Ländercode (ISO)', 'Country code (ISO)'), fields: [] },
  { kind: 'company', group: 'business', label: () => tr('Firmenname', 'Company name'), fields: [] },
  { kind: 'department', group: 'business', label: () => tr('Abteilung', 'Department'), fields: [] },
  { kind: 'productName', group: 'business', label: () => tr('Produktname', 'Product name'), fields: [] },
  { kind: 'productCategory', group: 'business', label: () => tr('Produktkategorie', 'Product category'), fields: [] },
  { kind: 'color', group: 'business', label: () => tr('Farbe', 'Color'), fields: [] },
  { kind: 'iban', group: 'business', label: () => tr('IBAN', 'IBAN'), fields: [] },
  { kind: 'bic', group: 'business', label: () => tr('BIC', 'BIC'), fields: [] },
  { kind: 'currency', group: 'business', label: () => tr('Währungscode', 'Currency code'), fields: [] },
  { kind: 'creditCard', group: 'business', label: () => tr('Kreditkartennummer', 'Credit card number'), fields: [] },
  { kind: 'url', group: 'internet', label: () => tr('URL', 'URL'), fields: [{ key: 'domain', type: 'text', label: () => tr('Domain', 'Domain'), placeholder: tr('(zufällig)', '(random)') }] },
  { kind: 'domain', group: 'internet', label: () => tr('Domainname', 'Domain name'), fields: [] },
  { kind: 'ip', group: 'internet', label: () => tr('IP-Adresse (IPv4)', 'IP address (IPv4)'), fields: [] },
  { kind: 'ipv6', group: 'internet', label: () => tr('IP-Adresse (IPv6)', 'IP address (IPv6)'), fields: [] },
  { kind: 'mac', group: 'internet', label: () => tr('MAC-Adresse', 'MAC address'), fields: [] },
  { kind: 'userAgent', group: 'internet', label: () => tr('Browser-Kennung (User-Agent)', 'User agent'), fields: [] },
  { kind: 'uuid', group: 'internet', label: () => tr('UUID', 'UUID'), fields: [{ key: 'hyphens', type: 'check', label: () => tr('Mit Bindestrichen', 'With hyphens') }] },
  { kind: 'words', group: 'text', label: () => tr('Wörter (Blindtext)', 'Words (lorem)'), fields: words() },
  { kind: 'sentence', group: 'text', label: () => tr('Satz (Blindtext)', 'Sentence (lorem)'), fields: words() },
  {
    kind: 'paragraph',
    group: 'text',
    label: () => tr('Absätze (Blindtext)', 'Paragraphs (lorem)'),
    fields: minMax(() => tr('Absätze mindestens', 'Minimum paragraphs'), () => tr('Absätze höchstens', 'Maximum paragraphs'), 1)
  },
  { kind: 'text', group: 'text', label: () => tr('Text (Länge)', 'Text (length)'), fields: minMax(() => tr('Zeichen mindestens', 'Minimum characters'), () => tr('Zeichen höchstens', 'Maximum characters'), 0) },
  { kind: 'slug', group: 'text', label: () => tr('URL-Kürzel (Slug)', 'Slug'), fields: [] },
  {
    kind: 'pattern',
    group: 'special',
    label: () => tr('Muster (z. B. KD-#####)', 'Pattern (e.g. KD-#####)'),
    fields: [
      {
        key: 'pattern',
        type: 'text',
        label: () => tr('Muster', 'Pattern'),
        placeholder: 'KD-#####',
        hint: () => tr('# Ziffer, @ Großbuchstabe, ? Buchstabe, * Großbuchstabe oder Ziffer, \\ maskiert das nächste Zeichen', '# digit, @ upper-case letter, ? letter, * upper-case letter or digit, \\ escapes the next character')
      }
    ]
  },
  {
    kind: 'regex',
    group: 'special',
    label: () => tr('Regulärer Ausdruck', 'Regular expression'),
    fields: [
      {
        key: 'pattern',
        type: 'text',
        label: () => tr('Ausdruck', 'Expression'),
        placeholder: '[A-Z]{2}-\\d{4}',
        hint: () => tr('Unterstützt: [a-z] [^…] . \\d \\w \\s ( | ) * + ? {n} {n,m}', 'Supported: [a-z] [^…] . \\d \\w \\s ( | ) * + ? {n} {n,m}')
      }
    ]
  },
  { kind: 'json', group: 'special', label: () => tr('JSON-Objekt', 'JSON object'), fields: [{ key: 'keys', type: 'list', label: () => tr('Schlüssel (einer pro Zeile)', 'Keys (one per line)') }] },
  { kind: 'binary', group: 'special', label: () => tr('Binärdaten (zufällig)', 'Binary data (random)'), fields: minMax(() => tr('Bytes mindestens', 'Minimum bytes'), () => tr('Bytes höchstens', 'Maximum bytes'), 0) },
  { kind: 'geometry', group: 'special', label: () => tr('Geometrie (zufällig)', 'Geometry (random)'), fields: [] }
];

const BY_KIND = new Map(GENERATORS.map((g) => [g.kind, g]));

export function genDef(kind: GenKind): GenDef {
  return BY_KIND.get(kind) ?? GENERATORS[0];
}

export function genLabel(kind: GenKind): string {
  return genDef(kind).label();
}

export const GEN_GROUPS: GenGroup[] = ['basic', 'number', 'date', 'person', 'address', 'business', 'internet', 'text', 'special'];

export function groupLabel(g: GenGroup): string {
  switch (g) {
    case 'basic':
      return tr('Allgemein', 'General');
    case 'number':
      return tr('Zahlen', 'Numbers');
    case 'date':
      return tr('Datum und Zeit', 'Date and time');
    case 'person':
      return tr('Personen', 'Persons');
    case 'address':
      return tr('Adressen', 'Addresses');
    case 'business':
      return tr('Firma und Handel', 'Business');
    case 'internet':
      return tr('Internet und Kennungen', 'Internet and identifiers');
    case 'text':
      return tr('Text', 'Text');
    default:
      return tr('Spezial', 'Special');
  }
}

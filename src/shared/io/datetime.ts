// Date / time / number helpers of the import and export wizards.

import type { DateOrder } from '../apis/io';

export interface Temporal {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** fractional second digits as written ('' = none) */
  frac: string;
  neg: boolean;
  hasDate: boolean;
  hasTime: boolean;
}

const pad = (n: number, len: number) => String(n).padStart(len, '0');

/** Parses the text MySQL returns for DATE, DATETIME, TIMESTAMP and TIME values. */
export function parseMysqlTemporal(v: string): Temporal | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/.exec(v);
  if (m) {
    return {
      y: +m[1],
      mo: +m[2],
      d: +m[3],
      h: m[4] ? +m[4] : 0,
      mi: m[5] ? +m[5] : 0,
      s: m[6] ? +m[6] : 0,
      frac: m[7] ?? '',
      neg: false,
      hasDate: true,
      hasTime: !!m[4]
    };
  }
  m = /^(-)?(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(v);
  if (m) return { y: 0, mo: 0, d: 0, h: +m[2], mi: +m[3], s: +m[4], frac: m[5] ?? '', neg: !!m[1], hasDate: false, hasTime: true };
  return null;
}

const TOKEN_RE = /\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|S+|A|a/g;

/**
 * Formats date/time parts with a pattern: YYYY YY MM M DD D HH H hh h mm m ss s S… (fraction) A a, [literal].
 * Without S tokens, "ss" also carries the fractional seconds of the value.
 */
export function formatTemporal(t: Temporal, pattern: string): string {
  const hasFracToken = /S/.test(pattern.replace(/\[[^\]]*\]/g, ''));
  const h12 = t.h % 12 === 0 ? 12 : t.h % 12;
  const out = pattern.replace(TOKEN_RE, (tok: string, lit?: string) => {
    if (lit !== undefined) return lit;
    switch (tok) {
      case 'YYYY':
        return pad(t.y, 4);
      case 'YY':
        return pad(t.y % 100, 2);
      case 'MM':
        return pad(t.mo, 2);
      case 'M':
        return String(t.mo);
      case 'DD':
        return pad(t.d, 2);
      case 'D':
        return String(t.d);
      case 'HH':
        return pad(t.h, 2);
      case 'H':
        return String(t.h);
      case 'hh':
        return pad(h12, 2);
      case 'h':
        return String(h12);
      case 'mm':
        return pad(t.mi, 2);
      case 'm':
        return String(t.mi);
      case 'ss':
        return pad(t.s, 2) + (!hasFracToken && t.frac ? `.${t.frac}` : '');
      case 's':
        return String(t.s);
      case 'A':
        return t.h < 12 ? 'AM' : 'PM';
      case 'a':
        return t.h < 12 ? 'am' : 'pm';
      default:
        return (t.frac + '000000000').slice(0, tok.length);
    }
  });
  return t.neg ? `-${out}` : out;
}

/** Re-formats a MySQL temporal value; values that cannot be parsed are returned unchanged. */
export function formatTemporalText(v: string, kind: 'date' | 'datetime' | 'time', dateFmt: string, timeFmt: string): string {
  const t = parseMysqlTemporal(v);
  if (!t) return v;
  if (kind === 'date') return formatTemporal(t, dateFmt);
  if (kind === 'time') return formatTemporal(t, timeFmt);
  return formatTemporal(t, t.hasTime ? `${dateFmt} ${timeFmt}` : dateFmt);
}

/** Local time stamp for file names, e.g. formatStamp('YYYYMMDD_HHmmss', new Date()) */
export function formatStamp(pattern: string, d: Date): string {
  // milliseconds only when the pattern asks for them (S tokens); "ss" alone stays two digits
  const frac = /S/.test(pattern.replace(/\[[^\]]*\]/g, '')) ? pad(d.getMilliseconds(), 3) : '';
  return formatTemporal(
    { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), frac, neg: false, hasDate: true, hasTime: true },
    pattern
  );
}

// ───────────────────────── parsing user supplied values (import) ─────────────────────────

export interface DateParseOptions {
  dateOrder: DateOrder;
  dateSeparator: string;
  timeSeparator: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, mär: 3, maer: 3, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12
};

function monthFromName(s: string): number | null {
  const k = s.toLowerCase().replace(/\.$/, '');
  if (k.length < 3) return null;
  return MONTHS[k.slice(0, 3)] ?? MONTHS[k.slice(0, 4)] ?? null;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function year4(y: string): number {
  const n = Number(y);
  if (y.length <= 2) return n < 70 ? 2000 + n : 1900 + n;
  return n;
}

interface TimeParts {
  h: number;
  mi: number;
  s: number;
  frac: string;
}

function parseTimePart(t: string, sep: string): TimeParts | null {
  const seps = sep && sep !== ':' ? `[${escRe(sep)}:]` : ':';
  const re = new RegExp(`^(\\d{1,3})${seps}(\\d{1,2})(?:${seps}(\\d{1,2})(?:[.,](\\d{1,9}))?)?\\s*([AaPp][Mm])?$`);
  const m = re.exec(t.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  if (m[5]) {
    const pm = /p/i.test(m[5]);
    if (h > 12) return null;
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (mi > 59 || s > 59) return null;
  return { h, mi, s, frac: (m[4] ?? '').slice(0, 6) };
}

function parseDatePart(t: string, o: DateParseOptions): { y: number; mo: number; d: number } | null {
  const s = t.trim().replace(/[,T]$/, '').trim();
  if (!s) return null;
  let parts: string[];
  if (/^\d{8}$/.test(s)) {
    const order = o.dateOrder;
    const lens = order.split('').map((c) => (c === 'Y' ? 4 : 2));
    parts = [];
    let p = 0;
    for (const l of lens) {
      parts.push(s.slice(p, p + l));
      p += l;
    }
  } else {
    parts = o.dateSeparator && s.includes(o.dateSeparator) ? s.split(o.dateSeparator).map((x) => x.trim()).filter(Boolean) : [];
    if (parts.length !== 3) parts = s.split(/[-./\s]+/).filter(Boolean);
  }
  if (parts.length !== 3) return null;
  let y = -1;
  let mo = -1;
  let d = -1;
  const letters = o.dateOrder.split('');
  const named = parts.findIndex((x) => /[^\d]/.test(x));
  if (named >= 0) {
    const mn = monthFromName(parts[named]);
    if (!mn) return null;
    mo = mn;
    const rest = parts.filter((_, i) => i !== named);
    const restLetters = letters.filter((c) => c !== 'M');
    // a 4-digit number is the year whatever the order says
    const yi = rest.findIndex((x) => x.length > 2);
    if (yi >= 0) {
      y = year4(rest[yi]);
      d = Number(rest[1 - yi]);
    } else {
      rest.forEach((x, i) => {
        if (restLetters[i] === 'Y') y = year4(x);
        else d = Number(x);
      });
    }
  } else {
    parts.forEach((x, i) => {
      const c = letters[i];
      if (c === 'Y') y = year4(x);
      else if (c === 'M') mo = Number(x);
      else d = Number(x);
    });
    if (y === 0 && mo === 0 && d === 0) return { y: 0, mo: 0, d: 0 };
  }
  if (!(y >= 0 && y <= 9999 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return { y, mo, d };
}

/**
 * Converts date / time text of an import file into MySQL notation
 * ('YYYY-MM-DD', 'YYYY-MM-DD HH:MM:SS[.ffffff]', 'HH:MM:SS[.ffffff]'); null when it cannot be read.
 */
export function parseUserTemporal(input: string, target: 'date' | 'datetime' | 'time', o: DateParseOptions): string | null {
  const s = input.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:T|\s+)(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,9}))?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(s);
  let date: { y: number; mo: number; d: number } | null = null;
  let time: TimeParts | null = null;
  if (iso) {
    date = { y: +iso[1], mo: +iso[2], d: +iso[3] };
    if (iso[4] !== undefined) time = { h: +iso[4], mi: +iso[5], s: iso[6] ? +iso[6] : 0, frac: (iso[7] ?? '').slice(0, 6) };
  } else {
    const tsep = o.timeSeparator && o.timeSeparator !== ':' ? `[${escRe(o.timeSeparator)}:]` : ':';
    const tm = new RegExp(`(?:^|[\\sT])(\\d{1,3}${tsep}\\d{1,2}(?:${tsep}\\d{1,2}(?:[.,]\\d{1,9})?)?\\s*(?:[AaPp][Mm])?)$`).exec(s);
    if (tm) {
      time = parseTimePart(tm[1], o.timeSeparator);
      const rest = s.slice(0, tm.index + (tm[0].length - tm[1].length)).trim();
      if (rest) {
        date = parseDatePart(rest, o);
        if (!date) return null;
      } else if (target !== 'time') return null;
    } else {
      date = parseDatePart(s, o);
    }
  }
  const dstr = date ? `${pad(date.y, 4)}-${pad(date.mo, 2)}-${pad(date.d, 2)}` : '';
  const tstr = time ? `${pad(time.h, 2)}:${pad(time.mi, 2)}:${pad(time.s, 2)}${time.frac ? `.${time.frac}` : ''}` : '';
  if (target === 'time') return tstr || null;
  if (!date) return null;
  if (target === 'date') return dstr;
  return tstr ? `${dstr} ${tstr}` : dstr;
}

// ───────────────────────── numbers ─────────────────────────

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Normalises a number written with the given decimal symbol (thousands separators are removed). */
export function normalizeNumber(input: string, decimalSymbol: string): string | null {
  let s = input.trim().replace(/[\u00A0\u202F]/g, ' ');
  if (!s) return null;
  if (decimalSymbol === ',') {
    if (/^[+-]?\d{1,3}([. '\u2019]\d{3})+(,\d*)?$/.test(s)) s = s.replace(/[. '\u2019]/g, '');
    s = s.replace(',', '.');
  } else {
    if (/^[+-]?\d{1,3}([, '\u2019]\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/[, '\u2019]/g, '');
  }
  if (s.startsWith('+')) s = s.slice(1);
  if (!PLAIN_NUMBER.test(s)) return null;
  if (s.startsWith('.')) s = `0${s}`;
  else if (s.startsWith('-.')) s = `-0${s.slice(1)}`;
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

/** Applies decimal / thousands separators to a number as returned by MySQL (e.g. "-1234.50"). */
export function formatNumberText(v: string, decimalSep: string, thousandsSep: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m) return decimalSep === '.' ? v : v.replace('.', decimalSep);
  let int = m[2];
  if (thousandsSep && int.length > 3) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSep);
  return `${m[1]}${int}${m[3] !== undefined ? decimalSep + m[3] : ''}`;
}

// Streaming parser for delimited text (CSV / TXT): arbitrary field and record delimiters, text
// qualifier (doubled inside values), optional escape character, quoted line breaks.
// Chunks may be split anywhere; only the undecided tail of a chunk is kept.

export interface DelimitedOptions {
  /** Field delimiter (may be several characters, '' = one field per record) */
  fieldDelimiter: string;
  recordDelimiter: 'auto' | 'crlf' | 'lf' | 'cr';
  /** Text qualifier ('' = none) */
  qualifier: string;
  /** Escape character ('' = none) */
  escapeChar: string;
}

/** Field kinds reported per value */
export const FIELD_UNQUOTED = 0;
export const FIELD_QUOTED = 1;
/** \N written with the escape character (MySQL notation for NULL) */
export const FIELD_NULL = 2;

export interface DelimitedRecord {
  /** 1-based record number (blank records are counted but not reported) */
  no: number;
  values: string[];
  kinds: number[];
}

/** Return false to stop parsing */
export type RecordCallback = (r: DelimitedRecord) => boolean | void;

const MORE = -1;

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', Z: '\x1a', b: '\b' };

export class DelimitedParser {
  private buf = '';
  private field = '';
  private kind = FIELD_UNQUOTED;
  private inQuotes = false;
  private afterQuote = false;
  private atFieldStart = true;
  private maybeNull = false;
  private lineHasContent = false;
  private values: string[] = [];
  private kinds: number[] = [];
  private recNo = 0;
  private stopped = false;
  private readonly fd: string;
  private readonly q: string;
  private readonly esc: string;
  private readonly rd: DelimitedOptions['recordDelimiter'];

  constructor(o: DelimitedOptions) {
    this.fd = o.fieldDelimiter;
    this.q = o.qualifier ? o.qualifier[0] : '';
    this.esc = o.escapeChar ? o.escapeChar[0] : '';
    this.rd = o.recordDelimiter;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  feed(chunk: string, cb: RecordCallback): void {
    if (this.stopped || !chunk) return;
    this.buf = this.buf ? this.buf + chunk : chunk;
    this.parse(false, cb);
  }

  end(cb: RecordCallback): void {
    if (this.stopped) return;
    this.parse(true, cb);
    if (this.stopped) return;
    if (this.values.length || this.lineHasContent || this.field !== '' || this.kind !== FIELD_UNQUOTED || this.inQuotes) {
      this.endField();
      this.endRecord(cb);
    }
  }

  private endField(): void {
    this.values.push(this.field);
    this.kinds.push(this.maybeNull && this.kind === FIELD_UNQUOTED ? FIELD_NULL : this.kind);
    this.field = '';
    this.kind = FIELD_UNQUOTED;
    this.inQuotes = false;
    this.afterQuote = false;
    this.atFieldStart = true;
    this.maybeNull = false;
  }

  private endRecord(cb: RecordCallback): void {
    this.recNo++;
    const blank = !this.lineHasContent && this.values.length === 1 && this.values[0] === '' && this.kinds[0] === FIELD_UNQUOTED;
    const rec: DelimitedRecord = { no: this.recNo, values: this.values, kinds: this.kinds };
    this.values = [];
    this.kinds = [];
    this.lineHasContent = false;
    if (!blank && cb(rec) === false) this.stopped = true;
  }

  /** Length of the record delimiter at i (0 = none, MORE = undecidable) */
  private recordEnd(s: string, i: number, eof: boolean): number {
    const c = s.charCodeAt(i);
    const n = s.length;
    switch (this.rd) {
      case 'lf':
        return c === 10 ? 1 : 0;
      case 'cr':
        return c === 13 ? 1 : 0;
      case 'crlf':
        if (c !== 13) return 0;
        if (i + 1 >= n) return eof ? 0 : MORE;
        return s.charCodeAt(i + 1) === 10 ? 2 : 0;
      default:
        if (c === 10) return 1;
        if (c !== 13) return 0;
        if (i + 1 >= n) return eof ? 1 : MORE;
        return s.charCodeAt(i + 1) === 10 ? 2 : 1;
    }
  }

  private parse(eof: boolean, cb: RecordCallback): void {
    const s = this.buf;
    const n = s.length;
    const fd = this.fd;
    const fd0 = fd ? fd.charCodeAt(0) : -1;
    const q = this.q;
    const qc = q ? q.charCodeAt(0) : -1;
    const ec = this.esc ? this.esc.charCodeAt(0) : -1;
    let i = 0;

    while (i < n && !this.stopped) {
      if (this.inQuotes) {
        let j = i;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === qc || d === ec) break;
          j++;
        }
        if (j > i) this.field += s.slice(i, j);
        if (j >= n) {
          i = n;
          break;
        }
        if (s.charCodeAt(j) === ec && ec !== qc) {
          if (j + 1 >= n) {
            if (!eof) {
              i = j;
              break;
            }
            this.field += this.esc;
            i = n;
            break;
          }
          const e = s[j + 1];
          this.field += ESCAPES[e] ?? e;
          i = j + 2;
          continue;
        }
        // qualifier (or escape character equal to the qualifier): doubled = literal
        if (j + 1 >= n && !eof) {
          i = j;
          break;
        }
        if (s.charCodeAt(j + 1) === qc) {
          this.field += q;
          i = j + 2;
          continue;
        }
        this.inQuotes = false;
        this.afterQuote = true;
        i = j + 1;
        continue;
      }

      const c = s.charCodeAt(i);

      // start of a quoted value (leading blanks before the qualifier are ignored)
      if (this.atFieldStart && qc >= 0) {
        if (c === qc) {
          this.inQuotes = true;
          this.kind = FIELD_QUOTED;
          this.atFieldStart = false;
          this.lineHasContent = true;
          i++;
          continue;
        }
        if ((c === 32 || c === 9) && c !== fd0) {
          let p = i;
          while (p < n && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) p++;
          if (p >= n && !eof) break;
          if (p < n && s.charCodeAt(p) === qc) {
            i = p;
            continue;
          }
        }
      }

      // field delimiter
      if (c === fd0) {
        if (fd.length === 1) {
          this.endField();
          this.lineHasContent = true;
          i++;
          continue;
        }
        if (n - i < fd.length && !eof && fd.startsWith(s.slice(i))) break;
        if (s.startsWith(fd, i)) {
          this.endField();
          this.lineHasContent = true;
          i += fd.length;
          continue;
        }
      }

      // record delimiter
      if (c === 10 || c === 13) {
        const r = this.recordEnd(s, i, eof);
        if (r === MORE) break;
        if (r > 0) {
          this.endField();
          this.endRecord(cb);
          i += r;
          continue;
        }
      }

      // escape character outside quotes
      if (c === ec) {
        if (i + 1 >= n && !eof) break;
        if (i + 1 >= n) {
          this.field += this.esc;
          i = n;
          break;
        }
        const e = s[i + 1];
        this.maybeNull = this.atFieldStart && e === 'N' && !this.afterQuote;
        this.field += ESCAPES[e] ?? e;
        this.atFieldStart = false;
        this.lineHasContent = true;
        i += 2;
        continue;
      }

      // blanks after a closing qualifier are ignored
      if (this.afterQuote && (c === 32 || c === 9)) {
        i++;
        continue;
      }

      // ordinary characters
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === fd0 || d === 10 || d === 13 || d === ec) break;
        j++;
      }
      this.field += s.slice(i, j);
      this.maybeNull = false;
      this.atFieldStart = false;
      this.lineHasContent = true;
      i = j;
    }
    this.buf = i >= n ? '' : s.slice(i);
  }
}

/** Parses a complete text (tests, small files). */
export function parseDelimited(text: string, o: DelimitedOptions): DelimitedRecord[] {
  const out: DelimitedRecord[] = [];
  const p = new DelimitedParser(o);
  p.feed(text, (r) => {
    out.push(r);
  });
  p.end((r) => {
    out.push(r);
  });
  return out;
}

/** Unique, non-empty field names (duplicates get _2, _3 …; empty names become F<n>). */
export function uniqueFieldNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((raw, i) => {
    let base = raw.trim() || `F${i + 1}`;
    if (base.length > 64) base = base.slice(0, 64);
    let name = base;
    for (let k = 2; seen.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

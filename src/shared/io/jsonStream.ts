// Streaming JSON record reader for imports.
//
// Recognised layouts:
//   [ {…}, {…} ]                      array of records (elements may also be arrays or scalars)
//   {…}\n{…}\n                        JSON Lines / concatenated values
//   { "RECORDS": [ {…}, … ], … }      an object wrapping an array of records (first such array)
// Records are returned as raw JSON text; parseJsonRecord() turns one into field names and values.
// Numbers, booleans and nested objects / arrays keep their exact source text.

export interface JsonRaw {
  /** Exact JSON text of a number, boolean, object or array */
  raw: string;
}

export type JsonCell = string | null | JsonRaw;

export type RawRecordCallback = (raw: string) => boolean | void;

/** A wrapping object is buffered up to this size before its record array is streamed */
const HEAD_LIMIT = 8 * 1024 * 1024;

type Phase = 'start' | 'head' | 'array' | 'lines' | 'done';

export class JsonRecordScanner {
  private buf = '';
  private i = 0;
  private phase: Phase = 'start';
  private depth = 0;
  private inStr = false;
  private esc = false;
  private recStart = -1;
  private scalar = false;
  /** depth at which records live */
  private recDepth = 1;
  private stopped = false;
  // head (first top-level object) analysis
  private headStart = -1;
  private headEnd = -1;
  private wrapperPos = -1;
  private awaitValue = false;
  private arrayCheck = false;

  get isStopped(): boolean {
    return this.stopped;
  }

  feed(chunk: string, cb: RawRecordCallback): void {
    if (this.stopped || !chunk || this.phase === 'done') return;
    this.buf += chunk;
    this.scan(false, cb);
    this.compact();
  }

  end(cb: RawRecordCallback): void {
    if (this.stopped || this.phase === 'done') return;
    this.scan(true, cb);
    if (this.stopped) return;
    if (this.phase === 'head') {
      this.decideHead(true, cb);
      const ph = this.phase as Phase;
      if (ph === 'array' || ph === 'lines') this.scan(true, cb);
    }
    if (!this.stopped && this.recStart >= 0) this.emit(this.buf.slice(this.recStart).trim(), cb);
    this.phase = 'done';
  }

  private emit(raw: string, cb: RawRecordCallback): void {
    this.recStart = -1;
    this.scalar = false;
    if (raw && cb(raw) === false) this.stopped = true;
  }

  private compact(): void {
    if (this.phase === 'head') return;
    if (this.phase === 'done') {
      this.buf = '';
      this.i = 0;
      return;
    }
    const cut = this.recStart >= 0 ? this.recStart : this.i;
    if (cut <= 0) return;
    this.buf = this.buf.slice(cut);
    this.i -= cut;
    if (this.recStart >= 0) this.recStart -= cut;
  }

  /** Called when the first top-level object closed (or at EOF / size limit) */
  private decideHead(eof: boolean, cb: RawRecordCallback): boolean {
    const s = this.buf;
    if (this.headEnd >= 0) {
      let p = this.headEnd;
      while (p < s.length && /\s/.test(s[p])) p++;
      if (p >= s.length && !eof) return false; // need to know whether more values follow
      if (p < s.length) {
        // several top-level values: JSON Lines, the head object is the first record
        this.phase = 'lines';
        this.recDepth = 0;
        this.depth = 0;
        this.emit(s.slice(this.headStart, this.headEnd), cb);
        this.i = p;
        return true;
      }
    }
    if (this.wrapperPos >= 0) {
      // stream the elements of the wrapped record array
      this.phase = 'array';
      this.recDepth = 2;
      this.depth = 2;
      this.inStr = false;
      this.esc = false;
      this.recStart = -1;
      this.i = this.wrapperPos;
      return true;
    }
    this.emit(s.slice(this.headStart, this.headEnd >= 0 ? this.headEnd : s.length), cb);
    this.phase = 'done';
    return true;
  }

  private scan(eof: boolean, cb: RawRecordCallback): void {
    let s = this.buf;
    let n = s.length;
    let i = this.i;
    while (i < n && !this.stopped) {
      const c = s.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === 92) this.esc = true;
        else if (c === 34) this.inStr = false;
        i++;
        continue;
      }
      if (this.phase === 'start') {
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) {
          i++;
          continue;
        }
        if (c === 91) {
          this.phase = 'array';
          this.recDepth = 1;
          this.depth = 1;
          i++;
          continue;
        }
        if (c === 123) {
          this.phase = 'head';
          this.headStart = i;
          this.depth = 1;
          i++;
          continue;
        }
        // a scalar or garbage at the top level: treat as JSON Lines
        this.phase = 'lines';
        this.recDepth = 0;
        this.depth = 0;
        continue;
      }
      if (this.phase === 'head') {
        if (this.headEnd >= 0) {
          // the first object is complete (decision was postponed for lack of input)
          this.i = i;
          if (!this.decideHead(eof, cb)) return;
          s = this.buf;
          n = s.length;
          i = this.i;
          continue;
        }
        if (this.arrayCheck && !(c === 32 || c === 9 || c === 10 || c === 13)) {
          this.arrayCheck = false;
          if ((c === 123 || c === 91) && this.wrapperPos < 0) this.wrapperPos = i;
        }
        if (this.awaitValue && !(c === 32 || c === 9 || c === 10 || c === 13)) {
          this.awaitValue = false;
          if (c === 91 && this.depth === 1) this.arrayCheck = true;
        }
        if (c === 34) this.inStr = true;
        else if (c === 123 || c === 91) this.depth++;
        else if (c === 125 || c === 93) {
          this.depth--;
          if (this.depth === 0) {
            this.headEnd = i + 1;
            i++;
            this.i = i;
            if (!this.decideHead(eof, cb)) return;
            s = this.buf;
            n = s.length;
            i = this.i;
            continue;
          }
        } else if (c === 58 && this.depth === 1) this.awaitValue = true;
        i++;
        if (this.wrapperPos >= 0 && i - this.headStart > HEAD_LIMIT) {
          this.i = i;
          this.decideHead(eof, cb);
          i = this.i;
        }
        continue;
      }
      if (this.phase === 'done') break;

      // array / lines phase
      const ws = c === 32 || c === 9 || c === 10 || c === 13;
      if (this.recStart < 0) {
        if (this.depth === this.recDepth) {
          if (ws || c === 44) {
            i++;
            continue;
          }
          if (c === 93 || c === 125) {
            // end of the record array
            this.phase = 'done';
            break;
          }
          this.recStart = i;
          if (c === 123 || c === 91) {
            this.depth++;
            this.scalar = false;
          } else {
            this.scalar = true;
            if (c === 34) this.inStr = true;
          }
          i++;
          continue;
        }
        i++;
        continue;
      }
      if (this.scalar) {
        const endHere = this.phase === 'lines' ? c === 10 || c === 13 || c === 44 : c === 44 || c === 93 || c === 125;
        if (endHere) {
          const raw = s.slice(this.recStart, i).trim();
          this.emit(raw, cb);
          continue; // re-examine the terminator at record depth
        }
        if (c === 34) this.inStr = true;
        i++;
        continue;
      }
      if (c === 34) this.inStr = true;
      else if (c === 123 || c === 91) this.depth++;
      else if (c === 125 || c === 93) {
        this.depth--;
        if (this.depth === this.recDepth) {
          i++;
          this.emit(s.slice(this.recStart, i), cb);
          continue;
        }
      }
      i++;
    }
    this.i = i;
  }
}

// ───────────────────────── record parsing ─────────────────────────

class JsonSyntaxError extends Error {}

function fail(text: string, pos: number): never {
  throw new JsonSyntaxError(`JSON syntax error at position ${pos}: ${JSON.stringify(text.slice(pos, pos + 30))}`);
}

function skipWs(t: string, p: number): number {
  while (p < t.length) {
    const c = t.charCodeAt(p);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    p++;
  }
  return p;
}

function parseString(t: string, p: number): { value: string; end: number } {
  // p points at the opening quote
  let out = '';
  let i = p + 1;
  let run = i;
  for (;;) {
    if (i >= t.length) fail(t, p);
    const c = t.charCodeAt(i);
    if (c === 34) {
      out += t.slice(run, i);
      return { value: out, end: i + 1 };
    }
    if (c === 92) {
      out += t.slice(run, i);
      const e = t[i + 1];
      switch (e) {
        case '"':
        case '\\':
        case '/':
          out += e;
          i += 2;
          break;
        case 'b':
          out += '\b';
          i += 2;
          break;
        case 'f':
          out += '\f';
          i += 2;
          break;
        case 'n':
          out += '\n';
          i += 2;
          break;
        case 'r':
          out += '\r';
          i += 2;
          break;
        case 't':
          out += '\t';
          i += 2;
          break;
        case 'u': {
          const hex = t.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(t, i);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          break;
        }
        default:
          fail(t, i);
      }
      run = i;
      continue;
    }
    i++;
  }
}

/** End offset of the JSON value starting at p (any type) */
function skipValue(t: string, p: number): number {
  const c = t.charCodeAt(p);
  if (c === 34) return parseString(t, p).end;
  if (c === 123 || c === 91) {
    let depth = 0;
    let i = p;
    let inStr = false;
    for (; i < t.length; i++) {
      const d = t.charCodeAt(i);
      if (inStr) {
        if (d === 92) i++;
        else if (d === 34) inStr = false;
        continue;
      }
      if (d === 34) inStr = true;
      else if (d === 123 || d === 91) depth++;
      else if (d === 125 || d === 93) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    fail(t, p);
  }
  const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(p, p + 400));
  if (!m) fail(t, p);
  return p + m[0].length;
}

function parseCell(t: string, p: number): { value: JsonCell; end: number } {
  const c = t.charCodeAt(p);
  if (c === 34) return parseString(t, p);
  const end = skipValue(t, p);
  const raw = t.slice(p, end);
  return { value: raw === 'null' ? null : { raw }, end };
}

/** Field names and values of one record (object → keys, array → F1…Fn, scalar → "value"). */
export function parseJsonRecord(text: string): { names: string[]; values: JsonCell[] } {
  let p = skipWs(text, 0);
  const c = text.charCodeAt(p);
  if (c === 123) {
    const names: string[] = [];
    const values: JsonCell[] = [];
    const index = new Map<string, number>();
    p = skipWs(text, p + 1);
    if (text.charCodeAt(p) === 125) return { names, values };
    for (;;) {
      if (text.charCodeAt(p) !== 34) fail(text, p);
      const k = parseString(text, p);
      p = skipWs(text, k.end);
      if (text.charCodeAt(p) !== 58) fail(text, p);
      p = skipWs(text, p + 1);
      const v = parseCell(text, p);
      const at = index.get(k.value);
      if (at === undefined) {
        index.set(k.value, names.length);
        names.push(k.value);
        values.push(v.value);
      } else values[at] = v.value;
      p = skipWs(text, v.end);
      const d = text.charCodeAt(p);
      if (d === 44) {
        p = skipWs(text, p + 1);
        continue;
      }
      if (d === 125) break;
      fail(text, p);
    }
    return { names, values };
  }
  if (c === 91) {
    const values: JsonCell[] = [];
    p = skipWs(text, p + 1);
    if (text.charCodeAt(p) !== 93) {
      for (;;) {
        const v = parseCell(text, p);
        values.push(v.value);
        p = skipWs(text, v.end);
        const d = text.charCodeAt(p);
        if (d === 44) {
          p = skipWs(text, p + 1);
          continue;
        }
        if (d === 93) break;
        fail(text, p);
      }
    }
    return { names: values.map((_, i) => `F${i + 1}`), values };
  }
  const v = parseCell(text, p);
  return { names: ['value'], values: [v.value] };
}

/** Collects records of a complete text (tests, small files). */
export function scanJsonRecords(text: string): string[] {
  const out: string[] = [];
  const s = new JsonRecordScanner();
  s.feed(text, (r) => {
    out.push(r);
  });
  s.end((r) => {
    out.push(r);
  });
  return out;
}

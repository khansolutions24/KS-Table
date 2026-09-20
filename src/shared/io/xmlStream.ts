// Streaming XML reader for imports: extracts records (a chosen element) with their attributes and
// child elements as fields. Nested child elements become dotted field names (address.city),
// attributes of child elements "element@attribute". xsi:nil="true" marks NULL.

export interface XmlRecordOptions {
  /** Element that identifies a record */
  rowTag: string;
  /** Attributes become fields */
  attributes: boolean;
}

export interface XmlRecord {
  names: string[];
  /** null = NULL (xsi:nil) */
  values: (string | null)[];
}

export type XmlRecordCallback = (r: XmlRecord) => boolean | void;

interface Attr {
  name: string;
  value: string;
}

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXmlText(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY_RE, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}

/** Inverse of encodeXmlName (export): _xHHHH_ sequences back to characters */
export function decodeXmlName(s: string): string {
  if (s.indexOf('_x') < 0) return s;
  return s.replace(/_x([0-9A-Fa-f]{4}|[0-9A-Fa-f]{8})_/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

// XML 1.0 name characters (':' is excluded on purpose: it would be read as a namespace prefix)
const NAME_START_RANGES = 'A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const NAME_START = new RegExp(`[${NAME_START_RANGES}]`);
const NAME_CHAR = new RegExp(`[-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040${NAME_START_RANGES}]`);

/** Valid XML element name for an arbitrary column name (invalid characters become _xHHHH_) */
export function encodeXmlName(name: string): string {
  if (!name) return '_';
  let out = '';
  const chars = Array.from(name);
  chars.forEach((ch, i) => {
    const ok = i === 0 ? NAME_START.test(ch) && ch !== ':' : NAME_CHAR.test(ch);
    const looksEncoded = ch === '_' && /^_x[0-9A-Fa-f]{4}_/.test(chars.slice(i).join('').slice(0, 7));
    if (ok && !looksEncoded) out += ch;
    else {
      const cp = ch.codePointAt(0)!;
      out += cp > 0xffff ? `_x${cp.toString(16).toUpperCase().padStart(8, '0')}_` : `_x${cp.toString(16).toUpperCase().padStart(4, '0')}_`;
    }
  });
  if (/^xml/i.test(out)) out = `_x${out.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_${out.slice(1)}`;
  return out;
}

function normalizeNewlines(s: string): string {
  return s.indexOf('\r') < 0 ? s : s.replace(/\r\n?/g, '\n');
}

function parseAttrs(body: string): Attr[] {
  const out: Attr[] = [];
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const raw = m[2] ?? m[3] ?? '';
    out.push({ name: m[1], value: decodeXmlText(normalizeNewlines(raw).replace(/[\t\n]/g, ' ')) });
  }
  return out;
}

function isNil(attrs: Attr[]): boolean {
  return attrs.some((a) => (a.name === 'nil' || a.name.endsWith(':nil')) && (a.value === 'true' || a.value === '1'));
}

function fieldAttrs(attrs: Attr[]): Attr[] {
  return attrs.filter((a) => !(a.name === 'xmlns' || a.name.startsWith('xmlns:') || a.name.startsWith('xsi:')));
}

/** Low level tokenizer: tags, text, CDATA; comments, processing instructions and DOCTYPE are skipped. */
abstract class XmlTokenizer {
  private buf = '';
  private inCdata = false;
  protected stopped = false;

  protected abstract onStart(name: string, attrs: Attr[], selfClosing: boolean): void;
  protected abstract onEnd(name: string): void;
  /** Decoded text (entities resolved, line breaks normalised) */
  protected abstract onText(text: string): void;

  feedText(chunk: string): void {
    if (this.stopped || !chunk) return;
    this.buf = this.buf ? this.buf + chunk : chunk;
    this.run(false);
  }

  endText(): void {
    if (this.stopped) return;
    this.run(true);
  }

  private run(eof: boolean): void {
    const s = this.buf;
    const n = s.length;
    let i = 0;
    while (i < n && !this.stopped) {
      if (this.inCdata) {
        const e = s.indexOf(']]>', i);
        if (e < 0) {
          const keep = eof ? n : Math.max(i, n - 2);
          if (keep > i) this.onText(normalizeNewlines(s.slice(i, keep)));
          i = keep;
          break;
        }
        if (e > i) this.onText(normalizeNewlines(s.slice(i, e)));
        this.inCdata = false;
        i = e + 3;
        continue;
      }
      const lt = s.indexOf('<', i);
      if (lt < 0) {
        // text without a following tag: emit up to a safe point (entities / CR LF must not be split)
        let safe = n;
        if (!eof) {
          const amp = s.lastIndexOf('&');
          if (amp >= i && s.indexOf(';', amp) < 0) safe = amp;
          if (safe > i && s.charCodeAt(safe - 1) === 13) safe--;
        }
        if (safe > i) this.onText(decodeXmlText(normalizeNewlines(s.slice(i, safe))));
        i = safe;
        break;
      }
      if (lt > i) {
        this.onText(decodeXmlText(normalizeNewlines(s.slice(i, lt))));
        i = lt;
      }
      // i points at '<'
      if (n - i < 9 && !eof) {
        const head = s.slice(i);
        if ('<!--'.startsWith(head) || '<![CDATA['.startsWith(head) || '<!DOCTYPE'.startsWith(head.toUpperCase()) || head.length < 2) break;
      }
      if (s.startsWith('<!--', i)) {
        const e = s.indexOf('-->', i + 4);
        if (e < 0) {
          if (!eof) break;
          i = n;
          break;
        }
        i = e + 3;
        continue;
      }
      if (s.startsWith('<![CDATA[', i)) {
        this.inCdata = true;
        i += 9;
        continue;
      }
      if (s.startsWith('<?', i)) {
        const e = s.indexOf('?>', i + 2);
        if (e < 0) {
          if (!eof) break;
          i = n;
          break;
        }
        i = e + 2;
        continue;
      }
      if (s.startsWith('<!', i)) {
        // DOCTYPE (with optional internal subset) or other declaration
        let p = i + 2;
        let bracket = 0;
        let quote = 0;
        for (; p < n; p++) {
          const c = s.charCodeAt(p);
          if (quote) {
            if (c === quote) quote = 0;
          } else if (c === 34 || c === 39) quote = c;
          else if (c === 91) bracket++;
          else if (c === 93) bracket--;
          else if (c === 62 && bracket <= 0) break;
        }
        if (p >= n) {
          if (!eof) break;
          i = n;
          break;
        }
        i = p + 1;
        continue;
      }
      // tag: find the closing '>' outside attribute quotes
      let p = i + 1;
      let quote = 0;
      for (; p < n; p++) {
        const c = s.charCodeAt(p);
        if (quote) {
          if (c === quote) quote = 0;
        } else if (c === 34 || c === 39) quote = c;
        else if (c === 62) break;
      }
      if (p >= n) {
        if (!eof) break;
        i = n;
        break;
      }
      const body = s.slice(i + 1, p);
      i = p + 1;
      if (body[0] === '/') {
        this.onEnd(body.slice(1).trim());
        continue;
      }
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const m = /^\s*([^\s/>]+)/.exec(inner);
      if (!m) continue;
      const name = m[1];
      const attrs = parseAttrs(inner.slice(m[0].length));
      this.onStart(name, attrs, selfClosing);
      if (selfClosing && !this.stopped) this.onEnd(name);
    }
    this.buf = i >= n ? '' : s.slice(i);
  }
}

interface Frame {
  name: string;
  path: string;
  hasChildren: boolean;
  nil: boolean;
  text: string;
}

export class XmlRecordReader extends XmlTokenizer {
  private depth = 0;
  private frames: Frame[] | null = null;
  private names: string[] = [];
  private values: (string | null)[] = [];
  private index = new Map<string, number>();
  private cb: XmlRecordCallback = () => undefined;

  constructor(private readonly o: XmlRecordOptions) {
    super();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  feed(chunk: string, cb: XmlRecordCallback): void {
    this.cb = cb;
    this.feedText(chunk);
  }

  end(cb: XmlRecordCallback): void {
    this.cb = cb;
    this.endText();
  }

  private set(name: string, value: string | null, join: boolean): void {
    const at = this.index.get(name);
    if (at === undefined) {
      this.index.set(name, this.names.length);
      this.names.push(name);
      this.values.push(value);
    } else if (join && value !== null && this.values[at] !== null) {
      this.values[at] = `${this.values[at]}, ${value}`;
    } else if (value !== null) this.values[at] = value;
  }

  protected onStart(name: string, attrs: Attr[], selfClosing: boolean): void {
    void selfClosing;
    if (!this.frames) {
      this.depth++;
      if (name !== this.o.rowTag) return;
      this.frames = [{ name, path: '', hasChildren: false, nil: false, text: '' }];
      this.names = [];
      this.values = [];
      this.index = new Map();
      if (this.o.attributes) for (const a of fieldAttrs(attrs)) this.set(decodeXmlName(a.name), a.value, false);
      return;
    }
    const parent = this.frames[this.frames.length - 1];
    parent.hasChildren = true;
    const seg = decodeXmlName(name);
    const path = parent.path ? `${parent.path}.${seg}` : seg;
    if (this.o.attributes) for (const a of fieldAttrs(attrs)) this.set(`${path}@${decodeXmlName(a.name)}`, a.value, false);
    this.frames.push({ name, path, hasChildren: false, nil: isNil(attrs), text: '' });
  }

  protected onText(text: string): void {
    if (this.frames) this.frames[this.frames.length - 1].text += text;
  }

  protected onEnd(name: string): void {
    const frames = this.frames;
    if (!frames) {
      this.depth--;
      return;
    }
    // tolerate mismatched end tags: close up to the matching element
    let idx = frames.length - 1;
    while (idx > 0 && frames[idx].name !== name) idx--;
    if (frames[idx].name !== name) return;
    while (frames.length > idx) {
      const f = frames.pop()!;
      if (frames.length === 0) {
        if (!f.hasChildren && f.text.trim()) this.set(decodeXmlName(f.name), f.text, false);
        this.frames = null;
        this.depth--;
        const rec: XmlRecord = { names: this.names, values: this.values };
        if (this.cb(rec) === false) this.stopped = true;
        return;
      }
      if (!f.hasChildren) this.set(f.path, f.nil ? null : f.text, true);
    }
  }
}

/** Counts element names (for choosing the record element). */
export class XmlSurvey extends XmlTokenizer {
  private depth = 0;
  private readonly stats = new Map<string, { count: number; depth: number }>();

  protected onStart(name: string): void {
    this.depth++;
    const st = this.stats.get(name);
    if (st) {
      st.count++;
      st.depth = Math.min(st.depth, this.depth);
    } else this.stats.set(name, { count: 1, depth: this.depth });
  }

  protected onEnd(): void {
    this.depth--;
  }

  protected onText(): void {
    // not needed
  }

  feed(chunk: string): void {
    this.feedText(chunk);
  }

  end(): void {
    this.endText();
  }

  result(): { name: string; count: number; depth: number }[] {
    return [...this.stats.entries()]
      .map(([name, s]) => ({ name, count: s.count, depth: s.depth }))
      .sort((a, b) => a.depth - b.depth || b.count - a.count || a.name.localeCompare(b.name));
  }
}

/** Likely record element: the shallowest repeated element below the root. */
export function guessRowTag(list: { name: string; count: number; depth: number }[]): string {
  const repeated = list.filter((e) => e.depth >= 2 && e.count >= 2);
  if (repeated.length) {
    const minDepth = Math.min(...repeated.map((e) => e.depth));
    return repeated.filter((e) => e.depth === minDepth).sort((a, b) => b.count - a.count)[0].name;
  }
  return list.find((e) => e.depth === 2)?.name ?? list[0]?.name ?? '';
}

/** Collects records of a complete text (tests, small files). */
export function readXmlRecords(text: string, o: XmlRecordOptions): XmlRecord[] {
  const out: XmlRecord[] = [];
  const r = new XmlRecordReader(o);
  r.feed(text, (x) => {
    out.push(x);
  });
  r.end((x) => {
    out.push(x);
  });
  return out;
}

// Streaming MySQL script splitter for huge SQL files (dumps).
//
// Incremental port of splitStatements() in src/shared/sql/splitter.ts: feeding the input in
// arbitrary chunks yields exactly the statements splitStatements() returns for the whole text
// (quotes, comments, the DELIMITER command and BEGIN … END blocks of stored programs), plus the
// line number where every statement starts. Only the current statement is kept in memory.

export interface StreamStatement {
  /** Statement text without the delimiter */
  sql: string;
  /** Delimiter that terminated the statement ('' at the end of the input) */
  delimiter: string;
  /** 1-based line of the first character of the statement */
  line: number;
  /** Character offset of the statement start in the whole input */
  offset: number;
}

export interface SqlStreamOptions {
  delimiter?: string;
  /** Keep ; inside BEGIN … END blocks of stored programs (default true) */
  detectBlocks?: boolean;
}

const BLOCK_OPENERS_AFTER = new Set([';', 'BEGIN', 'THEN', 'ELSE', 'DO', ':', 'LOOP', 'REPEAT', '']);
const END_PAIRS = new Set(['IF', 'CASE', 'LOOP', 'WHILE', 'REPEAT']);
/** Words longer than this cannot be keywords; they are consumed across chunks without re-scanning */
const LONG_WORD = 64;
const LONG_WORD_TOKEN = '\u0000W';

const enum Mode {
  Normal,
  LineComment,
  BlockComment,
  Quote,
  LongWord
}

function isSpaceCode(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}

/** Same character class as the original splitter: [A-Za-z0-9_$-￿] */
function isWordCode(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c >= 128;
}

/** Result of a lookahead that may need more input */
const MORE = -2;

export class SqlStreamSplitter {
  private buf = '';
  /** absolute offset of buf[0] */
  private base = 0;
  private pos = 0;
  /** the text before buf[0] ends at a line start (only spaces / tabs since the last line break) */
  private lineBefore = true;
  private delim: string;
  private readonly detectBlocks: boolean;
  private mode: Mode = Mode.Normal;
  private quoteCode = 0;
  private blockSig = false;

  // current statement (absolute offsets)
  private stmtStart = -1;
  private lastSig = -1;
  private parts: string[] = [];
  private words: string[] = [];
  private compound = false;
  private depth = 0;
  private prevToken = '';
  private stmtLine = 1;

  // line counting
  private lineNo = 1;
  private lineOff = 0;

  private out: StreamStatement[] = [];
  private ended = false;

  constructor(opts: SqlStreamOptions = {}) {
    this.delim = opts.delimiter || ';';
    this.detectBlocks = opts.detectBlocks !== false;
  }

  /** Current delimiter (changes with DELIMITER commands) */
  get delimiter(): string {
    return this.delim;
  }

  /** Adds text and returns the statements completed by it. */
  feed(chunk: string): StreamStatement[] {
    if (this.ended) throw new Error('SqlStreamSplitter: feed() after end()');
    if (chunk) {
      // after compact() buf only holds the undecided tail and pos is 0
      this.buf = this.buf ? this.buf + chunk : chunk;
      this.scan(false);
      this.compact();
    }
    return this.take();
  }

  /** Flushes the remaining text at the end of the input. */
  end(): StreamStatement[] {
    if (!this.ended) {
      this.ended = true;
      this.scan(true);
      this.pushStmt(this.base + this.buf.length, '');
    }
    return this.take();
  }

  private take(): StreamStatement[] {
    const r = this.out;
    this.out = [];
    return r;
  }

  private compact(): void {
    const cut = this.pos;
    if (cut <= 0) return;
    if (this.stmtStart >= 0) {
      const from = Math.max(this.stmtStart - this.base, 0);
      if (cut > from) this.parts.push(this.buf.slice(from, cut));
    }
    this.advanceLines(this.base + cut);
    this.lineBefore = this.atLineStart(cut);
    this.buf = this.buf.slice(cut);
    this.base += cut;
    this.pos = 0;
  }

  private advanceLines(toAbs: number): void {
    if (toAbs <= this.lineOff) return;
    const src = this.buf;
    const end = toAbs - this.base;
    let p = this.lineOff - this.base;
    for (;;) {
      const nl = src.indexOf('\n', p);
      if (nl < 0 || nl >= end) break;
      this.lineNo++;
      p = nl + 1;
    }
    this.lineOff = toAbs;
  }

  private atLineStart(i: number): boolean {
    const src = this.buf;
    let p = i - 1;
    while (p >= 0 && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p--;
    if (p < 0) return this.lineBefore;
    const c = src.charCodeAt(p);
    return c === 10 || c === 13;
  }

  private resetStatement(): void {
    this.stmtStart = -1;
    this.lastSig = -1;
    this.parts = [];
    this.words = [];
    this.compound = false;
    this.depth = 0;
    this.prevToken = '';
  }

  private pushStmt(endAbs: number, usedDelim: string): void {
    if (this.stmtStart >= 0) {
      const end = Math.min(endAbs, this.lastSig >= 0 ? this.lastSig : endAbs);
      let text: string;
      if (this.parts.length) {
        const joined = this.parts.join('');
        text = end <= this.base ? joined.slice(0, Math.max(0, end - this.stmtStart)) : joined + this.buf.slice(0, end - this.base);
      } else {
        text = this.buf.slice(this.stmtStart - this.base, end - this.base);
      }
      const sql = text.trim();
      if (sql) this.out.push({ sql, delimiter: usedDelim, line: this.stmtLine, offset: this.stmtStart });
    }
    this.resetStatement();
  }

  private startStatement(i: number): void {
    const abs = this.base + i;
    this.stmtStart = abs;
    this.advanceLines(abs);
    this.stmtLine = this.lineNo;
  }

  /** 1 = delimiter at i, 0 = no delimiter, MORE = undecidable without more input */
  private matchDelim(i: number, eof: boolean): number {
    const d = this.delim;
    const src = this.buf;
    if (src.startsWith(d, i)) return 1;
    if (!eof && src.length - i < d.length && d.startsWith(src.slice(i))) return MORE;
    return 0;
  }

  /** DELIMITER command at i: length of the command line and the new delimiter, null, or MORE */
  private matchDelimiterCommand(i: number, eof: boolean): { len: number; delim: string } | null | typeof MORE {
    const src = this.buf;
    const window = src.slice(i, i + 200);
    if (!eof && window.length < 200 && window.indexOf('\n') < 0) {
      const w = window.toLowerCase();
      if ('delimiter'.startsWith(w) || /^delimiter[ \t]/.test(w)) return MORE;
      return null;
    }
    const m = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(window);
    return m ? { len: m[0].length, delim: m[1] } : null;
  }

  /** Next character after white space, '' at the end of input, or MORE */
  private nextNonSpace(p: number, eof: boolean): string | typeof MORE {
    const src = this.buf;
    const n = src.length;
    while (p < n && isSpaceCode(src.charCodeAt(p))) p++;
    if (p >= n) return eof ? '' : MORE;
    return src[p];
  }

  /** Port of peekWord(): skips white space and comments and reads the next word */
  private peekWord(pos: number, eof: boolean): { word: string; end: number } | typeof MORE {
    const src = this.buf;
    const n = src.length;
    let p = pos;
    for (;;) {
      while (p < n && isSpaceCode(src.charCodeAt(p))) p++;
      if (p >= n) {
        if (!eof) return MORE;
        break;
      }
      const c = src.charCodeAt(p);
      if (c === 47 /* / */) {
        if (p + 2 >= n && !eof) return MORE;
        if (src.charCodeAt(p + 1) === 42 && src.charCodeAt(p + 2) !== 33) {
          const e = src.indexOf('*/', p + 2);
          if (e < 0 && !eof) return MORE;
          p = e < 0 ? n : e + 2;
          continue;
        }
      }
      if (c === 45 /* - */ && p + 2 >= n && !eof) return MORE;
      if (c === 35 /* # */ || (c === 45 && src.charCodeAt(p + 1) === 45 && (p + 2 >= n || isSpaceCode(src.charCodeAt(p + 2))))) {
        const e = src.indexOf('\n', p);
        if (e < 0 && !eof) return MORE;
        p = e < 0 ? n : e;
        continue;
      }
      break;
    }
    const s = p;
    while (p < n && isWordCode(src.charCodeAt(p))) p++;
    if (p >= n && !eof) return MORE;
    return { word: src.slice(s, p).toUpperCase(), end: p };
  }

  private scan(eof: boolean): void {
    const src = this.buf;
    const n = src.length;
    let i = this.pos;
    const abs = (k: number) => this.base + k;

    while (i < n) {
      // ── constructs that may span several chunks ──
      if (this.mode === Mode.LineComment) {
        const e = src.indexOf('\n', i);
        if (e < 0) {
          i = n;
          if (eof) this.mode = Mode.Normal;
          break;
        }
        i = e;
        this.mode = Mode.Normal;
        continue;
      }
      if (this.mode === Mode.BlockComment) {
        const e = src.indexOf('*/', i);
        if (e < 0) {
          if (eof) {
            i = n;
            this.mode = Mode.Normal;
            if (this.blockSig) this.lastSig = abs(n);
          } else if (src.charCodeAt(n - 1) === 42 && n - 1 > i) {
            i = n - 1; // keep a trailing '*' so that a '*/' split across chunks is found
          } else if (src.charCodeAt(n - 1) !== 42) {
            i = n;
          }
          break;
        }
        i = e + 2;
        this.mode = Mode.Normal;
        if (this.blockSig) this.lastSig = abs(i);
        continue;
      }
      if (this.mode === Mode.Quote) {
        const q = this.quoteCode;
        let j = i;
        let wait = false;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (d === 92 && q !== 96) {
            if (j + 1 >= n && !eof) {
              wait = true;
              break;
            }
            j += 2;
            continue;
          }
          if (d === q) {
            if (j + 1 >= n && !eof) {
              wait = true;
              break;
            }
            if (src.charCodeAt(j + 1) === q) {
              j += 2;
              continue;
            }
            break;
          }
          j++;
        }
        if (wait) {
          i = j;
          break;
        }
        if (j >= n && !eof) {
          i = n;
          break;
        }
        i = Math.min(j + 1, n);
        this.mode = Mode.Normal;
        this.lastSig = abs(i);
        this.prevToken = 'LIT';
        continue;
      }
      if (this.mode === Mode.LongWord) {
        let j = i;
        while (j < n && isWordCode(src.charCodeAt(j))) j++;
        i = j;
        this.lastSig = abs(j);
        if (j >= n && !eof) break;
        this.mode = Mode.Normal;
        continue;
      }

      const c = src.charCodeAt(i);

      // DELIMITER command at the start of a line (outside blocks)
      if (this.depth === 0 && (c === 100 || c === 68) && this.atLineStart(i)) {
        const m = this.matchDelimiterCommand(i, eof);
        if (m === MORE) break;
        if (m) {
          this.pushStmt(abs(i), '');
          this.delim = m.delim;
          i += m.len;
          continue;
        }
      }

      if (this.stmtStart < 0) {
        if (isSpaceCode(c)) {
          i++;
          continue;
        }
        // leading comments are not part of the statement (except /*! … */ and optimizer hints)
        if (c === 35) {
          this.mode = Mode.LineComment;
          i++;
          continue;
        }
        if (c === 45) {
          if (i + 1 >= n && !eof) break;
          if (src.charCodeAt(i + 1) === 45) {
            if (i + 2 >= n && !eof) break;
            if (i + 2 >= n || isSpaceCode(src.charCodeAt(i + 2))) {
              this.mode = Mode.LineComment;
              i += 2;
              continue;
            }
          }
        }
        if (c === 47) {
          if (i + 1 >= n && !eof) break;
          if (src.charCodeAt(i + 1) === 42) {
            if (i + 2 >= n && !eof) break;
            const c2 = src.charCodeAt(i + 2);
            if (c2 !== 33 && c2 !== 43) {
              this.mode = Mode.BlockComment;
              this.blockSig = false;
              i += 2;
              continue;
            }
          }
        }
        // stray delimiter
        const sd = this.matchDelim(i, eof);
        if (sd === MORE) break;
        if (sd === 1) {
          i += this.delim.length;
          continue;
        }
        this.startStatement(i);
      }

      // delimiter
      if (this.depth === 0) {
        const dm = this.matchDelim(i, eof);
        if (dm === MORE) break;
        if (dm === 1) {
          this.pushStmt(abs(i), this.delim);
          i += this.delim.length;
          continue;
        }
      }

      // strings and quoted identifiers
      if (c === 39 || c === 34 || c === 96) {
        this.mode = Mode.Quote;
        this.quoteCode = c;
        i++;
        continue;
      }

      // comments inside a statement
      if (c === 35) {
        this.mode = Mode.LineComment;
        i++;
        continue;
      }
      if (c === 45) {
        if (i + 1 >= n && !eof) break;
        if (src.charCodeAt(i + 1) === 45) {
          if (i + 2 >= n && !eof) break;
          if (i + 2 >= n || isSpaceCode(src.charCodeAt(i + 2))) {
            this.mode = Mode.LineComment;
            i += 2;
            continue;
          }
        }
      }
      if (c === 47) {
        if (i + 1 >= n && !eof) break;
        if (src.charCodeAt(i + 1) === 42) {
          this.mode = Mode.BlockComment;
          this.blockSig = true;
          i += 2;
          continue;
        }
      }

      if (isSpaceCode(c)) {
        i++;
        continue;
      }

      // words
      if (isWordCode(c)) {
        let j = i + 1;
        while (j < n && isWordCode(src.charCodeAt(j))) j++;
        const blocks = this.detectBlocks && this.delim === ';';
        if (j >= n && !eof) {
          if (j - i <= LONG_WORD) break; // the word may continue in the next chunk
          // a very long word (e.g. a 0x… hex literal) cannot be a keyword: consume it in streaming mode
          if (blocks && this.words.length < 12) this.words.push(LONG_WORD_TOKEN);
          this.prevToken = LONG_WORD_TOKEN;
          this.lastSig = abs(j);
          this.mode = Mode.LongWord;
          i = j;
          break;
        }
        if (!blocks || (this.words.length >= 12 && !this.compound)) {
          // keywords cannot matter any more for this statement
          i = j;
          this.lastSig = abs(j);
          this.prevToken = 'W';
          continue;
        }
        const w = j - i > LONG_WORD ? LONG_WORD_TOKEN : src.slice(i, j).toUpperCase();
        // lookahead first (without changing state), so the word can be re-scanned when input is missing
        let nextCh = '';
        let pk: { word: string; end: number } | null = null;
        if (this.compound) {
          if (w === 'IF' || w === 'WHILE' || w === 'LOOP' || w === 'REPEAT') {
            const r = this.nextNonSpace(j, eof);
            if (r === MORE) break;
            nextCh = r;
          } else if (w === 'END') {
            const r = this.peekWord(j, eof);
            if (r === MORE) break;
            pk = r;
          }
        }
        i = j;
        this.lastSig = abs(j);
        if (this.words.length < 12) {
          this.words.push(w);
          if (!this.compound) {
            const first = this.words[0];
            if ((first === 'CREATE' || first === 'ALTER') && (w === 'PROCEDURE' || w === 'FUNCTION' || w === 'TRIGGER' || w === 'EVENT')) {
              this.compound = true;
            } else if (first === 'BEGIN' && this.words.length === 2 && w === 'NOT') {
              // MariaDB anonymous block: BEGIN NOT ATOMIC … END
              this.compound = true;
              this.depth = 1;
            }
          }
        }
        if (this.compound) {
          if (w === 'BEGIN' && !(this.words.length === 1)) {
            this.depth++;
          } else if (w === 'CASE') {
            this.depth++;
          } else if ((w === 'IF' || w === 'WHILE' || w === 'LOOP' || w === 'REPEAT') && nextCh !== '(') {
            if (w === 'IF') {
              if (BLOCK_OPENERS_AFTER.has(this.prevToken) && this.depth > 0) this.depth++;
            } else if (this.depth > 0) {
              this.depth++;
            }
          } else if (w === 'END') {
            if (this.depth > 0) this.depth--;
            if (pk && END_PAIRS.has(pk.word)) {
              i = pk.end;
              this.lastSig = abs(pk.end);
            }
          }
        }
        this.prevToken = w;
        continue;
      }

      // punctuation
      this.prevToken = c === 59 ? ';' : c === 58 ? ':' : 'P';
      i++;
      this.lastSig = abs(i);
    }
    if (eof && i >= n) {
      // unterminated string / comment reaching the end of the input (already consumed by earlier chunks)
      if (this.mode === Mode.Quote || (this.mode === Mode.BlockComment && this.blockSig)) this.lastSig = abs(n);
      this.mode = Mode.Normal;
    }
    this.pos = i;
  }
}

/** Convenience: splits a complete text like splitStatements(), with line numbers. */
export function splitWithLines(src: string, opts: SqlStreamOptions = {}): StreamStatement[] {
  const s = new SqlStreamSplitter(opts);
  return [...s.feed(src), ...s.end()];
}

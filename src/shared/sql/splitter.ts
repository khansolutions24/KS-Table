// MySQL script splitter.
//
// Handles quotes ('', "", ``), comments (-- , #, /* */), the client-side
// DELIMITER command and – with the default ";" delimiter – compound
// statements (CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT ... BEGIN ... END),
// so routine bodies can be run without changing the delimiter.

export interface SplitStatement {
  /** Statement text without the delimiter */
  sql: string;
  /** Offset of the first character of the statement */
  start: number;
  /** Offset right after the statement text (before the delimiter) */
  end: number;
  /** Delimiter that terminated the statement ('' at end of input) */
  delimiter: string;
}

export interface SplitOptions {
  delimiter?: string;
  /** Keep ; inside BEGIN ... END blocks of stored programs (default true) */
  detectBlocks?: boolean;
}

const WORD_RE = /[A-Za-z0-9_$-￿]/;
const BLOCK_OPENERS_AFTER = new Set([';', 'BEGIN', 'THEN', 'ELSE', 'DO', ':', 'LOOP', 'REPEAT', '']);

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

export function splitStatements(src: string, opts: SplitOptions = {}): SplitStatement[] {
  const detectBlocks = opts.detectBlocks !== false;
  let delim = opts.delimiter || ';';
  const out: SplitStatement[] = [];
  const n = src.length;
  let i = 0;
  let stmtStart = -1;
  let lastSignificant = -1; // offset after last non-space char of the current statement

  // compound statement tracking
  let words: string[] = [];
  let compound = false;
  let depth = 0;
  let prevToken = '';

  const resetStatement = () => {
    stmtStart = -1;
    lastSignificant = -1;
    words = [];
    compound = false;
    depth = 0;
    prevToken = '';
  };

  const push = (endOffset: number, usedDelim: string) => {
    if (stmtStart >= 0) {
      const end = Math.min(endOffset, lastSignificant >= 0 ? lastSignificant : endOffset);
      const sql = src.slice(stmtStart, end).trim();
      if (sql) out.push({ sql, start: stmtStart, end, delimiter: usedDelim });
    }
    resetStatement();
  };

  const atLineStart = (pos: number): boolean => {
    let p = pos - 1;
    while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
    return p < 0 || src[p] === '\n' || src[p] === '\r';
  };

  const peekWord = (pos: number): { word: string; end: number } => {
    let p = pos;
    // skip whitespace and comments
    for (;;) {
      while (p < n && isSpace(src[p])) p++;
      if (src.startsWith('/*', p) && src[p + 2] !== '!') {
        const e = src.indexOf('*/', p + 2);
        p = e < 0 ? n : e + 2;
        continue;
      }
      if (src[p] === '#' || (src.startsWith('--', p) && (p + 2 >= n || isSpace(src[p + 2])))) {
        while (p < n && src[p] !== '\n') p++;
        continue;
      }
      break;
    }
    const s = p;
    while (p < n && WORD_RE.test(src[p])) p++;
    return { word: src.slice(s, p).toUpperCase(), end: p };
  };

  while (i < n) {
    const c = src[i];

    // DELIMITER command at the start of a line (outside blocks)
    if (depth === 0 && (c === 'd' || c === 'D') && atLineStart(i)) {
      const m = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(src.slice(i, i + 200));
      if (m) {
        push(i, '');
        delim = m[1];
        i += m[0].length;
        continue;
      }
    }

    if (stmtStart < 0) {
      if (isSpace(c)) {
        i++;
        continue;
      }
      // leading comments are not part of the statement (except /*! ... */ and optimizer hints)
      if (c === '#' || (c === '-' && src[i + 1] === '-' && (i + 2 >= n || isSpace(src[i + 2])))) {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*' && src[i + 2] !== '!' && src[i + 2] !== '+') {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      // stray delimiter
      if (src.startsWith(delim, i)) {
        i += delim.length;
        continue;
      }
      stmtStart = i;
    }

    // delimiter
    if (depth === 0 && src.startsWith(delim, i)) {
      push(i, delim);
      i += delim.length;
      continue;
    }

    // strings and quoted identifiers
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        const d = src[j];
        if (d === '\\' && c !== '`') {
          j += 2;
          continue;
        }
        if (d === c) {
          if (src[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = Math.min(j + 1, n);
      lastSignificant = i;
      prevToken = 'LIT';
      continue;
    }

    // comments inside a statement
    if (c === '#' || (c === '-' && src[i + 1] === '-' && (i + 2 >= n || isSpace(src[i + 2])))) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      lastSignificant = i;
      continue;
    }

    if (isSpace(c)) {
      i++;
      continue;
    }

    // words
    if (WORD_RE.test(c)) {
      let j = i + 1;
      while (j < n && WORD_RE.test(src[j])) j++;
      const w = src.slice(i, j).toUpperCase();
      i = j;
      lastSignificant = j;

      if (detectBlocks && delim === ';') {
        if (words.length < 12) {
          words.push(w);
          if (!compound) {
            const first = words[0];
            if (
              (first === 'CREATE' || first === 'ALTER') &&
              (w === 'PROCEDURE' || w === 'FUNCTION' || w === 'TRIGGER' || w === 'EVENT')
            ) {
              compound = true;
            } else if (first === 'BEGIN' && words.length === 2 && w === 'NOT') {
              // MariaDB anonymous block: BEGIN NOT ATOMIC ... END
              compound = true;
              depth = 1;
            }
          }
        }
        if (compound) {
          const nextCh = (() => {
            let p = j;
            while (p < n && isSpace(src[p])) p++;
            return src[p];
          })();
          if (w === 'BEGIN' && !(words.length === 1)) {
            depth++;
          } else if (w === 'CASE') {
            depth++;
          } else if ((w === 'IF' || w === 'WHILE' || w === 'LOOP' || w === 'REPEAT') && nextCh !== '(') {
            if (w === 'IF') {
              if (BLOCK_OPENERS_AFTER.has(prevToken) && depth > 0) depth++;
            } else if (depth > 0) {
              depth++;
            }
          } else if (w === 'END') {
            if (depth > 0) depth--;
            const pk = peekWord(j);
            if (['IF', 'CASE', 'LOOP', 'WHILE', 'REPEAT'].includes(pk.word)) {
              i = pk.end;
              lastSignificant = pk.end;
            }
          }
        }
      }
      prevToken = w;
      continue;
    }

    // punctuation
    prevToken = c === ';' || c === ':' ? c : 'P';
    i++;
    lastSignificant = i;
  }

  push(n, '');
  return out;
}

/** The statement at a cursor offset (for "run current statement"). */
export function statementAt(src: string, offset: number, opts: SplitOptions = {}): SplitStatement | null {
  const list = splitStatements(src, opts);
  if (!list.length) return null;
  let best: SplitStatement | null = null;
  for (const s of list) {
    if (offset >= s.start && offset <= s.end + s.delimiter.length) return s;
    if (s.start <= offset) best = s;
  }
  if (best) {
    // cursor after a statement: prefer it when only whitespace on the same line follows
    const gap = src.slice(best.end + best.delimiter.length, offset);
    if (!gap.includes('\n')) return best;
  }
  return list.find((s) => s.start >= offset) ?? best;
}

/** First keyword of a statement, upper-cased (skips comments and parentheses). */
export function firstKeyword(sql: string): string {
  const m = /^(?:\s|\(|\/\*(?!!)[\s\S]*?\*\/|--[^\n]*\n|#[^\n]*\n)*([A-Za-z]+)/.exec(sql);
  return m ? m[1].toUpperCase() : '';
}

const RESULT_KEYWORDS = new Set(['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'WITH', 'TABLE', 'VALUES', 'CALL', 'HELP', 'CHECK', 'ANALYZE', 'OPTIMIZE', 'REPAIR', 'CHECKSUM']);

export function mayReturnRows(sql: string): boolean {
  return RESULT_KEYWORDS.has(firstKeyword(sql));
}

/** UPDATE / DELETE without WHERE (simple heuristic for the safety prompt). */
export function isUnsafeWrite(sql: string): boolean {
  const kw = firstKeyword(sql);
  if (kw !== 'UPDATE' && kw !== 'DELETE') return false;
  const stripped = sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``');
  return !/\bWHERE\b/i.test(stripped) && !/\bLIMIT\b/i.test(stripped);
}

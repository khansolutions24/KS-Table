// Input handling of the console like the mysql command line client: statements may span lines and end with
// the delimiter, \g or \G; quotes and comments are respected; client commands (help, clear, use, delimiter …).

import { quoteString } from '@shared/sql/quote';

export interface ScanState {
  /** Text of the unfinished statement (lines separated by \n) */
  buffer: string;
  delimiter: string;
  /** Open quote at the end of the buffer */
  quote: '' | "'" | '"' | '`';
  /** Inside a /* … *\/ comment at the end of the buffer */
  comment: boolean;
}

export type ClientCommandName =
  | 'help'
  | 'clear'
  | 'quit'
  | 'status'
  | 'use'
  | 'delimiter'
  | 'reset'
  | 'print'
  | 'warnings'
  | 'nowarnings'
  | 'noquery'
  | 'unknown'
  | 'unsupported';

export type ConsoleCommand =
  | { kind: 'sql'; sql: string; vertical: boolean }
  | { kind: 'client'; name: ClientCommandName; arg: string };

export function initialScanState(delimiter = ';'): ScanState {
  return { buffer: '', delimiter, quote: '', comment: false };
}

const LONG_COMMANDS: [RegExp, ClientCommandName][] = [
  [/^(?:help|\?)\s*;?$/i, 'help'],
  [/^(?:clear|cls)\s*;?$/i, 'clear'],
  [/^(?:exit|quit)\s*;?$/i, 'quit'],
  [/^status\s*;?$/i, 'status'],
  [/^warnings\s*;?$/i, 'warnings'],
  [/^nowarning\s*;?$/i, 'nowarnings']
];

const UNSUPPORTED = /^(source|tee|notee|pager|nopager|system|connect|charset|rehash|prompt|edit|resetconnection)(\s|;|$)/i;

/** `db`, 'db', db; → db */
export function unquoteName(s: string): string {
  const t = s.trim().replace(/;+$/, '').trim();
  if (t.length >= 2 && t.startsWith('`') && t.endsWith('`')) return t.slice(1, -1).replace(/``/g, '`');
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) return t.slice(1, -1);
  return t;
}

/** Processes one input line; returns the complete commands and the new state. */
export function feedLine(state: ScanState, line: string): { commands: ConsoleCommand[]; state: ScanState } {
  const commands: ConsoleCommand[] = [];
  let { delimiter, quote, comment } = state;
  const trimmed = line.trim();
  const empty = !state.buffer.trim() && !quote && !comment;

  if (empty) {
    const done = (): { commands: ConsoleCommand[]; state: ScanState } => ({ commands, state: { buffer: '', delimiter, quote: '', comment: false } });
    if (!trimmed || trimmed.startsWith('#') || /^--(\s|$)/.test(trimmed)) return done();
    for (const [re, name] of LONG_COMMANDS) {
      if (re.test(trimmed)) {
        commands.push({ kind: 'client', name, arg: '' });
        return done();
      }
    }
    let m = /^use\s+(.+)$/i.exec(trimmed);
    if (m) {
      commands.push({ kind: 'client', name: 'use', arg: unquoteName(m[1]) });
      return done();
    }
    m = /^delimiter\s+(\S+)/i.exec(trimmed);
    if (m) {
      delimiter = m[1];
      commands.push({ kind: 'client', name: 'delimiter', arg: m[1] });
      return done();
    }
    if (/^delimiter\s*$/i.test(trimmed)) {
      commands.push({ kind: 'client', name: 'delimiter', arg: '' });
      return done();
    }
    m = /^help\s+(.+?)\s*;?$/i.exec(trimmed);
    if (m) {
      commands.push({ kind: 'sql', sql: `HELP ${quoteString(m[1])}`, vertical: false });
      return done();
    }
    if (UNSUPPORTED.test(trimmed)) {
      commands.push({ kind: 'client', name: 'unsupported', arg: trimmed.split(/[\s;]+/)[0] });
      return done();
    }
  }

  let text = (empty ? '' : state.buffer) + line;
  let start = 0;
  let i = empty ? 0 : state.buffer.length;
  let n = text.length;
  const cut = (from: number, len: number) => {
    text = text.slice(0, from) + text.slice(from + len);
    n = text.length;
  };
  while (i < n) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote !== '`') {
        i += 2;
        continue;
      }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (comment) {
      if (c === '*' && text[i + 1] === '/') {
        comment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      comment = true;
      i += 2;
      continue;
    }
    // line comment: the rest of the line belongs to the statement text but cannot end it
    if (c === '#' || (c === '-' && text[i + 1] === '-' && (i + 2 >= n || /\s/.test(text[i + 2])))) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '\\' && i + 1 < n) {
      const k = text[i + 1];
      if (k === 'g' || k === 'G') {
        const sql = text.slice(start, i).trim();
        commands.push(sql ? { kind: 'sql', sql, vertical: k === 'G' } : { kind: 'client', name: 'noquery', arg: '' });
        i += 2;
        start = i;
        continue;
      }
      if (k === 'c') {
        commands.push({ kind: 'client', name: 'reset', arg: '' });
        i += 2;
        start = i;
        continue;
      }
      if (k === 'q') {
        commands.push({ kind: 'client', name: 'quit', arg: '' });
        start = n;
        break;
      }
      if (k === 'u' || k === 'd') {
        const rest = text.slice(i + 2).trim();
        const arg = k === 'u' ? unquoteName(rest.split(/\s+/)[0] ?? '') : (rest.split(/\s+/)[0] ?? '');
        if (k === 'd' && arg) delimiter = arg;
        commands.push({ kind: 'client', name: k === 'u' ? 'use' : 'delimiter', arg });
        text = text.slice(0, i);
        n = text.length;
        break;
      }
      const simple: Record<string, ClientCommandName> = { h: 'help', '?': 'help', s: 'status', p: 'print', W: 'warnings', w: 'nowarnings' };
      const name = simple[k];
      if (name) commands.push({ kind: 'client', name, arg: name === 'print' ? text.slice(start, i).trim() : '' });
      else commands.push({ kind: 'client', name: 'unknown', arg: `\\${k}` });
      cut(i, 2);
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      const sql = text.slice(start, i).trim();
      commands.push(sql ? { kind: 'sql', sql, vertical: false } : { kind: 'client', name: 'noquery', arg: '' });
      i += delimiter.length;
      start = i;
      continue;
    }
    i++;
  }
  const rest = text.slice(start);
  const buffer = quote || comment || hasStatementText(rest) ? `${rest}\n` : '';
  return { commands, state: { buffer, delimiter, quote, comment } };
}

/** Text contains more than whitespace and comments (/*! … *\/ counts as statement text) */
function hasStatementText(s: string): boolean {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '#' || (c === '-' && s[i + 1] === '-' && (i + 2 >= n || /\s/.test(s[i + 2])))) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
    } else if (c === '/' && s[i + 1] === '*' && s[i + 2] !== '!' && s[i + 2] !== '+') {
      const e = s.indexOf('*/', i + 2);
      if (e < 0) return true;
      i = e + 2;
    } else {
      return true;
    }
  }
  return false;
}

/** Prompt for the next input line */
export function promptFor(state: ScanState, main: string): string {
  if (state.quote) return `    ${state.quote}> `;
  if (state.comment) return '   /*> ';
  if (state.buffer.trim()) return '    -> ';
  return main;
}

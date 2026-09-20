// Random strings from a mask (KD-#####) or from a regular expression.
// Regex subset: literals, . [abc] [a-z] [^…] \d \w \W \s \t \r \n, groups ( ), alternatives |,
// quantifiers * + ? {n} {n,} {n,m}; anchors ^ $ are ignored.

export type Rnd = (n: number) => number;

const DIGITS = '0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LETTERS = `${UPPER}abcdefghijklmnopqrstuvwxyz`;
const ALNUM = UPPER + DIGITS;
const WORD = `${LETTERS}_${DIGITS}`;
const PRINTABLE = (() => {
  let s = '';
  for (let c = 32; c < 127; c++) s += String.fromCharCode(c);
  return s;
})();
/** upper bound for * + and {n,} */
const OPEN_MAX = 8;

/** Mask: # digit, @ letter A-Z, ? letter a-z/A-Z, * letter A-Z or digit, \x literal x */
export function fromMask(mask: string, rnd: Rnd): string {
  let out = '';
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c === '\\' && i + 1 < mask.length) out += mask[++i];
    else if (c === '#') out += DIGITS[rnd(10)];
    else if (c === '@') out += UPPER[rnd(26)];
    else if (c === '?') out += LETTERS[rnd(52)];
    else if (c === '*') out += ALNUM[rnd(36)];
    else out += c;
  }
  return out;
}

export type RegexNode =
  | { t: 'lit'; s: string }
  | { t: 'chars'; set: string }
  | { t: 'seq'; items: { node: RegexNode; min: number; max: number }[] }
  | { t: 'alt'; options: RegexNode[] };

export class RegexSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number
  ) {
    super(message);
    this.name = 'RegexSyntaxError';
  }
}

function escapeSet(c: string | undefined): string {
  switch (c) {
    case 'd':
      return DIGITS;
    case 'w':
      return WORD;
    case 'W':
      return PRINTABLE;
    case 's':
      return ' ';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case 'n':
      return '\n';
    default:
      return c ?? '\\';
  }
}

export function compileRegex(pattern: string): RegexNode {
  let i = 0;
  const fail = (msg: string): never => {
    throw new RegexSyntaxError(msg, i);
  };

  const parseClass = (): RegexNode => {
    let negate = false;
    if (pattern[i] === '^') {
      negate = true;
      i++;
    }
    let set = '';
    let first = true;
    while (i < pattern.length && (pattern[i] !== ']' || first)) {
      first = false;
      let c: string;
      if (pattern[i] === '\\') {
        i++;
        const e = escapeSet(pattern[i++]);
        if (e.length > 1) {
          set += e;
          continue;
        }
        c = e;
      } else c = pattern[i++];
      if (pattern[i] === '-' && i + 1 < pattern.length && pattern[i + 1] !== ']') {
        i++;
        let d = pattern[i++];
        if (d === '\\') d = escapeSet(pattern[i++])[0];
        const a = c.charCodeAt(0);
        const b = d.charCodeAt(0);
        if (b < a) fail('invalid range');
        for (let x = a; x <= b; x++) set += String.fromCharCode(x);
      } else set += c;
    }
    if (pattern[i] !== ']') fail('missing ]');
    i++;
    if (negate) set = [...PRINTABLE].filter((ch) => !set.includes(ch)).join('');
    if (!set) fail('empty character class');
    return { t: 'chars', set: [...new Set(set)].join('') };
  };

  const parseQuant = (): [number, number] => {
    const c = pattern[i];
    if (c === '*') {
      i++;
      return [0, OPEN_MAX];
    }
    if (c === '+') {
      i++;
      return [1, OPEN_MAX];
    }
    if (c === '?') {
      i++;
      return [0, 1];
    }
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m) {
        i += m[0].length;
        const lo = Number(m[1]);
        const hi = m[2] ? (m[3] ? Number(m[3]) : lo + OPEN_MAX) : lo;
        if (hi < lo) fail('invalid repetition');
        return [Math.min(lo, 1000), Math.min(hi, 1000)];
      }
    }
    return [1, 1];
  };

  // eslint-disable-next-line prefer-const
  let parseAlt: () => RegexNode;

  const parseAtom = (): RegexNode | null => {
    const c = pattern[i++];
    switch (c) {
      case '(': {
        if (pattern.startsWith('?:', i)) i += 2;
        const n = parseAlt();
        if (pattern[i] !== ')') fail('missing )');
        i++;
        return n;
      }
      case '[':
        return parseClass();
      case '\\': {
        const e = escapeSet(pattern[i++]);
        return e.length > 1 ? { t: 'chars', set: e } : { t: 'lit', s: e };
      }
      case '.':
        return { t: 'chars', set: PRINTABLE };
      case '^':
      case '$':
        return null;
      case '*':
      case '+':
      case '?':
        return fail('quantifier without expression');
      default:
        return { t: 'lit', s: c };
    }
  };

  const parseSeq = (): RegexNode => {
    const items: { node: RegexNode; min: number; max: number }[] = [];
    while (i < pattern.length && pattern[i] !== '|' && pattern[i] !== ')') {
      const node = parseAtom();
      if (!node) continue;
      const [min, max] = parseQuant();
      items.push({ node, min, max });
    }
    return { t: 'seq', items };
  };

  parseAlt = () => {
    const options = [parseSeq()];
    while (pattern[i] === '|') {
      i++;
      options.push(parseSeq());
    }
    return options.length === 1 ? options[0] : { t: 'alt', options };
  };

  const root = parseAlt();
  if (i < pattern.length) fail('unexpected )');
  return root;
}

export function fromRegex(node: RegexNode, rnd: Rnd): string {
  switch (node.t) {
    case 'lit':
      return node.s;
    case 'chars':
      return node.set[rnd(node.set.length)];
    case 'alt':
      return fromRegex(node.options[rnd(node.options.length)], rnd);
    default: {
      let out = '';
      for (const r of node.items) {
        const n = r.min + rnd(r.max - r.min + 1);
        for (let k = 0; k < n; k++) out += fromRegex(r.node, rnd);
      }
      return out;
    }
  }
}

/** Error text of an invalid pattern or null */
export function regexError(pattern: string): string | null {
  try {
    compileRegex(pattern);
    return null;
  } catch (e) {
    return e instanceof RegexSyntaxError ? `${e.message} (${e.position + 1})` : String(e);
  }
}

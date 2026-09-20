// Result tab names from a comment right before a statement: `-- name: Kunden`, `# name: …` or `/* name: … */`.

const NAME_RE = /(?:--[ \t]|#)[ \t]*name[ \t]*:[ \t]*([^\r\n]*)|\/\*\s*name\s*:\s*([\s\S]*?)\s*\*\//gi;

/** Name given in the text between the previous statement and this one (last match wins). */
export function resultNameIn(gap: string): string | null {
  let last: string | null = null;
  NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(gap))) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v) last = v.slice(0, 60);
  }
  return last;
}

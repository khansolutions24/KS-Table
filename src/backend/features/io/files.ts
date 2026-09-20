// File helpers of the io feature: streamed text input with encodings, buffered text output.

import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import iconv from 'iconv-lite';
import { tr } from '@shared/i18n';
import { KsError } from '../../errors';

/** Resolves the encoding 'auto' (byte order mark, XML declaration, otherwise UTF-8). */
export function detectEncoding(head: Uint8Array, requested: string, xml = false): string {
  if (requested && requested !== 'auto') return requested;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf8';
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf16be';
  if (xml) {
    const decl = /^<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(Buffer.from(head.subarray(0, 200)).toString('latin1'));
    if (decl && iconv.encodingExists(decl[1])) return decl[1].toLowerCase();
  }
  return 'utf8';
}

export function checkEncoding(encoding: string): void {
  if (encoding !== 'auto' && encoding !== 'utf8bom' && !iconv.encodingExists(encoding)) {
    throw new KsError(tr('Unbekannte Zeichenkodierung: {e}', 'Unknown character encoding: {e}', { e: encoding }));
  }
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    throw new KsError(tr('Datei nicht gefunden: {f}', 'File not found: {f}', { f: file }));
  }
}

/**
 * Streams a text file as decoded chunks of about 1 MB (byte order mark removed).
 * onBytes receives the number of bytes of every raw chunk read.
 */
export async function* readTextChunks(file: string, encoding: string, onBytes?: (n: number) => void, xml = false): AsyncGenerator<string> {
  checkEncoding(encoding);
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  let decoder: iconv.DecoderStream | null = null;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (!decoder) decoder = iconv.getDecoder(detectEncoding(chunk, encoding, xml) as iconv.Encoding, { stripBOM: true });
      onBytes?.(chunk.length);
      const text = decoder.write(chunk);
      if (text) yield text;
    }
    const rest = decoder?.end();
    if (rest) yield rest;
  } finally {
    stream.destroy();
  }
}

/** Reads at most `maxBytes` of a text file (previews, XML survey). */
export async function readTextHead(file: string, encoding: string, maxBytes: number, xml = false): Promise<{ text: string; complete: boolean }> {
  checkEncoding(encoding);
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const dec = iconv.getDecoder(detectEncoding(buf, encoding, xml) as iconv.Encoding, { stripBOM: true });
    let text = dec.write(buf);
    const complete = len >= size;
    if (complete) text += dec.end() ?? '';
    return { text, complete };
  } finally {
    await fh.close();
  }
}

const FLUSH_CHARS = 1 << 18;

/** Buffered, encoded text output with back pressure. */
export class TextOutput {
  private parts: string[] = [];
  private pending = 0;
  /** bytes written so far */
  bytes = 0;

  private constructor(
    private readonly stream: fs.WriteStream,
    private readonly encoding: string,
    readonly file: string,
    /** the file existed with content (append mode) */
    readonly existed: boolean
  ) {}

  static async open(file: string, encoding: string, append = false): Promise<TextOutput> {
    checkEncoding(encoding);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    let existed = false;
    if (append) {
      const st = await fs.promises.stat(file).catch(() => null);
      existed = !!st && st.size > 0;
    }
    const enc = encoding === 'utf8bom' || encoding === 'auto' ? 'utf8' : encoding;
    const stream = fs.createWriteStream(file, { flags: append ? 'a' : 'w' });
    await once(stream, 'open');
    const out = new TextOutput(stream, enc, file, existed);
    if (!existed) {
      const bom = encoding === 'utf8bom' ? [0xef, 0xbb, 0xbf] : enc === 'utf16le' ? [0xff, 0xfe] : enc === 'utf16be' ? [0xfe, 0xff] : null;
      if (bom) await out.writeBytes(Buffer.from(bom));
    }
    return out;
  }

  /** Queues text; returns a promise when the buffer was flushed (await it in loops). */
  write(s: string): Promise<void> | undefined {
    this.parts.push(s);
    this.pending += s.length;
    if (this.pending >= FLUSH_CHARS) return this.flush();
    return undefined;
  }

  async writeBytes(buf: Buffer): Promise<void> {
    await this.flush();
    this.bytes += buf.length;
    if (!this.stream.write(buf)) await once(this.stream, 'drain');
  }

  async flush(): Promise<void> {
    if (!this.parts.length) return;
    const text = this.parts.length === 1 ? this.parts[0] : this.parts.join('');
    this.parts = [];
    this.pending = 0;
    const buf = this.encoding === 'utf8' ? Buffer.from(text, 'utf8') : iconv.encode(text, this.encoding as iconv.Encoding);
    this.bytes += buf.length;
    if (!this.stream.write(buf)) await once(this.stream, 'drain');
  }

  async close(): Promise<void> {
    await this.flush();
    this.stream.end();
    if (!this.stream.closed) await once(this.stream, 'close');
  }

  /** Stops writing; removes the file unless content was appended to an existing file. */
  async abort(): Promise<void> {
    this.parts = [];
    this.stream.destroy();
    if (!this.existed) await fs.promises.rm(this.file, { force: true }).catch(() => undefined);
  }
}

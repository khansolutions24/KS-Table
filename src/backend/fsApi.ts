import fs from 'node:fs/promises';
import path from 'node:path';
import iconv from 'iconv-lite';
import type { FileEntry, FsApi } from '@shared/api';
import { platform } from './platform';

const isUtf8 = (enc?: string) => !enc || /^utf-?8$/i.test(enc);

export const fsApi: FsApi = {
  async readText(p, encoding) {
    const buf = await fs.readFile(p);
    if (isUtf8(encoding)) {
      const s = buf.toString('utf8');
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    }
    return iconv.decode(buf, encoding!);
  },

  async writeText(p, content, encoding) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, isUtf8(encoding) ? content : iconv.encode(content, encoding!));
  },

  async readBinary(p) {
    return new Uint8Array(await fs.readFile(p));
  },

  async writeBinary(p, data) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  },

  async stat(p) {
    try {
      const s = await fs.stat(p);
      return { exists: true, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    } catch {
      return { exists: false, isDir: false, size: 0, mtime: 0 };
    }
  },

  async list(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: FileEntry[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const s = await fs.stat(full).catch(() => null);
      out.push({ name: e.name, path: full, isDir: e.isDirectory(), size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 });
    }
    return out;
  },

  async mkdir(dir) {
    await fs.mkdir(dir, { recursive: true });
  },

  async rename(from, to) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  },

  async remove(p) {
    const pl = platform();
    if (pl.trashItem) {
      try {
        await pl.trashItem(p);
        return;
      } catch {
        // fall back to deleting
      }
    }
    await fs.rm(p, { recursive: true, force: true });
  }
};

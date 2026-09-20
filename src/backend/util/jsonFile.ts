import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const writeChains = new Map<string, Promise<void>>();

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fsSync.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write (temp file + rename), serialized per file. */
export function writeJson(file: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, file);
    });
  writeChains.set(file, next);
  return next;
}

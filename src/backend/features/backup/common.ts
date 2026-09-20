// Helpers shared by backup, restore and extract: archive access, DDL capture, SQL literals, error classification.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { openPromise, type Entry, type ZipFile } from 'yauzl';
import type { BackupFileInfo, BackupManifest, BackupObjectType } from '@shared/apis/backup';
import { tr } from '@shared/i18n';
import { qname, quoteString } from '@shared/sql/quote';
import { KsError, toSqlError } from '../../errors';
import type { Session } from '../../db/sessions';
import { profilesDir } from '../../store/settings';

export const MANIFEST = 'manifest.json';
export const FORMAT = 'ks-table-backup';
export const FORMAT_VERSION = 1;

export const pad = (n: number, width = 4): string => String(n).padStart(width, '0');

/** Same folder as backupsDir() in the renderer: <profilesDir>/connections/<id>/<db>/backups */
export function backupFolder(connectionId: string, database: string): string {
  return path.join(profilesDir(), 'connections', connectionId, database, 'backups');
}

// ───────────────────────── Archive access ─────────────────────────

export interface BackupArchive {
  readonly file: string;
  readonly manifest: BackupManifest;
  has(name: string): boolean;
  text(name: string): Promise<string>;
  /** Lines of a text entry (data files hold one statement per line) */
  lines(name: string): AsyncGenerator<string>;
  close(): void;
}

function invalidBackup(file: string, e?: unknown): KsError {
  const detail = e instanceof Error ? ` (${e.message})` : '';
  return new KsError(
    tr('„{f}“ ist keine gültige KS-Table-Sicherung{d}.', '"{f}" is not a valid KS Table backup{d}.', { f: path.basename(file), d: detail }),
    'INVALID_BACKUP'
  );
}

export async function openArchive(file: string): Promise<BackupArchive> {
  let zip: ZipFile;
  try {
    zip = await openPromise(file, { lazyEntries: true, autoClose: false });
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      throw new KsError(tr('Die Datei „{f}“ wurde nicht gefunden.', 'File "{f}" was not found.', { f: file }), 'NOT_FOUND');
    }
    throw invalidBackup(file, e);
  }
  try {
    const entries = new Map<string, Entry>();
    for await (const e of zip.eachEntry()) entries.set(e.fileName, e);
    const entry = (name: string): Entry => {
      const e = entries.get(name);
      if (!e) throw new KsError(tr('Der Eintrag „{n}“ fehlt in der Sicherung.', 'Entry "{n}" is missing in the backup.', { n: name }));
      return e;
    };
    const read = async (name: string): Promise<Buffer> => {
      const rs = await zip.openReadStreamPromise(entry(name));
      const chunks: Buffer[] = [];
      for await (const c of rs) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    };
    if (!entries.has(MANIFEST)) throw invalidBackup(file);
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse((await read(MANIFEST)).toString('utf8')) as BackupManifest;
    } catch (e) {
      throw invalidBackup(file, e);
    }
    if (manifest?.format !== FORMAT || !Array.isArray(manifest.objects)) throw invalidBackup(file);
    if (Number(manifest.formatVersion) > FORMAT_VERSION) {
      throw new KsError(
        tr(
          'Die Sicherung wurde mit einer neueren Version von KS Table erstellt (Format {v}) und kann nicht gelesen werden.',
          'The backup was created by a newer version of KS Table (format {v}) and cannot be read.',
          { v: String(manifest.formatVersion) }
        )
      );
    }
    return {
      file,
      manifest,
      has: (name) => entries.has(name),
      text: async (name) => (await read(name)).toString('utf8'),
      async *lines(name) {
        const rs = await zip.openReadStreamPromise(entry(name));
        const rl = createInterface({ input: rs, crlfDelay: Infinity });
        try {
          for await (const line of rl) yield line;
        } finally {
          rl.close();
          rs.destroy();
        }
      },
      close: () => {
        try {
          zip.close();
        } catch {
          // already closed
        }
      }
    };
  } catch (e) {
    zip.close();
    throw e;
  }
}

export async function backupInfo(file: string): Promise<BackupFileInfo> {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new KsError(tr('Die Datei „{f}“ wurde nicht gefunden.', 'File "{f}" was not found.', { f: file }), 'NOT_FOUND');
  const arc = await openArchive(file);
  try {
    return { path: file, size: st.size, mtime: st.mtimeMs, manifest: arc.manifest };
  } finally {
    arc.close();
  }
}

// ───────────────────────── DDL ─────────────────────────

const SHOW_KW: Record<BackupObjectType, string> = {
  table: 'TABLE',
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  trigger: 'TRIGGER',
  event: 'EVENT'
};

export const DROP_KW = SHOW_KW;

export interface CapturedDdl {
  ddl: string;
  sqlMode?: string;
  collationConnection?: string;
  timeZone?: string;
}

/** SHOW CREATE … of an object plus the session settings it was created with. */
export async function captureDdl(s: Session, db: string, type: BackupObjectType, name: string): Promise<CapturedDdl> {
  const r = await s.rowset(`SHOW CREATE ${SHOW_KW[type]} ${qname(db, name)}`);
  const get = (re: RegExp): string | undefined => {
    const i = r.fields.findIndex((f) => re.test(f.name));
    if (i < 0) return undefined;
    const v = r.rows[0]?.[i];
    if (v === null || v === undefined) return undefined;
    return v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v);
  };
  const ddl = get(/^(create (table|view|function|procedure|event)|sql original statement)$/i);
  if (!ddl) {
    throw new KsError(tr('Keine Berechtigung, die Definition von „{n}“ zu lesen.', 'No privilege to read the definition of "{n}".', { n: name }));
  }
  return {
    ddl,
    sqlMode: get(/^sql_mode$/i),
    collationConnection: get(/^collation_connection$/i),
    timeZone: get(/^time_zone$/i)
  };
}

const USER_PART = "(?:`(?:[^`]|``)*`|'(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\"|[\\w.$%-]+)";
const DEFINER_RE = new RegExp(
  `^(\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:ALGORITHM\\s*=\\s*\\w+\\s+)?)DEFINER\\s*=\\s*(?:CURRENT_USER(?:\\s*\\(\\s*\\))?|${USER_PART}\\s*@\\s*${USER_PART})\\s+`,
  'i'
);

/** Removes the DEFINER clause so the object is created with the current user as definer. */
export function stripDefiner(ddl: string): string {
  return ddl.replace(DEFINER_RE, '$1');
}

// ───────────────────────── Values ─────────────────────────

export type ColKind = 'num' | 'bit' | 'bin' | 'str';

const NUMERIC = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year']);
const BINARY = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'geometry', 'point', 'linestring', 'polygon', 'multipoint',
  'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection'
]);
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export function colKind(dataType: string): ColKind {
  const t = dataType.toLowerCase();
  if (t === 'bit') return 'bit';
  if (NUMERIC.has(t)) return 'num';
  if (BINARY.has(t)) return 'bin';
  return 'str';
}

function bitLiteral(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(2).padStart(8, '0');
  s = s.replace(/^0+(?=.)/, '');
  return `b'${s || '0'}'`;
}

/** SQL literal for a value read with the app's driver settings (strings, numbers, Buffers, null). */
export function valueLiteral(v: unknown, kind: ColKind): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) {
    if (kind === 'bit') return bitLiteral(v);
    if (!v.length) return "''";
    return `X'${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}'`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v);
  if (kind === 'num' && NUMBER_RE.test(s)) return s;
  return quoteString(s);
}

// ───────────────────────── Errors ─────────────────────────

export function errorText(e: unknown): string {
  const x = toSqlError(e);
  return x.errno ? `${x.message} (${x.errno})` : x.message;
}

const errnoOf = (e: unknown): number => Number((e as { errno?: number })?.errno ?? 0);

/** The object references something that does not exist yet (views on views, functions) */
export function isDependencyError(e: unknown): boolean {
  return [1146, 1356, 1305].includes(errnoOf(e));
}

/** The server refused the DEFINER clause (missing SET_USER_ID / SUPER, unknown user) */
export function isDefinerError(e: unknown): boolean {
  return [1227, 1449].includes(errnoOf(e));
}

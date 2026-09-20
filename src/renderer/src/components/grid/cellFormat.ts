// Display / edit representation of cell values.

import type { CellValue, ColumnMeta, ResultColumn } from '@shared/types';
import { toHex } from '@shared/sql/quote';
import { formatBytes } from '@shared/util';

export type CellKind =
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'time'
  | 'year'
  | 'enum'
  | 'set'
  | 'json'
  | 'blob'
  | 'binary'
  | 'bit'
  | 'geometry';

export interface GridColumnDef {
  /** Column name (unique within the grid) */
  id: string;
  title: string;
  width?: number;
  kind: CellKind;
  /** Upper-case type name, e.g. VARCHAR(255) or INT UNSIGNED */
  typeLabel: string;
  numeric: boolean;
  readonly?: boolean;
  enumValues?: string[];
  primaryKey?: boolean;
  foreignKey?: boolean;
  nullable?: boolean;
  /** BIT(n) length */
  bitLength?: number;
  /** AUTO_INCREMENT: the server fills it in, so new rows skip it and leave it unset rather than requiring a value */
  autoIncrement?: boolean;
}

const GEOMETRY = new Set(['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geomcollection', 'geometrycollection']);

export function kindFromMeta(m: ColumnMeta): CellKind {
  const t = m.dataType;
  if (GEOMETRY.has(t)) return 'geometry';
  if (t === 'enum') return 'enum';
  if (t === 'set') return 'set';
  if (t === 'json') return 'json';
  if (t === 'bit') return 'bit';
  if (t === 'date') return 'date';
  if (t === 'datetime' || t === 'timestamp') return 'datetime';
  if (t === 'time') return 'time';
  if (t === 'year') return 'year';
  if (t.endsWith('blob')) return 'blob';
  if (t === 'binary' || t === 'varbinary') return 'binary';
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real'].includes(t)) return 'number';
  return 'text';
}

export function kindFromResult(c: ResultColumn): CellKind {
  const t = c.typeName;
  if (t === 'GEOMETRY') return 'geometry';
  if (t === 'ENUM') return 'enum';
  if (t === 'SET') return 'set';
  if (t === 'JSON') return 'json';
  if (t === 'BIT') return 'bit';
  if (t === 'DATE') return 'date';
  if (t === 'DATETIME' || t === 'TIMESTAMP') return 'datetime';
  if (t === 'TIME') return 'time';
  if (t === 'YEAR') return 'year';
  if (t.endsWith('BLOB')) return 'blob';
  if (t === 'BINARY' || t === 'VARBINARY') return 'binary';
  if (c.numeric) return 'number';
  return 'text';
}

export function columnFromMeta(m: ColumnMeta, extra: Partial<GridColumnDef> = {}): GridColumnDef {
  const bit = m.dataType === 'bit' ? /bit\((\d+)\)/i.exec(m.columnType) : null;
  return {
    id: m.name,
    title: m.name,
    kind: kindFromMeta(m),
    typeLabel: m.columnType.toUpperCase(),
    numeric: kindFromMeta(m) === 'number' || m.dataType === 'year',
    enumValues: m.enumValues,
    primaryKey: m.key === 'PRI',
    nullable: m.nullable,
    readonly: !!m.generationExpression,
    bitLength: bit ? Number(bit[1]) : m.dataType === 'bit' ? 1 : undefined,
    autoIncrement: /auto_increment/i.test(m.extra),
    ...extra
  };
}

export function columnFromResult(c: ResultColumn, extra: Partial<GridColumnDef> = {}): GridColumnDef {
  const kind = kindFromResult(c);
  return {
    id: c.name,
    title: c.name,
    kind,
    typeLabel: c.typeName + (c.unsigned ? ' UNSIGNED' : ''),
    numeric: c.numeric,
    primaryKey: c.primaryKey,
    nullable: !c.notNull,
    bitLength: kind === 'bit' ? c.length : undefined,
    ...extra
  };
}

const IMAGE_SIGNATURES: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], 'PNG'],
  [[0xff, 0xd8, 0xff], 'JPEG'],
  [[0x47, 0x49, 0x46, 0x38], 'GIF'],
  [[0x42, 0x4d], 'BMP'],
  [[0x52, 0x49, 0x46, 0x46], 'WEBP']
];

export function imageType(bytes: Uint8Array): string | null {
  for (const [sig, name] of IMAGE_SIGNATURES) if (sig.every((b, i) => bytes[i] === b)) return name;
  return null;
}

export function imageMime(bytes: Uint8Array): string | null {
  const t = imageType(bytes);
  return t ? `image/${t.toLowerCase()}` : null;
}

export function bitString(bytes: Uint8Array, len?: number): string {
  let s = '';
  for (const b of bytes) s += b.toString(2).padStart(8, '0');
  if (len && len < s.length) s = s.slice(s.length - len);
  return s.replace(/^0+(?=.)/, len === 1 ? '' : '') || '0';
}

// ───────────── MySQL internal geometry (4 byte SRID + WKB) → WKT ─────────────

export function geometryToWkt(bytes: Uint8Array): { srid: number; wkt: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const srid = view.getUint32(0, true);
  let pos = 4;
  const read = (): string => {
    const le = view.getUint8(pos) === 1;
    pos += 1;
    const type = view.getUint32(pos, le) % 1000;
    pos += 4;
    const u32 = () => {
      const v = view.getUint32(pos, le);
      pos += 4;
      return v;
    };
    const pt = () => {
      const x = view.getFloat64(pos, le);
      const y = view.getFloat64(pos + 8, le);
      pos += 16;
      return `${fmt(x)} ${fmt(y)}`;
    };
    const ring = () => {
      const n = u32();
      const pts: string[] = [];
      for (let i = 0; i < n; i++) pts.push(pt());
      return `(${pts.join(', ')})`;
    };
    switch (type) {
      case 1:
        return `POINT(${pt()})`;
      case 2:
        return `LINESTRING${ring()}`;
      case 3: {
        const n = u32();
        const rings: string[] = [];
        for (let i = 0; i < n; i++) rings.push(ring());
        return `POLYGON(${rings.join(', ')})`;
      }
      case 4:
      case 5:
      case 6:
      case 7: {
        const n = u32();
        const parts: string[] = [];
        for (let i = 0; i < n; i++) parts.push(read());
        const name = { 4: 'MULTIPOINT', 5: 'MULTILINESTRING', 6: 'MULTIPOLYGON', 7: 'GEOMETRYCOLLECTION' }[type as 4 | 5 | 6 | 7];
        if (type === 7) return `${name}(${parts.join(', ')})`;
        return `${name}(${parts.map((p) => p.replace(/^[A-Z]+/, '')).join(', ')})`;
      }
      default:
        throw new Error('unsupported geometry');
    }
  };
  try {
    return { srid, wkt: read() };
  } catch {
    return { srid, wkt: `0x${toHex(bytes)}` };
  }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e9) / 1e9);
}

const MAX_DISPLAY = 400;

/** Single line display text for a cell */
export function displayText(v: CellValue, col: GridColumnDef, nullText: string): string {
  if (v === null) return nullText;
  if (v instanceof Uint8Array) {
    if (col.kind === 'geometry') return geometryToWkt(v).wkt;
    if (col.kind === 'bit') return bitString(v, col.bitLength);
    if (v.length === 0) return '';
    const img = imageType(v);
    if (img) return `(${img}) ${formatBytes(v.length)}`;
    if (col.kind === 'binary' || v.length <= 24) return `0x${toHex(v.length > 64 ? v.subarray(0, 64) : v)}${v.length > 64 ? '…' : ''}`;
    return `(BLOB) ${formatBytes(v.length)}`;
  }
  const s = v.length > MAX_DISPLAY ? `${v.slice(0, MAX_DISPLAY)}…` : v;
  return s.includes('\n') || s.includes('\r') ? s.replace(/\r?\n|\r/g, ' ↵ ') : s;
}

/** Text used in the inline editor and for copying */
export function editText(v: CellValue, col: GridColumnDef): string {
  if (v === null) return '';
  if (v instanceof Uint8Array) {
    if (col.kind === 'geometry') return geometryToWkt(v).wkt;
    if (col.kind === 'bit') return bitString(v, col.bitLength);
    return toHex(v);
  }
  return v;
}

/** Can the value be edited inline (otherwise the value editor dialog is used)? */
export function inlineEditable(col: GridColumnDef, v: CellValue): boolean {
  if (col.readonly) return false;
  if (col.kind === 'blob' || col.kind === 'geometry') return false;
  if (v instanceof Uint8Array && col.kind !== 'bit' && col.kind !== 'binary') return false;
  return true;
}

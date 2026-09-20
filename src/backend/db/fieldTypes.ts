// MySQL protocol column types and flags → ResultColumn metadata.

import type { FieldPacket } from 'mysql2';
import type { ResultColumn } from '@shared/types';

export const FieldFlag = {
  NOT_NULL: 1,
  PRI_KEY: 2,
  UNIQUE_KEY: 4,
  MULTIPLE_KEY: 8,
  BLOB: 16,
  UNSIGNED: 32,
  ZEROFILL: 64,
  BINARY: 128,
  ENUM: 256,
  AUTO_INCREMENT: 512,
  TIMESTAMP: 1024,
  SET: 2048,
  NO_DEFAULT_VALUE: 4096,
  ON_UPDATE_NOW: 8192,
  NUM: 32768
} as const;

const BINARY_CHARSET = 63;

const TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  14: 'DATE',
  15: 'VARCHAR',
  16: 'BIT',
  17: 'TIMESTAMP',
  18: 'DATETIME',
  19: 'TIME',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VARCHAR',
  254: 'CHAR',
  255: 'GEOMETRY'
};

const NUMERIC_IDS = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]);

type AnyField = FieldPacket & {
  columnType?: number;
  characterSet?: number;
  columnLength?: number;
  schema?: string;
};

export function toResultColumn(f: FieldPacket): ResultColumn {
  const field = f as AnyField;
  const typeId = field.columnType ?? field.type ?? 253;
  const flags = typeof field.flags === 'number' ? field.flags : 0;
  const charsetNr = field.characterSet ?? field.charsetNr ?? 0;
  const length = field.columnLength ?? field.length ?? 0;
  let typeName = TYPE_NAMES[typeId] ?? 'UNKNOWN';
  const isStringish = typeId === 15 || typeId === 253 || typeId === 254 || (typeId >= 249 && typeId <= 252);
  const binary = typeId === 16 || typeId === 255 || (isStringish && charsetNr === BINARY_CHARSET);

  if (flags & FieldFlag.ENUM) typeName = 'ENUM';
  else if (flags & FieldFlag.SET) typeName = 'SET';
  else if (typeId === 253 || typeId === 15) typeName = binary ? 'VARBINARY' : 'VARCHAR';
  else if (typeId === 254) typeName = binary ? 'BINARY' : 'CHAR';
  else if (typeId >= 249 && typeId <= 252) {
    const base = binary ? 'BLOB' : 'TEXT';
    // length is in bytes (for text: chars * maxlen)
    if (length <= 255) typeName = 'TINY' + base;
    else if (length <= 65535 * 4) typeName = base;
    else if (length <= 16777215 * 4) typeName = 'MEDIUM' + base;
    else typeName = 'LONG' + base;
    if (!binary && length > 0 && length <= 65535 * 4 && length > 65535) typeName = base;
  }

  return {
    name: field.name,
    orgName: field.orgName ?? field.name,
    table: field.table ?? '',
    orgTable: field.orgTable ?? '',
    schema: field.schema ?? field.db ?? '',
    typeId,
    typeName,
    flags,
    length,
    decimals: field.decimals ?? 0,
    charsetNr,
    binary,
    primaryKey: (flags & FieldFlag.PRI_KEY) !== 0,
    notNull: (flags & FieldFlag.NOT_NULL) !== 0,
    unsigned: (flags & FieldFlag.UNSIGNED) !== 0,
    autoIncrement: (flags & FieldFlag.AUTO_INCREMENT) !== 0,
    numeric: NUMERIC_IDS.has(typeId)
  };
}

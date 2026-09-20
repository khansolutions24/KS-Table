// Text encodings offered for generated SQL scripts (data transfer to file, data sync script).
// `iconv` is the iconv-lite name, `mysql` the character set announced with SET NAMES in the script.

export interface SyncFileEncoding {
  id: string;
  label: string;
  iconv: string;
  mysql: string;
  bom: boolean;
}

export const SYNC_FILE_ENCODINGS: SyncFileEncoding[] = [
  { id: 'utf8', label: 'UTF-8', iconv: 'utf8', mysql: 'utf8mb4', bom: false },
  { id: 'utf8bom', label: 'UTF-8 (BOM)', iconv: 'utf8', mysql: 'utf8mb4', bom: true },
  { id: 'windows-1252', label: 'Windows-1252 (latin1)', iconv: 'windows-1252', mysql: 'latin1', bom: false },
  { id: 'iso-8859-1', label: 'ISO-8859-1', iconv: 'iso-8859-1', mysql: 'latin1', bom: false },
  { id: 'iso-8859-2', label: 'ISO-8859-2 (latin2)', iconv: 'iso-8859-2', mysql: 'latin2', bom: false },
  { id: 'windows-1250', label: 'Windows-1250', iconv: 'windows-1250', mysql: 'cp1250', bom: false },
  { id: 'windows-1251', label: 'Windows-1251', iconv: 'windows-1251', mysql: 'cp1251', bom: false }
];

export function fileEncoding(id: string): SyncFileEncoding {
  return SYNC_FILE_ENCODINGS.find((e) => e.id === id) ?? SYNC_FILE_ENCODINGS[0];
}

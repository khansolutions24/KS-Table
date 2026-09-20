// Metadata queries (information_schema / SHOW statements).

import type { CompletionTable } from '@shared/api';
import type {
  CharsetInfo,
  CollationInfo,
  ColumnMeta,
  EngineInfo,
  EventStatus,
  ObjectKind,
  RoutineStatus,
  SchemaInfo,
  TableStatus,
  TriggerStatus,
  ViewStatus
} from '@shared/types';
import { SYSTEM_SCHEMAS } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { parseEnumValues, qname } from '@shared/sql/quote';
import { KsError } from '../errors';
import type { Session } from './sessions';

type Row = Record<string, unknown>;

export const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export async function databases(s: Session): Promise<SchemaInfo[]> {
  const rows = await s.rows<Row>(
    'SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
  );
  let list: SchemaInfo[] = rows.map((r) => ({
    name: str(r.name),
    charset: str(r.charset),
    collation: str(r.collation),
    system: SYSTEM_SCHEMAS.has(str(r.name).toLowerCase())
  }));
  const cfg = s.config;
  if (cfg.hideSystemDatabases) list = list.filter((d) => !d.system);
  if (cfg.useCustomDatabaseList && cfg.databases.length) {
    const wanted = new Set(cfg.databases.map((x) => x.toLowerCase()));
    list = list.filter((d) => wanted.has(d.name.toLowerCase()));
  }
  return list;
}

export async function tables(s: Session, schema: string): Promise<TableStatus[]> {
  const rows = await s.rows<Row>(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, ROW_FORMAT AS rowFormat, TABLE_ROWS AS tableRows,
            AVG_ROW_LENGTH AS avgRowLength, DATA_LENGTH AS dataLength, MAX_DATA_LENGTH AS maxDataLength,
            INDEX_LENGTH AS indexLength, DATA_FREE AS dataFree, AUTO_INCREMENT AS autoIncrement,
            CREATE_TIME AS createTime, UPDATE_TIME AS updateTime, CHECK_TIME AS checkTime,
            TABLE_COLLATION AS collation, CHECKSUM AS checksum, CREATE_OPTIONS AS createOptions, TABLE_COMMENT AS comment
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE <> 'VIEW'
      ORDER BY TABLE_NAME`,
    [schema]
  );
  return rows.map((r) => ({
    name: str(r.name),
    type: str(r.type) as TableStatus['type'],
    engine: strOrNull(r.engine),
    rowFormat: strOrNull(r.rowFormat),
    rows: num(r.tableRows),
    avgRowLength: num(r.avgRowLength),
    dataLength: num(r.dataLength),
    maxDataLength: num(r.maxDataLength),
    indexLength: num(r.indexLength),
    dataFree: num(r.dataFree),
    autoIncrement: num(r.autoIncrement),
    createTime: strOrNull(r.createTime),
    updateTime: strOrNull(r.updateTime),
    checkTime: strOrNull(r.checkTime),
    collation: strOrNull(r.collation),
    checksum: num(r.checksum),
    createOptions: str(r.createOptions),
    comment: str(r.comment)
  }));
}

export async function views(s: Session, schema: string): Promise<ViewStatus[]> {
  const rows = await s.rows<Row>(
    `SELECT TABLE_NAME AS name, DEFINER AS definer, SECURITY_TYPE AS securityType, CHECK_OPTION AS checkOption,
            IS_UPDATABLE AS isUpdatable, CHARACTER_SET_CLIENT AS characterSetClient, COLLATION_CONNECTION AS collationConnection
       FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [schema]
  );
  return rows.map((r) => ({
    name: str(r.name),
    definer: str(r.definer),
    securityType: str(r.securityType),
    checkOption: str(r.checkOption),
    isUpdatable: str(r.isUpdatable) === 'YES',
    characterSetClient: str(r.characterSetClient),
    collationConnection: str(r.collationConnection)
  }));
}

export async function routines(s: Session, schema: string): Promise<RoutineStatus[]> {
  const rows = await s.rows<Row>(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DEFINER AS definer, CREATED AS created, LAST_ALTERED AS modified,
            SECURITY_TYPE AS securityType, ROUTINE_COMMENT AS comment, DTD_IDENTIFIER AS returnsType,
            IS_DETERMINISTIC AS isDeterministic, SQL_DATA_ACCESS AS dataAccess
       FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
    [schema]
  );
  return rows.map((r) => ({
    name: str(r.name),
    type: str(r.type) as RoutineStatus['type'],
    definer: str(r.definer),
    created: strOrNull(r.created),
    modified: strOrNull(r.modified),
    securityType: str(r.securityType),
    comment: str(r.comment),
    returns: strOrNull(r.returnsType),
    deterministic: str(r.isDeterministic) === 'YES',
    dataAccess: str(r.dataAccess)
  }));
}

export async function events(s: Session, schema: string): Promise<EventStatus[]> {
  const rows = await s.rows<Row>(
    `SELECT EVENT_NAME AS name, DEFINER AS definer, TIME_ZONE AS timeZone, EVENT_TYPE AS eventType, EXECUTE_AT AS executeAt,
            INTERVAL_VALUE AS intervalValue, INTERVAL_FIELD AS intervalField, STARTS AS starts, ENDS AS ends, STATUS AS status,
            ON_COMPLETION AS onCompletion, CREATED AS created, LAST_ALTERED AS lastAltered, LAST_EXECUTED AS lastExecuted,
            EVENT_COMMENT AS comment
       FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
    [schema]
  );
  return rows.map((r) => ({
    name: str(r.name),
    definer: str(r.definer),
    timeZone: str(r.timeZone),
    eventType: str(r.eventType) as EventStatus['eventType'],
    executeAt: strOrNull(r.executeAt),
    intervalValue: strOrNull(r.intervalValue),
    intervalField: strOrNull(r.intervalField),
    starts: strOrNull(r.starts),
    ends: strOrNull(r.ends),
    status: str(r.status),
    onCompletion: str(r.onCompletion),
    created: strOrNull(r.created),
    lastAltered: strOrNull(r.lastAltered),
    lastExecuted: strOrNull(r.lastExecuted),
    comment: str(r.comment)
  }));
}

export async function triggers(s: Session, schema: string, table?: string): Promise<TriggerStatus[]> {
  const rows = await s.rows<Row>(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event,
            ACTION_STATEMENT AS statement, ACTION_ORDER AS actionOrder, CREATED AS created, DEFINER AS definer
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ? ${table ? 'AND EVENT_OBJECT_TABLE = ?' : ''}
      ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER`,
    table ? [schema, table] : [schema]
  );
  return rows.map((r) => ({
    name: str(r.name),
    table: str(r.tableName),
    timing: str(r.timing) as TriggerStatus['timing'],
    event: str(r.event) as TriggerStatus['event'],
    statement: str(r.statement),
    order: Number(r.actionOrder ?? 0),
    created: strOrNull(r.created),
    definer: str(r.definer)
  }));
}

export async function columns(s: Session, schema: string, table: string): Promise<ColumnMeta[]> {
  const rows = await s.rows<Row>(
    `SELECT COLUMN_NAME AS name, ORDINAL_POSITION AS position, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
            IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_KEY AS columnKey,
            CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, COLUMN_COMMENT AS comment,
            CHARACTER_MAXIMUM_LENGTH AS maxLength, NUMERIC_PRECISION AS numericPrecision, NUMERIC_SCALE AS numericScale,
            DATETIME_PRECISION AS datetimePrecision, GENERATION_EXPRESSION AS generationExpression
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [schema, table]
  );
  return rows.map((r) => {
    const dataType = str(r.dataType).toLowerCase();
    const columnType = str(r.columnType);
    const col: ColumnMeta = {
      name: str(r.name),
      position: Number(r.position),
      dataType,
      columnType,
      nullable: str(r.nullable) === 'YES',
      defaultValue: strOrNull(r.defaultValue),
      extra: str(r.extra),
      key: str(r.columnKey) as ColumnMeta['key'],
      charset: strOrNull(r.charset),
      collation: strOrNull(r.collation),
      comment: str(r.comment),
      maxLength: num(r.maxLength),
      numericPrecision: num(r.numericPrecision),
      numericScale: num(r.numericScale),
      datetimePrecision: num(r.datetimePrecision),
      generationExpression: str(r.generationExpression)
    };
    if (dataType === 'enum' || dataType === 'set') col.enumValues = parseEnumValues(columnType);
    return col;
  });
}

const SHOW_KIND: Record<ObjectKind, string> = {
  table: 'TABLE',
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  event: 'EVENT',
  trigger: 'TRIGGER'
};

export async function ddl(s: Session, schema: string, kind: ObjectKind, name: string): Promise<string> {
  const r = await s.rowset(`SHOW CREATE ${SHOW_KIND[kind]} ${qname(schema, name)}`);
  const idx = r.fields.findIndex(
    (f) => /^create (table|view|function|procedure|event)$/i.test(f.name) || f.name === 'SQL Original Statement'
  );
  const v = idx >= 0 ? r.rows[0]?.[idx] : null;
  if (v === null || v === undefined) {
    throw new KsError(tr('Keine Berechtigung, die Definition anzuzeigen.', 'No privilege to show the definition.'));
  }
  return v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v);
}

export async function charsets(s: Session): Promise<CharsetInfo[]> {
  const r = await s.rowset('SHOW CHARACTER SET');
  return r.rows
    .map((row) => ({ charset: str(row[0]), description: str(row[1]), defaultCollation: str(row[2]), maxLen: Number(row[3]) }))
    .sort((a, b) => a.charset.localeCompare(b.charset));
}

export async function collations(s: Session): Promise<CollationInfo[]> {
  const r = await s.rowset('SHOW COLLATION');
  const idx = (n: string) => r.fields.findIndex((f) => f.name.toLowerCase() === n);
  const ci = idx('collation');
  const ch = idx('charset');
  const id = idx('id');
  const df = idx('default');
  return r.rows
    .filter((row) => row[ch] !== null)
    .map((row) => ({ collation: str(row[ci]), charset: str(row[ch]), id: Number(row[id]), isDefault: str(row[df]) === 'Yes' }))
    .sort((a, b) => a.collation.localeCompare(b.collation));
}

export async function engines(s: Session): Promise<EngineInfo[]> {
  const r = await s.rowset('SHOW ENGINES');
  return r.rows
    .map((row) => ({ engine: str(row[0]), support: str(row[1]), comment: str(row[2]), transactions: str(row[3]) === 'YES' }))
    .filter((e) => e.support !== 'NO');
}

export async function completion(s: Session, schema: string): Promise<CompletionTable[]> {
  const rows = await s.rows<Row>(
    `SELECT c.TABLE_NAME AS t, t.TABLE_TYPE AS k, c.COLUMN_NAME AS c, c.COLUMN_TYPE AS ct
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = ?
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
    [schema]
  );
  const map = new Map<string, CompletionTable>();
  for (const r of rows) {
    const name = str(r.t);
    let t = map.get(name);
    if (!t) {
      t = { name, type: str(r.k) === 'VIEW' ? 'view' : 'table', columns: [] };
      map.set(name, t);
    }
    t.columns.push({ name: str(r.c), type: str(r.ct) });
  }
  return [...map.values()];
}

// Table metadata for the data generator: columns, unique keys, foreign keys, dependency order.

import type { DataGenAnalysis, DgColumn, DgForeignKey, DgTable, DgUniqueKey } from '@shared/apis/datagen';
import { parseEnumValues } from '@shared/sql/quote';
import type { Session } from '../../db/sessions';

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export async function analyzeDatabase(ses: Session, db: string, only?: Set<string>): Promise<DataGenAnalysis> {
  const tableRows = await ses.rows<Row>(
    `SELECT TABLE_NAME AS t, TABLE_ROWS AS r, AUTO_INCREMENT AS ai FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [db]
  );
  const wanted = (t: string) => !only || only.has(t.toLowerCase());
  const tables = new Map<string, DgTable>();
  for (const r of tableRows) {
    if (!wanted(s(r.t))) continue;
    tables.set(s(r.t), { name: s(r.t), rows: Number(r.r ?? 0) || 0, autoIncrement: n(r.ai), columns: [], uniqueKeys: [], foreignKeys: [], dependsOn: [] });
  }
  const hasSrid = (
    await ses.rows<Row>("SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'information_schema' AND TABLE_NAME = 'COLUMNS' AND COLUMN_NAME = 'SRS_ID'")
  )[0]?.c;
  const cols = await ses.rows<Row>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS dt, COLUMN_TYPE AS ct, IS_NULLABLE AS nl, COLUMN_DEFAULT AS d, EXTRA AS x,
            CHARACTER_MAXIMUM_LENGTH AS ml, NUMERIC_PRECISION AS np, NUMERIC_SCALE AS ns, GENERATION_EXPRESSION AS g,
            COLUMN_COMMENT AS cm${Number(hasSrid) ? ', SRS_ID AS srid' : ''}
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [db]
  );
  for (const r of cols) {
    const t = tables.get(s(r.t));
    if (!t) continue;
    const dataType = s(r.dt).toLowerCase();
    const columnType = s(r.ct);
    const extra = s(r.x).toLowerCase();
    const col: DgColumn = {
      name: s(r.c),
      dataType,
      columnType,
      nullable: s(r.nl) === 'YES',
      defaultValue: r.d === null || r.d === undefined ? null : s(r.d),
      autoIncrement: extra.includes('auto_increment'),
      generated: !!s(r.g) || /\b(virtual|stored) generated\b/.test(extra),
      unsigned: /unsigned/i.test(columnType),
      maxLength: n(r.ml),
      precision: n(r.np),
      scale: n(r.ns),
      enumValues: dataType === 'enum' || dataType === 'set' ? parseEnumValues(columnType) : [],
      srid: n(r.srid),
      comment: s(r.cm)
    };
    t.columns.push(col);
  }
  const idx = await ses.rows<Row>(
    `SELECT TABLE_NAME AS t, INDEX_NAME AS i, COLUMN_NAME AS c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0 ORDER BY TABLE_NAME, INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
    [db]
  );
  const keyMap = new Map<string, DgUniqueKey & { expr: boolean }>();
  for (const r of idx) {
    const t = tables.get(s(r.t));
    if (!t) continue;
    const k = `${t.name}${s(r.i)}`;
    let key = keyMap.get(k);
    if (!key) {
      key = { name: s(r.i), columns: [], primary: s(r.i) === 'PRIMARY', expr: false };
      keyMap.set(k, key);
      t.uniqueKeys.push(key);
    }
    if (r.c === null) key.expr = true;
    else key.columns.push(s(r.c));
  }
  for (const t of tables.values()) {
    // functional unique indexes cannot be checked on the client
    t.uniqueKeys = t.uniqueKeys.filter((k) => !(k as { expr?: boolean }).expr).map(({ name, columns, primary }) => ({ name, columns, primary }));
  }
  const fks = await ses.rows<Row>(
    `SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS n, COLUMN_NAME AS c, REFERENCED_TABLE_SCHEMA AS rs, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [db]
  );
  const fkMap = new Map<string, DgForeignKey>();
  for (const r of fks) {
    const t = tables.get(s(r.t));
    if (!t) continue;
    const k = `${t.name}${s(r.n)}`;
    let fk = fkMap.get(k);
    if (!fk) {
      fk = { constraint: s(r.n), columns: [], refSchema: s(r.rs), refTable: s(r.rt), refColumns: [] };
      fkMap.set(k, fk);
      t.foreignKeys.push(fk);
    }
    fk.columns.push(s(r.c));
    fk.refColumns.push(s(r.rc));
  }
  for (const t of tables.values()) {
    t.dependsOn = [
      ...new Set(t.foreignKeys.filter((f) => f.refSchema.toLowerCase() === db.toLowerCase() && f.refTable.toLowerCase() !== t.name.toLowerCase()).map((f) => f.refTable))
    ];
  }
  const list = [...tables.values()];
  return { database: db, tables: list, order: dependencyOrder(list) };
}

/** Parents before children; tables in cycles keep their alphabetical order at the end. */
export function dependencyOrder(tables: { name: string; dependsOn: string[] }[]): string[] {
  const names = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const done = new Set<string>();
  const out: string[] = [];
  let rest = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  while (rest.length) {
    const ready = rest.filter((t) => t.dependsOn.every((d) => !names.has(d.toLowerCase()) || done.has(d.toLowerCase())));
    const take = ready.length ? ready : [rest[0]];
    for (const t of take) {
      out.push(t.name);
      done.add(t.name.toLowerCase());
    }
    rest = rest.filter((t) => !done.has(t.name.toLowerCase()));
  }
  return out;
}

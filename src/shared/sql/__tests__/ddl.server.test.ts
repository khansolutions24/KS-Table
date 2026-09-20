// Round-trip checks of the DDL generator against the portable test server (127.0.0.1:3307, root / kstable).
// Works in the scratch database ks_t_design (dropped afterwards); skipped when the server is not reachable.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Api } from '@shared/api';
import type { TableDesign } from '@shared/types';
import { newField } from '@shared/defaults';
import { qname, quoteString } from '@shared/sql/quote';
import { bootBackend } from '../../../devserver/harness';
import {
  addForeignKeysSql,
  alterEventSql,
  alterTableSql,
  alterTableSteps,
  asExisting,
  createEventSql,
  createRoutineSql,
  createTableSql,
  createTableSteps,
  createViewSql,
  dropRoutineSql,
  eventDefFromInfo,
  newPartitionDef,
  newPartitionItem,
  parseCreateRoutine,
  parseCreateView,
  parsePartitionClause,
  partitionClauseSql,
  refineDesignFromDdl,
  renameColumnInExpr,
  routineCallScript,
  syncTableSql,
  triggerSql,
  type DdlStepKind,
  type EventDef,
  type RoutineDef
} from '../ddl';

const DB = 'ks_t_design';
const OPTS = { serverType: 'mysql' as const, serverVersion: 80411 };

function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: 3307 });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

let api: Api;
let shutdown: (() => Promise<void>) | null = null;
let connectionId = '';
let sid = '';
let dbSid = '';
let ok = false;

async function exec(sql: string, session = sid): Promise<void> {
  const r = await api.query.execute(session, sql, { noSplit: true, history: false, stopOnError: true });
  const err = r.results.find((x) => x.kind === 'error');
  if (err) throw new Error(`${err.error?.message}\n--- SQL ---\n${sql}`);
}

async function rows(sql: string, session = sid): Promise<Record<string, string | null>[]> {
  const r = await api.query.execute(session, sql, { history: false });
  const rs = r.results.find((x) => x.kind === 'resultset');
  if (!rs) throw new Error(r.results.find((x) => x.kind === 'error')?.error?.message ?? 'no result set');
  return rs.rows!.map((row) => Object.fromEntries(rs.columns!.map((c, i) => [c.name, row[i] as string | null])));
}

async function load(db: string, table: string): Promise<TableDesign> {
  const d = await api.meta.tableDesign(sid, db, table);
  return refineDesignFromDdl(d, await api.meta.ddl(sid, db, 'table', table), 'mysql');
}

function copyTo(d: TableDesign, fromDb: string): TableDesign {
  return { ...d, schema: DB, foreignKeys: d.foreignKeys.map((f) => ({ ...f, refSchema: f.refSchema === fromDb ? DB : f.refSchema })) };
}

function comparable(d: TableDesign) {
  const strip = <T extends { id: string; origName?: string }>(x: T) => {
    const { id: _id, origName: _orig, ...rest } = x;
    return rest;
  };
  return {
    name: d.name,
    fields: d.fields.map(strip),
    primaryKey: d.primaryKey,
    indexes: d.indexes.map(strip).sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: d.foreignKeys.map(strip).sort((a, b) => a.name.localeCompare(b.name)),
    checks: d.checks.map(strip).sort((a, b) => a.name.localeCompare(b.name)),
    triggers: d.triggers.map(strip).sort((a, b) => a.name.localeCompare(b.name)),
    options: { ...d.options, autoIncrement: '' },
    comment: d.comment,
    partition: d.partition
  };
}

/** Applies `mutate` to the loaded design, executes the generated steps and checks the result on the server */
async function change(table: string, mutate: (d: TableDesign) => void, kinds?: DdlStepKind[]) {
  const from = await load(DB, table);
  const to = structuredClone(from);
  mutate(to);
  const steps = alterTableSteps(from, to, { ...OPTS, includeDefiner: true });
  if (kinds) expect(steps.map((s) => s.kind)).toEqual(kinds);
  for (const s of steps) await exec(s.sql);
  const after = await load(DB, to.name);
  // FOLLOWS / PRECEDES is not part of the stored trigger definition (checked through ACTION_ORDER instead);
  // constraints created without a name get the one the server generated
  const taken = (list: { name: string }[]) => new Set(list.map((x) => x.name));
  const checkNames = taken(to.checks);
  const expected: TableDesign = {
    ...to,
    triggers: to.triggers.map((x) => ({ ...x, orderType: '', orderOther: '' })),
    checks: to.checks.map((c) => (c.name ? c : { ...c, name: after.checks.find((a) => !checkNames.has(a.name) && a.expr === c.expr)?.name ?? '' }))
  };
  expect(syncTableSql(expected, after, OPTS), steps.map((s) => s.sql).join(';\n')).toEqual([]);
  expect(alterTableSql(after, asExisting(after), OPTS)).toEqual([]);
  return { from, to, after, steps };
}

beforeAll(async () => {
  ok = await reachable();
  if (!ok) return;
  const b = await bootBackend();
  api = b.api;
  shutdown = b.shutdown;
  connectionId = b.connectionId;
  sid = (await api.session.open(connectionId, null)).sessionId;
  await exec(`DROP DATABASE IF EXISTS ${DB}`);
  await exec(`CREATE DATABASE ${DB}`);
  dbSid = (await api.session.open(connectionId, DB)).sessionId;
}, 60_000);

afterAll(async () => {
  if (!ok) return;
  try {
    await exec(`DROP DATABASE IF EXISTS ${DB}`);
  } finally {
    await api.session.close(dbSid).catch(() => undefined);
    await api.session.close(sid).catch(() => undefined);
    await shutdown?.();
  }
});

describe('DDL against MySQL', () => {
  it('re-creates every sample table identically', async (t) => {
    if (!ok) t.skip();
    for (const db of ['ks_shop', 'ks_hr']) {
      const designs: TableDesign[] = [];
      for (const n of (await api.meta.tables(sid, db)).map((x) => x.name)) designs.push(await load(db, n));
      for (const d of designs) for (const s of createTableSql(copyTo(d, db), { ...OPTS, foreignKeys: false, triggers: false })) await exec(s);
      for (const d of designs) for (const s of addForeignKeysSql(copyTo(d, db))) await exec(s);
      for (const d of designs) for (const tr of d.triggers) await exec(triggerSql(tr, DB, d.name, { includeDefiner: true }));
      for (const d of designs) {
        const expected = copyTo(d, db);
        const again = await load(DB, d.name);
        expect(syncTableSql(expected, again, OPTS), d.name).toEqual([]);
        expect(comparable(again), d.name).toEqual(comparable(expected));
      }
    }
  }, 120_000);

  it('applies a combined column / index / key / check / trigger / option change', async (t) => {
    if (!ok) t.skip();
    await change(
      'products',
      (d) => {
        const f = (n: string) => d.fields.find((x) => x.name === n)!;
        f('vat_rate').name = 'vat';
        const vatCheck = d.checks.find((c) => c.name === 'chk_products_vat')!;
        vatCheck.expr = renameColumnInExpr(vatCheck.expr, 'vat_rate', 'vat');
        f('price_gross').generatedExpr = renameColumnInExpr(f('price_gross').generatedExpr, 'vat_rate', 'vat');
        Object.assign(f('name'), { length: '250', comment: "Artikel's Name" });
        const stock = f('stock');
        d.fields = d.fields.filter((x) => x !== stock);
        d.fields.splice(1, 0, stock);
        d.fields.splice(d.fields.findIndex((x) => x.name === 'sku') + 1, 0, newField({ name: 'ean', type: 'CHAR', length: '13' }));
        d.fields = d.fields.filter((x) => x.name !== 'weight_kg');
        f('status').defaultValue = 'active';
        const idx = { id: 'n', type: 'NORMAL' as const, method: '' as const, comment: '', invisible: false, parser: '', keyBlockSize: '' };
        d.indexes.push({ ...idx, name: 'idx_products_name_price', comment: 'Suche', fields: [{ name: 'name', subPart: '20', order: '' }, { name: 'price', subPart: '', order: 'DESC' }] });
        // expressions are written in the form the server prints them, so the reloaded design compares equal
        d.indexes.push({ ...idx, id: 'm', name: 'idx_products_lower', fields: [{ name: '', subPart: '', order: '', expr: "concat(lower(`name`),_utf8mb4'x\\'y')" }] });
        d.indexes.find((i) => i.name === 'idx_products_supplier')!.name = 'idx_prod_supplier';
        d.indexes.find((i) => i.name === 'uq_products_sku')!.invisible = true;
        d.foreignKeys.find((x) => x.name === 'fk_products_supplier')!.onDelete = 'CASCADE';
        d.checks.push({ id: 'c', name: 'chk_products_stock', expr: '`stock` >= -(100)', enforced: false });
        d.triggers[0].body = 'BEGIN\n  IF NOT (OLD.price <=> NEW.price) THEN\n    SET @ks_last_price = NEW.price;\n  END IF;\nEND';
        d.triggers.push({ id: 't', name: 'trg_products_au2', timing: 'AFTER', event: 'UPDATE', body: 'SET @ks_x = NEW.id', definer: '', orderType: 'FOLLOWS', orderOther: 'trg_products_au' });
        d.comment = "Artikel 'neu'";
        d.options.rowFormat = 'DYNAMIC';
        d.options.statsPersistent = '1';
      },
      ['dropTrigger', 'dropForeignKeys', 'alterTable', 'addForeignKeys', 'createTrigger', 'createTrigger']
    );
    const trg = await rows(`SELECT TRIGGER_NAME, ACTION_ORDER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${DB}' AND EVENT_OBJECT_TABLE = 'products' ORDER BY ACTION_ORDER`);
    expect(trg.map((r) => r.TRIGGER_NAME)).toEqual(['trg_products_au', 'trg_products_au2']);
    // resetting options goes back to the server defaults
    await change('products', (d) => {
      d.options.rowFormat = '';
      d.options.statsPersistent = '';
    });
  }, 60_000);

  it('handles generated kind changes, column attributes and enum values', async (t) => {
    if (!ok) t.skip();
    const { steps } = await change('all_types', (d) => {
      const f = (n: string) => d.fields.find((x) => x.name === n)!;
      f('c_generated').generatedStored = true;
      f('c_invisible').invisible = false;
      Object.assign(f('c_datetime'), { length: '3', notNull: true, defaultKind: 'expression', defaultValue: 'CURRENT_TIMESTAMP(3)', onUpdateCurrentTimestamp: true });
      f('c_enum').values = ['rot', 'grün', 'blau', "gelb's"];
      Object.assign(f('c_tinytext'), { charset: 'latin1', collation: 'latin1_german2_ci' });
      f('c_decimal').unsigned = true;
      Object.assign(f('c_text'), { defaultKind: 'value', defaultValue: "Text mit 'Quote'" });
      d.fields.push(newField({ name: 'c_expr', type: 'VARCHAR', length: '36', defaultKind: 'expression', defaultValue: "concat(_utf8mb4'K',_utf8mb4'S')" }));
      d.fields.push(newField({ name: 'c_blob_empty', type: 'BLOB', length: '', notNull: true, defaultKind: 'empty' }));
    });
    expect(steps[0].sql).toContain('DROP COLUMN `c_generated`');
    await change('all_types', (d) => {
      d.fields.find((x) => x.name === 'c_generated')!.generated = false;
    });
  }, 60_000);

  it('changes the primary key, renames columns and the table', async (t) => {
    if (!ok) t.skip();
    await change('stores', (d) => {
      d.fields.find((x) => x.name === 'city')!.name = 'town';
      d.primaryKey = ['id', 'name'];
    });
    await change('settings_kv', (d) => {
      d.primaryKey = ['k'];
      d.fields[0].notNull = true;
    });
    await change('stores', (d) => {
      d.name = 'stores_renamed';
    });
    await exec(`RENAME TABLE ${qname(DB, 'stores_renamed')} TO ${qname(DB, 'stores')}`);
  }, 60_000);

  it('adds, changes and removes partitioning', async (t) => {
    if (!ok) t.skip();
    await change('settings_kv', (d) => {
      d.partition = partitionClauseSql({ ...newPartitionDef(), method: 'KEY', expr: '`k`', count: '3' });
    }, ['partition']);
    const loaded = parsePartitionClause((await load(DB, 'settings_kv')).partition)!;
    expect(loaded).toMatchObject({ method: 'KEY', count: '3' });
    await change('settings_kv', (d) => {
      d.partition = partitionClauseSql({ ...loaded, count: '2' });
    }, ['partition']);
    await change('settings_kv', (d) => {
      d.partition = '';
    }, ['partition']);

    const def = {
      ...newPartitionDef(),
      method: 'RANGE' as const,
      expr: 'YEAR(`d`)',
      subMethod: 'HASH' as const,
      subExpr: 'TO_DAYS(`d`)',
      subCount: '2',
      partitions: [
        { ...newPartitionItem('p_old'), values: '2000', comment: "bis '99" },
        { ...newPartitionItem('p_mid'), values: '2020' },
        { ...newPartitionItem('p_max'), values: 'MAXVALUE' }
      ]
    };
    const d: TableDesign = {
      ...(await load(DB, 'settings_kv')),
      name: 'part_range',
      origName: undefined,
      primaryKey: [],
      fields: [newField({ name: 'id', type: 'INT', length: '', notNull: true }), newField({ name: 'd', type: 'DATE', length: '', notNull: true })],
      indexes: [],
      partition: partitionClauseSql(def)
    };
    for (const s of createTableSql(d, OPTS)) await exec(s);
    const back = parsePartitionClause((await load(DB, 'part_range')).partition)!;
    expect(back).toMatchObject({ method: 'RANGE', expr: 'year(`d`)', subMethod: 'HASH', subExpr: 'to_days(`d`)', subCount: '2' });
    expect(back.partitions.map((p) => [p.name, p.values, p.comment])).toEqual([
      ['p_old', '2000', "bis '99"],
      ['p_mid', '2020', ''],
      ['p_max', 'MAXVALUE', '']
    ]);
  }, 60_000);

  it('replaces triggers, indexes and checks of an existing table', async (t) => {
    if (!ok) t.skip();
    await change('customers', (d) => {
      d.triggers = [{ id: 'x', name: 'trg_customers_bu', timing: 'BEFORE', event: 'UPDATE', body: 'SET NEW.e_mail = LOWER(NEW.e_mail)', definer: 'root@localhost', orderType: '', orderOther: '' }];
      d.indexes = d.indexes.filter((i) => i.name !== 'idx_customers_city');
      d.indexes.find((i) => i.name === 'idx_customers_name')!.fields.reverse();
      d.checks.push({ id: 'k', name: '', expr: "`country` <> _utf8mb4''", enforced: true });
      d.fields.find((x) => x.name === 'email')!.name = 'e_mail';
      d.indexes.find((i) => i.name === 'uq_customers_email')!.fields[0].name = 'e_mail';
    });
    const after = await load(DB, 'customers');
    expect(after.checks.map((c) => c.name)).toEqual(['customers_chk_1']);
  }, 60_000);

  it('creates a new table with every kind of object in one go', async (t) => {
    if (!ok) t.skip();
    const d: TableDesign = {
      schema: DB,
      name: 'designer_new',
      fields: [
        newField({ name: 'id', type: 'BIGINT', length: '', unsigned: true, notNull: true, autoIncrement: true }),
        newField({ name: 'category_id', type: 'INT', length: '', unsigned: true }),
        newField({ name: 'title', type: 'VARCHAR', length: '120', notNull: true, comment: 'Überschrift' }),
        newField({ name: 'body', type: 'TEXT', length: '' }),
        newField({ name: 'flags', type: 'SET', length: '', values: ['a', 'b,c'.replace(',', ''), "d'e"], defaultKind: 'value', defaultValue: 'a' }),
        newField({ name: 'price', type: 'DECIMAL', length: '8', decimals: '2', defaultKind: 'value', defaultValue: '1.50' }),
        newField({ name: 'gross', type: 'DECIMAL', length: '8', decimals: '2', generated: true, generatedExpr: '(`price` * 1.19)', generatedStored: false }),
        newField({ name: 'created', type: 'TIMESTAMP', length: '', notNull: true, defaultKind: 'expression', defaultValue: 'CURRENT_TIMESTAMP', onUpdateCurrentTimestamp: true }),
        newField({ name: 'pos', type: 'POINT', length: '', notNull: true, srid: '4326' }),
        newField({ name: 'secret', type: 'INT', length: '', invisible: true, defaultKind: 'value', defaultValue: '7' })
      ],
      primaryKey: ['id'],
      indexes: [
        { id: 'a', name: 'uq_title', type: 'UNIQUE', method: 'BTREE', comment: '', invisible: false, parser: '', keyBlockSize: '', fields: [{ name: 'title', subPart: '', order: '' }] },
        { id: 'b', name: 'ft_body', type: 'FULLTEXT', method: '', comment: '', invisible: false, parser: '', keyBlockSize: '', fields: [{ name: 'body', subPart: '', order: '' }] },
        { id: 'c', name: 'sp_pos', type: 'SPATIAL', method: '', comment: '', invisible: false, parser: '', keyBlockSize: '', fields: [{ name: 'pos', subPart: '', order: '' }] },
        { id: 'd', name: 'idx_gross', type: 'NORMAL', method: '', comment: 'virtuell', invisible: true, parser: '', keyBlockSize: '', fields: [{ name: 'gross', subPart: '', order: 'DESC' }] }
      ],
      foreignKeys: [{ id: 'f', name: '', fields: ['category_id'], refSchema: DB, refTable: 'categories', refFields: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' }],
      checks: [{ id: 'k', name: 'chk_designer_price', expr: '`price` >= 0', enforced: true }],
      triggers: [{ id: 't', name: 'trg_designer_bi', timing: 'BEFORE', event: 'INSERT', body: 'SET NEW.title = TRIM(NEW.title)', definer: '', orderType: '', orderOther: '' }],
      options: { ...(await load(DB, 'categories')).options, autoIncrement: '1000', rowFormat: 'DYNAMIC', statsSamplePages: '12' },
      comment: 'Neu aus dem Designer',
      partition: ''
    };
    const steps = createTableSteps(d, OPTS);
    expect(steps.map((s) => s.kind)).toEqual(['createTable', 'createTrigger']);
    for (const s of steps) await exec(s.sql);
    const after = await load(DB, 'designer_new');
    expect(after.foreignKeys[0].name).toBe('designer_new_ibfk_1');
    // InnoDB adds an index for the foreign key column
    const implicit = after.indexes.find((i) => i.name === 'category_id')!;
    expect(implicit.fields.map((p) => p.name)).toEqual(['category_id']);
    const want = { ...d, indexes: [...d.indexes, implicit], foreignKeys: [{ ...d.foreignKeys[0], name: 'designer_new_ibfk_1' }] };
    expect(syncTableSql(want, after, OPTS)).toEqual([]);
  }, 60_000);

  it('creates, parses and replaces views', async (t) => {
    if (!ok) t.skip();
    const def = {
      schema: DB,
      name: 'v_design test',
      definition: "SELECT id, name AS `the name`, 'it''s' AS lit FROM products WHERE price > 0 -- nur aktive\n;",
      algorithm: 'MERGE' as const,
      definer: 'root@localhost',
      security: 'INVOKER' as const,
      checkOption: 'LOCAL' as const,
      columns: []
    };
    await exec(createViewSql(def), dbSid);
    const parsed = parseCreateView(await api.meta.ddl(sid, DB, 'view', def.name))!;
    expect(parsed).toMatchObject({ name: def.name, algorithm: 'MERGE', definer: 'root@localhost', security: 'INVOKER', checkOption: 'LOCAL', columns: [] });
    await exec(createViewSql({ ...parsed, schema: DB, checkOption: 'CASCADED', columns: ['a', 'b c', 'd'] }, { orReplace: true }), dbSid);
    const again = parseCreateView(await api.meta.ddl(sid, DB, 'view', def.name))!;
    expect(again).toMatchObject({ checkOption: 'CASCADED', columns: ['a', 'b c', 'd'] });
    expect(again.definition).toBe(parsed.definition);
    const data = await rows(`SELECT * FROM ${qname(DB, def.name)}`, dbSid);
    expect(data).toEqual([]);
  }, 60_000);

  it('creates, parses, re-creates and executes stored routines', async (t) => {
    if (!ok) t.skip();
    const fn: RoutineDef = {
      schema: DB,
      name: 'fn_design',
      type: 'FUNCTION',
      params: [
        { mode: '', name: 'p a', type: 'VARCHAR(20) CHARSET latin1' },
        { mode: '', name: 'n', type: 'INT' }
      ],
      returns: 'VARCHAR(50) CHARSET utf8mb4',
      body: "RETURN CONCAT(`p a`, '-', n)",
      definer: 'root@localhost',
      security: 'INVOKER',
      dataAccess: 'NO SQL',
      deterministic: true,
      comment: "it's a function"
    };
    await exec(createRoutineSql(fn));
    const parsed = parseCreateRoutine(await api.meta.ddl(sid, DB, 'function', fn.name), 'FUNCTION')!;
    expect(parsed).toEqual({ ...fn, schema: undefined, returns: 'varchar(50) CHARSET utf8mb4' } as unknown as typeof parsed);
    await exec(dropRoutineSql('FUNCTION', DB, fn.name));
    await exec(createRoutineSql({ ...parsed, schema: DB, body: 'RETURN UPPER(`p a`)' }));
    const call = routineCallScript({ ...parsed, schema: DB }, [
      { value: "o'k", isNull: false, raw: false },
      { value: '3', isNull: false, raw: false }
    ]);
    expect((await rows(call[0], dbSid))[0][fn.name]).toBe("O'K");

    const proc: RoutineDef = {
      schema: DB,
      name: 'sp_design',
      type: 'PROCEDURE',
      params: [
        { mode: 'IN', name: 'a', type: 'INT' },
        { mode: 'OUT', name: 'b', type: 'INT' },
        { mode: 'INOUT', name: 'c', type: 'VARCHAR(10)' }
      ],
      returns: '',
      body: "BEGIN\n  SET b = a * 2;\n  SET c = CONCAT(c, '!');\n  SELECT a, b, c;\n  SELECT 'zwei' AS x;\nEND",
      definer: '',
      security: '',
      dataAccess: 'READS SQL DATA',
      deterministic: false,
      comment: ''
    };
    await exec(createRoutineSql(proc));
    const pp = parseCreateRoutine(await api.meta.ddl(sid, DB, 'procedure', proc.name), 'PROCEDURE')!;
    expect(pp).toMatchObject({ params: proc.params, body: proc.body, dataAccess: 'READS SQL DATA', definer: 'root@localhost' });
    const script = routineCallScript(proc, [
      { value: '21', isNull: false, raw: false },
      { value: '', isNull: false, raw: false },
      { value: 'hi', isNull: false, raw: false }
    ]);
    const res = await api.query.execute(dbSid, script.join(';\n'), { history: false, stopOnError: true });
    const sets = res.results.filter((r) => r.kind === 'resultset');
    expect(res.results.some((r) => r.kind === 'error')).toBe(false);
    expect(sets.map((r) => r.rows)).toEqual([[['21', '42', 'hi!']], [['zwei']], [['42', 'hi!']]]);
    expect(sets[2].columns!.map((c) => c.name)).toEqual(['b', 'c']);
  }, 60_000);

  it('creates, alters and reloads events', async (t) => {
    if (!ok) t.skip();
    const ev: EventDef = {
      schema: DB,
      name: 'ev_design',
      scheduleType: 'EVERY',
      at: '',
      atIntervals: [],
      every: { value: '1:30', unit: 'HOUR_MINUTE' },
      starts: '2035-01-01 00:00:00',
      startsIntervals: [{ value: '1', unit: 'DAY' }],
      ends: '2036-01-01 00:00:00',
      endsIntervals: [],
      status: 'DISABLE',
      preserve: true,
      definer: 'root@localhost',
      comment: "it's an event",
      body: "BEGIN\n  DELETE FROM settings_kv WHERE k = 'x';\nEND"
    };
    await exec(createEventSql(ev, OPTS));
    const info = async (name: string) =>
      eventDefFromInfo(
        DB,
        (
          await rows(
            `SELECT EVENT_NAME AS name, EVENT_TYPE AS eventType, EXECUTE_AT AS executeAt, INTERVAL_VALUE AS intervalValue, INTERVAL_FIELD AS intervalField, STARTS AS starts, ENDS AS ends, STATUS AS status, ON_COMPLETION AS onCompletion, DEFINER AS definer, EVENT_COMMENT AS comment, EVENT_DEFINITION AS body FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${quoteString(DB)} AND EVENT_NAME = ${quoteString(name)}`
          )
        )[0] as never
      );
    const loaded = await info('ev_design');
    expect(loaded).toMatchObject({ scheduleType: 'EVERY', every: { value: '1:30', unit: 'HOUR_MINUTE' }, starts: '2035-01-02 00:00:00', ends: '2036-01-01 00:00:00', status: 'DISABLE', preserve: true, comment: "it's an event", body: ev.body });
    const changed: EventDef = { ...loaded, name: 'ev_design2', status: 'DISABLE ON SLAVE', comment: 'neu', body: 'SELECT 1', preserve: false };
    const sql = alterEventSql(loaded, changed, OPTS)!;
    expect(sql).not.toContain('ON SCHEDULE');
    await exec(sql);
    expect(await info('ev_design2')).toMatchObject({ status: 'DISABLE ON SLAVE', comment: 'neu', body: 'SELECT 1', preserve: false, starts: '2035-01-02 00:00:00' });
    const once: EventDef = { ...changed, name: 'ev_design_once', scheduleType: 'AT', at: '2035-05-05 10:00:00', atIntervals: [{ value: '2', unit: 'HOUR' }], status: 'ENABLE', preserve: true };
    await exec(createEventSql(once, OPTS));
    expect(await info('ev_design_once')).toMatchObject({ scheduleType: 'AT', at: '2035-05-05 12:00:00', status: 'ENABLE' });
    await exec(alterEventSql(await info('ev_design_once'), { ...once, at: '2035-06-01 00:00:00', atIntervals: [] }, OPTS)!);
    expect((await info('ev_design_once')).at).toBe('2035-06-01 00:00:00');
  }, 60_000);
});

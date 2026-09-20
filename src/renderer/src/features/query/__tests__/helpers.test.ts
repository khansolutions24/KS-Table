import { describe, expect, it } from 'vitest';
import type { ColumnMeta, ResultColumn } from '@shared/types';
import type { GridColumnDef } from '../../../components/grid/cellFormat';
import { toInsertSql, toTsv, toUpdateSql } from '../copyFormats';
import { resolveEditable, singleTableSource, type EditableInfo } from '../editableResult';
import { accessSeverity, parseExplainJson } from '../explainPlan';
import { buildChanges, emptyEdits, mergeApplyResults, pendingCount } from '../gridEdits';
import { resultNameIn } from '../resultNames';
import { findParams, paramLiteral, paramNames, substituteParams, validateParam } from '../sqlParams';
import { statusDelta, toSnapshot } from '../statusDiff';
import { foldTxState, nextTxState } from '../txState';

describe('query parameters', () => {
  it('finds placeholders outside strings, identifiers and comments', () => {
    const sql =
      "SELECT * FROM t WHERE id = :id AND name = ':nope' AND x = \":no\" AND `a:b` = 1 -- :c\n AND y IN (:list, :id) /* :d */ # :e\n LIMIT :n";
    expect(paramNames(sql)).toEqual(['id', 'list', 'n']);
    expect(findParams(sql).map((p) => p.name)).toEqual(['id', 'list', 'id', 'n']);
  });

  it('ignores assignments, labels and times', () => {
    expect(paramNames('SET @a := 5; SELECT @b:=1')).toEqual([]);
    expect(paramNames('lbl: LOOP LEAVE lbl; END LOOP lbl')).toEqual([]);
    expect(paramNames('lbl:BEGIN END')).toEqual([]);
    expect(paramNames("SELECT '10:30', TIME '10:30'")).toEqual([]);
    expect(paramNames('SELECT a FROM t WHERE b=:v')).toEqual(['v']);
    expect(paramNames('SELECT (:a)+:b')).toEqual(['a', 'b']);
    expect(paramNames("SELECT 'it''s :x', 'a\\':y', :z")).toEqual(['z']);
  });

  it('builds literals', () => {
    expect(paramLiteral({ mode: 'auto', value: '42' })).toBe('42');
    expect(paramLiteral({ mode: 'auto', value: '-3.5' })).toBe('-3.5');
    expect(paramLiteral({ mode: 'auto', value: '007' })).toBe("'007'");
    expect(paramLiteral({ mode: 'auto', value: "O'Brien" })).toBe("'O\\'Brien'");
    expect(paramLiteral({ mode: 'text', value: '42' })).toBe("'42'");
    expect(paramLiteral({ mode: 'number', value: ' 1e3 ' })).toBe('1e3');
    expect(() => paramLiteral({ mode: 'number', value: 'abc' })).toThrow();
    expect(paramLiteral({ mode: 'raw', value: 'NOW()' })).toBe('NOW()');
    expect(paramLiteral({ mode: 'null', value: 'x' })).toBe('NULL');
    expect(validateParam({ mode: 'number', value: 'x' })).toMatch(/Zahl|number/);
    expect(validateParam({ mode: 'raw', value: ' ' })).not.toBeNull();
    expect(validateParam({ mode: 'auto', value: '' })).toBeNull();
  });

  it('substitutes every occurrence', () => {
    const sql = "SELECT * FROM t WHERE a = :a AND b = ':a' AND c = :b OR d = :a LIMIT :n";
    expect(
      substituteParams(sql, { a: { mode: 'auto', value: 'x' }, b: { mode: 'null', value: '' }, n: { mode: 'number', value: '5' } })
    ).toBe("SELECT * FROM t WHERE a = 'x' AND b = ':a' AND c = NULL OR d = 'x' LIMIT 5");
    expect(substituteParams('SELECT :unknown', {})).toBe('SELECT :unknown');
  });
});

describe('transaction state', () => {
  const auto = { autocommit: true, open: false };
  const open = { autocommit: true, open: true };
  const manual = { autocommit: false, open: false };

  it('tracks explicit transactions', () => {
    expect(nextTxState(auto, 'START TRANSACTION', true)).toEqual(open);
    expect(nextTxState(auto, 'begin', true).open).toBe(true);
    expect(nextTxState(auto, 'BEGIN NOT ATOMIC SELECT 1; END', true).open).toBe(false);
    expect(nextTxState(open, 'COMMIT', true).open).toBe(false);
    expect(nextTxState(open, 'ROLLBACK', true).open).toBe(false);
    expect(nextTxState(open, 'ROLLBACK TO SAVEPOINT s1', true).open).toBe(true);
    expect(nextTxState(open, 'COMMIT AND CHAIN', true).open).toBe(true);
    expect(nextTxState(open, 'COMMIT AND NO CHAIN', true).open).toBe(false);
    expect(nextTxState(open, 'CREATE TABLE x (id int)', true).open).toBe(false);
    expect(nextTxState(open, 'CREATE TEMPORARY TABLE x (id int)', true).open).toBe(true);
    expect(nextTxState(open, 'ALTER TABLE x ADD c INT', true).open).toBe(false);
    expect(nextTxState(open, 'UPDATE t SET a = 1', false, 1062).open).toBe(true);
    expect(nextTxState(open, 'UPDATE t SET a = 1', false, 1213).open).toBe(false);
    expect(nextTxState(auto, '/* x */ (SELECT 1)', true)).toEqual(auto);
    expect(
      foldTxState(auto, [
        { sql: 'START TRANSACTION', ok: true },
        { sql: 'INSERT INTO t VALUES (1)', ok: true },
        { sql: 'COMMIT', ok: true }
      ])
    ).toEqual(auto);
  });

  it('follows autocommit assignments', () => {
    expect(nextTxState(auto, 'SET autocommit = 0', true)).toEqual(manual);
    expect(nextTxState(auto, "SET SESSION autocommit = 'OFF'", true)).toEqual(manual);
    expect(nextTxState(auto, 'SET @@autocommit := 0', true).autocommit).toBe(false);
    expect(nextTxState(auto, 'SET @@session.autocommit=0', true).autocommit).toBe(false);
    expect(nextTxState(auto, 'SET names utf8mb4, autocommit = 0', true).autocommit).toBe(false);
    expect(nextTxState(auto, 'SET GLOBAL autocommit = 0', true).autocommit).toBe(true);
    expect(nextTxState(auto, 'SET @@global.autocommit = 0', true).autocommit).toBe(true);
    expect(nextTxState(auto, "SET @x = 'autocommit = 0'", true).autocommit).toBe(true);
    expect(nextTxState(manual, 'SELECT * FROM t', true).open).toBe(true);
    expect(nextTxState(manual, 'SHOW TABLES', true).open).toBe(false);
    expect(nextTxState({ autocommit: false, open: true }, 'SET autocommit = 1', true)).toEqual(auto);
    expect(nextTxState(open, 'SET autocommit = 1', true)).toEqual(open);
  });
});

const rc = (p: Partial<ResultColumn>): ResultColumn => ({
  name: '',
  orgName: '',
  table: '',
  orgTable: '',
  schema: '',
  typeId: 253,
  typeName: 'VARCHAR',
  flags: 0,
  length: 0,
  decimals: 0,
  charsetNr: 33,
  binary: false,
  primaryKey: false,
  notNull: false,
  unsigned: false,
  autoIncrement: false,
  numeric: false,
  ...p
});

const cm = (name: string, key: ColumnMeta['key'] = ''): ColumnMeta => ({
  name,
  position: 1,
  dataType: 'varchar',
  columnType: 'varchar(50)',
  nullable: true,
  defaultValue: null,
  extra: '',
  key,
  charset: null,
  collation: null,
  comment: '',
  maxLength: 50,
  numericPrecision: null,
  numericScale: null,
  datetimePrecision: null,
  generationExpression: ''
});

describe('editable results', () => {
  const custMeta = [cm('id', 'PRI'), cm('email'), cm('first_name')];

  it('detects a single aliased table with its primary key', () => {
    const cols = [
      rc({ name: 'cid', orgName: 'id', table: 'c', orgTable: 'customers', schema: 'ks_shop', primaryKey: true }),
      rc({ name: 'email', orgName: 'email', table: 'c', orgTable: 'customers', schema: 'ks_shop' }),
      rc({ name: 'two' }),
      rc({ name: 'id2', orgName: 'id', table: 'c', orgTable: 'customers', schema: 'ks_shop' })
    ];
    const src = singleTableSource(cols);
    expect(src).toEqual({ schema: 'ks_shop', table: 'customers', alias: 'c' });
    const info = resolveEditable(cols, src!, custMeta);
    expect(info?.columnMap).toEqual(['id', 'email', null, null]);
    expect(info?.key).toEqual([{ name: 'id', index: 0 }]);
  });

  it('rejects joins, unions, views and results without key', () => {
    expect(
      singleTableSource([
        rc({ orgName: 'id', table: 'o', orgTable: 'orders', schema: 'ks_shop' }),
        rc({ orgName: 'id', table: 'c', orgTable: 'customers', schema: 'ks_shop' })
      ])
    ).toBeNull();
    expect(singleTableSource([rc({ name: 'id' })])).toBeNull();
    const viewCols = [rc({ name: 'id', orgName: 'id', table: 'v', orgTable: 'v', schema: 'ks_shop', primaryKey: true })];
    expect(resolveEditable(viewCols, singleTableSource(viewCols)!, [cm('id'), cm('name')])).toBeNull();
    const noKey = [rc({ name: 'email', orgName: 'email', table: 'customers', orgTable: 'customers', schema: 'ks_shop' })];
    expect(resolveEditable(noKey, singleTableSource(noKey)!, custMeta)).toBeNull();
  });

  it('turns edits into row changes and merges the results', () => {
    const info: EditableInfo = { schema: 's', table: 't', columnMap: ['id', 'name', null], key: [{ name: 'id', index: 0 }], meta: [] };
    const rows = [
      ['1', 'a', 'x'],
      ['2', 'b', 'y'],
      ['3', 'c', 'z']
    ];
    const st = { edits: { '0:1': 'A', '2:1': null, '2:2': 'ignored' }, inserted: [{ key: 7, values: { 1: 'new', 2: 'ignored' } }], deleted: [1] };
    expect(pendingCount(st)).toBe(4);
    const { changes, targets } = buildChanges(info, rows, st);
    expect(changes).toEqual([
      { type: 'update', key: { id: '1' }, values: { name: 'A' } },
      { type: 'update', key: { id: '3' }, values: { name: null } },
      { type: 'insert', values: { name: 'new' } },
      { type: 'delete', key: { id: '2' } }
    ]);
    const ok = mergeApplyResults(
      info,
      rows,
      st,
      targets,
      [
        { ok: true, sql: '', affectedRows: 1, row: ['1', 'A'] },
        { ok: true, sql: '', affectedRows: 1, row: ['3', null] },
        { ok: true, sql: '', affectedRows: 1, insertId: '4', row: ['4', 'new'] },
        { ok: true, sql: '', affectedRows: 1 }
      ],
      true,
      'rolled back'
    );
    expect(ok.rows).toEqual([
      ['1', 'A', 'x'],
      ['3', null, 'z'],
      ['4', 'new', null]
    ]);
    expect(pendingCount(ok.state)).toBe(0);
    expect(ok.applied).toBe(4);

    const partial = mergeApplyResults(
      info,
      rows,
      st,
      targets,
      [
        { ok: true, sql: '', affectedRows: 1, row: ['1', 'A'] },
        { ok: false, sql: 'UPDATE …', affectedRows: 0, error: { message: 'boom' } },
        { ok: true, sql: '', affectedRows: 1, row: ['4', 'new'] },
        { ok: true, sql: '', affectedRows: 1 }
      ],
      true,
      'rolled back'
    );
    expect(partial.rows.map((r) => r[0])).toEqual(['1', '3', '4']);
    expect(partial.state.edits).toEqual({ '1:1': null, '1:2': 'ignored' });
    expect(partial.failed.map((f) => f.message)).toEqual(['boom']);

    const rolledBack = mergeApplyResults(info, rows, st, targets, [{ ok: false, sql: '', affectedRows: 0, error: { message: 'dup' } }], false, 'rolled back');
    expect(rolledBack.rows).toBe(rows);
    expect(rolledBack.state).toBe(st);
    expect(rolledBack.failed[0].message).toBe('dup');
    expect(pendingCount(emptyEdits())).toBe(0);
  });
});

describe('explain plan', () => {
  it('parses nested loops with ordering', () => {
    const json = JSON.stringify({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '1481.98' },
        ordering_operation: {
          using_filesort: false,
          nested_loop: [
            {
              table: {
                table_name: 'c',
                access_type: 'index',
                possible_keys: ['PRIMARY'],
                key: 'uq_customers_email',
                used_key_parts: ['email'],
                key_length: '602',
                rows_examined_per_scan: 5,
                rows_produced_per_join: 2000,
                filtered: '100.00',
                using_index: true,
                cost_info: { read_cost: '5.00', eval_cost: '200.00', prefix_cost: '205.00', data_read_per_join: '3M' },
                used_columns: ['id', 'email']
              }
            },
            {
              table: {
                table_name: 'o',
                access_type: 'ref',
                key: 'idx_orders_customer_date',
                ref: ['ks_shop.c.id'],
                rows_examined_per_scan: 3,
                filtered: '50.00',
                cost_info: { read_cost: '502.98', eval_cost: '387.00', prefix_cost: '1481.98' },
                attached_condition: '(`ks_shop`.`o`.`id` > 10)'
              }
            }
          ]
        }
      }
    });
    const plan = parseExplainJson(json);
    expect(plan.totalCost).toBeCloseTo(1481.98);
    expect(plan.root.kind).toBe('block');
    const order = plan.root.children[0];
    expect(order.kind).toBe('operation');
    expect(order.children[0].children.map((c) => c.title)).toEqual(['c', 'o']);
    const [c, o] = plan.tables;
    expect(c.cost).toBeCloseTo(205);
    expect(c.flags.length).toBe(1);
    expect(c.details).toContainEqual(['cost_info.data_read_per_join', '3M']);
    expect(o.ref).toEqual(['ks_shop.c.id']);
    expect(o.condition).toContain('> 10');
    expect(o.filtered).toBe(50);
    expect(accessSeverity('ALL')).toBe('bad');
    expect(accessSeverity('eq_ref')).toBe('good');
  });

  it('parses unions, MariaDB tables and messages', () => {
    const union = JSON.stringify({
      query_block: {
        union_result: {
          using_temporary_table: true,
          table_name: '<union1,3>',
          access_type: 'ALL',
          query_specifications: [
            { dependent: false, cacheable: true, query_block: { select_id: 1, cost_info: { query_cost: '10' }, nested_loop: [{ table: { table_name: 'a' } }, { table: { table_name: 'b' } }] } },
            { dependent: true, cacheable: false, query_block: { select_id: 3, table: { table_name: 'c', access_type: 'const' } } }
          ]
        }
      }
    });
    const plan = parseExplainJson(union);
    expect(plan.totalCost).toBeNull();
    const u = plan.root.children[0];
    expect(u.children.map((c) => c.kind)).toEqual(['block', 'block']);
    expect(u.children[1].flags.length).toBe(2);
    expect(plan.tables.map((t) => t.title)).toEqual(['a', 'b', 'c']);

    const maria = parseExplainJson('{"query_block":{"select_id":1,"table":{"table_name":"t","access_type":"ALL","rows":1000,"filtered":100,"attached_condition":"t.a = 1"}}}');
    expect(maria.tables[0].rowsExamined).toBe(1000);
    const msg = parseExplainJson('{"query_block":{"select_id":1,"message":"No tables used"}}');
    expect(msg.root.children[0]).toMatchObject({ kind: 'message', title: 'No tables used' });
    expect(() => parseExplainJson('not json')).toThrow();
  });
});

describe('status, names and copy formats', () => {
  it('subtracts the cost of the status statement', () => {
    const a = toSnapshot([
      ['Com_select', '10'],
      ['Bytes_sent', '1000'],
      ['Com_show_status', '5'],
      ['Ssl_cipher', '']
    ]);
    expect(a.has('Ssl_cipher')).toBe(false);
    const b = toSnapshot([
      ['Com_select', '10'],
      ['Bytes_sent', '1500'],
      ['Com_show_status', '6']
    ]);
    const c = toSnapshot([
      ['Com_select', '12'],
      ['Bytes_sent', '2600'],
      ['Com_show_status', '7']
    ]);
    expect(statusDelta(a, b, c)).toEqual([
      { name: 'Bytes_sent', delta: 600, after: 2600 },
      { name: 'Com_select', delta: 2, after: 12 },
      { name: 'Com_show_status', delta: 0, after: 7 }
    ]);
  });

  it('reads result names from comments', () => {
    expect(resultNameIn('\n-- name: Kunden\n')).toBe('Kunden');
    expect(resultNameIn('/* name: Umsatz 2024 */')).toBe('Umsatz 2024');
    expect(resultNameIn('# name:x\n-- other\n')).toBe('x');
    expect(resultNameIn('-- nothing')).toBeNull();
    expect(resultNameIn('--name: x')).toBeNull();
  });

  it('copies as TSV, INSERT and UPDATE', () => {
    const columns: GridColumnDef[] = [
      { id: 'c0', title: 'id', kind: 'number', typeLabel: 'INT', numeric: true },
      { id: 'c1', title: 'name', kind: 'text', typeLabel: 'VARCHAR', numeric: false },
      { id: 'c2', title: 'flag', kind: 'bit', typeLabel: 'BIT', numeric: false, bitLength: 1 }
    ];
    const d = {
      columns,
      rows: [
        ['1', "O'Neil\tx", new Uint8Array([1])],
        ['2', null, new Uint8Array([0])]
      ]
    };
    expect(toTsv(d, true)).toBe("id\tname\tflag\n1\tO'Neil x\t1\n2\t\t0");
    expect(toInsertSql('`t`', ['id', 'name', 'flag'], d).split('\n')[1]).toBe("INSERT INTO `t` (`id`, `name`, `flag`) VALUES (2, NULL, b'0');");
    expect(toUpdateSql('`t`', ['id', 'name', 'flag'], d, [0]).split('\n')[0]).toBe("UPDATE `t` SET `name` = 'O\\'Neil\\tx', `flag` = b'1' WHERE `id` = 1;");
  });
});

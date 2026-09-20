import { describe, expect, it } from 'vitest';
import type { ColumnMeta } from '@shared/types';
import { colClass, histogramPlan, medianSql, parseMedian, statsQuery, topValuesSql, valueFilter, type ColStats } from './profileSql';

const col = (name: string, dataType: string): ColumnMeta => ({
  name,
  position: 1,
  dataType,
  columnType: dataType,
  nullable: true,
  defaultValue: null,
  extra: '',
  key: '',
  charset: null,
  collation: null,
  comment: '',
  maxLength: null,
  numericPrecision: null,
  numericScale: null,
  datetimePrecision: null,
  generationExpression: ''
});

const stats = (patch: Partial<ColStats>): ColStats => ({
  nulls: 0,
  distinct: null,
  empty: null,
  zeros: null,
  negatives: null,
  min: null,
  max: null,
  avg: null,
  stddev: null,
  minLen: null,
  maxLen: null,
  avgLen: null,
  ...patch
});

describe('colClass', () => {
  it('maps MySQL data types', () => {
    expect(colClass(col('a', 'int'))).toBe('number');
    expect(colClass(col('a', 'decimal'))).toBe('number');
    expect(colClass(col('a', 'varchar'))).toBe('text');
    expect(colClass(col('a', 'enum'))).toBe('text');
    expect(colClass(col('a', 'datetime'))).toBe('date');
    expect(colClass(col('a', 'time'))).toBe('time');
    expect(colClass(col('a', 'longblob'))).toBe('binary');
    expect(colClass(col('a', 'point'))).toBe('spatial');
    expect(colClass(col('a', 'json'))).toBe('json');
    expect(colClass(col('a', 'bit'))).toBe('bit');
  });
});

describe('statsQuery', () => {
  it('builds one aggregate row and parses it per column', () => {
    const q = statsQuery('shop', 'items', [col('id', 'int'), col('name', 'varchar')], 1000);
    expect(q.sql).toContain('FROM (SELECT `id`, `name` FROM `shop`.`items` LIMIT 1000) AS s');
    expect(q.sql).toContain('COUNT(DISTINCT `id`)');
    expect(q.sql).toContain("SUM(`name` = '')");
    // total | int: nulls distinct min max avg stddev zeros negatives | varchar: nulls distinct empty min max minLen maxLen avgLen
    const r = q.parse(['4', '0', '4', '1', '4', '2.5000', '1.118', '0', '0', '1', '2', '1', 'Anna', 'Zoe', '0', '4', '2.6667']);
    expect(r.total).toBe(4);
    expect(r.stats[0]).toMatchObject({ nulls: 0, distinct: 4, min: '1', max: '4', avg: 2.5, zeros: 0, negatives: 0 });
    expect(r.stats[1]).toMatchObject({ nulls: 1, distinct: 2, empty: 1, min: 'Anna', max: 'Zoe', minLen: 0, maxLen: 4 });
  });

  it('treats NULL sums of an empty table as zero', () => {
    const q = statsQuery('d', 't', [col('n', 'int')], 0);
    expect(q.sql).toContain('FROM `d`.`t` AS s');
    const r = q.parse(['0', null, '0', null, null, null, null, null, null]);
    expect(r.stats[0]).toMatchObject({ nulls: 0, distinct: 0, zeros: 0, negatives: 0, min: null, avg: null });
  });
});

describe('details', () => {
  it('groups text by a prefix for the most frequent values', () => {
    expect(topValuesSql('d', 't', col('c', 'text'), 0)).toBe(
      'SELECT LEFT(`c`, 200) AS __ks_v, COUNT(*) AS __ks_n FROM `d`.`t` AS s GROUP BY __ks_v ORDER BY __ks_n DESC, __ks_v LIMIT 20'
    );
  });

  it('computes the median from the middle row(s)', () => {
    expect(medianSql('d', 't', col('n', 'int'), 0, 4)).toContain('LIMIT 2 OFFSET 1');
    expect(medianSql('d', 't', col('n', 'int'), 0, 5)).toContain('LIMIT 1 OFFSET 2');
    expect(medianSql('d', 't', col('s', 'varchar'), 0, 5)).toBeNull();
    expect(parseMedian(col('n', 'int'), [['2'], ['3']])).toBe('2.5');
    expect(parseMedian(col('d', 'date'), [['2024-05-01']])).toBe('2024-05-01');
  });

  it('builds WHERE conditions for a value', () => {
    expect(valueFilter(col('n', 'int'), '42')).toBe('`n` = 42');
    expect(valueFilter(col('s', 'varchar'), null)).toBe('`s` IS NULL');
    expect(valueFilter(col('s', 'varchar'), "O'Brien")).toBe("`s` = 'O\\'Brien'");
    expect(valueFilter(col('s', 'text'), 'x'.repeat(200))).toMatch(/^LEFT\(`s`, 200\) = /);
  });
});

describe('histogramPlan', () => {
  it('uses one bucket per value for small integer ranges', () => {
    const p = histogramPlan('d', 't', col('n', 'tinyint'), 0, stats({ min: '1', max: '3' }))!;
    expect(p.mode).toBe('value');
    expect(p.parse([['1', '2'], ['3', '5']]).map((b) => b.n)).toEqual([2, 0, 5]);
  });

  it('splits decimal ranges into 20 buckets', () => {
    const p = histogramPlan('d', 't', col('price', 'decimal'), 0, stats({ min: '0', max: '10' }))!;
    expect(p.sql).toContain('GREATEST(0, LEAST(FLOOR((`price` - 0) / 0.5), 19))');
    const b = p.parse([['0', '1'], ['19', '4']]);
    expect(b).toHaveLength(20);
    expect(b[0]).toMatchObject({ n: 1, from: 0, to: 0.5 });
    expect(b[19]).toMatchObject({ n: 4, to: 10 });
  });

  it('uses integer widths for wide integer ranges', () => {
    const p = histogramPlan('d', 't', col('n', 'int'), 0, stats({ min: '1', max: '100' }))!;
    const b = p.parse([]);
    expect(b).toHaveLength(20);
    expect(b[0]).toMatchObject({ from: 1, to: 5 });
    expect(b[19]).toMatchObject({ from: 96, to: 100 });
  });

  it('profiles text lengths', () => {
    const p = histogramPlan('d', 't', col('s', 'varchar'), 0, stats({ minLen: 2, maxLen: 4 }))!;
    expect(p.mode).toBe('length');
    expect(p.sql).toContain('CHAR_LENGTH(`s`) AS __ks_b');
  });

  it('fills gaps in monthly date series', () => {
    const p = histogramPlan('d', 't', col('d', 'date'), 0, stats({ min: '2024-01-05', max: '2024-04-20' }))!;
    expect(p.sql).toContain("DATE_FORMAT(`d`, '%Y-%m')");
    expect(p.parse([['2024-01', '3'], ['2024-04', '1']])).toEqual([
      { label: '2024-01', n: 3 },
      { label: '2024-02', n: 0 },
      { label: '2024-03', n: 0 },
      { label: '2024-04', n: 1 }
    ]);
  });

  it('falls back to existing buckets for zero dates', () => {
    const p = histogramPlan('d', 't', col('d', 'date'), 0, stats({ min: '0000-00-00', max: '2024-04-20' }))!;
    expect(p.parse([['0000', '1'], ['2024', '2']])).toEqual([
      { label: '0000', n: 1 },
      { label: '2024', n: 2 }
    ]);
  });
});

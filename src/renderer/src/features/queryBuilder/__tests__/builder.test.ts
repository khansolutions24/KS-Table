import { describe, expect, it } from 'vitest';
import { addJoin, addTable, emptyState, generateSql, moveField, removeTables, setAggregate, setAlias, toggleColumn, updateField, type QbForeignKey } from '../model';
import { analyzeSelect, buildState, type MetaLookup, type TableMeta } from '../parse';

const t = (name: string, cols: string[], pk = 'id'): TableMeta & { name: string } => ({
  name,
  kind: 'table',
  columns: cols.map((c) => ({ name: c, type: 'int', pk: c === pk }))
});

const META: Record<string, TableMeta & { name: string }> = {
  customers: t('customers', ['id', 'email', 'first_name', 'city']),
  orders: t('orders', ['id', 'customer_id', 'total', 'status', 'order_date']),
  order_items: t('order_items', ['order_id', 'product_id', 'quantity'], 'order_id'),
  products: t('products', ['id', 'name', 'price']),
  order_extra: t('order_extra', ['order_id', 'note'], 'order_id')
};
const lookup: MetaLookup = (_db, name) => META[name] ?? null;
const FKS: QbForeignKey[] = [{ name: 'fk_orders_customer', table: 'orders', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }];

const info = (name: string) => ({ schema: null, name, kind: META[name].kind, columns: META[name].columns });

function roundTrip(sql: string): string {
  const a = analyzeSelect(sql);
  if (!a.ok) throw new Error(a.reason);
  const r = buildState(a.ast, 'ks_shop', lookup);
  if ('error' in r) throw new Error(r.error);
  return generateSql(r.state);
}

describe('query builder SQL generation', () => {
  it('joins via foreign keys, aggregates, criteria, sorting and limits', () => {
    let s = emptyState('ks_shop');
    const r1 = addTable(s, info('customers'), { x: 0, y: 0 }, FKS);
    s = r1.state;
    const r2 = addTable(s, info('orders'), { x: 300, y: 0 }, FKS);
    s = r2.state;
    const c = r1.table;
    const o = r2.table;
    expect(s.joins).toHaveLength(1);
    expect(s.joins[0]).toMatchObject({ type: 'INNER', left: { tableId: c.id, column: 'id' }, right: { tableId: o.id, column: 'customer_id' } });
    s = toggleColumn(s, c.id, 'email', true);
    s = toggleColumn(s, o.id, 'total', true);
    expect(generateSql(s)).toBe('SELECT `customers`.`email`, `orders`.`total`\nFROM `customers`\nINNER JOIN `orders` ON `customers`.`id` = `orders`.`customer_id`');

    const total = s.fields[1].id;
    const email = s.fields[0].id;
    s = setAggregate(s, total, 'SUM');
    expect(s.fields[0].groupBy).toBe(true);
    s = updateField(s, total, { alias: 'revenue', criteria: ['> 100'], sort: 'DESC' });
    s = updateField(s, email, { criteria: ["LIKE 'a%'"] });
    s = { ...s, limit: '10' };
    expect(generateSql(s)).toBe(
      [
        'SELECT `customers`.`email`, SUM(`orders`.`total`) AS `revenue`',
        'FROM `customers`',
        'INNER JOIN `orders` ON `customers`.`id` = `orders`.`customer_id`',
        "WHERE `customers`.`email` LIKE 'a%'",
        'GROUP BY `customers`.`email`',
        'HAVING SUM(`orders`.`total`) > 100',
        'ORDER BY `revenue` DESC',
        'LIMIT 10'
      ].join('\n')
    );
  });

  it('keeps LEFT / RIGHT semantics when the join is emitted from the other side', () => {
    let s = emptyState('ks_shop');
    const o = addTable(s, info('orders'), { x: 0, y: 0 }, [], false);
    s = o.state;
    const c = addTable(s, info('customers'), { x: 0, y: 0 }, [], false);
    s = c.state;
    s = addJoin(s, { tableId: c.table.id, column: 'id' }, { tableId: o.table.id, column: 'customer_id' });
    s = { ...s, joins: s.joins.map((j) => ({ ...j, type: 'LEFT' as const })) };
    expect(generateSql(s)).toBe('SELECT *\nFROM `orders`\nRIGHT JOIN `customers` ON `customers`.`id` = `orders`.`customer_id`');
    s = { ...s, joins: s.joins.map((j) => ({ ...j, type: 'CROSS' as const })) };
    expect(generateSql(s)).toBe('SELECT *\nFROM `orders`\nCROSS JOIN `customers`');
    expect(addJoin(s, { tableId: o.table.id, column: 'customer_id' }, { tableId: c.table.id, column: 'id' }).joins).toHaveLength(1);
    s = removeTables(s, [c.table.id]);
    expect(s.joins).toHaveLength(0);
    expect(generateSql(s)).toBe('SELECT *\nFROM `orders`');
  });

  it('handles OR rows, extra conditions, aliases, duplicates and offsets', () => {
    let s = emptyState('ks_shop');
    const c = addTable(s, info('customers'), { x: 0, y: 0 });
    s = c.state;
    s = toggleColumn(s, c.table.id, 'email', true);
    s = toggleColumn(s, c.table.id, 'city', true);
    s = updateField(s, s.fields[0].id, { criteria: ['= 1', '= 2'] });
    s = updateField(s, s.fields[1].id, { criteria: ["'Köln'"] });
    s = { ...s, where: 'id > 0 OR id IS NULL', offset: '20' };
    expect(generateSql(s)).toBe(
      "SELECT `email`, `city`\nFROM `customers`\nWHERE ((`email` = 1 AND `city` = 'Köln') OR (`email` = 2)) AND (id > 0 OR id IS NULL)\nLIMIT 20, 18446744073709551615"
    );
    const aliased = setAlias(s, c.table.id, 'c');
    expect('state' in aliased).toBe(true);
    if ('state' in aliased) s = aliased.state;
    expect(generateSql({ ...s, where: '', offset: '', limit: '5' })).toBe(
      "SELECT `c`.`email`, `c`.`city`\nFROM `customers` AS `c`\nWHERE (`c`.`email` = 1 AND `c`.`city` = 'Köln') OR (`c`.`email` = 2)\nLIMIT 5"
    );
    const second = addTable(s, info('customers'), { x: 0, y: 0 });
    expect(second.table.alias).toBe('');
    const third = addTable(second.state, info('customers'), { x: 0, y: 0 });
    expect(third.table.alias).toBe('customers_1');
    expect('error' in setAlias(second.state, second.table.id, 'c')).toBe(true);
    s = moveField(s, s.fields[1].id, -1);
    expect(s.fields[0].column).toBe('city');
    s = toggleColumn(s, c.table.id, 'email', false);
    expect(s.fields.find((f) => f.column === 'email')?.visible).toBe(false);
    expect(emptyState('x') && generateSql(emptyState('x'))).toBe('');
  });
});

describe('query builder parser', () => {
  it('loads joins, aggregates, criteria, grouping, sorting and limits', () => {
    expect(
      roundTrip(
        "SELECT c.id, c.email AS mail, COUNT(o.id) AS n FROM customers AS c LEFT JOIN orders o ON o.customer_id = c.id WHERE c.id > 5 AND c.city = 'Berlin' GROUP BY c.id, c.email HAVING COUNT(o.id) >= 2 ORDER BY n DESC, c.id LIMIT 10, 20;"
      )
    ).toBe(
      [
        'SELECT `c`.`id`, `c`.`email` AS `mail`, COUNT(`o`.`id`) AS `n`',
        'FROM `customers` AS `c`',
        'LEFT JOIN `orders` AS `o` ON `c`.`id` = `o`.`customer_id`',
        "WHERE `c`.`id` > 5 AND `c`.`city` = 'Berlin'",
        'GROUP BY `c`.`id`, `c`.`email`',
        'HAVING COUNT(`o`.`id`) >= 2',
        'ORDER BY `n` DESC, `c`.`id`',
        'LIMIT 10, 20'
      ].join('\n')
    );
  });

  it('maps OR conditions to criteria rows', () => {
    expect(roundTrip("SELECT * FROM customers WHERE id = 1 OR city = 'Köln' OR (id = 2 AND city = 'Bonn')")).toBe(
      "SELECT *\nFROM `customers`\nWHERE (`id` = 1) OR (`city` = 'Köln') OR (`id` = 2 AND `city` = 'Bonn')"
    );
  });

  it('converts comma joins, USING and inner ON extras', () => {
    expect(
      roundTrip('SELECT o.id, p.name FROM order_items oi, orders o, products p WHERE oi.order_id = o.id AND oi.product_id = p.id AND p.price > 10')
    ).toBe(
      [
        'SELECT `o`.`id`, `p`.`name`',
        'FROM `order_items` AS `oi`',
        'INNER JOIN `orders` AS `o` ON `oi`.`order_id` = `o`.`id`',
        'INNER JOIN `products` AS `p` ON `oi`.`product_id` = `p`.`id`',
        'WHERE `p`.`price` > 10'
      ].join('\n')
    );
    expect(roundTrip('SELECT oi.quantity FROM order_items oi INNER JOIN order_extra x USING (order_id)')).toBe(
      'SELECT `oi`.`quantity`\nFROM `order_items` AS `oi`\nINNER JOIN `order_extra` AS `x` ON `oi`.`order_id` = `x`.`order_id`'
    );
    expect(roundTrip("SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id AND o.status = 'paid'")).toBe(
      "SELECT *\nFROM `customers` AS `c`\nINNER JOIN `orders` AS `o` ON `c`.`id` = `o`.`customer_id`\nWHERE `o`.`status` = 'paid'"
    );
    expect(roundTrip('SELECT DISTINCT city, COUNT(*) FROM customers GROUP BY city')).toBe('SELECT DISTINCT `city`, COUNT(*)\nFROM `customers`\nGROUP BY `city`');
    expect(roundTrip('SELECT id FROM customers WHERE id BETWEEN 1 AND 5 AND city IN (\'a\', \'b\') AND email IS NOT NULL ORDER BY 1 DESC')).toBe(
      "SELECT `id`\nFROM `customers`\nWHERE `id` BETWEEN 1 AND 5 AND `city` IN ('a', 'b') AND `email` IS NOT NULL\nORDER BY `id` DESC"
    );
  });

  it('rejects what it cannot represent', () => {
    expect(analyzeSelect('SELECT 1 UNION SELECT 2').ok).toBe(false);
    expect(analyzeSelect('WITH x AS (SELECT 1) SELECT * FROM x').ok).toBe(false);
    expect(analyzeSelect('SELECT * FROM (SELECT 1) t').ok).toBe(false);
    expect(analyzeSelect('UPDATE t SET a = 1').ok).toBe(false);
    expect(analyzeSelect('SELECT FROM WHERE').ok).toBe(false);
    const a = analyzeSelect('SELECT * FROM nope');
    expect(a.ok && 'error' in buildState(a.ast, 'ks_shop', lookup)).toBe(true);
    const b = analyzeSelect("SELECT * FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'paid'");
    expect(b.ok && 'error' in buildState(b.ast, 'ks_shop', lookup)).toBe(true);
  });
});

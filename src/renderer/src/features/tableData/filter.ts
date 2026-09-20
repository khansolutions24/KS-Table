// Filter model of the table viewer and its translation into a WHERE clause.

import { tr } from '@shared/i18n';
import { escapeLike, quoteId, quoteString } from '@shared/sql/quote';
import { newId } from '@shared/defaults';
import type { GridColumnDef } from '../../components/grid/cellFormat';

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'contains'
  | 'notContains'
  | 'begins'
  | 'notBegins'
  | 'ends'
  | 'notEnds'
  | 'isNull'
  | 'notNull'
  | 'isEmpty'
  | 'notEmpty'
  | 'between'
  | 'notBetween'
  | 'in'
  | 'notIn'
  | 'like'
  | 'notLike'
  | 'regexp'
  | 'custom';

export interface FilterCond {
  id: string;
  enabled: boolean;
  column: string;
  op: FilterOp;
  value: string;
  value2: string;
  /** How this condition is combined with the previous one */
  join: 'AND' | 'OR';
  /** Negate the condition (NOT …) */
  not?: boolean;
}

export interface FilterModel {
  mode: 'builder' | 'sql';
  conds: FilterCond[];
  sql: string;
  /** Raw ORDER BY in text mode */
  orderSql: string;
}

export const emptyFilter = (): FilterModel => ({ mode: 'builder', conds: [], sql: '', orderSql: '' });

export type Arity = 0 | 1 | 2 | 'list';

export const FILTER_OPS: { op: FilterOp; label: () => string; arity: Arity }[] = [
  { op: 'eq', label: () => tr('ist gleich', 'is equal to'), arity: 1 },
  { op: 'ne', label: () => tr('ist ungleich', 'is not equal to'), arity: 1 },
  { op: 'lt', label: () => tr('ist kleiner als', 'is less than'), arity: 1 },
  { op: 'le', label: () => tr('ist kleiner oder gleich', 'is less than or equal to'), arity: 1 },
  { op: 'gt', label: () => tr('ist größer als', 'is greater than'), arity: 1 },
  { op: 'ge', label: () => tr('ist größer oder gleich', 'is greater than or equal to'), arity: 1 },
  { op: 'contains', label: () => tr('enthält', 'contains'), arity: 1 },
  { op: 'notContains', label: () => tr('enthält nicht', 'does not contain'), arity: 1 },
  { op: 'begins', label: () => tr('beginnt mit', 'begins with'), arity: 1 },
  { op: 'notBegins', label: () => tr('beginnt nicht mit', 'does not begin with'), arity: 1 },
  { op: 'ends', label: () => tr('endet mit', 'ends with'), arity: 1 },
  { op: 'notEnds', label: () => tr('endet nicht mit', 'does not end with'), arity: 1 },
  { op: 'isNull', label: () => tr('ist NULL', 'is null'), arity: 0 },
  { op: 'notNull', label: () => tr('ist nicht NULL', 'is not null'), arity: 0 },
  { op: 'isEmpty', label: () => tr('ist leer', 'is empty'), arity: 0 },
  { op: 'notEmpty', label: () => tr('ist nicht leer', 'is not empty'), arity: 0 },
  { op: 'between', label: () => tr('liegt zwischen', 'is between'), arity: 2 },
  { op: 'notBetween', label: () => tr('liegt nicht zwischen', 'is not between'), arity: 2 },
  { op: 'in', label: () => tr('ist in Liste', 'is in list'), arity: 'list' },
  { op: 'notIn', label: () => tr('ist nicht in Liste', 'is not in list'), arity: 'list' },
  { op: 'like', label: () => tr('entspricht Muster (LIKE)', 'matches pattern (LIKE)'), arity: 1 },
  { op: 'notLike', label: () => tr('entspricht nicht Muster', 'does not match pattern'), arity: 1 },
  { op: 'regexp', label: () => tr('entspricht regulärem Ausdruck', 'matches regular expression'), arity: 1 },
  { op: 'custom', label: () => tr('benutzerdefiniert (SQL)', 'custom (SQL)'), arity: 1 }
];

export function opArity(op: FilterOp): Arity {
  return FILTER_OPS.find((o) => o.op === op)?.arity ?? 1;
}

export function newCond(column: string, op: FilterOp = 'eq', value = ''): FilterCond {
  return { id: newId('fc'), enabled: true, column, op, value, value2: '', join: 'AND' };
}

const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

function lit(v: string, col: GridColumnDef | undefined): string {
  if (col?.numeric && NUMBER_RE.test(v.trim())) return v.trim();
  return quoteString(v);
}

export function condSql(c: FilterCond, columns: GridColumnDef[]): string | null {
  if (!c.enabled || !c.column) return null;
  const col = columns.find((x) => x.id === c.column);
  const q = quoteId(c.column);
  const v = c.value;
  switch (c.op) {
    case 'eq':
      return `${q} = ${lit(v, col)}`;
    case 'ne':
      return `${q} <> ${lit(v, col)}`;
    case 'lt':
      return `${q} < ${lit(v, col)}`;
    case 'le':
      return `${q} <= ${lit(v, col)}`;
    case 'gt':
      return `${q} > ${lit(v, col)}`;
    case 'ge':
      return `${q} >= ${lit(v, col)}`;
    case 'contains':
      return `${q} LIKE ${quoteString(`%${escapeLike(v)}%`)}`;
    case 'notContains':
      return `${q} NOT LIKE ${quoteString(`%${escapeLike(v)}%`)}`;
    case 'begins':
      return `${q} LIKE ${quoteString(`${escapeLike(v)}%`)}`;
    case 'notBegins':
      return `${q} NOT LIKE ${quoteString(`${escapeLike(v)}%`)}`;
    case 'ends':
      return `${q} LIKE ${quoteString(`%${escapeLike(v)}`)}`;
    case 'notEnds':
      return `${q} NOT LIKE ${quoteString(`%${escapeLike(v)}`)}`;
    case 'isNull':
      return `${q} IS NULL`;
    case 'notNull':
      return `${q} IS NOT NULL`;
    case 'isEmpty':
      return `(${q} IS NULL OR ${q} = '')`;
    case 'notEmpty':
      return `(${q} IS NOT NULL AND ${q} <> '')`;
    case 'between':
      return `${q} BETWEEN ${lit(v, col)} AND ${lit(c.value2, col)}`;
    case 'notBetween':
      return `${q} NOT BETWEEN ${lit(v, col)} AND ${lit(c.value2, col)}`;
    case 'in':
    case 'notIn': {
      const items = v
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!items.length) return null;
      return `${q} ${c.op === 'notIn' ? 'NOT IN' : 'IN'} (${items.map((i) => lit(i, col)).join(', ')})`;
    }
    case 'like':
      return `${q} LIKE ${quoteString(v)}`;
    case 'notLike':
      return `${q} NOT LIKE ${quoteString(v)}`;
    case 'regexp':
      return `${q} REGEXP ${quoteString(v)}`;
    case 'custom':
      return v.trim() ? `${q} ${v.trim()}` : null;
  }
}

/** WHERE clause (without the keyword) for a filter model; conditions are combined left to right. */
export function buildWhere(m: FilterModel, columns: GridColumnDef[]): string {
  if (m.mode === 'sql') return m.sql.trim();
  let expr = '';
  for (const c of m.conds) {
    const raw = condSql(c, columns);
    if (!raw) continue;
    const s = c.not ? `NOT (${raw})` : raw;
    expr = expr ? `(${expr}) ${c.join} ${s}` : s;
  }
  return expr;
}

export function filterActive(m: FilterModel): boolean {
  return m.mode === 'sql' ? !!m.sql.trim() : m.conds.some((c) => c.enabled && c.column);
}

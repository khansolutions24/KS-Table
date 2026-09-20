// Visual query builder: state model, editing helpers and SQL generation (no UI dependencies).

import { newId } from '@shared/defaults';
import { qname, quoteId } from '@shared/sql/quote';
import { uniqueName } from '@shared/util';

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'CROSS';
export const JOIN_TYPES: JoinType[] = ['INNER', 'LEFT', 'RIGHT', 'CROSS'];
export const JOIN_OPERATORS = ['=', '<>', '<', '>', '<=', '>='] as const;
export type JoinOperator = (typeof JOIN_OPERATORS)[number];

export type Aggregate = '' | 'COUNT' | 'COUNT DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'GROUP_CONCAT';
export const AGGREGATES: Aggregate[] = ['', 'COUNT', 'COUNT DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT'];

export interface QbColumn {
  name: string;
  type: string;
  pk?: boolean;
}

export interface QbTable {
  id: string;
  /** schema when different from the builder database, else null */
  schema: string | null;
  name: string;
  /** '' = no alias */
  alias: string;
  kind: 'table' | 'view';
  columns: QbColumn[];
  x: number;
  y: number;
}

export interface QbColumnRef {
  tableId: string;
  column: string;
}

export interface QbJoin {
  id: string;
  /** LEFT keeps all rows of `left`, RIGHT all rows of `right` */
  type: JoinType;
  op: JoinOperator;
  left: QbColumnRef;
  right: QbColumnRef;
}

export interface QbField {
  id: string;
  /** plain column reference (column may be '*') */
  tableId?: string;
  column?: string;
  /** SQL expression for fields that are not a plain column reference */
  expr: string;
  alias: string;
  aggregate: Aggregate;
  visible: boolean;
  groupBy: boolean;
  sort: '' | 'ASC' | 'DESC';
  /** ORDER BY position (lower first); null = order of the fields */
  sortOrder: number | null;
  /** [0] = criterion, [1..] = OR criteria */
  criteria: string[];
}

export interface QbState {
  database: string;
  tables: QbTable[];
  joins: QbJoin[];
  fields: QbField[];
  distinct: boolean;
  /** additional WHERE condition (AND-combined with the criteria) */
  where: string;
  /** additional HAVING condition */
  having: string;
  limit: string;
  offset: string;
}

export interface QbForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export function emptyState(database: string): QbState {
  return { database, tables: [], joins: [], fields: [], distinct: false, where: '', having: '', limit: '', offset: '' };
}

export function newField(partial: Partial<QbField> = {}): QbField {
  return { id: newId('f'), expr: '', alias: '', aggregate: '', visible: true, groupBy: false, sort: '', sortOrder: null, criteria: [], ...partial };
}

export const tableLabel = (t: QbTable): string => t.alias || t.name;

// ───────────────────────── editing helpers ─────────────────────────

export function addTable(
  s: QbState,
  info: { schema: string | null; name: string; kind: 'table' | 'view'; columns: QbColumn[] },
  pos: { x: number; y: number },
  fks: QbForeignKey[] = [],
  autoJoin = true
): { state: QbState; table: QbTable } {
  const labels = s.tables.map(tableLabel);
  const alias = labels.some((l) => l.toLowerCase() === info.name.toLowerCase()) ? uniqueName(info.name, labels) : '';
  const t: QbTable = { id: newId('t'), schema: info.schema, name: info.name, alias, kind: info.kind, columns: info.columns, x: pos.x, y: pos.y };
  let next: QbState = { ...s, tables: [...s.tables, t] };
  if (autoJoin) next = { ...next, joins: [...next.joins, ...foreignKeyJoins(next, t, fks)] };
  return { state: next, table: t };
}

/** INNER joins for foreign keys between `t` and the other tables of the builder database. */
export function foreignKeyJoins(s: QbState, t: QbTable, fks: QbForeignKey[]): QbJoin[] {
  if (t.schema) return [];
  const out: QbJoin[] = [];
  for (const o of s.tables) {
    if (o.id === t.id || o.schema || o.name === t.name) continue;
    if (s.joins.some((j) => (j.left.tableId === o.id && j.right.tableId === t.id) || (j.left.tableId === t.id && j.right.tableId === o.id))) continue;
    const fk =
      fks.find((f) => f.table === t.name && f.refTable === o.name) ?? fks.find((f) => f.table === o.name && f.refTable === t.name);
    if (!fk) continue;
    const child = fk.table === t.name ? t : o;
    const parent = child === t ? o : t;
    fk.columns.forEach((col, i) => {
      const refCol = fk.refColumns[i];
      if (!refCol) return;
      out.push({ id: newId('j'), type: 'INNER', op: '=', left: { tableId: parent.id, column: refCol }, right: { tableId: child.id, column: col } });
    });
  }
  return out;
}

export function removeTables(s: QbState, ids: string[]): QbState {
  const gone = new Set(ids);
  return {
    ...s,
    tables: s.tables.filter((t) => !gone.has(t.id)),
    joins: s.joins.filter((j) => !gone.has(j.left.tableId) && !gone.has(j.right.tableId)),
    fields: s.fields.filter((f) => !f.tableId || !gone.has(f.tableId))
  };
}

/** Renames a table alias. Returns an error message when the label is already used. */
export function setAlias(s: QbState, tableId: string, alias: string): { state: QbState } | { error: string } {
  const t = s.tables.find((x) => x.id === tableId);
  if (!t) return { state: s };
  const a = alias.trim() === t.name ? '' : alias.trim();
  const label = (a || t.name).toLowerCase();
  if (s.tables.some((x) => x.id !== tableId && tableLabel(x).toLowerCase() === label)) return { error: a || t.name };
  return { state: { ...s, tables: s.tables.map((x) => (x.id === tableId ? { ...x, alias: a } : x)) } };
}

export function isColumnSelected(s: QbState, tableId: string, column: string): boolean {
  return s.fields.some((f) => f.tableId === tableId && f.column === column && f.visible && !f.aggregate);
}

/** Checkbox of a column in a table node. */
export function toggleColumn(s: QbState, tableId: string, column: string, on: boolean): QbState {
  const idx = s.fields.findIndex((f) => f.tableId === tableId && f.column === column && !f.aggregate);
  if (on) {
    if (idx >= 0) return { ...s, fields: s.fields.map((f, i) => (i === idx ? { ...f, visible: true } : f)) };
    return { ...s, fields: [...s.fields, newField({ tableId, column })] };
  }
  if (idx < 0) return s;
  const f = s.fields[idx];
  const used = f.groupBy || !!f.sort || f.criteria.some((c) => c.trim());
  return { ...s, fields: used ? s.fields.map((x, i) => (i === idx ? { ...x, visible: false } : x)) : s.fields.filter((_, i) => i !== idx) };
}

export function addJoin(s: QbState, left: QbColumnRef, right: QbColumnRef): QbState {
  if (left.tableId === right.tableId) return s;
  const same = (a: QbColumnRef, b: QbColumnRef) => a.tableId === b.tableId && a.column === b.column;
  if (s.joins.some((j) => (same(j.left, left) && same(j.right, right)) || (same(j.left, right) && same(j.right, left)))) return s;
  return { ...s, joins: [...s.joins, { id: newId('j'), type: 'INNER', op: '=', left, right }] };
}

export function updateField(s: QbState, id: string, patch: Partial<QbField>): QbState {
  return { ...s, fields: s.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) };
}

/** Sets an aggregate; the other visible plain fields are grouped automatically when the first aggregate appears. */
export function setAggregate(s: QbState, id: string, aggregate: Aggregate): QbState {
  const hadAggregates = s.fields.some((f) => f.aggregate);
  let fields = s.fields.map((f) => (f.id === id ? { ...f, aggregate, groupBy: aggregate ? false : f.groupBy } : f));
  if (aggregate && !hadAggregates) fields = fields.map((f) => (f.id !== id && f.visible && !f.aggregate && f.column !== '*' ? { ...f, groupBy: true } : f));
  return { ...s, fields };
}

export function moveField(s: QbState, id: string, dir: -1 | 1): QbState {
  const i = s.fields.findIndex((f) => f.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= s.fields.length) return s;
  const fields = s.fields.slice();
  [fields[i], fields[j]] = [fields[j], fields[i]];
  return { ...s, fields };
}

// ───────────────────────── SQL generation ─────────────────────────

const qualify = (s: QbState): boolean => s.tables.length > 1 || s.tables.some((t) => t.alias);

function columnRef(s: QbState, ref: QbColumnRef, forceQualify = false): string {
  const t = s.tables.find((x) => x.id === ref.tableId);
  const col = ref.column === '*' ? '*' : quoteId(ref.column);
  if (!t) return col;
  return forceQualify || qualify(s) ? `${quoteId(tableLabel(t))}.${col}` : col;
}

/** Column / expression of a field without aggregate */
export function fieldExpr(s: QbState, f: QbField): string {
  if (f.tableId && f.column) return columnRef(s, { tableId: f.tableId, column: f.column });
  return f.expr.trim();
}

export function aggregateExpr(agg: Aggregate, expr: string): string {
  if (!agg) return expr;
  if (agg === 'COUNT DISTINCT') return `COUNT(DISTINCT ${expr})`;
  return `${agg}(${expr})`;
}

export const outputExpr = (s: QbState, f: QbField): string => aggregateExpr(f.aggregate, fieldExpr(s, f));

const OPERATOR_RE =
  /^\s*(=|<=>|<>|!=|<=|>=|<|>|NOT\s+LIKE\b|LIKE\b|NOT\s+IN\b|IN\b|IS\b|NOT\s+BETWEEN\b|BETWEEN\b|NOT\s+REGEXP\b|REGEXP\b|NOT\s+RLIKE\b|RLIKE\b|SOUNDS\s+LIKE\b|MEMBER\s+OF\b)/i;

/** `expr` combined with a criterion: operators are kept, plain values get "= ". */
export function criterionSql(expr: string, criterion: string): string {
  const c = criterion.trim();
  if (!c || !expr) return '';
  return OPERATOR_RE.test(c) ? `${expr} ${c}` : `${expr} = ${c}`;
}

function conditionClause(s: QbState, having: boolean): string {
  const fields = s.fields.filter((f) => !!f.aggregate === having);
  const rows = Math.max(0, ...fields.map((f) => f.criteria.length));
  const disjuncts: string[] = [];
  for (let r = 0; r < rows; r++) {
    const parts = fields.map((f) => criterionSql(outputExpr(s, f), f.criteria[r] ?? '')).filter(Boolean);
    if (parts.length) disjuncts.push(parts.join(' AND '));
  }
  let clause = disjuncts.length > 1 ? disjuncts.map((d) => `(${d})`).join(' OR ') : (disjuncts[0] ?? '');
  const extra = (having ? s.having : s.where).trim();
  if (extra) clause = clause ? `${disjuncts.length > 1 ? `(${clause})` : clause} AND (${extra})` : extra;
  return clause;
}

function tableRef(s: QbState, t: QbTable): string {
  const name = t.schema && t.schema !== s.database ? qname(t.schema, t.name) : quoteId(t.name);
  return t.alias ? `${name} AS ${quoteId(t.alias)}` : name;
}

export const joinCondition = (s: QbState, j: QbJoin): string => `${columnRef(s, j.left, true)} ${j.op} ${columnRef(s, j.right, true)}`;

/** FROM clause lines: connected tables through their joins, separate groups with CROSS JOIN. */
export function fromLines(s: QbState): string[] {
  const lines: string[] = [];
  const emitted = new Set<string>();
  for (const start of s.tables) {
    if (emitted.has(start.id)) continue;
    lines.push(`${lines.length ? 'CROSS JOIN' : 'FROM'} ${tableRef(s, start)}`);
    emitted.add(start.id);
    for (;;) {
      let added = false;
      for (const t of s.tables) {
        if (emitted.has(t.id)) continue;
        const links = s.joins.filter(
          (j) => (j.right.tableId === t.id && emitted.has(j.left.tableId)) || (j.left.tableId === t.id && emitted.has(j.right.tableId))
        );
        if (!links.length) continue;
        const first = links[0];
        let type = first.type;
        // stored as "left <type> JOIN right"; when `t` is the stored left side, LEFT and RIGHT swap
        if (first.left.tableId === t.id) type = type === 'LEFT' ? 'RIGHT' : type === 'RIGHT' ? 'LEFT' : type;
        if (type === 'CROSS') lines.push(`CROSS JOIN ${tableRef(s, t)}`);
        else lines.push(`${type} JOIN ${tableRef(s, t)} ON ${links.map((j) => joinCondition(s, j)).join(' AND ')}`);
        emitted.add(t.id);
        added = true;
        break;
      }
      if (!added) break;
    }
  }
  return lines;
}

const DIGITS = /^\d+$/;

export function generateSql(s: QbState): string {
  const visible = s.fields.filter((f) => f.visible && fieldExpr(s, f));
  if (!s.tables.length && !visible.length) return '';
  const items = visible.map((f) => `${outputExpr(s, f)}${f.alias.trim() ? ` AS ${quoteId(f.alias.trim())}` : ''}`);
  if (!items.length) items.push('*');
  const head = `SELECT${s.distinct ? ' DISTINCT' : ''}`;
  const lines: string[] = [];
  if (items.length <= 3 && items.join(', ').length <= 90) lines.push(`${head} ${items.join(', ')}`);
  else {
    lines.push(head);
    items.forEach((it, i) => lines.push(`    ${it}${i < items.length - 1 ? ',' : ''}`));
  }
  lines.push(...fromLines(s));
  const where = conditionClause(s, false);
  if (where) lines.push(`WHERE ${where}`);
  const groups = [...new Set(s.fields.filter((f) => f.groupBy && !f.aggregate && fieldExpr(s, f)).map((f) => fieldExpr(s, f)))];
  if (groups.length) lines.push(`GROUP BY ${groups.join(', ')}`);
  const having = conditionClause(s, true);
  if (having) lines.push(`HAVING ${having}`);
  const sorted = s.fields
    .map((f, i) => ({ f, i }))
    .filter((x) => x.f.sort && fieldExpr(s, x.f))
    .sort((a, b) => (a.f.sortOrder ?? 1e9) - (b.f.sortOrder ?? 1e9) || a.i - b.i);
  if (sorted.length) {
    lines.push(
      `ORDER BY ${sorted
        .map(({ f }) => `${f.visible && f.alias.trim() ? quoteId(f.alias.trim()) : outputExpr(s, f)}${f.sort === 'DESC' ? ' DESC' : ''}`)
        .join(', ')}`
    );
  }
  const limit = s.limit.trim();
  const offset = s.offset.trim();
  if (DIGITS.test(limit)) lines.push(`LIMIT ${DIGITS.test(offset) && offset !== '0' ? `${offset}, ` : ''}${limit}`);
  else if (DIGITS.test(offset) && offset !== '0') lines.push(`LIMIT ${offset}, 18446744073709551615`);
  return lines.join('\n');
}

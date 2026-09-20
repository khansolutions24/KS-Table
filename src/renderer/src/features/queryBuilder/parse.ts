// Parses a simple SELECT statement (node-sql-parser, MySQL dialect) into the builder model.
// Anything the builder cannot represent faithfully is rejected, so the builder starts empty instead.

import * as sqlParser from 'node-sql-parser/build/mysql';
import type { Parser as SqlParser } from 'node-sql-parser/build/mysql';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import {
  emptyState,
  JOIN_OPERATORS,
  newField,
  outputExpr,
  tableLabel,
  type Aggregate,
  type JoinOperator,
  type JoinType,
  type QbColumn,
  type QbColumnRef,
  type QbField,
  type QbState,
  type QbTable
} from './model';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = Record<string, any>;

type ParserCtor = new () => SqlParser;
const mod = sqlParser as unknown as { Parser?: ParserCtor; default?: { Parser?: ParserCtor } };
let parser: SqlParser | null = null;

function getParser(): SqlParser {
  if (!parser) {
    const Ctor = mod.Parser ?? mod.default?.Parser;
    if (!Ctor) throw new Error('node-sql-parser not available');
    parser = new Ctor();
  }
  return parser;
}

const OPT = { database: 'MySQL' };

export interface TableRefInfo {
  db: string | null;
  name: string;
}

export interface TableMeta {
  kind: 'table' | 'view';
  columns: QbColumn[];
}

export type MetaLookup = (db: string | null, name: string) => TableMeta | null;

export type Analysis = { ok: true; ast: N; tables: TableRefInfo[] } | { ok: false; reason: string };

class BuildError extends Error {}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);

/** Step 1: syntax check and the list of referenced tables (to load their metadata). */
export function analyzeSelect(sql: string): Analysis {
  const text = sql.trim().replace(/;\s*$/, '');
  const onlySelect = tr('Nur eine einzelne SELECT-Anweisung kann übernommen werden.', 'Only a single SELECT statement can be loaded.');
  if (!text) return { ok: false, reason: tr('Keine Abfrage vorhanden.', 'There is no query.') };
  let ast: unknown;
  try {
    ast = getParser().astify(text, OPT);
  } catch (e) {
    return { ok: false, reason: tr('Die Abfrage konnte nicht analysiert werden: {m}', 'The query could not be parsed: {m}', { m: firstLine(e) }) };
  }
  const list = Array.isArray(ast) ? ast : [ast];
  if (list.length !== 1) return { ok: false, reason: onlySelect };
  const a = list[0] as N;
  if (!a || a.type !== 'select') return { ok: false, reason: onlySelect };
  if (a.with) return { ok: false, reason: tr('WITH-Ausdrücke (CTE) werden im Abfrage-Generator nicht unterstützt.', 'WITH expressions (CTE) are not supported by the query builder.') };
  if (a._next || a.set_op) return { ok: false, reason: tr('UNION-Abfragen werden im Abfrage-Generator nicht unterstützt.', 'UNION queries are not supported by the query builder.') };
  const tables: TableRefInfo[] = [];
  for (const f of fromList(a)) {
    if (typeof f.table !== 'string' || f.expr) {
      return { ok: false, reason: tr('Unterabfragen in FROM werden im Abfrage-Generator nicht unterstützt.', 'Subqueries in FROM are not supported by the query builder.') };
    }
    tables.push({ db: f.db ?? null, name: f.table });
  }
  return { ok: true, ast: a, tables };
}

function fromList(a: N): N[] {
  const from: N[] = Array.isArray(a.from) ? a.from : a.from ? [a.from] : [];
  return from.filter((f) => f && f.type !== 'dual');
}

const colName = (ref: N): string => (typeof ref.column === 'string' ? ref.column : String(ref.column?.expr?.value ?? ''));

function splitBy(e: N, op: 'AND' | 'OR'): N[] {
  if (e?.type === 'binary_expr' && String(e.operator).toUpperCase() === op) return [...splitBy(e.left, op), ...splitBy(e.right, op)];
  return [e];
}

const SIMPLE_OPS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '<=>', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS', 'IS NOT', 'BETWEEN', 'NOT BETWEEN', 'REGEXP', 'NOT REGEXP', 'RLIKE']);
const AGG_NAMES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT']);
const FLIP: Record<string, JoinOperator> = { '=': '=', '<>': '<>', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };

function joinTypeOf(j: string): JoinType | null {
  const u = j.toUpperCase().replace(/\s+/g, ' ').trim();
  if (u === 'JOIN' || u === 'INNER JOIN' || u === 'STRAIGHT_JOIN') return 'INNER';
  if (u === 'LEFT JOIN' || u === 'LEFT OUTER JOIN') return 'LEFT';
  if (u === 'RIGHT JOIN' || u === 'RIGHT OUTER JOIN') return 'RIGHT';
  if (u === 'CROSS JOIN') return 'CROSS';
  return null;
}

/** Step 2: builds the model; returns an error message for unsupported constructs. */
export function buildState(ast: N, database: string, lookup: MetaLookup): { state: QbState } | { error: string } {
  try {
    return { state: build(ast, database, lookup) };
  } catch (e) {
    if (e instanceof BuildError) return { error: e.message };
    return { error: firstLine(e) };
  }
}

function build(ast: N, database: string, lookup: MetaLookup): QbState {
  const p = getParser();
  const sql = (x: unknown): string => p.exprToSQL(x as never, OPT);
  const unsupported = (what: string) =>
    new BuildError(tr('{w} wird im Abfrage-Generator nicht unterstützt.', '{w} is not supported by the query builder.', { w: what }));

  if (Array.isArray(ast.options) && ast.options.length) throw unsupported(ast.options.map(String).join(' '));
  if (ast.window) throw unsupported('WINDOW');
  if (ast.into?.position) throw unsupported('INTO');
  if (ast.locking_read) throw unsupported('FOR UPDATE / LOCK IN SHARE MODE');

  const s = emptyState(database);
  const from = fromList(ast);

  // ── tables ──
  from.forEach((f, i) => {
    const meta = lookup(f.db ?? null, f.table);
    if (!meta) throw new BuildError(tr('Tabelle „{t}“ wurde nicht gefunden.', 'Table "{t}" was not found.', { t: f.table }));
    const alias = typeof f.as === 'string' && f.as && f.as !== f.table ? f.as : '';
    s.tables.push({
      id: newId('t'),
      schema: f.db && f.db !== database ? f.db : null,
      name: f.table,
      alias,
      kind: meta.kind,
      columns: meta.columns,
      x: 40 + i * 280,
      y: 40 + (i % 2) * 80
    });
  });

  const canonical = (t: QbTable, col: string): string => t.columns.find((c) => c.name.toLowerCase() === col.toLowerCase())?.name ?? col;
  const hasColumn = (t: QbTable, col: string) => t.columns.some((c) => c.name.toLowerCase() === col.toLowerCase());

  const resolve = (ref: N): QbColumnRef | null => {
    const col = colName(ref);
    if (!col) return null;
    if (ref.table) {
      const q = String(ref.table).toLowerCase();
      const t = s.tables.find((x) => tableLabel(x).toLowerCase() === q) ?? s.tables.find((x) => x.name.toLowerCase() === q);
      return t ? { tableId: t.id, column: col === '*' ? '*' : canonical(t, col) } : null;
    }
    if (col === '*') return null;
    const t = s.tables.find((x) => hasColumn(x, col)) ?? (s.tables.length === 1 ? s.tables[0] : undefined);
    return t ? { tableId: t.id, column: canonical(t, col) } : null;
  };

  const extraWhere: string[] = [];

  // ── explicit joins ──
  from.forEach((f, i) => {
    if (i === 0 || !f.join) return;
    const t = s.tables[i];
    let type = joinTypeOf(String(f.join));
    if (!type) throw unsupported(String(f.join));
    if (type === 'CROSS' && f.on) type = 'INNER';
    const prev = s.tables.slice(0, i);
    const prevIds = new Set(prev.map((x) => x.id));
    let count = 0;
    if (Array.isArray(f.using)) {
      for (const u of f.using) {
        const name = typeof u === 'string' ? u : String(u?.value ?? u?.column ?? '');
        const partner = [...prev].reverse().find((x) => hasColumn(x, name)) ?? prev[prev.length - 1];
        s.joins.push({ id: newId('j'), type, op: '=', left: { tableId: partner.id, column: canonical(partner, name) }, right: { tableId: t.id, column: canonical(t, name) } });
        count++;
      }
    } else if (f.on) {
      for (const term of splitBy(f.on, 'AND')) {
        const op = String(term?.operator ?? '').toUpperCase().replace('!=', '<>');
        let joined = false;
        if (term?.type === 'binary_expr' && (JOIN_OPERATORS as readonly string[]).includes(op) && term.left?.type === 'column_ref' && term.right?.type === 'column_ref') {
          const a = resolve(term.left);
          const b = resolve(term.right);
          if (a && b && a.column !== '*' && b.column !== '*') {
            if (a.tableId === t.id && prevIds.has(b.tableId)) {
              s.joins.push({ id: newId('j'), type, op: FLIP[op], left: b, right: a });
              joined = true;
            } else if (b.tableId === t.id && prevIds.has(a.tableId)) {
              s.joins.push({ id: newId('j'), type, op: op as JoinOperator, left: a, right: b });
              joined = true;
            }
          }
        }
        if (joined) count++;
        else if (type === 'INNER') extraWhere.push(sql(term));
        else
          throw new BuildError(
            tr(
              'Die ON-Bedingung der Verknüpfung mit „{t}“ enthält Ausdrücke, die der Abfrage-Generator nicht darstellen kann.',
              'The ON condition of the join with "{t}" contains expressions the query builder cannot represent.',
              { t: tableLabel(t) }
            )
          );
      }
    }
    if (!count && (type === 'LEFT' || type === 'RIGHT')) {
      throw new BuildError(tr('Äußere Verknüpfung ohne Spaltenbedingung mit „{t}“.', 'Outer join without a column condition with "{t}".', { t: tableLabel(t) }));
    }
  });

  // ── output columns ──
  const cols: N[] = ast.columns === '*' ? [{ expr: { type: 'column_ref', table: null, column: '*' }, as: null }] : (ast.columns ?? []);
  for (const c of cols) {
    const e: N = c.expr ?? c;
    const alias = typeof c.as === 'string' ? c.as : c.as?.value !== undefined ? String(c.as.value) : '';
    if (e?.type === 'column_ref') {
      if (colName(e) === '*' && !e.table) {
        s.fields.push(newField({ expr: '*', alias }));
        continue;
      }
      const r = resolve(e);
      if (r) {
        s.fields.push(newField({ ...r, alias }));
        continue;
      }
    }
    if (e?.type === 'aggr_func') {
      const f = aggregateField(e, alias);
      if (f) {
        s.fields.push(f);
        continue;
      }
    }
    s.fields.push(newField({ expr: sql(e), alias }));
  }

  function aggregateField(e: N, alias: string): QbField | null {
    const name = String(e.name).toUpperCase();
    const args = e.args ?? {};
    if (!AGG_NAMES.has(name) || e.over || (args.orderby && args.orderby.length) || args.separator) return null;
    const distinct = !!args.distinct;
    const arg: N = args.expr;
    if (arg?.type === 'star' || (arg?.type === 'column_ref' && colName(arg) === '*' && !arg.table)) {
      return name === 'COUNT' && !distinct ? newField({ expr: '*', aggregate: 'COUNT', alias }) : null;
    }
    const agg: Aggregate | null = distinct ? (name === 'COUNT' ? 'COUNT DISTINCT' : null) : (name as Aggregate);
    if (!agg) return null;
    if (arg?.type === 'column_ref') {
      const r = resolve(arg);
      if (r && r.column !== '*') return newField({ ...r, aggregate: agg, alias });
    }
    return newField({ expr: sql(arg), aggregate: agg, alias });
  }

  const findOrAddField = (ref: QbColumnRef, free: (f: QbField) => boolean): QbField => {
    const same = s.fields.filter((f) => f.tableId === ref.tableId && f.column === ref.column && !f.aggregate);
    const hit = same.find((f) => f.visible && free(f)) ?? same.find(free);
    if (hit) return hit;
    const f = newField({ ...ref, visible: false });
    s.fields.push(f);
    return f;
  };

  const simpleCriterion = (term: N): { ref: QbColumnRef; criterion: string } | null => {
    if (term?.type !== 'binary_expr') return null;
    const op = String(term.operator).toUpperCase();
    if (!SIMPLE_OPS.has(op) || term.left?.type !== 'column_ref') return null;
    const ref = resolve(term.left);
    if (!ref || ref.column === '*') return null;
    const right: N = term.right;
    if (right?.ast) return null;
    let rhs: string;
    if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
      const v = right?.value;
      if (!Array.isArray(v) || v.length !== 2) return null;
      rhs = `${sql(v[0])} AND ${sql(v[1])}`;
    } else if (op === 'IN' || op === 'NOT IN') {
      if (right?.type !== 'expr_list' || !Array.isArray(right.value)) return null;
      rhs = `(${right.value.map(sql).join(', ')})`;
    } else rhs = sql(right);
    return { ref, criterion: `${op === '!=' ? '<>' : op} ${rhs}` };
  };

  const addCriterion = (c: { ref: QbColumnRef; criterion: string }, row: number) => {
    const f = findOrAddField(c.ref, (x) => !(x.criteria[row] ?? '').trim());
    while (f.criteria.length <= row) f.criteria.push('');
    f.criteria[row] = c.criterion;
  };

  // comma separated tables: `a.x = b.y` in WHERE becomes an INNER join
  const commaJoined = new Set(from.map((f, i) => (i > 0 && !f.join ? s.tables[i].id : '')).filter(Boolean));
  const implicitJoin = (term: N): boolean => {
    if (term?.type !== 'binary_expr' || term.operator !== '=' || term.left?.type !== 'column_ref' || term.right?.type !== 'column_ref') return false;
    const a = resolve(term.left);
    const b = resolve(term.right);
    if (!a || !b || a.tableId === b.tableId || a.column === '*' || b.column === '*') return false;
    const ia = s.tables.findIndex((t) => t.id === a.tableId);
    const ib = s.tables.findIndex((t) => t.id === b.tableId);
    const [first, later] = ia < ib ? [a, b] : [b, a];
    if (!commaJoined.has(later.tableId)) return false;
    s.joins.push({ id: newId('j'), type: 'INNER', op: '=', left: first, right: later });
    return true;
  };

  // ── WHERE ──
  if (ast.where) {
    const where: N = ast.where;
    if (where.type === 'binary_expr' && String(where.operator).toUpperCase() === 'OR') {
      const rows = splitBy(where, 'OR').map((d) => splitBy(d, 'AND').map(simpleCriterion));
      if (rows.length <= 8 && rows.every((r) => r.every((c) => c))) rows.forEach((r, i) => r.forEach((c) => addCriterion(c!, i)));
      else extraWhere.push(sql(where));
    } else {
      for (const term of splitBy(where, 'AND')) {
        if (implicitJoin(term)) continue;
        const c = simpleCriterion(term);
        if (c) addCriterion(c, 0);
        else extraWhere.push(sql(term));
      }
    }
  }
  s.where = extraWhere.length > 1 ? extraWhere.map((w) => `(${w})`).join(' AND ') : (extraWhere[0] ?? '');

  const visibleFields = () => s.fields.filter((f) => f.visible);

  // ── GROUP BY ──
  const gb: N[] = Array.isArray(ast.groupby) ? ast.groupby : Array.isArray(ast.groupby?.columns) ? ast.groupby.columns : [];
  if (Array.isArray(ast.groupby?.modifiers) && ast.groupby.modifiers.some((m: unknown) => m)) throw unsupported('WITH ROLLUP');
  for (const g of gb) {
    let target: QbField | undefined;
    if (g?.type === 'number') target = visibleFields()[Number(g.value) - 1];
    else if (g?.type === 'column_ref' && !g.table) target = s.fields.find((f) => f.alias && f.alias.toLowerCase() === colName(g).toLowerCase() && !f.aggregate);
    if (!target && g?.type === 'column_ref') {
      const r = resolve(g);
      if (r && r.column !== '*') target = findOrAddField(r, () => true);
    }
    if (!target) {
      target = newField({ expr: sql(g), visible: false });
      s.fields.push(target);
    }
    target.groupBy = true;
  }

  // ── HAVING ──
  if (ast.having) s.having = Array.isArray(ast.having) ? ast.having.map(sql).join(' AND ') : sql(ast.having);

  // ── ORDER BY ──
  (ast.orderby ?? []).forEach((o: N, idx: number) => {
    const e: N = o.expr;
    let target: QbField | undefined;
    if (e?.type === 'number') target = visibleFields()[Number(e.value) - 1];
    else if (e?.type === 'column_ref' && !e.table) target = s.fields.find((f) => f.alias && f.alias.toLowerCase() === colName(e).toLowerCase());
    if (!target && e?.type === 'column_ref') {
      const r = resolve(e);
      if (r && r.column !== '*') target = findOrAddField(r, (f) => !f.sort);
    }
    if (!target) {
      const text = sql(e);
      target = s.fields.find((f) => !f.sort && outputExpr(s, f) === text);
      if (!target) {
        target = newField({ expr: text, visible: false });
        s.fields.push(target);
      }
    }
    target.sort = String(o.type ?? '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    target.sortOrder = idx;
  });

  // ── LIMIT ──
  const lv: N[] = Array.isArray(ast.limit?.value) ? ast.limit.value : [];
  if (lv.length) {
    const nums = lv.map((v) => (v?.type === 'number' ? String(v.value) : null));
    if (nums.some((x) => x === null)) throw unsupported('LIMIT');
    if (lv.length === 1) s.limit = nums[0]!;
    else if (String(ast.limit.seperator).toLowerCase() === 'offset') {
      s.limit = nums[0]!;
      s.offset = nums[1]!;
    } else {
      s.offset = nums[0]!;
      s.limit = nums[1]!;
    }
  }

  s.distinct = ast.distinct === 'DISTINCT' || ast.distinct?.type === 'DISTINCT';
  return s;
}

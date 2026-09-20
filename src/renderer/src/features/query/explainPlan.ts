// EXPLAIN FORMAT=JSON → plan tree (MySQL 5.7 / 8.x and MariaDB structures).

import { tr } from '@shared/i18n';

export interface PlanNode {
  id: string;
  kind: 'block' | 'operation' | 'table' | 'message';
  title: string;
  table?: string;
  accessType?: string;
  key?: string;
  possibleKeys?: string[];
  usedKeyParts?: string[];
  keyLength?: string;
  ref?: string[];
  rowsExamined?: number;
  rowsProduced?: number;
  filtered?: number;
  /** read + eval cost of a table access */
  cost?: number;
  prefixCost?: number;
  /** query_cost of a query block */
  queryCost?: number;
  condition?: string;
  flags: string[];
  /** flattened scalar properties for the detail view */
  details: [string, string][];
  children: PlanNode[];
}

export interface ExplainPlan {
  root: PlanNode;
  totalCost: number | null;
  tables: PlanNode[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const strList = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
};

const OPERATIONS: Record<string, () => string> = {
  nested_loop: () => tr('Verschachtelte Schleife (Join)', 'Nested loop (join)'),
  ordering_operation: () => tr('Sortierung', 'Ordering'),
  grouping_operation: () => tr('Gruppierung', 'Grouping'),
  duplicates_removal: () => tr('Duplikate entfernen', 'Duplicates removal'),
  windowing: () => tr('Fensterfunktionen', 'Window functions'),
  buffer_result: () => tr('Ergebnis puffern', 'Buffer result'),
  union_result: () => tr('UNION-Ergebnis', 'UNION result'),
  materialized_from_subquery: () => tr('Materialisierte Unterabfrage', 'Materialized subquery'),
  attached_subqueries: () => tr('Angehängte Unterabfragen', 'Attached subqueries'),
  optimized_away_subqueries: () => tr('Wegoptimierte Unterabfragen', 'Optimized away subqueries'),
  select_list_subqueries: () => tr('Unterabfragen der Auswahlliste', 'Select list subqueries'),
  having_subqueries: () => tr('Unterabfragen in HAVING', 'HAVING subqueries'),
  order_by_subqueries: () => tr('Unterabfragen in ORDER BY', 'ORDER BY subqueries'),
  group_by_subqueries: () => tr('Unterabfragen in GROUP BY', 'GROUP BY subqueries'),
  update_value_subqueries: () => tr('Unterabfragen in SET', 'SET subqueries'),
  filesort: () => tr('Sortierung (Filesort)', 'Filesort'),
  temporary_table: () => tr('Temporäre Tabelle', 'Temporary table'),
  'block-nl-join': () => tr('Block-Nested-Loop-Join', 'Block nested loop join'),
  read_sorted_file: () => tr('Sortierte Datei lesen', 'Read sorted file'),
  expression_cache: () => tr('Ausdrucks-Cache', 'Expression cache'),
  subqueries: () => tr('Unterabfragen', 'Subqueries')
};

const STRUCT_KEYS = new Set(['query_block', 'table', 'query_specifications', 'message', ...Object.keys(OPERATIONS)]);

function isStructural(v: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(v)) return v.some((x) => isStructural(x, depth + 1));
  if (!isObj(v)) return false;
  return Object.entries(v).some(([k, x]) => (STRUCT_KEYS.has(k) && (isObj(x) || Array.isArray(x) || k === 'message')) || isStructural(x, depth + 1));
}

function scalars(obj: Obj, prefix = '', out: [string, string][] = []): [string, string][] {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (isObj(v)) {
      if (!isStructural(v) && !STRUCT_KEYS.has(k)) scalars(v, `${prefix}${k}.`, out);
    } else if (Array.isArray(v)) {
      if (v.every((x) => !isObj(x) && !Array.isArray(x))) out.push([prefix + k, v.map(String).join(', ')]);
    } else if (!(k === 'message' && !prefix)) {
      out.push([prefix + k, String(v)]);
    }
  }
  return out;
}

const humanize = (k: string): string => k.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

function opFlags(v: Obj): string[] {
  const f: string[] = [];
  if (v.using_filesort === true) f.push('Filesort');
  if (v.using_temporary_table === true) f.push(tr('Temporäre Tabelle', 'Temporary table'));
  if (v.dependent === true) f.push(tr('abhängig', 'dependent'));
  if (v.cacheable === false) f.push(tr('nicht zwischenspeicherbar', 'not cacheable'));
  return f;
}

/** Parses the JSON document returned by EXPLAIN FORMAT=JSON. Throws on invalid JSON. */
export function parseExplainJson(text: string): ExplainPlan {
  const data: unknown = JSON.parse(text);
  let seq = 0;
  const tables: PlanNode[] = [];
  const node = (kind: PlanNode['kind'], title: string): PlanNode => ({ id: `p${++seq}`, kind, title, flags: [], details: [], children: [] });

  const block = (v: Obj): PlanNode => {
    const id = num(v.select_id);
    const n = node('block', id !== undefined ? tr('Abfrageblock #{n}', 'Query block #{n}', { n: id }) : tr('Abfrageblock', 'Query block'));
    const ci = isObj(v.cost_info) ? v.cost_info : undefined;
    n.queryCost = num(ci?.query_cost) ?? num(v.cost);
    n.details = scalars(v);
    n.flags = opFlags(v);
    walkInto(v, n);
    return n;
  };

  const table = (v: Obj): PlanNode => {
    const n = node('table', String(v.table_name ?? v.name ?? '?'));
    n.table = String(v.table_name ?? v.name ?? '');
    n.accessType = typeof v.access_type === 'string' ? v.access_type : undefined;
    n.key = typeof v.key === 'string' ? v.key : undefined;
    n.possibleKeys = strList(v.possible_keys);
    n.usedKeyParts = strList(v.used_key_parts);
    n.keyLength = v.key_length !== undefined ? String(v.key_length) : undefined;
    n.ref = strList(v.ref);
    n.rowsExamined = num(v.rows_examined_per_scan) ?? num(v.rows);
    n.rowsProduced = num(v.rows_produced_per_join);
    n.filtered = num(v.filtered);
    const ci = isObj(v.cost_info) ? v.cost_info : undefined;
    const read = num(ci?.read_cost);
    const ev = num(ci?.eval_cost);
    n.cost = read !== undefined || ev !== undefined ? (read ?? 0) + (ev ?? 0) : num(v.cost);
    n.prefixCost = num(ci?.prefix_cost);
    n.condition = typeof v.attached_condition === 'string' ? v.attached_condition : undefined;
    if (v.using_index === true) n.flags.push(tr('Nur Index (abdeckend)', 'Covering index'));
    if (typeof v.index_condition === 'string') n.flags.push(tr('Index-Bedingung (ICP)', 'Index condition (ICP)'));
    if (v.using_join_buffer) n.flags.push(`${tr('Join-Puffer', 'Join buffer')}${typeof v.using_join_buffer === 'string' ? ` (${v.using_join_buffer})` : ''}`);
    if (v.using_MRR === true) n.flags.push('MRR');
    if (v.loosescan === true) n.flags.push('LooseScan');
    if (v.firstmatch) n.flags.push('FirstMatch');
    if (v.distinct === true) n.flags.push('Distinct');
    if (v.not_exists === true) n.flags.push('Not exists');
    n.flags.push(...opFlags(v));
    n.details = scalars(v);
    walkInto(v, n);
    tables.push(n);
    return n;
  };

  function walkInto(obj: Obj, parent: PlanNode): void {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'query_block' && isObj(v)) parent.children.push(block(v));
      else if (k === 'table' && isObj(v)) parent.children.push(table(v));
      else if (k === 'message' && typeof v === 'string') parent.children.push(node('message', v));
      else if (k === 'query_specifications' && Array.isArray(v)) {
        for (const item of v) {
          if (!isObj(item)) continue;
          const before = parent.children.length;
          walkInto(item, parent);
          const flags = opFlags(item);
          for (const c of parent.children.slice(before)) c.flags.push(...flags);
        }
      } else if (k in OPERATIONS || ((isObj(v) || Array.isArray(v)) && isStructural(v))) {
        const op = node('operation', OPERATIONS[k]?.() ?? humanize(k));
        if (isObj(v)) {
          op.details = scalars(v);
          op.flags = opFlags(v);
          walkInto(v, op);
        } else if (Array.isArray(v)) {
          for (const item of v) if (isObj(item)) walkInto(item, op);
        } else if (v !== null && v !== undefined) {
          op.details = [[k, String(v)]];
        }
        parent.children.push(op);
      }
    }
  }

  let root: PlanNode;
  if (isObj(data) && isObj(data.query_block)) root = block(data.query_block);
  else if (isObj(data)) {
    root = node('block', tr('Abfrage', 'Query'));
    root.details = scalars(data);
    walkInto(data, root);
  } else throw new Error(tr('Unerwartetes EXPLAIN-Format', 'Unexpected EXPLAIN format'));
  return { root, totalCost: root.queryCost ?? null, tables };
}

/** Access types that read (almost) everything */
export function accessSeverity(type: string | undefined): 'bad' | 'warn' | 'good' | 'neutral' {
  switch ((type ?? '').toLowerCase()) {
    case 'all':
      return 'bad';
    case 'index':
    case 'index_merge':
    case 'fulltext':
      return 'warn';
    case 'range':
    case 'ref':
    case 'ref_or_null':
    case 'eq_ref':
    case 'const':
    case 'system':
    case 'unique_subquery':
    case 'index_subquery':
      return 'good';
    default:
      return 'neutral';
  }
}

// Find in database: text search in table data or in object definitions.
// Runs as task on its own session; hits are collected per task and fetched by the renderer (findHits).

import type { FindHit, FindObjectHit, FindOptions, FindProgress, FindRowHit } from '@shared/apis/admin';
import { tr } from '@shared/i18n';
import { escapeLike, hexLiteral, qname, quoteId, quoteString } from '@shared/sql/quote';
import type { BackendContext } from '../../api';
import type { Session } from '../../db/sessions';
import { KsError, toSqlError } from '../../errors';
import type { TaskContext } from '../../tasks';
import { str } from './monitor';

interface Store {
  hits: FindHit[];
  done: boolean;
  truncated: boolean;
}

const MAX_HITS = 50_000;
const stores = new Map<string, Store>();

const TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set', 'json']);
const NUM_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real']);
const TIME_TYPES = new Set(['date', 'datetime', 'timestamp', 'time', 'year']);
const BIN_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);

type Row = Record<string, unknown>;

function typeSelected(dataType: string, o: FindOptions): boolean {
  const t = dataType.toLowerCase();
  if (TEXT_TYPES.has(t)) return o.columnTypes.text;
  if (NUM_TYPES.has(t)) return o.columnTypes.numeric;
  if (TIME_TYPES.has(t)) return o.columnTypes.temporal;
  if (BIN_TYPES.has(t)) return o.columnTypes.binary;
  return false;
}

export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

/** SQL condition matching one column (works for every column type via CONVERT … USING utf8mb4) */
export function sqlCondition(o: Pick<FindOptions, 'text' | 'mode' | 'caseSensitive'>, column: string, modernRegex: boolean): string {
  const x = `CONVERT(${quoteId(column)} USING utf8mb4)`;
  const ci = !o.caseSensitive;
  const like = (pattern: string) =>
    ci
      ? `LOWER(${x}) COLLATE utf8mb4_bin LIKE LOWER(${quoteString(pattern)}) COLLATE utf8mb4_bin`
      : `${x} COLLATE utf8mb4_bin LIKE ${quoteString(pattern)}`;
  switch (o.mode) {
    case 'contains':
      return like(`%${escapeLike(o.text)}%`);
    case 'prefix':
      return like(`${escapeLike(o.text)}%`);
    case 'exact':
      return ci
        ? `LOWER(${x}) COLLATE utf8mb4_bin = LOWER(${quoteString(o.text)}) COLLATE utf8mb4_bin`
        : `${x} COLLATE utf8mb4_bin = ${quoteString(o.text)}`;
    default: {
      const word = escapeRegex(o.text);
      const pattern = o.mode === 'word' ? (modernRegex ? `\\b${word}\\b` : `[[:<:]]${word}[[:>:]]`) : o.text;
      if (!modernRegex) return ci ? `${x} REGEXP ${quoteString(pattern)}` : `CAST(${x} AS BINARY) REGEXP ${quoteString(pattern)}`;
      return `${x} COLLATE utf8mb4_bin REGEXP ${quoteString(ci ? `(?i)${pattern}` : pattern)}`;
    }
  }
}

type Match = { index: number; length: number } | null;

/** JavaScript matcher for excerpts and the structure search; throws on an invalid regular expression */
export function jsMatcher(o: Pick<FindOptions, 'text' | 'mode' | 'caseSensitive'>): (text: string) => Match {
  const flags = o.caseSensitive ? 'u' : 'iu';
  const t = escapeRegex(o.text);
  let re: RegExp;
  switch (o.mode) {
    case 'regex':
      re = new RegExp(o.text, flags);
      break;
    case 'word':
      re = new RegExp(`(?<![\\p{L}\\p{N}_])${t}(?![\\p{L}\\p{N}_])`, flags);
      break;
    case 'prefix':
      re = new RegExp(`^${t}`, flags);
      break;
    case 'exact':
      re = new RegExp(`^${t}$`, flags);
      break;
    default:
      re = new RegExp(t, flags);
  }
  return (text) => {
    const m = re.exec(text);
    return m ? { index: m.index, length: m[0].length } : null;
  };
}

export function excerpt(text: string, m: Match, width = 60): string {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  if (!m) return flat(text.slice(0, width * 2)) + (text.length > width * 2 ? '…' : '');
  const start = Math.max(0, m.index - width);
  const end = Math.min(text.length, m.index + m.length + width);
  return (start > 0 ? '…' : '') + flat(text.slice(start, end)) + (end < text.length ? '…' : '');
}

function literalOf(v: unknown): string {
  if (v instanceof Uint8Array) return hexLiteral(v);
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return quoteString(str(v));
}

function displayOf(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex').toUpperCase()}`;
  return str(v);
}

interface TableWork {
  db: string;
  table: string;
  view: boolean;
  cols: string[];
  pk: string[];
}

async function searchData(ctx: BackendContext, s: Session, o: FindOptions, t: TaskContext, push: (h: FindHit) => void) {
  const modern = s.server.type === 'mariadb' || s.server.versionNumber >= 80004;
  const cond = (c: string) => sqlCondition(o, c, modern);
  let js: (text: string) => Match;
  try {
    js = jsMatcher(o);
  } catch {
    js = () => null;
  }
  if (o.mode === 'regex') {
    try {
      await s.rows(`SELECT 1 FROM (SELECT 'x' AS c) AS t WHERE ${cond('c')}`);
    } catch (e) {
      throw new KsError(tr('Ungültiger regulärer Ausdruck: {m}', 'Invalid regular expression: {m}', { m: toSqlError(e).message }));
    }
  }
  const onAbort = () => void ctx.sessions.killQuery(s).catch(() => undefined);
  t.signal.addEventListener('abort', onAbort);
  try {
    const work: TableWork[] = [];
    for (const db of o.databases) {
      t.throwIfCancelled();
      const tabs = await s.rows<Row>('SELECT TABLE_NAME AS n, TABLE_TYPE AS k FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [db]);
      const cols = await s.rows<Row>(
        'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
        [db]
      );
      const byTable = new Map<string, { name: string; type: string; key: string }[]>();
      for (const c of cols) {
        const list = byTable.get(str(c.t)) ?? [];
        list.push({ name: str(c.c), type: str(c.d), key: str(c.k) });
        byTable.set(str(c.t), list);
      }
      const only = o.tables?.[db];
      for (const tb of tabs) {
        const name = str(tb.n);
        const view = str(tb.k) !== 'BASE TABLE';
        if (view && !o.includeViews) continue;
        if (only && !only.includes(name)) continue;
        const list = byTable.get(name) ?? [];
        work.push({
          db,
          table: name,
          view,
          cols: list.filter((c) => typeSelected(c.type, o)).map((c) => c.name),
          pk: view ? [] : list.filter((c) => c.key === 'PRI').map((c) => c.name)
        });
      }
    }
    t.log('info', tr('Durchsuche {n} Tabellen …', 'Searching {n} tables …', { n: work.length }));
    const max = Math.max(1, Math.min(100_000, Math.floor(o.maxHitsPerTable) || 100));
    let done = 0;
    let rowsFound = 0;
    let tablesFound = 0;
    for (const w of work) {
      t.throwIfCancelled();
      t.progress(work.length ? done / work.length : null, `${w.db}.${w.table}`);
      done++;
      if (!w.cols.length) continue;
      const conds = w.cols.map(cond);
      const select = [
        ...w.pk.map((p) => quoteId(p)),
        ...conds.map((c, i) => `(${c}) AS ${quoteId(`__m${i}`)}`),
        ...w.cols.map((c, i) => `IF(${conds[i]}, LEFT(CONVERT(${quoteId(c)} USING utf8mb4), 4000), NULL) AS ${quoteId(`__v${i}`)}`)
      ];
      const sql = `SELECT ${select.join(', ')} FROM ${qname(w.db, w.table)} WHERE ${conds.map((c) => `(${c})`).join(' OR ')} LIMIT ${max + 1}`;
      let rows: unknown[][];
      try {
        rows = (await s.rowset(sql)).rows;
      } catch (e) {
        t.throwIfCancelled();
        t.log('warn', tr('{t} übersprungen: {m}', '{t} skipped: {m}', { t: `${w.db}.${w.table}`, m: toSqlError(e).message }));
        continue;
      }
      if (!rows.length) continue;
      const capped = rows.length > max;
      const list = capped ? rows.slice(0, max) : rows;
      const matched = new Set<string>();
      const hits: FindRowHit[] = list.map((row) => {
        const pkVals = row.slice(0, w.pk.length);
        const flags = row.slice(w.pk.length, w.pk.length + w.cols.length);
        const vals = row.slice(w.pk.length + w.cols.length);
        const matches: FindRowHit['matches'] = [];
        w.cols.forEach((c, i) => {
          if (str(flags[i]) !== '1') return;
          matched.add(c);
          const v = str(vals[i]);
          matches.push({ column: c, excerpt: excerpt(v, js(v)) });
        });
        const key = w.pk.map((p, i) => `${p} = ${displayOf(pkVals[i])}`).join(', ');
        const where = w.pk.length
          ? w.pk.map((p, i) => `${quoteId(p)} ${pkVals[i] === null || pkVals[i] === undefined ? 'IS NULL' : `= ${literalOf(pkVals[i])}`}`).join(' AND ')
          : cond(matches[0]?.column ?? w.cols[0]);
        return { kind: 'row', database: w.db, table: w.table, view: w.view, matches, key, where };
      });
      const cols = w.cols.filter((c) => matched.has(c));
      push({ kind: 'table', database: w.db, table: w.table, view: w.view, count: list.length, capped, where: cols.map((c) => `(${cond(c)})`).join(' OR '), columns: cols });
      for (const h of hits) push(h);
      rowsFound += list.length;
      tablesFound++;
      t.log('info', tr('{t}: {n} Treffer', '{t}: {n} hits', { t: `${w.db}.${w.table}`, n: capped ? `${list.length}+` : list.length }));
    }
    t.progress(1, '');
    t.log('success', tr('{n} Treffer in {t} Tabellen', '{n} hits in {t} tables', { n: rowsFound, t: tablesFound }));
    return { hits: rowsFound, tables: tablesFound };
  } finally {
    t.signal.removeEventListener('abort', onAbort);
  }
}

async function searchStructure(s: Session, o: FindOptions, t: TaskContext, push: (h: FindHit) => void) {
  let match: (text: string) => Match;
  try {
    match = jsMatcher(o);
  } catch (e) {
    throw new KsError(tr('Ungültiger regulärer Ausdruck: {m}', 'Invalid regular expression: {m}', { m: e instanceof Error ? e.message : String(e) }));
  }
  const types = new Set(o.objectTypes);
  let count = 0;
  for (let i = 0; i < o.databases.length; i++) {
    const db = o.databases[i];
    t.throwIfCancelled();
    t.progress(i / o.databases.length, db);
    const check = (objectType: FindObjectHit['objectType'], name: string, table: string, field: FindObjectHit['field'], value: string) => {
      if (!value) return;
      if (field === 'name' ? !o.searchNames : field === 'definition' ? !o.searchDefinitions : !o.searchComments) return;
      const m = match(value);
      if (!m) return;
      push({ kind: 'object', database: db, objectType, name, table, field, excerpt: excerpt(value, m) });
      count++;
    };
    const q = (sql: string) => s.rows<Row>(sql, [db]);
    if (types.has('table')) {
      for (const r of await q("SELECT TABLE_NAME AS n, TABLE_COMMENT AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME")) {
        check('table', str(r.n), '', 'name', str(r.n));
        check('table', str(r.n), '', 'comment', str(r.c));
      }
    }
    if (types.has('column')) {
      for (const r of await q(
        'SELECT TABLE_NAME AS t, COLUMN_NAME AS n, COLUMN_COMMENT AS c, GENERATION_EXPRESSION AS g FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION'
      )) {
        check('column', str(r.n), str(r.t), 'name', str(r.n));
        check('column', str(r.n), str(r.t), 'definition', str(r.g));
        check('column', str(r.n), str(r.t), 'comment', str(r.c));
      }
    }
    if (types.has('index')) {
      for (const r of await q(
        'SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS n, INDEX_COMMENT AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME'
      )) {
        check('index', str(r.n), str(r.t), 'name', str(r.n));
        check('index', str(r.n), str(r.t), 'comment', str(r.c));
      }
    }
    if (types.has('view')) {
      for (const r of await q('SELECT TABLE_NAME AS n, VIEW_DEFINITION AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME')) {
        check('view', str(r.n), '', 'name', str(r.n));
        check('view', str(r.n), '', 'definition', str(r.d));
      }
    }
    if (types.has('function') || types.has('procedure')) {
      for (const r of await q(
        'SELECT ROUTINE_NAME AS n, ROUTINE_TYPE AS k, ROUTINE_DEFINITION AS d, ROUTINE_COMMENT AS c FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME'
      )) {
        const kind = str(r.k) === 'FUNCTION' ? 'function' : 'procedure';
        if (!types.has(kind)) continue;
        check(kind, str(r.n), '', 'name', str(r.n));
        check(kind, str(r.n), '', 'definition', str(r.d));
        check(kind, str(r.n), '', 'comment', str(r.c));
      }
    }
    if (types.has('trigger')) {
      for (const r of await q(
        'SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t, ACTION_STATEMENT AS d FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME'
      )) {
        check('trigger', str(r.n), str(r.t), 'name', str(r.n));
        check('trigger', str(r.n), str(r.t), 'definition', str(r.d));
      }
    }
    if (types.has('event')) {
      for (const r of await q(
        'SELECT EVENT_NAME AS n, EVENT_DEFINITION AS d, EVENT_COMMENT AS c FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME'
      )) {
        check('event', str(r.n), '', 'name', str(r.n));
        check('event', str(r.n), '', 'definition', str(r.d));
        check('event', str(r.n), '', 'comment', str(r.c));
      }
    }
  }
  t.progress(1, '');
  t.log('success', tr('{n} Fundstellen', '{n} matches', { n: count }));
  return { hits: count };
}

export function startFind(ctx: BackendContext, o: FindOptions): string {
  if (!o.text) throw new KsError(tr('Bitte einen Suchbegriff eingeben.', 'Please enter a search text.'));
  if (!o.databases.length) throw new KsError(tr('Bitte mindestens eine Datenbank auswählen.', 'Please select at least one database.'));
  const store: Store = { hits: [], done: false, truncated: false };
  const push = (h: FindHit) => {
    if (store.hits.length >= MAX_HITS) {
      store.truncated = true;
      return;
    }
    store.hits.push(h);
  };
  const title = tr('Suche in Datenbank: „{t}“', 'Find in database: "{t}"', { t: o.text.length > 40 ? `${o.text.slice(0, 40)}…` : o.text });
  const taskId = ctx.tasks.start('findInDb', title, async (t) => {
    try {
      const s = await ctx.sessions.open(o.connectionId, null);
      try {
        return o.target === 'data' ? await searchData(ctx, s, o, t, push) : await searchStructure(s, o, t, push);
      } finally {
        await ctx.sessions.close(s.id);
      }
    } finally {
      if (store.truncated) t.log('warn', tr('Trefferlimit von {n} erreicht – weitere Treffer wurden verworfen.', 'Hit limit of {n} reached – further hits were dropped.', { n: MAX_HITS }));
      store.done = true;
    }
  });
  stores.set(taskId, store);
  return taskId;
}

export function findHits(taskId: string, from: number): FindProgress {
  const st = stores.get(taskId);
  if (!st) return { hits: [], next: from, done: true, truncated: false };
  const hits = st.hits.slice(from, from + 5000);
  const next = from + hits.length;
  return { hits, next, done: st.done && next >= st.hits.length, truncated: st.truncated };
}

export function disposeFind(ctx: BackendContext, taskId: string): void {
  ctx.tasks.cancel(taskId);
  stores.delete(taskId);
}

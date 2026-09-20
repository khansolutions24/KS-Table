// State of a table viewer: session, paging, sorting, filtering, pending edits, apply / transactions.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellValue, ColumnMeta, EditValue, ResultColumn, RowChange, SortSpec } from '@shared/types';
import { tr } from '@shared/i18n';
import { api, errorMessage } from '../../api/client';
import { columnFromMeta, columnFromResult, type GridColumnDef } from '../../components/grid/cellFormat';
import { errorDialog } from '../../components/ui/Dialog';
import { getSettings } from '../../store/settings';
import { isUserCancelled, openSessionWithPrompt, useWorkspace } from '../../store/workspace';
import { buildWhere, type FilterModel } from './filter';

export interface PendingRow {
  kind: 'modified' | 'inserted' | 'deleted';
  /** Values as loaded from the server (null for new rows) */
  original: CellValue[] | null;
  /** Changed cells: data column index → new value */
  values: Map<number, EditValue>;
  error?: string;
}

export interface FkRef {
  name: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
}

export interface TableDataParams {
  connectionId: string;
  database: string;
  table: string;
  view: boolean;
  where?: string;
}

export interface LoadInfo {
  columns: ResultColumn[];
  meta: ColumnMeta[];
  keyColumns: string[];
  keyKind: 'primary' | 'unique' | 'none';
  sql: string;
  durationMs: number;
}

export interface ViewPrefs {
  limitOn: boolean;
  pageSize: number;
  hidden: string[];
  order: string[];
  freeze: number;
  showTypes: boolean;
}

export const isEditObject = (v: EditValue): v is { expr: string } | { default: true } =>
  v !== null && typeof v === 'object' && !(v instanceof Uint8Array);

function sameValue(a: CellValue, b: EditValue): boolean {
  if (isEditObject(b)) return false;
  if (a === null || b === null) return a === b;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
}

const prefsKey = (p: TableDataParams) => `ks.tv:${p.connectionId}:${p.database}:${p.table}`;

function loadPrefs(p: TableDataParams): ViewPrefs {
  const g = getSettings().grid;
  const base: ViewPrefs = { limitOn: g.limitRecords, pageSize: g.recordsPerPage, hidden: [], order: [], freeze: 0, showTypes: false };
  try {
    const raw = localStorage.getItem(prefsKey(p));
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<ViewPrefs>) } : base;
  } catch {
    return base;
  }
}

export function useTableData(p: TableDataParams, initialFilter: FilterModel) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<'connecting' | 'loading' | 'ready' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<LoadInfo | null>(null);
  const [fks, setFks] = useState<Map<string, FkRef>>(new Map());
  const rowsRef = useRef<CellValue[][]>([]);
  const pendingRef = useRef<Map<number, PendingRow>>(new Map());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [page, setPage] = useState(0);
  const [prefs, setPrefsState] = useState<ViewPrefs>(() => loadPrefs(p));
  const [total, setTotal] = useState<number | null>(null);
  const [totalApprox, setTotalApprox] = useState(false);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [filter, setFilter] = useState<FilterModel>(initialFilter);
  const [inTx, setInTx] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const loadSeq = useRef(0);
  const gridColsRef = useRef<GridColumnDef[]>([]);

  const setPrefs = useCallback(
    (patch: Partial<ViewPrefs>) =>
      setPrefsState((cur) => {
        const next = { ...cur, ...patch };
        try {
          localStorage.setItem(prefsKey(p), JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      }),
    [p]
  );

  // dedicated session
  useEffect(() => {
    let alive = true;
    let sid: string | null = null;
    setStatus('connecting');
    (async () => {
      try {
        const s = await openSessionWithPrompt(p.connectionId, p.database);
        if (!alive) {
          void api.session.close(s.sessionId);
          return;
        }
        sid = s.sessionId;
        setSessionId(sid);
      } catch (e) {
        if (!alive) return;
        setStatus('error');
        setError(isUserCancelled(e) ? tr('Anmeldung abgebrochen', 'Sign in cancelled') : errorMessage(e));
      }
    })();
    return () => {
      alive = false;
      if (sid) void api.session.close(sid);
    };
  }, [p.connectionId, p.database]);

  const whereOf = useCallback((f: FilterModel) => buildWhere(f, gridColsRef.current), []);

  const countRows = useCallback(
    async (sid: string, where: string) => {
      const g = getSettings().grid;
      if (!where && g.countMode === 'estimate') {
        const t = useWorkspace.getState().conns[p.connectionId]?.dbs[p.database]?.tables.find((x) => x.name === p.table);
        if (t?.rows !== null && t?.rows !== undefined) {
          setTotal(t.rows);
          setTotalApprox(true);
          return;
        }
      }
      setTotal(null);
      try {
        const n = await api.data.count(sid, p.database, p.table, where || undefined);
        setTotal(n);
        setTotalApprox(false);
      } catch {
        setTotal(null);
      }
    },
    [p.connectionId, p.database, p.table]
  );

  const load = useCallback(
    async (pageArg: number, sortArg: SortSpec[], filterArg: FilterModel, prefsArg: ViewPrefs, recount = true) => {
      if (!sessionId) return;
      const seq = ++loadSeq.current;
      setStatus('loading');
      const where = whereOf(filterArg);
      const limit = prefsArg.limitOn ? Math.max(1, prefsArg.pageSize) : null;
      try {
        const res = await api.data.fetch(sessionId, {
          schema: p.database,
          table: p.table,
          where: where || undefined,
          orderBy: sortArg,
          orderSql: filterArg.mode === 'sql' ? filterArg.orderSql : undefined,
          offset: limit ? pageArg * limit : 0,
          limit
        });
        if (seq !== loadSeq.current) return;
        rowsRef.current = res.rows;
        pendingRef.current = new Map();
        setInfo({ columns: res.columns, meta: res.meta, keyColumns: res.keyColumns, keyKind: res.keyKind, sql: res.sql, durationMs: res.durationMs });
        setPage(pageArg);
        setStatus('ready');
        setError(null);
        bump();
        if (recount) void countRows(sessionId, where);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        setStatus('error');
        setError(errorMessage(e));
      }
    },
    [sessionId, p.database, p.table, whereOf, countRows, bump]
  );

  // first load
  useEffect(() => {
    if (sessionId) void load(0, sort, filter, prefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // foreign keys (base tables only)
  useEffect(() => {
    if (!sessionId || p.view) return;
    let alive = true;
    api.meta
      .tableDesign(sessionId, p.database, p.table)
      .then((d) => {
        if (!alive) return;
        const m = new Map<string, FkRef>();
        for (const fk of d.foreignKeys) {
          fk.fields.forEach((f, i) => m.set(f, { name: fk.name, refSchema: fk.refSchema || p.database, refTable: fk.refTable, refColumn: fk.refFields[i] }));
        }
        setFks(m);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionId, p.database, p.table, p.view]);

  const columns: GridColumnDef[] = useMemo(() => {
    if (!info) return [];
    const byName = new Map(info.meta.map((m) => [m.name, m]));
    return info.columns.map((c) => {
      const m = byName.get(c.orgName || c.name);
      const base = m ? columnFromMeta(m) : columnFromResult(c);
      return {
        ...base,
        id: c.name,
        title: c.name,
        foreignKey: fks.has(c.name),
        primaryKey: info.keyKind === 'primary' && info.keyColumns.includes(c.name)
      };
    });
  }, [info, fks]);
  gridColsRef.current = columns;

  const metaOf = useCallback((col: number): ColumnMeta | undefined => {
    const c = info?.columns[col];
    return c ? info?.meta.find((m) => m.name === (c.orgName || c.name)) : undefined;
  }, [info]);

  // ───────────── edit buffer ─────────────

  const getValue = useCallback(
    (row: number, col: number): CellValue => {
      const pend = pendingRef.current.get(row);
      if (pend && pend.values.has(col)) {
        const v = pend.values.get(col)!;
        if (isEditObject(v)) return 'expr' in v ? v.expr : tr('(Standard)', '(Default)');
        return v;
      }
      return rowsRef.current[row]?.[col] ?? null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const rowState = useCallback(
    (row: number): 'inserted' | 'deleted' | undefined => {
      const k = pendingRef.current.get(row)?.kind;
      return k === 'inserted' || k === 'deleted' ? k : undefined;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const cellModified = useCallback(
    (row: number, col: number) => !!pendingRef.current.get(row)?.values.has(col),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const edit = useCallback(
    (row: number, col: number, value: EditValue) => {
      const rows = rowsRef.current;
      if (row < 0 || row >= rows.length) return;
      let pend = pendingRef.current.get(row);
      if (pend?.kind === 'deleted') return;
      if (!pend) {
        pend = { kind: 'modified', original: rows[row].slice(), values: new Map() };
        pendingRef.current.set(row, pend);
      }
      const v: EditValue = rawMode && typeof value === 'string' ? { expr: value } : value;
      if (pend.kind === 'modified' && pend.original && sameValue(pend.original[col], v)) pend.values.delete(col);
      else pend.values.set(col, v);
      pend.error = undefined;
      if (pend.kind === 'modified' && pend.values.size === 0) pendingRef.current.delete(row);
      bump();
    },
    [rawMode, bump]
  );

  const addRow = useCallback((template?: CellValue[]): number => {
    const n = rowsRef.current.length;
    const width = info?.columns.length ?? 0;
    rowsRef.current = [...rowsRef.current, new Array<CellValue>(width).fill(null)];
    const values = new Map<number, EditValue>();
    if (template) {
      template.forEach((v, i) => {
        const m = info?.meta.find((x) => x.name === (info.columns[i].orgName || info.columns[i].name));
        const auto = m?.extra.toLowerCase().includes('auto_increment') || !!m?.generationExpression;
        if (!auto && v !== null) values.set(i, v);
      });
    }
    pendingRef.current.set(n, { kind: 'inserted', original: null, values });
    bump();
    return n;
  }, [info, bump]);

  const removeRows = useCallback((indices: number[]) => {
    if (!indices.length) return;
    const drop = new Set(indices);
    const rows: CellValue[][] = [];
    const pending = new Map<number, PendingRow>();
    rowsRef.current.forEach((r, i) => {
      if (drop.has(i)) return;
      const pend = pendingRef.current.get(i);
      if (pend) pending.set(rows.length, pend);
      rows.push(r);
    });
    rowsRef.current = rows;
    pendingRef.current = pending;
  }, []);

  const markDeleted = useCallback(
    (indices: number[]) => {
      const remove: number[] = [];
      for (const r of indices) {
        const pend = pendingRef.current.get(r);
        if (pend?.kind === 'inserted') remove.push(r);
        else if (rowsRef.current[r]) {
          pendingRef.current.set(r, { kind: 'deleted', original: (pend?.original ?? rowsRef.current[r]).slice(), values: new Map() });
        }
      }
      removeRows(remove);
      bump();
    },
    [removeRows, bump]
  );

  const discard = useCallback(
    (indices?: number[]) => {
      const targets = indices ?? [...pendingRef.current.keys()];
      const inserted = targets.filter((r) => pendingRef.current.get(r)?.kind === 'inserted');
      for (const r of targets) if (pendingRef.current.get(r)?.kind !== 'inserted') pendingRef.current.delete(r);
      removeRows(inserted);
      bump();
    },
    [removeRows, bump]
  );

  const pendingCount = useMemo(
    () => pendingRef.current.size,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const rowError = useCallback(
    (row: number) => pendingRef.current.get(row)?.error,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const apply = useCallback(
    async (indices?: number[]): Promise<boolean> => {
      if (!sessionId || !info) return true;
      const entries = [...pendingRef.current.entries()].filter(([r]) => !indices || indices.includes(r)).sort((a, b) => a[0] - b[0]);
      if (!entries.length) return true;
      const names = info.columns.map((c) => c.name);
      const keyCols = info.keyColumns.length ? info.keyColumns : names;
      const keyOf = (orig: CellValue[]) => {
        const o: Record<string, CellValue> = {};
        for (const k of keyCols) {
          const i = names.indexOf(k);
          if (i >= 0) o[k] = orig[i];
        }
        return o;
      };
      const valuesOf = (pend: PendingRow) => {
        const o: Record<string, EditValue> = {};
        for (const [ci, v] of pend.values) o[names[ci]] = v;
        return o;
      };
      const changes: RowChange[] = [];
      const order: number[] = [];
      for (const [r, pend] of entries) {
        if (pend.kind === 'deleted') changes.push({ type: 'delete', key: keyOf(pend.original!) });
        else if (pend.kind === 'inserted') changes.push({ type: 'insert', values: valuesOf(pend) });
        else changes.push({ type: 'update', key: keyOf(pend.original!), values: valuesOf(pend) });
        order.push(r);
      }
      setApplying(true);
      try {
        const res = await api.data.apply(sessionId, { schema: p.database, table: p.table, changes, transaction: changes.length > 1, columns: names });
        let firstError: string | null = null;
        const removed: number[] = [];
        let inserted = 0;
        res.results.forEach((r, i) => {
          const rowIdx = order[i];
          const pend = pendingRef.current.get(rowIdx);
          if (!pend) return;
          if (!r.ok) {
            pend.error = r.error?.message ?? tr('Unbekannter Fehler', 'Unknown error');
            firstError ??= pend.error;
          }
        });
        if (res.committed) {
          res.results.forEach((r, i) => {
            if (!r.ok) return;
            const rowIdx = order[i];
            const pend = pendingRef.current.get(rowIdx);
            if (!pend) return;
            if (pend.kind === 'deleted') removed.push(rowIdx);
            else {
              if (pend.kind === 'inserted') inserted++;
              if (r.row) rowsRef.current[rowIdx] = r.row;
              else {
                const base = rowsRef.current[rowIdx].slice();
                for (const [ci, v] of pend.values) base[ci] = isEditObject(v) ? ('expr' in v ? v.expr : null) : v;
                rowsRef.current[rowIdx] = base;
              }
            }
            pendingRef.current.delete(rowIdx);
          });
        }
        removeRows(removed);
        bump();
        if (removed.length || inserted) setTotal((t) => (t === null ? t : t - removed.length + inserted));
        if (firstError !== null) {
          void errorDialog(new Error(firstError), tr('Änderungen konnten nicht übernommen werden', 'Changes could not be applied'));
          return false;
        }
        return true;
      } catch (e) {
        void errorDialog(e);
        return false;
      } finally {
        setApplying(false);
      }
    },
    [sessionId, info, p.database, p.table, removeRows, bump]
  );

  // ───────────── transactions ─────────────

  const runStatement = useCallback(
    async (sql: string) => {
      if (!sessionId) return false;
      const res = await api.query.execute(sessionId, sql, { history: true });
      const err = res.results.find((r) => r.kind === 'error');
      if (err?.error) {
        void errorDialog(new Error(err.error.message));
        return false;
      }
      return true;
    },
    [sessionId]
  );

  const beginTx = useCallback(async () => {
    if (await runStatement('START TRANSACTION')) setInTx(true);
  }, [runStatement]);

  const commit = useCallback(async () => {
    if (pendingRef.current.size && !(await apply())) return;
    if (await runStatement('COMMIT')) setInTx(false);
  }, [apply, runStatement]);

  const rollback = useCallback(async () => {
    if (await runStatement('ROLLBACK')) {
      setInTx(false);
      await load(page, sort, filter, prefs);
    }
  }, [runStatement, load, page, sort, filter, prefs]);

  const cancel = useCallback(async () => {
    if (sessionId) await api.query.cancel(sessionId).catch(() => undefined);
  }, [sessionId]);

  return {
    sessionId,
    status,
    error,
    info,
    columns,
    fks,
    metaOf,
    rows: rowsRef,
    pending: pendingRef,
    version,
    page,
    prefs,
    setPrefs,
    total,
    totalApprox,
    sort,
    setSort,
    filter,
    setFilter,
    inTx,
    applying,
    rawMode,
    setRawMode,
    load,
    getValue,
    rowState,
    cellModified,
    rowError,
    edit,
    addRow,
    markDeleted,
    discard,
    pendingCount,
    apply,
    beginTx,
    commit,
    rollback,
    cancel,
    whereOf
  };
}

export type TableData = ReturnType<typeof useTableData>;

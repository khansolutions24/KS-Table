// Result area of the query tab: result grids (editable for single-table results), messages, explain, profile, status.

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Check,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  Copy,
  FileOutput,
  Funnel,
  FunnelX,
  Minus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
  X
} from 'lucide-react';
import type { CellValue, EditValue } from '@shared/types';
import { tr } from '@shared/i18n';
import { qname, quoteId } from '@shared/sql/quote';
import { formatDateTime, formatDuration, formatNumber } from '@shared/util';
import { api } from '../../api/client';
import * as T from '../../actions/tools';
import { DataGrid, type DataGridHandle } from '../../components/grid/DataGrid';
import { columnFromMeta, columnFromResult, displayText, type GridColumnDef } from '../../components/grid/cellFormat';
import { SqlHighlight } from '../../components/SqlHighlight';
import { toast } from '../../components/Toast';
import { alertDialog, confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { Checkbox, EmptyState, IconButton, Spinner } from '../../components/ui/controls';
import { SEP, showContextMenu, type MenuItem } from '../../components/ui/Menu';
import { useSettings } from '../../store/settings';
import { toInsertSql, toTsv, toUpdateSql } from './copyFormats';
import { singleTableSource } from './editableResult';
import { accessSeverity, parseExplainJson, type ExplainPlan, type PlanNode } from './explainPlan';
import { buildChanges, editKey, editToCell, emptyEdits, mergeApplyResults, pendingCount, sameCell } from './gridEdits';
import { openValueDialog } from './dialogs';
import { patchResult, togglePin, type ClientFilter, type QueryStore, type ResultSet, type ResultsHost } from './queryStore';

const i14 = { size: 14 };

export function ResultsPanel({ store, host }: { store: QueryStore; host: ResultsHost }) {
  const results = store((s) => s.results);
  const messages = store((s) => s.messages);
  const explain = store((s) => s.explain);
  const profile = store((s) => s.profile);
  const profileError = store((s) => s.profileError);
  const status = store((s) => s.status);
  const active = store((s) => s.activeTab);
  const running = store((s) => s.running);
  const setActive = (id: string) => store.setState({ activeTab: id });

  const errors = messages?.results.filter((r) => r.kind === 'error').length ?? 0;
  const tabs: { id: string; label: ReactNode; title?: string; pinned?: boolean }[] = [
    ...results.map((r) => ({
      id: r.id,
      label: r.title,
      pinned: r.pinned,
      title: `${r.title}\n${formatDateTime(r.startedAt)} · ${formatDuration(r.durationMs)}\n\n${r.sql.slice(0, 600)}`
    })),
    { id: 'messages', label: errors ? `${tr('Meldungen', 'Messages')} (${errors})` : tr('Meldungen', 'Messages') },
    ...(explain ? [{ id: 'explain', label: tr('Erklären', 'Explain') }] : []),
    ...(profile || profileError ? [{ id: 'profile', label: tr('Profil', 'Profile') }] : []),
    ...(status ? [{ id: 'status', label: tr('Status', 'Status') }] : [])
  ];
  const current = tabs.some((t) => t.id === active) ? active : 'messages';
  const result = results.find((r) => r.id === current);

  return (
    <div className="ks-query-results">
      <div className="ks-tabstrip ks-query-rtabs" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            title={t.title ?? (i < 9 ? `Alt+${i + 1}` : undefined)}
            className={clsx('ks-tab', current === t.id && 'active', errors > 0 && t.id === 'messages' && 'ks-query-tab-error')}
            onClick={() => setActive(t.id)}
            onMouseDown={(e) => {
              if (e.button === 1 && results.some((r) => r.id === t.id)) {
                e.preventDefault();
                void closeResult(store, t.id);
              }
            }}
          >
            {t.pinned && <Pin size={12} className="ks-query-pin" />}
            <span>{t.label}</span>
            {results.some((r) => r.id === t.id) && (
              <span
                className="ks-query-tab-close"
                title={tr('Ergebnis schließen', 'Close result')}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeResult(store, t.id);
                }}
              >
                <X size={11} />
              </span>
            )}
          </button>
        ))}
        {running && (
          <div className="ks-tabstrip-right">
            <Spinner size={14} />
          </div>
        )}
      </div>
      <div className="ks-query-rbody">
        {result ? (
          <ResultGrid key={result.id} store={store} result={result} host={host} />
        ) : current === 'explain' && explain ? (
          <ExplainView data={explain} />
        ) : current === 'profile' ? (
          <ProfileView />
        ) : current === 'status' ? (
          <StatusView store={store} />
        ) : (
          <MessagesView store={store} host={host} />
        )}
      </div>
    </div>
  );

  function ProfileView() {
    if (profileError) return <div className="ks-query-pad danger-text selectable">{profileError}</div>;
    if (!profile?.length) return <EmptyState title={tr('Keine Profildaten', 'No profile data')} />;
    return (
      <div className="ks-query-scroll">
        {profile.map((p) => {
          const max = Math.max(1e-9, ...p.stages.map((s) => s.durationSec));
          return (
            <div key={p.queryId} className="ks-query-profile">
              <div className="ks-query-profile-head">
                <span className="ks-badge">#{p.queryId}</span>
                <span className="mono ellipsis selectable" title={p.sql}>
                  {p.sql}
                </span>
                <span className="spacer" />
                <b>{formatDuration(p.durationSec * 1000)}</b>
              </div>
              <table className="ks-table">
                <thead>
                  <tr>
                    <th>{tr('Phase', 'Stage')}</th>
                    <th style={{ width: 110 }}>{tr('Dauer (s)', 'Duration (s)')}</th>
                    <th style={{ width: 70 }}>%</th>
                    <th style={{ width: 200 }} />
                  </tr>
                </thead>
                <tbody>
                  {p.stages.map((s, i) => (
                    <tr key={i}>
                      <td>{s.status}</td>
                      <td className="num">{s.durationSec.toFixed(6)}</td>
                      <td className="num">{p.durationSec > 0 ? ((s.durationSec / p.durationSec) * 100).toFixed(1) : ''}</td>
                      <td>
                        <div className="ks-query-bar">
                          <div style={{ width: `${(s.durationSec / max) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    );
  }
}

async function closeResult(store: QueryStore, id: string): Promise<void> {
  const r = store.getState().results.find((x) => x.id === id);
  const discard = () =>
    confirmDialog({ message: tr('Nicht übernommene Änderungen verwerfen?', 'Discard changes that were not applied?'), okLabel: tr('Verwerfen', 'Discard'), danger: true });
  if (r && pendingCount(r.editState) > 0 && !(await discard())) return;
  store.setState((s) => ({ results: s.results.filter((x) => x.id !== id), activeTab: s.activeTab === id ? 'messages' : s.activeTab }));
}

// ───────────────────────── result grid ─────────────────────────

type ViewRow = { k: 'row'; i: number } | { k: 'ins'; key: number };

function matches(v: CellValue, f: ClientFilter): boolean {
  switch (f.op) {
    case 'null':
      return v === null;
    case 'notnull':
      return v !== null;
    case 'eq':
      return v !== null && sameCell(v, f.value);
    default:
      return !(v !== null && sameCell(v, f.value));
  }
}

function compareCells(a: CellValue, b: CellValue, numeric: boolean): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a instanceof Uint8Array || b instanceof Uint8Array) return String(a).localeCompare(String(b));
  if (numeric) {
    const x = Number(a);
    const y = Number(b);
    if (!isNaN(x) && !isNaN(y)) return x - y;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

function ResultGrid({ store, result, host }: { store: QueryStore; result: ResultSet; host: ResultsHost }) {
  const grid = useRef<DataGridHandle>(null);
  const nullText = useSettings((s) => s.settings.grid.nullText);
  const [searchOpen, setSearchOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const info = result.editable;
  const es = result.editState;
  const pending = pendingCount(es);
  const set = (patch: Partial<ResultSet> | ((r: ResultSet) => Partial<ResultSet>)) => patchResult(store, result.id, patch);

  const columns: GridColumnDef[] = useMemo(
    () =>
      result.columns.map((c, i) => {
        const mapped = info?.columnMap[i];
        const m = mapped ? info?.meta.find((x) => x.name === mapped) : undefined;
        if (m) return columnFromMeta(m, { id: `c${i}`, title: c.name });
        return columnFromResult(c, { id: `c${i}`, readonly: true });
      }),
    [result.columns, info]
  );

  const view: ViewRow[] = useMemo(() => {
    let idx = result.rows.map((_, i) => i);
    if (result.filters.length) idx = idx.filter((i) => result.filters.every((f) => matches(result.rows[i][f.col], f)));
    const sort = result.sort;
    if (sort) {
      const num = columns[sort.col]?.numeric ?? false;
      idx.sort((a, b) => compareCells(result.rows[a][sort.col], result.rows[b][sort.col], num) * (sort.desc ? -1 : 1));
    }
    return [...idx.map((i): ViewRow => ({ k: 'row', i })), ...es.inserted.map((x): ViewRow => ({ k: 'ins', key: x.key }))];
  }, [result.rows, result.filters, result.sort, es.inserted, columns]);

  const valueAt = useCallback(
    (vr: number, col: number): CellValue => {
      const r = view[vr];
      if (!r) return null;
      if (r.k === 'ins') {
        const v = es.inserted.find((x) => x.key === r.key)?.values[col];
        return v === undefined ? null : editToCell(v);
      }
      const k = editKey(r.i, col);
      return k in es.edits ? editToCell(es.edits[k]) : result.rows[r.i][col];
    },
    [view, es, result.rows]
  );

  const deleted = useMemo(() => new Set(es.deleted), [es.deleted]);
  const canEditCol = (col: number) => !!info?.columnMap[col] && !columns[col]?.readonly;

  const edit = (vr: number, col: number, value: EditValue) => {
    const r = view[vr];
    if (!info || !r || !canEditCol(col)) return;
    set((cur) => {
      const s = cur.editState;
      if (r.k === 'ins') {
        return { editState: { ...s, inserted: s.inserted.map((x) => (x.key === r.key ? { ...x, values: { ...x.values, [col]: value } } : x)) } };
      }
      if (s.deleted.includes(r.i)) return {};
      const edits = { ...s.edits };
      const k = editKey(r.i, col);
      const orig = cur.rows[r.i][col];
      if ((value === null || typeof value === 'string' || value instanceof Uint8Array) && sameCell(orig, value)) delete edits[k];
      else edits[k] = value;
      return { editState: { ...s, edits } };
    });
  };

  const selection = (): { rows: number[]; cols: number[] } => {
    const sel = grid.current?.selection();
    const all = columns.map((_, i) => i);
    if (!sel) return { rows: [], cols: all };
    if (sel.rows.length) return { rows: sel.rows, cols: all };
    if (sel.columns.length) return { rows: view.map((_, i) => i), cols: sel.columns };
    if (sel.range) {
      return {
        rows: Array.from({ length: sel.range.height }, (_, i) => sel.range!.row + i),
        cols: Array.from({ length: sel.range.width }, (_, i) => sel.range!.col + i)
      };
    }
    if (sel.cell) return { rows: [sel.cell.row], cols: [sel.cell.col] };
    return { rows: [], cols: all };
  };

  const src = useMemo(() => singleTableSource(result.columns), [result.columns]);
  const target = info ? qname(info.schema, info.table) : src ? qname(src.schema, src.table) : quoteId('table_name');

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(tr('{w} kopiert', '{w} copied', { w: what }));
    } catch (e) {
      void errorDialog(e);
    }
  };

  const copyAs = (format: 'value' | 'tsv' | 'tsvHeader' | 'insert' | 'update') => {
    const sel = selection();
    if (!sel.rows.length) return;
    if (format === 'value' || format === 'tsv' || format === 'tsvHeader') {
      const d = { columns: sel.cols.map((c) => columns[c]), rows: sel.rows.map((r) => sel.cols.map((c) => valueAt(r, c))) };
      void copy(toTsv(d, format === 'tsvHeader', format === 'value' ? '' : ''), tr('Auswahl', 'Selection'));
      return;
    }
    const bound = result.columns.map((c, i) => (c.orgTable ? i : -1)).filter((i) => i >= 0);
    const cols = format === 'insert' ? (bound.length ? sel.cols.filter((c) => bound.includes(c)) : sel.cols) : bound.length ? bound : columns.map((_, i) => i);
    const useCols = cols.length ? cols : sel.cols;
    const names = useCols.map((c) => info?.columnMap[c] ?? (result.columns[c].orgName || result.columns[c].name));
    const d = { columns: useCols.map((c) => columns[c]), rows: sel.rows.map((r) => useCols.map((c) => valueAt(r, c))) };
    if (format === 'insert') void copy(toInsertSql(target, names, d), 'INSERT');
    else {
      const keyCols = info ? info.key.map((k) => k.index) : useCols.filter((c) => result.columns[c].primaryKey);
      void copy(toUpdateSql(target, names, d, keyCols.map((k) => useCols.indexOf(k)).filter((i) => i >= 0)), 'UPDATE');
    }
  };

  const addRow = () => {
    if (!info) return;
    const key = Date.now() + Math.random();
    set((cur) => ({ editState: { ...cur.editState, inserted: [...cur.editState.inserted, { key, values: {} }] } }));
    requestAnimationFrame(() => {
      const row = view.length;
      const col = Math.max(0, info.columnMap.findIndex((n, i) => n && !columns[i]?.readonly));
      grid.current?.selectCell(row, col);
      grid.current?.focus();
    });
  };

  const deleteRows = () => {
    if (!info) return;
    const rows = selection().rows.map((r) => view[r]).filter(Boolean);
    if (!rows.length) return;
    set((cur) => {
      const s = cur.editState;
      const base = rows.filter((r): r is { k: 'row'; i: number } => r.k === 'row').map((r) => r.i);
      const insKeys = new Set(rows.filter((r): r is { k: 'ins'; key: number } => r.k === 'ins').map((r) => r.key));
      const allDeleted = base.length > 0 && base.every((i) => s.deleted.includes(i));
      const deletedList = allDeleted ? s.deleted.filter((i) => !base.includes(i)) : [...new Set([...s.deleted, ...base])];
      return { editState: { ...s, deleted: deletedList, inserted: s.inserted.filter((x) => !insKeys.has(x.key)) } };
    });
  };

  const setNull = () => {
    const sel = selection();
    for (const r of sel.rows) for (const c of sel.cols) if (columns[c]?.nullable !== false) edit(r, c, null);
  };

  const apply = async () => {
    const sid = host.sessionId();
    if (!info || !pending || !sid) return;
    const { changes, targets } = buildChanges(info, result.rows, es);
    setApplying(true);
    try {
      const names = info.columnMap.filter((n): n is string => !!n);
      const res = await api.data.apply(sid, { schema: info.schema, table: info.table, changes, transaction: true, columns: names });
      const cur = store.getState().results.find((r) => r.id === result.id);
      if (!cur) return;
      const m = mergeApplyResults(info, cur.rows, cur.editState, targets, res.results, res.committed, tr('Transaktion zurückgesetzt', 'Transaction rolled back'));
      set({ rows: m.rows, editState: m.state });
      if (m.failed.length) {
        await alertDialog({
          kind: 'error',
          title: tr('Änderungen übernehmen', 'Apply changes'),
          message: res.committed
            ? tr('{n} Änderung(en) konnten nicht übernommen werden.', '{n} change(s) could not be applied.', { n: m.failed.length })
            : tr('Die Änderungen wurden nicht übernommen (Transaktion zurückgesetzt).', 'The changes were not applied (transaction rolled back).'),
          details: m.failed.map((f) => `${f.message}${f.sql ? `\n${f.sql}` : ''}`).join('\n\n')
        });
      } else toast(tr('{n} Änderung(en) übernommen', '{n} change(s) applied', { n: m.applied }), 'success');
    } catch (e) {
      void errorDialog(e);
    } finally {
      setApplying(false);
    }
  };

  const discard = () => set({ editState: emptyEdits() });

  const addFilter = (col: number, op: ClientFilter['op'], value: CellValue) => set((cur) => ({ filters: [...cur.filters, { col, op, value }] }));

  const openValue = async (vr: number, col: number) => {
    const r = view[vr];
    if (!r) return;
    const c = columns[col];
    const editable = !!info && canEditCol(col) && !(r.k === 'row' && deleted.has(r.i));
    const v = await openValueDialog({ title: `${c.title} – ${c.typeLabel}`, value: valueAt(vr, col), column: c, editable });
    if (v !== undefined && editable) edit(vr, col, v);
  };

  const menu = (vr: number, col: number, e: { clientX: number; clientY: number }) => {
    const v = col >= 0 ? valueAt(vr, col) : null;
    const c = col >= 0 ? columns[col] : undefined;
    const short = v === null ? 'NULL' : c ? displayText(v, c, nullText).slice(0, 30) : '';
    const items: MenuItem[] = [
      { label: tr('Kopieren', 'Copy'), icon: <Copy {...i14} />, onClick: () => copyAs('value') },
      { label: tr('Kopieren mit Spaltennamen', 'Copy with Column Names'), icon: <ClipboardCopy {...i14} />, onClick: () => copyAs('tsvHeader') },
      {
        label: tr('Kopieren als', 'Copy as'),
        submenu: [
          { label: tr('INSERT-Anweisungen', 'INSERT statements'), onClick: () => copyAs('insert') },
          { label: tr('UPDATE-Anweisungen', 'UPDATE statements'), onClick: () => copyAs('update') },
          { label: tr('Tabulatorgetrennt (nur Daten)', 'Tab separated (data only)'), onClick: () => copyAs('tsv') },
          { label: tr('Tabulatorgetrennt (mit Spaltennamen)', 'Tab separated (with column names)'), onClick: () => copyAs('tsvHeader') }
        ]
      },
      SEP,
      { label: tr('Wert anzeigen …', 'View Value …'), disabled: col < 0, onClick: () => void openValue(vr, col) },
      { label: tr('Auf NULL setzen', 'Set to NULL'), hidden: !info, disabled: col < 0 || !canEditCol(col), onClick: setNull },
      { label: tr('Datensatz hinzufügen', 'Add Record'), icon: <Plus {...i14} />, hidden: !info, onClick: addRow },
      { label: tr('Datensatz löschen', 'Delete Record'), icon: <Minus {...i14} />, hidden: !info, onClick: deleteRows },
      SEP,
      ...(col >= 0
        ? [
            v === null
              ? { label: tr('Filter: {c} IS NULL', 'Filter: {c} IS NULL', { c: c!.title }), icon: <Funnel {...i14} />, onClick: () => addFilter(col, 'null', null) }
              : { label: tr('Filter: {c} = {v}', 'Filter: {c} = {v}', { c: c!.title, v: short }), icon: <Funnel {...i14} />, onClick: () => addFilter(col, 'eq', v) },
            v === null
              ? { label: tr('Filter: {c} IS NOT NULL', 'Filter: {c} IS NOT NULL', { c: c!.title }), onClick: () => addFilter(col, 'notnull', null) }
              : { label: tr('Filter: {c} ≠ {v}', 'Filter: {c} ≠ {v}', { c: c!.title, v: short }), onClick: () => addFilter(col, 'ne', v) }
          ]
        : []),
      { label: tr('Filter entfernen', 'Remove Filter'), icon: <FunnelX {...i14} />, disabled: !result.filters.length, onClick: () => set({ filters: [] }) },
      SEP,
      { label: tr('Exportieren …', 'Export …'), icon: <FileOutput {...i14} />, onClick: () => T.openExportWizard(host.connectionId(), host.database(), null, result.sql) },
      { label: result.pinned ? tr('Lösen', 'Unpin') : tr('Anheften', 'Pin'), icon: result.pinned ? <PinOff {...i14} /> : <Pin {...i14} />, onClick: () => togglePin(store, result.id) }
    ];
    showContextMenu(e, items);
  };

  const shown = view.length - es.inserted.length;

  return (
    <div className="ks-query-gridwrap">
      <div className="ks-query-gridbar">
        {info ? (
          <span className="ks-badge success" title={tr('Änderungen werden in {t} gespeichert', 'Changes are saved to {t}', { t: `${info.schema}.${info.table}` })}>
            <Pencil size={11} />
            &nbsp;{info.table}
          </span>
        ) : (
          <span className="ks-badge" title={result.readOnlyReason ?? tr('Wird geprüft …', 'Checking …')}>
            {tr('Schreibgeschützt', 'Read-only')}
          </span>
        )}
        {info && (
          <>
            <IconButton icon={<Plus {...i14} />} title={tr('Datensatz hinzufügen', 'Add record')} onClick={addRow} />
            <IconButton icon={<Minus {...i14} />} title={tr('Datensatz löschen (Strg+Entf)', 'Delete record (Ctrl+Del)')} onClick={deleteRows} />
            <IconButton icon={applying ? <Spinner size={13} /> : <Check {...i14} />} title={tr('Änderungen übernehmen (Strg+Enter)', 'Apply changes (Ctrl+Enter)')} disabled={!pending || applying} onClick={() => void apply()} />
            <IconButton icon={<RotateCcw {...i14} />} title={tr('Änderungen verwerfen', 'Discard changes')} disabled={!pending || applying} onClick={discard} />
            {pending > 0 && <span className="ks-badge warning">{tr('{n} ausstehend', '{n} pending', { n: pending })}</span>}
          </>
        )}
        <span className="ks-tb-sep" />
        <IconButton icon={<Search {...i14} />} title={tr('Suchen (Strg+F)', 'Find (Ctrl+F)')} active={searchOpen} onClick={() => setSearchOpen((x) => !x)} />
        {result.filters.length > 0 && (
          <button type="button" className="ks-badge accent ks-query-filterbadge" title={tr('Filter entfernen', 'Remove filter')} onClick={() => set({ filters: [] })}>
            <Funnel size={11} />
            &nbsp;{tr('{n} Filter', '{n} filter(s)', { n: result.filters.length })}
            <X size={11} />
          </button>
        )}
        <IconButton icon={<FileOutput {...i14} />} title={tr('Exportieren …', 'Export …')} onClick={() => T.openExportWizard(host.connectionId(), host.database(), null, result.sql)} />
        <IconButton
          icon={result.pinned ? <PinOff {...i14} /> : <Pin {...i14} />}
          active={result.pinned}
          title={result.pinned ? tr('Ergebnis lösen', 'Unpin result') : tr('Ergebnis anheften (bleibt bei erneutem Ausführen erhalten)', 'Pin result (kept when running again)')}
          onClick={() => togglePin(store, result.id)}
        />
        <span className="spacer" />
        {result.truncated && (
          <span className="ks-badge warning" title={tr('Einstellbar unter Optionen › Abfrage', 'Configurable in Options › Query')}>
            <TriangleAlert size={11} />
            &nbsp;{tr('Auf {n} Zeilen begrenzt', 'Limited to {n} rows', { n: formatNumber(result.rows.length) })}
          </span>
        )}
        <span className="muted">
          {result.filters.length
            ? tr('{s} von {n} Zeilen', '{s} of {n} rows', { s: formatNumber(shown), n: formatNumber(result.rows.length) })
            : tr('{n} Zeilen', '{n} rows', { n: formatNumber(result.rows.length) })}
          {' · '}
          {formatDuration(result.durationMs)}
        </span>
      </div>
      <DataGrid
        ref={grid}
        columns={columns}
        rowCount={view.length}
        getValue={valueAt}
        editable={!!info}
        onEdit={edit}
        rowState={(vr) => {
          const r = view[vr];
          if (!r) return undefined;
          return r.k === 'ins' ? 'inserted' : deleted.has(r.i) ? 'deleted' : undefined;
        }}
        cellModified={(vr, col) => {
          const r = view[vr];
          if (!r) return false;
          if (r.k === 'ins') return es.inserted.find((x) => x.key === r.key)?.values[col] !== undefined;
          return editKey(r.i, col) in es.edits;
        }}
        onOpenValue={(vr, col) => void openValue(vr, col)}
        onCellContextMenu={menu}
        onHeaderClick={(col) =>
          set((cur) => ({
            sort: !cur.sort || cur.sort.col !== col ? { col, desc: false } : !cur.sort.desc ? { col, desc: true } : null
          }))
        }
        sortState={(col) => (result.sort?.col === col ? (result.sort.desc ? 'desc' : 'asc') : null)}
        searchOpen={searchOpen}
        onSearchClose={() => setSearchOpen(false)}
        onKeyDown={(e) => {
          const ctrl = e.ctrlKey || e.metaKey;
          if (ctrl && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            setSearchOpen(true);
          } else if (ctrl && e.key === 'Enter' && info) {
            e.preventDefault();
            void apply();
          } else if (ctrl && e.key === 'Delete' && info) {
            e.preventDefault();
            deleteRows();
          } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'n' && info) {
            e.preventDefault();
            setNull();
          }
        }}
        empty={<span>{result.filters.length ? tr('Keine Treffer', 'No matches') : tr('Keine Zeilen', 'No rows')}</span>}
      />
    </div>
  );
}

// ───────────────────────── messages ─────────────────────────

function MessagesView({ store, host }: { store: QueryStore; host: ResultsHost }) {
  const m = store((s) => s.messages);
  const running = store((s) => s.running);
  const progress = store((s) => s.progress);
  if (!m) {
    return running && progress ? (
      <div className="ks-query-pad row">
        <Spinner size={16} />
        {tr('Anweisung {i} von {n} …', 'Statement {i} of {n} …', { i: progress.index + 1, n: progress.total })}
      </div>
    ) : (
      <EmptyState title={tr('Noch nichts ausgeführt', 'Nothing executed yet')}>
        {tr('Ausführen mit Strg+R oder F9, aktuelle Anweisung mit Strg+Umschalt+R.', 'Run with Ctrl+R or F9, the current statement with Ctrl+Shift+R.')}
      </EmptyState>
    );
  }
  const errors = m.results.filter((r) => r.kind === 'error').length;
  return (
    <div className="ks-query-scroll">
      <div className="ks-query-msg-summary">
        {errors ? <CircleX size={15} className="danger-text" /> : <CircleCheck size={15} className="success-text" />}
        <span>
          {tr('{n} Anweisung(en) ausgeführt, {e} Fehler, Gesamtzeit {t}', '{n} statement(s) executed, {e} error(s), total time {t}', {
            n: m.results.length,
            e: errors,
            t: formatDuration(m.totalMs)
          })}
          {m.cancelled ? ` – ${tr('abgebrochen', 'cancelled')}` : ''}
          {m.hiddenResults ? ` – ${tr('{n} weitere Ergebnisse nicht angezeigt', '{n} more results not shown', { n: m.hiddenResults })}` : ''}
        </span>
      </div>
      <table className="ks-table ks-query-msgs">
        <thead>
          <tr>
            <th style={{ width: 34 }}>#</th>
            <th>{tr('Anweisung', 'Statement')}</th>
            <th>{tr('Meldung', 'Message')}</th>
            <th style={{ width: 80 }}>{tr('Dauer', 'Time')}</th>
          </tr>
        </thead>
        <tbody>
          {m.results.map((r, i) => (
            <tr key={i} className={clsx(r.kind === 'error' && 'ks-query-msg-error')}>
              <td className="num">{r.index + 1}</td>
              <td className="ks-query-msg-sql">
                <button
                  type="button"
                  className="ks-query-link mono"
                  title={m.mapped ? `${tr('Im Editor markieren', 'Select in editor')}\n\n${r.sql.slice(0, 800)}` : r.sql.slice(0, 800)}
                  onClick={() => m.mapped && host.selectStatement(r.index)}
                >
                  {r.sql.replace(/\s+/g, ' ').slice(0, 160)}
                </button>
              </td>
              <td className="ks-query-msg-text selectable">
                {r.kind === 'error' ? (
                  <span className="danger-text">
                    {r.error?.errno ? `[${r.error.errno}] ` : ''}
                    {r.error?.message}
                  </span>
                ) : r.kind === 'resultset' ? (
                  <span>
                    {tr('{n} Zeile(n) zurückgegeben', '{n} row(s) returned', { n: formatNumber(r.rows?.length ?? 0) })}
                    {r.truncated ? ` (${tr('begrenzt', 'limited')})` : ''}
                  </span>
                ) : (
                  <span>
                    {tr('{n} Zeile(n) betroffen', '{n} row(s) affected', { n: formatNumber(r.affectedRows ?? 0) })}
                    {r.insertId && r.insertId !== '0' ? ` · ${tr('Einfüge-ID', 'Insert ID')} ${r.insertId}` : ''}
                    {r.info ? ` · ${r.info}` : ''}
                  </span>
                )}
                {r.warnings?.map((w, j) => (
                  <div key={j} className="ks-query-warning">
                    <TriangleAlert size={12} /> {w.level} {w.code}: {w.message}
                  </div>
                ))}
                {!r.warnings?.length && r.warningCount ? (
                  <div className="ks-query-warning">
                    <TriangleAlert size={12} /> {tr('{n} Warnung(en)', '{n} warning(s)', { n: r.warningCount })}
                  </div>
                ) : null}
              </td>
              <td className="num">{formatDuration(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────── explain ─────────────────────────

function ExplainView({ data }: { data: NonNullable<ReturnType<QueryStore['getState']>['explain']> }) {
  const plan = useMemo((): { plan: ExplainPlan | null; error: string | null } => {
    if (!data.json) return { plan: null, error: data.jsonError };
    try {
      return { plan: parseExplainJson(data.json), error: null };
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [data.json, data.jsonError]);
  const [mode, setMode] = useState<'plan' | 'table' | 'tree' | 'json'>(plan.plan ? 'plan' : 'table');
  const maxCost = Math.max(0, ...(plan.plan?.tables.map((t) => t.cost ?? 0) ?? []));
  const modes: { id: typeof mode; label: string; show: boolean }[] = [
    { id: 'plan', label: tr('Plan', 'Plan'), show: true },
    { id: 'table', label: tr('Tabelle', 'Table'), show: true },
    { id: 'tree', label: tr('Baum', 'Tree'), show: !!data.tree || !!data.treeError },
    { id: 'json', label: 'JSON', show: true }
  ];
  return (
    <div className="ks-query-explain">
      <div className="ks-query-gridbar">
        {modes
          .filter((x) => x.show)
          .map((x) => (
            <button key={x.id} type="button" className={clsx('ks-tb-btn inline', mode === x.id && 'active')} onClick={() => setMode(x.id)}>
              {x.label}
            </button>
          ))}
        <span className="spacer" />
        {plan.plan?.totalCost != null && <span className="muted">{tr('Geschätzte Kosten: {c}', 'Estimated cost: {c}', { c: formatNumber(plan.plan.totalCost, 2) })}</span>}
        <span className="muted mono ellipsis ks-query-explain-sql" title={data.sql}>
          {data.sql.replace(/\s+/g, ' ')}
        </span>
      </div>
      <div className="ks-query-scroll">
        {mode === 'plan' &&
          (plan.plan ? (
            <div className="ks-query-plan">
              <PlanNodeView node={plan.plan.root} maxCost={maxCost} />
            </div>
          ) : (
            <div className="ks-query-pad danger-text selectable">{plan.error ?? tr('Kein Plan verfügbar', 'No plan available')}</div>
          ))}
        {mode === 'table' &&
          (data.table ? (
            <table className="ks-table">
              <thead>
                <tr>
                  {data.table.columns.map((c, i) => (
                    <th key={i}>{c.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.table.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className={clsx('selectable', data.table!.columns[j]?.numeric && 'num', j === 4 && `ks-query-access-${accessSeverity(typeof v === 'string' ? v : '')}`)}>
                        {v === null ? <span className="faint">NULL</span> : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="ks-query-pad danger-text selectable">{data.tableError}</div>
          ))}
        {mode === 'tree' && (data.tree ? <pre className="ks-sql selectable">{data.tree}</pre> : <div className="ks-query-pad danger-text selectable">{data.treeError}</div>)}
        {mode === 'json' && (data.json ? <SqlHighlight sql={data.json} className="selectable" /> : <div className="ks-query-pad danger-text selectable">{data.jsonError}</div>)}
      </div>
    </div>
  );
}

function PlanNodeView({ node, maxCost }: { node: PlanNode; maxCost: number }) {
  const [open, setOpen] = useState(false);
  const sev = node.kind === 'table' ? accessSeverity(node.accessType) : 'neutral';
  const heavy = node.kind === 'table' && maxCost > 0 && (node.cost ?? 0) >= maxCost * 0.5 && (node.cost ?? 0) > 0;
  return (
    <div className="ks-query-plan-item">
      <div className={clsx('ks-query-plan-card', `kind-${node.kind}`, heavy && 'heavy')} onClick={() => setOpen((x) => !x)} title={tr('Klicken für Details', 'Click for details')}>
        <div className="ks-query-plan-title">
          <span>{node.title}</span>
          {node.accessType && <span className={clsx('ks-badge', sev === 'bad' ? 'danger' : sev === 'warn' ? 'warning' : sev === 'good' ? 'success' : '')}>{node.accessType}</span>}
          {node.queryCost !== undefined && <span className="muted">{tr('Kosten {c}', 'cost {c}', { c: formatNumber(node.queryCost, 2) })}</span>}
        </div>
        {node.kind === 'table' && (
          <div className="ks-query-plan-props">
            {node.key && (
              <span>
                {tr('Index', 'Key')}: <b>{node.key}</b>
                {node.usedKeyParts ? ` (${node.usedKeyParts.join(', ')})` : ''}
              </span>
            )}
            {node.rowsExamined !== undefined && (
              <span>
                {tr('Zeilen', 'Rows')}: <b>{formatNumber(node.rowsExamined)}</b>
              </span>
            )}
            {node.filtered !== undefined && <span>{tr('Gefiltert', 'Filtered')}: {formatNumber(node.filtered, 2)} %</span>}
            {node.cost !== undefined && (
              <span>
                {tr('Kosten', 'Cost')}: <b>{formatNumber(node.cost, 2)}</b>
              </span>
            )}
            {node.ref && <span>ref: {node.ref.join(', ')}</span>}
          </div>
        )}
        {node.condition && <div className="ks-query-plan-cond mono">{node.condition}</div>}
        {node.flags.length > 0 && (
          <div className="ks-query-plan-flags">
            {node.flags.map((f, i) => (
              <span key={i} className="ks-badge">
                {f}
              </span>
            ))}
          </div>
        )}
        {open && node.details.length > 0 && (
          <table className="ks-query-plan-details" onClick={(e) => e.stopPropagation()}>
            <tbody>
              {node.details.map(([k, v]) => (
                <tr key={k}>
                  <td className="muted">{k}</td>
                  <td className="selectable mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {node.children.length > 0 && (
        <div className="ks-query-plan-children">
          {node.children.map((c) => (
            <PlanNodeView key={c.id} node={c} maxCost={maxCost} />
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── status ─────────────────────────

function StatusView({ store }: { store: QueryStore }) {
  const status = store((s) => s.status) ?? [];
  const [changedOnly, setChangedOnly] = useState(true);
  const list = changedOnly ? status.filter((s) => s.delta !== 0) : status;
  return (
    <div className="ks-query-explain">
      <div className="ks-query-gridbar">
        <Checkbox checked={changedOnly} onChange={setChangedOnly} label={tr('Nur geänderte Werte', 'Changed values only')} />
        <span className="spacer" />
        <span className="muted">{tr('Sitzungsstatus: Differenz vor / nach der Ausführung', 'Session status: difference before / after execution')}</span>
      </div>
      <div className="ks-query-scroll">
        <table className="ks-table">
          <thead>
            <tr>
              <th>{tr('Variable', 'Variable')}</th>
              <th style={{ width: 140 }}>{tr('Änderung', 'Change')}</th>
              <th style={{ width: 160 }}>{tr('Wert danach', 'Value after')}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.name}>
                <td className="selectable">{s.name}</td>
                <td className="num">{formatNumber(s.delta)}</td>
                <td className="num">{formatNumber(s.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="ks-query-pad muted">{tr('Keine Änderungen', 'No changes')}</div>}
      </div>
    </div>
  );
}

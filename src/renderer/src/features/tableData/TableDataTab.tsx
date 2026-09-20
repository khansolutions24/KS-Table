// Table / view data viewer: grid + form view, editing, filter & sort, paging, cell editor, transactions.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  CircleStop,
  ClipboardPaste,
  Columns3,
  Copy,
  Dices,
  FileCode,
  FileInput,
  FileOutput,
  ListFilter,
  Minus,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  Replace,
  Rows3,
  Sigma,
  Table2,
  Undo2,
  Wrench,
  X
} from 'lucide-react';
import { tr } from '@shared/i18n';
import type { CellValue, EditValue, SortSpec } from '@shared/types';
import { literal, quoteId } from '@shared/sql/quote';
import { formatDuration, formatNumber } from '@shared/util';
import { api } from '../../api/client';
import * as O from '../../actions/objects';
import * as Q from '../../actions/query';
import * as T from '../../actions/tools';
import { editText, type GridColumnDef } from '../../components/grid/cellFormat';
import type { GridKeyEventArgs } from '@glideapps/glide-data-grid';
import { DataGrid, type DataGridHandle, type GridSel } from '../../components/grid/DataGrid';
import { askDialog, confirmDialog, promptDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, EmptyState, IconButton, NumberInput, ProgressBar, Spinner, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { SEP, showContextMenu, showMenu, showMenuBelow, type MenuItem } from '../../components/ui/Menu';
import { toast } from '../../components/Toast';
import { keyCombo } from '../../lib/shortcuts';
import { useSettings } from '../../store/settings';
import { setCloseGuard, useTabs, type TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { CellEditor, openValueEditor } from './CellEditor';
import { toCsv, toInsert, toJson, toMarkdown, toTsv, toUpdate, type CopySource } from './copyAs';
import { buildWhere, emptyFilter, filterActive, newCond, type FilterModel, type FilterOp } from './filter';
import { FilterSortPane } from './FilterSortPane';
import { FormView } from './FormView';
import { askReplace, chooseColumns, pickDateTime, pickForeignKey } from './pickers';
import { useTableData, type FkRef, type TableDataParams } from './useTableData';
import './tableData.css';

const PROFILE_KIND = 'tableview';

function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
  toast(tr('In die Zwischenablage kopiert', 'Copied to clipboard'));
}

function shortValue(v: CellValue, c: GridColumnDef): string {
  if (v === null) return 'NULL';
  const s = typeof v === 'string' ? v : editText(v, c);
  return s.length > 30 ? `„${s.slice(0, 30)}…“` : `„${s}“`;
}

export default function TableDataTab({ tab, active }: TabProps) {
  const params = tab.params as unknown as TableDataParams;
  const initialFilter = useMemo<FilterModel>(
    () => (params.where ? { mode: 'sql', conds: [], sql: params.where, orderSql: '' } : emptyFilter()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const td = useTableData(params, initialFilter);
  const gs = useSettings((s) => s.settings.grid);
  const grid = useRef<DataGridHandle>(null);
  const [mode, setMode] = useState<'grid' | 'form'>('grid');
  const [filterOpen, setFilterOpen] = useState(!!params.where);
  const [paneInit, setPaneInit] = useState<FilterModel | null>(null);
  const [paneSeed, setPaneSeed] = useState(0);
  const [cellPane, setCellPane] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(null);
  const lastRow = useRef<number | null>(null);
  const tdRef = useRef(td);
  tdRef.current = td;
  const activeRef = useRef(active);
  activeRef.current = active;

  const viewInfo = useWorkspace((s) =>
    params.view ? s.conns[params.connectionId]?.dbs[params.database]?.views.find((v) => v.name === params.table) : undefined
  );
  const tableInfo = useWorkspace((s) =>
    !params.view ? s.conns[params.connectionId]?.dbs[params.database]?.tables.find((t) => t.name === params.table) : undefined
  );
  const editable = !params.view || !!viewInfo?.isUpdatable;
  const txCapable = !params.view && (tableInfo?.engine ?? 'InnoDB').toLowerCase() === 'innodb';

  // ───────────── columns (hidden / order) ─────────────
  const visible = useMemo(() => {
    const all = td.columns.map((c, i) => ({ c, i }));
    const pos = (id: string, fallback: number) => {
      const k = td.prefs.order.indexOf(id);
      return k < 0 ? 1e6 + fallback : k;
    };
    return all.filter((x) => !td.prefs.hidden.includes(x.c.id)).sort((a, b) => pos(a.c.id, a.i) - pos(b.c.id, b.i));
  }, [td.columns, td.prefs.hidden, td.prefs.order]);
  const visCols = useMemo(
    () => visible.map(({ c }) => (td.prefs.showTypes ? { ...c, title: `${c.title}  ·  ${c.typeLabel.toLowerCase()}` } : c)),
    [visible, td.prefs.showTypes]
  );
  const toData = useCallback((vc: number) => visible[vc]?.i ?? -1, [visible]);
  const toVis = useCallback((dc: number) => visible.findIndex((v) => v.i === dc), [visible]);
  const rowCount = td.rows.current.length;

  const getValue = useCallback((row: number, vc: number) => td.getValue(row, toData(vc)), [td.getValue, toData]);
  const cellModified = useCallback((row: number, vc: number) => td.cellModified(row, toData(vc)), [td.cellModified, toData]);
  const sortState = useCallback(
    (vc: number) => {
      const s = td.sort.find((x) => x.column === visible[vc]?.c.id);
      return s ? (s.desc ? 'desc' : 'asc') : null;
    },
    [td.sort, visible]
  );

  // ───────────── dirty state / close guard / global commands ─────────────
  useEffect(() => {
    useTabs.getState().update(tab.id, { dirty: td.pendingCount > 0 || td.inTx });
  }, [td.pendingCount, td.inTx, tab.id]);

  useEffect(() => {
    setCloseGuard(tab.id, async () => {
      const t = tdRef.current;
      if (t.pending.current.size) {
        const c = await askDialog({
          title: tr('Nicht übernommene Änderungen', 'Unsaved changes'),
          message: tr('„{t}“ enthält nicht übernommene Änderungen. Jetzt übernehmen?', '"{t}" has unsaved changes. Apply them now?', { t: params.table }),
          yesLabel: tr('Übernehmen', 'Apply'),
          noLabel: tr('Verwerfen', 'Discard')
        });
        if (c === 'cancel') return false;
        if (c === 'yes' && !(await t.apply())) return false;
      }
      if (t.inTx) {
        const c = await askDialog({
          title: tr('Offene Transaktion', 'Open transaction'),
          message: tr('Die Transaktion ist noch offen. Änderungen festschreiben (COMMIT)?', 'The transaction is still open. Commit the changes?'),
          yesLabel: 'Commit',
          noLabel: 'Rollback'
        });
        if (c === 'cancel') return false;
        if (c === 'yes') await t.commit();
      }
      return true;
    });
    return () => setCloseGuard(tab.id, null);
  }, [tab.id, params.table]);

  useEffect(() => {
    const h = (e: Event) => {
      if (!activeRef.current) return;
      const d = (e as CustomEvent<string>).detail;
      if (d === 'save') void tdRef.current.apply();
      else if (d === 'find') setSearchOpen(true);
    };
    window.addEventListener('ks-command', h);
    return () => window.removeEventListener('ks-command', h);
  }, []);

  // ───────────── loading helpers ─────────────
  const ensureApplied = useCallback(async (): Promise<boolean> => {
    const t = tdRef.current;
    if (!t.pending.current.size) return true;
    if (gs.autoApply) return t.apply();
    const c = await askDialog({
      message: tr('Nicht übernommene Änderungen vorher übernehmen?', 'Apply the unsaved changes first?'),
      yesLabel: tr('Übernehmen', 'Apply'),
      noLabel: tr('Verwerfen', 'Discard')
    });
    if (c === 'cancel') return false;
    if (c === 'yes') return t.apply();
    t.discard();
    return true;
  }, [gs.autoApply]);

  const reload = useCallback(
    async (page?: number, recount = true) => {
      if (!(await ensureApplied())) return;
      const t = tdRef.current;
      void t.load(page ?? t.page, t.sort, t.filter, t.prefs, recount);
    },
    [ensureApplied]
  );

  const applySort = async (sort: SortSpec[]) => {
    if (!(await ensureApplied())) return;
    td.setSort(sort);
    void td.load(0, sort, td.filter, td.prefs);
  };

  const applyFilter = async (f: FilterModel, sort: SortSpec[] = td.sort) => {
    if (!(await ensureApplied())) return;
    td.setFilter(f);
    td.setSort(sort);
    setPaneInit(null);
    void td.load(0, sort, f, td.prefs);
  };

  const goPage = async (n: number) => {
    if (!(await ensureApplied())) return;
    void td.load(n, td.sort, td.filter, td.prefs, false);
  };

  const changeLimit = (patch: { limitOn?: boolean; pageSize?: number }) => {
    const prefs = { ...td.prefs, ...patch };
    td.setPrefs(patch);
    void (async () => {
      if (await ensureApplied()) void td.load(0, td.sort, td.filter, prefs, false);
    })();
  };

  // ───────────── selection helpers ─────────────
  const selection = (): GridSel => grid.current?.selection() ?? { cell: null, range: null, rows: [], columns: [] };

  const selectedRows = (): number[] => {
    if (mode === 'form') return cursor ? [cursor.row] : [];
    const rows = grid.current?.selectedRows() ?? [];
    return rows.length ? rows : cursor ? [cursor.row] : [];
  };

  const selectedCells = (): { row: number; dc: number }[] => {
    if (mode === 'form') return cursor ? [{ row: cursor.row, dc: cursor.col }] : [];
    const s = selection();
    if (s.rows.length) return s.rows.flatMap((r) => visible.map((v) => ({ row: r, dc: v.i })));
    if (s.range) {
      const out: { row: number; dc: number }[] = [];
      for (let r = s.range.row; r < s.range.row + s.range.height; r++) {
        for (let c = s.range.col; c < s.range.col + s.range.width; c++) out.push({ row: r, dc: toData(c) });
      }
      return out;
    }
    return cursor ? [{ row: cursor.row, dc: cursor.col }] : [];
  };

  const selectionSource = (): CopySource & { rowIdx: number[] } => {
    const s = selection();
    let rows: number[] = [];
    let dcs: number[] = [];
    if (mode === 'form' && cursor) {
      rows = [cursor.row];
      dcs = visible.map((v) => v.i);
    } else if (s.rows.length) {
      rows = s.rows;
      dcs = visible.map((v) => v.i);
    } else if (s.range) {
      for (let r = s.range.row; r < s.range.row + s.range.height; r++) rows.push(r);
      for (let c = s.range.col; c < s.range.col + s.range.width; c++) dcs.push(toData(c));
    } else if (cursor) {
      rows = [cursor.row];
      dcs = [cursor.col];
    }
    return { columns: dcs.map((d) => td.columns[d]), rows: rows.map((r) => dcs.map((d) => td.getValue(r, d))), rowIdx: rows };
  };

  const fullRows = (rowIdx: number[]): CopySource => ({
    columns: td.columns,
    rows: rowIdx.map((r) => td.columns.map((_, d) => td.getValue(r, d)))
  });

  const setCells = (value: EditValue | ((c: GridColumnDef) => EditValue | undefined)) => {
    if (!editable) return;
    for (const { row, dc } of selectedCells()) {
      const col = td.columns[dc];
      if (!col || col.readonly || td.rowState(row) === 'deleted') continue;
      const v = typeof value === 'function' ? value(col) : value;
      if (v === undefined) continue;
      td.edit(row, dc, v);
    }
  };

  // ───────────── record actions ─────────────
  const onSel = (s: GridSel) => {
    const row = s.cell?.row ?? null;
    setCursor(s.cell ? { row: s.cell.row, col: toData(s.cell.col) } : null);
    const prev = lastRow.current;
    lastRow.current = row;
    // apply every pending row, not just the one being left — a single edit (e.g. filling a
    // multi-row selection) can dirty several rows at once, and all of them should be saved
    if (gs.autoApply && prev !== null && prev !== row && tdRef.current.pendingCount > 0) {
      void tdRef.current.apply();
    }
  };

  const moveRecord = (to: number) => {
    if (!rowCount) return;
    const r = Math.max(0, Math.min(rowCount - 1, to));
    if (mode === 'grid') grid.current?.selectCell(r, cursor ? Math.max(0, toVis(cursor.col)) : 0);
    else {
      const prev = cursor?.row;
      setCursor({ row: r, col: cursor?.col ?? 0 });
      lastRow.current = r;
      if (gs.autoApply && prev !== undefined && prev !== r && td.pendingCount > 0) void td.apply();
    }
  };

  const addRecord = (template?: CellValue[]) => {
    if (!editable) return;
    const r = td.addRow(template);
    // land on the first column the user would actually fill in, not the auto-increment id
    const firstEditableVis = visible.findIndex(({ c }) => !c.readonly && !c.autoIncrement);
    const startVis = firstEditableVis >= 0 ? firstEditableVis : 0;
    if (mode === 'form') setCursor({ row: r, col: toData(startVis) });
    else window.setTimeout(() => grid.current?.selectCell(r, startVis), 30);
  };

  const deleteRecords = async () => {
    const rows = selectedRows();
    if (!rows.length || !editable) return;
    const ok = await confirmDialog({
      title: tr('Datensatz löschen', 'Delete record'),
      message: rows.length === 1 ? tr('Soll der ausgewählte Datensatz gelöscht werden?', 'Delete the selected record?') : tr('Sollen {n} Datensätze gelöscht werden?', 'Delete {n} records?', { n: rows.length }),
      okLabel: tr('Löschen', 'Delete'),
      danger: true
    });
    if (!ok) return;
    td.markDeleted(rows);
    if (gs.autoApply) await td.apply();
  };

  /** Pastes a 2D block of text starting at (row, startVisCol); rows falling past the end are appended. */
  const applyPaste = (row: number, startVisCol: number, lines: string[][]) => {
    if (!editable || !lines.length) return;
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      let r = row + i;
      if (r >= tdRef.current.rows.current.length) r = td.addRow();
      for (let j = 0; j < lines[i].length; j++) {
        const dc = toData(startVisCol + j);
        const col = td.columns[dc];
        if (!col || col.readonly) continue;
        td.edit(r, dc, lines[i][j]);
        count++;
      }
    }
    toast(tr('{n} Werte eingefügt', '{n} values pasted', { n: count }));
  };

  const paste = async () => {
    if (!editable) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    const start = cursor ?? { row: 0, col: visible[0]?.i ?? 0 };
    applyPaste(start.row, Math.max(0, toVis(start.col)), lines);
  };

  const openEditor = async (row: number, dc: number) => {
    const col = td.columns[dc];
    if (!col) return;
    const v = td.getValue(row, dc);
    const canEdit = editable && !col.readonly && td.rowState(row) !== 'deleted';
    const fk = td.fks.get(col.id);
    if (canEdit && fk && td.sessionId) {
      const nv = await pickForeignKey(td.sessionId, fk, v);
      if (nv !== undefined) td.edit(row, dc, nv);
      return;
    }
    if (canEdit && (col.kind === 'date' || col.kind === 'datetime' || col.kind === 'time')) {
      const nv = await pickDateTime(col.kind, typeof v === 'string' ? v : null, !!col.nullable, `${params.table}.${col.title}`);
      if (nv !== undefined) td.edit(row, dc, nv);
      return;
    }
    const nv = await openValueEditor({ title: `${params.table}.${col.title}`, column: col, meta: td.metaOf(dc), value: v, editable: canEdit, nullText: gs.nullText });
    if (nv !== undefined && canEdit) td.edit(row, dc, nv);
  };

  const openReferenced = (fk: FkRef, v: CellValue) => {
    const refCol = td.columns.find((c) => c.id === fk.refColumn);
    useTabs.getState().open({
      kind: 'tableData',
      title: `${fk.refTable} @${fk.refSchema}`,
      icon: 'table',
      params: {
        connectionId: params.connectionId,
        database: fk.refSchema,
        table: fk.refTable,
        view: false,
        where: `${quoteId(fk.refColumn)} = ${literal(v, refCol?.numeric ?? /^-?\d+(\.\d+)?$/.test(String(v)))}`
      },
      connectionId: params.connectionId
    });
  };

  const quickFilter = (dc: number, op: FilterOp, value: CellValue) => {
    const col = td.columns[dc];
    const text = value === null ? '' : typeof value === 'string' ? value : editText(value, col);
    const base = td.filter.mode === 'builder' ? td.filter : emptyFilter();
    void applyFilter({ ...base, mode: 'builder', conds: [...base.conds, newCond(col.id, op, text)] });
  };

  const customFilter = async (dc: number) => {
    const col = td.columns[dc];
    const pattern = await promptDialog({
      title: tr('Benutzerdefinierter Filter', 'Custom filter'),
      label: tr('Muster für „{c}“ (_ = ein beliebiges Zeichen, % = beliebig viele Zeichen):', 'Pattern for "{c}" (_ = any single character, % = any sequence):', { c: col.title }),
      value: '%'
    });
    if (pattern !== null) quickFilter(dc, 'like', pattern);
  };

  const goToRow = async () => {
    const max = td.total ?? rowCount;
    const s = await promptDialog({
      title: tr('Gehe zu Zeile', 'Go to row'),
      label: tr('Zeilennummer (1 – {n}):', 'Row number (1 – {n}):', { n: formatNumber(max) }),
      validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 ? null : tr('Bitte eine gültige Zahl eingeben.', 'Please enter a valid number.'))
    });
    if (!s) return;
    const n = Number(s) - 1;
    const size = td.prefs.limitOn ? td.prefs.pageSize : null;
    if (size && (n < td.page * size || n >= (td.page + 1) * size)) {
      if (!(await ensureApplied())) return;
      const page = Math.floor(n / size);
      await td.load(page, td.sort, td.filter, td.prefs, false);
      window.setTimeout(() => grid.current?.selectCell(n - page * size, 0), 80);
    } else grid.current?.selectCell(size ? n - td.page * size : n, 0);
  };

  const findField = async () => {
    const s = await promptDialog({ title: tr('Spalte suchen', 'Find column'), label: tr('Spaltenname:', 'Column name:') });
    if (!s) return;
    const vc = visible.findIndex((v) => v.c.id.toLowerCase().includes(s.toLowerCase()));
    if (vc < 0) toast(tr('Keine passende Spalte gefunden', 'No matching column found'), 'error');
    else grid.current?.selectCell(cursor?.row ?? 0, vc);
  };

  const replaceAll = async () => {
    const o = await askReplace(visCols);
    if (!o) return;
    const targets = o.column === '*' ? visible.filter((v) => ['text', 'json', 'enum', 'set'].includes(v.c.kind)).map((v) => v.i) : [td.columns.findIndex((c) => c.id === o.column)];
    const esc = o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let count = 0;
    for (let r = 0; r < tdRef.current.rows.current.length; r++) {
      if (td.rowState(r) === 'deleted') continue;
      for (const dc of targets) {
        const col = td.columns[dc];
        if (!col || col.readonly) continue;
        const v = td.getValue(r, dc);
        if (typeof v !== 'string') continue;
        let nv: string | null = null;
        if (o.wholeCell) {
          if (o.matchCase ? v === o.find : v.toLowerCase() === o.find.toLowerCase()) nv = o.replace;
        } else {
          const re = new RegExp(esc, o.matchCase ? 'g' : 'gi');
          if (re.test(v)) nv = v.replace(new RegExp(esc, o.matchCase ? 'g' : 'gi'), () => o.replace);
        }
        if (nv !== null && nv !== v) {
          td.edit(r, dc, nv);
          count++;
        }
      }
    }
    toast(tr('{n} Werte ersetzt', '{n} values replaced', { n: count }), count ? 'success' : 'info');
  };

  const editColumns = async () => {
    const res = await chooseColumns(td.columns, td.prefs.order, td.prefs.hidden);
    if (res) td.setPrefs(res);
  };

  const design = () =>
    params.view ? O.designView(params.connectionId, params.database, params.table) : O.designTable(params.connectionId, params.database, params.table);

  const queryObject = () => {
    const where = buildWhere(td.filter, td.columns);
    Q.newQuery(params.connectionId, params.database, `SELECT *\nFROM ${quoteId(params.table)}${where ? `\nWHERE ${where}` : ''};`, `${params.table} – ${tr('Abfrage', 'Query')}`);
  };

  // table view profiles (filter, sort, layout)
  const profilePrefix = `${params.connectionId}~${params.database}~${params.table}~`;
  const profileMenu = async (el: HTMLElement) => {
    const list = (await api.profiles.list(PROFILE_KIND).catch(() => [])).filter((p) => p.name.startsWith(profilePrefix));
    const label = (n: string) => n.slice(profilePrefix.length);
    showMenuBelow(el, [
      {
        label: tr('Profil speichern …', 'Save profile …'),
        icon: <Bookmark size={14} />,
        onClick: async () => {
          const name = await promptDialog({ title: tr('Profil speichern', 'Save profile'), label: tr('Profilname:', 'Profile name:'), validate: (v) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.')) });
          if (!name) return;
          await api.profiles.save(PROFILE_KIND, profilePrefix + name.trim(), { filter: td.filter, sort: td.sort, prefs: td.prefs });
          toast(tr('Profil „{n}“ gespeichert', 'Profile "{n}" saved', { n: name.trim() }), 'success');
        }
      },
      SEP,
      { type: 'header', label: tr('Profil laden', 'Load profile') },
      ...(list.length
        ? list.map<MenuItem>((p) => ({
            label: label(p.name),
            onClick: async () => {
              const data = (await api.profiles.load(PROFILE_KIND, p.name)) as { filter: FilterModel; sort: SortSpec[]; prefs: typeof td.prefs };
              td.setPrefs(data.prefs);
              setFilterOpen(filterActive(data.filter));
              void applyFilter(data.filter, data.sort);
            }
          }))
        : [{ label: tr('Keine gespeicherten Profile', 'No saved profiles'), disabled: true }]),
      SEP,
      {
        label: tr('Profil löschen', 'Delete profile'),
        disabled: !list.length,
        submenu: list.map<MenuItem>((p) => ({ label: label(p.name), onClick: () => void api.profiles.remove(PROFILE_KIND, p.name) }))
      }
    ]);
  };

  // ───────────── menus ─────────────
  const cellMenu = (row: number, dc: number): MenuItem[] => {
    const col = td.columns[dc];
    if (!col) return [];
    const v = td.getValue(row, dc);
    const canEdit = editable && !col.readonly && td.rowState(row) !== 'deleted';
    const temporal = col.kind === 'date' || col.kind === 'datetime' || col.kind === 'time';
    const fk = td.fks.get(col.id);
    const src = selectionSource();
    const keyCols = td.info?.keyColumns ?? [];
    return [
      { label: tr('Kopieren', 'Copy'), icon: <Copy size={14} />, shortcut: 'Ctrl+C', onClick: () => copyText(toTsv(src, false)) },
      {
        label: tr('Kopieren als', 'Copy as'),
        submenu: [
          { label: tr('INSERT-Anweisungen', 'Insert statements'), onClick: () => copyText(toInsert(params.database, params.table, fullRows(src.rowIdx))) },
          { label: tr('UPDATE-Anweisungen', 'Update statements'), onClick: () => copyText(toUpdate(params.database, params.table, src, keyCols, fullRows(src.rowIdx))) },
          SEP,
          { label: tr('Tabulatorgetrennt (nur Daten)', 'Tab separated (data only)'), onClick: () => copyText(toTsv(src, false)) },
          { label: tr('Tabulatorgetrennt (nur Feldnamen)', 'Tab separated (field names only)'), onClick: () => copyText(toTsv(src, true, false)) },
          { label: tr('Tabulatorgetrennt (Feldnamen und Daten)', 'Tab separated (field names and data)'), onClick: () => copyText(toTsv(src, true)) },
          SEP,
          { label: 'CSV', onClick: () => copyText(toCsv(src)) },
          { label: 'JSON', onClick: () => copyText(toJson(src)) },
          { label: 'Markdown', onClick: () => copyText(toMarkdown(src)) }
        ]
      },
      { label: tr('Einfügen', 'Paste'), icon: <ClipboardPaste size={14} />, shortcut: 'Ctrl+V', disabled: !editable, onClick: () => void paste() },
      SEP,
      { label: tr('Auf NULL setzen', 'Set to NULL'), shortcut: 'Ctrl+Shift+N', disabled: !canEdit || !col.nullable, onClick: () => setCells((c) => (c.nullable ? null : undefined)) },
      { label: tr('Leere Zeichenkette', 'Set to empty string'), disabled: !canEdit, onClick: () => setCells('') },
      {
        label: tr('Aktuelles Datum / Uhrzeit', 'Current date / time'),
        hidden: !temporal,
        disabled: !canEdit,
        onClick: () => setCells((c) => ({ expr: c.kind === 'date' ? 'CURRENT_DATE' : c.kind === 'time' ? 'CURRENT_TIME' : 'NOW()' }))
      },
      { label: tr('Standardwert (DEFAULT)', 'Default value (DEFAULT)'), disabled: !canEdit, onClick: () => setCells({ default: true }) },
      { label: tr('Wert bearbeiten …', 'Edit value …'), shortcut: 'Ctrl+Enter', onClick: () => void openEditor(row, dc) },
      { label: tr('Fremdschlüsseldaten auswählen …', 'Select foreign key data …'), hidden: !fk, disabled: !canEdit, onClick: () => void openEditor(row, dc) },
      { label: tr('Referenzierten Datensatz öffnen', 'Open referenced record'), hidden: !fk || v === null, onClick: () => fk && openReferenced(fk, v) },
      SEP,
      {
        label: tr('Filter', 'Filter'),
        icon: <ListFilter size={14} />,
        submenu: [
          { label: `${col.title} = ${shortValue(v, col)}`, onClick: () => quickFilter(dc, v === null ? 'isNull' : 'eq', v) },
          { label: `${col.title} <> ${shortValue(v, col)}`, onClick: () => quickFilter(dc, v === null ? 'notNull' : 'ne', v) },
          { label: `${col.title} < ${shortValue(v, col)}`, hidden: v === null, onClick: () => quickFilter(dc, 'lt', v) },
          { label: `${col.title} > ${shortValue(v, col)}`, hidden: v === null, onClick: () => quickFilter(dc, 'gt', v) },
          { label: tr('{c} enthält {v}', '{c} contains {v}', { c: col.title, v: shortValue(v, col) }), hidden: typeof v !== 'string', onClick: () => quickFilter(dc, 'contains', v) },
          { label: tr('{c} beginnt mit {v}', '{c} begins with {v}', { c: col.title, v: shortValue(v, col) }), hidden: typeof v !== 'string', onClick: () => quickFilter(dc, 'begins', v) },
          SEP,
          { label: `${col.title} IS NULL`, onClick: () => quickFilter(dc, 'isNull', null) },
          { label: `${col.title} IS NOT NULL`, onClick: () => quickFilter(dc, 'notNull', null) },
          SEP,
          { label: tr('Benutzerdefinierter Filter …', 'Custom filter …'), onClick: () => void customFilter(dc) },
          { label: tr('Filter & Sortierung …', 'Filter & sort …'), onClick: () => setFilterOpen(true) },
          { label: tr('Filter entfernen', 'Remove filter'), disabled: !filterActive(td.filter), onClick: () => void applyFilter(emptyFilter(), td.sort) }
        ]
      },
      {
        label: tr('Sortieren', 'Sort'),
        submenu: [
          { label: tr('Aufsteigend', 'Ascending'), icon: <ArrowUpAZ size={14} />, onClick: () => void applySort([{ column: col.id, desc: false }]) },
          { label: tr('Absteigend', 'Descending'), icon: <ArrowDownAZ size={14} />, onClick: () => void applySort([{ column: col.id, desc: true }]) },
          { label: tr('Sortierung entfernen', 'Remove sort'), disabled: !td.sort.length, onClick: () => void applySort([]) }
        ]
      },
      SEP,
      { label: tr('Neuer Datensatz', 'New record'), icon: <Plus size={14} />, shortcut: 'Insert', disabled: !editable, onClick: () => addRecord() },
      {
        label: tr('Datensatz duplizieren', 'Duplicate record'),
        disabled: !editable,
        onClick: () => addRecord(td.columns.map((_, d) => td.getValue(row, d)))
      },
      { label: tr('Datensatz löschen', 'Delete record'), icon: <Minus size={14} />, shortcut: 'Ctrl+Del', disabled: !editable, danger: true, onClick: () => void deleteRecords() },
      SEP,
      { label: tr('Aktualisieren', 'Refresh'), icon: <RefreshCw size={14} />, shortcut: 'F5', onClick: () => void reload() }
    ];
  };

  const headerMenu = (vc: number): MenuItem[] => {
    const col = visible[vc]?.c;
    if (!col) return [];
    const s = td.sort.find((x) => x.column === col.id);
    return [
      { label: tr('Aufsteigend sortieren', 'Sort ascending'), icon: <ArrowUpAZ size={14} />, checked: !!s && !s.desc, onClick: () => void applySort([{ column: col.id, desc: false }]) },
      { label: tr('Absteigend sortieren', 'Sort descending'), icon: <ArrowDownAZ size={14} />, checked: !!s?.desc, onClick: () => void applySort([{ column: col.id, desc: true }]) },
      {
        label: tr('Zur Sortierung hinzufügen', 'Add to sort'),
        disabled: !!s,
        submenu: [
          { label: tr('Aufsteigend', 'Ascending'), onClick: () => void applySort([...td.sort, { column: col.id, desc: false }]) },
          { label: tr('Absteigend', 'Descending'), onClick: () => void applySort([...td.sort, { column: col.id, desc: true }]) }
        ]
      },
      { label: tr('Sortierung entfernen', 'Remove sort'), disabled: !td.sort.length, onClick: () => void applySort([]) },
      SEP,
      { label: tr('Spalte ausblenden', 'Hide column'), onClick: () => td.setPrefs({ hidden: [...td.prefs.hidden, col.id] }) },
      { label: tr('Spalten anzeigen / ausblenden …', 'Show / hide columns …'), icon: <Columns3 size={14} />, onClick: () => void editColumns() },
      { label: tr('Alle Spalten anzeigen', 'Show all columns'), disabled: !td.prefs.hidden.length, onClick: () => td.setPrefs({ hidden: [] }) },
      SEP,
      { label: tr('Bis hier fixieren', 'Freeze up to here'), onClick: () => td.setPrefs({ freeze: vc + 1 }) },
      { label: tr('Fixierung aufheben', 'Unfreeze columns'), disabled: !td.prefs.freeze, onClick: () => td.setPrefs({ freeze: 0 }) },
      SEP,
      { label: tr('Feldtypen im Spaltenkopf', 'Field types in header'), checked: td.prefs.showTypes, onClick: () => td.setPrefs({ showTypes: !td.prefs.showTypes }) },
      {
        label: tr('Nach dieser Spalte filtern …', 'Filter by this column …'),
        icon: <ListFilter size={14} />,
        onClick: () => {
          const base = td.filter.mode === 'builder' ? td.filter : emptyFilter();
          setPaneInit({ ...base, mode: 'builder', conds: [...base.conds, newCond(col.id)] });
          setPaneSeed((x) => x + 1);
          setFilterOpen(true);
        }
      },
      { label: tr('Spaltenname kopieren', 'Copy column name'), icon: <Copy size={14} />, onClick: () => copyText(col.id) }
    ];
  };

  // ───────────── keyboard ─────────────
  // Shared by the tab's own onKeyDown (DOM bubbling, e.g. toolbar/filter pane focus) and the grid's
  // onKeyDown (glide-data-grid calls this directly — its focus-capturing input is portaled to <body>,
  // so a plain DOM keydown handler on the tab never sees it; see DataGrid's onKeyDown prop).
  const handleCombo = (combo: string, run: (fn: () => void) => void, inField: boolean) => {
    switch (combo) {
      case 'Ctrl+S':
        return run(() => void td.apply());
      case 'F5':
        return run(() => void reload());
      case 'Ctrl+T':
        return run(() => void td.cancel());
      case 'Ctrl+F':
        return run(() => setSearchOpen(true));
      case 'Ctrl+G':
        return run(() => void goToRow());
      case 'Ctrl+D':
        return run(design);
      case 'Ctrl+Q':
        return run(queryObject);
      case 'Ctrl+R':
        if (!filterOpen) run(() => void reload());
        return;
    }
    if (inField) return;
    switch (combo) {
      case 'Insert':
      case 'Ctrl+N':
        return run(() => addRecord());
      case 'Ctrl+Delete':
        return run(() => void deleteRecords());
      case 'Ctrl+Shift+N':
        return run(() => setCells((c) => (c.nullable ? null : undefined)));
      case 'Ctrl+Enter':
        if (cursor) run(() => void openEditor(cursor.row, cursor.col));
        return;
      case 'Escape':
        if (cursor && td.pending.current.has(cursor.row)) run(() => td.discard([cursor.row]));
        return;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inField = !!target.closest('input, textarea, select, .monaco-editor') && !target.closest('.ks-grid');
    handleCombo(keyCombo(e), (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }, inField);
  };

  // grid-focused keys: glide-data-grid calls this directly, bypassing DOM bubbling entirely.
  // cancel() stops glide's own further handling of the key (e.g. its Escape/type-to-edit logic).
  const onGridKeyDown = (e: GridKeyEventArgs) => {
    handleCombo(keyCombo(e), (fn) => {
      e.preventDefault();
      e.stopPropagation();
      e.cancel();
      fn();
    }, false);
  };

  // ───────────── render ─────────────
  const size = td.prefs.limitOn ? Math.max(1, td.prefs.pageSize) : null;
  const pages = size && td.total !== null ? Math.max(1, Math.ceil(td.total / size)) : null;
  const canNext = size !== null && (pages !== null ? td.page < pages - 1 : rowCount >= size);
  const busy = td.status === 'loading' || td.applying;
  const current = cursor && cursor.row < rowCount ? cursor : null;
  const cellCol = current ? td.columns[current.col] ?? null : null;

  let content;
  if (!td.info && td.status === 'error') {
    content = (
      <EmptyState title={tr('Daten konnten nicht geladen werden', 'Data could not be loaded')}>
        <p className="selectable">{td.error}</p>
        <Button variant="primary" icon={<RefreshCw size={14} />} onClick={() => void td.load(0, td.sort, td.filter, td.prefs)} disabled={!td.sessionId}>
          {tr('Erneut versuchen', 'Retry')}
        </Button>
      </EmptyState>
    );
  } else if (!td.info) {
    content = (
      <div className="ks-tab-loading">
        <Spinner size={22} />
      </div>
    );
  } else if (mode === 'grid') {
    content = (
      <DataGrid
        ref={grid}
        columns={visCols}
        rowCount={rowCount}
        getValue={getValue}
        rowState={td.rowState}
        cellModified={cellModified}
        editable={editable}
        onEdit={(row, vc, v) => td.edit(row, toData(vc), v)}
        onOpenValue={(row, vc) => void openEditor(row, toData(vc))}
        onCellContextMenu={(row, vc, e) => showContextMenu(e, cellMenu(row, toData(vc)))}
        onHeaderContextMenu={(vc, e) => showContextMenu(e, headerMenu(vc))}
        onHeaderMenu={(vc, r) => showMenu({ x: r.x, y: r.y + r.height, items: headerMenu(vc) })}
        sortState={sortState}
        onColumnMoved={(from, to) => {
          const ids = visible.map((v) => v.c.id);
          const [m] = ids.splice(from, 1);
          ids.splice(to, 0, m);
          td.setPrefs({ order: [...ids, ...td.columns.map((c) => c.id).filter((id) => !ids.includes(id))] });
        }}
        onSelectionChange={onSel}
        onKeyDown={(e: GridKeyEventArgs) => onGridKeyDown(e)}
        onDeleteCells={(cells) => {
          for (const c of cells) {
            const dc = toData(c.col);
            const col = td.columns[dc];
            if (!col || col.readonly || td.rowState(c.row) === 'deleted') continue;
            td.edit(c.row, dc, col.nullable ? null : '');
          }
        }}
        onDeleteRows={editable ? () => void deleteRecords() : undefined}
        onPasteCells={editable ? (target, values) => applyPaste(target.row, target.col, values) : undefined}
        onAppendRow={editable ? () => void td.addRow() : undefined}
        freezeColumns={Math.min(td.prefs.freeze, visCols.length)}
        rowNumberOffset={size ? td.page * size : 0}
        searchOpen={searchOpen}
        onSearchClose={() => setSearchOpen(false)}
        empty={td.status === 'ready' ? tr('Keine Datensätze', 'No records') : undefined}
      />
    );
  } else {
    content = (
      <FormView
        columns={visCols}
        row={current?.row ?? (rowCount ? 0 : -1)}
        rowCount={rowCount}
        getValue={getValue}
        cellModified={cellModified}
        editable={editable}
        nullText={gs.nullText}
        rowState={current ? td.rowState(current.row) : undefined}
        onEdit={(row, vc, v) => td.edit(row, toData(vc), v)}
        onOpenValue={(row, vc) => void openEditor(row, toData(vc))}
        onPickDate={(row, vc) => void openEditor(row, toData(vc))}
        onPickFk={(row, vc) => void openEditor(row, toData(vc))}
      />
    );
  }

  const recordText =
    current !== null
      ? tr('Datensatz {a} von {b} auf Seite {c}', 'Record {a} of {b} in page {c}', { a: current.row + 1, b: rowCount, c: td.page + 1 })
      : tr('{b} Datensätze auf Seite {c}', '{b} records in page {c}', { b: rowCount, c: td.page + 1 });

  return (
    <div className="ks-td" onKeyDown={onKeyDown}>
      <Toolbar>
        {editable && txCapable && (
          <>
            <ToolbarButton icon={<Play size={15} />} label={tr('Transaktion beginnen', 'Begin Transaction')} disabled={td.inTx || !td.sessionId} onClick={() => void td.beginTx()} />
            <ToolbarButton icon={<Check size={15} />} label="Commit" disabled={!td.inTx} onClick={() => void td.commit()} />
            <ToolbarButton icon={<Undo2 size={15} />} label="Rollback" disabled={!td.inTx} onClick={() => void td.rollback()} />
            <ToolbarSep />
          </>
        )}
        <ToolbarButton icon={<ListFilter size={15} />} label={tr('Filter & Sortierung', 'Filter & Sort')} active={filterOpen} onClick={() => setFilterOpen((v) => !v)} />
        <ToolbarButton icon={<Columns3 size={15} />} label={tr('Spalten', 'Columns')} onClick={() => void editColumns()} />
        <ToolbarButton icon={<PanelRight size={15} />} label={tr('Zelleditor', 'Cell Editor')} active={cellPane} onClick={() => setCellPane((v) => !v)} />
        <ToolbarButton icon={<Replace size={15} />} label={tr('Ersetzen', 'Replace')} disabled={!editable} onClick={() => void replaceAll()} />
        <ToolbarSep />
        {!params.view && <ToolbarButton icon={<FileInput size={15} />} label={tr('Import', 'Import')} onClick={() => T.openImportWizard(params.connectionId, params.database, params.table)} />}
        <ToolbarButton icon={<FileOutput size={15} />} label={tr('Export', 'Export')} onClick={() => T.openExportWizard(params.connectionId, params.database, [params.table])} />
        <ToolbarButton icon={<Bookmark size={15} />} label={tr('Profil', 'Profile')} dropdown onClick={(e) => void profileMenu(e.currentTarget)} />
        <div className="spacer" />
        <ToolbarButton
          icon={<Sigma size={15} />}
          title={tr('Datenprofil', 'Data profiling')}
          onClick={() =>
            useTabs.getState().open({
              kind: 'profiling',
              key: `profile:${params.connectionId}:${params.database}:${params.table}`,
              title: `${params.table} – ${tr('Datenprofil', 'Profile')}`,
              icon: 'chart',
              params: { connectionId: params.connectionId, database: params.database, table: params.table },
              connectionId: params.connectionId
            })
          }
        />
        {!params.view && <ToolbarButton icon={<Dices size={15} />} title={tr('Testdaten generieren', 'Generate data')} onClick={() => T.openDataGenerator(params.connectionId, params.database, [params.table])} />}
        <ToolbarButton icon={<Wrench size={15} />} title={tr('Entwerfen (Ctrl+D)', 'Design (Ctrl+D)')} onClick={design} />
        <ToolbarButton icon={<FileCode size={15} />} title={tr('Abfrage (Ctrl+Q)', 'Query (Ctrl+Q)')} onClick={queryObject} />
      </Toolbar>

      {filterOpen && td.info && (
        <FilterSortPane
          key={paneSeed}
          columns={td.columns}
          filter={paneInit ?? td.filter}
          sort={td.sort}
          sessionId={td.sessionId}
          database={params.database}
          table={params.table}
          onApply={(f, s) => void applyFilter(f, s)}
          onClose={() => setFilterOpen(false)}
        />
      )}
      {td.status === 'error' && td.info && <div className="ks-td-error selectable">{td.error}</div>}

      <div className="ks-td-main">
        {busy && <ProgressBar className="ks-td-busy" value={null} />}
        <Group orientation="horizontal" className="ks-td-split">
          <Panel id="grid" minSize="30%">
            <div className="ks-td-content">{content}</div>
          </Panel>
          {cellPane && <Separator className="ks-splitter" />}
          {cellPane && (
            <Panel id="cell" defaultSize="340px" minSize="220px" maxSize="70%">
              <CellEditor
                column={cellCol}
                meta={current ? td.metaOf(current.col) : undefined}
                value={current ? td.getValue(current.row, current.col) : null}
                editable={editable && !!current && td.rowState(current.row) !== 'deleted'}
                nullText={gs.nullText}
                onSet={(v) => current && td.edit(current.row, current.col, v)}
              />
            </Panel>
          )}
        </Group>
      </div>

      <div className="ks-td-nav">
        <IconButton icon={<Plus size={15} />} title={tr('Neuer Datensatz (Einfg / Ctrl+N)', 'New record (Insert / Ctrl+N)')} disabled={!editable} onClick={() => addRecord()} />
        <IconButton icon={<Minus size={15} />} title={tr('Datensatz löschen (Ctrl+Entf)', 'Delete record (Ctrl+Del)')} disabled={!editable || !rowCount} onClick={() => void deleteRecords()} />
        <IconButton icon={<Check size={15} />} title={tr('Änderungen übernehmen (Ctrl+S)', 'Apply changes (Ctrl+S)')} disabled={!td.pendingCount || td.applying} onClick={() => void td.apply()} />
        <IconButton icon={<X size={15} />} title={tr('Änderungen verwerfen', 'Discard changes')} disabled={!td.pendingCount} onClick={() => td.discard()} />
        <span className="ks-td-nav-sep" />
        <IconButton icon={<RefreshCw size={14} />} title={tr('Aktualisieren (F5)', 'Refresh (F5)')} disabled={busy || !td.sessionId} onClick={() => void reload()} />
        <IconButton icon={<CircleStop size={15} />} title={tr('Laden abbrechen (Ctrl+T)', 'Stop loading (Ctrl+T)')} disabled={td.status !== 'loading'} onClick={() => void td.cancel()} />
        <span className="ks-td-nav-sep" />
        <IconButton icon={<ChevronsLeft size={15} />} title={tr('Erste Seite', 'First page')} disabled={!size || td.page === 0 || busy} onClick={() => void goPage(0)} />
        <IconButton icon={<ChevronLeft size={15} />} title={tr('Vorherige Seite', 'Previous page')} disabled={!size || td.page === 0 || busy} onClick={() => void goPage(td.page - 1)} />
        <span className="ks-td-page">
          {tr('Seite', 'Page')} {td.page + 1}
          {pages !== null ? ` / ${formatNumber(pages)}` : ''}
        </span>
        <IconButton icon={<ChevronRight size={15} />} title={tr('Nächste Seite', 'Next page')} disabled={!canNext || busy} onClick={() => void goPage(td.page + 1)} />
        <IconButton icon={<ChevronsRight size={15} />} title={tr('Letzte Seite', 'Last page')} disabled={pages === null || td.page >= pages - 1 || busy} onClick={() => pages !== null && void goPage(pages - 1)} />
        <span className="ks-td-nav-sep" />
        <IconButton icon={<ChevronUp size={15} />} title={tr('Vorheriger Datensatz', 'Previous record')} disabled={!rowCount} onClick={() => moveRecord((current?.row ?? 0) - 1)} />
        <IconButton icon={<ChevronDown size={15} />} title={tr('Nächster Datensatz', 'Next record')} disabled={!rowCount} onClick={() => moveRecord((current?.row ?? -1) + 1)} />
        <span className="ks-td-nav-sep" />
        <IconButton icon={<Table2 size={15} />} title={tr('Rasteransicht', 'Grid view')} active={mode === 'grid'} onClick={() => setMode('grid')} />
        <IconButton
          icon={<Rows3 size={15} />}
          title={tr('Formularansicht', 'Form view')}
          active={mode === 'form'}
          onClick={() => {
            if (!cursor && rowCount) setCursor({ row: 0, col: visible[0]?.i ?? 0 });
            setMode('form');
          }}
        />
        <span className="ks-td-nav-sep" />
        <Checkbox checked={td.prefs.limitOn} onChange={(v) => changeLimit({ limitOn: v })} label={tr('Begrenzen auf', 'Limit to')} />
        <NumberInput
          value={td.prefs.pageSize}
          min={1}
          step={100}
          disabled={!td.prefs.limitOn}
          className="ks-td-pagesize"
          onChange={(v) => {
            if (v !== '' && v > 0) td.setPrefs({ pageSize: v });
          }}
        />
        <Button size="sm" variant="ghost" disabled={!td.prefs.limitOn} onClick={() => changeLimit({ pageSize: td.prefs.pageSize })} title={tr('Seitengröße anwenden', 'Apply page size')}>
          {tr('Datensätze / Seite', 'records / page')}
        </Button>
        <div className="spacer" />
        <span className="ks-td-rec">{recordText}</span>
        {td.total !== null && (
          <span className="ks-td-total">
            {tr('{t} gesamt', '{t} total', { t: `${td.totalApprox ? '~' : ''}${formatNumber(td.total)}` })}
          </span>
        )}
      </div>

      <div className="ks-statusline">
        <span className="ks-td-sql ellipsis selectable" title={td.info?.sql}>
          {td.info?.sql}
        </span>
        <span className="spacer" />
        {td.rawMode && <span className="ks-badge warning">{tr('Rohmodus', 'Raw mode')}</span>}
        {!editable && <span className="ks-badge">{tr('Schreibgeschützt', 'Read only')}</span>}
        {editable && td.info?.keyKind === 'none' && (
          <span className="ks-badge warning" title={tr('Ohne Primärschlüssel werden Datensätze über alle Spalten identifiziert.', 'Without a primary key records are identified by all columns.')}>
            {tr('Kein Primärschlüssel', 'No primary key')}
          </span>
        )}
        {td.inTx && <span className="ks-badge accent">{tr('Transaktion offen', 'Transaction open')}</span>}
        {td.pendingCount > 0 && <span className="ks-badge warning">{tr('{n} ungespeichert', '{n} unsaved', { n: td.pendingCount })}</span>}
        <label className="ks-td-raw" title={tr('Eingaben als SQL-Ausdruck senden (z. B. NOW())', 'Send input as SQL expression (e.g. NOW())')}>
          <input type="checkbox" checked={td.rawMode} onChange={(e) => td.setRawMode(e.target.checked)} />
          {tr('Roh', 'Raw')}
        </label>
        {td.info && <span>{formatDuration(td.info.durationMs)}</span>}
      </div>
    </div>
  );
}

// Canvas data grid (Glide Data Grid) for table data and query results.

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridKeyEventArgs,
  type GridSelection,
  type Item,
  type ProvideEditorCallback,
  type Theme
} from '@glideapps/glide-data-grid';
import { tr } from '@shared/i18n';
import type { CellValue, EditValue } from '@shared/types';
import { fromHex } from '@shared/sql/quote';
import { cssVar, useResolvedTheme } from '../../lib/theme';
import { useSettings } from '../../store/settings';
import { displayText, editText, inlineEditable, type GridColumnDef } from './cellFormat';

export type RowState = 'inserted' | 'deleted' | undefined;

export interface GridSel {
  /** focused cell */
  cell: { row: number; col: number } | null;
  /** rectangle of the current range selection */
  range: { col: number; row: number; width: number; height: number } | null;
  /** explicitly selected rows (row marker selection) */
  rows: number[];
  /** explicitly selected columns */
  columns: number[];
}

export interface DataGridHandle {
  selection(): GridSel;
  /** rows covered by the selection (range or row markers) */
  selectedRows(): number[];
  focus(): void;
  scrollTo(row: number, col?: number): void;
  selectCell(row: number, col: number): void;
  clearSelection(): void;
}

export interface DataGridProps {
  columns: GridColumnDef[];
  rowCount: number;
  getValue: (row: number, col: number) => CellValue;
  rowState?: (row: number) => RowState;
  cellModified?: (row: number, col: number) => boolean;
  editable?: boolean;
  onEdit?: (row: number, col: number, value: EditValue) => void;
  /** Double click / Enter on cells that cannot be edited inline (BLOB, geometry …) */
  onOpenValue?: (row: number, col: number) => void;
  onCellContextMenu?: (row: number, col: number, e: { clientX: number; clientY: number }) => void;
  onHeaderContextMenu?: (col: number, e: { clientX: number; clientY: number }) => void;
  onHeaderClick?: (col: number, e: { shiftKey: boolean; ctrlKey: boolean }) => void;
  /** Header drag & drop reordering */
  onColumnMoved?: (from: number, to: number) => void;
  /** Shows a menu arrow in every header; called with the arrow's screen rectangle */
  onHeaderMenu?: (col: number, rect: { x: number; y: number; width: number; height: number }) => void;
  /** Double click / Enter on a row of a read-only grid */
  onRowActivated?: (row: number) => void;
  /** Shows a trailing "new record" row; called when the user starts a new row there */
  onAppendRow?: () => void;
  sortState?: (col: number) => 'asc' | 'desc' | null;
  onKeyDown?: (e: GridKeyEventArgs) => void;
  onSelectionChange?: (sel: GridSel) => void;
  /** Delete / Backspace on a cell range selection (default: nothing happens) */
  onDeleteCells?: (cells: { row: number; col: number }[]) => void;
  /** Delete / Backspace when whole rows are selected via the row markers (default: falls back to onDeleteCells) */
  onDeleteRows?: (rows: number[]) => void;
  /** Ctrl+V / native paste; called with the target cell and the pasted 2D values. Overrides the grid's own paste handling. */
  onPasteCells?: (target: { row: number; col: number }, values: string[][]) => void;
  freezeColumns?: number;
  /** first row number shown in the row marker column (paging) */
  rowNumberOffset?: number;
  searchOpen?: boolean;
  onSearchClose?: () => void;
  /** content shown when there are no rows */
  empty?: ReactNode;
}

const HEADER_ICONS = {
  pk: (p: { fgColor: string; bgColor: string }) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none"><circle cx="7" cy="10" r="3.5" stroke="#d4a106" stroke-width="2"/><path d="M10.5 10h7M15 10v3M17.5 10v2.5" stroke="#d4a106" stroke-width="2" stroke-linecap="round"/><title>${p.fgColor}</title></svg>`,
  fk: () =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none"><path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9" stroke="#7c3aed" stroke-width="1.8" stroke-linecap="round"/></svg>`
};

function useGridTheme(fontSize: number): Partial<Theme> {
  const t = useResolvedTheme();
  return useMemo(() => {
    const dark = t === 'dark';
    return {
      accentColor: cssVar('--accent'),
      accentFg: '#ffffff',
      accentLight: dark ? 'rgba(76, 141, 255, 0.20)' : 'rgba(37, 99, 235, 0.12)',
      textDark: cssVar('--fg'),
      textMedium: cssVar('--fg-muted'),
      textLight: cssVar('--fg-faint'),
      textBubble: cssVar('--fg'),
      bgIconHeader: cssVar('--fg-muted'),
      fgIconHeader: cssVar('--bg-panel'),
      textHeader: cssVar('--fg'),
      textGroupHeader: cssVar('--fg-muted'),
      textHeaderSelected: '#ffffff',
      bgCell: cssVar('--bg-panel'),
      bgCellMedium: cssVar('--bg-panel-alt'),
      bgHeader: cssVar('--grid-header-bg'),
      bgHeaderHasFocus: dark ? '#343a44' : '#e3e8f0',
      bgHeaderHovered: dark ? '#313640' : '#e8ecf2',
      bgBubble: cssVar('--bg-panel-alt'),
      bgBubbleSelected: cssVar('--bg-panel'),
      bgSearchResult: 'rgba(250, 204, 21, 0.38)',
      borderColor: cssVar('--grid-line'),
      horizontalBorderColor: cssVar('--grid-line'),
      drilldownBorder: cssVar('--border'),
      linkColor: cssVar('--accent'),
      cellHorizontalPadding: 8,
      cellVerticalPadding: 3,
      headerFontStyle: `600 ${fontSize - 0.5}px`,
      baseFontStyle: `${fontSize}px`,
      markerFontStyle: `${Math.max(10, fontSize - 2)}px`,
      editorFontSize: `${fontSize}px`,
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      lineHeight: 1.4
    };
  }, [t, fontSize]);
}

export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid(p, ref) {
  const gs = useSettings((s) => s.settings.grid);
  const theme = useGridTheme(gs.fontSize);
  const editorRef = useRef<DataEditorRef>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty()
  });
  const resolved = useResolvedTheme();
  const nullColor = cssVar('--grid-null');
  const modifiedBg = cssVar('--grid-modified');

  const toSel = useCallback((s: GridSelection): GridSel => {
    const cur = s.current;
    return {
      cell: cur ? { col: cur.cell[0], row: cur.cell[1] } : null,
      range: cur ? { col: cur.range.x, row: cur.range.y, width: cur.range.width, height: cur.range.height } : null,
      rows: s.rows.toArray(),
      columns: s.columns.toArray()
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      selection: () => toSel(selection),
      selectedRows: () => {
        const rows = selection.rows.toArray();
        if (rows.length) return rows;
        const r = selection.current?.range;
        if (!r) return [];
        return Array.from({ length: r.height }, (_, i) => r.y + i);
      },
      focus: () => editorRef.current?.focus(),
      scrollTo: (row, col = 0) => editorRef.current?.scrollTo(col, row, 'both', 0, 0, { vAlign: 'center' }),
      selectCell: (row, col) => {
        const s: GridSelection = {
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
          current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] }
        };
        setSelection(s);
        p.onSelectionChange?.(toSel(s));
        editorRef.current?.scrollTo(col, row, 'both', 0, 0, { vAlign: 'center' });
      },
      clearSelection: () => setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })
    }),
    [selection, toSel, p]
  );

  const columns: GridColumn[] = useMemo(
    () =>
      p.columns.map((c, i) => {
        const sort = p.sortState?.(i);
        return {
          id: c.id,
          title: `${c.title}${sort === 'asc' ? '  ▲' : sort === 'desc' ? '  ▼' : ''}`,
          width: widths[c.id] ?? c.width ?? Math.min(280, Math.max(80, c.title.length * 9 + 36)),
          icon: c.primaryKey ? 'pk' : c.foreignKey ? 'fk' : undefined,
          hasMenu: !!p.onHeaderMenu
        } as GridColumn;
      }),
    [p.columns, widths, p.sortState, p.onHeaderMenu]
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const c = p.columns[col];
      const v = p.getValue(row, col);
      const modified = p.cellModified?.(row, col);
      const canEdit = !!p.editable && !!c && inlineEditable(c, v) && p.rowState?.(row) !== 'deleted';
      if (!c) return { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false };
      // an untouched auto-increment cell on a new row is left for the server to fill in, not a missing value
      const display = v === null && c.autoIncrement && p.rowState?.(row) === 'inserted' ? tr('(automatisch)', '(automatic)') : displayText(v, c, gs.nullText);
      const themeOverride: Partial<Theme> | undefined =
        v === null ? { textDark: nullColor, ...(modified ? { bgCell: modifiedBg } : {}) } : modified ? { bgCell: modifiedBg } : undefined;
      return {
        kind: GridCellKind.Text,
        data: editText(v, c),
        displayData: display,
        allowOverlay: canEdit,
        readonly: !canEdit,
        contentAlign: c.numeric ? 'right' : undefined,
        themeOverride,
        copyData: v === null ? '' : editText(v, c)
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.columns, p.getValue, p.cellModified, p.editable, p.rowState, gs.nullText, nullColor, modifiedBg, resolved]
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, v: EditableGridCell) => {
      const c = p.columns[col];
      if (!c || v.kind !== GridCellKind.Text) return;
      let value: EditValue = v.data;
      if (c.kind === 'binary') value = fromHex(v.data);
      // typing over a multi-row selection fills the same column in every selected row, not just the active cell
      const rowMarkers = selection.rows.toArray();
      const range = selection.current?.range;
      const rangeRows = range && range.height > 1 && col >= range.x && col < range.x + range.width ? Array.from({ length: range.height }, (_, i) => range.y + i) : [];
      const targetRows = rowMarkers.length > 1 && rowMarkers.includes(row) ? rowMarkers : rangeRows.length > 1 && rangeRows.includes(row) ? rangeRows : [row];
      for (const r of targetRows) {
        if (r !== row && p.rowState?.(r) === 'deleted') continue;
        p.onEdit?.(r, col, value);
      }
    },
    [p, selection]
  );

  const provideEditor: ProvideEditorCallback<GridCell> = useCallback(
    (cell: GridCell) => {
      if (cell.kind !== GridCellKind.Text) return undefined;
      const sel = selection.current?.cell;
      if (!sel) return undefined;
      const c = p.columns[sel[0]];
      if (!c || (c.kind !== 'enum' && c.kind !== 'set')) return undefined;
      return {
        disablePadding: true,
        editor: (props) => {
          const current = props.value.kind === GridCellKind.Text ? props.value.data : '';
          if (c.kind === 'enum') {
            return (
              <div className="ks-grid-enum">
                {c.nullable && (
                  <button type="button" className="faint" onClick={() => props.onFinishedEditing(undefined)}>
                    —
                  </button>
                )}
                {(c.enumValues ?? []).map((ev) => (
                  <button
                    key={ev}
                    type="button"
                    className={ev === current ? 'active' : ''}
                    onClick={() => props.onFinishedEditing({ ...(props.value as EditableGridCell), data: ev } as EditableGridCell)}
                  >
                    {ev || tr('(leer)', '(empty)')}
                  </button>
                ))}
              </div>
            );
          }
          const set = new Set(current ? current.split(',') : []);
          return (
            <div className="ks-grid-set">
              {(c.enumValues ?? []).map((ev) => (
                <label key={ev} className="ks-check">
                  <input
                    type="checkbox"
                    defaultChecked={set.has(ev)}
                    onChange={(e) => {
                      if (e.target.checked) set.add(ev);
                      else set.delete(ev);
                      const data = (c.enumValues ?? []).filter((x) => set.has(x)).join(',');
                      props.onChange({ ...(props.value as EditableGridCell), data } as EditableGridCell);
                    }}
                  />
                  <span>{ev}</span>
                </label>
              ))}
              <button type="button" className="ks-btn ks-btn-primary ks-btn-sm" onClick={() => props.onFinishedEditing(props.value)}>
                OK
              </button>
            </div>
          );
        }
      };
    },
    [p.columns, selection]
  );

  const getRowThemeOverride = useCallback(
    (row: number): Partial<Theme> | undefined => {
      const st = p.rowState?.(row);
      if (st === 'inserted') return { bgCell: cssVar('--grid-inserted') };
      if (st === 'deleted') return { bgCell: cssVar('--grid-deleted'), textDark: cssVar('--fg-faint') };
      if (gs.alternateRows && row % 2 === 1) return { bgCell: cssVar('--bg-panel-alt') };
      return undefined;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.rowState, gs.alternateRows, resolved]
  );

  return (
    <div className="ks-grid">
      <DataEditor
        ref={editorRef}
        columns={columns}
        rows={p.rowCount}
        getCellContent={getCellContent}
        onCellEdited={p.editable ? onCellEdited : undefined}
        provideEditor={provideEditor}
        getRowThemeOverride={getRowThemeOverride}
        theme={theme}
        headerIcons={HEADER_ICONS}
        width="100%"
        height="100%"
        rowHeight={gs.rowHeight}
        headerHeight={gs.rowHeight + 4}
        rowMarkers={gs.showRowNumbers ? { kind: 'clickable-number', startIndex: (p.rowNumberOffset ?? 0) + 1 } : 'none'}
        freezeColumns={p.freezeColumns}
        smoothScrollX
        smoothScrollY
        rangeSelect="multi-rect"
        columnSelect="multi"
        rowSelect="multi"
        getCellsForSelection
        onPaste={
          p.editable && p.onPasteCells
            ? ([col, row], values) => {
                p.onPasteCells!({ row, col }, values.map((r) => [...r]));
                return false; // we already applied it (and may have added rows for it)
              }
            : p.editable
        }
        gridSelection={selection}
        onGridSelectionChange={(s) => {
          setSelection(s);
          p.onSelectionChange?.(toSel(s));
        }}
        onColumnResize={(col, size) => setWidths((w) => ({ ...w, [String(col.id)]: size }))}
        onCellContextMenu={([col, row], e) => {
          e.preventDefault();
          const cur = selection.current;
          const inside = cur && col >= cur.range.x && col < cur.range.x + cur.range.width && row >= cur.range.y && row < cur.range.y + cur.range.height;
          if (!inside && col >= 0) {
            const s: GridSelection = {
              columns: CompactSelection.empty(),
              rows: CompactSelection.empty(),
              current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] }
            };
            setSelection(s);
            p.onSelectionChange?.(toSel(s));
          }
          const b = e.bounds;
          p.onCellContextMenu?.(row, col, { clientX: b.x + e.localEventX, clientY: b.y + e.localEventY });
        }}
        onHeaderContextMenu={(col, e) => {
          e.preventDefault();
          const b = e.bounds;
          p.onHeaderContextMenu?.(col, { clientX: b.x + e.localEventX, clientY: b.y + e.localEventY });
        }}
        onHeaderClicked={(col, e) => p.onHeaderClick?.(col, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey })}
        onColumnMoved={p.onColumnMoved}
        onHeaderMenuClick={p.onHeaderMenu ? (col, r) => p.onHeaderMenu!(col, { x: r.x, y: r.y, width: r.width, height: r.height }) : undefined}
        trailingRowOptions={p.onAppendRow ? { hint: tr('Neuer Datensatz', 'New record'), sticky: true, tint: true } : undefined}
        onRowAppended={p.onAppendRow ? () => void p.onAppendRow!() : undefined}
        onCellActivated={([col, row]) => {
          const c = p.columns[col];
          if (!c) return;
          if (!p.editable && p.onRowActivated) {
            p.onRowActivated(row);
            return;
          }
          if (!inlineEditable(c, p.getValue(row, col)) || c.kind === 'json') p.onOpenValue?.(row, col);
        }}
        onKeyDown={p.onKeyDown}
        onDelete={(sel) => {
          if (!p.editable) return false;
          // whole rows selected via the row markers → delete the records; otherwise clear the selected cells
          const rows = sel.rows.toArray();
          if (rows.length && p.onDeleteRows) {
            p.onDeleteRows(rows);
          } else if (p.onDeleteCells) {
            const cells: { row: number; col: number }[] = [];
            const r = sel.current?.range;
            if (r) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) cells.push({ row: y, col: x });
            p.onDeleteCells(cells);
          }
          return false;
        }}
        showSearch={p.searchOpen}
        onSearchClose={p.onSearchClose}
        keybindings={{ search: false }}
        verticalBorder
      />
      {p.rowCount === 0 && p.empty && <div className="ks-grid-empty">{p.empty}</div>}
    </div>
  );
});

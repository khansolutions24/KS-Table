// Virtualized, sortable object list with multi-selection (detail and list mode).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { keyCombo } from '../lib/shortcuts';

export interface OTColumn<T> {
  id: string;
  label: string;
  width: number;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null;
}

interface Props<T> {
  columns: OTColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  iconOf?: (row: T) => ReactNode;
  nameOf: (row: T) => string;
  selected: string[];
  onSelectionChange: (keys: string[]) => void;
  onOpen?: (row: T) => void;
  onContextMenu?: (e: React.MouseEvent, row: T | null, selectedKeys: string[]) => void;
  /** Extra keys (Delete, F2, Ctrl+C …); return true when handled */
  onKey?: (combo: string, selectedKeys: string[]) => boolean;
  mode?: 'detail' | 'list';
  empty?: ReactNode;
}

const ROW_H = 26;

export function ObjectTable<T>(p: Props<T>) {
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return p.rows;
    const col = p.columns.find((c) => c.id === sort.id);
    if (!col?.sortValue) return p.rows;
    const sv = col.sortValue;
    const arr = [...p.rows];
    arr.sort((a, b) => {
      const va = sv(a);
      const vb = sv(b);
      let r: number;
      if (va === null || va === undefined) r = vb === null || vb === undefined ? 0 : 1;
      else if (vb === null || vb === undefined) r = -1;
      else if (typeof va === 'number' && typeof vb === 'number') r = va - vb;
      else r = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
      return sort.desc ? -r : r;
    });
    return arr;
  }, [p.rows, p.columns, sort]);

  const keys = useMemo(() => sorted.map(p.rowKey), [sorted, p.rowKey]);
  const selectedSet = useMemo(() => new Set(p.selected), [p.selected]);

  const virt = useVirtualizer({
    count: p.mode === 'list' ? 0 : sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12
  });

  useEffect(() => {
    if (focusKey && !keys.includes(focusKey)) setFocusKey(null);
  }, [keys, focusKey]);

  const click = (e: React.MouseEvent, key: string) => {
    if (e.ctrlKey || e.metaKey) {
      p.onSelectionChange(selectedSet.has(key) ? p.selected.filter((k) => k !== key) : [...p.selected, key]);
      anchor.current = key;
    } else if (e.shiftKey && anchor.current) {
      const a = keys.indexOf(anchor.current);
      const b = keys.indexOf(key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      p.onSelectionChange(keys.slice(lo, hi + 1));
    } else {
      p.onSelectionChange([key]);
      anchor.current = key;
    }
    setFocusKey(key);
  };

  const moveFocus = (delta: number, extend: boolean) => {
    if (!keys.length) return;
    const cur = focusKey ? keys.indexOf(focusKey) : -1;
    const idx = Math.max(0, Math.min(keys.length - 1, cur < 0 ? 0 : cur + delta));
    const key = keys[idx];
    setFocusKey(key);
    if (extend && anchor.current) {
      const a = keys.indexOf(anchor.current);
      const [lo, hi] = a < idx ? [a, idx] : [idx, a];
      p.onSelectionChange(keys.slice(lo, hi + 1));
    } else {
      anchor.current = key;
      p.onSelectionChange([key]);
    }
    if (p.mode !== 'list') virt.scrollToIndex(idx, { align: 'auto' });
    else scrollRef.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const combo = keyCombo(e);
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const listCols = p.mode === 'list' ? Math.max(1, Math.floor((scrollRef.current?.clientWidth ?? 240) / 240)) : 1;
    switch (combo) {
      case 'ArrowDown':
      case 'Shift+ArrowDown':
        stop();
        moveFocus(listCols, e.shiftKey);
        return;
      case 'ArrowUp':
      case 'Shift+ArrowUp':
        stop();
        moveFocus(-listCols, e.shiftKey);
        return;
      case 'ArrowRight':
        if (p.mode === 'list') {
          stop();
          moveFocus(1, false);
        }
        return;
      case 'ArrowLeft':
        if (p.mode === 'list') {
          stop();
          moveFocus(-1, false);
        }
        return;
      case 'Home':
        stop();
        moveFocus(-1e9, false);
        return;
      case 'End':
        stop();
        moveFocus(1e9, false);
        return;
      case 'PageDown':
        stop();
        moveFocus(15, false);
        return;
      case 'PageUp':
        stop();
        moveFocus(-15, false);
        return;
      case 'Ctrl+A':
        stop();
        p.onSelectionChange(keys);
        return;
      case 'Enter': {
        stop();
        const k = focusKey ?? p.selected[0];
        const row = sorted[keys.indexOf(k)];
        if (row) p.onOpen?.(row);
        return;
      }
    }
    if (p.onKey?.(combo, p.selected)) stop();
  };

  const rowMenu = (e: React.MouseEvent, row: T | null, key: string | null) => {
    let sel = p.selected;
    if (key && !selectedSet.has(key)) {
      sel = [key];
      p.onSelectionChange(sel);
      anchor.current = key;
      setFocusKey(key);
    }
    p.onContextMenu?.(e, row, sel);
  };

  const width = (c: OTColumn<T>) => widths[c.id] ?? c.width;
  const totalWidth = p.columns.reduce((a, c) => a + width(c), 0);

  const startResize = (e: React.MouseEvent, c: OTColumn<T>) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sw = width(c);
    const move = (ev: MouseEvent) => setWidths((w) => ({ ...w, [c.id]: Math.max(40, sw + ev.clientX - sx) }));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (p.mode === 'list') {
    return (
      <div
        className="ks-ot-list"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) p.onSelectionChange([]);
        }}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            p.onSelectionChange([]);
            p.onContextMenu?.(e, null, []);
          }
        }}
      >
        {sorted.map((row) => {
          const key = p.rowKey(row);
          return (
            <div
              key={key}
              data-key={key}
              className={clsx('ks-ot-item', selectedSet.has(key) && 'selected', focusKey === key && 'focused')}
              onMouseDown={(e) => {
                if (e.button === 0) click(e, key);
              }}
              onDoubleClick={() => p.onOpen?.(row)}
              onContextMenu={(e) => rowMenu(e, row, key)}
              title={p.nameOf(row)}
            >
              {p.iconOf?.(row)}
              <span className="ellipsis">{p.nameOf(row)}</span>
            </div>
          );
        })}
        {!sorted.length && p.empty}
      </div>
    );
  }

  return (
    <div
      className="ks-ot"
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest('.ks-ot-row')) {
          p.onSelectionChange([]);
          p.onContextMenu?.(e, null, []);
        }
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('ks-ot-body')) p.onSelectionChange([]);
      }}
    >
      <div className="ks-ot-head" style={{ width: Math.max(totalWidth, 0), minWidth: '100%' }}>
        {p.columns.map((c) => (
          <div
            key={c.id}
            className={clsx('ks-ot-th', c.align === 'right' && 'right', c.sortValue && 'sortable')}
            style={{ width: width(c) }}
            onClick={() => {
              if (!c.sortValue) return;
              setSort((s) => (s?.id === c.id ? (s.desc ? null : { id: c.id, desc: true }) : { id: c.id, desc: false }));
            }}
          >
            <span className="ellipsis">{c.label}</span>
            {sort?.id === c.id && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
            <span className="ks-ot-resize" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
          </div>
        ))}
      </div>
      <div className="ks-ot-body" style={{ height: virt.getTotalSize(), width: Math.max(totalWidth, 0), minWidth: '100%' }}>
        {virt.getVirtualItems().map((vi) => {
          const row = sorted[vi.index];
          const key = keys[vi.index];
          return (
            <div
              key={key}
              className={clsx('ks-ot-row', selectedSet.has(key) && 'selected', focusKey === key && 'focused')}
              style={{ transform: `translateY(${vi.start}px)`, height: ROW_H }}
              onMouseDown={(e) => {
                if (e.button === 0) click(e, key);
              }}
              onDoubleClick={() => p.onOpen?.(row)}
              onContextMenu={(e) => rowMenu(e, row, key)}
            >
              {p.columns.map((c, ci) => (
                <div key={c.id} className={clsx('ks-ot-td', c.align === 'right' && 'right')} style={{ width: width(c) }}>
                  {ci === 0 && p.iconOf?.(row)}
                  <span className="ellipsis">{c.render(row)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {!sorted.length && <div className="ks-ot-empty">{p.empty}</div>}
    </div>
  );
}

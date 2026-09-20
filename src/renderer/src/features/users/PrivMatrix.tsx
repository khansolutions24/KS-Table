// Checkbox matrix: rows (objects or accounts) × privileges.

import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface MatrixColumn {
  priv: string;
  title?: string;
}

export interface MatrixRow {
  key: string;
  icon?: ReactNode;
  label: ReactNode;
  title?: string;
  has(priv: string): boolean;
  applicable(priv: string): boolean;
  /** Differs from the state on the server */
  changed?(priv: string): boolean;
}

export function PrivMatrix({
  head,
  columns,
  rows,
  selected,
  onSelect,
  onToggle,
  onRowMenu,
  empty,
  disabled
}: {
  head: ReactNode;
  columns: MatrixColumn[];
  rows: MatrixRow[];
  selected: string[];
  onSelect(keys: string[]): void;
  onToggle(rowKey: string, priv: string, value: boolean): void;
  onRowMenu?(e: React.MouseEvent, rowKey: string): void;
  empty?: ReactNode;
  disabled?: boolean;
}) {
  const toggleColumn = (priv: string) => {
    if (disabled) return;
    const target = rows.filter((r) => r.applicable(priv) && (!selected.length || selected.includes(r.key)));
    if (!target.length) return;
    const all = target.every((r) => r.has(priv));
    for (const r of target) if (r.has(priv) === all) onToggle(r.key, priv, !all);
  };
  return (
    <div className="ks-users-matrix-wrap">
      <table className="ks-users-matrix">
        <thead>
          <tr>
            <th className="obj">{head}</th>
            {columns.map((c) => (
              <th
                key={c.priv}
                title={c.title || c.priv}
                className="priv"
                onClick={() => toggleColumn(c.priv)}
              >
                <span>{c.priv}</span>
              </th>
            ))}
            <th className="fill" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sel = selected.includes(r.key);
            return (
              <tr key={r.key} className={clsx(sel && 'selected')} onContextMenu={(e) => onRowMenu?.(e, r.key)}>
                <td
                  className="obj"
                  title={r.title}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    if (e.ctrlKey || e.metaKey) onSelect(sel ? selected.filter((k) => k !== r.key) : [...selected, r.key]);
                    else onSelect([r.key]);
                  }}
                >
                  <div className="ks-users-matrix-obj">
                    {r.icon}
                    <span className="ellipsis">{r.label}</span>
                  </div>
                </td>
                {columns.map((c) =>
                  r.applicable(c.priv) ? (
                    <td key={c.priv} className={clsx('cell', r.changed?.(c.priv) && 'changed')}>
                      <input
                        type="checkbox"
                        checked={r.has(c.priv)}
                        disabled={disabled}
                        title={c.priv}
                        onChange={(e) => onToggle(r.key, c.priv, e.target.checked)}
                      />
                    </td>
                  ) : (
                    <td key={c.priv} className="na">
                      ·
                    </td>
                  )
                )}
                <td className="fill" />
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <div className="ks-users-matrix-empty">{empty}</div>}
    </div>
  );
}

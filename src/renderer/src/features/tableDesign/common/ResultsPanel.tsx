// Result sets and messages of statements executed by a designer (view preview, routine execution).

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CircleCheck, CircleX, X } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { StatementResult } from '@shared/types';
import { formatDuration, formatNumber } from '@shared/util';
import { DataGrid } from '../../../components/grid/DataGrid';
import { columnFromResult } from '../../../components/grid/cellFormat';
import { IconButton, TabStrip } from '../../../components/ui/controls';
import './designer.css';

function ResultGrid({ result }: { result: StatementResult }) {
  const columns = useMemo(() => (result.columns ?? []).map((c, i) => columnFromResult(c, { id: `${i}${c.name}` })), [result]);
  const rows = result.rows ?? [];
  return (
    <DataGrid
      columns={columns}
      rowCount={rows.length}
      getValue={(r, c) => rows[r]?.[c] ?? null}
      empty={<span>{tr('Keine Datensätze', 'No records')}</span>}
    />
  );
}

function Messages({ results }: { results: StatementResult[] }) {
  return (
    <div className="ks-dsg-msgs selectable">
      {results.map((r, i) => (
        <div key={i} className={`ks-dsg-msg ${r.kind === 'error' ? 'error' : ''}`}>
          {r.kind === 'error' ? <CircleX size={14} className="danger-text" /> : <CircleCheck size={14} className="success-text" />}
          <div className="ks-dsg-msg-text">
            <div className="mono ks-dsg-msg-sql">{r.sql.length > 300 ? `${r.sql.slice(0, 300)}…` : r.sql}</div>
            <div>
              {r.kind === 'error'
                ? `${r.error?.errno ? `${r.error.errno}: ` : ''}${r.error?.message ?? ''}`
                : r.kind === 'resultset'
                  ? tr('{n} Datensätze{t}', '{n} records{t}', {
                      n: formatNumber(r.rows?.length ?? 0),
                      t: r.truncated ? tr(' (gekürzt)', ' (truncated)') : ''
                    })
                  : tr('{n} Zeilen betroffen', '{n} rows affected', { n: formatNumber(r.affectedRows ?? 0) })}
              <span className="faint"> · {formatDuration(r.durationMs)}</span>
            </div>
          </div>
        </div>
      ))}
      {!results.length && <div className="faint">{tr('Keine Meldungen', 'No messages')}</div>}
    </div>
  );
}

export function ResultsPanel({
  results,
  onClose,
  labelFor,
  toolbar
}: {
  results: StatementResult[];
  onClose?: () => void;
  /** Custom tab label for a result set (index among all results) */
  labelFor?: (r: StatementResult, index: number) => string | undefined;
  toolbar?: ReactNode;
}) {
  const sets = useMemo(() => results.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'resultset'), [results]);
  const firstError = results.some((r) => r.kind === 'error');
  const [tab, setTab] = useState('msg');
  useEffect(() => setTab(firstError || !sets.length ? 'msg' : 'r0'), [results, sets.length, firstError]);
  const current = tab.startsWith('r') ? sets[Number(tab.slice(1))]?.r : undefined;
  return (
    <div className="ks-dsg-results">
      <TabStrip
        tabs={[
          ...sets.map((s, k) => ({
            id: `r${k}`,
            label: labelFor?.(s.r, s.i) ?? tr('Ergebnis {n}', 'Result {n}', { n: k + 1 }),
            badge: formatNumber(s.r.rows?.length ?? 0)
          })),
          { id: 'msg', label: tr('Meldungen', 'Messages') }
        ]}
        value={tab}
        onChange={setTab}
        right={
          <>
            {toolbar}
            {onClose && <IconButton icon={<X size={14} />} title={tr('Ergebnis schließen', 'Close result')} onClick={onClose} />}
          </>
        }
      />
      <div className="ks-dsg-results-body">{current ? <ResultGrid key={tab} result={current} /> : <Messages results={results} />}</div>
    </div>
  );
}

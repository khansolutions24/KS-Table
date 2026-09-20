// Data profiling: statistics for every column of a table (NULLs, distinct and empty values,
// min / max / mean / median, lengths), the most frequent values and the distribution of the
// selected column. Runs on its own session so long aggregations can be cancelled.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Copy, KeyRound, ListFilter, RefreshCw, Square, Table2 } from 'lucide-react';
import type { CellValue, ColumnMeta, StatementResult } from '@shared/types';
import { locale, tr } from '@shared/i18n';
import { quoteString } from '@shared/sql/quote';
import { api, errorMessage } from '../../api/client';
import { openTable } from '../../actions/objects';
import { EmptyState, ProgressBar, Select, Spinner, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { toast } from '../../components/Toast';
import { useTabs, type TabProps } from '../../store/tabs';
import { isUserCancelled, openSessionWithPrompt } from '../../store/workspace';
import {
  cellNum,
  cellText,
  colClass,
  histogramPlan,
  medianSql,
  parseMedian,
  statsQuery,
  TEXT_PREFIX,
  TOP_LIMIT,
  topValuesSql,
  uniqueCountSql,
  valueFilter,
  type ColClass,
  type ColStats,
  type HistBucket,
  type HistPlan
} from './profileSql';
import './profiling.css';

interface Params {
  connectionId: string;
  database: string;
  table: string;
}

interface Details {
  top: { value: CellValue; n: number }[];
  unique: number | null;
  median: string | null;
  hist: HistBucket[] | null;
  histMode: HistPlan['mode'] | null;
  error?: string;
}

/** Columns per statistics query */
const CHUNK = 25;
const SAMPLES = [0, 1000, 10000, 100000, 1000000];
/** Tables with more (estimated) rows start with a sample */
const SAMPLE_THRESHOLD = 200000;

// ───────────────────────── formatting ─────────────────────────

interface Formats {
  loc: string;
  int: Intl.NumberFormat;
  pct: Intl.NumberFormat;
  pctFine: Intl.NumberFormat;
  compact: Intl.NumberFormat;
  dec: Map<number, Intl.NumberFormat>;
}

let formats: Formats | null = null;

function fmts(): Formats {
  const loc = locale();
  if (!formats || formats.loc !== loc) {
    formats = {
      loc,
      int: new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }),
      pct: new Intl.NumberFormat(loc, { style: 'percent', maximumFractionDigits: 1 }),
      pctFine: new Intl.NumberFormat(loc, { style: 'percent', maximumFractionDigits: 3 }),
      compact: new Intl.NumberFormat(loc, { notation: 'compact', maximumFractionDigits: 1 }),
      dec: new Map()
    };
  }
  return formats;
}

const fmtInt = (n: number | null | undefined): string => (n === null || n === undefined ? '–' : fmts().int.format(n));

function fmtNum(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const f = fmts();
  let nf = f.dec.get(digits);
  if (!nf) {
    nf = new Intl.NumberFormat(f.loc, { maximumFractionDigits: digits });
    f.dec.set(digits, nf);
  }
  return nf.format(n);
}

function fmtPct(part: number | null | undefined, whole: number | null | undefined): string {
  if (part === null || part === undefined || !whole) return '–';
  const p = part / whole;
  return (p > 0 && p < 0.001 ? fmts().pctFine : fmts().pct).format(p);
}

const lengthUnit = (cls: ColClass): string => (cls === 'binary' || cls === 'spatial' ? 'Bytes' : tr('Zeichen', 'characters'));

function valueText(v: CellValue, cls: ColClass): string {
  const s = cellText(v);
  if (s === null) return 'NULL';
  if (s === '') return tr('(leer)', '(empty)');
  if (cls === 'binary') return `0x${s}`;
  return [...s].length >= TEXT_PREFIX && cls !== 'number' ? `${s}…` : s;
}

function bucketLabel(b: HistBucket): string {
  if (b.label) return b.label;
  if (b.from === undefined || b.to === undefined) return '';
  return b.from === b.to ? fmtNum(b.from, 3) : `${fmtNum(b.from, 3)} – ${fmtNum(b.to, 3)}`;
}

async function run(sid: string, sql: string): Promise<StatementResult[]> {
  const r = await api.query.execute(sid, sql, { history: false, maxRows: 0 });
  if (r.cancelled) throw new Error(tr('Die Analyse wurde abgebrochen.', 'The analysis was cancelled.'));
  const failed = r.results.find((x) => x.kind === 'error');
  if (failed) throw new Error(failed.error?.message ?? tr('SQL-Fehler', 'SQL error'));
  return r.results;
}

// ───────────────────────── tab ─────────────────────────

export default function ProfilingTab({ tab }: TabProps) {
  const p = tab.params as unknown as Params;
  const [sid, setSid] = useState<string | null>(null);
  const [cols, setCols] = useState<ColumnMeta[]>([]);
  const [isView, setIsView] = useState(false);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [sample, setSample] = useState<number | null>(null);
  const [stats, setStats] = useState<(ColStats | null)[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [details, setDetails] = useState<Record<string, Details | 'loading'>>({});
  const gen = useRef(0);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  useEffect(() => {
    let alive = true;
    let opened: string | null = null;
    void (async () => {
      try {
        const s = await openSessionWithPrompt(p.connectionId, p.database);
        if (!alive) {
          void api.session.close(s.sessionId);
          return;
        }
        opened = s.sessionId;
        const columns = await api.meta.columns(s.sessionId, p.database, p.table);
        const info = await run(
          s.sessionId,
          `SELECT TABLE_ROWS, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${quoteString(p.database)} AND TABLE_NAME = ${quoteString(p.table)}`
        ).catch(() => null);
        if (!alive) return;
        const row = info?.[0]?.rows?.[0];
        const est = cellNum(row?.[0]);
        setCols(columns);
        setIsView(cellText(row?.[1]) === 'VIEW');
        setEstimate(est);
        setSample(est !== null && est > SAMPLE_THRESHOLD ? 100000 : 0);
        setSid(s.sessionId);
      } catch (e) {
        if (alive) setError(isUserCancelled(e) ? tr('Die Anmeldung wurde abgebrochen.', 'Sign-in was cancelled.') : errorMessage(e));
      }
    })();
    return () => {
      alive = false;
      gen.current++;
      if (opened) void api.session.close(opened);
    };
  }, [p.connectionId, p.database, p.table]);

  const profile = useCallback(async () => {
    if (!sid || sample === null || !cols.length) return;
    const g = ++gen.current;
    setRunning(true);
    setError(null);
    setStats(cols.map(() => null));
    setDetails({});
    setProgress(0);
    setElapsed(null);
    const t0 = performance.now();
    try {
      for (let i = 0; i < cols.length; i += CHUNK) {
        const q = statsQuery(p.database, p.table, cols.slice(i, i + CHUNK), sample);
        const res = await run(sid, q.sql);
        if (g !== gen.current) return;
        const parsed = q.parse(res[0]?.rows?.[0] ?? []);
        setTotal(parsed.total);
        setStats((prev) => {
          const next = [...prev];
          parsed.stats.forEach((s, k) => (next[i + k] = s));
          return next;
        });
        setProgress(Math.min(1, (i + CHUNK) / cols.length));
      }
      setElapsed(performance.now() - t0);
    } catch (e) {
      if (g === gen.current) setError(errorMessage(e));
    } finally {
      if (g === gen.current) setRunning(false);
    }
  }, [sid, sample, cols, p.database, p.table]);

  useEffect(() => {
    void profile();
  }, [profile]);

  const col = cols[sel];
  const st = stats[sel] ?? null;
  const dkey = col ? `${sample}:${col.name}` : '';
  const det = details[dkey];

  // details of the selected column: most frequent values, unique count, median, distribution
  useEffect(() => {
    if (!sid || running || !col || !st || det || sample === null || total === null) return;
    const g = gen.current;
    setDetails((d) => ({ ...d, [dkey]: 'loading' }));
    void (async () => {
      const plan = histogramPlan(p.database, p.table, col, sample, st);
      const parts: { kind: 'top' | 'unique' | 'median' | 'hist'; sql: string }[] = [{ kind: 'top', sql: topValuesSql(p.database, p.table, col, sample) }];
      const unique = uniqueCountSql(p.database, p.table, col, sample);
      if (unique) parts.push({ kind: 'unique', sql: unique });
      const median = medianSql(p.database, p.table, col, sample, total - st.nulls);
      if (median) parts.push({ kind: 'median', sql: median });
      if (plan) parts.push({ kind: 'hist', sql: plan.sql });
      const out: Details = { top: [], unique: null, median: null, hist: null, histMode: plan?.mode ?? null };
      try {
        const res = await run(sid, parts.map((x) => x.sql).join(';\n'));
        parts.forEach((part, i) => {
          const rows = res[i]?.rows ?? [];
          if (part.kind === 'top') out.top = rows.map((r) => ({ value: r[0] ?? null, n: cellNum(r[1]) ?? 0 }));
          else if (part.kind === 'unique') out.unique = cellNum(rows[0]?.[0]);
          else if (part.kind === 'median') out.median = parseMedian(col, rows);
          else if (plan) out.hist = plan.parse(rows);
        });
      } catch (e) {
        out.error = errorMessage(e);
      }
      if (g !== gen.current) return;
      setDetails((d) => ({ ...d, [dkey]: out }));
    })();
  }, [sid, running, col, st, det, dkey, sample, total, p.database, p.table]);

  useEffect(() => {
    rowRefs.current[sel]?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const cancel = () => {
    gen.current++;
    setRunning(false);
    if (sid) void api.query.cancel(sid);
  };

  const showRows = (where?: string) => {
    if (!where) {
      openTable(p.connectionId, p.database, p.table, isView);
      return;
    }
    useTabs.getState().open({
      kind: 'tableData',
      key: `data:${p.connectionId}:${p.database}:${p.table}:${where}`,
      title: `${p.table} @${p.database} (${tr('gefiltert', 'filtered')})`,
      icon: isView ? 'view' : 'table',
      params: { connectionId: p.connectionId, database: p.database, table: p.table, view: isView, where },
      connectionId: p.connectionId,
      subtitle: where
    });
  };

  const copy = () => {
    const head = [
      tr('Spalte', 'Column'),
      tr('Typ', 'Type'),
      tr('Zeilen', 'Rows'),
      'NULL',
      'Distinct',
      tr('Leer', 'Empty'),
      'Min',
      'Max',
      tr('Mittelwert', 'Mean'),
      tr('Standardabweichung', 'Std. deviation'),
      tr('Länge min', 'Length min'),
      tr('Länge max', 'Length max'),
      tr('Länge Ø', 'Length avg')
    ];
    const lines = cols.map((c, i) => {
      const s = stats[i];
      return [c.name, c.columnType, total, s?.nulls, s?.distinct, s?.empty, s?.min, s?.max, s?.avg, s?.stddev, s?.minLen, s?.maxLen, s?.avgLen]
        .map((v) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' ')))
        .join('\t');
    });
    void navigator.clipboard
      .writeText([head.join('\t'), ...lines].join('\n'))
      .then(() => toast(tr('Datenprofil in die Zwischenablage kopiert', 'Data profile copied to the clipboard'), 'success'));
  };

  const onListKey = (e: React.KeyboardEvent) => {
    let next = sel;
    if (e.key === 'ArrowDown') next = Math.min(cols.length - 1, sel + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, sel - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = cols.length - 1;
    else if (e.key === 'Enter') {
      showRows();
      return;
    } else return;
    e.preventDefault();
    setSel(next);
  };

  if (!sid || sample === null) {
    if (error) {
      return (
        <EmptyState title={tr('Datenprofil nicht verfügbar', 'Data profile not available')}>
          <span className="selectable">{error}</span>
        </EmptyState>
      );
    }
    return (
      <div className="ks-tab-loading">
        <Spinner size={22} />
      </div>
    );
  }

  const sampled = sample > 0 && estimate !== null && estimate > sample;
  const status = running
    ? tr('Analysiere {n} Spalten …', 'Analyzing {n} columns …', { n: cols.length })
    : total !== null
      ? [
          tr('{n} Zeilen analysiert', '{n} rows analyzed', { n: fmtInt(total) }),
          sampled ? tr('Stichprobe aus ca. {n}', 'sample of approx. {n}', { n: fmtInt(estimate) }) : null,
          elapsed !== null ? `${fmtNum(elapsed / 1000, 2)} s` : null
        ]
          .filter(Boolean)
          .join(' · ')
      : '';

  return (
    <div
      className="ks-prof"
      onKeyDown={(e) => {
        if (e.key === 'F5') {
          e.preventDefault();
          e.stopPropagation();
          if (!running) void profile();
        }
      }}
    >
      <Toolbar>
        <ToolbarButton icon={<RefreshCw size={15} />} label={tr('Aktualisieren', 'Refresh')} title={tr('Aktualisieren (F5)', 'Refresh (F5)')} disabled={running} onClick={() => void profile()} />
        {running && <ToolbarButton icon={<Square size={14} />} label={tr('Abbrechen', 'Stop')} onClick={cancel} />}
        <ToolbarSep />
        <span className="ks-prof-label">{tr('Zeilen', 'Rows')}</span>
        <Select
          value={String(sample)}
          onChange={(v) => setSample(Number(v))}
          disabled={running}
          style={{ width: 180 }}
          options={SAMPLES.map((n) => ({ value: String(n), label: n ? tr('Erste {n} Zeilen', 'First {n} rows', { n: fmtInt(n) }) : tr('Alle Zeilen', 'All rows') }))}
        />
        <ToolbarSep />
        <ToolbarButton icon={<Copy size={15} />} label={tr('Kopieren', 'Copy')} title={tr('Übersicht als Tabelle kopieren', 'Copy the overview as a table')} disabled={!stats.some(Boolean)} onClick={copy} />
        <ToolbarButton icon={<Table2 size={15} />} label={tr('Daten anzeigen', 'Show Data')} onClick={() => showRows()} />
        <div className="spacer" />
        <span className="ks-prof-status">{status}</span>
      </Toolbar>
      {running && <ProgressBar value={progress || null} className="ks-prof-progress" />}
      {error && <div className="ks-prof-error selectable">{error}</div>}
      <div className="ks-prof-body">
        <div className="ks-prof-list" tabIndex={0} onKeyDown={onListKey}>
          <table className="ks-prof-table">
            <thead>
              <tr>
                <th>{tr('Spalte', 'Column')}</th>
                <th>{tr('Typ', 'Type')}</th>
                <th className="num">NULL</th>
                <th className="num">Distinct</th>
                <th className="num">{tr('Leer', 'Empty')}</th>
                <th>Min</th>
                <th>Max</th>
                <th className="num">{tr('Ø Wert / Länge', 'Avg value / length')}</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c, i) => {
                const s = stats[i];
                const nonNull = s && total !== null ? total - s.nulls : null;
                const cls = colClass(c);
                return (
                  <tr key={c.name} ref={(el) => void (rowRefs.current[i] = el)} className={clsx(i === sel && 'sel')} onClick={() => setSel(i)} onDoubleClick={() => showRows()}>
                    <td className="name" title={c.comment || c.name}>
                      {c.key === 'PRI' && <KeyRound size={12} className="ks-prof-key" />}
                      {c.name}
                    </td>
                    <td className="type">{c.columnType}</td>
                    <td className="num">{s ? <Meter part={s.nulls} whole={total} /> : running ? <Spinner size={10} /> : ''}</td>
                    <td className="num">
                      {s?.distinct !== null && s?.distinct !== undefined ? (
                        <>
                          {fmtInt(s.distinct)}
                          <span className="ks-prof-sub">{fmtPct(s.distinct, nonNull)}</span>
                        </>
                      ) : s ? (
                        '–'
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="num">{s ? (s.empty !== null ? fmtInt(s.empty) : '–') : ''}</td>
                    <td className="mono" title={s?.min ?? undefined}>
                      {s?.min ?? (s ? '–' : '')}
                    </td>
                    <td className="mono" title={s?.max ?? undefined}>
                      {s?.max ?? (s ? '–' : '')}
                    </td>
                    <td className="num">{s ? (s.avg !== null ? fmtNum(s.avg, 2) : s.avgLen !== null ? `${fmtNum(s.avgLen, 1)} ${lengthUnit(cls)}` : '–') : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="ks-prof-detail">{col && <ColumnDetails col={col} st={st} total={total} det={det} onFilter={showRows} />}</div>
      </div>
    </div>
  );
}

function Meter({ part, whole }: { part: number; whole: number | null }) {
  const ratio = whole ? part / whole : 0;
  return (
    <span className="ks-prof-meter-wrap" title={`${fmtInt(part)} / ${fmtInt(whole)}`}>
      <span className="ks-prof-meter">
        <i style={{ width: `${ratio > 0 ? Math.max(4, ratio * 100) : 0}%` }} />
      </span>
      <span className="ks-prof-meter-num">{fmtPct(part, whole)}</span>
    </span>
  );
}

// ───────────────────────── selected column ─────────────────────────

interface Card {
  k: string;
  v: ReactNode;
  s?: ReactNode;
  mono?: boolean;
  title?: string;
}

function ColumnDetails({
  col,
  st,
  total,
  det,
  onFilter
}: {
  col: ColumnMeta;
  st: ColStats | null;
  total: number | null;
  det: Details | 'loading' | undefined;
  onFilter: (where: string) => void;
}) {
  const [asTable, setAsTable] = useState(false);
  const cls = colClass(col);
  const d = det && det !== 'loading' ? det : null;
  const nonNull = st && total !== null ? total - st.nulls : null;
  const unit = lengthUnit(cls);

  const cards: Card[] = [];
  if (st && total !== null) {
    cards.push({ k: tr('Zeilen', 'Rows'), v: fmtInt(total) });
    cards.push({ k: tr('Mit Wert', 'With value'), v: fmtInt(nonNull), s: fmtPct(nonNull, total) });
    cards.push({ k: 'NULL', v: fmtInt(st.nulls), s: fmtPct(st.nulls, total) });
    if (st.distinct !== null) cards.push({ k: tr('Verschiedene Werte', 'Distinct values'), v: fmtInt(st.distinct), s: nonNull ? fmtPct(st.distinct, nonNull) : undefined });
    if (d?.unique !== null && d?.unique !== undefined) cards.push({ k: tr('Einmalige Werte', 'Unique values'), v: fmtInt(d.unique), s: tr('kommen genau einmal vor', 'occur exactly once') });
    if (st.empty !== null) cards.push({ k: tr('Leer', 'Empty'), v: fmtInt(st.empty), s: fmtPct(st.empty, total) });
    if (st.zeros !== null) cards.push({ k: tr('Wert 0', 'Value 0'), v: fmtInt(st.zeros), s: fmtPct(st.zeros, total) });
    if (st.negatives !== null) cards.push({ k: tr('Negativ', 'Negative'), v: fmtInt(st.negatives), s: fmtPct(st.negatives, total) });
    const monoValues = cls !== 'number' && cls !== 'bit';
    if (st.min !== null) cards.push({ k: tr('Minimum', 'Minimum'), v: st.min, mono: monoValues, title: st.min });
    if (st.max !== null) cards.push({ k: tr('Maximum', 'Maximum'), v: st.max, mono: monoValues, title: st.max });
    if (st.avg !== null) cards.push({ k: tr('Mittelwert', 'Mean'), v: fmtNum(st.avg) });
    if (d?.median !== null && d?.median !== undefined) {
      const m = cls === 'number' || cls === 'bit' ? fmtNum(Number(d.median)) : d.median;
      cards.push({ k: 'Median', v: m, mono: cls !== 'number' && cls !== 'bit', title: d.median });
    }
    if (st.stddev !== null) cards.push({ k: tr('Standardabweichung', 'Std. deviation'), v: fmtNum(st.stddev) });
    if (st.minLen !== null) cards.push({ k: tr('Länge min / max', 'Length min / max'), v: `${fmtInt(st.minLen)} / ${fmtInt(st.maxLen)}`, s: unit });
    if (st.avgLen !== null) cards.push({ k: tr('Länge Ø', 'Avg length'), v: fmtNum(st.avgLen, 1), s: unit });
  }

  const badges = [
    col.key === 'PRI' ? tr('Primärschlüssel', 'Primary key') : col.key === 'UNI' ? 'UNIQUE' : col.key === 'MUL' ? tr('Index', 'Index') : null,
    col.nullable ? null : 'NOT NULL',
    /auto_increment/i.test(col.extra) ? 'AUTO_INCREMENT' : null,
    col.generationExpression ? tr('Generiert', 'Generated') : null
  ].filter((b): b is string => !!b);

  const maxTop = d ? Math.max(1, ...d.top.map((t) => t.n)) : 1;
  const histTitle =
    d?.histMode === 'length'
      ? tr('Längenverteilung ({u})', 'Length distribution ({u})', { u: unit })
      : d?.histMode === 'date'
        ? tr('Verteilung über die Zeit', 'Distribution over time')
        : tr('Werteverteilung', 'Value distribution');

  return (
    <div className="ks-prof-col">
      <div className="ks-prof-col-name selectable">{col.name}</div>
      <div className="ks-prof-col-type mono">{col.columnType}</div>
      {badges.length > 0 && (
        <div className="ks-prof-badges">
          {badges.map((b) => (
            <span key={b} className="ks-prof-badge">
              {b}
            </span>
          ))}
        </div>
      )}
      {col.comment && <div className="ks-prof-comment">{col.comment}</div>}

      {!st ? (
        <div className="ks-prof-wait">
          <Spinner size={14} /> {tr('Wird analysiert …', 'Analyzing …')}
        </div>
      ) : (
        <>
          <div className="ks-prof-cards">
            {cards.map((c) => (
              <div key={c.k} className="ks-prof-card" title={c.title}>
                <div className="k">{c.k}</div>
                <div className={clsx('v', c.mono && 'mono')}>{c.v}</div>
                {c.s && <div className="s">{c.s}</div>}
              </div>
            ))}
          </div>

          <div className="ks-prof-h">
            {tr('Häufigste Werte', 'Most frequent values')}
            <span className="ks-prof-h-note">Top {TOP_LIMIT}</span>
          </div>
          {!d ? (
            <div className="ks-prof-wait">
              <Spinner size={14} />
            </div>
          ) : d.error ? (
            <div className="ks-prof-error selectable">{d.error}</div>
          ) : d.top.length === 0 ? (
            <div className="muted">{tr('Keine Daten', 'No data')}</div>
          ) : (
            <div className="ks-prof-top" role="list">
              {d.top.map((t, i) => {
                const text = valueText(t.value, cls);
                const special = t.value === null || cellText(t.value) === '';
                return (
                  <div
                    key={i}
                    role="listitem"
                    className="ks-prof-top-row"
                    title={`${text}\n${fmtInt(t.n)} · ${fmtPct(t.n, total)}`}
                    onDoubleClick={() => onFilter(valueFilter(col, t.value))}
                  >
                    <span className={clsx('val', special && 'special')}>{text}</span>
                    <span className="bar">
                      <i style={{ width: `${(t.n / maxTop) * 100}%` }} />
                    </span>
                    <span className="cnt">{fmtInt(t.n)}</span>
                    <span className="pct">{fmtPct(t.n, total)}</span>
                    <button type="button" className="act" title={tr('Zeilen mit diesem Wert anzeigen', 'Show rows with this value')} onClick={() => onFilter(valueFilter(col, t.value))}>
                      <ListFilter size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {d?.hist && d.hist.length > 0 && !!nonNull && (
            <>
              <div className="ks-prof-h">
                {histTitle}
                <div className="spacer" />
                <button type="button" className="ks-prof-link" onClick={() => setAsTable((v) => !v)}>
                  {asTable ? tr('Als Diagramm', 'As chart') : tr('Als Tabelle', 'As table')}
                </button>
              </div>
              {asTable ? <HistTable buckets={d.hist} total={nonNull} /> : <Histogram buckets={d.hist} total={nonNull} title={histTitle} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────── distribution ─────────────────────────

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Axis maximum: 1, 2, 2.5, 5 × 10^n (even below 10 so the middle grid line is an integer) */
function niceMax(v: number): number {
  if (v < 10) return Math.max(2, Math.ceil(v / 2) * 2);
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

/** Bar with rounded data end, square at the baseline */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const b = y + h;
  return `M${x},${b}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${b}Z`;
}

const CH = 184;
const PAD = { top: 10, right: 10, bottom: 24, left: 46 };

function Histogram({ buckets, total, title }: { buckets: HistBucket[]; total: number; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  const max = niceMax(Math.max(1, ...buckets.map((b) => b.n)));
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = CH - PAD.top - PAD.bottom;
  const slot = plotW / buckets.length;
  const barW = Math.max(1, slot - 2);
  const y = (n: number) => PAD.top + plotH - (n / max) * plotH;

  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const ranged = first.label === '' && first.from !== first.to;
  const mid = Math.floor((buckets.length - 1) / 2);
  // ranges: label the bucket boundary in the middle; single values / dates: the middle bucket
  const half = Math.round(buckets.length / 2);
  const xLabels: { x: number; anchor: 'start' | 'middle' | 'end'; text: string }[] =
    buckets.length === 1
      ? [{ x: PAD.left + plotW / 2, anchor: 'middle', text: bucketLabel(first) }]
      : [
          { x: PAD.left, anchor: 'start', text: ranged ? fmtNum(first.from, 3) : bucketLabel(first) },
          ...(buckets.length >= 5
            ? [
                ranged
                  ? { x: PAD.left + half * slot, anchor: 'middle' as const, text: fmtNum(buckets[half].from, 3) }
                  : { x: PAD.left + (mid + 0.5) * slot, anchor: 'middle' as const, text: bucketLabel(buckets[mid]) }
              ]
            : []),
          { x: PAD.left + plotW, anchor: 'end', text: ranged ? fmtNum(last.to, 3) : bucketLabel(last) }
        ];

  const hb = hover ? buckets[hover.i] : null;

  return (
    <div className="ks-prof-hist" ref={ref}>
      {width > 0 && (
        <svg width={width} height={CH} role="img" aria-label={title}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(max * f)} y2={y(max * f)} className={f === 0 ? 'axis' : 'grid'} />
              <text x={PAD.left - 6} y={y(max * f)} textAnchor="end" dominantBaseline="middle">
                {fmts().compact.format(max * f)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const h = (b.n / max) * plotH;
            const x = PAD.left + i * slot + (slot - barW) / 2;
            return b.n > 0 ? <path key={i} d={barPath(x, y(b.n), barW, Math.max(h, 1))} className={clsx('bar', hover?.i === i && 'hover')} /> : null;
          })}
          {buckets.map((_, i) => (
            <rect
              key={`hit${i}`}
              x={PAD.left + i * slot}
              y={PAD.top}
              width={slot}
              height={plotH}
              fill="transparent"
              onMouseMove={(e) => setHover({ i, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
            />
          ))}
          {xLabels.map((l, i) => (
            <text key={i} x={l.x} y={CH - 6} textAnchor={l.anchor}>
              {l.text}
            </text>
          ))}
        </svg>
      )}
      {hover && hb && (
        <div className="ks-prof-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="t">{bucketLabel(hb)}</div>
          <div>
            {fmtInt(hb.n)} · {fmtPct(hb.n, total)}
          </div>
        </div>
      )}
    </div>
  );
}

function HistTable({ buckets, total }: { buckets: HistBucket[]; total: number }) {
  return (
    <table className="ks-prof-table ks-prof-htable">
      <thead>
        <tr>
          <th>{tr('Bereich', 'Range')}</th>
          <th className="num">{tr('Anzahl', 'Count')}</th>
          <th className="num">%</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b, i) => (
          <tr key={i}>
            <td className="mono">{bucketLabel(b)}</td>
            <td className="num">{fmtInt(b.n)}</td>
            <td className="num">{fmtPct(b.n, total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

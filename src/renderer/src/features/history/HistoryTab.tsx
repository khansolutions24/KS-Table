// History log of all executed SQL statements (live updates, filters, detail pane, export).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleX, Copy, Download, FilePlus, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { HistoryEntry } from '@shared/types';
import { formatDateTime, formatDuration, formatNumber } from '@shared/util';
import { api, onEvent } from '../../api/client';
import { newQuery } from '../../actions/query';
import { ObjectTable, type OTColumn } from '../../components/ObjectTable';
import { SqlHighlight } from '../../components/SqlHighlight';
import { toast } from '../../components/Toast';
import { Button, EmptyState, SearchInput, Select, Spinner, TextInput, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { showContextMenu } from '../../components/ui/Menu';
import { pickSaveFile } from '../../lib/files';
import { useSettings } from '../../store/settings';
import type { TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import './history.css';

const LIMIT = 100_000;
const oneLine = (s: string) => (s.length > 400 ? s.slice(0, 400) : s).replace(/\s+/g, ' ');

function statementText(e: HistoryEntry): string {
  const sql = e.sql.trim();
  return /;\s*$/.test(sql) || /^delimiter\b/i.test(sql) ? sql : `${sql};`;
}

export default function HistoryTab({ active }: TabProps) {
  const profiles = useWorkspace((s) => s.profiles);
  const enabled = useSettings((s) => s.settings.historyEnabled);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const pending = useRef<HistoryEntry[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [conn, setConn] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'ok' | 'error'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await api.history.list({ limit: LIMIT }));
      pending.current = [];
      setPendingCount(0);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return onEvent('history:added', (e) => {
      if (pausedRef.current) {
        pending.current.push(e);
        setPendingCount(pending.current.length);
      } else setEntries((list) => [e, ...list]);
    });
  }, [load]);

  const resume = () => {
    setPaused(false);
    if (pending.current.length) {
      const add = [...pending.current].reverse();
      pending.current = [];
      setPendingCount(0);
      setEntries((list) => [...add, ...list]);
    }
  };

  const connections = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) m.set(e.connectionId, profiles.find((p) => p.id === e.connectionId)?.name ?? e.connectionName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries, profiles]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromT = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toT = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    return entries.filter(
      (e) =>
        (!conn || e.connectionId === conn) &&
        (status === 'all' || (status === 'ok') === e.ok) &&
        (fromT === null || e.time >= fromT) &&
        (toT === null || e.time <= toT) &&
        (!q || e.sql.toLowerCase().includes(q) || (e.database ?? '').toLowerCase().includes(q) || (e.error ?? '').toLowerCase().includes(q))
    );
  }, [entries, conn, status, from, to, search]);

  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const selEntries = selected.map((id) => byId.get(id)).filter((e): e is HistoryEntry => !!e).sort((a, b) => a.time - b.time);
  const detail = selEntries.length === 1 ? selEntries[0] : null;

  const columns: OTColumn<HistoryEntry>[] = [
    { id: 'time', label: tr('Zeit', 'Time'), width: 150, render: (e) => formatDateTime(e.time), sortValue: (e) => e.time },
    { id: 'conn', label: tr('Verbindung', 'Connection'), width: 130, render: (e) => e.connectionName, sortValue: (e) => e.connectionName },
    { id: 'db', label: tr('Datenbank', 'Database'), width: 120, render: (e) => e.database ?? '', sortValue: (e) => e.database ?? '' },
    { id: 'dur', label: tr('Dauer', 'Duration'), width: 80, align: 'right', render: (e) => formatDuration(e.durationMs), sortValue: (e) => e.durationMs },
    {
      id: 'rows',
      label: tr('Zeilen', 'Rows'),
      width: 80,
      align: 'right',
      render: (e) => formatNumber(e.rows ?? e.affectedRows ?? null),
      sortValue: (e) => e.rows ?? e.affectedRows ?? null
    },
    {
      id: 'status',
      label: tr('Status', 'Status'),
      width: 80,
      render: (e) =>
        e.ok ? (
          <span className="ks-history-ok">
            <CircleCheck size={13} /> OK
          </span>
        ) : (
          <span className="ks-history-err" title={e.error}>
            <CircleX size={13} /> {tr('Fehler', 'Error')}
          </span>
        ),
      sortValue: (e) => (e.ok ? 1 : 0)
    },
    { id: 'sql', label: 'SQL', width: 600, render: (e) => oneLine(e.sql), sortValue: (e) => e.sql }
  ];

  const copy = (list: HistoryEntry[]) => {
    if (!list.length) return;
    void navigator.clipboard.writeText(list.map(statementText).join('\n'));
    toast(tr('SQL kopiert', 'SQL copied'));
  };

  const openInQuery = (list: HistoryEntry[]) => {
    if (!list.length) return;
    const first = list[0];
    if (!profiles.some((p) => p.id === first.connectionId)) {
      toast(tr('Die Verbindung „{n}“ existiert nicht mehr.', 'The connection "{n}" no longer exists.', { n: first.connectionName }), 'error');
      return;
    }
    newQuery(first.connectionId, first.database, list.map(statementText).join('\n'));
  };

  const exportSql = async (list: HistoryEntry[]) => {
    if (!list.length) return;
    const file = await pickSaveFile({
      title: tr('Verlauf exportieren', 'Export history'),
      defaultPath: `history_${formatDateTime(Date.now()).replace(/[: ]/g, '-')}.sql`,
      filters: [{ name: 'SQL', extensions: ['sql'] }]
    });
    if (!file) return;
    const text = [...list]
      .sort((a, b) => a.time - b.time)
      .map((e) => `-- ${formatDateTime(e.time)} | ${e.connectionName}${e.database ? ` | ${e.database}` : ''} | ${formatDuration(e.durationMs)}${e.ok ? '' : ` | ${tr('FEHLER', 'ERROR')}: ${e.error ?? ''}`}\n${statementText(e)}\n`)
      .join('\n');
    try {
      await api.fs.writeText(file, text);
      toast(tr('{n} Anweisungen exportiert', '{n} statements exported', { n: list.length }), 'success');
    } catch (e) {
      void errorDialog(e);
    }
  };

  const clear = async () => {
    const ok = await confirmDialog({
      title: tr('Verlauf leeren', 'Clear history'),
      message: tr('Den gesamten Verlauf ({n} Einträge) unwiderruflich löschen?', 'Delete the whole history ({n} entries) permanently?', { n: entries.length }),
      okLabel: tr('Leeren', 'Clear'),
      danger: true
    });
    if (!ok) return;
    try {
      await api.history.clear();
      setEntries([]);
      setSelected([]);
    } catch (e) {
      void errorDialog(e);
    }
  };

  useEffect(() => {
    if (!active) return;
    const onCmd = (e: Event) => {
      if ((e as CustomEvent).detail === 'find') document.querySelector<HTMLInputElement>('.ks-history-search input')?.focus();
    };
    window.addEventListener('ks-command', onCmd);
    return () => window.removeEventListener('ks-command', onCmd);
  }, [active]);

  const target = selEntries.length ? selEntries : rows;

  return (
    <div className="ks-editor-layout">
      <Toolbar>
        <ToolbarButton icon={<FilePlus size={15} />} label={tr('In neuer Abfrage öffnen', 'Open in New Query')} disabled={!selEntries.length} onClick={() => openInQuery(selEntries)} />
        <ToolbarButton icon={<Copy size={15} />} label={tr('Kopieren', 'Copy')} disabled={!selEntries.length} onClick={() => copy(selEntries)} />
        <ToolbarButton
          icon={<Download size={15} />}
          label={selEntries.length ? tr('Auswahl exportieren', 'Export Selection') : tr('Exportieren', 'Export')}
          disabled={!target.length}
          onClick={() => void exportSql(target)}
        />
        <ToolbarSep />
        {paused ? (
          <ToolbarButton icon={<Play size={15} />} label={pendingCount ? tr('Fortsetzen ({n} neu)', 'Resume ({n} new)', { n: pendingCount }) : tr('Fortsetzen', 'Resume')} active onClick={resume} />
        ) : (
          <ToolbarButton icon={<Pause size={15} />} label={tr('Anhalten', 'Pause')} onClick={() => setPaused(true)} />
        )}
        <ToolbarButton icon={loading ? <Spinner size={14} /> : <RefreshCw size={15} />} label={tr('Aktualisieren', 'Refresh')} onClick={() => void load()} />
        <ToolbarButton icon={<Trash2 size={15} />} label={tr('Leeren', 'Clear')} disabled={!entries.length} onClick={() => void clear()} />
      </Toolbar>
      <div className="ks-history-filters">
        <SearchInput value={search} onChange={setSearch} className="ks-history-search" placeholder={tr('SQL, Datenbank oder Fehler suchen', 'Search SQL, database or error')} />
        <Select
          value={conn}
          onChange={setConn}
          style={{ width: 180 }}
          options={[{ value: '', label: tr('Alle Verbindungen', 'All connections') }, ...connections.map(([id, name]) => ({ value: id, label: name }))]}
        />
        <Select<'all' | 'ok' | 'error'>
          value={status}
          onChange={setStatus}
          style={{ width: 150 }}
          options={[
            { value: 'all', label: tr('Alle Status', 'All states') },
            { value: 'ok', label: tr('Nur erfolgreiche', 'Successful only') },
            { value: 'error', label: tr('Nur Fehler', 'Errors only') }
          ]}
        />
        <span className="muted">{tr('Von', 'From')}</span>
        <TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 140 }} />
        <span className="muted">{tr('bis', 'to')}</span>
        <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 140 }} />
        {(search || conn || status !== 'all' || from || to) && (
          <Button size="sm" variant="link" onClick={() => (setSearch(''), setConn(''), setStatus('all'), setFrom(''), setTo(''))}>
            {tr('Filter zurücksetzen', 'Reset filters')}
          </Button>
        )}
      </div>
      <div className="ks-history-main">
        <div className="ks-history-list">
          <ObjectTable<HistoryEntry>
            columns={columns}
            rows={rows}
            rowKey={(e) => e.id}
            nameOf={(e) => oneLine(e.sql)}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={(e) => openInQuery([e])}
            onKey={(combo, keys) => {
              const list = keys.map((k) => byId.get(k)).filter((e): e is HistoryEntry => !!e).sort((a, b) => a.time - b.time);
              if (combo === 'Ctrl+C') copy(list);
              else if (combo === 'F5') void load();
              else return false;
              return true;
            }}
            onContextMenu={(e, _row, keys) => {
              const list = keys.map((k) => byId.get(k)).filter((x): x is HistoryEntry => !!x).sort((a, b) => a.time - b.time);
              showContextMenu(e, [
                { label: tr('In neuer Abfrage öffnen', 'Open in New Query'), icon: <FilePlus size={14} />, disabled: !list.length, onClick: () => openInQuery(list) },
                { label: tr('SQL kopieren', 'Copy SQL'), icon: <Copy size={14} />, shortcut: 'Ctrl+C', disabled: !list.length, onClick: () => copy(list) },
                { label: tr('Als SQL-Datei exportieren …', 'Export as SQL File …'), icon: <Download size={14} />, disabled: !list.length, onClick: () => void exportSql(list) }
              ]);
            }}
            empty={
              <EmptyState title={entries.length ? tr('Keine Treffer', 'No matches') : tr('Der Verlauf ist leer', 'The history is empty')}>
                {!enabled && tr('Die Protokollierung ist in den Optionen ausgeschaltet.', 'Logging is turned off in the options.')}
              </EmptyState>
            }
          />
        </div>
        <div className="ks-history-detail">
          {detail ? (
            <>
              <div className="ks-history-detail-head">
                <span>{formatDateTime(detail.time)}</span>
                <span>{detail.connectionName}</span>
                {detail.database && <span>{detail.database}</span>}
                <span>{formatDuration(detail.durationMs)}</span>
                {detail.rows !== undefined && <span>{tr('{n} Zeilen', '{n} rows', { n: formatNumber(detail.rows) })}</span>}
                {detail.affectedRows !== undefined && <span>{tr('{n} betroffen', '{n} affected', { n: formatNumber(detail.affectedRows) })}</span>}
                <span className="spacer" />
                <Button size="sm" icon={<Copy size={13} />} onClick={() => copy([detail])}>
                  {tr('Kopieren', 'Copy')}
                </Button>
                <Button size="sm" icon={<FilePlus size={13} />} onClick={() => openInQuery([detail])}>
                  {tr('In neuer Abfrage öffnen', 'Open in New Query')}
                </Button>
              </div>
              {!detail.ok && <div className="ks-history-error selectable">{detail.error}</div>}
              <div className="ks-history-sql">
                <SqlHighlight sql={detail.sql} className="selectable" />
              </div>
            </>
          ) : (
            <div className="faint" style={{ padding: 12 }}>
              {selEntries.length > 1 ? tr('{n} Einträge ausgewählt', '{n} entries selected', { n: selEntries.length }) : tr('Eintrag auswählen, um die Anweisung zu sehen.', 'Select an entry to see the statement.')}
            </div>
          )}
        </div>
      </div>
      <div className="ks-statusline">
        <span>{tr('{n} von {t} Einträgen', '{n} of {t} entries', { n: rows.length, t: entries.length })}</span>
        <span>{tr('{n} Fehler', '{n} errors', { n: rows.filter((r) => !r.ok).length })}</span>
        {paused && <span className="danger-text">{tr('Anzeige angehalten', 'Display paused')}</span>}
        {!enabled && <span className="danger-text">{tr('Protokollierung ausgeschaltet', 'Logging disabled')}</span>}
      </div>
    </div>
  );
}

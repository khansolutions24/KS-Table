// Server monitor: process list, variables, status with live charts and InnoDB status for one or more connections.
// Every monitored connection gets its own session (closed when it is removed or the tab closes).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Copy, OctagonX, Pencil, Plug, RefreshCw, Server } from 'lucide-react';
import type { ProcessInfo, StatusRow, VariableRow, VariableScope, VariableValueMode } from '@shared/apis/admin';
import { tr } from '@shared/i18n';
import { formatBytes, formatNumber } from '@shared/util';
import { api, errorMessage } from '../../api/client';
import { ObjectTable, type OTColumn } from '../../components/ObjectTable';
import { SqlHighlight } from '../../components/SqlHighlight';
import { toast } from '../../components/Toast';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  RadioGroup,
  SearchInput,
  Select,
  Spinner,
  TabStrip,
  TextInput,
  Toolbar,
  ToolbarButton,
  ToolbarSep
} from '../../components/ui/controls';
import { confirmDialog, Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { showContextMenu, showMenuBelow, type MenuItem } from '../../components/ui/Menu';
import type { TabProps } from '../../store/tabs';
import { isUserCancelled, openSessionWithPrompt, useWorkspace } from '../../store/workspace';
import { LineChart, type ChartSeries } from './EChart';
import './monitor.css';

type SubTab = 'processes' | 'variables' | 'status' | 'innodb';

interface MonSession {
  sessionId: string | null;
  threadId: number;
  serverType: 'mysql' | 'mariadb';
  version: number;
  error: string | null;
  connecting: boolean;
}

interface Sample {
  t: number;
  questions: number;
  threadsConnected: number;
  threadsRunning: number;
  bytesSent: number;
  bytesReceived: number;
  bpTotal: number;
  bpFree: number;
}

const MAX_SAMPLES = 300;

type ProcRow = ProcessInfo & { cid: string; connName: string; key: string; own: boolean };

function useMonitorSessions(cids: string[]) {
  const [sessions, setSessions] = useState<Record<string, MonSession>>({});
  const ref = useRef<Record<string, MonSession>>({});
  const alive = useRef(true);

  const update = (cid: string, s: MonSession | null) => {
    const next = { ...ref.current };
    if (s) next[cid] = s;
    else delete next[cid];
    ref.current = next;
    setSessions(next);
  };

  const open = useCallback(async (cid: string) => {
    update(cid, { sessionId: null, threadId: 0, serverType: 'mysql', version: 0, error: null, connecting: true });
    try {
      const info = await openSessionWithPrompt(cid, null);
      if (!alive.current || !ref.current[cid] || ref.current[cid].sessionId) {
        void api.session.close(info.sessionId).catch(() => undefined);
        return;
      }
      update(cid, { sessionId: info.sessionId, threadId: info.threadId, serverType: info.server.type, version: info.server.versionNumber, error: null, connecting: false });
    } catch (e) {
      if (!alive.current || !ref.current[cid]) return;
      update(cid, {
        sessionId: null,
        threadId: 0,
        serverType: 'mysql',
        version: 0,
        error: isUserCancelled(e) ? tr('Anmeldung abgebrochen', 'Sign in cancelled') : errorMessage(e),
        connecting: false
      });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const s of Object.values(ref.current)) if (s.sessionId) void api.session.close(s.sessionId).catch(() => undefined);
      ref.current = {};
    };
  }, []);

  useEffect(() => {
    for (const cid of cids) if (!ref.current[cid]) void open(cid);
    for (const [cid, s] of Object.entries(ref.current)) {
      if (cids.includes(cid)) continue;
      if (s.sessionId) void api.session.close(s.sessionId).catch(() => undefined);
      update(cid, null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cids.join('|')]);

  const retry = (cid: string) => {
    update(cid, null);
    void open(cid);
  };

  return { sessions, retry };
}

const num = (rows: StatusRow[], name: string) => Number(rows.find((r) => r.name === name)?.value ?? 0) || 0;

function editVariable(row: VariableRow, allowPersist: boolean): Promise<{ scope: VariableScope; value: string; mode: VariableValueMode } | null> {
  return openDialog<{ scope: VariableScope; value: string; mode: VariableValueMode }>((close) => <VariableDialog row={row} allowPersist={allowPersist} close={close} />).then((v) => v ?? null);
}

function VariableDialog({ row, allowPersist, close }: { row: VariableRow; allowPersist: boolean; close: (v?: { scope: VariableScope; value: string; mode: VariableValueMode }) => void }) {
  const [scope, setScope] = useState<VariableScope>(row.global !== null ? 'GLOBAL' : 'SESSION');
  const [value, setValue] = useState((row.global ?? row.session) ?? '');
  const [mode, setMode] = useState<VariableValueMode>('auto');
  return (
    <Dialog
      title={tr('Variable ändern – {n}', 'Edit variable – {n}', { n: row.name })}
      width={520}
      onClose={() => close()}
      onSubmit={() => close({ scope, value, mode })}
      footer={
        <>
          <Button type="submit" variant="primary">
            {tr('Übernehmen', 'Apply')}
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-form">
        <Field label={tr('Aktuell global', 'Current global')} labelWidth={140}>
          <span className="selectable mono">{row.global ?? '–'}</span>
        </Field>
        <Field label={tr('Aktuell Sitzung', 'Current session')} labelWidth={140}>
          <span className="selectable mono">{row.session ?? '–'}</span>
        </Field>
        <Field label={tr('Gültigkeit', 'Scope')} labelWidth={140}>
          <RadioGroup
            inline
            value={scope}
            onChange={setScope}
            options={[
              { value: 'GLOBAL', label: 'GLOBAL', disabled: row.global === null },
              { value: 'SESSION', label: 'SESSION', disabled: row.session === null },
              ...(allowPersist ? [{ value: 'PERSIST' as const, label: 'PERSIST', disabled: row.global === null }] : [])
            ]}
          />
        </Field>
        <Field label={tr('Neuer Wert', 'New value')} labelWidth={140}>
          <TextInput data-autofocus className="mono" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label={tr('Schreibweise', 'Write as')} labelWidth={140}>
          <Select<VariableValueMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'auto', label: tr('Automatisch (Zahl, ON/OFF oder Text)', 'Automatic (number, ON/OFF or text)') },
              { value: 'string', label: tr('Immer als Text', 'Always as text') },
              { value: 'expression', label: tr('SQL-Ausdruck', 'SQL expression') }
            ]}
          />
        </Field>
        <div className="ks-field-hint">
          {tr(
            'SESSION wirkt nur auf die Sitzung der Serverüberwachung. PERSIST speichert den Wert zusätzlich dauerhaft (MySQL 8).',
            'SESSION only affects the server monitor session. PERSIST also stores the value permanently (MySQL 8).'
          )}
        </div>
      </div>
    </Dialog>
  );
}

export default function ServerMonitorTab({ tab, active }: TabProps) {
  const initial = (tab.params as { connectionId: string | null }).connectionId;
  const profiles = useWorkspace((s) => s.profiles);
  const [cids, setCids] = useState<string[]>(initial ? [initial] : []);
  const { sessions, retry } = useMonitorSessions(cids);
  const [sub, setSub] = useState<SubTab>('processes');
  const [interval, setIntervalSec] = useState('5');
  const [current, setCurrent] = useState<string | null>(initial);
  const nameOf = useCallback((cid: string) => profiles.find((p) => p.id === cid)?.name ?? cid, [profiles]);
  const ready = cids.filter((c) => sessions[c]?.sessionId);

  useEffect(() => {
    if (!current || !cids.includes(current)) setCurrent(cids[0] ?? null);
  }, [cids, current]);

  // ───────── process list ─────────
  const [procs, setProcs] = useState<ProcRow[]>([]);
  const [procErrors, setProcErrors] = useState<string[]>([]);
  const [procFilter, setProcFilter] = useState('');
  const [hideSleep, setHideSleep] = useState(true);
  const [procSel, setProcSel] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const loadProcs = useCallback(async () => {
    const list: ProcRow[] = [];
    const errors: string[] = [];
    setLoading(true);
    await Promise.all(
      cids.map(async (cid) => {
        const s = sessions[cid];
        if (!s?.sessionId) return;
        try {
          for (const p of await api.admin.processList(s.sessionId)) {
            list.push({ ...p, cid, connName: nameOf(cid), key: `${cid}:${p.id}`, own: Number(p.id) === s.threadId });
          }
        } catch (e) {
          errors.push(`${nameOf(cid)}: ${errorMessage(e)}`);
        }
      })
    );
    setLoading(false);
    setProcs(list);
    setProcErrors(errors);
  }, [cids, sessions, nameOf]);

  // ───────── variables / status / innodb ─────────
  const [vars, setVars] = useState<VariableRow[]>([]);
  const [varFilter, setVarFilter] = useState('');
  const [varSel, setVarSel] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusRow[]>([]);
  const statusRef = useRef<StatusRow[]>([]);
  const [prevStatus, setPrevStatus] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState('');
  const [innodb, setInnodb] = useState('');
  const [samples, setSamples] = useState<Record<string, Sample[]>>({});
  const [subError, setSubError] = useState<string | null>(null);
  const curSession = current ? sessions[current] : undefined;

  const loadVars = useCallback(async () => {
    if (!curSession?.sessionId) return;
    try {
      setVars(await api.admin.variables(curSession.sessionId));
      setSubError(null);
    } catch (e) {
      setSubError(errorMessage(e));
    }
  }, [curSession?.sessionId]);

  const loadInnodb = useCallback(async () => {
    if (!curSession?.sessionId) return;
    try {
      setInnodb(await api.admin.innodbStatus(curSession.sessionId));
      setSubError(null);
    } catch (e) {
      setSubError(errorMessage(e));
    }
  }, [curSession?.sessionId]);

  const sampleStatus = useCallback(async () => {
    const now = Date.now();
    await Promise.all(
      cids.map(async (cid) => {
        const s = sessions[cid];
        if (!s?.sessionId) return;
        try {
          const rows = await api.admin.status(s.sessionId);
          const sample: Sample = {
            t: now,
            questions: num(rows, 'Questions'),
            threadsConnected: num(rows, 'Threads_connected'),
            threadsRunning: num(rows, 'Threads_running'),
            bytesSent: num(rows, 'Bytes_sent'),
            bytesReceived: num(rows, 'Bytes_received'),
            bpTotal: num(rows, 'Innodb_buffer_pool_pages_total'),
            bpFree: num(rows, 'Innodb_buffer_pool_pages_free')
          };
          setSamples((all) => {
            const list = [...(all[cid] ?? []), sample];
            return { ...all, [cid]: list.length > MAX_SAMPLES ? list.slice(list.length - MAX_SAMPLES) : list };
          });
          if (cid === current) {
            setPrevStatus(Object.fromEntries(statusRef.current.map((r) => [r.name, r.value])));
            statusRef.current = rows;
            setStatus(rows);
          }
        } catch (e) {
          if (cid === current) setSubError(errorMessage(e));
        }
      })
    );
  }, [cids, sessions, current]);

  const refresh = useCallback(() => {
    if (sub === 'processes') void loadProcs();
    else if (sub === 'variables') void loadVars();
    else if (sub === 'innodb') void loadInnodb();
  }, [sub, loadProcs, loadVars, loadInnodb]);

  // initial load when sub tab / sessions change
  useEffect(() => {
    if (active) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, active, ready.join('|'), current]);

  useEffect(() => {
    setStatus([]);
    statusRef.current = [];
    setPrevStatus({});
    setVars([]);
    setInnodb('');
    setSubError(null);
  }, [current]);

  // auto refresh (process list) and status sampling (charts)
  const sec = Number(interval);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!active || !ready.length) return;
    const tickSec = sub === 'status' ? Math.min(sec || 2, 2) : sec;
    if (!tickSec) return;
    const t = window.setInterval(() => {
      if (busyRef.current) return;
      busyRef.current = true;
      const job = sub === 'processes' ? loadProcs() : sub === 'status' ? sampleStatus() : Promise.resolve();
      void job.finally(() => (busyRef.current = false));
    }, tickSec * 1000);
    return () => window.clearInterval(t);
  }, [active, sub, sec, ready.length, loadProcs, sampleStatus]);

  useEffect(() => {
    if (active && sub === 'status') void sampleStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sub, ready.join('|'), current]);

  // ───────── actions ─────────
  const kill = async (rows: ProcRow[], queryOnly: boolean) => {
    if (!rows.length) return;
    const own = rows.some((r) => r.own);
    const ok = await confirmDialog({
      title: queryOnly ? tr('Abfrage beenden', 'Kill query') : tr('Verbindung trennen', 'Kill connection'),
      message:
        (queryOnly
          ? tr('Laufende Anweisung von {n} Prozess(en) abbrechen?', 'Cancel the running statement of {n} process(es)?', { n: rows.length })
          : tr('{n} Verbindung(en) beenden? Offene Transaktionen werden zurückgerollt.', 'Kill {n} connection(s)? Open transactions are rolled back.', { n: rows.length })) +
        `\n\n${rows.slice(0, 10).map((r) => `• ${r.connName}: ${r.id} ${r.user}@${r.host}`).join('\n')}` +
        (own ? `\n\n${tr('Hinweis: Darunter ist die Sitzung der Serverüberwachung selbst.', 'Note: this includes the server monitor session itself.')}` : ''),
      okLabel: queryOnly ? tr('Abfrage beenden', 'Kill query') : tr('Verbindung trennen', 'Kill connection'),
      danger: true
    });
    if (!ok) return;
    for (const r of rows) {
      const sid = sessions[r.cid]?.sessionId;
      if (!sid) continue;
      try {
        await api.admin.kill(sid, r.id, queryOnly);
      } catch (e) {
        await errorDialog(e);
        break;
      }
    }
    await loadProcs();
  };

  const setVariable = async (row: VariableRow) => {
    if (!curSession?.sessionId) return;
    const r = await editVariable(row, curSession.serverType === 'mysql' && curSession.version >= 80000);
    if (!r) return;
    try {
      const sql = await api.admin.setVariable(curSession.sessionId, r.scope, row.name, r.value, r.mode);
      toast(sql, 'success');
      await loadVars();
    } catch (e) {
      void errorDialog(e);
    }
  };

  // ───────── derived ─────────
  const procRows = useMemo(() => {
    const f = procFilter.trim().toLowerCase();
    return procs.filter(
      (p) =>
        (!hideSleep || (p.command !== 'Sleep' && p.command !== 'Daemon')) &&
        (!f || [p.id, p.user, p.host, p.db ?? '', p.command, p.state, p.info ?? '', p.connName].some((x) => x.toLowerCase().includes(f)))
    );
  }, [procs, procFilter, hideSleep]);
  const procByKey = useMemo(() => new Map(procs.map((p) => [p.key, p])), [procs]);
  const selProcs = procSel.map((k) => procByKey.get(k)).filter((p): p is ProcRow => !!p);

  const procColumns: OTColumn<ProcRow>[] = [
    ...(cids.length > 1 ? [{ id: 'conn', label: tr('Verbindung', 'Connection'), width: 140, render: (p: ProcRow) => p.connName, sortValue: (p: ProcRow) => p.connName }] : []),
    { id: 'id', label: 'ID', width: 80, align: 'right', render: (p) => (p.own ? `${p.id} *` : p.id), sortValue: (p) => Number(p.id) },
    { id: 'user', label: tr('Benutzer', 'User'), width: 120, render: (p) => p.user, sortValue: (p) => p.user },
    { id: 'host', label: tr('Host', 'Host'), width: 150, render: (p) => p.host, sortValue: (p) => p.host },
    { id: 'db', label: tr('Datenbank', 'Database'), width: 120, render: (p) => p.db ?? '', sortValue: (p) => p.db ?? '' },
    { id: 'cmd', label: tr('Befehl', 'Command'), width: 90, render: (p) => p.command, sortValue: (p) => p.command },
    { id: 'time', label: tr('Zeit (s)', 'Time (s)'), width: 80, align: 'right', render: (p) => formatNumber(p.time), sortValue: (p) => p.time },
    { id: 'state', label: tr('Zustand', 'State'), width: 170, render: (p) => p.state, sortValue: (p) => p.state },
    { id: 'info', label: tr('Anweisung', 'Statement'), width: 480, render: (p) => (p.info ?? '').replace(/\s+/g, ' '), sortValue: (p) => p.info ?? '' }
  ];

  const varRows = useMemo(() => {
    const f = varFilter.trim().toLowerCase();
    return f ? vars.filter((v) => v.name.toLowerCase().includes(f) || (v.global ?? '').toLowerCase().includes(f) || (v.session ?? '').toLowerCase().includes(f)) : vars;
  }, [vars, varFilter]);
  const varColumns: OTColumn<VariableRow>[] = [
    { id: 'name', label: tr('Variable', 'Variable'), width: 300, render: (v) => v.name, sortValue: (v) => v.name },
    { id: 'global', label: tr('Global', 'Global'), width: 300, render: (v) => v.global ?? '', sortValue: (v) => v.global },
    {
      id: 'session',
      label: tr('Sitzung', 'Session'),
      width: 300,
      render: (v) => <span className={v.session !== v.global && v.global !== null && v.session !== null ? 'ks-monitor-changed' : undefined}>{v.session ?? ''}</span>,
      sortValue: (v) => v.session
    }
  ];

  const statusRows = useMemo(() => {
    const f = statusFilter.trim().toLowerCase();
    return f ? status.filter((s) => s.name.toLowerCase().includes(f) || s.value.toLowerCase().includes(f)) : status;
  }, [status, statusFilter]);
  const statusColumns: OTColumn<StatusRow>[] = [
    { id: 'name', label: tr('Statusvariable', 'Status variable'), width: 320, render: (s) => s.name, sortValue: (s) => s.name },
    {
      id: 'value',
      label: tr('Wert', 'Value'),
      width: 260,
      render: (s) => <span className={prevStatus[s.name] !== undefined && prevStatus[s.name] !== s.value ? 'ks-monitor-changed' : undefined}>{s.value}</span>,
      sortValue: (s) => (s.value !== '' && !isNaN(Number(s.value)) ? Number(s.value) : s.value)
    },
    {
      id: 'delta',
      label: tr('Änderung', 'Delta'),
      width: 120,
      align: 'right',
      render: (s) => {
        const p = prevStatus[s.name];
        if (p === undefined || p === '' || s.value === '' || isNaN(Number(p)) || isNaN(Number(s.value))) return '';
        const d = Number(s.value) - Number(p);
        return d ? (d > 0 ? `+${formatNumber(d, 2)}` : formatNumber(d, 2)) : '';
      }
    }
  ];

  const charts = useMemo(() => {
    const rate = (fn: (s: Sample) => number, scale = 1): ChartSeries[] =>
      cids.map((cid) => {
        const list = samples[cid] ?? [];
        const data: [number, number][] = [];
        for (let i = 1; i < list.length; i++) {
          const dt = (list[i].t - list[i - 1].t) / 1000;
          const dv = fn(list[i]) - fn(list[i - 1]);
          if (dt > 0 && dv >= 0) data.push([list[i].t, (dv / dt) * scale]);
        }
        return { name: nameOf(cid), data };
      });
    const value = (fn: (s: Sample) => number): ChartSeries[] => cids.map((cid) => ({ name: nameOf(cid), data: (samples[cid] ?? []).map((s) => [s.t, fn(s)] as [number, number]) }));
    return {
      qps: rate((s) => s.questions),
      connected: value((s) => s.threadsConnected),
      running: value((s) => s.threadsRunning),
      sent: rate((s) => s.bytesSent),
      received: rate((s) => s.bytesReceived),
      pool: value((s) => (s.bpTotal ? ((s.bpTotal - s.bpFree) / s.bpTotal) * 100 : 0))
    };
  }, [samples, cids, nameOf]);
  const bytesFmt = useCallback((v: number) => `${formatBytes(v)}/s`, []);
  const pctFmt = useCallback((v: number) => `${v.toFixed(1)} %`, []);

  // ───────── rendering ─────────
  const connMenu = (el: HTMLElement) => {
    const items: MenuItem[] = profiles.map((p) => ({
      label: p.name,
      checked: cids.includes(p.id),
      icon: <Server size={14} />,
      onClick: () => setCids((c) => (c.includes(p.id) ? c.filter((x) => x !== p.id) : [...c, p.id]))
    }));
    showMenuBelow(el, items.length ? items : [{ label: tr('Keine Verbindungen', 'No connections'), disabled: true }]);
  };

  const errors = cids.filter((c) => sessions[c]?.error);
  const connecting = cids.some((c) => sessions[c]?.connecting);
  const needsCurrent = sub !== 'processes';

  const body = () => {
    if (!cids.length) {
      return (
        <EmptyState icon={<Server size={40} />} title={tr('Keine Verbindung ausgewählt', 'No connection selected')}>
          <p>{tr('Wählen Sie eine oder mehrere Verbindungen zur Überwachung aus.', 'Choose one or more connections to monitor.')}</p>
          <Button icon={<Plug size={14} />} onClick={(e) => connMenu(e.currentTarget)}>
            {tr('Verbindungen wählen', 'Choose connections')}
          </Button>
        </EmptyState>
      );
    }
    if (needsCurrent && !curSession?.sessionId) {
      return (
        <div className="ks-tab-loading">
          {curSession?.connecting ? <Spinner size={22} /> : <span className="faint">{tr('Keine Sitzung für diese Verbindung', 'No session for this connection')}</span>}
        </div>
      );
    }
    switch (sub) {
      case 'processes': {
        const detail = selProcs.length === 1 ? selProcs[0] : null;
        return (
          <div className="ks-monitor-split">
            <div className="ks-monitor-list">
              <ObjectTable<ProcRow>
                columns={procColumns}
                rows={procRows}
                rowKey={(p) => p.key}
                nameOf={(p) => p.id}
                selected={procSel}
                onSelectionChange={setProcSel}
                onContextMenu={(e, _row, keys) => {
                  const rows = keys.map((k) => procByKey.get(k)).filter((p): p is ProcRow => !!p);
                  showContextMenu(e, [
                    { label: tr('Abfrage beenden', 'Kill Query'), icon: <Ban size={14} />, disabled: !rows.length, onClick: () => void kill(rows, true) },
                    { label: tr('Verbindung trennen', 'Kill Connection'), icon: <OctagonX size={14} />, danger: true, disabled: !rows.length, onClick: () => void kill(rows, false) },
                    {
                      label: tr('Anweisung kopieren', 'Copy Statement'),
                      icon: <Copy size={14} />,
                      disabled: !rows.some((r) => r.info),
                      onClick: () => void navigator.clipboard.writeText(rows.map((r) => r.info ?? '').filter(Boolean).join(';\n'))
                    },
                    { label: tr('Aktualisieren', 'Refresh'), icon: <RefreshCw size={14} />, onClick: () => void loadProcs() }
                  ]);
                }}
                onKey={(combo, keys) => {
                  const rows = keys.map((k) => procByKey.get(k)).filter((p): p is ProcRow => !!p);
                  if (combo === 'Delete' && rows.length) void kill(rows, false);
                  else if (combo === 'F5') void loadProcs();
                  else return false;
                  return true;
                }}
                empty={<span className="faint">{loading ? tr('Wird geladen …', 'Loading …') : tr('Keine Prozesse', 'No processes')}</span>}
              />
            </div>
            <div className="ks-monitor-detail">
              {detail?.info ? <SqlHighlight sql={detail.info} className="selectable" /> : <div className="faint" style={{ padding: 10 }}>{tr('Prozess auswählen, um die vollständige Anweisung zu sehen.', 'Select a process to see its full statement.')}</div>}
            </div>
          </div>
        );
      }
      case 'variables':
        return (
          <div className="ks-monitor-list">
            <ObjectTable<VariableRow>
              columns={varColumns}
              rows={varRows}
              rowKey={(v) => v.name}
              nameOf={(v) => v.name}
              selected={varSel}
              onSelectionChange={setVarSel}
              onOpen={(v) => void setVariable(v)}
              onKey={(combo, keys) => {
                const v = vars.find((x) => x.name === keys[0]);
                if ((combo === 'Ctrl+Enter' || combo === 'F2') && v) void setVariable(v);
                else if (combo === 'F5') void loadVars();
                else return false;
                return true;
              }}
              onContextMenu={(e, row) =>
                row &&
                showContextMenu(e, [
                  { label: tr('Wert ändern …', 'Edit Value …'), icon: <Pencil size={14} />, shortcut: 'Ctrl+Enter', onClick: () => void setVariable(row) },
                  { label: tr('Kopieren', 'Copy'), icon: <Copy size={14} />, onClick: () => void navigator.clipboard.writeText(`${row.name} = ${row.global ?? row.session ?? ''}`) }
                ])
              }
              empty={<span className="faint">{tr('Keine Variablen', 'No variables')}</span>}
            />
          </div>
        );
      case 'status':
        return (
          <div className="ks-monitor-split">
            <div className="ks-monitor-charts">
              <LineChart title={tr('Abfragen pro Sekunde', 'Queries per second')} series={charts.qps} />
              <LineChart title={tr('Verbindungen', 'Connections')} series={charts.connected} />
              <LineChart title={tr('Laufende Threads', 'Threads running')} series={charts.running} />
              <LineChart title={tr('Gesendet', 'Bytes sent')} series={charts.sent} format={bytesFmt} />
              <LineChart title={tr('Empfangen', 'Bytes received')} series={charts.received} format={bytesFmt} />
              <LineChart title={tr('InnoDB-Pufferpool belegt', 'InnoDB buffer pool used')} series={charts.pool} format={pctFmt} />
            </div>
            <div className="ks-monitor-list">
              <ObjectTable<StatusRow>
                columns={statusColumns}
                rows={statusRows}
                rowKey={(s) => s.name}
                nameOf={(s) => s.name}
                selected={[]}
                onSelectionChange={() => undefined}
                empty={<span className="faint">{tr('Wird geladen …', 'Loading …')}</span>}
              />
            </div>
          </div>
        );
      default:
        return <pre className="ks-monitor-innodb selectable">{innodb || tr('Wird geladen …', 'Loading …')}</pre>;
    }
  };

  return (
    <div className="ks-editor-layout">
      <Toolbar>
        <ToolbarButton icon={<Server size={15} />} label={tr('Verbindungen ({n})', 'Connections ({n})', { n: cids.length })} dropdown onClick={(e) => connMenu(e.currentTarget)} />
        {needsCurrent && cids.length > 1 && (
          <Select value={current ?? ''} onChange={setCurrent} options={cids.map((c) => ({ value: c, label: nameOf(c) }))} className="ks-monitor-conns" />
        )}
        <ToolbarSep />
        <ToolbarButton icon={loading || connecting ? <Spinner size={14} /> : <RefreshCw size={15} />} label={tr('Aktualisieren', 'Refresh')} disabled={!ready.length} onClick={() => (sub === 'status' ? void sampleStatus() : refresh())} />
        {(sub === 'processes' || sub === 'status') && (
          <Select
            value={interval}
            onChange={setIntervalSec}
            title={tr('Automatische Aktualisierung', 'Auto refresh')}
            style={{ width: 150 }}
            options={[
              { value: '0', label: tr('Auto: aus', 'Auto: off') },
              { value: '1', label: tr('Auto: 1 s', 'Auto: 1 s') },
              { value: '2', label: tr('Auto: 2 s', 'Auto: 2 s') },
              { value: '5', label: tr('Auto: 5 s', 'Auto: 5 s') },
              { value: '10', label: tr('Auto: 10 s', 'Auto: 10 s') },
              { value: '30', label: tr('Auto: 30 s', 'Auto: 30 s') },
              { value: '60', label: tr('Auto: 60 s', 'Auto: 60 s') }
            ]}
          />
        )}
        {sub === 'processes' && (
          <>
            <ToolbarSep />
            <ToolbarButton icon={<Ban size={15} />} label={tr('Abfrage beenden', 'Kill Query')} disabled={!selProcs.length} onClick={() => void kill(selProcs, true)} />
            <ToolbarButton icon={<OctagonX size={15} />} label={tr('Verbindung trennen', 'Kill Connection')} disabled={!selProcs.length} onClick={() => void kill(selProcs, false)} />
            <div className="spacer" />
            <Checkbox checked={hideSleep} onChange={setHideSleep} label={tr('Ruhende ausblenden', 'Hide sleeping')} />
            <SearchInput value={procFilter} onChange={setProcFilter} className="ks-monitor-search" placeholder={tr('Prozesse filtern', 'Filter processes')} />
          </>
        )}
        {sub === 'variables' && (
          <>
            <ToolbarButton icon={<Pencil size={15} />} label={tr('Wert ändern', 'Edit Value')} disabled={varSel.length !== 1} onClick={() => { const v = vars.find((x) => x.name === varSel[0]); if (v) void setVariable(v); }} />
            <div className="spacer" />
            <SearchInput value={varFilter} onChange={setVarFilter} className="ks-monitor-search" placeholder={tr('Variablen suchen', 'Search variables')} />
          </>
        )}
        {sub === 'status' && (
          <>
            <div className="spacer" />
            <SearchInput value={statusFilter} onChange={setStatusFilter} className="ks-monitor-search" placeholder={tr('Status suchen', 'Search status')} />
          </>
        )}
      </Toolbar>
      <TabStrip<SubTab>
        tabs={[
          { id: 'processes', label: tr('Prozessliste', 'Process List') },
          { id: 'variables', label: tr('Variablen', 'Variables') },
          { id: 'status', label: tr('Status', 'Status') },
          { id: 'innodb', label: tr('InnoDB-Status', 'InnoDB Status') }
        ]}
        value={sub}
        onChange={setSub}
      />
      {errors.length > 0 && (
        <div className="ks-monitor-errors">
          {errors.map((c) => (
            <div key={c} className="row">
              <span className="grow">
                {nameOf(c)}: {sessions[c]?.error}
              </span>
              <Button size="sm" onClick={() => retry(c)}>
                {tr('Erneut verbinden', 'Reconnect')}
              </Button>
            </div>
          ))}
        </div>
      )}
      {subError && needsCurrent && <div className="ks-monitor-errors">{subError}</div>}
      <div className="ks-monitor-body">{body()}</div>
      <div className="ks-statusline">
        {sub === 'processes' ? (
          <span>{tr('{n} von {t} Prozessen', '{n} of {t} processes', { n: procRows.length, t: procs.length })}</span>
        ) : sub === 'variables' ? (
          <span>{tr('{n} Variablen', '{n} variables', { n: varRows.length })}</span>
        ) : sub === 'status' ? (
          <span>{tr('{n} Statuswerte', '{n} status values', { n: statusRows.length })}</span>
        ) : (
          <span>{current ? nameOf(current) : ''}</span>
        )}
        <span>{tr('{r} von {n} Verbindungen aktiv', '{r} of {n} connections active', { r: ready.length, n: cids.length })}</span>
        {procProblems(procErrors)}
      </div>
    </div>
  );
}

function procProblems(errors: string[]) {
  return errors.length ? <span className="danger-text ellipsis" title={errors.join('\n')}>{errors[0]}</span> : null;
}

// Charts & dashboards: workspaces with data sources (SQL queries), chart designer and dashboards.

import './charts.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toPng } from 'html-to-image';
import {
  ChartArea,
  ChartBar,
  ChartColumn,
  ChartColumnStacked,
  ChartLine,
  ChartPie,
  ChartScatter,
  Copy,
  Database,
  Donut,
  FilePlus,
  Fullscreen,
  Gauge,
  Grid3x3,
  Hash,
  Image,
  LayoutDashboard,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  Type,
  X
} from 'lucide-react';
import type { FileEntry } from '@shared/api';
import { tr } from '@shared/i18n';
import { newId } from '@shared/defaults';
import type { ResultColumn } from '@shared/types';
import { formatDateTime, formatNumber, safeFileName, uniqueName } from '@shared/util';
import { api, errorCode, errorMessage } from '../../api/client';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { columnFromResult } from '../../components/grid/cellFormat';
import { DataGrid } from '../../components/grid/DataGrid';
import { toast } from '../../components/Toast';
import { Button, Checkbox, EmptyState, Field, IconButton, NumberInput, Select, Spinner, TextArea, TextInput, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { confirmDialog, errorDialog, promptDialog } from '../../components/ui/Dialog';
import { SEP, showContextMenu, showMenuBelow, type MenuItem } from '../../components/ui/Menu';
import { dataUrlToBytes } from '../model/diagram/image';
import { ConnectionDbPicker } from '../model/ConnectionPicker';
import { joinPath, pickSaveFile } from '../../lib/files';
import { cssVar } from '../../lib/theme';
import type { TabProps } from '../../store/tabs';
import { isUserCancelled, openSessionWithPrompt, useWorkspace } from '../../store/workspace';
import { PALETTES, type SourceData } from './engine';
import { ChartView } from './ChartView';
import {
  AGGREGATIONS,
  CHART_TYPES,
  DASH_COLUMNS,
  newChart,
  newDashboard,
  newSource,
  newWorkspace,
  parseWorkspace,
  ROW_HEIGHT,
  WORKSPACE_EXT,
  type ChartDef,
  type ChartType,
  type ChartWorkspace,
  type Dashboard,
  type DashboardItem,
  type DataSource,
  type FilterOp
} from './model';

type Sel = { kind: 'source' | 'chart' | 'dashboard'; id: string } | null;

interface Loaded {
  data: SourceData | null;
  columns: ResultColumn[];
  loading: boolean;
  error: string | null;
}

const TYPE_ICON: Record<ChartType, ReactNode> = {
  bar: <ChartColumn size={16} />,
  barStacked: <ChartColumnStacked size={16} />,
  barHorizontal: <ChartBar size={16} />,
  line: <ChartLine size={16} />,
  area: <ChartArea size={16} />,
  pie: <ChartPie size={16} />,
  donut: <Donut size={16} />,
  scatter: <ChartScatter size={16} />,
  heatmap: <Grid3x3 size={16} />,
  kpi: <Hash size={16} />,
  gauge: <Gauge size={16} />,
  table: <Table2 size={16} />
};

const chartsDir = () => joinPath(useWorkspace.getState().profilesDir, 'charts');
const fileOf = (name: string) => joinPath(chartsDir(), `${safeFileName(name)}.${WORKSPACE_EXT}`);

async function exportElementPng(el: HTMLElement, name: string): Promise<void> {
  const url = await toPng(el, { backgroundColor: cssVar('--bg-panel'), pixelRatio: 2, skipFonts: true });
  const p = await pickSaveFile({ title: tr('Bild speichern', 'Save image'), defaultPath: `${safeFileName(name)}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (!p) return;
  const file = /\.png$/i.test(p) ? p : `${p}.png`;
  await api.fs.writeBinary(file, dataUrlToBytes(url));
  toast(tr('Bild gespeichert: {f}', 'Image saved: {f}', { f: file }), 'success');
}

export default function ChartsTab({ active }: TabProps) {
  const profilesDir = useWorkspace((s) => s.profilesDir);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [ws, setWs] = useState<ChartWorkspace | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'error'>('saved');
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const sessions = useRef(new Map<string, string>());
  const rootRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef(ws);
  wsRef.current = ws;

  // ───────────── workspace files ─────────────

  const listFiles = useCallback(async () => {
    await api.fs.mkdir(chartsDir()).catch(() => undefined);
    const list = (await api.fs.list(chartsDir())).filter((e) => !e.isDir && e.name.toLowerCase().endsWith(`.${WORKSPACE_EXT}`)).sort((a, b) => a.name.localeCompare(b.name));
    setFiles(list);
    return list;
  }, []);

  const openFile = useCallback(async (path: string) => {
    try {
      const w = parseWorkspace(await api.fs.readText(path));
      setWs(w);
      setFile(path);
      setSel(w.dashboards[0] ? { kind: 'dashboard', id: w.dashboards[0].id } : w.charts[0] ? { kind: 'chart', id: w.charts[0].id } : w.sources[0] ? { kind: 'source', id: w.sources[0].id } : null);
      setSaveState('saved');
      try {
        localStorage.setItem('ks-charts-last', path);
      } catch {
        // ignore
      }
    } catch (e) {
      void errorDialog(e);
    }
  }, []);

  useEffect(() => {
    if (!profilesDir) return;
    void listFiles().then(async (list) => {
      let last: string | null = null;
      try {
        last = localStorage.getItem('ks-charts-last');
      } catch {
        last = null;
      }
      const target = list.find((f) => f.path === last) ?? list[0];
      if (target) await openFile(target.path);
    });
  }, [profilesDir, listFiles, openFile]);

  // autosave
  useEffect(() => {
    if (!ws || !file || saveState !== 'pending') return;
    const t = window.setTimeout(() => {
      api.fs
        .writeText(file, JSON.stringify(ws, null, 1))
        .then(() => setSaveState('saved'))
        .catch((e) => {
          setSaveState('error');
          void errorDialog(e);
        });
    }, 700);
    return () => window.clearTimeout(t);
  }, [ws, file, saveState]);

  const update = useCallback((fn: (w: ChartWorkspace) => ChartWorkspace) => {
    setWs((cur) => (cur ? { ...fn(cur), updatedAt: Date.now() } : cur));
    setSaveState('pending');
  }, []);

  const createWorkspace = async () => {
    const name = await promptDialog({
      title: tr('Neuer Arbeitsbereich', 'New Workspace'),
      label: tr('Name', 'Name'),
      value: uniqueName(tr('Auswertungen', 'Reports'), files.map((f) => f.name.replace(/\.[^.]+$/, ''))),
      validate: (v) => (!v.trim() ? tr('Bitte einen Namen eingeben.', 'Please enter a name.') : files.some((f) => f.path.toLowerCase() === fileOf(v.trim()).toLowerCase()) ? tr('Der Name ist bereits vergeben.', 'The name is already in use.') : null)
    });
    if (!name) return;
    const path = fileOf(name.trim());
    const w = newWorkspace(name.trim());
    try {
      await api.fs.writeText(path, JSON.stringify(w, null, 1));
      await listFiles();
      await openFile(path);
    } catch (e) {
      void errorDialog(e);
    }
  };

  const renameWorkspace = async () => {
    if (!ws || !file) return;
    const name = await promptDialog({ title: tr('Arbeitsbereich umbenennen', 'Rename Workspace'), label: tr('Name', 'Name'), value: ws.name, validate: (v) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.')) });
    if (!name || name.trim() === ws.name) return;
    const path = fileOf(name.trim());
    try {
      const next = { ...ws, name: name.trim() };
      await api.fs.writeText(path, JSON.stringify(next, null, 1));
      if (path.toLowerCase() !== file.toLowerCase()) await api.fs.remove(file);
      setWs(next);
      setFile(path);
      await listFiles();
    } catch (e) {
      void errorDialog(e);
    }
  };

  const deleteWorkspace = async () => {
    if (!ws || !file) return;
    const ok = await confirmDialog({ title: tr('Arbeitsbereich löschen', 'Delete Workspace'), message: tr('Arbeitsbereich „{n}“ mit allen Diagrammen und Dashboards löschen?', 'Delete workspace "{n}" with all charts and dashboards?', { n: ws.name }), danger: true, okLabel: tr('Löschen', 'Delete') });
    if (!ok) return;
    try {
      await api.fs.remove(file);
      setWs(null);
      setFile(null);
      setSel(null);
      const list = await listFiles();
      if (list[0]) await openFile(list[0].path);
    } catch (e) {
      void errorDialog(e);
    }
  };

  // ───────────── data loading (own sessions per connection) ─────────────

  useEffect(
    () => () => {
      for (const sid of sessions.current.values()) void api.session.close(sid).catch(() => undefined);
      sessions.current.clear();
    },
    []
  );

  const loadSource = useCallback(async (src: DataSource) => {
    if (!src.connectionId || !src.sql.trim()) {
      setLoaded((l) => ({ ...l, [src.id]: { data: null, columns: [], loading: false, error: !src.sql.trim() ? tr('Keine Abfrage definiert', 'No query defined') : tr('Keine Verbindung gewählt', 'No connection chosen') } }));
      return;
    }
    setLoaded((l) => ({ ...l, [src.id]: { ...(l[src.id] ?? { data: null, columns: [] }), loading: true, error: null } }));
    try {
      let sid = sessions.current.get(src.connectionId);
      if (!sid) {
        sid = (await openSessionWithPrompt(src.connectionId, null)).sessionId;
        sessions.current.set(src.connectionId, sid);
      }
      const run = async (id: string) => {
        if (src.database) await api.session.useDatabase(id, src.database);
        return api.query.execute(id, src.sql, { maxRows: src.maxRows > 0 ? src.maxRows : 0, stopOnError: true, history: false });
      };
      let res;
      try {
        res = await run(sid);
      } catch (e) {
        if (errorCode(e) !== 'NO_SESSION') throw e;
        sid = (await openSessionWithPrompt(src.connectionId, null)).sessionId;
        sessions.current.set(src.connectionId, sid);
        res = await run(sid);
      }
      const err = res.results.find((r) => r.kind === 'error');
      if (err) throw new Error(err.error?.message ?? tr('Unbekannter Fehler', 'Unknown error'));
      const rs = [...res.results].reverse().find((r) => r.kind === 'resultset');
      if (!rs?.columns) throw new Error(tr('Die Abfrage liefert keine Ergebnismenge.', 'The query returns no result set.'));
      const data: SourceData = { columns: rs.columns.map((c) => ({ name: c.name, numeric: c.numeric })), rows: rs.rows ?? [], loadedAt: Date.now(), truncated: !!rs.truncated };
      setLoaded((l) => ({ ...l, [src.id]: { data, columns: rs.columns!, loading: false, error: null } }));
    } catch (e) {
      const msg = isUserCancelled(e) ? tr('Anmeldung abgebrochen', 'Sign in cancelled') : errorMessage(e);
      setLoaded((l) => ({ ...l, [src.id]: { ...(l[src.id] ?? { data: null, columns: [] }), loading: false, error: msg } }));
    }
  }, []);

  const ensureLoaded = useCallback(
    (sourceIds: string[]) => {
      const w = wsRef.current;
      if (!w) return;
      for (const id of new Set(sourceIds)) {
        const s = w.sources.find((x) => x.id === id);
        if (s && !loaded[id]) void loadSource(s);
      }
    },
    [loaded, loadSource]
  );

  // ───────────── item operations ─────────────

  const addSource = () => {
    if (!ws) return;
    const s = newSource(uniqueName(tr('Datenquelle', 'Data source'), ws.sources.map((x) => x.name)));
    update((w) => ({ ...w, sources: [...w.sources, s] }));
    setSel({ kind: 'source', id: s.id });
  };
  const addChart = () => {
    if (!ws) return;
    if (!ws.sources.length) {
      toast(tr('Legen Sie zuerst eine Datenquelle an.', 'Create a data source first.'));
      addSource();
      return;
    }
    const srcId = sel?.kind === 'source' ? sel.id : sel?.kind === 'chart' ? (ws.charts.find((c) => c.id === sel.id)?.sourceId ?? ws.sources[0].id) : ws.sources[0].id;
    const c = newChart(uniqueName(tr('Diagramm', 'Chart'), ws.charts.map((x) => x.name)), srcId);
    update((w) => ({ ...w, charts: [...w.charts, c] }));
    setSel({ kind: 'chart', id: c.id });
  };
  const addDashboard = () => {
    if (!ws) return;
    const d = newDashboard(uniqueName(tr('Dashboard', 'Dashboard'), ws.dashboards.map((x) => x.name)));
    update((w) => ({ ...w, dashboards: [...w.dashboards, d] }));
    setSel({ kind: 'dashboard', id: d.id });
  };

  const removeItem = async (kind: 'source' | 'chart' | 'dashboard', id: string) => {
    if (!ws) return;
    const name = kind === 'source' ? ws.sources.find((x) => x.id === id)?.name : kind === 'chart' ? ws.charts.find((x) => x.id === id)?.name : ws.dashboards.find((x) => x.id === id)?.name;
    const usedBy = kind === 'source' ? ws.charts.filter((c) => c.sourceId === id).map((c) => c.name) : kind === 'chart' ? ws.dashboards.filter((d) => d.items.some((i) => i.chartId === id)).map((d) => d.name) : [];
    const ok = await confirmDialog({
      title: tr('Löschen', 'Delete'),
      message:
        tr('„{n}“ löschen?', 'Delete "{n}"?', { n: name ?? '' }) +
        (usedBy.length ? `\n\n${kind === 'source' ? tr('Folgende Diagramme verwenden die Datenquelle:', 'These charts use the data source:') : tr('Das Diagramm wird aus folgenden Dashboards entfernt:', 'The chart will be removed from these dashboards:')}\n${usedBy.map((u) => `• ${u}`).join('\n')}` : ''),
      danger: true,
      okLabel: tr('Löschen', 'Delete')
    });
    if (!ok) return;
    update((w) => ({
      ...w,
      sources: kind === 'source' ? w.sources.filter((x) => x.id !== id) : w.sources,
      charts: kind === 'chart' ? w.charts.filter((x) => x.id !== id) : w.charts,
      dashboards: kind === 'dashboard' ? w.dashboards.filter((x) => x.id !== id) : kind === 'chart' ? w.dashboards.map((d) => ({ ...d, items: d.items.filter((i) => i.chartId !== id) })) : w.dashboards
    }));
    if (sel?.id === id) setSel(null);
  };

  const duplicateItem = (kind: 'source' | 'chart' | 'dashboard', id: string) => {
    if (!ws) return;
    const nid = newId(kind === 'source' ? 'ds' : kind === 'chart' ? 'ch' : 'db');
    update((w) => {
      if (kind === 'source') {
        const s = w.sources.find((x) => x.id === id)!;
        return { ...w, sources: [...w.sources, { ...s, id: nid, name: uniqueName(`${s.name} (2)`, w.sources.map((x) => x.name)) }] };
      }
      if (kind === 'chart') {
        const c = w.charts.find((x) => x.id === id)!;
        return { ...w, charts: [...w.charts, { ...structuredClone(c), id: nid, name: uniqueName(`${c.name} (2)`, w.charts.map((x) => x.name)) }] };
      }
      const d = w.dashboards.find((x) => x.id === id)!;
      return { ...w, dashboards: [...w.dashboards, { ...structuredClone(d), id: nid, name: uniqueName(`${d.name} (2)`, w.dashboards.map((x) => x.name)), items: d.items.map((i) => ({ ...i, id: newId('di') })) }] };
    });
    setSel({ kind, id: nid });
  };

  const renameItem = async (kind: 'source' | 'chart' | 'dashboard', id: string, current: string) => {
    const name = await promptDialog({ title: tr('Umbenennen', 'Rename'), label: tr('Name', 'Name'), value: current, validate: (v) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.')) });
    if (!name) return;
    const n = name.trim();
    update((w) => ({
      ...w,
      sources: kind === 'source' ? w.sources.map((x) => (x.id === id ? { ...x, name: n } : x)) : w.sources,
      charts: kind === 'chart' ? w.charts.map((x) => (x.id === id ? { ...x, name: n } : x)) : w.charts,
      dashboards: kind === 'dashboard' ? w.dashboards.map((x) => (x.id === id ? { ...x, name: n } : x)) : w.dashboards
    }));
  };

  const itemMenu = (e: React.MouseEvent, kind: 'source' | 'chart' | 'dashboard', id: string, name: string) =>
    showContextMenu(e, [
      { label: tr('Umbenennen …', 'Rename …'), icon: <Pencil size={14} />, onClick: () => void renameItem(kind, id, name) },
      { label: tr('Duplizieren', 'Duplicate'), icon: <Copy size={14} />, onClick: () => duplicateItem(kind, id) },
      SEP,
      { label: tr('Löschen', 'Delete'), icon: <Trash2 size={14} />, danger: true, onClick: () => void removeItem(kind, id) }
    ]);

  const refreshAll = () => {
    if (!ws) return;
    for (const s of ws.sources) if (loaded[s.id] || ws.charts.some((c) => c.sourceId === s.id)) void loadSource(s);
  };

  // ───────────── render ─────────────

  const listItem = (kind: 'source' | 'chart' | 'dashboard', id: string, name: string, icon: ReactNode) => (
    <div key={id} className={`ks-ch-item ${sel?.id === id ? 'selected' : ''}`} onClick={() => setSel({ kind, id })} onContextMenu={(e) => itemMenu(e, kind, id, name)} onDoubleClick={() => void renameItem(kind, id, name)} title={name}>
      {icon}
      <span className="ellipsis">{name}</span>
    </div>
  );

  const source = sel?.kind === 'source' ? ws?.sources.find((s) => s.id === sel.id) : undefined;
  const chart = sel?.kind === 'chart' ? ws?.charts.find((c) => c.id === sel.id) : undefined;
  const dashboard = sel?.kind === 'dashboard' ? ws?.dashboards.find((d) => d.id === sel.id) : undefined;

  return (
    <div className="ks-ch" ref={rootRef}>
      <Toolbar>
        <Select
          value={file ?? ''}
          title={tr('Arbeitsbereich', 'Workspace')}
          onChange={(p) => p && void openFile(p)}
          options={[...(file ? [] : [{ value: '', label: tr('(kein Arbeitsbereich)', '(no workspace)') }]), ...files.map((f) => ({ value: f.path, label: f.name.replace(/\.[^.]+$/, '') }))]}
        />
        <ToolbarButton
          icon={<FilePlus size={15} />}
          title={tr('Arbeitsbereich', 'Workspace')}
          dropdown
          onClick={(e) =>
            showMenuBelow(e.currentTarget, [
              { label: tr('Neuer Arbeitsbereich …', 'New Workspace …'), icon: <FilePlus size={14} />, onClick: () => void createWorkspace() },
              { label: tr('Umbenennen …', 'Rename …'), disabled: !ws, onClick: () => void renameWorkspace() },
              { label: tr('Im Explorer anzeigen', 'Show in Explorer'), disabled: !file, onClick: () => file && void api.app.showItemInFolder(file) },
              SEP,
              { label: tr('Löschen …', 'Delete …'), icon: <Trash2 size={14} />, danger: true, disabled: !ws, onClick: () => void deleteWorkspace() }
            ])
          }
        />
        <ToolbarSep />
        <ToolbarButton icon={<Database size={15} />} label={tr('Datenquelle', 'Data Source')} disabled={!ws} onClick={addSource} />
        <ToolbarButton icon={<ChartColumn size={15} />} label={tr('Diagramm', 'Chart')} disabled={!ws} onClick={addChart} />
        <ToolbarButton icon={<LayoutDashboard size={15} />} label={tr('Dashboard', 'Dashboard')} disabled={!ws} onClick={addDashboard} />
        <ToolbarSep />
        <ToolbarButton icon={<RefreshCw size={15} />} label={tr('Alle aktualisieren', 'Refresh All')} disabled={!ws} onClick={refreshAll} />
        <div className="spacer" />
        {ws && <span className="muted" style={{ fontSize: 12, marginRight: 6 }}>{saveState === 'pending' ? tr('Wird gespeichert …', 'Saving …') : saveState === 'error' ? tr('Speichern fehlgeschlagen', 'Saving failed') : tr('Gespeichert', 'Saved')}</span>}
      </Toolbar>
      {!ws ? (
        <EmptyState icon={<ChartColumn size={44} />} title={tr('Diagramme & Dashboards', 'Charts & Dashboards')}>
          <p>{tr('Legen Sie einen Arbeitsbereich an. Er enthält Datenquellen (SQL-Abfragen), Diagramme und Dashboards.', 'Create a workspace. It holds data sources (SQL queries), charts and dashboards.')}</p>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => void createWorkspace()}>
            {tr('Neuer Arbeitsbereich', 'New Workspace')}
          </Button>
        </EmptyState>
      ) : (
        <div className="ks-ch-body">
          <div className="ks-ch-side">
            <div className="ks-ch-group">
              {tr('Datenquellen', 'Data Sources')}
              <span className="spacer" />
              <IconButton icon={<Plus size={13} />} title={tr('Neue Datenquelle', 'New data source')} onClick={addSource} />
            </div>
            {ws.sources.map((s) => listItem('source', s.id, s.name, <Database size={14} style={{ color: 'var(--c-query)' }} />))}
            {!ws.sources.length && <div className="ks-ch-empty-list">{tr('Keine', 'None')}</div>}
            <div className="ks-ch-group">
              {tr('Diagramme', 'Charts')}
              <span className="spacer" />
              <IconButton icon={<Plus size={13} />} title={tr('Neues Diagramm', 'New chart')} onClick={addChart} />
            </div>
            {ws.charts.map((c) => listItem('chart', c.id, c.name, <span style={{ color: 'var(--c-chart)', display: 'flex' }}>{TYPE_ICON[c.type]}</span>))}
            {!ws.charts.length && <div className="ks-ch-empty-list">{tr('Keine', 'None')}</div>}
            <div className="ks-ch-group">
              {tr('Dashboards', 'Dashboards')}
              <span className="spacer" />
              <IconButton icon={<Plus size={13} />} title={tr('Neues Dashboard', 'New dashboard')} onClick={addDashboard} />
            </div>
            {ws.dashboards.map((d) => listItem('dashboard', d.id, d.name, <LayoutDashboard size={14} style={{ color: 'var(--c-model)' }} />))}
            {!ws.dashboards.length && <div className="ks-ch-empty-list">{tr('Keine', 'None')}</div>}
          </div>
          <div className="ks-ch-main">
            {source && (
              <SourceEditor
                key={source.id}
                src={source}
                state={loaded[source.id]}
                onChange={(p) => update((w) => ({ ...w, sources: w.sources.map((s) => (s.id === source.id ? { ...s, ...p } : s)) }))}
                onRun={() => void loadSource(source)}
              />
            )}
            {chart && (
              <ChartEditor
                key={chart.id}
                ws={ws}
                chart={chart}
                state={loaded[chart.sourceId]}
                ensure={ensureLoaded}
                onReload={() => {
                  const s = ws.sources.find((x) => x.id === chart.sourceId);
                  if (s) void loadSource(s);
                }}
                onChange={(p) => update((w) => ({ ...w, charts: w.charts.map((c) => (c.id === chart.id ? { ...c, ...p } : c)) }))}
              />
            )}
            {dashboard && (
              <DashboardEditor
                key={dashboard.id}
                ws={ws}
                dash={dashboard}
                loaded={loaded}
                active={active}
                ensure={ensureLoaded}
                reload={(ids) => {
                  for (const id of new Set(ids)) {
                    const s = ws.sources.find((x) => x.id === id);
                    if (s) void loadSource(s);
                  }
                }}
                onChange={(p) => update((w) => ({ ...w, dashboards: w.dashboards.map((d) => (d.id === dashboard.id ? { ...d, ...p } : d)) }))}
                openChart={(id) => setSel({ kind: 'chart', id })}
                fullscreenEl={rootRef}
              />
            )}
            {!source && !chart && !dashboard && (
              <EmptyState icon={<LayoutDashboard size={40} />} title={ws.name}>
                <p>{tr('Wählen Sie links ein Element aus oder legen Sie ein neues an.', 'Select an item on the left or create a new one.')}</p>
                <div className="row" style={{ justifyContent: 'center' }}>
                  <Button icon={<Database size={14} />} onClick={addSource}>
                    {tr('Datenquelle', 'Data Source')}
                  </Button>
                  <Button icon={<ChartColumn size={14} />} onClick={addChart}>
                    {tr('Diagramm', 'Chart')}
                  </Button>
                  <Button icon={<LayoutDashboard size={14} />} onClick={addDashboard}>
                    {tr('Dashboard', 'Dashboard')}
                  </Button>
                </div>
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── data source ─────────────────────────

function SourceEditor({ src, state, onChange, onRun }: { src: DataSource; state?: Loaded; onChange: (p: Partial<DataSource>) => void; onRun: () => void }) {
  const gridCols = useMemo(() => (state?.columns ?? []).map((c) => columnFromResult(c)), [state?.columns]);
  const rows = state?.data?.rows ?? [];
  return (
    <>
      <div className="ks-ch-src-form">
        <Field label={tr('Name', 'Name')} labelWidth={90}>
          <TextInput value={src.name} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Field label={tr('Max. Zeilen', 'Max rows')} labelWidth={90} hint={tr('0 = unbegrenzt', '0 = unlimited')}>
          <NumberInput value={src.maxRows} min={0} onChange={(v) => onChange({ maxRows: v === '' ? 0 : v })} style={{ width: 130 }} />
        </Field>
        <ConnectionDbPicker connectionId={src.connectionId} database={src.database} labelWidth={90} onChange={(connectionId, database) => onChange({ connectionId, database })} />
      </div>
      <div className="ks-ch-src-sql">
        <SqlEditor
          value={src.sql}
          onChange={(sql) => onChange({ sql })}
          completion={src.connectionId && src.database ? { connectionId: src.connectionId, database: src.database } : null}
          onMount={(ed, m) => ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, onRun)}
        />
      </div>
      <div className="ks-ch-bar">
        <Button size="sm" variant="primary" icon={state?.loading ? <Spinner size={12} /> : <Play size={13} />} disabled={state?.loading} onClick={onRun}>
          {tr('Ausführen', 'Run')} (Ctrl+Enter)
        </Button>
        {state?.error && <span className="danger-text ellipsis">{state.error}</span>}
        <div className="spacer" />
        {state?.data && (
          <span className="muted">
            {tr('{n} Zeilen · {c} Felder · geladen {t}', '{n} rows · {c} fields · loaded {t}', { n: formatNumber(rows.length), c: state.data.columns.length, t: formatDateTime(state.data.loadedAt) })}
            {state.data.truncated ? ` · ${tr('gekürzt', 'truncated')}` : ''}
          </span>
        )}
      </div>
      <div className="ks-ch-grid">
        <DataGrid columns={gridCols} rowCount={rows.length} getValue={(r, c) => rows[r]?.[c] ?? null} empty={<span>{tr('Führen Sie die Abfrage aus, um eine Vorschau zu sehen.', 'Run the query to see a preview.')}</span>} />
      </div>
    </>
  );
}

// ───────────────────────── chart designer ─────────────────────────

const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: '=', label: '=' },
  { value: '!=', label: '≠' },
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: '>', label: '>' },
  { value: '>=', label: '≥' },
  { value: 'contains', label: tr('enthält', 'contains') },
  { value: 'notContains', label: tr('enthält nicht', 'does not contain') },
  { value: 'startsWith', label: tr('beginnt mit', 'begins with') },
  { value: 'endsWith', label: tr('endet mit', 'ends with') },
  { value: 'between', label: tr('zwischen', 'between') },
  { value: 'in', label: tr('in Liste', 'in list') },
  { value: 'empty', label: tr('ist leer', 'is empty') },
  { value: 'notEmpty', label: tr('ist nicht leer', 'is not empty') }
];

function ChartEditor({
  ws,
  chart,
  state,
  ensure,
  onReload,
  onChange
}: {
  ws: ChartWorkspace;
  chart: ChartDef;
  state?: Loaded;
  ensure: (ids: string[]) => void;
  onReload: () => void;
  onChange: (p: Partial<ChartDef>) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => ensure([chart.sourceId]), [chart.sourceId, ensure]);
  const fields = state?.data?.columns ?? [];
  const fieldOpts = (allowEmpty: boolean) => [...(allowEmpty ? [{ value: '', label: tr('(keins)', '(none)') }] : []), ...fields.map((f) => ({ value: f.name, label: f.name }))];
  const numericFirst = fields.find((f) => f.numeric)?.name ?? fields[0]?.name ?? '';
  const needsCategory = !['kpi', 'gauge', 'scatter'].includes(chart.type);
  const f = chart.format;
  return (
    <div className="ks-ch-design">
      <div className="ks-ch-shelves">
        <Field label={tr('Name', 'Name')}>
          <TextInput value={chart.name} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Field label={tr('Datenquelle', 'Data source')}>
          <Select value={chart.sourceId} onChange={(sourceId) => onChange({ sourceId })} options={ws.sources.map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <h4>{tr('Diagrammtyp', 'Chart type')}</h4>
        <div className="ks-ch-types">
          {CHART_TYPES.map((t) => (
            <button key={t.type} type="button" className={`ks-ch-type ${chart.type === t.type ? 'active' : ''}`} title={t.label()} onClick={() => onChange({ type: t.type })}>
              {TYPE_ICON[t.type]}
              <span>{t.label()}</span>
            </button>
          ))}
        </div>
        {!fields.length && (
          <div className="muted" style={{ fontSize: 12 }}>
            {state?.loading ? tr('Daten werden geladen …', 'Loading data …') : state?.error ?? tr('Keine Felder – Datenquelle ausführen.', 'No fields – run the data source.')}
          </div>
        )}
        {needsCategory && (
          <>
            <h4>{chart.type === 'heatmap' ? tr('Spalten (X)', 'Columns (X)') : chart.type === 'table' ? tr('Gruppieren nach', 'Group by') : tr('Kategorie (X-Achse)', 'Category (X axis)')}</h4>
            <div className="ks-ch-shelf">
              <div className="ks-ch-shelf-row">
                <Select value={chart.category} onChange={(category) => onChange({ category })} options={fieldOpts(true)} />
                <Select
                  value={chart.datePart}
                  title={tr('Datumsteil', 'Date part')}
                  onChange={(datePart) => onChange({ datePart })}
                  style={{ width: 100, flex: 'none' }}
                  options={[
                    { value: '', label: tr('Wert', 'Value') },
                    { value: 'year', label: tr('Jahr', 'Year') },
                    { value: 'quarter', label: tr('Quartal', 'Quarter') },
                    { value: 'month', label: tr('Monat', 'Month') },
                    { value: 'day', label: tr('Tag', 'Day') },
                    { value: 'hour', label: tr('Stunde', 'Hour') },
                    { value: 'weekday', label: tr('Wochentag', 'Weekday') }
                  ]}
                />
              </div>
            </div>
          </>
        )}
        <h4>
          {chart.type === 'scatter' ? tr('Werte (X, Y)', 'Values (X, Y)') : tr('Werte', 'Values')}
          <span className="spacer" />
          <IconButton icon={<Plus size={13} />} title={tr('Wertfeld hinzufügen', 'Add value field')} disabled={!fields.length} onClick={() => onChange({ values: [...chart.values, { field: numericFirst, agg: chart.type === 'scatter' ? 'none' : 'sum', label: '' }] })} />
        </h4>
        <div className="ks-ch-shelf">
          {chart.values.map((v, i) => (
            <div key={i} className="ks-ch-shelf-row">
              <Select value={v.field} onChange={(field) => onChange({ values: chart.values.map((x, j) => (j === i ? { ...x, field } : x)) })} options={fieldOpts(false).concat(fields.some((x) => x.name === v.field) ? [] : [{ value: v.field, label: v.field }])} />
              <Select value={v.agg} style={{ width: 96, flex: 'none' }} onChange={(agg) => onChange({ values: chart.values.map((x, j) => (j === i ? { ...x, agg } : x)) })} options={AGGREGATIONS.map((a) => ({ value: a.value, label: a.label() }))} />
              <IconButton icon={<X size={13} />} title={tr('Entfernen', 'Remove')} onClick={() => onChange({ values: chart.values.filter((_, j) => j !== i) })} />
            </div>
          ))}
          {!chart.values.length && <span className="faint">{tr('Kein Wertfeld', 'No value field')}</span>}
        </div>
        {!['kpi', 'gauge', 'pie', 'donut', 'table'].includes(chart.type) && (
          <>
            <h4>{chart.type === 'heatmap' ? tr('Zeilen (Y)', 'Rows (Y)') : tr('Serie / Farbe nach', 'Series / color by')}</h4>
            <Select value={chart.series} onChange={(series) => onChange({ series })} options={fieldOpts(true)} />
          </>
        )}
        <h4>
          {tr('Filter', 'Filters')}
          <span className="spacer" />
          <IconButton icon={<Plus size={13} />} title={tr('Filter hinzufügen', 'Add filter')} disabled={!fields.length} onClick={() => onChange({ filters: [...chart.filters, { field: fields[0]?.name ?? '', op: '=', value: '', value2: '' }] })} />
        </h4>
        {chart.filters.map((flt, i) => {
          const set = (p: Partial<typeof flt>) => onChange({ filters: chart.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) });
          return (
            <div key={i} className="ks-ch-shelf">
              <div className="ks-ch-shelf-row">
                <Select value={flt.field} onChange={(field) => set({ field })} options={fieldOpts(false)} />
                <Select value={flt.op} style={{ width: 104, flex: 'none' }} onChange={(op) => set({ op })} options={FILTER_OPS} />
                <IconButton icon={<X size={13} />} title={tr('Entfernen', 'Remove')} onClick={() => onChange({ filters: chart.filters.filter((_, j) => j !== i) })} />
              </div>
              {flt.op !== 'empty' && flt.op !== 'notEmpty' && (
                <div className="ks-ch-shelf-row">
                  <TextInput value={flt.value} placeholder={flt.op === 'in' ? 'a, b, c' : tr('Wert', 'Value')} onChange={(e) => set({ value: e.target.value })} />
                  {flt.op === 'between' && <TextInput value={flt.value2} placeholder={tr('bis', 'to')} onChange={(e) => set({ value2: e.target.value })} />}
                </div>
              )}
            </div>
          );
        })}
        {needsCategory && (
          <>
            <h4>{tr('Sortierung', 'Sorting')}</h4>
            <div className="ks-ch-shelf-row">
              <Select
                value={chart.sort}
                onChange={(sort) => onChange({ sort })}
                options={[
                  { value: 'none', label: tr('Datenreihenfolge', 'Data order') },
                  { value: 'category', label: tr('Kategorie aufsteigend', 'Category ascending') },
                  { value: 'categoryDesc', label: tr('Kategorie absteigend', 'Category descending') },
                  { value: 'valueAsc', label: tr('Wert aufsteigend', 'Value ascending') },
                  { value: 'valueDesc', label: tr('Wert absteigend', 'Value descending') }
                ]}
              />
              <span className="muted">Top</span>
              <NumberInput value={chart.limit} min={0} style={{ width: 64 }} onChange={(v) => onChange({ limit: v === '' ? 0 : Math.max(0, v) })} />
            </div>
          </>
        )}
        <h4>{tr('Darstellung', 'Appearance')}</h4>
        <Field label={tr('Titel', 'Title')}>
          <div className="row">
            <Checkbox checked={chart.showTitle} onChange={(showTitle) => onChange({ showTitle })} />
            <TextInput value={chart.title} placeholder={chart.name} onChange={(e) => onChange({ title: e.target.value })} />
          </div>
        </Field>
        {!['kpi', 'gauge', 'table'].includes(chart.type) && (
          <>
            <Field label={tr('Legende', 'Legend')}>
              <Select
                value={chart.legend}
                onChange={(legend) => onChange({ legend })}
                options={[
                  { value: 'bottom', label: tr('Unten', 'Bottom') },
                  { value: 'top', label: tr('Oben', 'Top') },
                  { value: 'right', label: tr('Rechts', 'Right') },
                  { value: 'none', label: tr('Keine', 'None') }
                ]}
              />
            </Field>
            <Field label={tr('Farben', 'Colors')}>
              <Select value={chart.palette} onChange={(palette) => onChange({ palette })} options={Object.entries(PALETTES).map(([k, p]) => ({ value: k, label: p.label() }))} />
            </Field>
            <div className="row" style={{ flexWrap: 'wrap', gap: '2px 14px' }}>
              <Checkbox checked={chart.labels} onChange={(labels) => onChange({ labels })} label={tr('Datenbeschriftung', 'Data labels')} />
              {(chart.type === 'line' || chart.type === 'area') && <Checkbox checked={chart.smooth} onChange={(smooth) => onChange({ smooth })} label={tr('Geglättet', 'Smoothed')} />}
            </div>
          </>
        )}
        {(chart.type === 'kpi' || chart.type === 'gauge') && (
          <>
            <Field label={tr('Zielwert', 'Target')}>
              <NumberInput value={chart.target ?? ''} onChange={(v) => onChange({ target: v === '' ? null : v })} />
            </Field>
            {chart.type === 'gauge' && (
              <Field label={tr('Min / Max', 'Min / Max')}>
                <div className="row">
                  <NumberInput value={chart.min ?? ''} onChange={(v) => onChange({ min: v === '' ? null : v })} />
                  <NumberInput value={chart.max ?? ''} onChange={(v) => onChange({ max: v === '' ? null : v })} />
                </div>
              </Field>
            )}
          </>
        )}
        <h4>{tr('Zahlenformat', 'Number format')}</h4>
        <Field label={tr('Dezimalstellen', 'Decimals')}>
          <NumberInput value={f.decimals ?? ''} min={0} max={10} onChange={(v) => onChange({ format: { ...f, decimals: v === '' ? null : Math.max(0, Math.min(10, v)) } })} />
        </Field>
        <Field label={tr('Präfix / Suffix', 'Prefix / suffix')}>
          <div className="row">
            <TextInput value={f.prefix} onChange={(e) => onChange({ format: { ...f, prefix: e.target.value } })} />
            <TextInput value={f.suffix} placeholder=" €" onChange={(e) => onChange({ format: { ...f, suffix: e.target.value } })} />
          </div>
        </Field>
        <Field label={tr('Einheit', 'Unit')}>
          <div className="row">
            <Select
              value={f.unit}
              onChange={(unit) => onChange({ format: { ...f, unit } })}
              options={[
                { value: '', label: tr('Keine', 'None') },
                { value: 'K', label: tr('Tausend', 'Thousands') },
                { value: 'M', label: tr('Millionen', 'Millions') },
                { value: 'B', label: tr('Milliarden', 'Billions') }
              ]}
            />
            <Checkbox checked={f.thousands} onChange={(thousands) => onChange({ format: { ...f, thousands } })} label={tr('Tausendertrennung', 'Grouping')} />
          </div>
        </Field>
      </div>
      <div className="ks-ch-main">
        <div className="ks-ch-bar">
          <Button size="sm" icon={state?.loading ? <Spinner size={12} /> : <RefreshCw size={13} />} disabled={state?.loading} onClick={onReload}>
            {tr('Daten aktualisieren', 'Refresh data')}
          </Button>
          <Button size="sm" icon={<Image size={13} />} onClick={() => cardRef.current && void exportElementPng(cardRef.current, chart.name).catch((e) => errorDialog(e))}>
            {tr('Als PNG exportieren', 'Export PNG')}
          </Button>
          <div className="spacer" />
          {state?.data && (
            <span className="muted">
              {tr('{n} Datensätze · {t}', '{n} records · {t}', { n: formatNumber(state.data.rows.length), t: formatDateTime(state.data.loadedAt) })}
            </span>
          )}
        </div>
        <div className="ks-ch-preview">
          <div className="ks-ch-card" ref={cardRef}>
            <ChartView chart={chart} data={state?.data ?? null} loading={state?.loading} error={state?.error} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── dashboard ─────────────────────────

function DashboardEditor({
  ws,
  dash,
  loaded,
  active,
  ensure,
  reload,
  onChange,
  openChart,
  fullscreenEl
}: {
  ws: ChartWorkspace;
  dash: Dashboard;
  loaded: Record<string, Loaded>;
  active: boolean;
  ensure: (ids: string[]) => void;
  reload: (ids: string[]) => void;
  onChange: (p: Partial<Dashboard>) => void;
  openChart: (id: string) => void;
  fullscreenEl: React.RefObject<HTMLDivElement | null>;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null);
  const sourceIds = useMemo(() => dash.items.filter((i) => i.kind === 'chart').map((i) => ws.charts.find((c) => c.id === i.chartId)?.sourceId ?? '').filter(Boolean), [dash.items, ws.charts]);

  useEffect(() => ensure(sourceIds), [sourceIds, ensure]);

  useEffect(() => {
    if (!dash.refresh || !active) return;
    const t = window.setInterval(() => reload(sourceIds), dash.refresh * 1000);
    return () => window.clearInterval(t);
  }, [dash.refresh, active, sourceIds, reload]);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const colW = width / DASH_COLUMNS;
  const bottom = Math.max(8, ...dash.items.map((i) => i.y + i.h), drag ? drag.y + drag.h : 0);

  const nextY = () => Math.max(0, ...dash.items.map((i) => i.y + i.h));
  const addChartItem = (chartId: string) => {
    const it: DashboardItem = { id: newId('di'), kind: 'chart', chartId, text: '', x: 0, y: nextY(), w: 6, h: 7 };
    const row = dash.items.filter((i) => i.y + i.h === nextY());
    const right = row.length === 1 && row[0].x + row[0].w <= 6 ? row[0] : null;
    if (right) {
      it.x = right.x + right.w;
      it.y = right.y;
      it.h = right.h;
    }
    onChange({ items: [...dash.items, it] });
    setSelected(it.id);
  };
  const addText = () => {
    const it: DashboardItem = { id: newId('di'), kind: 'text', chartId: '', text: tr('Überschrift', 'Heading'), x: 0, y: nextY(), w: 12, h: 2 };
    onChange({ items: [...dash.items, it] });
    setSelected(it.id);
    setEditing(it.id);
  };

  const startPointer = (e: React.PointerEvent, it: DashboardItem, mode: 'move' | 'resize') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(it.id);
    const sx = e.clientX;
    const sy = e.clientY;
    let cur = { id: it.id, x: it.x, y: it.y, w: it.w, h: it.h };
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - sx) / colW);
      const dy = Math.round((ev.clientY - sy) / ROW_HEIGHT);
      cur =
        mode === 'move'
          ? { ...cur, x: Math.max(0, Math.min(DASH_COLUMNS - it.w, it.x + dx)), y: Math.max(0, it.y + dy) }
          : { ...cur, w: Math.max(2, Math.min(DASH_COLUMNS - it.x, it.w + dx)), h: Math.max(2, it.h + dy) };
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (cur.x !== it.x || cur.y !== it.y || cur.w !== it.w || cur.h !== it.h) onChange({ items: dash.items.map((i) => (i.id === it.id ? { ...i, x: cur.x, y: cur.y, w: cur.w, h: cur.h } : i)) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const itemMenu = (e: React.MouseEvent, it: DashboardItem) => {
    setSelected(it.id);
    const items: MenuItem[] = [
      { label: tr('Diagramm bearbeiten', 'Edit Chart'), icon: <Pencil size={14} />, hidden: it.kind !== 'chart', onClick: () => openChart(it.chartId) },
      { label: tr('Text bearbeiten', 'Edit Text'), icon: <Pencil size={14} />, hidden: it.kind !== 'text', onClick: () => setEditing(it.id) },
      { label: tr('Volle Breite', 'Full Width'), onClick: () => onChange({ items: dash.items.map((i) => (i.id === it.id ? { ...i, x: 0, w: DASH_COLUMNS } : i)) }) },
      { label: tr('Halbe Breite', 'Half Width'), onClick: () => onChange({ items: dash.items.map((i) => (i.id === it.id ? { ...i, w: 6, x: Math.min(i.x, 6) } : i)) }) },
      SEP,
      { label: tr('Aus Dashboard entfernen', 'Remove from Dashboard'), icon: <Trash2 size={14} />, danger: true, onClick: () => onChange({ items: dash.items.filter((i) => i.id !== it.id) }) }
    ];
    showContextMenu(e, items);
  };

  const exportPng = async () => {
    const el = boardRef.current;
    if (!el) return;
    setSelected(null);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    try {
      await exportElementPng(el, dash.name);
    } catch (e) {
      void errorDialog(e);
    }
  };

  const anyLoading = sourceIds.some((id) => loaded[id]?.loading);

  return (
    <>
      <div className="ks-ch-bar">
        <Field label={tr('Name', 'Name')} labelWidth={46}>
          <TextInput value={dash.name} onChange={(e) => onChange({ name: e.target.value })} style={{ width: 200 }} />
        </Field>
        <Button
          size="sm"
          icon={<ChartColumn size={13} />}
          onClick={(e) =>
            showMenuBelow(
              e.currentTarget,
              ws.charts.length
                ? ws.charts.map((c) => ({ label: c.name, icon: TYPE_ICON[c.type], onClick: () => addChartItem(c.id) }))
                : [{ label: tr('Noch keine Diagramme vorhanden', 'No charts yet'), disabled: true }]
            )
          }
        >
          {tr('Diagramm hinzufügen', 'Add Chart')}
        </Button>
        <Button size="sm" icon={<Type size={13} />} onClick={addText}>
          {tr('Text', 'Text')}
        </Button>
        <Button size="sm" icon={anyLoading ? <Spinner size={12} /> : <RefreshCw size={13} />} onClick={() => reload(sourceIds)}>
          {tr('Aktualisieren', 'Refresh')}
        </Button>
        <Select
          value={String(dash.refresh)}
          title={tr('Automatisch aktualisieren', 'Auto refresh')}
          style={{ width: 150 }}
          onChange={(v) => onChange({ refresh: Number(v) })}
          options={[
            { value: '0', label: tr('Auto-Aktualisierung aus', 'Auto refresh off') },
            { value: '30', label: tr('alle 30 Sekunden', 'every 30 seconds') },
            { value: '60', label: tr('jede Minute', 'every minute') },
            { value: '300', label: tr('alle 5 Minuten', 'every 5 minutes') },
            { value: '900', label: tr('alle 15 Minuten', 'every 15 minutes') }
          ]}
        />
        <div className="spacer" />
        <Button size="sm" icon={<Image size={13} />} disabled={!dash.items.length} onClick={() => void exportPng()}>
          PNG
        </Button>
        <IconButton
          icon={<Fullscreen size={15} />}
          title={tr('Vollbild', 'Full screen')}
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void fullscreenEl.current?.requestFullscreen().catch(() => undefined);
          }}
        />
      </div>
      <div className="ks-dash-scroll" onPointerDown={(e) => e.target === e.currentTarget && setSelected(null)}>
        <div className="ks-dash" ref={boardRef} style={{ height: bottom * ROW_HEIGHT + ROW_HEIGHT * 2 }} onPointerDown={(e) => e.target === e.currentTarget && setSelected(null)}>
          {!dash.items.length && <div className="ks-dash-empty">{tr('Fügen Sie Diagramme und Texte über die Leiste oben hinzu.', 'Add charts and texts with the bar above.')}</div>}
          {dash.items.map((it) => {
            const g = drag?.id === it.id ? drag : it;
            const c = it.kind === 'chart' ? ws.charts.find((x) => x.id === it.chartId) : undefined;
            const st = c ? loaded[c.sourceId] : undefined;
            return (
              <div
                key={it.id}
                className={`ks-dash-item ${selected === it.id ? 'selected' : ''} ${drag?.id === it.id ? 'moving' : ''}`}
                style={{ left: g.x * colW, top: g.y * ROW_HEIGHT, width: g.w * colW, height: g.h * ROW_HEIGHT }}
                onContextMenu={(e) => itemMenu(e, it)}
                onPointerDown={() => setSelected(it.id)}
              >
                <div className="ks-dash-box">
                  <div className="ks-dash-head" onPointerDown={(e) => startPointer(e, it, 'move')} onDoubleClick={() => (c ? openChart(c.id) : setEditing(it.id))}>
                    <span className="ellipsis">{c ? c.name : it.kind === 'text' ? tr('Text', 'Text') : tr('Diagramm fehlt', 'Chart missing')}</span>
                    {st?.loading && <Spinner size={10} />}
                  </div>
                  {it.kind === 'text' ? (
                    <div className={`ks-dash-text ${it.h <= 2 ? 'h1' : ''}`} onDoubleClick={() => setEditing(it.id)}>
                      {editing === it.id ? (
                        <TextArea
                          autoFocus
                          defaultValue={it.text}
                          onBlur={(e) => {
                            onChange({ items: dash.items.map((i) => (i.id === it.id ? { ...i, text: e.target.value } : i)) });
                            setEditing(null);
                          }}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Escape') setEditing(null);
                          }}
                        />
                      ) : (
                        it.text
                      )}
                    </div>
                  ) : c ? (
                    <ChartView chart={c} data={st?.data ?? null} loading={st?.loading} error={st?.error} />
                  ) : (
                    <div className="ks-ch-overlay faint">{tr('Das Diagramm wurde gelöscht.', 'The chart was deleted.')}</div>
                  )}
                </div>
                <div className="ks-dash-resize" onPointerDown={(e) => startPointer(e, it, 'resize')} />
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

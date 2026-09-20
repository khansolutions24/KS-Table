// Data synchronization: compare the records of mapped tables, review the differences and deploy
// INSERT / UPDATE / DELETE statements to the target.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Ban, CircleCheck, FileCode, GitCompareArrows, Play, RefreshCw, Save, Settings2 } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import clsx from 'clsx';
import { tr } from '@shared/i18n';
import type {
  DataCompareResult,
  DataDiffKind,
  DataDiffPage,
  DataSyncOptions,
  DataSyncPrepareResult,
  DataSyncProfile,
  DataSyncTableSelection,
  DsTable
} from '@shared/apis/sync';
import type { CellValue } from '@shared/types';
import { defaultDataSyncOptions, normalizeDataSyncProfile } from '@shared/sync/defaults';
import { valueClass, valuesEqual } from '@shared/sync/values';
import { formatNumber } from '@shared/util';
import { api } from '../../api/client';
import { columnFromMeta, type GridColumnDef } from '../../components/grid/cellFormat';
import { DataGrid, type DataGridHandle } from '../../components/grid/DataGrid';
import { ObjIcon } from '../../components/icons';
import { TaskPanel } from '../../components/TaskPanel';
import { Button, Checkbox, IconButton, SearchInput, Section, Select, Spinner, TabStrip, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { confirmDialog, Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { pickSaveFile } from '../../lib/files';
import { useTabs, type TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { EncodingSelect, EndpointFields, ProfileButtons, showScriptDialog, showTaskDialog, waitForTask } from './common';

type View = 'setup' | 'mapping' | 'result';

interface MapRow {
  enabled: boolean;
  target: string;
  /** '' = primary key; otherwise explicit key columns */
  key: string[];
  /** empty = all common columns */
  columns: string[];
}

const PAGE = 500;

function sameName(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function defaultKey(t: DsTable | undefined): string[] {
  if (!t) return [];
  return t.primaryKey.length ? t.primaryKey : (t.uniqueKeys.find((k) => !k.nullable)?.columns ?? []);
}

/** Dialog: key columns and synchronized columns of one mapping */
function editMapping(src: DsTable, tgt: DsTable | undefined, row: MapRow): Promise<MapRow | undefined> {
  return openDialog<MapRow>((close) => <MappingDialog src={src} tgt={tgt} row={row} close={close} />);
}

function MappingDialog({ src, tgt, row, close }: { src: DsTable; tgt: DsTable | undefined; row: MapRow; close: (v?: MapRow) => void }) {
  const cols = src.columns.filter((c) => !c.generated);
  const [key, setKey] = useState<string[]>(row.key.length ? row.key : defaultKey(src));
  const [sync, setSync] = useState<string[]>(row.columns.length ? row.columns : cols.map((c) => c.name));
  const inTarget = (n: string) => !!tgt?.columns.some((c) => sameName(c.name, n) && !c.generated);
  const flip = (list: string[], n: string, on: boolean) => (on ? [...list.filter((x) => x !== n), n] : list.filter((x) => x !== n));
  const ordered = (list: string[]) => cols.map((c) => c.name).filter((n) => list.includes(n));
  const all = cols.filter((c) => inTarget(c.name)).every((c) => sync.includes(c.name));
  return (
    <Dialog
      title={tr('Schlüssel und Felder – {t}', 'Key and Fields – {t}', { t: src.name })}
      width={560}
      height={520}
      resizable
      onClose={() => close()}
      onSubmit={() => close({ ...row, key: ordered(key), columns: all ? [] : ordered([...new Set([...sync, ...key])]) })}
      footer={
        <>
          <Button type="submit" variant="primary" disabled={!key.length}>
            OK
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
      footerLeft={
        <Button size="sm" onClick={() => setKey(defaultKey(src))}>
          {tr('Primärschlüssel verwenden', 'Use primary key')}
        </Button>
      }
    >
      <div className="ks-sync-list" style={{ minHeight: 0, height: '100%' }}>
        <table className="ks-table">
          <thead>
            <tr>
              <th>{tr('Feld', 'Field')}</th>
              <th>{tr('Typ', 'Type')}</th>
              <th>{tr('Schlüssel', 'Key')}</th>
              <th>{tr('Synchronisieren', 'Synchronize')}</th>
            </tr>
          </thead>
          <tbody>
            {cols.map((c) => (
              <tr key={c.name}>
                <td className={clsx(!inTarget(c.name) && 'faint')} title={inTarget(c.name) ? undefined : tr('Fehlt im Ziel', 'Missing in target')}>
                  {c.name}
                </td>
                <td className="muted">{c.columnType}</td>
                <td>
                  <Checkbox checked={key.includes(c.name)} disabled={!inTarget(c.name)} onChange={(v) => setKey((k) => flip(k, c.name, v))} />
                </td>
                <td>
                  <Checkbox checked={sync.includes(c.name) || key.includes(c.name)} disabled={!inTarget(c.name) || key.includes(c.name)} onChange={(v) => setSync((k) => flip(k, c.name, v))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

export default function DataSyncTab({ tab }: TabProps) {
  const cid0 = (tab.params.connectionId as string | null) ?? '';
  const [p, setP] = useState<DataSyncProfile>(() => ({
    version: 1,
    source: { connectionId: cid0, database: (tab.params.database as string | null) ?? '' },
    target: { connectionId: cid0, database: '' },
    autoMap: false,
    excluded: [],
    mappings: [],
    options: defaultDataSyncOptions()
  }));
  const [view, setView] = useState<View>('setup');
  const [schema, setSchema] = useState<DataSyncPrepareResult | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [map, setMap] = useState<Record<string, MapRow>>({});
  const pendingProfile = useRef<DataSyncProfile | null>(null);
  const [mapSearch, setMapSearch] = useState('');
  const [compareTask, setCompareTask] = useState<string | null>(null);
  const [result, setResult] = useState<DataCompareResult | null>(null);
  const [sel, setSel] = useState<Record<number, DataSyncTableSelection>>({});
  const [current, setCurrent] = useState<number | null>(null);
  const [showIdentical, setShowIdentical] = useState(false);
  const [busy, setBusy] = useState(false);
  const profiles = useWorkspace((s) => s.profiles);
  const o = p.options;
  const compareIdRef = useRef<string | null>(null);

  useEffect(() => () => void (compareIdRef.current && api.sync.releaseCompare(compareIdRef.current).catch(() => undefined)), []);

  useEffect(() => {
    const n = profiles.find((x) => x.id === p.target.connectionId)?.name;
    useTabs.getState().update(tab.id, { subtitle: n ? `${tr('Ziel', 'Target')}: ${n}${p.target.database ? ` / ${p.target.database}` : ''}` : undefined });
  }, [p.target.connectionId, p.target.database, profiles, tab.id]);

  // ── schema & mapping
  const endpointsReady = !!(p.source.connectionId && p.source.database && p.target.connectionId && p.target.database);
  const loadSchema = useCallback(async () => {
    if (!endpointsReady) {
      setSchema(null);
      return;
    }
    setLoadingSchema(true);
    try {
      const s = await api.sync.dataSyncPrepare(p.source, p.target);
      setSchema(s);
      const prof = pendingProfile.current;
      pendingProfile.current = null;
      const next: Record<string, MapRow> = {};
      for (const t of s.source) {
        const m = prof?.mappings.find((x) => sameName(x.source, t.name));
        const auto = s.target.find((x) => sameName(x.name, t.name))?.name ?? '';
        if (m) {
          const target = s.target.find((x) => sameName(x.name, m.target))?.name ?? '';
          next[t.name] = { enabled: !!target, target, key: m.key, columns: m.columns };
        } else {
          const excluded = prof ? !prof.autoMap || prof.excluded.some((x) => sameName(x, t.name)) : false;
          next[t.name] = { enabled: !!auto && !excluded, target: auto, key: [], columns: [] };
        }
      }
      setMap(next);
    } catch (e) {
      setSchema(null);
      void errorDialog(e);
    } finally {
      setLoadingSchema(false);
    }
  }, [endpointsReady, p.source, p.target]);

  useEffect(() => {
    void loadSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.source.connectionId, p.source.database, p.target.connectionId, p.target.database]);

  const profileData = (): DataSyncProfile => {
    const mappings = Object.entries(map)
      .filter(([, m]) => m.enabled && m.target)
      .map(([source, m]) => ({ source, target: m.target, key: m.key, columns: m.columns, columnMap: {} }));
    return normalizeDataSyncProfile({ ...p, autoMap: false, excluded: [], mappings });
  };

  // ── compare
  const compare = async () => {
    const prof = profileData();
    if (!endpointsReady) {
      void errorDialog(new Error(tr('Bitte Quelle und Ziel vollständig wählen.', 'Please choose source and target completely.')));
      return;
    }
    if (!prof.mappings.length) {
      setView('mapping');
      void errorDialog(new Error(tr('Keine Tabellen zum Vergleichen ausgewählt.', 'No tables selected for comparison.')));
      return;
    }
    setBusy(true);
    setView('result');
    try {
      const id = await api.sync.startDataCompare(prof);
      setCompareTask(id);
      setResult(null);
      const r = await waitForTask<DataCompareResult>(id);
      if (compareIdRef.current) void api.sync.releaseCompare(compareIdRef.current).catch(() => undefined);
      compareIdRef.current = r.compareId;
      setResult(r);
      setSel(Object.fromEntries(r.tables.map((t) => [t.index, { index: t.index, insert: true, update: true, delete: true, excluded: [] }])));
      setCurrent(r.tables.find((t) => !t.error && t.onlySource + t.onlyTarget + t.different > 0)?.index ?? r.tables[0]?.index ?? null);
      setCompareTask(null);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  const selection = (): DataSyncTableSelection[] => Object.values(sel);
  const pending = result
    ? result.tables.reduce((a, t) => {
        const s = sel[t.index];
        if (!s || t.error) return a;
        return a + (s.insert && o.insert ? t.onlySource : 0) + (s.update && o.update ? t.different : 0) + (s.delete && o.delete ? t.onlyTarget : 0) - s.excluded.length;
      }, 0)
    : 0;

  const showScript = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const r = await api.sync.dataSyncScript(result.compareId, selection(), o, 4 << 20);
      await showScriptDialog({
        title: tr('Synchronisationsskript', 'Synchronization Script'),
        sql: r.sql,
        note: r.truncated ? tr('Vorschau gekürzt – „Skript speichern“ schreibt das vollständige Skript.', 'Preview truncated – "Save Script" writes the complete script.') : tr('{n} Anweisungen', '{n} statements', { n: r.statements }),
        connectionId: result.target.connectionId,
        database: result.target.database
      });
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  const saveScript = async () => {
    if (!result) return;
    const encoding = await openDialog<string>((close) => <EncodingDialog close={close} />);
    if (!encoding) return;
    const file = await pickSaveFile({ title: tr('Skript speichern', 'Save Script'), defaultPath: `${result.target.database}_data_sync.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (!file) return;
    try {
      const id = await api.sync.startDataSyncSave(result.compareId, selection(), o, file, encoding);
      await showTaskDialog(id, tr('Skript speichern', 'Save Script'));
    } catch (e) {
      void errorDialog(e);
    }
  };

  const deploy = async () => {
    if (!result) return;
    const ok = await confirmDialog({
      title: tr('Datensynchronisation ausführen', 'Run Data Synchronization'),
      message: tr('Etwa {n} Datensätze in „{d}“ werden geändert. Fortfahren?', 'About {n} records in "{d}" will be changed. Continue?', { n: formatNumber(pending), d: result.target.database }),
      danger: true,
      okLabel: tr('Ausführen', 'Execute')
    });
    if (!ok) return;
    try {
      const id = await api.sync.startDataSyncDeploy(result.compareId, selection(), o);
      await showTaskDialog(id, tr('Datensynchronisation', 'Data Synchronization'));
      await compare();
    } catch (e) {
      void errorDialog(e);
    }
  };

  const swap = () => {
    setP((x) => ({ ...x, source: x.target, target: x.source }));
    setResult(null);
  };
  const setOpt = (k: keyof DataSyncOptions, v: boolean) => setP((x) => ({ ...x, options: { ...x.options, [k]: v } }));
  const opt = (k: keyof DataSyncOptions, label: string) => <Checkbox checked={o[k]} disabled={busy} onChange={(v) => setOpt(k, v)} label={label} />;

  const mapFilter = mapSearch.trim().toLowerCase();
  const mapRows = (schema?.source ?? []).filter((t) => !mapFilter || t.name.toLowerCase().includes(mapFilter));
  const enabledCount = Object.values(map).filter((m) => m.enabled && m.target).length;
  const tables = (result?.tables ?? []).filter((t) => showIdentical || t.error || t.onlySource + t.onlyTarget + t.different > 0);
  const currentTable = result?.tables.find((t) => t.index === current);

  const setSelFlag = (index: number, patch: Partial<DataSyncTableSelection>) => setSel((s) => ({ ...s, [index]: { ...s[index], ...patch } }));

  return (
    <div className="ks-sync">
      <Toolbar>
        <ProfileButtons
          kind="dataSync"
          current={profileData}
          onLoad={(d) => {
            const prof = normalizeDataSyncProfile(d);
            pendingProfile.current = prof;
            setP({ ...prof, mappings: [] });
            setResult(null);
            setView('setup');
            if (
              prof.source.connectionId === p.source.connectionId &&
              prof.source.database === p.source.database &&
              prof.target.connectionId === p.target.connectionId &&
              prof.target.database === p.target.database
            ) {
              void loadSchema();
            }
          }}
        />
        <ToolbarSep />
        <ToolbarButton icon={<GitCompareArrows size={15} />} label={tr('Vergleichen', 'Compare')} disabled={busy || !endpointsReady} onClick={() => void compare()} />
        <ToolbarButton icon={<FileCode size={15} />} label={tr('Skript anzeigen', 'Show Script')} disabled={busy || !result || pending <= 0} onClick={() => void showScript()} />
        <ToolbarButton icon={<Save size={15} />} label={tr('Skript speichern', 'Save Script')} disabled={busy || !result || pending <= 0} onClick={() => void saveScript()} />
        <ToolbarButton icon={<Play size={15} />} label={tr('Ausführen', 'Execute')} disabled={busy || !result || pending <= 0} onClick={() => void deploy()} />
      </Toolbar>
      <TabStrip<View>
        value={view}
        onChange={setView}
        tabs={[
          { id: 'setup', label: tr('Quelle, Ziel und Optionen', 'Source, Target and Options') },
          { id: 'mapping', label: tr('Tabellenzuordnung', 'Table Mapping'), badge: schema ? `${enabledCount}/${schema.source.length}` : undefined },
          { id: 'result', label: tr('Ergebnis', 'Result'), hidden: !result && !compareTask }
        ]}
      />
      <div className="ks-sync-body">
        {view === 'setup' && (
          <div className="ks-sync-scroll">
            <div className="ks-sync-endpoints">
              <EndpointFields title={tr('Quelle', 'Source')} connectionId={p.source.connectionId} database={p.source.database} disabled={busy} onChange={(connectionId, database) => setP((x) => ({ ...x, source: { connectionId, database } }))} />
              <IconButton className="ks-sync-swap" icon={<ArrowLeftRight size={16} />} title={tr('Quelle und Ziel tauschen', 'Swap source and target')} disabled={busy} onClick={swap} />
              <EndpointFields title={tr('Ziel', 'Target')} connectionId={p.target.connectionId} database={p.target.database} disabled={busy} onChange={(connectionId, database) => setP((x) => ({ ...x, target: { connectionId, database } }))} />
            </div>
            <Section title={tr('Optionen', 'Options')}>
              <div className="ks-sync-options">
                {opt('insert', tr('Datensätze einfügen (nur in Quelle)', 'Insert records (only in source)'))}
                {opt('update', tr('Datensätze aktualisieren (verschieden)', 'Update records (different)'))}
                {opt('delete', tr('Datensätze löschen (nur im Ziel)', 'Delete records (only in target)'))}
                {opt('useTransaction', tr('Transaktion pro Tabelle', 'Transaction per table'))}
                {opt('disableFkChecks', tr('Fremdschlüsselprüfung deaktivieren', 'Disable foreign key checks'))}
                {opt('continueOnError', tr('Bei Fehlern fortfahren', 'Continue on error'))}
              </div>
            </Section>
            <div className="ks-field-hint">
              {tr(
                'Tabellen mit gleichem Namen werden automatisch zugeordnet; unter „Tabellenzuordnung“ lassen sich Zuordnung, Schlüssel und Felder anpassen.',
                'Tables with the same name are mapped automatically; adjust mapping, key and fields under "Table Mapping".'
              )}
            </div>
          </div>
        )}

        {view === 'mapping' && (
          <div className="ks-sync-scroll">
            <div className="ks-sync-row">
              <Button size="sm" disabled={!schema} onClick={() => setMap((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, enabled: !!v.target }])))}>
                {tr('Alle', 'All')}
              </Button>
              <Button size="sm" disabled={!schema} onClick={() => setMap((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, enabled: false }])))}>
                {tr('Keine', 'None')}
              </Button>
              <div className="spacer" />
              <SearchInput value={mapSearch} onChange={setMapSearch} className="ks-objects-search" />
              <IconButton icon={loadingSchema ? <Spinner size={13} /> : <RefreshCw size={14} />} title={tr('Aktualisieren', 'Refresh')} onClick={() => void loadSchema()} />
            </div>
            <div className="ks-sync-list">
              {!schema ? (
                <div className="ks-sync-empty">{loadingSchema ? <Spinner /> : tr('Bitte zuerst Quelle und Ziel wählen.', 'Please choose source and target first.')}</div>
              ) : (
                <table className="ks-table">
                  <thead>
                    <tr>
                      <th />
                      <th>{tr('Quelltabelle', 'Source table')}</th>
                      <th>{tr('Zieltabelle', 'Target table')}</th>
                      <th>{tr('Schlüssel', 'Key')}</th>
                      <th>{tr('Felder', 'Fields')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {mapRows.map((t) => {
                      const m = map[t.name] ?? { enabled: false, target: '', key: [], columns: [] };
                      const key = m.key.length ? m.key : defaultKey(t);
                      const tgt = schema.target.find((x) => x.name === m.target);
                      const set = (patch: Partial<MapRow>) => setMap((x) => ({ ...x, [t.name]: { ...m, ...patch } }));
                      return (
                        <tr key={t.name}>
                          <td className="chk">
                            <Checkbox checked={m.enabled && !!m.target} disabled={!m.target} onChange={(v) => set({ enabled: v })} />
                          </td>
                          <td>
                            <span className="ks-sync-name">
                              <ObjIcon kind="table" size={14} />
                              {t.name}
                            </span>
                          </td>
                          <td>
                            <Select
                              value={m.target}
                              style={{ height: 22 }}
                              onChange={(target) => set({ target, enabled: !!target, columns: [], key: m.key })}
                              options={[{ value: '', label: tr('(nicht zuordnen)', '(not mapped)') }, ...schema.target.map((x) => ({ value: x.name, label: x.name }))]}
                            />
                          </td>
                          <td className={clsx(!key.length && 'danger-text')}>{key.length ? `${key.join(', ')}${m.key.length ? '' : ` (${tr('Standard', 'default')})`}` : tr('kein Schlüssel', 'no key')}</td>
                          <td>{m.columns.length ? `${m.columns.length}/${t.columns.length}` : tr('alle', 'all')}</td>
                          <td>
                            <Button
                              size="sm"
                              icon={<Settings2 size={13} />}
                              disabled={!m.target}
                              onClick={() => void editMapping(t, tgt, m).then((r) => r && set({ key: sameList(r.key, defaultKey(t)) ? [] : r.key, columns: r.columns }))}
                            >
                              {tr('Schlüssel/Felder …', 'Key/Fields …')}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {view === 'result' && !result && compareTask && (
          <div className="ks-sync-scroll">
            <TaskPanel taskId={compareTask} />
          </div>
        )}

        {view === 'result' && result && (
          <Group orientation="vertical" className="ks-sync-split">
            <Panel defaultSize="40" minSize={120}>
              <div className="ks-sync-pane">
                <div className="ks-sync-pane-head">
                  <Checkbox checked={showIdentical} onChange={setShowIdentical} label={tr('Identische Tabellen anzeigen', 'Show identical tables')} />
                  <div className="spacer" />
                  <span className="muted">{tr('{n} Änderungen ausgewählt', '{n} changes selected', { n: formatNumber(Math.max(0, pending)) })}</span>
                </div>
                <div className="ks-sync-list" style={{ border: 'none', borderRadius: 0 }}>
                  <table className="ks-table">
                    <thead>
                      <tr>
                        <th />
                        <th>{tr('Quelltabelle', 'Source table')}</th>
                        <th>{tr('Zieltabelle', 'Target table')}</th>
                        <th>{tr('Nur in Quelle (INSERT)', 'Only in source (INSERT)')}</th>
                        <th>{tr('Verschieden (UPDATE)', 'Different (UPDATE)')}</th>
                        <th>{tr('Nur im Ziel (DELETE)', 'Only in target (DELETE)')}</th>
                        <th>{tr('Identisch', 'Identical')}</th>
                        <th>{tr('Meldung', 'Message')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tables.map((t) => {
                        const s = sel[t.index];
                        const any = s && (s.insert || s.update || s.delete);
                        const cell = (kind: 'insert' | 'update' | 'delete', n: number, cls: string, allowed: boolean) => (
                          <td>
                            <Checkbox
                              checked={!!s?.[kind] && n > 0 && allowed}
                              disabled={!n || !allowed || !!t.error}
                              onChange={(v) => setSelFlag(t.index, { [kind]: v })}
                              label={<span className={n ? cls : 'faint'}>{formatNumber(n)}</span>}
                            />
                          </td>
                        );
                        return (
                          <tr key={t.index} className={clsx(current === t.index && 'selected')} onMouseDown={() => setCurrent(t.index)}>
                            <td className="chk">
                              <Checkbox checked={!!any && !t.error} disabled={!!t.error} onChange={(v) => setSelFlag(t.index, { insert: v, update: v, delete: v })} />
                            </td>
                            <td>
                              <span className="ks-sync-name">
                                <ObjIcon kind="table" size={14} />
                                {t.source}
                              </span>
                            </td>
                            <td>{t.target}</td>
                            {cell('insert', t.onlySource, 'ks-sync-plus', o.insert)}
                            {cell('update', t.different, 'ks-sync-tilde', o.update)}
                            {cell('delete', t.onlyTarget, 'ks-sync-minus', o.delete)}
                            <td className="num">{formatNumber(t.identical)}</td>
                            <td className={clsx(t.error && 'danger-text')} title={t.error ?? undefined}>
                              {t.error ?? (s?.excluded.length ? tr('{n} Zeilen ausgeschlossen', '{n} rows excluded', { n: s.excluded.length }) : '')}
                            </td>
                          </tr>
                        );
                      })}
                      {!tables.length && (
                        <tr>
                          <td colSpan={8} className="ks-sync-empty">
                            {tr('Keine Unterschiede gefunden – die Daten sind identisch.', 'No differences found – the data is identical.')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </Panel>
            <Separator className="ks-sync-sep h" />
            <Panel minSize={140}>
              {currentTable && !currentTable.error ? (
                <DiffRows
                  key={`${result.compareId}:${currentTable.index}`}
                  compareId={result.compareId}
                  table={currentTable}
                  excluded={sel[currentTable.index]?.excluded ?? []}
                  onExcluded={(excluded) => setSelFlag(currentTable.index, { excluded })}
                />
              ) : (
                <div className="ks-sync-empty">{tr('Tabelle auswählen, um die Datensätze zu sehen.', 'Select a table to see its records.')}</div>
              )}
            </Panel>
          </Group>
        )}
      </div>
      <div className="ks-statusline">
        {result ? (
          <>
            <span>
              {result.source.database} → {result.target.database}
            </span>
            <span>{tr('{n} Tabellen verglichen', '{n} tables compared', { n: result.tables.length })}</span>
          </>
        ) : (
          <span>{schema ? tr('{n} Tabellen zugeordnet', '{n} tables mapped', { n: enabledCount }) : tr('Quelle und Ziel wählen.', 'Choose source and target.')}</span>
        )}
      </div>
    </div>
  );
}

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function EncodingDialog({ close }: { close: (v?: string) => void }) {
  const [enc, setEnc] = useState('utf8');
  return (
    <Dialog
      title={tr('Skript speichern', 'Save Script')}
      width={380}
      onClose={() => close()}
      onSubmit={() => close(enc)}
      footer={
        <>
          <Button type="submit" variant="primary">
            OK
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-field">
        <label className="ks-field-label">{tr('Kodierung', 'Encoding')}</label>
        <EncodingSelect value={enc} onChange={setEnc} />
      </div>
    </Dialog>
  );
}

// ───────────────────────── differing rows ─────────────────────────

function DiffRows({
  compareId,
  table,
  excluded,
  onExcluded
}: {
  compareId: string;
  table: DataCompareResult['tables'][number];
  excluded: string[];
  onExcluded: (keys: string[]) => void;
}) {
  const kinds: { id: DataDiffKind; label: string; n: number }[] = [
    { id: 'insert', label: tr('Nur in Quelle', 'Only in source'), n: table.onlySource },
    { id: 'update', label: tr('Verschieden', 'Different'), n: table.different },
    { id: 'delete', label: tr('Nur im Ziel', 'Only in target'), n: table.onlyTarget }
  ];
  const [kind, setKind] = useState<DataDiffKind>(kinds.find((k) => k.n > 0)?.id ?? 'update');
  const [page, setPage] = useState<DataDiffPage | null>(null);
  const [loading, setLoading] = useState(false);
  const grid = useRef<DataGridHandle>(null);
  const excludedSet = useMemo(() => new Set(excluded), [excluded]);

  const load = async (k: DataDiffKind, append: boolean) => {
    setLoading(true);
    try {
      const offset = append && page ? page.rows.length : 0;
      const r = await api.sync.dataDiffRows(compareId, table.index, k, offset, PAGE);
      setPage((prev) => (append && prev ? { ...r, rows: [...prev.rows, ...r.rows] } : r));
    } catch (e) {
      void errorDialog(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPage(null);
    void load(kind, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const upd = kind === 'update';
  const columns: GridColumnDef[] = useMemo(() => {
    if (!page) return [];
    const side: GridColumnDef = { id: '__side', title: tr('Seite', 'Side'), kind: 'text', typeLabel: '', numeric: false, width: 70, readonly: true };
    const meta = kind === 'delete' ? page.targetMeta : page.sourceMeta;
    return [side, ...meta.map((m, i) => columnFromMeta(m, { id: `c${i}`, title: page.columns[i] ?? m.name, primaryKey: table.key.includes(page.columns[i] ?? m.name) }))];
  }, [page, kind, table.key]);

  const classes = useMemo(
    () => (page ? { s: page.sourceMeta.map((m) => valueClass(m.dataType)), t: page.targetMeta.map((m) => valueClass(m.dataType)) } : { s: [], t: [] }),
    [page]
  );
  const rowCount = page ? page.rows.length * (upd ? 2 : 1) : 0;
  const rowOf = (r: number) => (page ? page.rows[upd ? Math.floor(r / 2) : r] : undefined);
  const isTargetRow = (r: number) => (upd ? r % 2 === 1 : kind === 'delete');

  const getValue = useCallback(
    (r: number, c: number): CellValue => {
      const row = rowOf(r);
      if (!row) return null;
      if (c === 0) return isTargetRow(r) ? tr('Ziel', 'Target') : tr('Quelle', 'Source');
      const vals = isTargetRow(r) ? row.target : row.source;
      return vals ? (vals[c - 1] ?? null) : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, kind]
  );
  const cellModified = useCallback(
    (r: number, c: number) => {
      if (!upd || c === 0) return false;
      const row = rowOf(r);
      if (!row?.source || !row.target) return false;
      return !valuesEqual(row.source[c - 1], row.target[c - 1], classes.s[c - 1], classes.t[c - 1]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, kind, classes]
  );
  const rowState = useCallback(
    (r: number) => {
      const row = rowOf(r);
      return row && excludedSet.has(row.key) ? ('deleted' as const) : undefined;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, kind, excludedSet]
  );

  const setExcluded = (on: boolean) => {
    const rows = grid.current?.selectedRows() ?? [];
    const keys = new Set(rows.map((r) => rowOf(r)?.key).filter((k): k is string => !!k));
    if (!keys.size) return;
    const next = new Set(excluded);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    onExcluded([...next]);
  };

  return (
    <div className="ks-sync-pane">
      <div className="ks-sync-pane-head">
        <TabStrip<DataDiffKind> value={kind} onChange={setKind} tabs={kinds.map((k) => ({ id: k.id, label: k.label, badge: formatNumber(k.n) }))} className="grow" />
        {loading && <Spinner size={13} />}
        <Button size="sm" icon={<Ban size={13} />} onClick={() => setExcluded(true)} title={tr('Markierte Zeilen nicht synchronisieren', 'Do not synchronize the selected rows')}>
          {tr('Ausschließen', 'Exclude')}
        </Button>
        <Button size="sm" icon={<CircleCheck size={13} />} onClick={() => setExcluded(false)}>
          {tr('Einschließen', 'Include')}
        </Button>
        {upd && (
          <span className="ks-sync-legend">
            <span className="ks-sync-swatch" style={{ background: 'var(--grid-modified)' }} />
            {tr('geänderter Wert', 'changed value')}
          </span>
        )}
      </div>
      <div className="ks-sync-pane-body">
        {page && (
          <DataGrid
            ref={grid}
            columns={columns}
            rowCount={rowCount}
            getValue={getValue}
            cellModified={cellModified}
            rowState={rowState}
            freezeColumns={1}
            empty={<span>{tr('Keine Datensätze', 'No records')}</span>}
          />
        )}
      </div>
      {page && page.rows.length < page.total && (
        <div className="ks-statusline">
          <span>{tr('{n} von {t} Datensätzen geladen', '{n} of {t} records loaded', { n: formatNumber(page.rows.length), t: formatNumber(page.total) })}</span>
          <Button size="sm" variant="link" disabled={loading} onClick={() => void load(kind, true)}>
            {tr('Weitere laden', 'Load more')}
          </Button>
        </div>
      )}
    </div>
  );
}

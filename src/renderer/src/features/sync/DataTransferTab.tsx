// Data transfer: copies tables (structure + records), views, routines, triggers and events into another
// database (same or other server) or into an SQL script file.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeftRight, Play, RefreshCw } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { DataTransferProfile, DataTransferResult, SyncObjectList, TransferOptions } from '@shared/apis/sync';
import { defaultTransferOptions, emptyTransferObjects, normalizeTransferProfile } from '@shared/sync/defaults';
import { formatDuration, formatNumber } from '@shared/util';
import { api } from '../../api/client';
import { ObjIcon, type ObjKind } from '../../components/icons';
import { TaskPanel, useTask } from '../../components/TaskPanel';
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  NumberInput,
  RadioGroup,
  SearchInput,
  Section,
  Select,
  Spinner,
  TabStrip,
  TextInput,
  Toolbar,
  ToolbarButton,
  ToolbarSep
} from '../../components/ui/controls';
import { confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { PathInput } from '../../components/ui/PathInput';
import { useTabs, type TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { EncodingSelect, EndpointFields, ProfileButtons } from './common';

type Section = 'general' | 'objects' | 'options' | 'run';
type ObjGroup = 'tables' | 'views' | 'functions' | 'procedures' | 'triggers' | 'events';

const GROUPS: { id: ObjGroup; icon: ObjKind; label: () => string }[] = [
  { id: 'tables', icon: 'table', label: () => tr('Tabellen', 'Tables') },
  { id: 'views', icon: 'view', label: () => tr('Ansichten', 'Views') },
  { id: 'functions', icon: 'function', label: () => tr('Funktionen', 'Functions') },
  { id: 'procedures', icon: 'procedure', label: () => tr('Prozeduren', 'Procedures') },
  { id: 'triggers', icon: 'trigger', label: () => tr('Trigger', 'Triggers') },
  { id: 'events', icon: 'event', label: () => tr('Ereignisse', 'Events') }
];

function initialProfile(params: Record<string, unknown>): DataTransferProfile {
  const cid = (params.connectionId as string | null) ?? '';
  const db = (params.database as string | null) ?? '';
  const tables = (params.tables as string[] | null) ?? null;
  return {
    version: 1,
    source: { connectionId: cid, database: db },
    target: { kind: 'database', connectionId: cid, database: '' },
    objects: tables ? { ...emptyTransferObjects(), tables } : { ...emptyTransferObjects(), all: true },
    tableSettings: {},
    options: defaultTransferOptions()
  };
}

export default function DataTransferTab({ tab }: TabProps) {
  const [p, setP] = useState<DataTransferProfile>(() => initialProfile(tab.params));
  const [section, setSection] = useState<Section>('general');
  const [objects, setObjects] = useState<SyncObjectList | null>(null);
  const [loadingObjects, setLoadingObjects] = useState(false);
  const [search, setSearch] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [summary, setSummary] = useState<DataTransferResult | null>(null);
  const { info } = useTask(taskId);
  const running = !!taskId && (!info || info.status === 'running');
  const profiles = useWorkspace((s) => s.profiles);

  const setOpt = <K extends keyof TransferOptions>(k: K, v: TransferOptions[K]) => setP((x) => ({ ...x, options: { ...x.options, [k]: v } }));
  const o = p.options;

  const loadObjects = async () => {
    const { connectionId, database } = p.source;
    if (!connectionId || !database) {
      setObjects(null);
      return;
    }
    setLoadingObjects(true);
    try {
      setObjects(await api.sync.listObjects(connectionId, database));
    } catch (e) {
      setObjects(null);
      void errorDialog(e);
    } finally {
      setLoadingObjects(false);
    }
  };

  useEffect(() => {
    void loadObjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.source.connectionId, p.source.database]);

  useEffect(() => {
    if (!taskId || !info || info.status === 'running') return;
    void api.sync.transferSummary(taskId).then(setSummary).catch(() => undefined);
    const t = p.target;
    if (t.kind === 'database' && useWorkspace.getState().conns[t.connectionId]?.status === 'open') {
      void useWorkspace.getState().refreshConnection(t.connectionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, info?.status]);

  useEffect(() => {
    const name = profiles.find((x) => x.id === p.source.connectionId)?.name;
    useTabs.getState().update(tab.id, { subtitle: name ? `${name}${p.source.database ? ` / ${p.source.database}` : ''}` : undefined });
  }, [p.source.connectionId, p.source.database, profiles, tab.id]);

  // ── object lists
  const available: Record<ObjGroup, string[]> = useMemo(
    () => ({
      tables: objects?.tables.map((x) => x.name) ?? [],
      views: objects?.views ?? [],
      functions: objects?.functions ?? [],
      procedures: objects?.procedures ?? [],
      triggers: objects?.triggers.map((x) => x.name) ?? [],
      events: objects?.events ?? []
    }),
    [objects]
  );
  const isChecked = (g: ObjGroup, n: string) => p.objects.all || p.objects[g].includes(n);
  const setChecked = (g: ObjGroup, names: string[], on: boolean) =>
    setP((x) => {
      const base = x.objects.all
        ? { ...x.objects, all: false, ...Object.fromEntries(GROUPS.map((gr) => [gr.id, [...available[gr.id]]])) }
        : { ...x.objects };
      const set = new Set(base[g]);
      for (const n of names) {
        if (on) set.add(n);
        else set.delete(n);
      }
      return { ...x, objects: { ...base, [g]: available[g].filter((n) => set.has(n)).concat([...set].filter((n) => !available[g].includes(n))) } };
    });
  const setAll = (on: boolean) => setP((x) => ({ ...x, objects: on ? { ...emptyTransferObjects(), all: true } : emptyTransferObjects() }));
  const selectedCount = GROUPS.reduce((a, g) => a + available[g.id].filter((n) => isChecked(g.id, n)).length, 0);
  const totalCount = GROUPS.reduce((a, g) => a + available[g.id].length, 0);
  const filter = search.trim().toLowerCase();

  const setTableSetting = (name: string, patch: Partial<{ targetName: string; where: string }>) =>
    setP((x) => {
      const prev = x.tableSettings[name];
      const cur = { targetName: patch.targetName ?? prev?.targetName ?? '', where: patch.where ?? prev?.where ?? '' };
      const ts = { ...x.tableSettings };
      if (!cur.targetName && !cur.where) delete ts[name];
      else ts[name] = cur;
      return { ...x, tableSettings: ts };
    });

  // ── validation & start
  const problems = (): string | null => {
    if (!p.source.connectionId || !p.source.database) return tr('Bitte Quellverbindung und -datenbank wählen.', 'Please choose the source connection and database.');
    if (p.target.kind === 'database') {
      if (!p.target.connectionId || !p.target.database.trim()) return tr('Bitte Zielverbindung und -datenbank wählen.', 'Please choose the target connection and database.');
      if (p.target.connectionId === p.source.connectionId && p.target.database.trim().toLowerCase() === p.source.database.toLowerCase()) {
        return tr('Quelle und Ziel dürfen nicht dieselbe Datenbank sein.', 'Source and target must not be the same database.');
      }
    } else if (!p.target.path.trim()) return tr('Bitte eine Zieldatei angeben.', 'Please choose a target file.');
    if (!p.objects.all && selectedCount === 0) return tr('Bitte mindestens ein Objekt auswählen.', 'Please select at least one object.');
    return null;
  };

  const start = async () => {
    const err = problems();
    if (err) {
      void errorDialog(new Error(err));
      return;
    }
    if (p.target.kind === 'database' && o.dropBeforeCreate && o.createTables) {
      const ok = await confirmDialog({
        title: tr('Datenübertragung starten', 'Start Data Transfer'),
        message: tr(
          'Gleichnamige Objekte in „{d}“ werden gelöscht und neu erstellt. Fortfahren?',
          'Objects with the same names in "{d}" will be dropped and re-created. Continue?',
          { d: p.target.database }
        ),
        danger: true,
        okLabel: tr('Starten', 'Start')
      });
      if (!ok) return;
    }
    try {
      setSummary(null);
      const id = await api.sync.startTransfer(normalizeTransferProfile(p));
      setTaskId(id);
      setSection('run');
    } catch (e) {
      void errorDialog(e);
    }
  };

  const swap = () => {
    if (p.target.kind !== 'database') return;
    setP((x) => ({
      ...x,
      source: { connectionId: x.target.kind === 'database' ? x.target.connectionId : '', database: x.target.kind === 'database' ? x.target.database : '' },
      target: { kind: 'database', connectionId: x.source.connectionId, database: x.source.database },
      objects: { ...emptyTransferObjects(), all: true },
      tableSettings: {}
    }));
  };

  const opt = (k: keyof TransferOptions, label: ReactNode, disabled = false) => (
    <Checkbox checked={!!o[k]} disabled={disabled || running} onChange={(v) => setOpt(k, v as never)} label={label} />
  );

  return (
    <div className="ks-sync">
      <Toolbar>
        <ProfileButtons kind="dataTransfer" current={() => normalizeTransferProfile(p)} onLoad={(d) => setP(normalizeTransferProfile(d))} />
        <ToolbarSep />
        <ToolbarButton icon={<Play size={15} />} label={tr('Starten', 'Start')} disabled={running} onClick={() => void start()} />
      </Toolbar>
      <TabStrip<Section>
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'general', label: tr('Quelle und Ziel', 'Source and Target') },
          { id: 'objects', label: tr('Objekte', 'Objects'), badge: p.objects.all ? tr('alle', 'all') : `${selectedCount}/${totalCount}` },
          { id: 'options', label: tr('Optionen', 'Options') },
          { id: 'run', label: tr('Ausführung', 'Progress'), hidden: !taskId }
        ]}
      />
      <div className="ks-sync-body">
        {section === 'general' && (
          <div className="ks-sync-scroll">
            <div className="ks-sync-endpoints">
              <EndpointFields
                title={tr('Quelle', 'Source')}
                connectionId={p.source.connectionId}
                database={p.source.database}
                disabled={running}
                onChange={(connectionId, database) =>
                  setP((x) => ({ ...x, source: { connectionId, database }, objects: x.objects.all ? x.objects : { ...emptyTransferObjects(), all: true }, tableSettings: {} }))
                }
              />
              <IconButton className="ks-sync-swap" icon={<ArrowLeftRight size={16} />} title={tr('Quelle und Ziel tauschen', 'Swap source and target')} disabled={running || p.target.kind !== 'database'} onClick={swap} />
              <div className="col" style={{ gap: 8, minWidth: 0 }}>
                <RadioGroup
                  inline
                  disabled={running}
                  value={p.target.kind}
                  onChange={(kind) =>
                    setP((x) => ({
                      ...x,
                      target:
                        kind === 'database'
                          ? { kind: 'database', connectionId: x.source.connectionId, database: '' }
                          : { kind: 'file', path: '', encoding: 'utf8', database: x.source.database }
                    }))
                  }
                  options={[
                    { value: 'database', label: tr('Ziel: Datenbank', 'Target: database') },
                    { value: 'file', label: tr('Ziel: SQL-Datei', 'Target: SQL file') }
                  ]}
                />
                {p.target.kind === 'database' ? (
                  <EndpointFields
                    title={tr('Ziel', 'Target')}
                    allowNew
                    disabled={running}
                    connectionId={p.target.connectionId}
                    database={p.target.database}
                    onChange={(connectionId, database) => setP((x) => ({ ...x, target: { kind: 'database', connectionId, database } }))}
                  />
                ) : (
                  <div className="ks-sync-endpoint">
                    <div className="ks-sync-endpoint-title">{tr('Ziel', 'Target')}</div>
                    <label className="ks-sync-endpoint-label">{tr('Datei', 'File')}</label>
                    <PathInput
                      mode="save"
                      value={p.target.path}
                      disabled={running}
                      filters={[{ name: 'SQL', extensions: ['sql'] }]}
                      onChange={(path) => setP((x) => (x.target.kind === 'file' ? { ...x, target: { ...x.target, path } } : x))}
                    />
                    <label className="ks-sync-endpoint-label">{tr('Kodierung', 'Encoding')}</label>
                    <EncodingSelect
                      value={p.target.encoding}
                      disabled={running}
                      onChange={(encoding) => setP((x) => (x.target.kind === 'file' ? { ...x, target: { ...x.target, encoding } } : x))}
                    />
                    <label className="ks-sync-endpoint-label">{tr('Datenbank im Skript', 'Database in script')}</label>
                    <TextInput
                      value={p.target.database}
                      disabled={running}
                      placeholder={tr('(ohne USE / unqualifiziert)', '(no USE / unqualified)')}
                      onChange={(e) => {
                        const database = e.target.value;
                        setP((x) => (x.target.kind === 'file' ? { ...x, target: { ...x.target, database } } : x));
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="ks-field-hint">
              {tr(
                'Weiter unter „Objekte“ die zu übertragenden Objekte wählen und unter „Optionen“ festlegen, wie Tabellen und Datensätze erstellt werden.',
                'Choose the objects to transfer under "Objects" and how tables and records are created under "Options".'
              )}
            </div>
          </div>
        )}

        {section === 'objects' && (
          <div className="ks-sync-scroll">
            <div className="ks-sync-row">
              <Checkbox
                checked={p.objects.all}
                disabled={running}
                onChange={(v) => setAll(v)}
                label={tr('Alle Objekte (auch später hinzugefügte)', 'All objects (including ones added later)')}
              />
              <Button size="sm" disabled={running || !objects} onClick={() => setChecked('tables', [], true) /* switches to explicit selection */}>
                {tr('Einzeln auswählen', 'Select individually')}
              </Button>
              <Button size="sm" disabled={running} onClick={() => setAll(false)}>
                {tr('Keine', 'None')}
              </Button>
              <div className="spacer" />
              <SearchInput value={search} onChange={setSearch} className="ks-objects-search" />
              <IconButton icon={loadingObjects ? <Spinner size={13} /> : <RefreshCw size={14} />} title={tr('Aktualisieren', 'Refresh')} onClick={() => void loadObjects()} />
            </div>
            <div className="ks-sync-list">
              {!objects ? (
                <div className="ks-sync-empty">{loadingObjects ? <Spinner /> : tr('Bitte zuerst eine Quelldatenbank wählen.', 'Please choose a source database first.')}</div>
              ) : (
                <table className="ks-table">
                  <thead>
                    <tr>
                      <th />
                      <th>{tr('Name', 'Name')}</th>
                      <th>{tr('Zeilen', 'Rows')}</th>
                      <th>{tr('Zielname', 'Target name')}</th>
                      <th>{tr('Filter (WHERE)', 'Filter (WHERE)')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {GROUPS.map((g) => {
                      const names = available[g.id].filter((n) => !filter || n.toLowerCase().includes(filter));
                      if (!names.length) return null;
                      const checked = names.filter((n) => isChecked(g.id, n)).length;
                      return [
                        <tr key={`g:${g.id}`} className="group">
                          <td className="chk">
                            <Checkbox
                              checked={checked === names.length}
                              indeterminate={checked > 0 && checked < names.length}
                              disabled={running || (g.id === 'triggers' && !o.includeTriggers)}
                              onChange={(v) => setChecked(g.id, names, v)}
                            />
                          </td>
                          <td colSpan={4}>
                            <span className="ks-sync-name">
                              <ObjIcon kind={g.icon} size={14} />
                              {g.label()} ({checked}/{names.length})
                            </span>
                          </td>
                        </tr>,
                        ...names.map((n) => {
                          const tbl = g.id === 'tables' ? objects.tables.find((x) => x.name === n) : undefined;
                          const trig = g.id === 'triggers' ? objects.triggers.find((x) => x.name === n) : undefined;
                          const ts = p.tableSettings[n];
                          return (
                            <tr key={`${g.id}:${n}`}>
                              <td className="chk">
                                <Checkbox
                                  checked={isChecked(g.id, n)}
                                  disabled={running || (g.id === 'triggers' && !o.includeTriggers)}
                                  onChange={(v) => setChecked(g.id, [n], v)}
                                />
                              </td>
                              <td title={tbl?.comment || (trig ? `${tr('Tabelle', 'Table')}: ${trig.table}` : undefined)}>
                                <span className="ks-sync-name">
                                  <ObjIcon kind={g.icon} size={14} />
                                  {n}
                                  {trig && <span className="faint">({trig.table})</span>}
                                </span>
                              </td>
                              <td className="num">{tbl ? formatNumber(tbl.rows) : ''}</td>
                              <td>
                                {g.id === 'tables' && (
                                  <TextInput
                                    value={ts?.targetName ?? ''}
                                    disabled={running}
                                    placeholder={o.nameCase === 'lower' ? n.toLowerCase() : o.nameCase === 'upper' ? n.toUpperCase() : n}
                                    onChange={(e) => setTableSetting(n, { targetName: e.target.value })}
                                  />
                                )}
                              </td>
                              <td>
                                {g.id === 'tables' && (
                                  <TextInput
                                    className="mono"
                                    value={ts?.where ?? ''}
                                    disabled={running}
                                    placeholder={tr('alle Datensätze', 'all records')}
                                    onChange={(e) => setTableSetting(n, { where: e.target.value })}
                                  />
                                )}
                              </td>
                            </tr>
                          );
                        })
                      ];
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {section === 'options' && (
          <div className="ks-sync-scroll">
            <Section title={tr('Tabellen', 'Tables')}>
              <div className="ks-sync-options">
                {opt('createTables', tr('Tabellen erstellen', 'Create tables'))}
                {opt('dropBeforeCreate', tr('Zielobjekte vor dem Erstellen löschen', 'Drop target objects before create'))}
                {opt('createDatabase', tr('Zieldatenbank erstellen, falls nicht vorhanden', 'Create target database if missing'))}
                {opt('includeIndexes', tr('Indizes einschließen', 'Include indexes'), !o.createTables)}
                {opt('includeForeignKeys', tr('Fremdschlüssel einschließen', 'Include foreign keys'), !o.createTables)}
                {opt('includeChecks', tr('Check-Einschränkungen einschließen', 'Include check constraints'), !o.createTables)}
                {opt('includeTriggers', tr('Trigger einschließen', 'Include triggers'))}
                {opt('includeAutoIncrement', tr('AUTO_INCREMENT-Wert einschließen', 'Include AUTO_INCREMENT value'), !o.createTables)}
                {opt('includePartitions', tr('Partitionierung einschließen', 'Include partitioning'), !o.createTables)}
                {opt('includeCharset', tr('Zeichensatz und Sortierung einschließen', 'Include character set and collation'), !o.createTables)}
                {opt('includeEngine', tr('Engine einschließen', 'Include engine'), !o.createTables)}
                {opt('includeTableOptions', tr('Weitere Tabellenoptionen einschließen', 'Include other table options'), !o.createTables)}
                {opt('includeComments', tr('Kommentare einschließen', 'Include comments'), !o.createTables)}
                {opt('includeDefiner', tr('DEFINER von Ansichten, Routinen, Triggern, Ereignissen übernehmen', 'Keep DEFINER of views, routines, triggers, events'))}
              </div>
              <Field label={tr('Objektnamen umwandeln', 'Convert object names')} labelWidth={170}>
                <Select
                  value={o.nameCase}
                  disabled={running}
                  style={{ width: 200 }}
                  onChange={(v) => setOpt('nameCase', v)}
                  options={[
                    { value: 'keep', label: tr('Nicht umwandeln', 'Keep') },
                    { value: 'lower', label: tr('Kleinbuchstaben', 'Lower case') },
                    { value: 'upper', label: tr('Großbuchstaben', 'Upper case') }
                  ]}
                />
              </Field>
            </Section>
            <Section title={tr('Datensätze', 'Records')}>
              <div className="ks-sync-options">
                {opt('createRecords', tr('Datensätze übertragen', 'Copy records'))}
                {opt('extendedInsert', tr('Erweiterte INSERT-Anweisungen (mehrere Zeilen)', 'Extended INSERT statements (multiple rows)'), !o.createRecords)}
                {opt('useTransaction', tr('Transaktion pro Tabelle verwenden', 'Use a transaction per table'), !o.createRecords)}
                {opt('disableFkChecks', tr('Fremdschlüsselprüfung im Ziel deaktivieren', 'Disable foreign key checks on target'))}
                {opt('lockSource', tr('Quelltabellen sperren (statt Snapshot)', 'Lock source tables (instead of snapshot)'), !o.createRecords)}
                {opt('lockTarget', tr('Zieltabellen sperren', 'Lock target tables'), !o.createRecords)}
              </div>
              <Field label={tr('Bei doppelten Schlüsseln', 'On duplicate keys')} labelWidth={170}>
                <Select
                  value={o.insertMode}
                  disabled={running || !o.createRecords}
                  style={{ width: 260 }}
                  onChange={(v) => setOpt('insertMode', v)}
                  options={[
                    { value: 'insert', label: tr('Fehler (INSERT)', 'Error (INSERT)') },
                    { value: 'ignore', label: tr('Überspringen (INSERT IGNORE)', 'Skip (INSERT IGNORE)') },
                    { value: 'replace', label: tr('Ersetzen (REPLACE)', 'Replace (REPLACE)') }
                  ]}
                />
              </Field>
              <Field label={tr('Zeilen pro Anweisung', 'Rows per statement')} labelWidth={170}>
                <NumberInput value={o.rowsPerStatement} min={1} disabled={running || !o.extendedInsert} style={{ width: 120 }} onChange={(v) => setOpt('rowsPerStatement', v === '' ? 1 : v)} />
              </Field>
              <Field label={tr('Max. Anweisungsgröße (KB)', 'Max. statement size (KB)')} labelWidth={170}>
                <NumberInput value={o.maxStatementKB} min={16} disabled={running || !o.extendedInsert} style={{ width: 120 }} onChange={(v) => setOpt('maxStatementKB', v === '' ? 16 : v)} />
              </Field>
              <Field label={tr('Lesepuffer (Zeilen)', 'Read chunk (rows)')} labelWidth={170}>
                <NumberInput value={o.fetchSize} min={50} disabled={running} style={{ width: 120 }} onChange={(v) => setOpt('fetchSize', v === '' ? 2000 : v)} />
              </Field>
            </Section>
            <Section title={tr('Allgemein', 'General')}>
              {opt('continueOnError', tr('Bei Fehlern fortfahren', 'Continue on error'))}
            </Section>
          </div>
        )}

        {section === 'run' && taskId && (
          <div className="ks-sync-scroll">
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 220, flex: summary ? '0 0 260px' : 1 }}>
              <TaskPanel taskId={taskId} />
            </div>
            {summary && (
              <div className="ks-sync-list" style={{ flex: 1 }}>
                <table className="ks-table">
                  <thead>
                    <tr>
                      <th>{tr('Objekt', 'Object')}</th>
                      <th>{tr('Ziel', 'Target')}</th>
                      <th>{tr('Status', 'Status')}</th>
                      <th>{tr('Datensätze', 'Records')}</th>
                      <th>{tr('Dauer', 'Duration')}</th>
                      <th>{tr('Meldung', 'Message')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.objects.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <span className="ks-sync-name">
                            <ObjIcon kind={r.type} size={14} />
                            {r.name}
                          </span>
                        </td>
                        <td>{r.targetName}</td>
                        <td>
                          <span className={`ks-sync-status ${r.status}`}>
                            {r.status === 'ok' ? tr('OK', 'OK') : r.status === 'warning' ? tr('Warnung', 'Warning') : r.status === 'error' ? tr('Fehler', 'Error') : tr('Übersprungen', 'Skipped')}
                          </span>
                        </td>
                        <td className="num">{r.type === 'table' ? formatNumber(r.rows) : ''}</td>
                        <td className="num">{formatDuration(r.durationMs)}</td>
                        <td title={r.message}>{r.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="ks-statusline">
        <span>
          {p.source.database ? `${tr('Quelle', 'Source')}: ${p.source.database}` : tr('Keine Quelle', 'No source')}
          {' → '}
          {p.target.kind === 'database' ? p.target.database || '…' : p.target.path || tr('SQL-Datei', 'SQL file')}
        </span>
        <span>{p.objects.all ? tr('Alle Objekte', 'All objects') : tr('{n} Objekte ausgewählt', '{n} objects selected', { n: selectedCount })}</span>
        {summary && (
          <span>
            {tr('{r} Datensätze, {e} Fehler, {w} Warnungen', '{r} records, {e} errors, {w} warnings', { r: formatNumber(summary.rows), e: summary.errors, w: summary.warnings })}
          </span>
        )}
      </div>
    </div>
  );
}

// Data generator tab: choose tables and generators, preview and generate test data.

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Eye, ListOrdered, Play, RefreshCw, Save, TriangleAlert, Upload } from 'lucide-react';
import type { ColumnGenConfig, DataGenAnalysis, DataGenOptions, DataGenPlan, DataGenPreview, DataGenResult, DgColumn, DgTable, GenKind, TableGenConfig, TextCase } from '@shared/apis/datagen';
import { compatibleKinds, defaultDataGenOptions, defaultOptions, fixedSkipReason, suggestTable } from '@shared/datagen/auto';
import { genDef, genLabel, type OptionField } from '@shared/datagen/catalog';
import { regexError } from '@shared/datagen/patterns';
import { tr } from '@shared/i18n';
import { formatNumber } from '@shared/util';
import { api, errorMessage } from '../../api/client';
import { DataGrid } from '../../components/grid/DataGrid';
import type { GridColumnDef } from '../../components/grid/cellFormat';
import { ObjIcon } from '../../components/icons';
import { TaskPanel, useTask } from '../../components/TaskPanel';
import { toast } from '../../components/Toast';
import { confirmDialog, errorDialog, promptDialog } from '../../components/ui/Dialog';
import { Checkbox, EmptyState, Field, NumberInput, Section, Select, Spinner, TabStrip, TextArea, TextInput, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { showMenuBelow } from '../../components/ui/Menu';
import { useTabs, type TabProps } from '../../store/tabs';
import { getProfile, useWorkspace } from '../../store/workspace';
import './datagen.css';

type Page = 'tables' | 'options' | 'preview' | 'run';

interface Params {
  connectionId: string;
  database: string | null;
  tables: string[] | null;
}

const LW = 120;
const lower = (s: string) => s.toLowerCase();

function mergeConfig(t: DgTable, saved: TableGenConfig | undefined, enabled: boolean): TableGenConfig {
  const fresh = suggestTable(t, 100);
  if (!saved) return { ...fresh, enabled };
  const byCol = new Map(saved.columns.map((c) => [lower(c.column), c]));
  return {
    table: t.name,
    enabled: saved.enabled,
    rows: saved.rows,
    columns: fresh.columns.map((c) => {
      const s = byCol.get(lower(c.column));
      return s ? { ...c, ...s, column: c.column, options: { ...s.options } } : c;
    })
  };
}

export default function DataGenTab({ tab }: TabProps) {
  const p = tab.params as unknown as Params;
  const cid = p.connectionId;
  const db = p.database ?? '';
  const profile = useWorkspace((s) => s.profiles.find((x) => x.id === cid));
  const [analysis, setAnalysis] = useState<DataGenAnalysis | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configs, setConfigs] = useState<TableGenConfig[]>([]);
  const [options, setOptions] = useState<DataGenOptions>(defaultDataGenOptions);
  const [selTable, setSelTable] = useState<string | null>(null);
  const [selColumn, setSelColumn] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('tables');
  const [preview, setPreview] = useState<DataGenPreview[] | null>(null);
  const [previewTable, setPreviewTable] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const { info } = useTask(taskId);
  const running = !!taskId && (!info || info.status === 'running');

  useEffect(() => {
    useTabs.getState().update(tab.id, { subtitle: `${profile?.name ?? ''} / ${db}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.name]);

  const load = async (keep: TableGenConfig[] | null) => {
    if (!cid || !db) return;
    setLoadError(null);
    try {
      const a = await api.datagen.analyze(cid, db);
      const wanted = new Set((p.tables ?? []).map(lower));
      const prev = new Map((keep ?? []).map((c) => [lower(c.table), c]));
      const byName = new Map(a.tables.map((t) => [lower(t.name), t]));
      const order = keep?.length ? [...keep.map((c) => c.table).filter((n) => byName.has(lower(n))), ...a.order.filter((n) => !prev.has(lower(n)))] : a.order;
      setAnalysis(a);
      setConfigs(order.map((n) => mergeConfig(byName.get(lower(n))!, prev.get(lower(n)), wanted.has(lower(n)))));
      setSelTable((s) => s ?? order.find((n) => wanted.has(lower(n))) ?? order[0] ?? null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, db]);

  useEffect(() => {
    if (info && info.status !== 'running' && info.status === 'done') {
      void useWorkspace.getState().refreshDatabase(cid, db, ['tables']);
    }
  }, [info?.status, cid, db]);

  const metaOf = useMemo(() => new Map((analysis?.tables ?? []).map((t) => [lower(t.name), t])), [analysis]);
  const table = selTable ? metaOf.get(lower(selTable)) : undefined;
  const cfg = configs.find((c) => lower(c.table) === lower(selTable ?? ''));
  const column = table?.columns.find((c) => c.name === selColumn) ?? table?.columns[0];
  const ccfg = cfg?.columns.find((c) => c.column === column?.name);
  const plan: DataGenPlan = { connectionId: cid, database: db, tables: configs, options };
  const enabled = configs.filter((c) => c.enabled && c.rows > 0);
  const totalRows = enabled.reduce((a, c) => a + c.rows, 0);

  const setTable = (name: string, patch: Partial<TableGenConfig>) => setConfigs((cs) => cs.map((c) => (c.table === name ? { ...c, ...patch } : c)));
  const setColumn = (name: string, colName: string, patch: Partial<ColumnGenConfig>) =>
    setConfigs((cs) => cs.map((c) => (c.table === name ? { ...c, columns: c.columns.map((x) => (x.column === colName ? { ...x, ...patch } : x)) } : c)));

  const move = (d: -1 | 1) => {
    const i = configs.findIndex((c) => c.table === selTable);
    if (i < 0 || i + d < 0 || i + d >= configs.length) return;
    const a = [...configs];
    [a[i], a[i + d]] = [a[i + d], a[i]];
    setConfigs(a);
  };

  const sortByDependencies = () => {
    if (!analysis) return;
    const pos = new Map(analysis.order.map((n, i) => [lower(n), i]));
    setConfigs((cs) => [...cs].sort((a, b) => (pos.get(lower(a.table)) ?? 0) - (pos.get(lower(b.table)) ?? 0)));
  };

  /** enabled tables generated before one of their enabled parents */
  const orderWarnings = useMemo(() => {
    const out = new Map<string, string[]>();
    const idx = new Map(configs.map((c, i) => [lower(c.table), i]));
    configs.forEach((c, i) => {
      if (!c.enabled) return;
      const late = (metaOf.get(lower(c.table))?.dependsOn ?? []).filter((d) => {
        const j = idx.get(lower(d));
        return j !== undefined && j > i && configs[j].enabled;
      });
      if (late.length) out.set(c.table, late);
    });
    return out;
  }, [configs, metaOf]);

  const validation = (): string | null => {
    if (!enabled.length) return tr('Bitte mindestens eine Tabelle auswählen.', 'Please select at least one table.');
    for (const t of enabled) {
      for (const c of t.columns) {
        if (c.kind === 'regex') {
          const err = regexError(c.options.pattern ?? '');
          if (err) return tr('„{t}.{c}“: ungültiger Ausdruck ({e})', '"{t}.{c}": invalid expression ({e})', { t: t.table, c: c.column, e: err });
        }
      }
    }
    return null;
  };

  const runPreview = async () => {
    const err = validation();
    if (err) {
      toast(err, 'error');
      return;
    }
    setPreviewing(true);
    setPage('preview');
    try {
      const r = await api.datagen.preview(plan, 20);
      setPreview(r);
      setPreviewTable((t) => (r.some((x) => x.table === t) ? t : (r.find((x) => lower(x.table) === lower(selTable ?? ''))?.table ?? r[0]?.table ?? '')));
    } catch (e) {
      void errorDialog(e);
    } finally {
      setPreviewing(false);
    }
  };

  const start = async () => {
    const err = validation();
    if (err) {
      toast(err, 'error');
      return;
    }
    const list = enabled.map((c) => `• ${c.table}: ${formatNumber(c.rows)}`).join('\n');
    const ok = await confirmDialog({
      title: tr('Daten generieren', 'Generate data'),
      message: options.emptyTables
        ? tr('Alle vorhandenen Datensätze dieser Tabellen werden zuerst GELÖSCHT und dann neu erzeugt:\n\n{l}', 'All existing records of these tables are DELETED first and then generated:\n\n{l}', { l: list })
        : tr('{n} Datensätze in „{db}“ einfügen?\n\n{l}', 'Insert {n} records into "{db}"?\n\n{l}', { n: formatNumber(totalRows), db, l: list }),
      okLabel: tr('Generieren', 'Generate'),
      danger: options.emptyTables
    });
    if (!ok) return;
    try {
      setTaskId(await api.datagen.start(plan));
      setPage('run');
    } catch (e) {
      void errorDialog(e);
    }
  };

  const saveProfile = async () => {
    const name = await promptDialog({
      title: tr('Profil speichern', 'Save profile'),
      label: tr('Name des Generierungsprofils (auch in der Automatisierung verwendbar):', 'Name of the generation profile (usable in automation):'),
      value: db,
      validate: (v) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
    });
    if (!name) return;
    try {
      await api.profiles.save('dataGen', name.trim(), plan);
      toast(tr('Profil „{n}“ gespeichert', 'Profile "{n}" saved', { n: name.trim() }), 'success');
    } catch (e) {
      void errorDialog(e);
    }
  };

  const loadProfile = async (el: HTMLElement) => {
    try {
      const list = await api.profiles.list('dataGen');
      showMenuBelow(
        el,
        list.length
          ? list.map((x) => ({
              label: x.name,
              onClick: () =>
                void api.profiles.load('dataGen', x.name).then((d) => {
                  const pl = d as Partial<DataGenPlan>;
                  if (pl.database && lower(pl.database) !== lower(db)) toast(tr('Das Profil wurde für „{db}“ erstellt.', 'The profile was created for "{db}".', { db: pl.database }));
                  setOptions({ ...defaultDataGenOptions(), ...(pl.options ?? {}) });
                  void load(Array.isArray(pl.tables) ? pl.tables : []);
                }, (e) => void errorDialog(e))
            }))
          : [{ label: tr('Keine gespeicherten Profile', 'No saved profiles'), disabled: true }]
      );
    } catch (e) {
      void errorDialog(e);
    }
  };

  if (!cid || !db) {
    return <EmptyState title={tr('Datengenerator', 'Data Generator')}>{tr('Bitte zuerst eine Datenbank auswählen.', 'Please select a database first.')}</EmptyState>;
  }

  const allOn = configs.length > 0 && configs.every((c) => c.enabled);
  const someOn = configs.some((c) => c.enabled);

  return (
    <div className="ks-datagen">
      <Toolbar>
        <ToolbarButton icon={<RefreshCw size={15} />} label={tr('Neu einlesen', 'Reload')} disabled={running} onClick={() => void load(configs)} />
        <ToolbarButton icon={<Upload size={15} />} label={tr('Profil laden', 'Load Profile')} disabled={running} onClick={(e) => void loadProfile(e.currentTarget)} />
        <ToolbarButton icon={<Save size={15} />} label={tr('Profil speichern', 'Save Profile')} disabled={!analysis} onClick={() => void saveProfile()} />
        <ToolbarSep />
        <ToolbarButton icon={previewing ? <Spinner size={14} /> : <Eye size={15} />} label={tr('Vorschau', 'Preview')} disabled={!enabled.length || previewing || running} onClick={() => void runPreview()} />
        <ToolbarButton icon={<Play size={15} />} label={tr('Generieren', 'Generate')} disabled={!enabled.length || running} onClick={() => void start()} />
      </Toolbar>
      <TabStrip<Page>
        value={page}
        onChange={setPage}
        tabs={[
          { id: 'tables', label: tr('Tabellen und Spalten', 'Tables and columns'), badge: enabled.length || undefined },
          { id: 'options', label: tr('Optionen', 'Options') },
          { id: 'preview', label: tr('Vorschau', 'Preview') },
          { id: 'run', label: tr('Ausführung', 'Execution'), hidden: !taskId }
        ]}
      />
      {loadError && (
        <EmptyState icon={<TriangleAlert size={36} />} title={tr('Die Tabellen konnten nicht gelesen werden', 'The tables could not be read')}>
          {loadError}
        </EmptyState>
      )}
      {!loadError && !analysis && (
        <div className="ks-tab-loading">
          <Spinner size={22} />
        </div>
      )}
      {analysis && page === 'tables' && (
        <div className="ks-datagen-page">
          <div className="ks-datagen-split">
            <div className="ks-datagen-pane">
              <div className="ks-datagen-pane-head">
                <Checkbox checked={allOn} indeterminate={!allOn && someOn} onChange={(v) => setConfigs((cs) => cs.map((c) => ({ ...c, enabled: v })))} title={tr('Alle', 'All')} />
                <span className="grow">{tr('Tabellen (Reihenfolge)', 'Tables (order)')}</span>
                <button type="button" className="ks-icon-btn" title={tr('Nach Abhängigkeiten sortieren', 'Sort by dependencies')} onClick={sortByDependencies}>
                  <ListOrdered size={14} />
                </button>
                <button type="button" className="ks-icon-btn" title={tr('Nach oben', 'Move up')} onClick={() => move(-1)}>
                  <ArrowUp size={14} />
                </button>
                <button type="button" className="ks-icon-btn" title={tr('Nach unten', 'Move down')} onClick={() => move(1)}>
                  <ArrowDown size={14} />
                </button>
              </div>
              <div className="ks-datagen-scroll">
                {configs.map((c) => {
                  const m = metaOf.get(lower(c.table));
                  const warn = orderWarnings.get(c.table);
                  return (
                    <div
                      key={c.table}
                      className={clsx('ks-datagen-row', c.table === selTable && 'selected', !c.enabled && 'off')}
                      onMouseDown={(e) => {
                        if ((e.target as HTMLElement).closest('input')) return;
                        setSelTable(c.table);
                        setSelColumn(null);
                      }}
                    >
                      <Checkbox checked={c.enabled} onChange={(enabled) => setTable(c.table, { enabled })} />
                      <ObjIcon kind="table" size={14} />
                      <span className="ks-datagen-name ellipsis" title={c.table}>
                        {c.table}
                        <div className="ks-datagen-sub">{tr('~{n} vorhanden', '~{n} existing', { n: formatNumber(m?.rows ?? 0) })}</div>
                      </span>
                      {warn && (
                        <span title={tr('Wird vor {t} erzeugt, auf die sie verweist', 'Generated before {t}, which it references', { t: warn.join(', ') })}>
                          <TriangleAlert size={14} className="ks-datagen-warn" />
                        </span>
                      )}
                      <NumberInput className="ks-datagen-rows" min={0} max={10_000_000} value={c.rows} onChange={(v) => setTable(c.table, { rows: v === '' ? 0 : Math.max(0, Math.floor(v)) })} />
                    </div>
                  );
                })}
              </div>
              <div className="ks-statusline">{tr('{t} Tabellen, {n} Datensätze', '{t} tables, {n} records', { t: enabled.length, n: formatNumber(totalRows) })}</div>
            </div>
            <div className="ks-datagen-pane">
              <div className="ks-datagen-pane-head">{table ? tr('Spalten von „{t}“', 'Columns of "{t}"', { t: table.name }) : tr('Spalten', 'Columns')}</div>
              <div className="ks-datagen-scroll">
                {table?.columns.map((c) => {
                  const cc = cfg?.columns.find((x) => x.column === c.name);
                  const skip = fixedSkipReason(c);
                  return (
                    <div key={c.name} className={clsx('ks-datagen-row', c.name === column?.name && 'selected', (skip || cc?.kind === 'skip') && 'off')} onMouseDown={() => setSelColumn(c.name)}>
                      <ObjIcon kind={table.uniqueKeys.some((k) => k.primary && k.columns.includes(c.name)) ? 'key' : table.foreignKeys.some((f) => f.columns.includes(c.name)) ? 'foreignKey' : 'column'} size={14} />
                      <span className="ks-datagen-name ellipsis" title={c.columnType}>
                        {c.name}
                        <div className="ks-datagen-sub">
                          {c.columnType}
                          {c.nullable ? '' : ' NOT NULL'}
                        </div>
                      </span>
                      <span className="ks-datagen-kind ellipsis">{skip ?? (cc ? genLabel(cc.kind) : '')}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="ks-datagen-pane">
              <div className="ks-datagen-pane-head">{column ? tr('Generator für „{c}“', 'Generator for "{c}"', { c: column.name }) : tr('Generator', 'Generator')}</div>
              <div className="ks-datagen-scroll">
                {table && cfg && column && ccfg && (
                  <ColumnForm
                    key={`${table.name}.${column.name}`}
                    table={table}
                    column={column}
                    cfg={ccfg}
                    tables={analysis.tables}
                    onChange={(patch) => setColumn(cfg.table, column.name, patch)}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {analysis && page === 'options' && <OptionsPage options={options} onChange={setOptions} />}
      {analysis && page === 'preview' && (
        <div className="ks-datagen-page">
          <div className="ks-datagen-preview-head">
            {previewing && <Spinner />}
            {preview && (
              <Select
                style={{ width: 260 }}
                value={previewTable}
                onChange={setPreviewTable}
                options={preview.map((x) => ({ value: x.table, label: x.error ? `${x.table} – ${tr('Fehler', 'error')}` : x.table }))}
              />
            )}
            <span className="muted">
              {preview ? tr('Die ersten {n} Datensätze je Tabelle – es wird nichts gespeichert.', 'The first {n} records per table – nothing is saved.', { n: 20 }) : tr('Noch keine Vorschau erstellt.', 'No preview created yet.')}
            </span>
          </div>
          <PreviewGrid preview={preview?.find((x) => x.table === previewTable) ?? null} table={metaOf.get(lower(previewTable))} />
        </div>
      )}
      {page === 'run' && taskId && (
        <div className="ks-datagen-run">
          {info?.status === 'done' && (
            <div className="ks-datagen-hint" style={{ marginBottom: 8 }}>
              {tr('{n} Datensätze eingefügt, {e} Fehler.', '{n} records inserted, {e} errors.', {
                n: formatNumber((info.result as DataGenResult).rows),
                e: (info.result as DataGenResult).errors
              })}
            </div>
          )}
          <TaskPanel taskId={taskId} />
        </div>
      )}
    </div>
  );
}

function OptionsPage({ options, onChange }: { options: DataGenOptions; onChange: (o: DataGenOptions) => void }) {
  const set = (patch: Partial<DataGenOptions>) => onChange({ ...options, ...patch });
  return (
    <div className="ks-datagen-options">
      <Section title={tr('Daten', 'Data')}>
        <Field label={tr('Sprache der Daten', 'Data locale')} labelWidth={170}>
          <Select
            style={{ width: 200 }}
            value={options.locale}
            onChange={(locale) => set({ locale })}
            options={[
              { value: 'de', label: tr('Deutsch', 'German') },
              { value: 'en', label: tr('Englisch', 'English') }
            ]}
          />
        </Field>
        <Field label={tr('Startwert (Seed)', 'Seed')} labelWidth={170} hint={tr('Gleicher Startwert = gleiche Daten; leer = jedes Mal andere Daten', 'Same seed = same data; empty = different data every time')}>
          <NumberInput style={{ width: 200 }} value={options.seed ?? ''} onChange={(v) => set({ seed: v === '' ? null : Math.floor(v) })} />
        </Field>
      </Section>
      <Section title={tr('Ausführung', 'Execution')}>
        <Field label={tr('Datensätze je INSERT', 'Records per INSERT')} labelWidth={170}>
          <NumberInput style={{ width: 200 }} min={1} max={10000} value={options.rowsPerInsert} onChange={(v) => set({ rowsPerInsert: v === '' ? 100 : Math.max(1, Math.min(10000, Math.floor(v))) })} />
        </Field>
        <Checkbox checked={options.emptyTables} onChange={(emptyTables) => set({ emptyTables })} label={tr('Tabellen vorher leeren (DELETE)', 'Empty tables first (DELETE)')} />
        <Checkbox checked={options.transaction} onChange={(transaction) => set({ transaction })} label={tr('In einer Transaktion ausführen (bei Fehler alles zurückrollen)', 'Run in one transaction (roll back everything on error)')} />
        <Checkbox
          checked={options.continueOnError}
          disabled={options.transaction}
          onChange={(continueOnError) => set({ continueOnError })}
          label={tr('Bei Fehlern fortfahren', 'Continue on error')}
        />
        <Checkbox checked={options.disableForeignKeys} onChange={(disableForeignKeys) => set({ disableForeignKeys })} label={tr('Fremdschlüsselprüfung deaktivieren', 'Disable foreign key checks')} />
        <div className="ks-datagen-hint">
          {tr(
            'Berechnete Spalten und Auto-Increment-Spalten werden nie gefüllt. Fremdschlüssel verwenden vorhandene Werte der referenzierten Tabelle und die in diesem Lauf zuvor erzeugten Datensätze.',
            'Generated and auto increment columns are never filled. Foreign keys use existing values of the referenced table and the records generated earlier in this run.'
          )}
        </div>
      </Section>
    </div>
  );
}

function PreviewGrid({ preview, table }: { preview: DataGenPreview | null; table: DgTable | undefined }) {
  const columns: GridColumnDef[] = useMemo(
    () =>
      (preview?.columns ?? []).map((name) => {
        const c = table?.columns.find((x) => x.name === name);
        const t = c?.dataType ?? '';
        const numeric = /int|decimal|numeric|float|double|real|year/.test(t);
        const kind: GridColumnDef['kind'] = /blob/.test(t) ? 'blob' : /binary/.test(t) ? 'binary' : numeric ? 'number' : 'text';
        return { id: name, title: name, kind, typeLabel: c?.columnType.toUpperCase() ?? '', numeric, nullable: c?.nullable };
      }),
    [preview, table]
  );
  if (!preview) return <div className="ks-datagen-grid" />;
  if (preview.error) {
    return (
      <EmptyState icon={<TriangleAlert size={32} />} title={tr('Vorschau nicht möglich', 'Preview not possible')}>
        {preview.error}
      </EmptyState>
    );
  }
  return (
    <div className="ks-datagen-grid">
      <DataGrid columns={columns} rowCount={preview.rows.length} getValue={(r, c) => preview.rows[r]?.[c] ?? null} />
    </div>
  );
}

function OptionInput({ field, cfg, column, tables, onChange }: { field: OptionField; cfg: ColumnGenConfig; column: DgColumn; tables: DgTable[]; onChange: (patch: Partial<ColumnGenConfig>) => void }) {
  const o = cfg.options;
  const setOpt = (patch: Record<string, unknown>) => onChange({ options: { ...o, ...patch } });
  switch (field.type) {
    case 'number':
      return (
        <Field label={field.label()} labelWidth={LW}>
          <NumberInput min={field.min} max={field.max} value={(o[field.key] as number | undefined) ?? ''} onChange={(v) => setOpt({ [field.key]: v === '' ? undefined : v })} />
        </Field>
      );
    case 'date':
    case 'datetime':
    case 'time': {
      const ph = field.type === 'date' ? 'YYYY-MM-DD' : field.type === 'time' ? 'HH:MM:SS' : 'YYYY-MM-DD HH:MM:SS';
      return (
        <Field label={field.label()} labelWidth={LW}>
          <TextInput value={o[field.key] ?? ''} placeholder={ph} onChange={(e) => setOpt({ [field.key]: e.target.value })} />
        </Field>
      );
    }
    case 'list': {
      const list = (o[field.key] as string[] | undefined) ?? [];
      return (
        <Field label={field.label()} labelWidth={LW} alignTop>
          <TextArea rows={5} value={list.join('\n')} onChange={(e) => setOpt({ [field.key]: e.target.value.split(/\r?\n/) })} onBlur={(e) => setOpt({ [field.key]: e.target.value.split(/\r?\n/).filter((x) => x !== '') })} />
        </Field>
      );
    }
    case 'text': {
      const err = field.key === 'pattern' && cfg.kind === 'regex' ? regexError(o.pattern ?? '') : null;
      return (
        <Field label={field.label()} labelWidth={LW} hint={err ? <span className="danger-text">{err}</span> : field.hint?.()}>
          <TextInput className={field.key === 'pattern' ? 'mono' : undefined} invalid={!!err} value={(o[field.key] as string | undefined) ?? ''} placeholder={field.placeholder} onChange={(e) => setOpt({ [field.key]: e.target.value })} />
        </Field>
      );
    }
    case 'check':
      return (
        <Field label="" labelWidth={LW}>
          <Checkbox checked={o[field.key] !== false} onChange={(v) => setOpt({ [field.key]: v })} label={field.label()} />
        </Field>
      );
    case 'select':
      return (
        <Field label={field.label()} labelWidth={LW}>
          <Select value={(o[field.key] as string | undefined) ?? field.options()[0]?.value ?? ''} onChange={(v) => setOpt({ [field.key]: v })} options={field.options()} />
        </Field>
      );
    default: {
      const ref = tables.find((t) => lower(t.name) === lower(o.refTable ?? ''));
      return (
        <>
          <Field label={tr('Tabelle', 'Table')} labelWidth={LW}>
            <Select
              value={o.refTable ?? ''}
              onChange={(refTable) => setOpt({ refTable, refSchema: '', refColumn: tables.find((t) => t.name === refTable)?.columns[0]?.name ?? '', constraint: '' })}
              options={[{ value: '', label: tr('(Tabelle wählen)', '(choose table)') }, ...tables.map((t) => ({ value: t.name, label: t.name }))]}
            />
          </Field>
          <Field label={tr('Spalte', 'Column')} labelWidth={LW}>
            <Select
              value={o.refColumn ?? ''}
              onChange={(refColumn) => setOpt({ refColumn, constraint: '' })}
              options={[
                { value: '', label: tr('(Spalte wählen)', '(choose column)') },
                ...(ref?.columns ?? (o.refColumn ? [{ name: o.refColumn } as DgColumn] : [])).map((c) => ({ value: c.name, label: c.name }))
              ]}
            />
          </Field>
          {o.constraint && <div className="ks-datagen-hint">{tr('Fremdschlüssel „{n}“', 'Foreign key "{n}"', { n: o.constraint })}</div>}
          {!column.nullable && <div className="ks-datagen-hint">{tr('Die referenzierte Tabelle muss Datensätze enthalten (oder vorher erzeugt werden).', 'The referenced table must contain records (or be generated earlier).')}</div>}
        </>
      );
    }
  }
}

function ColumnForm({ table, column, cfg, tables, onChange }: { table: DgTable; column: DgColumn; cfg: ColumnGenConfig; tables: DgTable[]; onChange: (patch: Partial<ColumnGenConfig>) => void }) {
  const skip = fixedSkipReason(column);
  if (skip) {
    return (
      <div className="ks-datagen-form">
        <div className="ks-datagen-hint">
          {tr('{r}: Die Spalte wird vom Server gefüllt und nicht generiert.', '{r}: the column is filled by the server and not generated.', { r: skip })}
        </div>
      </div>
    );
  }
  const kinds = compatibleKinds(column);
  if (!kinds.includes(cfg.kind)) kinds.push(cfg.kind);
  const def = genDef(cfg.kind);
  const keyUnique = table.uniqueKeys.some((k) => k.columns.length === 1 && k.columns[0] === column.name);
  const textual = !['skip', 'null', 'foreignKey', 'intRange', 'sequence', 'decimalRange', 'boolean', 'bit', 'date', 'datetime', 'time', 'year', 'binary', 'geometry', 'json'].includes(cfg.kind);
  return (
    <div className="ks-datagen-form">
      <Field label={tr('Generator', 'Generator')} labelWidth={LW}>
        <Select<GenKind>
          value={cfg.kind}
          onChange={(kind) => onChange({ kind, options: defaultOptions(kind, column, table) })}
          options={kinds.map((k) => ({ value: k, label: genLabel(k) }))}
        />
      </Field>
      {def.hint && <div className="ks-datagen-hint">{def.hint()}</div>}
      {cfg.kind !== 'skip' && cfg.kind !== 'null' && (
        <>
          {def.fields.map((f) => (
            <OptionInput key={f.key} field={f} cfg={cfg} column={column} tables={tables} onChange={onChange} />
          ))}
          <Section title={tr('Allgemein', 'General')}>
            <Field label={tr('NULL-Anteil (%)', 'NULL share (%)')} labelWidth={LW} hint={!column.nullable ? tr('Die Spalte erlaubt kein NULL.', 'The column does not allow NULL.') : undefined}>
              <NumberInput min={0} max={100} disabled={!column.nullable} value={column.nullable ? cfg.nullPercent : 0} onChange={(v) => onChange({ nullPercent: v === '' ? 0 : Math.max(0, Math.min(100, v)) })} />
            </Field>
            <Field label="" labelWidth={LW}>
              <Checkbox
                checked={cfg.unique || keyUnique}
                disabled={keyUnique}
                onChange={(unique) => onChange({ unique })}
                label={keyUnique ? tr('Eindeutige Werte (eindeutiger Index)', 'Unique values (unique index)') : tr('Eindeutige Werte', 'Unique values')}
              />
            </Field>
            {textual && (
              <Field label={tr('Schreibweise', 'Letter case')} labelWidth={LW}>
                <Select<TextCase>
                  value={cfg.textCase}
                  onChange={(textCase) => onChange({ textCase })}
                  options={[
                    { value: 'none', label: tr('Unverändert', 'Unchanged') },
                    { value: 'lower', label: tr('kleinbuchstaben', 'lower case') },
                    { value: 'upper', label: tr('GROSSBUCHSTABEN', 'UPPER CASE') },
                    { value: 'proper', label: tr('Erster Buchstabe Groß', 'Proper Case') }
                  ]}
                />
              </Field>
            )}
          </Section>
        </>
      )}
      <div className="ks-datagen-hint">
        {column.columnType}
        {column.nullable ? '' : ' NOT NULL'}
        {column.defaultValue !== null ? ` DEFAULT ${column.defaultValue}` : ''}
        {column.comment ? ` – ${column.comment}` : ''}
      </div>
    </div>
  );
}

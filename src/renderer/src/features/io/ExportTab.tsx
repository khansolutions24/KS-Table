// Export wizard: tables / views / a query → CSV, TXT, JSON, XML, HTML, Excel, SQL, Markdown.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Braces, Code, FileCode, FileSpreadsheet, FileText, FolderOpen, Hash, Table2 } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { ExportFormat, ExportObjectSpec, ExportOptions, ExportProfile, ExportResult } from '@shared/apis/io';
import { defaultExportOptions, encodingOptions, exportExtension, supportsAppend, supportsSameFile } from '@shared/io/defaults';
import { formatStamp } from '@shared/io/datetime';
import { safeFileName } from '@shared/util';
import { api } from '../../api/client';
import { errorDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, Field, IconButton, NumberInput, RadioGroup, Section, Select, Spinner, TextInput } from '../../components/ui/controls';
import { PathInput } from '../../components/ui/PathInput';
import { ObjIcon } from '../../components/icons';
import { TaskPanel } from '../../components/TaskPanel';
import type { TabProps } from '../../store/tabs';
import { DelimiterInput, documentsDir, FIELD_DELIMITERS, Hint, ProfileButtons, QUALIFIERS, useDatabases, useTaskDone, withMeta, Wizard } from './common';

interface Source {
  name: string;
  kind: 'table' | 'view' | 'query';
}

interface FieldState {
  all: string[] | null;
  /** selected fields in output order (null = all) */
  selected: string[] | null;
}

const FORMATS: { id: ExportFormat; icon: ReactNode; name: string; desc: () => string }[] = [
  { id: 'csv', icon: <FileText size={20} />, name: 'CSV', desc: () => tr('Kommagetrennte Werte (.csv)', 'Comma separated values (.csv)') },
  { id: 'txt', icon: <FileText size={20} />, name: 'TXT', desc: () => tr('Textdatei mit Trennzeichen oder fester Breite', 'Text file, delimited or fixed width') },
  { id: 'json', icon: <Braces size={20} />, name: 'JSON', desc: () => tr('JSON-Array oder JSON Lines', 'JSON array or JSON Lines') },
  { id: 'xml', icon: <Code size={20} />, name: 'XML', desc: () => tr('Datensätze als Elemente oder Attribute', 'Records as elements or attributes') },
  { id: 'html', icon: <Table2 size={20} />, name: 'HTML', desc: () => tr('Formatierte HTML-Tabelle', 'Styled HTML table') },
  { id: 'xlsx', icon: <FileSpreadsheet size={20} />, name: 'Excel', desc: () => tr('Excel-Arbeitsmappe (.xlsx)', 'Excel workbook (.xlsx)') },
  { id: 'sql', icon: <FileCode size={20} />, name: 'SQL', desc: () => tr('INSERT-Anweisungen, optional mit CREATE TABLE', 'INSERT statements, optionally with CREATE TABLE') },
  { id: 'md', icon: <Hash size={20} />, name: 'Markdown', desc: () => tr('Markdown-Tabelle (.md)', 'Markdown table (.md)') }
];

const LW = 170;

export default function ExportTab({ tab }: TabProps) {
  const params = tab.params as { connectionId: string; database: string | null; tables: string[] | null; query: string | null };
  const cid = params.connectionId;
  const queryMode = !!params.query;
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [database, setDatabase] = useState(params.database ?? '');
  const [sources, setSources] = useState<Source[] | null>(queryMode ? [{ name: 'query_result', kind: 'query' }] : null);
  const [checked, setChecked] = useState<string[]>(queryMode ? ['query_result'] : []);
  const [queryName, setQueryName] = useState('query_result');
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const [fieldObj, setFieldObj] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [pattern, setPattern] = useState('{name}');
  const [sameFile, setSameFile] = useState(false);
  const [sameFileName, setSameFileName] = useState('export');
  const [timestamp, setTimestamp] = useState(false);
  const [stampFormat, setStampFormat] = useState('YYYYMMDD_HHmmss');
  const [o, setO] = useState<ExportOptions>(() => defaultExportOptions('csv'));
  const [taskId, setTaskId] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const databases = useDatabases(cid);
  const set = (patch: Partial<ExportOptions>) => setO((x) => ({ ...x, ...patch }));

  useEffect(() => {
    void documentsDir().then((d) => setOutputDir((x) => x || d));
  }, []);

  // objects of the database
  useEffect(() => {
    if (queryMode || !database) return;
    let cancelled = false;
    setSources(null);
    void withMeta(cid, async (sid) => {
      const [t, v] = await Promise.all([api.meta.tables(sid, database), api.meta.views(sid, database)]);
      return [...t.map((x) => ({ name: x.name, kind: 'table' as const })), ...v.map((x) => ({ name: x.name, kind: 'view' as const }))];
    })
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        setChecked((c) => {
          const names = new Set(list.map((x) => x.name));
          const keep = c.filter((n) => names.has(n));
          if (keep.length) return keep;
          return params.tables?.length && database === params.database ? list.filter((x) => params.tables!.includes(x.name)).map((x) => x.name) : [];
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setSources([]);
          void errorDialog(e);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, database, queryMode]);

  const selectedSources = useMemo(() => (sources ?? []).filter((x) => checked.includes(x.name)), [sources, checked]);

  // fields of the object shown in the field step
  const loadFields = async (name: string) => {
    if (fields[name]?.all) return;
    try {
      const src = (sources ?? []).find((x) => x.name === name);
      const all =
        src?.kind === 'query'
          ? await api.io.queryColumns(cid, database || null, params.query!)
          : await withMeta(cid, (sid) => api.meta.columns(sid, database, name).then((c) => c.filter((x) => !/INVISIBLE/i.test(x.extra)).map((x) => x.name)));
      setFields((f) => ({ ...f, [name]: { all, selected: f[name]?.selected ?? null } }));
    } catch (e) {
      setFields((f) => ({ ...f, [name]: { all: [], selected: null } }));
      void errorDialog(e);
    }
  };
  useEffect(() => {
    if (step !== 2) return;
    const first = fieldObj && checked.includes(fieldObj) ? fieldObj : (selectedSources[0]?.name ?? null);
    setFieldObj(first);
    if (first) void loadFields(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, fieldObj, checked.join('\n')]);

  const running = useTaskDone(taskId, (status, res) => {
    if (status === 'done') setResult(res as ExportResult);
  });

  const objName = (s: Source) => (s.kind === 'query' ? queryName.trim() || 'query_result' : s.name);

  const profile = (): ExportProfile => ({
    version: 1,
    connectionId: cid,
    database: database || null,
    format,
    query: queryMode ? params.query : null,
    objects: selectedSources.map<ExportObjectSpec>((s) => ({
      name: objName(s),
      kind: s.kind,
      fileName: fileNames[s.name] ?? '',
      fields: fields[s.name]?.selected ?? null
    })),
    outputDir,
    fileNamePattern: pattern,
    sameFile: sameFile && supportsSameFile(format),
    sameFileName,
    timestamp,
    timestampFormat: stampFormat,
    options: o
  });

  const changeFormat = (f: ExportFormat) => {
    setFormat(f);
    const d = defaultExportOptions(f);
    setO((x) => ({ ...x, fieldDelimiter: d.fieldDelimiter, nullText: d.nullText, append: false }));
  };

  const start = async () => {
    try {
      setResult(null);
      setTaskId(await api.io.startExport(profile()));
    } catch (e) {
      void errorDialog(e);
    }
  };

  const steps = [
    { id: 'format', label: tr('Format', 'Format') },
    { id: 'objects', label: queryMode ? tr('Abfrage und Datei', 'Query and file') : tr('Objekte und Dateien', 'Objects and files') },
    { id: 'fields', label: tr('Felder', 'Fields') },
    { id: 'options', label: tr('Optionen', 'Options') },
    { id: 'run', label: tr('Ausführen', 'Run') }
  ];

  const stepValid = (i: number): boolean => {
    if (i === 1) return selectedSources.length > 0 && !!outputDir.trim() && (!!database || queryMode);
    if (i === 2) return selectedSources.every((s) => fields[s.name]?.selected === undefined || fields[s.name]?.selected === null || fields[s.name]!.selected!.length > 0);
    return true;
  };

  const goto = (i: number) => {
    setStep(i);
    setMaxStep((m) => Math.max(m, i));
  };

  const ext = exportExtension(format, o);
  const stamp = timestamp ? `_${safeFileName(formatStamp(stampFormat, new Date()))}` : '';
  const defaultFile = (s: Source) => safeFileName(pattern.replace(/\{name\}/g, objName(s)).replace(/\{db\}/g, database)) + stamp + ext;

  return (
    <Wizard
      steps={steps}
      step={step}
      onStep={goto}
      maxStep={stepValid(1) ? Math.max(maxStep, step) : Math.min(maxStep, 1)}
      canNext={stepValid(step)}
      running={running}
      onStart={() => void start()}
      startDisabled={!stepValid(1) || !stepValid(2)}
      footerLeft={
        <ProfileButtons<ExportProfile>
          kind="export"
          disabled={running}
          current={profile}
          onLoad={(p) => {
            setFormat(p.format ?? 'csv');
            setO({ ...defaultExportOptions(p.format ?? 'csv'), ...(p.options ?? {}) });
            if (!queryMode && p.database) setDatabase(p.database);
            setOutputDir(p.outputDir ?? '');
            setPattern(p.fileNamePattern || '{name}');
            setSameFile(!!p.sameFile);
            setSameFileName(p.sameFileName || 'export');
            setTimestamp(!!p.timestamp);
            setStampFormat(p.timestampFormat || 'YYYYMMDD_HHmmss');
            const objs = (p.objects ?? []).filter((x) => (queryMode ? x.kind === 'query' : x.kind !== 'query'));
            if (queryMode && objs[0]) setQueryName(objs[0].name);
            const key = (x: ExportObjectSpec) => (x.kind === 'query' ? 'query_result' : x.name);
            if (!queryMode) setChecked(objs.map(key));
            setFileNames(Object.fromEntries(objs.map((x) => [key(x), x.fileName ?? ''])));
            setFields(Object.fromEntries(objs.map((x) => [key(x), { all: null, selected: x.fields ?? null }])));
            setMaxStep(4);
          }}
        />
      }
    >
      {step === 0 && (
        <>
          <h3 className="ks-io-title">{tr('Exportformat wählen', 'Choose the export format')}</h3>
          <div className="ks-io-formats" role="radiogroup">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={format === f.id}
                className={clsx('ks-io-format', format === f.id && 'active')}
                onClick={() => changeFormat(f.id)}
                onDoubleClick={() => {
                  changeFormat(f.id);
                  goto(1);
                }}
              >
                {f.icon}
                <span>
                  <div className="ks-io-format-name">{f.name}</div>
                  <div className="ks-io-format-desc">{f.desc()}</div>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <div className="ks-io-form">
            <div className="ks-form">
              {!queryMode && (
                <Field label={tr('Datenbank', 'Database')} labelWidth={LW}>
                  <Select
                    value={database}
                    onChange={(d) => {
                      setDatabase(d);
                      setChecked([]);
                      setFields({});
                      setFileNames({});
                    }}
                    options={[{ value: '', label: tr('(bitte wählen)', '(please choose)') }, ...[...new Set([...databases, ...(database ? [database] : [])])].map((d) => ({ value: d, label: d }))]}
                  />
                </Field>
              )}
              <Field label={tr('Zielordner', 'Output folder')} labelWidth={LW}>
                <PathInput mode="dir" value={outputDir} onChange={setOutputDir} title={tr('Zielordner wählen', 'Choose output folder')} />
              </Field>
              <Field label={tr('Dateinamen-Muster', 'File name pattern')} labelWidth={LW} hint={tr('{name} = Objektname, {db} = Datenbank', '{name} = object name, {db} = database')}>
                <TextInput value={pattern} onChange={(e) => setPattern(e.target.value)} />
              </Field>
            </div>
            <div className="ks-form">
              <Checkbox
                checked={sameFile && supportsSameFile(format)}
                disabled={!supportsSameFile(format) || queryMode}
                onChange={setSameFile}
                label={format === 'xlsx' ? tr('Alle Objekte in eine Arbeitsmappe (ein Blatt je Objekt)', 'All objects into one workbook (one sheet per object)') : tr('Alle Objekte in eine Datei', 'All objects into one file')}
              />
              {sameFile && supportsSameFile(format) && !queryMode && (
                <Field label={tr('Dateiname', 'File name')} labelWidth={LW - 30}>
                  <TextInput value={sameFileName} onChange={(e) => setSameFileName(e.target.value)} />
                </Field>
              )}
              <div className="ks-io-inline">
                <Checkbox checked={timestamp} onChange={setTimestamp} label={tr('Zeitstempel an Dateinamen anhängen', 'Append timestamp to file names')} />
                <TextInput className="ks-io-medium" disabled={!timestamp} value={stampFormat} onChange={(e) => setStampFormat(e.target.value)} title="YYYY MM DD HH mm ss" />
              </div>
            </div>
          </div>
          {queryMode ? (
            <div className="ks-form">
              <Field label={tr('Name des Ergebnisses', 'Result name')} labelWidth={LW} hint={tr('Wird für Dateiname, Tabellenblatt und SQL-Tabellenname verwendet.', 'Used for the file name, worksheet and SQL table name.')}>
                <TextInput value={queryName} onChange={(e) => setQueryName(e.target.value)} />
              </Field>
              <Field label={tr('Dateiname', 'File name')} labelWidth={LW}>
                <TextInput value={fileNames.query_result ?? ''} placeholder={defaultFile({ name: 'query_result', kind: 'query' })} onChange={(e) => setFileNames({ query_result: e.target.value })} />
              </Field>
              <pre className="ks-msg-details mono selectable" style={{ margin: 0, padding: 8, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--bg-code)', border: '1px solid var(--border)', borderRadius: 4 }}>
                {params.query}
              </pre>
            </div>
          ) : (
            <div className="ks-io-box ks-io-grow">
              <div className="ks-io-box-head">
                <strong>{tr('Objekte', 'Objects')}</strong>
                <span className="muted">{tr('{n} ausgewählt', '{n} selected', { n: checked.length })}</span>
                <div className="spacer" />
                <Button size="sm" disabled={!sources?.length} onClick={() => setChecked((sources ?? []).map((x) => x.name))}>
                  {tr('Alle auswählen', 'Select all')}
                </Button>
                <Button size="sm" onClick={() => setChecked([])}>
                  {tr('Keine', 'None')}
                </Button>
              </div>
              <div className="ks-io-box-body">
                {!database ? (
                  <div className="ks-io-preview-msg">{tr('Bitte eine Datenbank wählen.', 'Please choose a database.')}</div>
                ) : !sources ? (
                  <div className="ks-io-preview-msg">
                    <Spinner />
                  </div>
                ) : (
                  <table className="ks-table ks-io-table">
                    <thead>
                      <tr>
                        <th style={{ width: 30 }} />
                        <th>{tr('Objekt', 'Object')}</th>
                        <th style={{ width: '50%' }}>{sameFile && supportsSameFile(format) ? tr('Datei', 'File') : tr('Dateiname (leer = Muster)', 'File name (empty = pattern)')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources.map((s) => {
                        const on = checked.includes(s.name);
                        return (
                          <tr key={s.name} className={clsx(!on && 'muted')}>
                            <td className="center">
                              <Checkbox checked={on} onChange={(v) => setChecked((c) => (v ? [...c, s.name] : c.filter((x) => x !== s.name)))} />
                            </td>
                            <td>
                              <span className="row" style={{ gap: 6 }}>
                                <ObjIcon kind={s.kind === 'view' ? 'view' : 'table'} size={14} />
                                {s.name}
                              </span>
                            </td>
                            <td>
                              {sameFile && supportsSameFile(format) ? (
                                <span className="faint">{safeFileName(sameFileName) + stamp + ext}</span>
                              ) : (
                                <TextInput disabled={!on} value={fileNames[s.name] ?? ''} placeholder={defaultFile(s)} onChange={(e) => setFileNames((f) => ({ ...f, [s.name]: e.target.value }))} />
                              )}
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
        </>
      )}

      {step === 2 && (
        <div className="ks-io-split">
          <div className="ks-io-box">
            <div className="ks-io-box-head">
              <strong>{tr('Objekte', 'Objects')}</strong>
            </div>
            <div className="ks-io-box-body">
              {selectedSources.map((s) => (
                <div key={s.name} className={clsx('ks-io-list-item', fieldObj === s.name && 'selected')} onMouseDown={() => setFieldObj(s.name)}>
                  <ObjIcon kind={s.kind === 'view' ? 'view' : s.kind === 'query' ? 'query' : 'table'} size={14} />
                  <span className="ellipsis">{objName(s)}</span>
                  {fields[s.name]?.selected && <span className="ks-badge">{fields[s.name]!.selected!.length}</span>}
                </div>
              ))}
            </div>
          </div>
          {fieldObj && <FieldPicker state={fields[fieldObj]} onChange={(st) => setFields((f) => ({ ...f, [fieldObj]: st }))} />}
        </div>
      )}

      {step === 3 && <OptionsForm format={format} o={o} set={set} />}

      {step === 4 && (
        <div className="ks-io-run">
          <div className="ks-io-summary">
            <span>{tr('Format', 'Format')}</span>
            <span>{FORMATS.find((f) => f.id === format)?.name}</span>
            <span>{queryMode ? tr('Abfrage', 'Query') : tr('Datenbank', 'Database')}</span>
            <span>{queryMode ? objName({ name: '', kind: 'query' }) : database}</span>
            <span>{tr('Objekte', 'Objects')}</span>
            <span>{selectedSources.map(objName).join(', ')}</span>
            <span>{tr('Zielordner', 'Output folder')}</span>
            <span>{outputDir}</span>
          </div>
          {taskId ? <TaskPanel taskId={taskId} /> : <div className="muted">{tr('Klicken Sie auf „Starten“, um den Export auszuführen.', 'Click "Start" to run the export.')}</div>}
          {result && result.files.length > 0 && (
            <div className="row">
              <Button icon={<FolderOpen size={14} />} onClick={() => void api.app.showItemInFolder(result.files[0])}>
                {tr('Im Ordner anzeigen', 'Show in folder')}
              </Button>
              <span className="muted">{tr('{n} Datei(en) geschrieben', '{n} file(s) written', { n: result.files.length })}</span>
            </div>
          )}
        </div>
      )}
    </Wizard>
  );
}

function FieldPicker({ state, onChange }: { state: FieldState | undefined; onChange: (s: FieldState) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  if (!state?.all) {
    return (
      <div className="ks-io-box">
        <div className="ks-io-preview-msg">
          <Spinner />
        </div>
      </div>
    );
  }
  const all = state.all;
  const order = state.selected ? [...state.selected, ...all.filter((n) => !state.selected!.includes(n))] : all;
  const isOn = (n: string) => !state.selected || state.selected.includes(n);
  const update = (selected: string[]) => onChange({ all, selected: selected.length === all.length && selected.every((n, i) => n === all[i]) ? null : selected });
  const selectedList = order.filter(isOn);
  const move = (d: -1 | 1) => {
    if (!sel || !isOn(sel)) return;
    const list = selectedList.slice();
    const i = list.indexOf(sel);
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    update(list);
  };
  return (
    <div className="ks-io-box">
      <div className="ks-io-box-head">
        <Checkbox
          checked={selectedList.length === all.length}
          indeterminate={selectedList.length > 0 && selectedList.length < all.length}
          onChange={(v) => update(v ? order : [])}
          label={<strong>{tr('Alle Felder', 'All fields')}</strong>}
        />
        <span className="muted">{tr('{s} von {n}', '{s} of {n}', { s: selectedList.length, n: all.length })}</span>
        <div className="spacer" />
        <IconButton icon={<ArrowUp size={15} />} title={tr('Nach oben', 'Move up')} disabled={!sel || !isOn(sel)} onClick={() => move(-1)} />
        <IconButton icon={<ArrowDown size={15} />} title={tr('Nach unten', 'Move down')} disabled={!sel || !isOn(sel)} onClick={() => move(1)} />
      </div>
      <div className="ks-io-box-body">
        {!selectedList.length && (
          <div className="ks-io-preview-msg error">{tr('Mindestens ein Feld muss ausgewählt sein.', 'At least one field must be selected.')}</div>
        )}
        {order.map((n) => (
          <div key={n} className={clsx('ks-io-list-item', sel === n && 'selected')} onMouseDown={() => setSel(n)}>
            <Checkbox checked={isOn(n)} onChange={(v) => update(v ? [...selectedList, n] : selectedList.filter((x) => x !== n))} />
            <ObjIcon kind="column" size={14} />
            <span className="ellipsis">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OptionsForm({ format, o, set }: { format: ExportFormat; o: ExportOptions; set: (p: Partial<ExportOptions>) => void }) {
  const textual = format === 'csv' || format === 'txt';
  const delimited = format === 'csv' || (format === 'txt' && o.txtLayout === 'delimited');
  const localized = format !== 'sql' && format !== 'json' && format !== 'xlsx';
  return (
    <div className="ks-io-form">
      <Section title={tr('Datei', 'File')}>
        {format !== 'xlsx' && (
          <Field label={tr('Zeichenkodierung', 'Encoding')} labelWidth={LW}>
            <Select value={o.encoding} onChange={(encoding) => set({ encoding })} options={encodingOptions('write')} />
          </Field>
        )}
        {(textual || format === 'html' || format === 'xlsx') && (
          <Checkbox checked={o.header} onChange={(header) => set({ header })} label={tr('Feldnamen als erste Zeile', 'Field names in the first row')} />
        )}
        <Checkbox
          checked={o.append && supportsAppend(format, o)}
          disabled={!supportsAppend(format, o)}
          onChange={(append) => set({ append })}
          label={tr('An vorhandene Datei anhängen', 'Append to existing file')}
        />
        <Checkbox checked={o.continueOnError} onChange={(continueOnError) => set({ continueOnError })} label={tr('Bei Fehlern mit dem nächsten Objekt fortfahren', 'Continue with the next object on error')} />
      </Section>

      {format === 'txt' && (
        <Section title={tr('Textlayout', 'Text layout')}>
          <RadioGroup
            inline
            value={o.txtLayout}
            onChange={(txtLayout) => set({ txtLayout })}
            options={[
              { value: 'delimited', label: tr('Mit Trennzeichen', 'Delimited') },
              { value: 'fixed', label: tr('Feste Breite', 'Fixed width') }
            ]}
          />
        </Section>
      )}

      {textual && (
        <Section title={tr('Trennzeichen', 'Delimiters')}>
          <Field label={tr('Datensatz-Trennzeichen', 'Record delimiter')} labelWidth={LW}>
            <Select
              value={o.recordDelimiter}
              onChange={(recordDelimiter) => set({ recordDelimiter })}
              options={[
                { value: 'crlf', label: 'CRLF (Windows)' },
                { value: 'lf', label: 'LF (Unix)' },
                { value: 'cr', label: 'CR' }
              ]}
            />
          </Field>
          {delimited && (
            <>
              <Field label={tr('Feld-Trennzeichen', 'Field delimiter')} labelWidth={LW}>
                <DelimiterInput value={o.fieldDelimiter} onChange={(fieldDelimiter) => set({ fieldDelimiter })} presets={FIELD_DELIMITERS()} />
              </Field>
              <Field label={tr('Textbegrenzer', 'Text qualifier')} labelWidth={LW}>
                <Select value={o.textQualifier} onChange={(textQualifier) => set({ textQualifier })} options={QUALIFIERS()} />
              </Field>
              <Field label={tr('Escape-Zeichen', 'Escape character')} labelWidth={LW} hint={o.textQualifier ? tr('Leer = Textbegrenzer verdoppeln', 'Empty = double the qualifier') : tr('z. B. \\ für \\n, \\t und \\N', 'e.g. \\ for \\n, \\t and \\N')}>
                <TextInput className="ks-io-short" maxLength={1} value={o.escapeChar} onChange={(e) => set({ escapeChar: e.target.value })} />
              </Field>
              <Checkbox checked={o.quoteAll} disabled={!o.textQualifier} onChange={(quoteAll) => set({ quoteAll })} label={tr('Alle Werte in Textbegrenzer setzen', 'Quote all values')} />
            </>
          )}
        </Section>
      )}

      {format === 'json' && (
        <Section title="JSON">
          <RadioGroup
            value={o.jsonLayout}
            onChange={(jsonLayout) => set({ jsonLayout })}
            options={[
              { value: 'array', label: tr('Array von Objekten', 'Array of objects') },
              { value: 'lines', label: tr('JSON Lines (ein Objekt je Zeile)', 'JSON Lines (one object per line)') }
            ]}
          />
          <Checkbox checked={o.jsonPretty} disabled={o.jsonLayout === 'lines'} onChange={(jsonPretty) => set({ jsonPretty })} label={tr('Eingerückt (lesbar)', 'Indented (pretty)')} />
        </Section>
      )}

      {format === 'xml' && (
        <Section title="XML">
          <RadioGroup
            value={o.xmlAttributes ? 'attr' : 'elem'}
            onChange={(v) => set({ xmlAttributes: v === 'attr' })}
            options={[
              { value: 'elem', label: tr('Felder als Unterelemente', 'Fields as child elements') },
              { value: 'attr', label: tr('Felder als Attribute', 'Fields as attributes') }
            ]}
          />
        </Section>
      )}

      {format === 'sql' && (
        <Section title="SQL">
          <Checkbox checked={o.sqlCreateTable} onChange={(sqlCreateTable) => set({ sqlCreateTable })} label={tr('CREATE TABLE einfügen', 'Include CREATE TABLE')} />
          <Checkbox checked={o.sqlDropTable} onChange={(sqlDropTable) => set({ sqlDropTable })} label={tr('DROP TABLE IF EXISTS einfügen', 'Include DROP TABLE IF EXISTS')} />
          <Field label={tr('Datensätze je INSERT', 'Records per INSERT')} labelWidth={LW}>
            <NumberInput value={o.sqlRowsPerStatement} min={1} style={{ width: 110 }} onChange={(v) => set({ sqlRowsPerStatement: v === '' ? 1 : v })} />
          </Field>
        </Section>
      )}

      {format !== 'sql' && (
        <Section title={tr('Werte', 'Values')}>
          {format !== 'json' && (
            <Field label={tr('NULL-Darstellung', 'NULL representation')} labelWidth={LW}>
              <TextInput className="ks-io-medium" value={o.nullText} placeholder={tr('(leer)', '(empty)')} onChange={(e) => set({ nullText: e.target.value })} />
            </Field>
          )}
          <Field label={tr('Datumsformat', 'Date format')} labelWidth={LW} hint="YYYY, YY, MM, M, DD, D">
            <Select
              value={o.dateFormat}
              onChange={(dateFormat) => set({ dateFormat })}
              options={['YYYY-MM-DD', 'DD.MM.YYYY', 'D.M.YYYY', 'MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY/MM/DD', 'YYYYMMDD'].map((v) => ({ value: v, label: v }))}
            />
          </Field>
          <Field label={tr('Zeitformat', 'Time format')} labelWidth={LW} hint={tr('HH/H 24 h, hh/h 12 h, mm, ss, SSS, A', 'HH/H 24 h, hh/h 12 h, mm, ss, SSS, A')}>
            <Select value={o.timeFormat} onChange={(timeFormat) => set({ timeFormat })} options={['HH:mm:ss', 'HH:mm', 'H:mm:ss', 'hh:mm:ss A', 'h:mm A', 'HH.mm.ss'].map((v) => ({ value: v, label: v }))} />
          </Field>
          {localized && (
            <>
              <Field label={tr('Dezimaltrennzeichen', 'Decimal separator')} labelWidth={LW}>
                <Select value={o.decimalSeparator} onChange={(decimalSeparator) => set({ decimalSeparator })} options={[{ value: '.', label: tr('Punkt (.)', 'Point (.)') }, { value: ',', label: tr('Komma (,)', 'Comma (,)') }]} />
              </Field>
              <Field label={tr('Tausendertrennzeichen', 'Thousands separator')} labelWidth={LW}>
                <Select
                  value={o.thousandsSeparator}
                  onChange={(thousandsSeparator) => set({ thousandsSeparator })}
                  options={[
                    { value: '', label: tr('Keines', 'None') },
                    { value: '.', label: '.' },
                    { value: ',', label: ',' },
                    { value: ' ', label: tr('Leerzeichen', 'Space') },
                    { value: "'", label: "'" }
                  ]}
                />
              </Field>
            </>
          )}
          {(localized || format === 'xlsx') && <Checkbox checked={o.blankIfZero} onChange={(blankIfZero) => set({ blankIfZero })} label={tr('Nullwerte (0) leer lassen', 'Leave zero numbers blank')} />}
          <Field label={tr('Binärdaten', 'Binary data')} labelWidth={LW}>
            <Select
              value={o.binaryEncoding}
              onChange={(binaryEncoding) => set({ binaryEncoding })}
              options={[
                { value: 'base64', label: 'Base64' },
                { value: 'hex', label: tr('Hexadezimal', 'Hexadecimal') },
                { value: 'none', label: tr('Als Text (UTF-8)', 'As text (UTF-8)') }
              ]}
            />
          </Field>
          {localized && (o.decimalSeparator !== '.' || o.thousandsSeparator) && (
            <Hint>{tr('Beim späteren Import müssen die gleichen Trennzeichen eingestellt werden.', 'The same separators must be set when importing the file later.')}</Hint>
          )}
        </Section>
      )}
    </div>
  );
}


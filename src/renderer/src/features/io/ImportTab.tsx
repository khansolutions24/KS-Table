// Import wizard: CSV / TXT, JSON, XML and Excel files into new or existing tables.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Braces, Code, FilePlus, FileSpreadsheet, FileText, Wand2, X } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { ColumnMeta } from '@shared/types';
import type {
  ImportAdvancedOptions,
  ImportFieldMap,
  ImportFormat,
  ImportMode,
  ImportParseOptions,
  ImportPreview,
  ImportProfile,
  ImportResult,
  XmlElementInfo
} from '@shared/apis/io';
import { defaultImportAdvanced, defaultImportOptions, encodingOptions, importExtensions, sanitizeName } from '@shared/io/defaults';
import { guessRowTag } from '@shared/io/xmlStream';
import { formatNumber, uniqueName } from '@shared/util';
import { api, errorMessage } from '../../api/client';
import { errorDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, Field, IconButton, NumberInput, RadioGroup, Section, Select, Spinner, TextInput } from '../../components/ui/controls';
import { DataGrid } from '../../components/grid/DataGrid';
import type { GridColumnDef } from '../../components/grid/cellFormat';
import { TaskPanel } from '../../components/TaskPanel';
import { pickOpenFiles } from '../../lib/files';
import type { TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { baseOf, DelimiterInput, FIELD_DELIMITERS, Hint, ProfileButtons, QUALIFIERS, useDatabases, useTaskDone, withMeta, Wizard } from './common';

interface FileEntry {
  file: string;
  /** Excel: all sheets (null = not loaded yet) */
  sheets: string[] | null;
  /** Excel: selected sheets */
  selected: string[];
}

interface Target {
  table: string;
  newTable: boolean;
  fields: ImportFieldMap[];
  /** signature of the source fields / table the mapping was made for */
  mappedFor: string;
}

interface PreviewState {
  loading: boolean;
  data?: ImportPreview;
  error?: string;
  /** options signature of the data */
  sig: string;
}

const FORMATS: { id: ImportFormat; icon: ReactNode; name: string; desc: () => string }[] = [
  { id: 'csv', icon: <FileText size={20} />, name: 'CSV', desc: () => tr('Kommagetrennte Werte (.csv)', 'Comma separated values (.csv)') },
  { id: 'txt', icon: <FileText size={20} />, name: 'TXT', desc: () => tr('Textdatei mit Trennzeichen (Tabulator, | …)', 'Delimited text file (tab, | …)') },
  { id: 'json', icon: <Braces size={20} />, name: 'JSON', desc: () => tr('Array von Objekten oder JSON Lines', 'Array of objects or JSON Lines') },
  { id: 'xml', icon: <Code size={20} />, name: 'XML', desc: () => tr('Wiederholtes Element als Datensatz', 'Repeated element as record') },
  { id: 'xlsx', icon: <FileSpreadsheet size={20} />, name: 'Excel', desc: () => tr('Excel-Arbeitsmappe (.xlsx)', 'Excel workbook (.xlsx)') }
];

const MODES: { value: ImportMode; label: () => string; desc: () => string; key: boolean }[] = [
  { value: 'append', key: false, label: () => tr('Anfügen', 'Append'), desc: () => tr('Datensätze an die Zieltabelle anfügen', 'Add the records to the target table') },
  { value: 'update', key: true, label: () => tr('Aktualisieren', 'Update'), desc: () => tr('Vorhandene Datensätze mit gleichem Schlüssel aktualisieren', 'Update existing records with the same key') },
  { value: 'appendUpdate', key: true, label: () => tr('Anfügen/Aktualisieren', 'Append/Update'), desc: () => tr('Vorhandene aktualisieren, neue anfügen', 'Update existing records, append new ones') },
  { value: 'appendNoUpdate', key: true, label: () => tr('Anfügen ohne Aktualisierung', 'Append without update'), desc: () => tr('Nur Datensätze anfügen, deren Schlüssel noch nicht vorhanden ist', 'Only append records whose key does not exist yet') },
  { value: 'delete', key: true, label: () => tr('Löschen', 'Delete'), desc: () => tr('Datensätze der Zieltabelle mit gleichem Schlüssel löschen', 'Delete records of the target table with the same key') },
  { value: 'copy', key: false, label: () => tr('Kopieren', 'Copy'), desc: () => tr('Zieltabelle leeren und alle Datensätze anfügen', 'Empty the target table and append all records') }
];

const TYPES = ['INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'DECIMAL', 'DOUBLE', 'FLOAT', 'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR', 'BIT', 'JSON', 'BLOB', 'LONGBLOB', 'VARBINARY', 'ENUM', 'SET'];

const LW = 170;

const sourceKey = (file: string, sheet: string | null) => (sheet === null ? file : `${file}\u0000${sheet}`);

function isGenerated(c: ColumnMeta): boolean {
  return !!c.generationExpression || /(VIRTUAL|STORED) GENERATED/i.test(c.extra);
}

export default function ImportTab({ tab }: TabProps) {
  const params = tab.params as { connectionId: string; database: string | null; table: string | null };
  const cid = params.connectionId;
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [format, setFormat] = useState<ImportFormat>('csv');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [encoding, setEncoding] = useState('auto');
  const [o, setO] = useState<ImportParseOptions>(() => defaultImportOptions('csv'));
  const [database, setDatabase] = useState(params.database ?? '');
  const [tables, setTables] = useState<string[] | null>(null);
  const [columns, setColumns] = useState<Record<string, ColumnMeta[]>>({});
  const [targets, setTargets] = useState<Record<string, Target>>({});
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [xmlTags, setXmlTags] = useState<XmlElementInfo[] | null>(null);
  const [mode, setMode] = useState<ImportMode>('append');
  const [adv, setAdv] = useState<ImportAdvancedOptions>(defaultImportAdvanced);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const databases = useDatabases(cid);
  const set = (patch: Partial<ImportParseOptions>) => setO((x) => ({ ...x, ...patch }));

  // sources = files (Excel: selected sheets)
  const sources = useMemo(
    () =>
      files.flatMap((f) =>
        format === 'xlsx' ? f.selected.map((sheet) => ({ key: sourceKey(f.file, sheet), file: f.file, sheet })) : [{ key: sourceKey(f.file, null), file: f.file, sheet: null as string | null }]
      ),
    [files, format]
  );
  const label = (s: { file: string; sheet: string | null }) => (s.sheet ? `${baseOf(s.file)} [${s.sheet}]` : baseOf(s.file));

  useEffect(() => {
    if (!current || !sources.some((s) => s.key === current)) setCurrent(sources[0]?.key ?? null);
  }, [sources, current]);

  // tables of the target database
  useEffect(() => {
    if (!database) {
      setTables([]);
      return;
    }
    let cancelled = false;
    setTables(null);
    void withMeta(cid, (sid) => api.meta.tables(sid, database))
      .then((l) => !cancelled && setTables(l.map((t) => t.name)))
      .catch((e) => {
        if (cancelled) return;
        setTables([]);
        void errorDialog(e);
      });
    return () => {
      cancelled = true;
    };
  }, [cid, database]);

  const loadColumns = async (table: string): Promise<ColumnMeta[]> => {
    const key = `${database}\u0000${table}`;
    if (columns[key]) return columns[key];
    const cols = await withMeta(cid, (sid) => api.meta.columns(sid, database, table));
    setColumns((c) => ({ ...c, [key]: cols }));
    return cols;
  };
  const colsOf = (table: string) => columns[`${database}\u0000${table}`];

  // Excel sheets
  useEffect(() => {
    if (format !== 'xlsx') return;
    for (const f of files) {
      if (f.sheets) continue;
      void api.io
        .xlsxSheets(f.file)
        .then((sheets) => setFiles((list) => list.map((x) => (x.file === f.file ? { ...x, sheets, selected: x.selected.length ? x.selected.filter((s) => sheets.includes(s)) : sheets.slice(0, 1) } : x))))
        .catch((e) => {
          setFiles((list) => list.map((x) => (x.file === f.file ? { ...x, sheets: [], selected: [] } : x)));
          void errorDialog(e);
        });
    }
  }, [files, format]);

  // XML elements of the first file
  const firstFile = files[0]?.file ?? null;
  useEffect(() => {
    setXmlTags(null);
    if (format !== 'xml' || !firstFile) return;
    let cancelled = false;
    void api.io
      .xmlElements(firstFile, encoding)
      .then((list) => {
        if (cancelled) return;
        setXmlTags(list);
        setO((x) => (x.xmlRowTag && list.some((e) => e.name === x.xmlRowTag) ? x : { ...x, xmlRowTag: guessRowTag(list) }));
      })
      .catch((e) => {
        if (!cancelled) {
          setXmlTags([]);
          void errorDialog(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [format, firstFile, encoding]);

  // previews
  const optionsSig = JSON.stringify([format, encoding, o]);
  const requested = useRef<Record<string, string>>({});
  const loadPreview = (key: string, force = false): Promise<ImportPreview | null> => {
    const src = sources.find((s) => s.key === key);
    if (!src) return Promise.resolve(null);
    const have = previews[key];
    if (!force && have?.sig === optionsSig && have.data) return Promise.resolve(have.data);
    if (format === 'xml' && !o.xmlRowTag) return Promise.resolve(null);
    requested.current[key] = optionsSig;
    setPreviews((p) => ({ ...p, [key]: { ...p[key], loading: true, sig: optionsSig } }));
    return api.io
      .previewImport({ format, file: src.file, sheet: src.sheet, encoding, options: o, limit: 100 })
      .then((data) => {
        if (requested.current[key] === optionsSig) setPreviews((p) => ({ ...p, [key]: { loading: false, data, sig: optionsSig } }));
        return data;
      })
      .catch((e) => {
        if (requested.current[key] === optionsSig) setPreviews((p) => ({ ...p, [key]: { loading: false, error: errorMessage(e), sig: optionsSig } }));
        return null;
      });
  };
  useEffect(() => {
    if (step !== 2 || !current) return;
    const t = window.setTimeout(() => void loadPreview(current), 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, current, optionsSig]);

  // default targets for new sources
  useEffect(() => {
    setTargets((t) => {
      const next = { ...t };
      let changed = false;
      const used = new Set<string>();
      for (const s of sources) {
        if (next[s.key]) continue;
        changed = true;
        if (params.table && database === params.database) {
          next[s.key] = { table: params.table, newTable: false, fields: [], mappedFor: '' };
        } else {
          const base = sanitizeName(s.sheet && sources.filter((x) => x.file === s.file).length > 1 ? `${baseOf(s.file)}_${s.sheet}` : baseOf(s.file));
          const existing = (tables ?? []).find((x) => x.toLowerCase() === base.toLowerCase());
          const name = existing ?? uniqueName(base, used);
          used.add(name);
          next[s.key] = { table: name, newTable: !existing, fields: [], mappedFor: '' };
        }
      }
      return changed ? next : t;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, tables]);

  const running = useTaskDone(taskId, (status, res) => {
    if (status === 'done') setResult(res as ImportResult);
    if (database) void useWorkspace.getState().refreshDatabase(cid, database, ['tables']);
  });

  const setTarget = (key: string, patch: Partial<Target>) => setTargets((t) => ({ ...t, [key]: { ...t[key], ...patch } }));

  /** Builds or refreshes the field mapping of every source (called when entering the mapping step) */
  const prepareMapping = async (): Promise<boolean> => {
    for (const s of sources) {
      const tg = targets[s.key];
      if (!tg) continue;
      const pv = await loadPreview(s.key);
      if (!pv) {
        void errorDialog(new Error(tr('Die Datei „{f}“ konnte nicht gelesen werden: {m}', 'The file "{f}" could not be read: {m}', { f: label(s), m: previews[s.key]?.error ?? '' })));
        return false;
      }
      const sig = JSON.stringify([tg.table, tg.newTable, pv.fields]);
      if (tg.mappedFor === sig && tg.fields.length) continue;
      if (tg.mappedFor === 'profile' && tg.fields.length) {
        // mapping loaded from a profile is kept as long as the source fields still exist
        if (tg.fields.every((f) => pv.fields.includes(f.source))) {
          setTarget(s.key, { mappedFor: sig });
          if (!tg.newTable) await loadColumns(tg.table).catch(() => undefined);
          continue;
        }
      }
      setTarget(s.key, { fields: await autoMap(pv, tg), mappedFor: sig });
    }
    return true;
  };

  const autoMap = async (pv: ImportPreview, tg: Target): Promise<ImportFieldMap[]> => {
    if (tg.newTable) {
      const used: string[] = [];
      return pv.fields.map((f, i) => {
        const name = uniqueName(sanitizeName(f, `F${i + 1}`), used);
        used.push(name);
        return { source: f, target: name, key: false, ...pv.types[i] };
      });
    }
    const cols = (await loadColumns(tg.table).catch(() => [])).filter((c) => !isGenerated(c));
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
    const taken = new Set<string>();
    return pv.fields.map((f, i) => {
      const col = cols.find((c) => c.name.toLowerCase() === f.toLowerCase() && !taken.has(c.name)) ?? cols.find((c) => norm(c.name) === norm(f) && !taken.has(c.name));
      if (col) taken.add(col.name);
      return { source: f, target: col?.name ?? '', key: col?.key === 'PRI', ...pv.types[i] };
    });
  };

  const profile = (): ImportProfile => ({
    version: 1,
    connectionId: cid,
    database,
    format,
    encoding,
    options: o,
    sources: sources.map((s) => {
      const tg = targets[s.key] ?? { table: '', newTable: false, fields: [], mappedFor: '' };
      return { file: s.file, sheet: s.sheet, table: tg.table.trim(), newTable: tg.newTable, fields: tg.fields };
    }),
    mode,
    advanced: adv
  });

  const changeFormat = (f: ImportFormat) => {
    if (f === format) return;
    setFormat(f);
    setO(defaultImportOptions(f));
    setFiles([]);
    setTargets({});
    setPreviews({});
    setMaxStep(0);
  };

  const addFiles = async () => {
    const picked = await pickOpenFiles({
      title: tr('Quelldateien auswählen', 'Choose source files'),
      filters: [
        { name: FORMATS.find((x) => x.id === format)!.name, extensions: importExtensions(format) },
        { name: tr('Alle Dateien', 'All files'), extensions: ['*'] }
      ]
    });
    if (picked?.length) setFiles((l) => [...l, ...picked.filter((p) => !l.some((x) => x.file === p)).map((file) => ({ file, sheets: null, selected: [] }))]);
  };

  const hasKeys = sources.every((s) => (targets[s.key]?.fields ?? []).some((f) => f.target && f.key));
  const modeNeedsKey = MODES.find((m) => m.value === mode)!.key;

  const validate = (i: number): string | null => {
    if (i === 1) {
      if (!sources.length) return format === 'xlsx' && files.length ? tr('Bitte mindestens ein Arbeitsblatt auswählen.', 'Please select at least one worksheet.') : tr('Bitte mindestens eine Datei hinzufügen.', 'Please add at least one file.');
    }
    if (i === 2 && format === 'xml' && !o.xmlRowTag.trim()) return tr('Bitte das Datensatz-Element angeben.', 'Please specify the record element.');
    if (i === 3) {
      if (!database) return tr('Bitte eine Zieldatenbank wählen.', 'Please choose a target database.');
      for (const s of sources) {
        const tg = targets[s.key];
        if (!tg?.table.trim()) return tr('Bitte für „{s}“ eine Zieltabelle angeben.', 'Please specify a target table for "{s}".', { s: label(s) });
        if (!tg.newTable && tables && !tables.some((t) => t === tg.table)) return tr('Die Tabelle „{t}“ existiert nicht.', 'Table "{t}" does not exist.', { t: tg.table });
      }
    }
    if (i === 4) {
      for (const s of sources) {
        const f = (targets[s.key]?.fields ?? []).filter((x) => x.target.trim());
        if (!f.length) return tr('Für „{s}“ ist kein Feld zugeordnet.', 'No field is mapped for "{s}".', { s: label(s) });
        const names = f.map((x) => x.target.trim().toLowerCase());
        const dup = names.find((n, k) => names.indexOf(n) !== k);
        if (dup) return tr('Das Zielfeld „{f}“ ist in „{s}“ mehrfach zugeordnet.', 'Target field "{f}" is mapped more than once in "{s}".', { f: dup, s: label(s) });
      }
    }
    return null;
  };

  const goto = async (i: number) => {
    if (i > step) {
      for (let k = step; k < i; k++) {
        const err = validate(k);
        if (err) {
          void errorDialog(new Error(err));
          return;
        }
        if (k === 3 && !(await prepareMapping())) return;
      }
    } else if (i === 4 && !(await prepareMapping())) return;
    setStep(i);
    setMaxStep((m) => Math.max(m, i));
  };

  const start = async () => {
    for (const k of [1, 2, 3, 4]) {
      const err = validate(k);
      if (err) {
        void errorDialog(new Error(err));
        return;
      }
    }
    if (modeNeedsKey && !hasKeys) {
      void errorDialog(new Error(tr('Der gewählte Importmodus benötigt in jeder Quelle mindestens ein Schlüsselfeld (Schritt „Felder“).', 'The chosen import mode needs at least one key field in every source (step "Fields").')));
      return;
    }
    try {
      setResult(null);
      setTaskId(await api.io.startImport(profile()));
    } catch (e) {
      void errorDialog(e);
    }
  };

  const steps = [
    { id: 'format', label: tr('Format', 'Format') },
    { id: 'files', label: tr('Dateien', 'Files') },
    { id: 'options', label: tr('Formatoptionen', 'Format options') },
    { id: 'target', label: tr('Zieltabellen', 'Target tables') },
    { id: 'fields', label: tr('Felder', 'Fields') },
    { id: 'mode', label: tr('Importmodus', 'Import mode') },
    { id: 'run', label: tr('Ausführen', 'Run') }
  ];

  const sourcePicker = (
    <Select
      style={{ width: 320 }}
      value={current ?? ''}
      onChange={setCurrent}
      options={sources.map((s) => ({ value: s.key, label: label(s) }))}
    />
  );

  return (
    <Wizard
      steps={steps}
      step={step}
      onStep={(i) => void goto(i)}
      maxStep={maxStep}
      canNext={!(step === 1 && !sources.length)}
      onNext={async () => {
        await goto(step + 1);
        return false;
      }}
      running={running}
      onStart={() => void start()}
      startDisabled={!sources.length}
      footerLeft={
        <ProfileButtons<ImportProfile>
          kind="import"
          disabled={running}
          current={profile}
          onLoad={(p) => {
            const fmt = p.format ?? 'csv';
            setFormat(fmt);
            setO({ ...defaultImportOptions(fmt), ...(p.options ?? {}) });
            setEncoding(p.encoding || 'auto');
            if (p.database) setDatabase(p.database);
            setMode(p.mode ?? 'append');
            setAdv({ ...defaultImportAdvanced(), ...(p.advanced ?? {}) });
            const srcs = p.sources ?? [];
            const byFile = new Map<string, FileEntry>();
            for (const s of srcs) {
              const e = byFile.get(s.file) ?? { file: s.file, sheets: null, selected: [] };
              if (s.sheet) e.selected.push(s.sheet);
              byFile.set(s.file, e);
            }
            setFiles([...byFile.values()]);
            setPreviews({});
            setTargets(
              Object.fromEntries(
                srcs.map((s) => [sourceKey(s.file, fmt === 'xlsx' ? s.sheet : null), { table: s.table, newTable: s.newTable, fields: s.fields ?? [], mappedFor: 'profile' }])
              )
            );
            setMaxStep(6);
          }}
        />
      }
    >
      {step === 0 && (
        <>
          <h3 className="ks-io-title">{tr('Dateiformat wählen', 'Choose the file format')}</h3>
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
                  setStep(1);
                  setMaxStep((m) => Math.max(m, 1));
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
          {format !== 'xlsx' && (
            <Field label={tr('Zeichenkodierung', 'Encoding')} labelWidth={LW}>
              <Select style={{ maxWidth: 320 }} value={encoding} onChange={(v) => { setEncoding(v); setPreviews({}); }} options={encodingOptions('read')} />
            </Field>
          )}
          <div className="ks-io-box ks-io-grow">
            <div className="ks-io-box-head">
              <strong>{tr('Quelldateien', 'Source files')}</strong>
              <div className="spacer" />
              <Button size="sm" icon={<FilePlus size={13} />} onClick={() => void addFiles()}>
                {tr('Dateien hinzufügen …', 'Add files …')}
              </Button>
            </div>
            <div className="ks-io-box-body">
              {!files.length && <div className="ks-io-preview-msg">{tr('Noch keine Dateien ausgewählt.', 'No files selected yet.')}</div>}
              {files.map((f) => (
                <div key={f.file}>
                  <div className="ks-io-list-item" title={f.file}>
                    <FileText size={14} className="faint" />
                    <span className="ellipsis">{f.file}</span>
                    <IconButton
                      icon={<X size={14} />}
                      title={tr('Entfernen', 'Remove')}
                      onClick={() => {
                        setFiles((l) => l.filter((x) => x.file !== f.file));
                        setPreviews({});
                      }}
                    />
                  </div>
                  {format === 'xlsx' &&
                    (f.sheets === null ? (
                      <div className="ks-io-list-item" style={{ paddingLeft: 34 }}>
                        <Spinner size={12} />
                      </div>
                    ) : (
                      f.sheets.map((sh) => (
                        <div key={sh} className="ks-io-list-item" style={{ paddingLeft: 34 }}>
                          <Checkbox
                            checked={f.selected.includes(sh)}
                            onChange={(on) =>
                              setFiles((l) => l.map((x) => (x.file === f.file ? { ...x, selected: on ? f.sheets!.filter((n) => n === sh || x.selected.includes(n)) : x.selected.filter((n) => n !== sh) } : x)))
                            }
                            label={
                              <span className="row" style={{ gap: 6 }}>
                                <FileSpreadsheet size={13} className="faint" />
                                {sh}
                              </span>
                            }
                          />
                        </div>
                      ))
                    ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="ks-io-form">
            {(format === 'csv' || format === 'txt') && (
              <Section title={tr('Trennzeichen', 'Delimiters')}>
                <Field label={tr('Datensatz-Trennzeichen', 'Record delimiter')} labelWidth={LW}>
                  <Select
                    value={o.recordDelimiter}
                    onChange={(recordDelimiter) => set({ recordDelimiter })}
                    options={[
                      { value: 'auto', label: tr('Automatisch (CRLF, LF, CR)', 'Automatic (CRLF, LF, CR)') },
                      { value: 'crlf', label: 'CRLF' },
                      { value: 'lf', label: 'LF' },
                      { value: 'cr', label: 'CR' }
                    ]}
                  />
                </Field>
                <Field label={tr('Feld-Trennzeichen', 'Field delimiter')} labelWidth={LW}>
                  <DelimiterInput value={o.fieldDelimiter} onChange={(fieldDelimiter) => set({ fieldDelimiter })} presets={FIELD_DELIMITERS()} />
                </Field>
                <Field label={tr('Textbegrenzer', 'Text qualifier')} labelWidth={LW}>
                  <Select value={o.textQualifier} onChange={(textQualifier) => set({ textQualifier })} options={QUALIFIERS()} />
                </Field>
                <Field label={tr('Escape-Zeichen', 'Escape character')} labelWidth={LW} hint={tr('Leer = keines (z. B. \\ für \\n, \\t, \\N)', 'Empty = none (e.g. \\ for \\n, \\t, \\N)')}>
                  <TextInput className="ks-io-short" maxLength={1} value={o.escapeChar} onChange={(e) => set({ escapeChar: e.target.value })} />
                </Field>
              </Section>
            )}
            {format === 'xml' && (
              <Section title="XML">
                <Field label={tr('Datensatz-Element', 'Record element')} labelWidth={LW}>
                  <TextInput list="ks-io-xml-tags" value={o.xmlRowTag} onChange={(e) => set({ xmlRowTag: e.target.value })} />
                  <datalist id="ks-io-xml-tags">
                    {(xmlTags ?? []).map((t) => (
                      <option key={t.name} value={t.name}>
                        {tr('{n}× (Ebene {d})', '{n}× (level {d})', { n: t.count, d: t.depth })}
                      </option>
                    ))}
                  </datalist>
                </Field>
                <Checkbox checked={o.xmlAttributes} onChange={(xmlAttributes) => set({ xmlAttributes })} label={tr('Attribute als Felder übernehmen', 'Use attributes as fields')} />
              </Section>
            )}
            {(format === 'csv' || format === 'txt' || format === 'xlsx') && (
              <Section title={tr('Zeilen', 'Rows')}>
                <Field label={tr('Feldnamen-Zeile', 'Field name row')} labelWidth={LW} hint={tr('0 = keine Feldnamen (F1, F2 …)', '0 = no field names (F1, F2 …)')}>
                  <NumberInput className="ks-io-short" min={0} value={o.headerRow} onChange={(v) => set({ headerRow: v === '' ? 0 : v })} />
                </Field>
                <Field label={tr('Erste Datenzeile', 'First data row')} labelWidth={LW} hint={tr('0 = direkt nach der Feldnamen-Zeile', '0 = right after the field name row')}>
                  <NumberInput className="ks-io-short" min={0} value={o.firstDataRow} onChange={(v) => set({ firstDataRow: v === '' ? 0 : v })} />
                </Field>
                <Field label={tr('Letzte Datenzeile', 'Last data row')} labelWidth={LW} hint={tr('0 = bis zum Ende', '0 = up to the end')}>
                  <NumberInput className="ks-io-short" min={0} value={o.lastDataRow} onChange={(v) => set({ lastDataRow: v === '' ? 0 : v })} />
                </Field>
              </Section>
            )}
            <Section title={tr('Werte', 'Values')}>
              <Field label={tr('Datumsreihenfolge', 'Date order')} labelWidth={LW}>
                <div className="ks-io-inline">
                  <Select className="ks-io-short" value={o.dateOrder} onChange={(dateOrder) => set({ dateOrder })} options={['YMD', 'DMY', 'MDY', 'YDM', 'DYM', 'MYD']} />
                  <span className="muted">{tr('Trennzeichen', 'Separator')}</span>
                  <TextInput className="ks-io-short" style={{ width: 50 }} maxLength={2} value={o.dateSeparator} onChange={(e) => set({ dateSeparator: e.target.value })} />
                </div>
              </Field>
              <Field label={tr('Zeit-Trennzeichen', 'Time separator')} labelWidth={LW}>
                <TextInput className="ks-io-short" maxLength={2} value={o.timeSeparator} onChange={(e) => set({ timeSeparator: e.target.value })} />
              </Field>
              <Field label={tr('Dezimaltrennzeichen', 'Decimal symbol')} labelWidth={LW}>
                <Select className="ks-io-medium" value={o.decimalSymbol} onChange={(decimalSymbol) => set({ decimalSymbol })} options={[{ value: '.', label: tr('Punkt (.)', 'Point (.)') }, { value: ',', label: tr('Komma (,)', 'Comma (,)') }]} />
              </Field>
              <Field label={tr('Binärdaten', 'Binary data')} labelWidth={LW}>
                <Select
                  className="ks-io-medium"
                  value={o.binaryEncoding}
                  onChange={(binaryEncoding) => set({ binaryEncoding })}
                  options={[
                    { value: 'base64', label: 'Base64' },
                    { value: 'hex', label: tr('Hexadezimal', 'Hexadecimal') },
                    { value: 'none', label: tr('Text (UTF-8)', 'Text (UTF-8)') }
                  ]}
                />
              </Field>
              {(format === 'csv' || format === 'txt') && (
                <Field label={tr('NULL-Darstellung', 'NULL text')} labelWidth={LW} hint={tr('Unbegrenzter Wert, der als NULL gilt, z. B. NULL oder \\N', 'Unquoted value treated as NULL, e.g. NULL or \\N')}>
                  <TextInput className="ks-io-medium" value={o.nullText} onChange={(e) => set({ nullText: e.target.value })} />
                </Field>
              )}
              <Checkbox checked={o.emptyAsNull} onChange={(emptyAsNull) => set({ emptyAsNull })} label={tr('Leere Zeichenketten als NULL importieren', 'Import empty strings as NULL')} />
              <Checkbox checked={o.trim} onChange={(trim) => set({ trim })} label={tr('Leerzeichen am Anfang und Ende entfernen', 'Trim leading and trailing spaces')} />
            </Section>
          </div>
          <div className="row">
            <strong>{tr('Vorschau', 'Preview')}</strong>
            {sources.length > 1 && sourcePicker}
            {current && previews[current]?.loading && <Spinner size={14} />}
            {current && previews[current]?.data && (
              <span className="muted">
                {tr('{f} Felder, {n} Datensätze gelesen{m}', '{f} fields, {n} records read{m}', {
                  f: previews[current]!.data!.fields.length,
                  n: formatNumber(previews[current]!.data!.scanned),
                  m: previews[current]!.data!.more ? tr(' (Ausschnitt)', ' (excerpt)') : ''
                })}
              </span>
            )}
          </div>
          <PreviewGrid state={current ? previews[current] : undefined} empty={format === 'xml' && !o.xmlRowTag ? tr('Bitte das Datensatz-Element angeben.', 'Please specify the record element.') : undefined} />
        </>
      )}

      {step === 3 && (
        <>
          {!params.database && (
            <Field label={tr('Zieldatenbank', 'Target database')} labelWidth={LW}>
              <Select
                style={{ maxWidth: 320 }}
                value={database}
                onChange={(d) => {
                  setDatabase(d);
                  setTargets({});
                }}
                options={[{ value: '', label: tr('(bitte wählen)', '(please choose)') }, ...databases.map((d) => ({ value: d, label: d }))]}
              />
            </Field>
          )}
          <div className="ks-io-box ks-io-grow">
            <div className="ks-io-box-head">
              <strong>{tr('Zieltabellen in {d}', 'Target tables in {d}', { d: database || '…' })}</strong>
              {tables === null && <Spinner size={13} />}
            </div>
            <div className="ks-io-box-body">
              <datalist id="ks-io-tables">
                {(tables ?? []).map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <table className="ks-table ks-io-table">
                <thead>
                  <tr>
                    <th>{tr('Quelle', 'Source')}</th>
                    <th style={{ width: 150 }}>{tr('Ziel', 'Target')}</th>
                    <th style={{ width: '40%' }}>{tr('Tabelle', 'Table')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => {
                    const tg = targets[s.key];
                    if (!tg) return null;
                    const exists = (tables ?? []).includes(tg.table);
                    return (
                      <tr key={s.key}>
                        <td title={s.file}>{label(s)}</td>
                        <td>
                          <Select
                            value={tg.newTable ? 'new' : 'existing'}
                            onChange={(v) => setTarget(s.key, { newTable: v === 'new', table: v === 'existing' && !exists ? (tables?.[0] ?? '') : tg.table })}
                            options={[
                              { value: 'existing', label: tr('Vorhandene Tabelle', 'Existing table') },
                              { value: 'new', label: tr('Neue Tabelle', 'New table') }
                            ]}
                          />
                        </td>
                        <td>
                          {tg.newTable ? (
                            <div className="row">
                              <TextInput value={tg.table} onChange={(e) => setTarget(s.key, { table: e.target.value })} />
                              {exists && <span className="ks-badge warning">{tr('existiert', 'exists')}</span>}
                            </div>
                          ) : (
                            <Select value={tg.table} onChange={(table) => setTarget(s.key, { table })} options={[...(exists ? [] : [{ value: tg.table, label: tg.table || tr('(bitte wählen)', '(please choose)') }]), ...(tables ?? []).map((t) => ({ value: t, label: t }))]} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {step === 4 && current && targets[current] && (
        <>
          <div className="row">
            {sources.length > 1 && sourcePicker}
            <span className="muted">
              → {targets[current].table} {targets[current].newTable ? tr('(neue Tabelle)', '(new table)') : ''}
            </span>
            <div className="spacer" />
            <Button
              size="sm"
              icon={<Wand2 size={13} />}
              onClick={() => {
                const pv = previews[current]?.data;
                const tg = targets[current];
                if (pv) void autoMap(pv, tg).then((fields) => setTarget(current, { fields }));
              }}
            >
              {tr('Automatisch zuordnen', 'Auto map')}
            </Button>
            <Button size="sm" onClick={() => setTarget(current, { fields: targets[current].fields.map((f) => ({ ...f, target: '', key: false })) })}>
              {tr('Zuordnung aufheben', 'Unmap all')}
            </Button>
          </div>
          <MappingTable
            target={targets[current]}
            columns={targets[current].newTable ? null : (colsOf(targets[current].table) ?? [])}
            onChange={(fields) => setTarget(current, { fields })}
          />
        </>
      )}

      {step === 5 && (
        <div className="ks-io-form">
          <Section title={tr('Importmodus', 'Import mode')}>
            <RadioGroup
              value={mode}
              onChange={setMode}
              options={MODES.map((m) => ({
                value: m.value,
                label: (
                  <span>
                    <strong>{m.label()}</strong> <span className="muted">– {m.desc()}</span>
                  </span>
                )
              }))}
            />
            {modeNeedsKey && !hasKeys && (
              <Hint>{tr('Dieser Modus benötigt Schlüsselfelder. Markieren Sie im Schritt „Felder“ die Spalte „Schlüssel“.', 'This mode needs key fields. Tick the "Key" column in the "Fields" step.')}</Hint>
            )}
            {mode === 'copy' && <Hint>{tr('Alle vorhandenen Datensätze der Zieltabellen werden gelöscht.', 'All existing records of the target tables are deleted.')}</Hint>}
          </Section>
          <Section title={tr('Erweitert', 'Advanced')}>
            <Field label={tr('Datensätze je INSERT', 'Records per INSERT')} labelWidth={LW}>
              <NumberInput className="ks-io-short" min={1} value={adv.rowsPerStatement} onChange={(v) => setAdv((a) => ({ ...a, rowsPerStatement: v === '' ? 1 : v }))} />
            </Field>
            <Field label={tr('Max. Anweisungsgröße (KB)', 'Max. statement size (KB)')} labelWidth={LW}>
              <NumberInput className="ks-io-short" min={16} value={adv.maxStatementKB} onChange={(v) => setAdv((a) => ({ ...a, maxStatementKB: v === '' ? 1024 : v }))} />
            </Field>
            <Checkbox checked={adv.transaction} onChange={(transaction) => setAdv((a) => ({ ...a, transaction }))} label={tr('In einer Transaktion importieren (bei Abbruch zurücksetzen)', 'Import in one transaction (roll back on abort)')} />
            <Checkbox checked={adv.continueOnError} onChange={(continueOnError) => setAdv((a) => ({ ...a, continueOnError }))} label={tr('Bei Fehlern fortfahren (fehlerhafte Datensätze überspringen)', 'Continue on error (skip failing records)')} />
            <Checkbox checked={adv.disableFkChecks} onChange={(disableFkChecks) => setAdv((a) => ({ ...a, disableFkChecks }))} label={tr('Fremdschlüsselprüfung abschalten', 'Disable foreign key checks')} />
          </Section>
        </div>
      )}

      {step === 6 && (
        <div className="ks-io-run">
          <div className="ks-io-summary">
            <span>{tr('Format', 'Format')}</span>
            <span>{FORMATS.find((f) => f.id === format)?.name}</span>
            <span>{tr('Datenbank', 'Database')}</span>
            <span>{database}</span>
            <span>{tr('Modus', 'Mode')}</span>
            <span>{MODES.find((m) => m.value === mode)?.label()}</span>
            {sources.map((s) => (
              <FragmentRow key={s.key} a={label(s)} b={`→ ${targets[s.key]?.table ?? ''}${targets[s.key]?.newTable ? tr(' (neu)', ' (new)') : ''}`} />
            ))}
          </div>
          {taskId ? <TaskPanel taskId={taskId} /> : <div className="muted">{tr('Klicken Sie auf „Starten“, um den Import auszuführen.', 'Click "Start" to run the import.')}</div>}
          {result && (
            <div className="muted">
              {tr('{i} eingefügt, {u} aktualisiert, {d} gelöscht, {s} übersprungen, {e} Fehler', '{i} inserted, {u} updated, {d} deleted, {s} skipped, {e} errors', {
                i: formatNumber(result.inserted),
                u: formatNumber(result.updated),
                d: formatNumber(result.deleted),
                s: formatNumber(result.skipped),
                e: formatNumber(result.errors)
              })}
            </div>
          )}
        </div>
      )}
    </Wizard>
  );
}

function FragmentRow({ a, b }: { a: string; b: string }) {
  return (
    <>
      <span className="ellipsis">{a}</span>
      <span>{b}</span>
    </>
  );
}

function PreviewGrid({ state, empty }: { state: PreviewState | undefined; empty?: string }) {
  const data = state?.data;
  const cols: GridColumnDef[] = useMemo(
    () => (data?.fields ?? []).map((f, i) => ({ id: `${i}:${f}`, title: f, kind: 'text', typeLabel: data!.types[i]?.type ?? '', numeric: false })),
    [data]
  );
  return (
    <div className="ks-io-preview">
      <div className="ks-io-preview-body">
        {empty ? (
          <div className="ks-io-preview-msg">{empty}</div>
        ) : state?.error ? (
          <div className="ks-io-preview-msg error selectable">{state.error}</div>
        ) : !data ? (
          <div className="ks-io-preview-msg">{state?.loading ? <Spinner /> : null}</div>
        ) : (
          <DataGrid columns={cols} rowCount={data.rows.length} getValue={(r, c) => data.rows[r]?.[c] ?? null} empty={tr('Keine Datensätze', 'No records')} />
        )}
      </div>
    </div>
  );
}

function MappingTable({ target, columns, onChange }: { target: Target; columns: ColumnMeta[] | null; onChange: (f: ImportFieldMap[]) => void }) {
  const fields = target.fields;
  const update = (i: number, patch: Partial<ImportFieldMap>) => onChange(fields.map((f, k) => (k === i ? { ...f, ...patch } : f)));
  const colOptions = [{ value: '', label: tr('(nicht importieren)', '(do not import)') }, ...(columns ?? []).filter((c) => !isGenerated(c)).map((c) => ({ value: c.name, label: `${c.name}  ·  ${c.columnType}` }))];
  const usedTargets = fields.map((f) => f.target.toLowerCase()).filter(Boolean);
  return (
    <div className="ks-io-box ks-io-grow">
      <div className="ks-io-box-body">
        <table className="ks-table ks-io-table">
          <thead>
            <tr>
              <th>{tr('Quellfeld', 'Source field')}</th>
              <th style={{ width: columns ? '45%' : '28%' }}>{tr('Zielfeld', 'Target field')}</th>
              {!columns && (
                <>
                  <th style={{ width: 140 }}>{tr('Typ', 'Type')}</th>
                  <th style={{ width: 80 }}>{tr('Länge', 'Length')}</th>
                  <th style={{ width: 80 }}>{tr('Dezimalen', 'Decimals')}</th>
                </>
              )}
              <th className="center" style={{ width: 90 }}>
                {columns ? tr('Schlüssel', 'Key') : tr('Primärschlüssel', 'Primary key')}
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f, i) => {
              const dup = f.target && usedTargets.filter((t) => t === f.target.toLowerCase()).length > 1;
              return (
                <tr key={`${i}:${f.source}`} className={clsx(!f.target && 'muted')}>
                  <td title={f.source}>{f.source}</td>
                  <td>
                    {columns ? (
                      <Select className={clsx(dup && 'invalid')} value={f.target} onChange={(target) => update(i, { target, key: target ? f.key : false })} options={colOptions} />
                    ) : (
                      <TextInput invalid={!!dup} value={f.target} placeholder={tr('(nicht importieren)', '(do not import)')} onChange={(e) => update(i, { target: e.target.value })} />
                    )}
                  </td>
                  {!columns && (
                    <>
                      <td>
                        <Select value={TYPES.includes(f.type) ? f.type : 'VARCHAR'} disabled={!f.target} onChange={(type) => update(i, { type, length: type === 'VARCHAR' && !f.length ? '255' : f.length })} options={TYPES} />
                      </td>
                      <td>
                        <TextInput disabled={!f.target} value={f.length} onChange={(e) => update(i, { length: e.target.value.replace(/[^0-9]/g, '') })} />
                      </td>
                      <td>
                        <TextInput disabled={!f.target} value={f.decimals} onChange={(e) => update(i, { decimals: e.target.value.replace(/[^0-9]/g, '') })} />
                      </td>
                    </>
                  )}
                  <td className="center">
                    <Checkbox checked={f.key} disabled={!f.target} onChange={(key) => update(i, { key })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!fields.length && <div className="ks-io-preview-msg">{tr('Die Quelle enthält keine Felder.', 'The source has no fields.')}</div>}
      </div>
    </div>
  );
}

// View designer tab: SELECT definition, advanced view options, SQL preview and data preview.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { FileInput, ListTree, Play, RotateCw, Save, SaveAll, TriangleAlert, Wand, Workflow } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { StatementResult } from '@shared/types';
import { createViewSql, parseCreateView, stripStatementEnd, type ViewDef } from '@shared/sql/ddl';
import { api, errorMessage } from '../../api/client';
import { designView, openTable } from '../../actions/objects';
import { SqlEditor, type MonacoEditor } from '../../components/editor/SqlEditor';
import { beautifySql } from '../../components/editor/monaco';
import { toast } from '../../components/Toast';
import { Button, EmptyState, Field, RadioGroup, Section, Select, Spinner, TabStrip, TextInput, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { askDialog, errorDialog, promptDialog } from '../../components/ui/Dialog';
import { pickOpenFile } from '../../lib/files';
import type { TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { openQueryBuilder } from '../queryBuilder';
import { ResultsPanel } from '../tableDesign/common/ResultsPanel';
import { SqlPreview } from '../tableDesign/common/SqlPreview';
import { commitPendingEdits, execChecked, renameDesignerTab, useDesignerTab, useOwnSession } from '../tableDesign/common/useDesignerTab';
import '../tableDesign/common/designer.css';

type Section = 'definition' | 'advanced' | 'sql';

interface Params {
  connectionId: string;
  database: string;
  view: string | null;
}

const LW = 150;

function emptyView(db: string): ViewDef {
  return { schema: db, name: '', definition: 'SELECT\n  \nFROM ', algorithm: '', definer: '', security: '', checkOption: '', columns: [] };
}

function ColumnsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value]);
  return (
    <TextInput
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(text.split(',').map((s) => s.trim()).filter(Boolean))}
    />
  );
}

const keyOf = (v: ViewDef) => JSON.stringify({ ...v, definition: v.definition.trim() });

export default function ViewDesignTab({ tab, active }: TabProps) {
  const params = tab.params as unknown as Params;
  const cid = params.connectionId;
  const db = params.database;
  const session = useOwnSession(cid, db);
  const nameRef = useRef<string | null>(params.view);
  const [def, setDef] = useState<ViewDef | null>(null);
  const [baseline, setBaseline] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('definition');
  const [results, setResults] = useState<StatementResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<MonacoEditor | null>(null);
  const defRef = useRef(def);
  defRef.current = def;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      if (!nameRef.current) {
        const v = emptyView(db);
        setDef(v);
        setBaseline(keyOf(v));
        return;
      }
      const sid = await session();
      const ddl = await api.meta.ddl(sid, db, 'view', nameRef.current);
      const parsed = parseCreateView(ddl);
      if (!parsed) throw new Error(tr('Die Definition der Ansicht konnte nicht gelesen werden.', 'The view definition could not be read.'));
      const v: ViewDef = { ...parsed, schema: db, name: nameRef.current };
      setDef(v);
      setBaseline(keyOf(v));
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [db, session]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (patch: Partial<ViewDef>) => setDef((d) => (d ? { ...d, ...patch } : d));
  const dirty = !!def && keyOf(def) !== baseline;
  const isNew = !nameRef.current;

  const previewSql = useMemo(() => {
    if (!def) return [];
    const name = def.name || tr('neue_ansicht', 'new_view');
    return [createViewSql({ ...def, name }, { orReplace: !isNew })];
  }, [def, isNew]);

  const run = async (explain: boolean) => {
    const d = defRef.current;
    if (!d || running) return;
    const sql = stripStatementEnd(d.definition);
    if (!sql) return;
    setRunning(true);
    try {
      const sid = await session();
      const r = await api.query.execute(sid, explain ? `EXPLAIN ${sql}` : sql, { maxRows: 1000, noSplit: true, history: false });
      setResults(r.results);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setRunning(false);
    }
  };

  const askName = (title: string, value = '') =>
    promptDialog({
      title,
      label: tr('Name der Ansicht:', 'View name:'),
      value,
      validate: (v) => (v.trim() ? (v.trim().length > 64 ? tr('Maximal 64 Zeichen.', 'At most 64 characters.') : null) : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
    });

  const save = async (): Promise<boolean> => {
    await commitPendingEdits();
    const d = defRef.current;
    if (!d || busy) return false;
    if (!stripStatementEnd(d.definition)) {
      toast(tr('Die Definition ist leer.', 'The definition is empty.'), 'error');
      return false;
    }
    let name = nameRef.current ?? '';
    if (!name) {
      const n = await askName(tr('Ansicht speichern', 'Save view'));
      if (!n) return false;
      name = n.trim();
    } else if (!dirty) {
      toast(tr('Keine Änderungen', 'No changes'));
      return true;
    }
    setBusy(true);
    try {
      const sid = await session();
      await execChecked(sid, createViewSql({ ...d, name }, { orReplace: !!nameRef.current }));
      const wasNew = !nameRef.current;
      nameRef.current = name;
      await useWorkspace.getState().refreshDatabase(cid, db, ['views']);
      if (wasNew) renameDesignerTab(tab.id, `viewdesign:${cid}:${db}:${name}`, `${name} @${db} (${tr('Ansicht', 'View')})`, { view: name });
      await load();
      toast(tr('Ansicht „{n}“ gespeichert', 'View "{n}" saved', { n: name }), 'success');
      return true;
    } catch (e) {
      void errorDialog(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveAs = async () => {
    await commitPendingEdits();
    const d = defRef.current;
    if (!d || busy) return;
    const n = await askName(tr('Speichern unter', 'Save as'), d.name ? `${d.name}_copy` : '');
    if (!n) return;
    setBusy(true);
    try {
      const sid = await session();
      await execChecked(sid, createViewSql({ ...d, name: n.trim() }));
      await useWorkspace.getState().refreshDatabase(cid, db, ['views']);
      toast(tr('Ansicht „{n}“ erstellt', 'View "{n}" created', { n: n.trim() }), 'success');
      designView(cid, db, n.trim());
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  const builder = async () => {
    const d = defRef.current;
    if (!d) return;
    const sql = await openQueryBuilder({ connectionId: cid, database: db, sql: d.definition });
    if (sql !== null) set({ definition: sql });
  };

  const importFile = async () => {
    const file = await pickOpenFile({ title: tr('SQL-Datei laden', 'Load SQL file'), filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (!file) return;
    try {
      set({ definition: await api.fs.readText(file) });
    } catch (e) {
      void errorDialog(e);
    }
  };

  const reload = async () => {
    if (dirty) {
      const a = await askDialog({ title: tr('Neu laden', 'Reload'), message: tr('Ungespeicherte Änderungen verwerfen?', 'Discard unsaved changes?'), yesLabel: tr('Verwerfen', 'Discard'), noLabel: tr('Abbrechen', 'Cancel') });
      if (a !== 'yes') return;
    }
    await load();
  };

  useDesignerTab({
    tab,
    active,
    dirty,
    save,
    objectLabel: () => (nameRef.current ? tr('Ansicht „{n}“', 'view "{n}"', { n: nameRef.current }) : tr('die neue Ansicht', 'the new view')),
    shortcuts: {
      'Ctrl+R': () => void run(false),
      F9: () => void run(false),
      'Ctrl+E': () => setSection('definition'),
      'Ctrl+Shift+F': () => set({ definition: beautifySql(defRef.current?.definition ?? '') })
    }
  });

  if (loadError) {
    return (
      <div className="ks-dsg">
        <EmptyState icon={<TriangleAlert size={40} />} title={tr('Die Ansicht konnte nicht geladen werden', 'The view could not be loaded')}>
          <p className="selectable">{loadError}</p>
          <Button variant="primary" icon={<RotateCw size={14} />} onClick={() => void load()}>
            {tr('Erneut versuchen', 'Retry')}
          </Button>
        </EmptyState>
      </div>
    );
  }
  if (!def) {
    return (
      <div className="ks-dsg">
        <div className="ks-dsg-loading">
          <Spinner size={22} />
        </div>
      </div>
    );
  }

  const editor = (
    <div className="ks-dsg-editor">
      <SqlEditor
        value={def.definition}
        onChange={(definition) => set({ definition })}
        completion={{ connectionId: cid, database: db }}
        onMount={(ed) => (editorRef.current = ed)}
      />
    </div>
  );

  return (
    <div className="ks-dsg">
      <Toolbar>
        <ToolbarButton icon={busy ? <Spinner size={14} /> : <Save size={15} />} label={tr('Speichern', 'Save')} title={tr('Speichern (Strg+S)', 'Save (Ctrl+S)')} disabled={busy} onClick={() => void save()} />
        <ToolbarButton icon={<SaveAll size={15} />} label={tr('Speichern unter …', 'Save As …')} disabled={busy} onClick={() => void saveAs()} />
        <ToolbarSep />
        <ToolbarButton icon={running ? <Spinner size={14} /> : <Play size={15} />} label={tr('Vorschau', 'Preview')} title={tr('Daten anzeigen (Strg+R)', 'Preview data (Ctrl+R)')} disabled={running} onClick={() => void run(false)} />
        <ToolbarButton icon={<ListTree size={15} />} label={tr('Erklären', 'Explain')} disabled={running} onClick={() => void run(true)} />
        <ToolbarSep />
        <ToolbarButton icon={<Workflow size={15} />} label={tr('Ansichts-Generator', 'View Builder')} onClick={() => void builder()} />
        <ToolbarButton icon={<Wand size={15} />} label={tr('Formatieren', 'Beautify')} onClick={() => set({ definition: beautifySql(def.definition) })} />
        <ToolbarButton icon={<FileInput size={15} />} label={tr('SQL laden', 'Load SQL')} onClick={() => void importFile()} />
        <ToolbarSep />
        <ToolbarButton icon={<RotateCw size={15} />} label={tr('Neu laden', 'Reload')} disabled={isNew} onClick={() => void reload()} />
        {!isNew && <ToolbarButton label={tr('Ansicht öffnen', 'Open View')} onClick={() => openTable(cid, db, nameRef.current!, true)} />}
      </Toolbar>
      <TabStrip<Section>
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'definition', label: tr('Definition', 'Definition') },
          { id: 'advanced', label: tr('Erweitert', 'Advanced') },
          { id: 'sql', label: tr('SQL-Vorschau', 'SQL Preview') }
        ]}
      />
      <div className="ks-dsg-body">
        {section === 'definition' &&
          (results ? (
            <Group orientation="vertical" style={{ flex: 1, minHeight: 0 }}>
              <Panel id="editor" defaultSize="55%" minSize="80px">
                <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>{editor}</div>
              </Panel>
              <Separator className="ks-dsg-sep-v" />
              <Panel id="results" defaultSize="45%" minSize="80px">
                <ResultsPanel results={results} onClose={() => setResults(null)} />
              </Panel>
            </Group>
          ) : (
            editor
          ))}
        {section === 'advanced' && (
          <div className="ks-dsg-scroll">
            <div className="ks-dsg-form">
              <Section title={tr('Ansicht', 'View')}>
                <Field label={tr('Algorithmus', 'Algorithm')} labelWidth={LW}>
                  <Select<ViewDef['algorithm']>
                    style={{ width: 200 }}
                    value={def.algorithm}
                    onChange={(algorithm) => set({ algorithm })}
                    options={[{ value: '', label: tr('(nicht angegeben)', '(not specified)') }, 'UNDEFINED', 'MERGE', 'TEMPTABLE']}
                  />
                </Field>
                <Field label="Definer" labelWidth={LW} hint={tr('benutzer@host, leer = aktueller Benutzer', 'user@host, empty = current user')}>
                  <TextInput value={def.definer} placeholder="root@localhost" onChange={(e) => set({ definer: e.target.value })} />
                </Field>
                <Field label={tr('Sicherheit', 'Security')} labelWidth={LW}>
                  <Select<ViewDef['security']>
                    style={{ width: 200 }}
                    value={def.security}
                    onChange={(security) => set({ security })}
                    options={[{ value: '', label: tr('(nicht angegeben)', '(not specified)') }, 'DEFINER', 'INVOKER']}
                  />
                </Field>
                <Field label={tr('Prüfoption', 'Check option')} labelWidth={LW}>
                  <RadioGroup<ViewDef['checkOption']>
                    inline
                    value={def.checkOption}
                    onChange={(checkOption) => set({ checkOption })}
                    options={[
                      { value: '', label: tr('Keine', 'None') },
                      { value: 'CASCADED', label: 'CASCADED' },
                      { value: 'LOCAL', label: 'LOCAL' }
                    ]}
                  />
                </Field>
                <Field label={tr('Spaltennamen', 'Column names')} labelWidth={LW} hint={tr('Optional, kommagetrennt', 'Optional, comma separated')}>
                  <ColumnsInput value={def.columns} onChange={(columns) => set({ columns })} />
                </Field>
              </Section>
            </div>
          </div>
        )}
        {section === 'sql' && <SqlPreview statements={previewSql} />}
      </div>
      <div className="ks-statusline">
        <span>
          {nameRef.current ?? tr('Neue Ansicht', 'New view')} @{db}
        </span>
        {dirty && <span className="ks-dsg-status-dirty">{tr('Geändert', 'Modified')}</span>}
        {results && <span>{tr('{n} Datensätze in der Vorschau (max. 1000)', '{n} records in preview (max. 1000)', { n: results.find((r) => r.kind === 'resultset')?.rows?.length ?? 0 })}</span>}
      </div>
    </div>
  );
}

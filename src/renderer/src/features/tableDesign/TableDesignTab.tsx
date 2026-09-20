// Table designer tab: create / alter tables (fields, indexes, foreign keys, checks, triggers, options, comment).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCw, Save, SaveAll, Search, TriangleAlert } from 'lucide-react';
import { newTableDesign } from '@shared/defaults';
import { tr } from '@shared/i18n';
import type { TableDesign } from '@shared/types';
import { alterTableSteps, createTableSteps, refineDesignFromDdl, type DdlStep, type DdlOptions } from '@shared/sql/ddl';
import { quoteString } from '@shared/sql/quote';
import { api, errorMessage } from '../../api/client';
import { designTable, openTable } from '../../actions/objects';
import { runSql } from '../../actions/sql';
import { ObjIcon } from '../../components/icons';
import { toast } from '../../components/Toast';
import { Button, EmptyState, Select, Spinner, TabStrip, TextArea, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { alertDialog, askDialog, errorDialog, promptDialog } from '../../components/ui/Dialog';
import type { TabProps } from '../../store/tabs';
import { metaSession, useWorkspace } from '../../store/workspace';
import { commitPendingEdits, renameDesignerTab, useDesignerTab } from './common/useDesignerTab';
import { SqlPreview } from './common/SqlPreview';
import { FieldsPane } from './FieldsPane';
import { ChecksPane, ForeignKeysPane, IndexesPane } from './KeysPanes';
import {
  copyForSaveAs,
  designKey,
  fromEditDesign,
  rebaseAfterPartialSave,
  serverFeatures,
  toEditDesign,
  validateDesign,
  type DesignSection
} from './model';
import { OptionsPane } from './OptionsPane';
import { invalidateTableLists, useServerLists } from './serverLists';
import { TriggersPane } from './TriggersPane';
import type { PaneProps } from './types';
import './common/designer.css';
import './tableDesign.css';

type Section = DesignSection | 'comment' | 'sql';

interface Params {
  connectionId: string;
  database: string;
  table: string | null;
}

async function loadDesign(cid: string, db: string, table: string): Promise<TableDesign> {
  const sid = metaSession(cid);
  const [d, ddl] = await Promise.all([api.meta.tableDesign(sid, db, table), api.meta.ddl(sid, db, 'table', table)]);
  const server = useWorkspace.getState().conns[cid]?.server;
  return refineDesignFromDdl(d, ddl, server?.type ?? 'mysql');
}

export default function TableDesignTab({ tab, active }: TabProps) {
  const params = tab.params as unknown as Params;
  const cid = params.connectionId;
  const db = params.database;
  const server = useWorkspace((s) => s.conns[cid]?.server);
  const features = useMemo(() => serverFeatures(server), [server]);
  const lists = useServerLists(cid);

  const [original, setOriginal] = useState<TableDesign | null>(null);
  const [edit, setEdit] = useState<TableDesign | null>(null);
  const [baseline, setBaseline] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('fields');
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<'save' | 'saveAs'>('save');
  const [busy, setBusy] = useState(false);
  const tableName = useRef<string | null>(params.table);

  const opts: DdlOptions = useMemo(() => ({ serverType: server?.type, serverVersion: server?.versionNumber, includeDefiner: true }), [server]);

  const applyLoaded = useCallback((d: TableDesign | null) => {
    const e = toEditDesign(d ?? newTableDesign(db));
    setOriginal(d);
    setEdit(e);
    setBaseline(designKey(fromEditDesign(e)));
    setSelectedField((cur) => (cur && e.fields.some((f) => f.id === cur) ? cur : (e.fields[0]?.id ?? null)));
  }, [db]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      if (!(await useWorkspace.getState().openConnection(cid))) throw new Error(tr('Die Verbindung ist nicht geöffnet.', 'The connection is not open.'));
      applyLoaded(tableName.current ? await loadDesign(cid, db, tableName.current) : null);
    } catch (e) {
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [cid, db, applyLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const editRef = useRef(edit);
  editRef.current = edit;
  const update = useCallback((fn: (e: TableDesign) => TableDesign) => setEdit((e) => (e ? fn(e) : e)), []);

  const resolved = useMemo(() => (edit ? fromEditDesign(edit, edit.name) : null), [edit]);
  const dirty = !!resolved && designKey(resolved) !== baseline;
  const problems = useMemo(() => (resolved ? validateDesign(resolved) : []), [resolved]);
  const problemIds = useMemo(() => new Set(problems.map((x) => x.id).filter((x): x is string => !!x)), [problems]);

  const steps = useMemo((): { list: DdlStep[]; error?: string } => {
    if (!resolved) return { list: [] };
    try {
      if (previewMode === 'saveAs' || !original) {
        const name = previewMode === 'saveAs' ? `${resolved.name || 'table'}_copy` : resolved.name || tr('neue_tabelle', 'new_table');
        const d = previewMode === 'saveAs' ? copyForSaveAs(resolved, name, { triggers: [], constraints: [] }) : { ...resolved, name };
        return { list: createTableSteps(d, opts) };
      }
      return { list: alterTableSteps(original, resolved, opts) };
    } catch (e) {
      return { list: [], error: errorMessage(e) };
    }
  }, [resolved, original, previewMode, opts]);

  const objectLabel = () => (tableName.current ? tr('Tabelle „{n}“', 'table "{n}"', { n: tableName.current }) : tr('die neue Tabelle', 'the new table'));

  const showProblems = async (): Promise<boolean> => {
    if (!problems.length) return true;
    const first = problems[0];
    setSection(first.section);
    if (first.section === 'fields' && first.id) setSelectedField(first.id);
    await alertDialog({
      kind: 'warning',
      title: tr('Entwurf unvollständig', 'Design incomplete'),
      message: problems
        .slice(0, 12)
        .map((x) => `• ${x.message}`)
        .join('\n') + (problems.length > 12 ? '\n…' : '')
    });
    return false;
  };

  /** Executes steps one by one; returns the number of executed steps and the error (if any) */
  const execute = async (list: DdlStep[]): Promise<{ done: number; error?: unknown }> => {
    for (let i = 0; i < list.length; i++) {
      try {
        await runSql(cid, list[i].sql, { noSplit: true });
      } catch (e) {
        return { done: i, error: e };
      }
    }
    return { done: list.length };
  };

  const afterServerChange = async (name: string | null) => {
    invalidateTableLists(cid, db);
    await useWorkspace.getState().refreshDatabase(cid, db, ['tables']);
    if (name) {
      try {
        return await loadDesign(cid, db, name);
      } catch {
        return null;
      }
    }
    return null;
  };

  const save = async (): Promise<boolean> => {
    if (!edit || busy) return false;
    await commitPendingEdits();
    let cur = editRef.current;
    if (!cur) return false;
    let res = fromEditDesign(cur, cur.name);
    if (!(await showProblems())) return false;
    const isNew = !original;
    if (isNew && !res.name.trim()) {
      const name = await promptDialog({
        title: tr('Tabelle speichern', 'Save table'),
        label: tr('Name der neuen Tabelle:', 'Name of the new table:'),
        validate: (v) => (v.trim() ? (v.trim().length > 64 ? tr('Maximal 64 Zeichen.', 'At most 64 characters.') : null) : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
      });
      if (!name) return false;
      const n = name.trim();
      update((e) => ({ ...e, name: n }));
      cur = { ...cur, name: n };
      res = fromEditDesign(cur, n);
    }
    const list = isNew ? createTableSteps(res, opts) : alterTableSteps(original!, res, opts);
    if (!list.length) {
      setBaseline(designKey(res));
      toast(tr('Keine Änderungen', 'No changes'));
      return true;
    }
    setBusy(true);
    try {
      const { done, error } = await execute(list);
      const name = res.name;
      if (error) {
        if (done > 0) {
          const rebased = rebaseAfterPartialSave(cur, list, done);
          const loaded = await afterServerChange(name);
          if (loaded) {
            setOriginal(loaded);
            setEdit(rebased);
            tableName.current = name;
            if (isNew) renameDesignerTab(tab.id, `design:${cid}:${db}:${name}`, `${name} @${db} (${tr('Entwurf', 'Design')})`, { table: name });
          }
        }
        await errorDialog(
          error,
          tr('Fehler bei Anweisung {i} von {n}', 'Error in statement {i} of {n}', { i: done + 1, n: list.length })
        );
        return false;
      }
      const loaded = await afterServerChange(name);
      tableName.current = name;
      if (loaded) applyLoaded(loaded);
      if (isNew || params.table !== name) renameDesignerTab(tab.id, `design:${cid}:${db}:${name}`, `${name} @${db} (${tr('Entwurf', 'Design')})`, { table: name });
      toast(tr('Tabelle „{n}“ gespeichert', 'Table "{n}" saved', { n: name }), 'success');
      return true;
    } finally {
      setBusy(false);
    }
  };

  const saveAs = async () => {
    if (!edit || busy) return;
    await commitPendingEdits();
    if (!editRef.current || !(await showProblems())) return;
    const source = fromEditDesign(editRef.current, editRef.current.name);
    const existing = useWorkspace.getState().conns[cid]?.dbs[db]?.tables.map((t) => t.name.toLowerCase()) ?? [];
    const name = await promptDialog({
      title: tr('Speichern unter', 'Save as'),
      label: tr('Name der neuen Tabelle:', 'Name of the new table:'),
      value: source.name ? `${source.name}_copy` : '',
      validate: (v) =>
        !v.trim() ? tr('Bitte einen Namen eingeben.', 'Please enter a name.') : existing.includes(v.trim().toLowerCase()) ? tr('Diese Tabelle existiert bereits.', 'This table already exists.') : null
    });
    if (!name) return;
    setBusy(true);
    try {
      const sid = metaSession(cid);
      const q = await api.query.execute(
        sid,
        `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ${quoteString(db)} AND CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK')`,
        { history: false }
      );
      const constraints = (q.results[0]?.rows ?? []).map((r) => String(r[0]));
      const triggers = (await api.meta.triggers(sid, db)).map((t) => t.name);
      const copy = copyForSaveAs(source, name.trim(), { triggers, constraints });
      const list = createTableSteps(copy, opts);
      const { done, error } = await execute(list);
      if (done > 0) await afterServerChange(null);
      if (error) {
        await errorDialog(error, tr('Fehler bei Anweisung {i} von {n}', 'Error in statement {i} of {n}', { i: done + 1, n: list.length }));
        if (done === 0) return;
      } else toast(tr('Tabelle „{n}“ erstellt', 'Table "{n}" created', { n: copy.name }), 'success');
      designTable(cid, db, copy.name);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    if (dirty) {
      const a = await askDialog({
        title: tr('Neu laden', 'Reload'),
        message: tr('Ungespeicherte Änderungen gehen verloren. Trotzdem neu laden?', 'Unsaved changes will be lost. Reload anyway?'),
        yesLabel: tr('Neu laden', 'Reload'),
        noLabel: tr('Abbrechen', 'Cancel')
      });
      if (a !== 'yes') return;
    }
    await load();
  };

  useDesignerTab({
    tab,
    active,
    dirty,
    save,
    objectLabel,
    onFind: () => {
      setSection('fields');
      setFindOpen(true);
    },
    shortcuts: {
      'Ctrl+O': () => tableName.current && openTable(cid, db, tableName.current)
    }
  });

  if (loading && !edit) {
    return (
      <div className="ks-dsg">
        <div className="ks-dsg-loading">
          <Spinner size={22} />
        </div>
      </div>
    );
  }
  if (loadError || !edit || !resolved) {
    return (
      <div className="ks-dsg">
        <EmptyState icon={<TriangleAlert size={40} />} title={tr('Die Tabelle konnte nicht geladen werden', 'The table could not be loaded')}>
          <p className="selectable">{loadError}</p>
          <Button variant="primary" icon={<RotateCw size={14} />} onClick={() => void load()}>
            {tr('Erneut versuchen', 'Retry')}
          </Button>
        </EmptyState>
      </div>
    );
  }

  const pane: PaneProps = { connectionId: cid, database: db, edit, update, server, features, lists, problems: problemIds };
  const count = (s: DesignSection) => problems.filter((x) => x.section === s).length;
  const badge = (n: number, s: DesignSection) => (count(s) ? `${n} !` : n ? n : undefined);

  return (
    <div className="ks-dsg">
      <Toolbar>
        <ToolbarButton icon={busy ? <Spinner size={14} /> : <Save size={15} />} label={tr('Speichern', 'Save')} title={tr('Speichern (Strg+S)', 'Save (Ctrl+S)')} disabled={busy} onClick={() => void save()} />
        <ToolbarButton icon={<SaveAll size={15} />} label={tr('Speichern unter …', 'Save As …')} disabled={busy} onClick={() => void saveAs()} />
        <ToolbarSep />
        <ToolbarButton
          icon={<ObjIcon kind="table" size={15} />}
          label={tr('Tabelle öffnen', 'Open Table')}
          title={tr('Tabelle öffnen (Strg+O)', 'Open Table (Ctrl+O)')}
          disabled={!tableName.current}
          onClick={() => tableName.current && openTable(cid, db, tableName.current)}
        />
        <ToolbarButton icon={<Search size={15} />} label={tr('Suchen', 'Find')} title={tr('Feld suchen (Strg+F)', 'Find field (Ctrl+F)')} onClick={() => {
          setSection('fields');
          setFindOpen(true);
        }} />
        <ToolbarButton icon={<RotateCw size={15} />} label={tr('Neu laden', 'Reload')} disabled={!tableName.current || busy} onClick={() => void reload()} />
      </Toolbar>
      <TabStrip<Section>
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'fields', label: tr('Felder', 'Fields'), badge: badge(edit.fields.length, 'fields') },
          { id: 'indexes', label: tr('Indizes', 'Indexes'), badge: badge(edit.indexes.length, 'indexes') },
          { id: 'foreignKeys', label: tr('Fremdschlüssel', 'Foreign Keys'), badge: badge(edit.foreignKeys.length, 'foreignKeys') },
          { id: 'checks', label: tr('Checks', 'Checks'), badge: badge(edit.checks.length, 'checks'), hidden: !features.checks && !edit.checks.length },
          { id: 'triggers', label: tr('Trigger', 'Triggers'), badge: badge(edit.triggers.length, 'triggers') },
          { id: 'options', label: tr('Optionen', 'Options'), badge: count('options') ? '!' : undefined },
          { id: 'comment', label: tr('Kommentar', 'Comment') },
          { id: 'sql', label: tr('SQL-Vorschau', 'SQL Preview') }
        ]}
      />
      <div className="ks-dsg-body">
        {section === 'fields' && <FieldsPane {...pane} selected={selectedField} onSelect={setSelectedField} findOpen={findOpen} onFindClose={() => setFindOpen(false)} />}
        {section === 'indexes' && <IndexesPane {...pane} />}
        {section === 'foreignKeys' && <ForeignKeysPane {...pane} />}
        {section === 'checks' && <ChecksPane {...pane} />}
        {section === 'triggers' && <TriggersPane {...pane} />}
        {section === 'options' && <OptionsPane {...pane} />}
        {section === 'comment' && (
          <div className="ks-td-comment">
            <span className="muted">{tr('Kommentar der Tabelle', 'Table comment')}</span>
            <TextArea value={edit.comment} maxLength={2048} onChange={(e) => update((x) => ({ ...x, comment: e.target.value }))} />
          </div>
        )}
        {section === 'sql' && (
          <SqlPreview
            statements={steps.list.map((s) => s.sql)}
            empty={steps.error ?? undefined}
            header={
              <>
                <span className="muted">{tr('Anweisungen für', 'Statements for')}</span>
                <Select<'save' | 'saveAs'>
                  style={{ width: 200 }}
                  value={previewMode}
                  onChange={setPreviewMode}
                  options={[
                    { value: 'save', label: tr('Speichern', 'Save') },
                    { value: 'saveAs', label: tr('Speichern unter', 'Save as') }
                  ]}
                />
                {problems.length > 0 && (
                  <span className="danger-text row" style={{ gap: 4 }}>
                    <TriangleAlert size={14} />
                    {tr('{n} Probleme im Entwurf', '{n} problems in the design', { n: problems.length })}
                  </span>
                )}
              </>
            }
          />
        )}
      </div>
      <div className="ks-statusline">
        <span>
          {resolved.name || tr('Neue Tabelle', 'New table')} @{db}
        </span>
        <span>{tr('{n} Felder', '{n} fields', { n: edit.fields.length })}</span>
        {dirty && <span className="ks-dsg-status-dirty">{tr('Geändert', 'Modified')}</span>}
        {problems.length > 0 && <span className="danger-text">{problems[0].message}</span>}
        <span className="ks-dsg-status-right">{server ? `${server.type === 'mariadb' ? 'MariaDB' : 'MySQL'} ${server.version}` : ''}</span>
      </div>
    </div>
  );
}

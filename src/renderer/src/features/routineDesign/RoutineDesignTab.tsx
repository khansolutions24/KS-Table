// Stored routine designer: parameters, return type, body, characteristics, SQL preview and execution (F9).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ArrowDown, ArrowUp, Play, Plus, RotateCw, Save, SaveAll, Trash2, TriangleAlert, Wand } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { StatementResult } from '@shared/types';
import {
  createRoutineSql,
  dropRoutineSql,
  parseCreateRoutine,
  routineCallScript,
  type RoutineArg,
  type RoutineDataAccess,
  type RoutineDef,
  type RoutineParam
} from '@shared/sql/ddl';
import { api, errorMessage } from '../../api/client';
import { designRoutine } from '../../actions/objects';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { beautifySql } from '../../components/editor/monaco';
import { toast } from '../../components/Toast';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Section,
  Select,
  Spinner,
  TabStrip,
  TextInput,
  Toolbar,
  ToolbarButton,
  ToolbarSep
} from '../../components/ui/controls';
import { askDialog, Dialog, errorDialog, openDialog, promptDialog } from '../../components/ui/Dialog';
import type { TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { ResultsPanel } from '../tableDesign/common/ResultsPanel';
import { SqlPreview } from '../tableDesign/common/SqlPreview';
import { commitPendingEdits, execChecked, renameDesignerTab, useDesignerTab, useOwnSession } from '../tableDesign/common/useDesignerTab';
import { typesFor } from '../tableDesign/model';
import '../tableDesign/common/designer.css';

type Section = 'definition' | 'parameters' | 'advanced' | 'sql';

interface Params {
  connectionId: string;
  database: string;
  name: string | null;
  routineType: 'FUNCTION' | 'PROCEDURE';
}

const LW = 150;
const DATA_ACCESS: RoutineDataAccess[] = ['CONTAINS SQL', 'NO SQL', 'READS SQL DATA', 'MODIFIES SQL DATA'];

/** Values entered in the execute dialog, remembered per routine */
const rememberedArgs = new Map<string, RoutineArg[]>();

function newRoutine(db: string, type: RoutineDef['type']): RoutineDef {
  return {
    schema: db,
    name: '',
    type,
    params: [],
    returns: type === 'FUNCTION' ? 'INT' : '',
    body: type === 'FUNCTION' ? 'BEGIN\n  RETURN NULL;\nEND' : 'BEGIN\n  \nEND',
    definer: '',
    security: '',
    dataAccess: type === 'FUNCTION' ? 'READS SQL DATA' : '',
    deterministic: false,
    comment: ''
  };
}

const keyOf = (r: RoutineDef) => JSON.stringify({ ...r, body: r.body.trim() });

export default function RoutineDesignTab({ tab, active }: TabProps) {
  const params = tab.params as unknown as Params;
  const cid = params.connectionId;
  const db = params.database;
  const type = params.routineType;
  const session = useOwnSession(cid, db);
  const server = useWorkspace((s) => s.conns[cid]?.server);
  const nameRef = useRef<string | null>(params.name);
  const originalDdl = useRef<string>('');
  const [def, setDef] = useState<RoutineDef | null>(null);
  const [saved, setSaved] = useState<RoutineDef | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>(params.name ? 'definition' : 'parameters');
  const [results, setResults] = useState<StatementResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const defRef = useRef(def);
  defRef.current = def;
  const typeLabel = type === 'FUNCTION' ? tr('Funktion', 'Function') : tr('Prozedur', 'Procedure');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      if (!nameRef.current) {
        const r = newRoutine(db, type);
        setDef(r);
        setSaved(null);
        return;
      }
      const sid = await session();
      const ddl = await api.meta.ddl(sid, db, type === 'FUNCTION' ? 'function' : 'procedure', nameRef.current);
      const parsed = parseCreateRoutine(ddl, type);
      if (!parsed) throw new Error(tr('Die Definition konnte nicht gelesen werden.', 'The definition could not be read.'));
      originalDdl.current = ddl;
      const r: RoutineDef = { ...parsed, schema: db, name: nameRef.current };
      setDef(r);
      setSaved(r);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [db, type, session]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (patch: Partial<RoutineDef>) => setDef((d) => (d ? { ...d, ...patch } : d));
  const baseline = useMemo(() => (saved ? keyOf(saved) : keyOf(newRoutine(db, type))), [saved, db, type]);
  const dirty = !!def && keyOf(def) !== baseline;

  const validate = (d: RoutineDef): string | null => {
    if (!d.body.trim()) return tr('Der Rumpf ist leer.', 'The body is empty.');
    for (const [i, p] of d.params.entries()) {
      if (!p.name.trim() || !p.type.trim()) return tr('Parameter {n}: Name und Typ angeben.', 'Parameter {n}: enter name and type.', { n: i + 1 });
    }
    const names = d.params.map((p) => p.name.toLowerCase());
    if (new Set(names).size !== names.length) return tr('Parameternamen müssen eindeutig sein.', 'Parameter names must be unique.');
    if (d.type === 'FUNCTION' && !d.returns.trim()) return tr('Rückgabetyp fehlt.', 'Return type is missing.');
    return null;
  };

  const askName = (title: string, value = '') =>
    promptDialog({
      title,
      label: tr('Name der {t}:', 'Name of the {t}:', { t: typeLabel }),
      value,
      validate: (v) => (v.trim() ? (v.trim().length > 64 ? tr('Maximal 64 Zeichen.', 'At most 64 characters.') : null) : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
    });

  const save = async (): Promise<boolean> => {
    await commitPendingEdits();
    const d = defRef.current;
    if (!d || busy) return false;
    const err = validate(d);
    if (err) {
      toast(err, 'error');
      return false;
    }
    let name = nameRef.current ?? '';
    const isNew = !name;
    if (isNew) {
      const n = await askName(tr('{t} speichern', 'Save {t}', { t: typeLabel }));
      if (!n) return false;
      name = n.trim();
    } else if (!dirty) {
      toast(tr('Keine Änderungen', 'No changes'));
      return true;
    }
    setBusy(true);
    try {
      const sid = await session();
      const create = createRoutineSql({ ...d, name });
      if (isNew) await execChecked(sid, create);
      else {
        await execChecked(sid, dropRoutineSql(type, db, name));
        try {
          await execChecked(sid, create);
        } catch (e) {
          let restored = true;
          try {
            await execChecked(sid, originalDdl.current);
          } catch {
            restored = false;
          }
          await errorDialog(
            e,
            restored
              ? tr('Speichern fehlgeschlagen – die bisherige Definition wurde wiederhergestellt', 'Save failed – the previous definition was restored')
              : tr('Speichern fehlgeschlagen – die bisherige Definition konnte nicht wiederhergestellt werden', 'Save failed – the previous definition could not be restored')
          );
          return false;
        }
      }
      nameRef.current = name;
      await useWorkspace.getState().refreshDatabase(cid, db, ['routines']);
      if (isNew) renameDesignerTab(tab.id, `routine:${cid}:${db}:${type}:${name}`, `${name} @${db}`, { name });
      await load();
      toast(tr('{t} „{n}“ gespeichert', '{t} "{n}" saved', { t: typeLabel, n: name }), 'success');
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
    const err = validate(d);
    if (err) {
      toast(err, 'error');
      return;
    }
    const n = await askName(tr('Speichern unter', 'Save as'), d.name ? `${d.name}_copy` : '');
    if (!n) return;
    setBusy(true);
    try {
      await execChecked(await session(), createRoutineSql({ ...d, name: n.trim() }));
      await useWorkspace.getState().refreshDatabase(cid, db, ['routines']);
      toast(tr('{t} „{n}“ erstellt', '{t} "{n}" created', { t: typeLabel, n: n.trim() }), 'success');
      designRoutine(cid, db, n.trim(), type);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (running || !saved || !nameRef.current) {
      if (!nameRef.current) toast(tr('Bitte zuerst speichern.', 'Please save first.'));
      return;
    }
    if (dirty) toast(tr('Es wird die gespeicherte Version ausgeführt.', 'The saved version is executed.'));
    const key = `${cid}|${db}|${type}|${nameRef.current}`;
    const inputs = saved.params.filter((p) => type === 'FUNCTION' || p.mode !== 'OUT');
    let args: RoutineArg[] = saved.params.map(() => ({ value: '', isNull: false, raw: false }));
    if (inputs.length) {
      const r = await askArguments(saved, rememberedArgs.get(key));
      if (!r) return;
      args = r;
      rememberedArgs.set(key, r);
    }
    setRunning(true);
    try {
      const script = routineCallScript({ ...saved, name: nameRef.current }, args);
      const r = await api.query.execute(await session(), script.join(';\n'), { stopOnError: true });
      setResults(r.results);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setRunning(false);
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
    objectLabel: () => (nameRef.current ? `${typeLabel} „${nameRef.current}“` : typeLabel),
    shortcuts: { F9: () => void execute() }
  });

  if (loadError) {
    return (
      <div className="ks-dsg">
        <EmptyState icon={<TriangleAlert size={40} />} title={tr('Die Routine konnte nicht geladen werden', 'The routine could not be loaded')}>
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

  const previewName = def.name || nameRef.current || tr('neue_routine', 'new_routine');
  const preview = nameRef.current ? [dropRoutineSql(type, db, nameRef.current), createRoutineSql({ ...def, name: previewName })] : [createRoutineSql({ ...def, name: previewName })];
  const editor = (
    <div className="ks-dsg-editor">
      <SqlEditor value={def.body} onChange={(body) => set({ body })} completion={{ connectionId: cid, database: db }} />
    </div>
  );

  return (
    <div className="ks-dsg">
      <Toolbar>
        <ToolbarButton icon={busy ? <Spinner size={14} /> : <Save size={15} />} label={tr('Speichern', 'Save')} title={tr('Speichern (Strg+S)', 'Save (Ctrl+S)')} disabled={busy} onClick={() => void save()} />
        <ToolbarButton icon={<SaveAll size={15} />} label={tr('Speichern unter …', 'Save As …')} disabled={busy} onClick={() => void saveAs()} />
        <ToolbarSep />
        <ToolbarButton
          icon={running ? <Spinner size={14} /> : <Play size={15} />}
          label={tr('Ausführen', 'Execute')}
          title={tr('Ausführen (F9)', 'Execute (F9)')}
          disabled={running || !nameRef.current}
          onClick={() => void execute()}
        />
        <ToolbarButton icon={<Wand size={15} />} label={tr('Formatieren', 'Beautify')} onClick={() => set({ body: beautifySql(def.body) })} />
        <ToolbarSep />
        <ToolbarButton icon={<RotateCw size={15} />} label={tr('Neu laden', 'Reload')} disabled={!nameRef.current} onClick={() => void reload()} />
      </Toolbar>
      <TabStrip<Section>
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'definition', label: tr('Definition', 'Definition') },
          { id: 'parameters', label: tr('Parameter', 'Parameters'), badge: def.params.length || undefined },
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
                <ResultsPanel
                  results={results}
                  onClose={() => setResults(null)}
                  labelFor={(r) => (/^SELECT @_ks_p\d/.test(r.sql) && r.sql === results[results.length - 1]?.sql ? tr('Ausgabeparameter', 'Output parameters') : undefined)}
                />
              </Panel>
            </Group>
          ) : (
            editor
          ))}
        {section === 'parameters' && (
          <ParametersPane def={def} set={set} typeOptions={typesFor(server).map((t) => t.name)} />
        )}
        {section === 'advanced' && (
          <div className="ks-dsg-scroll">
            <div className="ks-dsg-form">
              <Section title={typeLabel}>
                <Field label={tr('Sicherheit', 'Security')} labelWidth={LW}>
                  <Select<RoutineDef['security']>
                    style={{ width: 220 }}
                    value={def.security}
                    onChange={(security) => set({ security })}
                    options={[{ value: '', label: tr('(nicht angegeben = DEFINER)', '(not specified = DEFINER)') }, 'DEFINER', 'INVOKER']}
                  />
                </Field>
                <Field label="Definer" labelWidth={LW} hint={tr('benutzer@host, leer = aktueller Benutzer', 'user@host, empty = current user')}>
                  <TextInput value={def.definer} placeholder="root@localhost" onChange={(e) => set({ definer: e.target.value })} />
                </Field>
                <Field label={tr('Datenzugriff', 'Data access')} labelWidth={LW}>
                  <Select<RoutineDataAccess>
                    style={{ width: 220 }}
                    value={def.dataAccess}
                    onChange={(dataAccess) => set({ dataAccess })}
                    options={[{ value: '', label: tr('(nicht angegeben)', '(not specified)') }, ...DATA_ACCESS]}
                  />
                </Field>
                <Field label="" labelWidth={LW}>
                  <Checkbox checked={def.deterministic} onChange={(deterministic) => set({ deterministic })} label={tr('Deterministisch (DETERMINISTIC)', 'Deterministic')} />
                </Field>
                <Field label={tr('Kommentar', 'Comment')} labelWidth={LW}>
                  <TextInput value={def.comment} onChange={(e) => set({ comment: e.target.value })} />
                </Field>
              </Section>
            </div>
          </div>
        )}
        {section === 'sql' && <SqlPreview statements={preview} />}
      </div>
      <div className="ks-statusline">
        <span>
          {typeLabel} {nameRef.current ?? tr('(neu)', '(new)')} @{db}
        </span>
        {dirty && <span className="ks-dsg-status-dirty">{tr('Geändert', 'Modified')}</span>}
        <span className="ks-dsg-status-right">{tr('F9 = Ausführen', 'F9 = Execute')}</span>
      </div>
    </div>
  );
}

function ParametersPane({ def, set, typeOptions }: { def: RoutineDef; set: (p: Partial<RoutineDef>) => void; typeOptions: string[] }) {
  const [sel, setSel] = useState(0);
  const proc = def.type === 'PROCEDURE';
  const setParam = (i: number, patch: Partial<RoutineParam>) => set({ params: def.params.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const move = (dir: -1 | 1) => {
    const j = sel + dir;
    if (j < 0 || j >= def.params.length) return;
    const n = [...def.params];
    [n[sel], n[j]] = [n[j], n[sel]];
    set({ params: n });
    setSel(j);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Toolbar>
        <ToolbarButton
          icon={<Plus size={15} />}
          label={tr('Parameter hinzufügen', 'Add Parameter')}
          onClick={() => {
            set({ params: [...def.params, { mode: proc ? 'IN' : '', name: `p_${def.params.length + 1}`, type: 'INT' }] });
            setSel(def.params.length);
          }}
        />
        <ToolbarButton
          icon={<Trash2 size={15} />}
          label={tr('Parameter löschen', 'Delete Parameter')}
          disabled={!def.params.length}
          onClick={() => {
            set({ params: def.params.filter((_, k) => k !== sel) });
            setSel(Math.max(0, sel - 1));
          }}
        />
        <ToolbarButton icon={<ArrowUp size={15} />} label={tr('Nach oben', 'Move Up')} disabled={sel <= 0} onClick={() => move(-1)} />
        <ToolbarButton icon={<ArrowDown size={15} />} label={tr('Nach unten', 'Move Down')} disabled={sel >= def.params.length - 1} onClick={() => move(1)} />
      </Toolbar>
      <datalist id="ks-rd-types">
        {typeOptions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {def.type === 'FUNCTION' && (
        <div className="ks-dsg-form" style={{ paddingBottom: 4 }}>
          <Field label={tr('Rückgabetyp', 'Returns')} labelWidth={LW} hint={tr('z. B. VARCHAR(100) CHARSET utf8mb4, DECIMAL(10,2)', 'e.g. VARCHAR(100) CHARSET utf8mb4, DECIMAL(10,2)')}>
            <TextInput list="ks-rd-types" className="mono" value={def.returns} onChange={(e) => set({ returns: e.target.value })} />
          </Field>
        </div>
      )}
      <div className="ks-dsg-grid-wrap">
        <table className="ks-table ks-dsg-grid">
          <thead>
            <tr>
              <th>#</th>
              {proc && <th style={{ width: 90 }}>{tr('Modus', 'Mode')}</th>}
              <th style={{ minWidth: 200 }}>{tr('Name', 'Name')}</th>
              <th style={{ minWidth: 300 }}>{tr('Typ', 'Type')}</th>
            </tr>
          </thead>
          <tbody>
            {def.params.map((p, i) => (
              <tr key={i} className={clsx(sel === i && 'selected')} onMouseDown={() => setSel(i)} onFocus={() => setSel(i)}>
                <td className="faint">{i + 1}</td>
                {proc && (
                  <td>
                    <select className="ks-dsg-cell" value={p.mode || 'IN'} onChange={(e) => setParam(i, { mode: e.target.value as RoutineParam['mode'] })}>
                      <option value="IN">IN</option>
                      <option value="OUT">OUT</option>
                      <option value="INOUT">INOUT</option>
                    </select>
                  </td>
                )}
                <td>
                  <input className="ks-dsg-cell" value={p.name} spellCheck={false} onChange={(e) => setParam(i, { name: e.target.value })} />
                </td>
                <td>
                  <input className="ks-dsg-cell mono" list="ks-rd-types" value={p.type} spellCheck={false} onChange={(e) => setParam(i, { type: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!def.params.length && <div className="ks-dsg-grid-empty">{tr('Keine Parameter', 'No parameters')}</div>}
      </div>
    </div>
  );
}

function inputKind(type: string): 'number' | 'date' | 'time' | 'text' {
  const t = type.trim().split(/[\s(]/)[0].toUpperCase();
  if (['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'REAL', 'YEAR'].includes(t)) return 'number';
  if (t === 'DATE') return 'date';
  if (t === 'TIME') return 'time';
  return 'text';
}

function ArgsBody({ def, initial, close }: { def: RoutineDef; initial?: RoutineArg[]; close: (v?: RoutineArg[] | null) => void }) {
  const [args, setArgs] = useState<RoutineArg[]>(() => def.params.map((_, i) => initial?.[i] ?? { value: '', isNull: false, raw: false }));
  const setArg = (i: number, patch: Partial<RoutineArg>) => setArgs((a) => a.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <Dialog
      title={tr('Parameter für {n}', 'Parameters for {n}', { n: def.name })}
      width={640}
      onClose={() => close(null)}
      onSubmit={() => close(args)}
      footer={
        <>
          <Button type="submit" variant="primary" icon={<Play size={14} />}>
            {tr('Ausführen', 'Execute')}
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <table className="ks-table ks-dsg-grid">
        <thead>
          <tr>
            <th>{tr('Parameter', 'Parameter')}</th>
            <th>{tr('Typ', 'Type')}</th>
            <th style={{ minWidth: 220 }}>{tr('Wert', 'Value')}</th>
            <th className="ks-dsg-center">NULL</th>
            <th className="ks-dsg-center" title={tr('Wert als SQL-Ausdruck verwenden', 'Use value as SQL expression')}>
              {tr('Ausdruck', 'Expression')}
            </th>
          </tr>
        </thead>
        <tbody>
          {def.params.map((p, i) => {
            const out = def.type === 'PROCEDURE' && p.mode === 'OUT';
            const kind = args[i].raw ? 'text' : inputKind(p.type);
            return (
              <tr key={i}>
                <td>
                  {p.mode && <span className="faint">{p.mode} </span>}
                  {p.name}
                </td>
                <td className="mono faint">{p.type}</td>
                <td>
                  <input
                    className="ks-dsg-cell"
                    type={kind === 'number' ? 'text' : kind}
                    inputMode={kind === 'number' ? 'decimal' : undefined}
                    step={kind === 'time' ? 1 : undefined}
                    value={args[i].value}
                    disabled={out || args[i].isNull}
                    placeholder={out ? tr('(Ausgabe)', '(output)') : ''}
                    autoFocus={i === def.params.findIndex((x) => def.type === 'FUNCTION' || x.mode !== 'OUT')}
                    onChange={(e) => setArg(i, { value: e.target.value })}
                  />
                </td>
                <td className="ks-dsg-center">
                  <input type="checkbox" checked={args[i].isNull} disabled={out} onChange={(e) => setArg(i, { isNull: e.target.checked })} />
                </td>
                <td className="ks-dsg-center">
                  <input type="checkbox" checked={args[i].raw} disabled={out || args[i].isNull} onChange={(e) => setArg(i, { raw: e.target.checked })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="ks-field-hint" style={{ marginTop: 8 }}>
        {tr('Werte werden als Literal übergeben; „Ausdruck“ übernimmt den Text unverändert (z. B. NOW()).', 'Values are passed as literals; "Expression" passes the text unchanged (e.g. NOW()).')}
      </div>
    </Dialog>
  );
}

function askArguments(def: RoutineDef, initial?: RoutineArg[]): Promise<RoutineArg[] | null> {
  return openDialog<RoutineArg[] | null>((close) => <ArgsBody def={def} initial={initial} close={close} />).then((v) => v ?? null);
}

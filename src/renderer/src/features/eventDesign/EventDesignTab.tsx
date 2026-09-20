// Event designer: body, schedule (AT / EVERY with STARTS / ENDS), status, completion, definer, comment, SQL preview.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Plus, Power, RotateCw, Save, SaveAll, Trash2, TriangleAlert } from 'lucide-react';
import { tr } from '@shared/i18n';
import {
  alterEventSql,
  createEventSql,
  eventDefFromInfo,
  INTERVAL_UNITS,
  type EventDef,
  type EventInfoRow,
  type EventStatusKind,
  type IntervalDef,
  type IntervalUnit
} from '@shared/sql/ddl';
import { quoteString } from '@shared/sql/quote';
import { formatDateTime } from '@shared/util';
import { api, errorMessage } from '../../api/client';
import { designEvent } from '../../actions/objects';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { toast } from '../../components/Toast';
import { Button, Checkbox, EmptyState, Field, IconButton, RadioGroup, Section, Select, Spinner, TabStrip, TextInput, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { askDialog, confirmDialog, errorDialog, promptDialog } from '../../components/ui/Dialog';
import type { TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { SqlPreview } from '../tableDesign/common/SqlPreview';
import { commitPendingEdits, execChecked, renameDesignerTab, useDesignerTab, useOwnSession } from '../tableDesign/common/useDesignerTab';
import '../tableDesign/common/designer.css';

type Section = 'definition' | 'schedule' | 'advanced' | 'sql';

interface Params {
  connectionId: string;
  database: string;
  name: string | null;
}

const LW = 150;
const now = () => formatDateTime(Date.now());

function newEvent(db: string): EventDef {
  return {
    schema: db,
    name: '',
    scheduleType: 'EVERY',
    at: '',
    atIntervals: [],
    every: { value: '1', unit: 'DAY' },
    starts: '',
    startsIntervals: [],
    ends: '',
    endsIntervals: [],
    status: 'ENABLE',
    preserve: false,
    definer: '',
    comment: '',
    body: 'BEGIN\n  \nEND'
  };
}

const keyOf = (e: EventDef) => JSON.stringify({ ...e, body: e.body.trim() });

export default function EventDesignTab({ tab, active }: TabProps) {
  const params = tab.params as unknown as Params;
  const cid = params.connectionId;
  const db = params.database;
  const session = useOwnSession(cid, db);
  const server = useWorkspace((s) => s.conns[cid]?.server);
  const nameRef = useRef<string | null>(params.name);
  const [def, setDef] = useState<EventDef | null>(null);
  const [saved, setSaved] = useState<EventDef | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('definition');
  const [scheduler, setScheduler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const defRef = useRef(def);
  defRef.current = def;
  const opts = useMemo(() => ({ serverType: server?.type, serverVersion: server?.versionNumber }), [server]);

  const checkScheduler = useCallback(async () => {
    try {
      const r = await api.query.execute(await session(), 'SELECT @@event_scheduler', { history: false });
      setScheduler(String(r.results[0]?.rows?.[0]?.[0] ?? ''));
    } catch {
      setScheduler(null);
    }
  }, [session]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      void checkScheduler();
      if (!nameRef.current) {
        setDef(newEvent(db));
        setSaved(null);
        return;
      }
      const r = await api.query.execute(
        await session(),
        `SELECT EVENT_NAME AS name, EVENT_TYPE AS eventType, EXECUTE_AT AS executeAt, INTERVAL_VALUE AS intervalValue, INTERVAL_FIELD AS intervalField,
                STARTS AS starts, ENDS AS ends, STATUS AS status, ON_COMPLETION AS onCompletion, DEFINER AS definer, EVENT_COMMENT AS comment,
                EVENT_DEFINITION AS body
           FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${quoteString(db)} AND EVENT_NAME = ${quoteString(nameRef.current)}`,
        { history: false }
      );
      const rs = r.results[0];
      if (rs?.kind === 'error') throw new Error(rs.error?.message);
      const row = rs?.rows?.[0];
      if (!rs?.columns || !row) throw new Error(tr('Das Ereignis „{n}“ wurde nicht gefunden.', 'The event "{n}" was not found.', { n: nameRef.current }));
      const obj = Object.fromEntries(rs.columns.map((c, i) => [c.name, row[i] === null ? null : String(row[i])])) as unknown as EventInfoRow;
      const e = eventDefFromInfo(db, obj);
      setDef(e);
      setSaved(e);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [db, session, checkScheduler]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (patch: Partial<EventDef>) => setDef((d) => (d ? { ...d, ...patch } : d));
  const baseline = useMemo(() => keyOf(saved ?? newEvent(db)), [saved, db]);
  const dirty = !!def && keyOf(def) !== baseline;

  const validate = (e: EventDef): string | null => {
    if (!e.body.trim()) return tr('Der Rumpf ist leer.', 'The body is empty.');
    if (e.scheduleType === 'AT' && !e.at.trim()) return tr('Bitte den Ausführungszeitpunkt angeben.', 'Please enter the execution time.');
    if (e.scheduleType === 'EVERY' && !e.every.value.trim()) return tr('Bitte das Intervall angeben.', 'Please enter the interval.');
    return null;
  };

  const statements = (e: EventDef, name: string): string[] => {
    if (!saved) return [createEventSql({ ...e, name }, opts)];
    const sql = alterEventSql(saved, { ...e, name }, opts);
    return sql ? [sql] : [];
  };

  const askName = (title: string, value = '') =>
    promptDialog({
      title,
      label: tr('Name des Ereignisses:', 'Event name:'),
      value,
      validate: (v) => (v.trim() ? (v.trim().length > 64 ? tr('Maximal 64 Zeichen.', 'At most 64 characters.') : null) : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
    });

  const save = async (): Promise<boolean> => {
    await commitPendingEdits();
    const e = defRef.current;
    if (!e || busy) return false;
    const err = validate(e);
    if (err) {
      toast(err, 'error');
      return false;
    }
    let name = e.name.trim();
    if (!name) {
      const n = await askName(tr('Ereignis speichern', 'Save event'));
      if (!n) return false;
      name = n.trim();
    }
    const list = statements(e, name);
    if (!list.length) {
      toast(tr('Keine Änderungen', 'No changes'));
      return true;
    }
    setBusy(true);
    try {
      const sid = await session();
      for (const s of list) await execChecked(sid, s);
      const renamed = nameRef.current !== name;
      nameRef.current = name;
      await useWorkspace.getState().refreshDatabase(cid, db, ['events']);
      if (renamed) renameDesignerTab(tab.id, `event:${cid}:${db}:${name}`, `${name} @${db}`, { name });
      await load();
      toast(tr('Ereignis „{n}“ gespeichert', 'Event "{n}" saved', { n: name }), 'success');
      return true;
    } catch (ex) {
      void errorDialog(ex);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveAs = async () => {
    await commitPendingEdits();
    const e = defRef.current;
    if (!e || busy) return;
    const err = validate(e);
    if (err) {
      toast(err, 'error');
      return;
    }
    const n = await askName(tr('Speichern unter', 'Save as'), e.name ? `${e.name}_copy` : '');
    if (!n) return;
    setBusy(true);
    try {
      await execChecked(await session(), createEventSql({ ...e, name: n.trim() }, opts));
      await useWorkspace.getState().refreshDatabase(cid, db, ['events']);
      toast(tr('Ereignis „{n}“ erstellt', 'Event "{n}" created', { n: n.trim() }), 'success');
      designEvent(cid, db, n.trim());
    } catch (ex) {
      void errorDialog(ex);
    } finally {
      setBusy(false);
    }
  };

  const enableScheduler = async () => {
    const ok = await confirmDialog({
      title: tr('Ereignisplaner aktivieren', 'Enable event scheduler'),
      message: tr(
        'SET GLOBAL event_scheduler = ON ausführen? Die Einstellung gilt für den ganzen Server bis zum nächsten Neustart und erfordert entsprechende Rechte.',
        'Execute SET GLOBAL event_scheduler = ON? The setting applies to the whole server until the next restart and requires the corresponding privilege.'
      ),
      okLabel: tr('Aktivieren', 'Enable')
    });
    if (!ok) return;
    try {
      await execChecked(await session(), 'SET GLOBAL event_scheduler = ON');
      await checkScheduler();
      toast(tr('Ereignisplaner ist aktiv', 'Event scheduler is on'), 'success');
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
    objectLabel: () => (nameRef.current ? tr('Ereignis „{n}“', 'event "{n}"', { n: nameRef.current }) : tr('das neue Ereignis', 'the new event'))
  });

  if (loadError) {
    return (
      <div className="ks-dsg">
        <EmptyState icon={<TriangleAlert size={40} />} title={tr('Das Ereignis konnte nicht geladen werden', 'The event could not be loaded')}>
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

  const previewName = def.name.trim() || tr('neues_ereignis', 'new_event');
  let preview: string[] = [];
  try {
    preview = statements(def, previewName);
  } catch {
    preview = [];
  }

  return (
    <div className="ks-dsg">
      <Toolbar>
        <ToolbarButton icon={busy ? <Spinner size={14} /> : <Save size={15} />} label={tr('Speichern', 'Save')} title={tr('Speichern (Strg+S)', 'Save (Ctrl+S)')} disabled={busy} onClick={() => void save()} />
        <ToolbarButton icon={<SaveAll size={15} />} label={tr('Speichern unter …', 'Save As …')} disabled={busy} onClick={() => void saveAs()} />
        <ToolbarSep />
        <ToolbarButton icon={<RotateCw size={15} />} label={tr('Neu laden', 'Reload')} disabled={!nameRef.current} onClick={() => void reload()} />
      </Toolbar>
      {scheduler !== null && scheduler.toUpperCase() !== 'ON' && (
        <div className="ks-dsg-banner">
          <TriangleAlert size={15} />
          <span>
            {tr('Der Ereignisplaner des Servers ist ausgeschaltet ({s}) – Ereignisse werden nicht ausgeführt.', 'The server event scheduler is off ({s}) – events are not executed.', {
              s: scheduler
            })}
          </span>
          <span className="spacer" />
          {scheduler.toUpperCase() !== 'DISABLED' && (
            <Button size="sm" icon={<Power size={13} />} onClick={() => void enableScheduler()}>
              {tr('Aktivieren', 'Enable')}
            </Button>
          )}
        </div>
      )}
      <TabStrip<Section>
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'definition', label: tr('Definition', 'Definition') },
          { id: 'schedule', label: tr('Zeitplan', 'Schedule') },
          { id: 'advanced', label: tr('Erweitert', 'Advanced') },
          { id: 'sql', label: tr('SQL-Vorschau', 'SQL Preview') }
        ]}
      />
      <div className="ks-dsg-body">
        {section === 'definition' && (
          <div className="ks-dsg-editor">
            <SqlEditor value={def.body} onChange={(body) => set({ body })} completion={{ connectionId: cid, database: db }} />
          </div>
        )}
        {section === 'schedule' && (
          <div className="ks-dsg-scroll">
            <div className="ks-dsg-form">
              <Field label={tr('Ausführung', 'Execution')} labelWidth={LW}>
                <RadioGroup<EventDef['scheduleType']>
                  inline
                  value={def.scheduleType}
                  onChange={(scheduleType) => set({ scheduleType, at: scheduleType === 'AT' && !def.at ? now() : def.at })}
                  options={[
                    { value: 'AT', label: tr('Einmalig (AT)', 'Once (AT)') },
                    { value: 'EVERY', label: tr('Wiederkehrend (EVERY)', 'Recurring (EVERY)') }
                  ]}
                />
              </Field>
              {def.scheduleType === 'AT' ? (
                <Section title={tr('Zeitpunkt', 'Time')}>
                  <TimestampField label="AT" value={def.at} onChange={(at) => set({ at })} />
                  <IntervalList value={def.atIntervals} onChange={(atIntervals) => set({ atIntervals })} />
                </Section>
              ) : (
                <>
                  <Section title={tr('Intervall', 'Interval')}>
                    <Field label="EVERY" labelWidth={LW} hint={tr('Zusammengesetzte Einheiten z. B. 1:30 bei HOUR_MINUTE', "Compound units e.g. 1:30 for HOUR_MINUTE")}>
                      <IntervalInput value={def.every} onChange={(every) => set({ every })} />
                    </Field>
                  </Section>
                  <Section title={tr('Beginn', 'Starts')}>
                    <Checkbox
                      checked={!!def.starts}
                      label={tr('Beginn festlegen (STARTS)', 'Set start (STARTS)')}
                      onChange={(v) => set({ starts: v ? now() : '', startsIntervals: v ? def.startsIntervals : [] })}
                    />
                    {!!def.starts && (
                      <>
                        <TimestampField label="STARTS" value={def.starts} onChange={(starts) => set({ starts })} />
                        <IntervalList value={def.startsIntervals} onChange={(startsIntervals) => set({ startsIntervals })} />
                      </>
                    )}
                  </Section>
                  <Section title={tr('Ende', 'Ends')}>
                    <Checkbox
                      checked={!!def.ends}
                      label={tr('Ende festlegen (ENDS)', 'Set end (ENDS)')}
                      onChange={(v) => set({ ends: v ? now() : '', endsIntervals: v ? def.endsIntervals : [] })}
                    />
                    {!!def.ends && (
                      <>
                        <TimestampField label="ENDS" value={def.ends} onChange={(ends) => set({ ends })} />
                        <IntervalList value={def.endsIntervals} onChange={(endsIntervals) => set({ endsIntervals })} />
                      </>
                    )}
                  </Section>
                </>
              )}
            </div>
          </div>
        )}
        {section === 'advanced' && (
          <div className="ks-dsg-scroll">
            <div className="ks-dsg-form">
              <Section title={tr('Ereignis', 'Event')}>
                <Field label={tr('Name', 'Name')} labelWidth={LW} hint={nameRef.current ? tr('Eine Änderung benennt das Ereignis beim Speichern um', 'A change renames the event on save') : undefined}>
                  <TextInput value={def.name} spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <Field label={tr('Status', 'Status')} labelWidth={LW}>
                  <Select<EventStatusKind>
                    style={{ width: 260 }}
                    value={def.status}
                    onChange={(status) => set({ status })}
                    options={[
                      { value: 'ENABLE', label: tr('Aktiviert (ENABLE)', 'Enabled (ENABLE)') },
                      { value: 'DISABLE', label: tr('Deaktiviert (DISABLE)', 'Disabled (DISABLE)') },
                      { value: 'DISABLE ON SLAVE', label: tr('Auf Replikat deaktiviert', 'Disabled on replica') }
                    ]}
                  />
                </Field>
                <Field label={tr('Nach Abschluss', 'On completion')} labelWidth={LW}>
                  <RadioGroup
                    inline
                    value={def.preserve ? 'p' : 'n'}
                    onChange={(v) => set({ preserve: v === 'p' })}
                    options={[
                      { value: 'n', label: tr('Löschen (NOT PRESERVE)', 'Drop (NOT PRESERVE)') },
                      { value: 'p', label: tr('Behalten (PRESERVE)', 'Keep (PRESERVE)') }
                    ]}
                  />
                </Field>
                <Field label="Definer" labelWidth={LW} hint={tr('benutzer@host, leer = aktueller Benutzer', 'user@host, empty = current user')}>
                  <TextInput value={def.definer} placeholder="root@localhost" onChange={(e) => set({ definer: e.target.value })} />
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
        <CalendarClock size={13} />
        <span>
          {nameRef.current ?? tr('Neues Ereignis', 'New event')} @{db}
        </span>
        {dirty && <span className="ks-dsg-status-dirty">{tr('Geändert', 'Modified')}</span>}
      </div>
    </div>
  );
}

function TimestampField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} labelWidth={LW} hint={tr('JJJJ-MM-TT HH:MM:SS oder CURRENT_TIMESTAMP', 'YYYY-MM-DD HH:MM:SS or CURRENT_TIMESTAMP')}>
      <div className="row">
        <TextInput className="mono" style={{ width: 240 }} value={value} onChange={(e) => onChange(e.target.value)} />
        <Button size="sm" onClick={() => onChange(now())}>
          {tr('Jetzt', 'Now')}
        </Button>
        <Button size="sm" onClick={() => onChange('CURRENT_TIMESTAMP')}>
          CURRENT_TIMESTAMP
        </Button>
      </div>
    </Field>
  );
}

function IntervalInput({ value, onChange }: { value: IntervalDef; onChange: (v: IntervalDef) => void }) {
  return (
    <div className="row">
      <TextInput className="mono" style={{ width: 110 }} value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} />
      <Select<IntervalUnit> style={{ width: 160 }} value={value.unit} onChange={(unit) => onChange({ ...value, unit })} options={INTERVAL_UNITS} />
    </div>
  );
}

function IntervalList({ value, onChange }: { value: IntervalDef[]; onChange: (v: IntervalDef[]) => void }) {
  return (
    <>
      {value.map((iv, i) => (
        <Field key={i} label="+ INTERVAL" labelWidth={LW}>
          <div className="row">
            <IntervalInput value={iv} onChange={(v) => onChange(value.map((x, k) => (k === i ? v : x)))} />
            <IconButton icon={<Trash2 size={14} />} title={tr('Intervall entfernen', 'Remove interval')} onClick={() => onChange(value.filter((_, k) => k !== i))} />
          </div>
        </Field>
      ))}
      <Field label="" labelWidth={LW}>
        <div>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => onChange([...value, { value: '1', unit: 'DAY' }])}>
            {tr('Intervall addieren', 'Add interval')}
          </Button>
        </div>
      </Field>
    </>
  );
}

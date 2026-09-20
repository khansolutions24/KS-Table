// Pages of the automation job editor: steps, schedule, notification, history.

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Copy, Database, FileCode, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import type {
  AutomationEnvironment,
  AutomationJob,
  JobEmail,
  JobSchedule,
  JobStep,
  RunRecord,
  RunSummary,
  ScheduleType,
  WindowsTaskState
} from '@shared/apis/automation';
import type { ProfileInfo } from '@shared/apis/profiles';
import type { SmtpSettings } from '@shared/types';
import { defaultStepName, KNOWN_PROFILE_KINDS, profileKindLabel, runStatusLabel, stepKindLabel, stepStatusLabel, triggerLabel } from '@shared/automation/labels';
import { describeSchedule, formatStart, nextRun, weekdayName } from '@shared/automation/schedule';
import { defaultBackupOptions } from '@shared/backup/options';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { formatDuration, formatDateTime } from '@shared/util';
import { api, errorMessage } from '../../api/client';
import { ObjIcon } from '../../components/icons';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { toast } from '../../components/Toast';
import { confirmDialog, errorDialog, promptDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, Field, IconButton, NumberInput, RadioGroup, Section, Select, Spinner, TextArea, TextInput } from '../../components/ui/controls';
import { showMenuBelow } from '../../components/ui/Menu';
import { PathInput } from '../../components/ui/PathInput';
import { useSettings } from '../../store/settings';
import { getProfile, queriesDir, useWorkspace } from '../../store/workspace';
import { BackupOptionsForm } from '../backup/parts';

const LW = 150;

export const connName = (id: string): string => getProfile(id)?.name ?? id;
export const stepTitle = (s: JobStep): string => s.name.trim() || defaultStepName(s, connName);

// ───────────────────────── Steps ─────────────────────────

function newStep(kind: JobStep['kind'], connectionId: string, database: string): JobStep {
  const base = { id: newId('s'), name: '', enabled: true, continueOnError: false };
  if (kind === 'sql') return { ...base, kind, connectionId, database, source: 'text', sql: '', file: '' };
  if (kind === 'backup') return { ...base, kind, connectionId, database, options: defaultBackupOptions() };
  return { ...base, kind, profileKind: 'backup', profileName: '' };
}

function stepIcon(s: JobStep) {
  if (s.kind === 'sql') return <FileCode size={15} style={{ color: 'var(--c-query)', flex: 'none' }} />;
  if (s.kind === 'backup') return <ObjIcon kind="backup" size={15} />;
  return <ObjIcon kind="automation" size={15} />;
}

/** Databases of a connection: from the open navigator connection or fetched with the saved profile. */
function useDatabases(connectionId: string): { list: string[]; loading: boolean; reload: () => void } {
  const open = useWorkspace((s) => s.conns[connectionId]?.databases);
  const [fetched, setFetched] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const reload = () => {
    const p = getProfile(connectionId);
    if (!p) return;
    setLoading(true);
    api.connections
      .listDatabases(p)
      .then(setFetched)
      .catch(() => setFetched([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    setFetched([]);
    if (connectionId && !open?.length) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);
  const list = open?.length ? open.map((d) => d.name) : fetched;
  return { list, loading, reload };
}

function ConnectionDatabase({
  connectionId,
  database,
  onChange,
  requireDatabase
}: {
  connectionId: string;
  database: string;
  onChange: (cid: string, db: string) => void;
  requireDatabase?: boolean;
}) {
  const profiles = useWorkspace((s) => s.profiles);
  const dbs = useDatabases(connectionId);
  const listId = `ks-auto-dbs-${connectionId}`;
  return (
    <>
      <Field label={tr('Verbindung', 'Connection')} labelWidth={LW}>
        <Select
          value={connectionId}
          onChange={(v) => onChange(v, '')}
          options={[{ value: '', label: tr('(Verbindung wählen)', '(choose connection)') }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
        />
      </Field>
      <Field label={tr('Datenbank', 'Database')} labelWidth={LW} hint={!requireDatabase ? tr('Leer = keine Standarddatenbank', 'Empty = no default database') : undefined}>
        <div className="row">
          <TextInput list={listId} value={database} invalid={!!requireDatabase && !database} onChange={(e) => onChange(connectionId, e.target.value)} />
          <datalist id={listId}>
            {dbs.list.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <IconButton icon={dbs.loading ? <Spinner size={13} /> : <RefreshCw size={14} />} title={tr('Datenbanken abrufen', 'Fetch databases')} disabled={!connectionId} onClick={dbs.reload} />
        </div>
      </Field>
    </>
  );
}

function ProfileStepForm({ step, onChange, kinds }: { step: Extract<JobStep, { kind: 'profile' }>; onChange: (s: JobStep) => void; kinds: string[] }) {
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  useEffect(() => {
    setProfiles(null);
    if (!step.profileKind) return;
    void api.profiles.list(step.profileKind).then(setProfiles, () => setProfiles([]));
  }, [step.profileKind]);
  const allKinds = [...new Set([...KNOWN_PROFILE_KINDS, ...kinds, step.profileKind].filter(Boolean))];
  const available = kinds.includes(step.profileKind);
  const names = profiles?.map((p) => p.name) ?? [];
  if (step.profileName && !names.includes(step.profileName)) names.push(step.profileName);
  return (
    <>
      <Field label={tr('Profiltyp', 'Profile type')} labelWidth={LW}>
        <Select
          value={step.profileKind}
          onChange={(profileKind) => onChange({ ...step, profileKind, profileName: '' })}
          options={allKinds.map((k) => ({ value: k, label: kinds.includes(k) ? profileKindLabel(k) : `${profileKindLabel(k)} ${tr('(nicht verfügbar)', '(not available)')}` }))}
        />
      </Field>
      {!available && (
        <div className="danger-text">
          {tr('Für diesen Profiltyp ist in dieser Version kein Ausführungsmodul vorhanden – der Schritt schlägt fehl.', 'No runner exists for this profile type in this version – the step will fail.')}
        </div>
      )}
      <Field label={tr('Profil', 'Profile')} labelWidth={LW}>
        <div className="row">
          <Select
            value={step.profileName}
            onChange={(profileName) => onChange({ ...step, profileName })}
            options={[{ value: '', label: profiles === null ? tr('Lade …', 'Loading …') : tr('(Profil wählen)', '(choose profile)') }, ...names.map((n) => ({ value: n, label: n }))]}
          />
          <IconButton
            icon={<RefreshCw size={14} />}
            title={tr('Aktualisieren', 'Refresh')}
            onClick={() => void api.profiles.list(step.profileKind).then(setProfiles, () => setProfiles([]))}
          />
        </div>
      </Field>
      {profiles !== null && !profiles.length && (
        <div className="ks-automation-hint">
          {tr('Es gibt noch keine gespeicherten Profile dieses Typs. Profile werden im jeweiligen Assistenten gespeichert.', 'There are no saved profiles of this type yet. Profiles are saved in the respective wizard.')}
        </div>
      )}
    </>
  );
}

function SqlStepForm({ step, onChange }: { step: Extract<JobStep, { kind: 'sql' }>; onChange: (s: JobStep) => void }) {
  const profilesDir = useWorkspace((s) => s.profilesDir);
  const pickSaved = async (el: HTMLElement) => {
    if (!step.connectionId || !step.database) {
      toast(tr('Bitte zuerst Verbindung und Datenbank wählen.', 'Please choose connection and database first.'));
      return;
    }
    const files = (await api.fs.list(queriesDir(profilesDir, step.connectionId, step.database))).filter((f) => !f.isDir && f.name.toLowerCase().endsWith('.sql'));
    showMenuBelow(
      el,
      files.length
        ? files.map((f) => ({ label: f.name.replace(/\.sql$/i, ''), icon: <ObjIcon kind="query" size={14} />, onClick: () => onChange({ ...step, source: 'file', file: f.path }) }))
        : [{ label: tr('Keine gespeicherten Abfragen', 'No saved queries'), disabled: true }]
    );
  };
  return (
    <>
      <ConnectionDatabase connectionId={step.connectionId} database={step.database} onChange={(connectionId, database) => onChange({ ...step, connectionId, database })} />
      <Field label={tr('Quelle', 'Source')} labelWidth={LW}>
        <RadioGroup
          inline
          value={step.source}
          onChange={(source) => onChange({ ...step, source })}
          options={[
            { value: 'text', label: tr('SQL-Text', 'SQL text') },
            { value: 'file', label: tr('SQL-Datei / gespeicherte Abfrage', 'SQL file / saved query') }
          ]}
        />
      </Field>
      {step.source === 'text' ? (
        <div className="ks-automation-sql">
          <SqlEditor value={step.sql} onChange={(sql) => onChange({ ...step, sql })} completion={step.connectionId ? { connectionId: step.connectionId, database: step.database || null } : null} />
        </div>
      ) : (
        <Field label={tr('Datei', 'File')} labelWidth={LW} hint={tr('Die Datei wird bei jeder Ausführung neu gelesen.', 'The file is read again on every run.')}>
          <div className="row">
            <PathInput value={step.file} onChange={(file) => onChange({ ...step, file })} filters={[{ name: 'SQL', extensions: ['sql'] }]} />
            <Button icon={<Database size={14} />} onClick={(e) => void pickSaved(e.currentTarget).catch((err) => void errorDialog(err))}>
              {tr('Gespeicherte Abfrage', 'Saved query')}
            </Button>
          </div>
        </Field>
      )}
    </>
  );
}

export function StepsPage({ job, onChange, kinds }: { job: AutomationJob; onChange: (steps: JobStep[]) => void; kinds: string[] }) {
  const [selId, setSelId] = useState<string | null>(job.steps[0]?.id ?? null);
  const idx = job.steps.findIndex((s) => s.id === selId);
  const step = idx >= 0 ? job.steps[idx] : null;

  useEffect(() => {
    if (!job.steps.some((s) => s.id === selId)) setSelId(job.steps[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, job.steps.length]);

  const update = (s: JobStep) => onChange(job.steps.map((x) => (x.id === s.id ? s : x)));
  const add = (kind: JobStep['kind']) => {
    const last = [...job.steps].reverse().find((s) => s.kind !== 'profile') as Extract<JobStep, { connectionId: string }> | undefined;
    const s = newStep(kind, last?.connectionId ?? useWorkspace.getState().profiles[0]?.id ?? '', last?.database ?? '');
    const at = idx >= 0 ? idx + 1 : job.steps.length;
    onChange([...job.steps.slice(0, at), s, ...job.steps.slice(at)]);
    setSelId(s.id);
  };
  const move = (d: -1 | 1) => {
    if (idx < 0 || idx + d < 0 || idx + d >= job.steps.length) return;
    const a = [...job.steps];
    [a[idx], a[idx + d]] = [a[idx + d], a[idx]];
    onChange(a);
  };
  const remove = async () => {
    if (!step) return;
    if (!(await confirmDialog({ message: tr('Schritt „{s}“ entfernen?', 'Remove step "{s}"?', { s: stepTitle(step) }), okLabel: tr('Entfernen', 'Remove'), danger: true }))) return;
    const next = job.steps.filter((s) => s.id !== step.id);
    onChange(next);
    setSelId(next[Math.min(idx, next.length - 1)]?.id ?? null);
  };
  const duplicate = () => {
    if (!step) return;
    const copy = { ...structuredClone(step), id: newId('s'), name: step.name ? `${step.name} (2)` : '' };
    onChange([...job.steps.slice(0, idx + 1), copy, ...job.steps.slice(idx + 1)]);
    setSelId(copy.id);
  };

  return (
    <div className="ks-automation-page fill">
      <div className="ks-automation-steps">
        <div className="ks-automation-steplist">
          <div className="row">
            <Button
              size="sm"
              variant="primary"
              icon={<Plus size={13} />}
              onClick={(e) =>
                showMenuBelow(e.currentTarget, [
                  { label: stepKindLabel('sql'), icon: <FileCode size={14} />, onClick: () => add('sql') },
                  { label: stepKindLabel('backup'), icon: <ObjIcon kind="backup" size={14} />, onClick: () => add('backup') },
                  { label: stepKindLabel('profile'), icon: <ObjIcon kind="automation" size={14} />, onClick: () => add('profile') }
                ])
              }
            >
              {tr('Schritt', 'Step')}
            </Button>
            <div className="spacer" />
            <IconButton icon={<ArrowUp size={14} />} title={tr('Nach oben', 'Move up')} disabled={idx <= 0} onClick={() => move(-1)} />
            <IconButton icon={<ArrowDown size={14} />} title={tr('Nach unten', 'Move down')} disabled={idx < 0 || idx >= job.steps.length - 1} onClick={() => move(1)} />
            <IconButton icon={<Copy size={14} />} title={tr('Duplizieren', 'Duplicate')} disabled={!step} onClick={duplicate} />
            <IconButton icon={<Trash2 size={14} />} title={tr('Entfernen', 'Remove')} disabled={!step} onClick={() => void remove()} />
          </div>
          <div
            className="ks-automation-steprows"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                const n = Math.max(0, Math.min(job.steps.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
                if (job.steps[n]) setSelId(job.steps[n].id);
              } else if (e.key === 'Delete' && step) {
                e.stopPropagation();
                void remove();
              }
            }}
          >
            {job.steps.map((s, i) => (
              <div key={s.id} className={clsx('ks-automation-step', s.id === selId && 'selected', !s.enabled && 'disabled')} onMouseDown={() => setSelId(s.id)}>
                <span className="ks-automation-step-no">{i + 1}</span>
                <Checkbox checked={s.enabled} onChange={(enabled) => update({ ...s, enabled })} title={tr('Aktiv', 'Enabled')} />
                {stepIcon(s)}
                <span className="ks-automation-step-name ellipsis" title={stepTitle(s)}>
                  {stepTitle(s)}
                </span>
              </div>
            ))}
            {!job.steps.length && <div className="faint" style={{ padding: 10 }}>{tr('Noch keine Schritte. Fügen Sie mit „+ Schritt“ einen hinzu.', 'No steps yet. Add one with "+ Step".')}</div>}
          </div>
          <div className="ks-automation-hint">
            {tr('Die Schritte werden von oben nach unten ausgeführt. Bei einem Fehler endet der Auftrag, außer „Bei Fehler fortfahren“ ist gesetzt.', 'Steps run from top to bottom. On an error the job stops unless "Continue on error" is set.')}
          </div>
        </div>
        <div className="ks-automation-stepform">
          {step ? (
            <>
              <Section title={stepKindLabel(step.kind)}>
                <Field label={tr('Name', 'Name')} labelWidth={LW}>
                  <TextInput value={step.name} placeholder={defaultStepName(step, connName)} onChange={(e) => update({ ...step, name: e.target.value })} />
                </Field>
                <Field label="" labelWidth={LW}>
                  <div className="row" style={{ gap: 16 }}>
                    <Checkbox checked={step.enabled} onChange={(enabled) => update({ ...step, enabled })} label={tr('Aktiv', 'Enabled')} />
                    <Checkbox checked={step.continueOnError} onChange={(continueOnError) => update({ ...step, continueOnError })} label={tr('Bei Fehler fortfahren', 'Continue on error')} />
                  </div>
                </Field>
                {step.kind === 'sql' && <SqlStepForm step={step} onChange={update} />}
                {step.kind === 'profile' && <ProfileStepForm step={step} onChange={update} kinds={kinds} />}
                {step.kind === 'backup' && (
                  <ConnectionDatabase connectionId={step.connectionId} database={step.database} requireDatabase onChange={(connectionId, database) => update({ ...step, connectionId, database })} />
                )}
              </Section>
              {step.kind === 'backup' && step.connectionId && step.database && (
                <BackupOptionsForm compact connectionId={step.connectionId} database={step.database} value={step.options} onChange={(options) => update({ ...step, options })} />
              )}
            </>
          ) : (
            <div className="faint">{tr('Kein Schritt ausgewählt', 'No step selected')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Schedule ─────────────────────────

const toDateInput = (s: string) => s.slice(0, 16);

export function SchedulePage({
  job,
  onChange,
  env,
  winTask,
  dirty
}: {
  job: AutomationJob;
  onChange: (s: JobSchedule) => void;
  env: AutomationEnvironment | null;
  winTask: WindowsTaskState | null | undefined;
  dirty: boolean;
}) {
  const sc = job.schedule;
  const set = (patch: Partial<JobSchedule>) => onChange({ ...sc, ...patch });
  const off = !sc.enabled;
  const upcoming = useMemo(() => {
    if (!sc.enabled) return [];
    const out: number[] = [];
    let t = Date.now();
    for (let i = 0; i < 5; i++) {
      const n = nextRun(sc, t);
      if (n === null) break;
      out.push(n);
      t = n;
    }
    return out;
  }, [sc]);
  const toggle = (arr: number[], v: number) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const unit: Record<ScheduleType, string> = {
    once: '',
    minutes: tr('Minuten', 'minutes'),
    hourly: tr('Stunden', 'hours'),
    daily: tr('Tage', 'days'),
    weekly: tr('Wochen', 'weeks'),
    monthly: tr('Monate', 'months')
  };
  const windowsAvailable = !!env?.windowsTasks;

  return (
    <div className="ks-automation-page">
      <Checkbox checked={sc.enabled} onChange={(enabled) => set({ enabled })} label={tr('Auftrag nach Zeitplan ausführen', 'Run job on a schedule')} />
      <Section title={tr('Ausführung durch', 'Run by')}>
        <RadioGroup
          value={sc.runner}
          disabled={off}
          onChange={(runner) => set({ runner })}
          options={[
            { value: 'app', label: tr('KS Table (nur solange das Programm geöffnet ist)', 'KS Table (only while the application is open)') },
            {
              value: 'windows',
              label: tr('Windows-Aufgabenplanung (auch wenn KS Table geschlossen ist)', 'Windows Task Scheduler (also when KS Table is closed)'),
              disabled: !windowsAvailable && sc.runner !== 'windows'
            }
          ]}
        />
        {env && !env.windowsTasks && <div className="ks-automation-hint">{env.windowsReason}</div>}
        {sc.runner === 'windows' && (
          <>
            <Checkbox
              disabled={off}
              checked={sc.runWhenLoggedOff}
              onChange={(runWhenLoggedOff) => set({ runWhenLoggedOff })}
              label={tr('Auch ausführen, wenn der Benutzer nicht angemeldet ist (erfordert Administratorrechte)', 'Run whether the user is logged on or not (requires administrator rights)')}
            />
            <div className="ks-automation-hint">
              {tr(
                'Beim Speichern wird eine Aufgabe in der Windows-Aufgabenplanung angelegt, die KS Table mit „--run-job“ startet. Verbindungspasswörter müssen gespeichert sein.',
                'Saving creates a task in the Windows Task Scheduler that starts KS Table with "--run-job". Connection passwords must be saved.'
              )}
              {env?.launchCommand && (
                <>
                  <br />
                  <span className="mono selectable">{env.launchCommand.replace('<id>', job.id)}</span>
                </>
              )}
            </div>
            {winTask !== undefined && (
              <div className={winTask?.exists ? 'success-text' : 'muted'}>
                {winTask
                  ? winTask.exists
                    ? tr('Windows-Aufgabe „{n}“ ist eingerichtet.', 'Windows task "{n}" is registered.', { n: winTask.name })
                    : tr('Windows-Aufgabe „{n}“ fehlt – erneut speichern, um sie anzulegen.', 'Windows task "{n}" is missing – save again to create it.', { n: winTask.name })
                  : tr('Noch keine Windows-Aufgabe angelegt.', 'No Windows task registered yet.')}
                {dirty && ` ${tr('(Änderungen werden beim Speichern übernommen)', '(changes apply when saving)')}`}
              </div>
            )}
          </>
        )}
      </Section>
      <Section title={tr('Zeitplan', 'Schedule')}>
        <Field label={tr('Wiederholung', 'Recurrence')} labelWidth={LW}>
          <Select
            disabled={off}
            style={{ width: 220 }}
            value={sc.type}
            onChange={(type) => set({ type })}
            options={[
              { value: 'once', label: tr('Einmalig', 'Once') },
              { value: 'minutes', label: tr('Alle N Minuten', 'Every N minutes') },
              { value: 'hourly', label: tr('Stündlich', 'Hourly') },
              { value: 'daily', label: tr('Täglich', 'Daily') },
              { value: 'weekly', label: tr('Wöchentlich', 'Weekly') },
              { value: 'monthly', label: tr('Monatlich', 'Monthly') }
            ]}
          />
        </Field>
        <Field label={sc.type === 'once' ? tr('Zeitpunkt', 'Date and time') : tr('Beginn', 'Start')} labelWidth={LW}>
          <TextInput type="datetime-local" disabled={off} style={{ width: 220 }} value={toDateInput(sc.start)} invalid={!sc.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        {sc.type !== 'once' && (
          <Field label={tr('Intervall', 'Interval')} labelWidth={LW}>
            <div className="row">
              <span>{tr('alle', 'every')}</span>
              <NumberInput disabled={off} style={{ width: 90 }} min={1} max={9999} value={sc.interval} onChange={(v) => set({ interval: v === '' ? 1 : Math.max(1, Math.floor(v)) })} />
              <span>{unit[sc.type]}</span>
            </div>
          </Field>
        )}
        {sc.type === 'weekly' && (
          <Field label={tr('Wochentage', 'Weekdays')} labelWidth={LW}>
            <div className="ks-automation-days">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button key={d} type="button" disabled={off} className={clsx('ks-automation-day', sc.weekdays.includes(d) && 'on')} onClick={() => set({ weekdays: toggle(sc.weekdays, d) })}>
                  {weekdayName(d)}
                </button>
              ))}
            </div>
          </Field>
        )}
        {sc.type === 'monthly' && (
          <Field label={tr('Tage im Monat', 'Days of month')} labelWidth={LW} alignTop hint={tr('Tage, die ein Monat nicht hat, werden übersprungen.', 'Days a month does not have are skipped.')}>
            <div className="ks-automation-days" style={{ maxWidth: 300 }}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <button key={d} type="button" disabled={off} className={clsx('ks-automation-day', sc.monthDays.includes(d) && 'on')} onClick={() => set({ monthDays: toggle(sc.monthDays, d) })}>
                  {d}
                </button>
              ))}
            </div>
          </Field>
        )}
        {sc.type !== 'once' && (
          <Field label={tr('Ende', 'End')} labelWidth={LW} hint={tr('Leer = kein Ende', 'Empty = no end')}>
            <TextInput type="date" disabled={off} style={{ width: 220 }} value={sc.end} onChange={(e) => set({ end: e.target.value })} />
          </Field>
        )}
      </Section>
      {sc.enabled && (
        <Section title={tr('Vorschau', 'Preview')}>
          <div>{describeSchedule(sc)}</div>
          {upcoming.length ? (
            <ul className="ks-automation-next">
              {upcoming.map((t) => (
                <li key={t}>{formatStart(t)}</li>
              ))}
            </ul>
          ) : (
            <div className="muted">{tr('Keine weiteren Ausführungen', 'No further runs')}</div>
          )}
        </Section>
      )}
    </div>
  );
}

// ───────────────────────── Notification ─────────────────────────

function SmtpSection() {
  const saved = useSettings((s) => s.settings.smtp);
  const [smtp, setSmtp] = useState<SmtpSettings>(saved);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  useEffect(() => setSmtp(saved), [saved]);
  const dirty = JSON.stringify(smtp) !== JSON.stringify(saved);
  const set = (patch: Partial<SmtpSettings>) => setSmtp((s) => ({ ...s, ...patch }));
  const save = async () => {
    setBusy('save');
    try {
      await useSettings.getState().update({ smtp });
      toast(tr('E-Mail-Einstellungen gespeichert', 'E-mail settings saved'), 'success');
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    const to = await promptDialog({
      title: tr('Test-E-Mail senden', 'Send test e-mail'),
      label: tr('Empfänger:', 'Recipient:'),
      value: smtp.from || smtp.user,
      validate: (v) => (/\S+@\S+/.test(v) ? null : tr('Bitte eine gültige Adresse eingeben.', 'Please enter a valid address.'))
    });
    if (!to) return;
    setBusy('test');
    try {
      await api.automation.sendTestMail(to, smtp);
      toast(tr('Test-E-Mail an {to} gesendet', 'Test e-mail sent to {to}', { to }), 'success');
    } catch (e) {
      void errorDialog(e, tr('Test-E-Mail fehlgeschlagen', 'Test e-mail failed'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title={tr('E-Mail-Einstellungen (SMTP, für alle Aufträge)', 'E-mail settings (SMTP, for all jobs)')}>
      <Field label={tr('SMTP-Server', 'SMTP server')} labelWidth={LW}>
        <div className="row">
          <TextInput value={smtp.host} placeholder="smtp.example.com" onChange={(e) => set({ host: e.target.value })} />
          <span>{tr('Port', 'Port')}</span>
          <NumberInput style={{ width: 90 }} min={1} max={65535} value={smtp.port} onChange={(v) => set({ port: v === '' ? 587 : v })} />
        </div>
      </Field>
      <Field label={tr('Verschlüsselung', 'Encryption')} labelWidth={LW}>
        <RadioGroup
          inline
          value={smtp.secure ? 'ssl' : 'starttls'}
          onChange={(v) => set({ secure: v === 'ssl', port: v === 'ssl' && smtp.port === 587 ? 465 : v !== 'ssl' && smtp.port === 465 ? 587 : smtp.port })}
          options={[
            { value: 'starttls', label: tr('STARTTLS / keine (meist Port 587 oder 25)', 'STARTTLS / none (usually port 587 or 25)') },
            { value: 'ssl', label: tr('SSL/TLS (meist Port 465)', 'SSL/TLS (usually port 465)') }
          ]}
        />
      </Field>
      <Field label={tr('Benutzername', 'User name')} labelWidth={LW} hint={tr('Leer = ohne Anmeldung', 'Empty = no authentication')}>
        <TextInput value={smtp.user} autoComplete="off" onChange={(e) => set({ user: e.target.value })} />
      </Field>
      <Field label={tr('Passwort', 'Password')} labelWidth={LW}>
        <TextInput type="password" autoComplete="new-password" value={smtp.password ?? ''} onChange={(e) => set({ password: e.target.value })} />
      </Field>
      <Field label={tr('Absender', 'Sender')} labelWidth={LW}>
        <TextInput value={smtp.from} placeholder="KS Table <backup@example.com>" onChange={(e) => set({ from: e.target.value })} />
      </Field>
      <Field label="" labelWidth={LW}>
        <div className="row">
          <Button variant="primary" disabled={!dirty || !!busy} icon={busy === 'save' ? <Spinner size={13} /> : undefined} onClick={() => void save()}>
            {tr('Einstellungen speichern', 'Save settings')}
          </Button>
          <Button disabled={!!busy || !smtp.host} icon={busy === 'test' ? <Spinner size={13} /> : <Send size={14} />} onClick={() => void test()}>
            {tr('Test-E-Mail senden', 'Send test e-mail')}
          </Button>
        </div>
      </Field>
    </Section>
  );
}

export function MailPage({ job, onChange }: { job: AutomationJob; onChange: (e: JobEmail) => void }) {
  const em = job.email;
  const set = (patch: Partial<JobEmail>) => onChange({ ...em, ...patch });
  const off = !em.enabled;
  return (
    <div className="ks-automation-page">
      <Checkbox checked={em.enabled} onChange={(enabled) => set({ enabled })} label={tr('Nach der Ausführung eine E-Mail senden', 'Send an e-mail after the run')} />
      <Section title={tr('Benachrichtigung', 'Notification')}>
        <Field label={tr('Senden bei', 'Send on')} labelWidth={LW}>
          <div className="row" style={{ gap: 16 }}>
            <Checkbox disabled={off} checked={em.onSuccess} onChange={(onSuccess) => set({ onSuccess })} label={tr('Erfolg', 'Success')} />
            <Checkbox disabled={off} checked={em.onFailure} onChange={(onFailure) => set({ onFailure })} label={tr('Fehler oder Abbruch', 'Failure or cancellation')} />
          </div>
        </Field>
        <Field label={tr('An', 'To')} labelWidth={LW} hint={tr('Mehrere Adressen mit Komma oder Semikolon trennen', 'Separate several addresses with comma or semicolon')}>
          <TextInput disabled={off} value={em.to} invalid={em.enabled && !em.to.trim()} onChange={(e) => set({ to: e.target.value })} />
        </Field>
        <Field label={tr('Kopie (CC)', 'CC')} labelWidth={LW}>
          <TextInput disabled={off} value={em.cc} onChange={(e) => set({ cc: e.target.value })} />
        </Field>
        <Field label={tr('Betreff', 'Subject')} labelWidth={LW}>
          <TextInput disabled={off} value={em.subject} onChange={(e) => set({ subject: e.target.value })} />
        </Field>
        <Field
          label={tr('Text', 'Body')}
          labelWidth={LW}
          alignTop
          hint={tr('Platzhalter: {job} {status} {start} {end} {duration} {host} {trigger} {steps}', 'Placeholders: {job} {status} {start} {end} {duration} {host} {trigger} {steps}')}
        >
          <TextArea disabled={off} rows={7} value={em.body} onChange={(e) => set({ body: e.target.value })} />
        </Field>
        <Field label="" labelWidth={LW}>
          <Checkbox disabled={off} checked={em.attachLog} onChange={(attachLog) => set({ attachLog })} label={tr('Protokoll als Anhang senden', 'Attach the log')} />
        </Field>
      </Section>
      <SmtpSection />
    </div>
  );
}

// ───────────────────────── History ─────────────────────────

export function RunStatus({ status }: { status: RunSummary['status'] }) {
  return <span className={`ks-automation-status ${status}`}>{runStatusLabel(status)}</span>;
}

export function HistoryPage({ job, refreshKey, onCleared }: { job: AutomationJob; refreshKey: number; onCleared: () => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [rec, setRec] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.automation
      .runs(job.id)
      .then((r) => {
        setRuns(r);
        setSel((s) => (s && r.some((x) => x.runId === s) ? s : (r[0]?.runId ?? null)));
      })
      .catch((e) => {
        setRuns([]);
        setError(errorMessage(e));
      });
  };
  useEffect(load, [job.id, refreshKey]);
  useEffect(() => {
    setRec(null);
    if (!sel) return;
    void api.automation.runLog(job.id, sel).then(setRec, (e) => setError(errorMessage(e)));
  }, [job.id, sel]);

  const clear = async () => {
    if (!(await confirmDialog({ message: tr('Den gesamten Ausführungsverlauf dieses Auftrags löschen?', 'Delete the entire run history of this job?'), okLabel: tr('Löschen', 'Delete'), danger: true }))) return;
    try {
      await api.automation.clearRuns(job.id);
      onCleared();
      load();
    } catch (e) {
      void errorDialog(e);
    }
  };

  return (
    <div className="ks-automation-page fill">
      <div className="row">
        <span className="muted">{runs ? tr('{n} Ausführungen', '{n} runs', { n: runs.length }) : tr('Lade …', 'Loading …')}</span>
        <div className="spacer" />
        <Button size="sm" icon={<RefreshCw size={13} />} onClick={load}>
          {tr('Aktualisieren', 'Refresh')}
        </Button>
        <Button size="sm" icon={<Trash2 size={13} />} disabled={!runs?.length} onClick={() => void clear()}>
          {tr('Verlauf löschen', 'Clear history')}
        </Button>
      </div>
      {error && <div className="danger-text">{error}</div>}
      <div className="ks-automation-runs">
        <table className="ks-table">
          <thead>
            <tr>
              <th>{tr('Start', 'Start')}</th>
              <th>{tr('Dauer', 'Duration')}</th>
              <th>{tr('Status', 'Status')}</th>
              <th>{tr('Auslöser', 'Trigger')}</th>
              <th>{tr('Meldung', 'Message')}</th>
            </tr>
          </thead>
          <tbody>
            {runs?.map((r) => (
              <tr key={r.runId} className={r.runId === sel ? 'selected' : ''} onMouseDown={() => setSel(r.runId)}>
                <td>{formatDateTime(r.startedAt)}</td>
                <td className="num">{r.endedAt ? formatDuration(r.endedAt - r.startedAt) : ''}</td>
                <td>
                  <RunStatus status={r.status} />
                </td>
                <td>{triggerLabel(r.trigger)}</td>
                <td title={r.message}>{r.message}</td>
              </tr>
            ))}
            {runs && !runs.length && (
              <tr>
                <td colSpan={5} className="faint">
                  {tr('Der Auftrag wurde noch nicht ausgeführt.', 'The job has not run yet.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="ks-automation-log selectable">
        {rec ? (
          <>
            {rec.steps.map((s) => (
              <div key={s.stepId} className={clsx('ks-task-line', s.status === 'error' ? 'error' : s.status === 'success' ? 'success' : 'warn')}>
                <span className="ks-task-time">{stepStatusLabel(s.status)}</span>
                <span>
                  {s.name}
                  {s.message ? ` – ${s.message}` : ''}
                </span>
              </div>
            ))}
            {rec.mail && (
              <div className="ks-task-line">
                <span className="ks-task-time">{tr('E-Mail', 'E-mail')}</span>
                <span>{rec.mail}</span>
              </div>
            )}
            <div style={{ height: 8 }} />
            {rec.log.map((l, i) => (
              <div key={i} className={clsx('ks-task-line', l.level)}>
                <span className="ks-task-time">{new Date(l.time).toLocaleTimeString()}</span>
                <span>{l.message}</span>
              </div>
            ))}
          </>
        ) : (
          sel && <Spinner />
        )}
      </div>
    </div>
  );
}

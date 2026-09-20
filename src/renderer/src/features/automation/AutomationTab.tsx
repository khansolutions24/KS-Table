// Automation tab: batch jobs with steps, schedule (app / Windows task scheduler), e-mail notification and history.

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { CalendarClock, FolderOpen, History, ListChecks, Mail, Play, Plus, RefreshCw, Save, Settings2, SquareActivity, Trash2 } from 'lucide-react';
import type { AutomationEnvironment, AutomationJob, JobListItem, WindowsTaskState } from '@shared/apis/automation';
import { describeSchedule, formatStart, newJob } from '@shared/automation/schedule';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { uniqueName } from '@shared/util';
import { api, onEvent } from '../../api/client';
import { ObjIcon } from '../../components/icons';
import { TaskPanel } from '../../components/TaskPanel';
import { toast } from '../../components/Toast';
import { alertDialog, askDialog, confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { EmptyState, Field, SearchInput, Section, Spinner, TabStrip, TextArea, TextInput, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { keyCombo } from '../../lib/shortcuts';
import { setCloseGuard, useTabs, type TabProps } from '../../store/tabs';
import { HistoryPage, MailPage, RunStatus, SchedulePage, StepsPage } from './editors';
import './automation.css';

type Page = 'general' | 'steps' | 'schedule' | 'mail' | 'history' | 'run';

const same = (a: AutomationJob | null, b: AutomationJob | null) => JSON.stringify(a) === JSON.stringify(b);

export default function AutomationTab({ tab, active }: TabProps) {
  const [items, setItems] = useState<JobListItem[] | null>(null);
  const [saved, setSaved] = useState<AutomationJob | null>(null);
  const [draft, setDraft] = useState<AutomationJob | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [page, setPage] = useState<Page>('steps');
  const [filter, setFilter] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [env, setEnv] = useState<AutomationEnvironment | null>(null);
  const [winTask, setWinTask] = useState<WindowsTaskState | null | undefined>(undefined);
  const [runTask, setRunTask] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const dirty = !!draft && (isNew || !same(draft, saved));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const reload = useCallback(async () => {
    try {
      setItems(await api.automation.list());
    } catch (e) {
      setItems([]);
      void errorDialog(e);
    }
  }, []);

  useEffect(() => {
    void reload();
    void api.automation.profileKinds().then(setKinds, () => undefined);
    void api.automation.environment().then(setEnv, () => undefined);
    const timer = window.setInterval(() => void reload(), 30_000);
    const off = onEvent('task:update', (t) => {
      if (t.kind !== 'automation') return;
      if (t.status !== 'running') {
        void reload();
        setHistoryKey((k) => k + 1);
      } else void reload();
    });
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [reload]);

  useEffect(() => {
    useTabs.getState().update(tab.id, { dirty });
  }, [dirty, tab.id]);

  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    const a = await askDialog({
      title: tr('Automatisierung', 'Automation'),
      message: tr('Der Auftrag „{n}“ wurde geändert. Änderungen speichern?', 'Job "{n}" was changed. Save changes?', { n: draft?.name ?? '' }),
      yesLabel: tr('Speichern', 'Save'),
      noLabel: tr('Verwerfen', 'Discard')
    });
    if (a === 'cancel') return false;
    if (a === 'yes') return save();
    return true;
  };

  useEffect(() => {
    setCloseGuard(tab.id, confirmDiscard);
    return () => setCloseGuard(tab.id, null);
  });


  const select = async (id: string) => {
    if (draft?.id === id) return;
    if (!(await confirmDiscard())) return;
    try {
      const job = await api.automation.get(id);
      setSaved(job);
      setDraft(structuredClone(job));
      setIsNew(false);
      setRunTask(items?.find((i) => i.job.id === id)?.taskId ?? null);
      if (page === 'run') setPage('steps');
      setWinTask(undefined);
      void api.automation.windowsTask(id).then(setWinTask, () => setWinTask(null));
    } catch (e) {
      void errorDialog(e);
    }
  };

  const create = async () => {
    if (!(await confirmDiscard())) return;
    const job = newJob(newId('j'), uniqueName(tr('Neuer Auftrag', 'New job'), (items ?? []).map((i) => i.job.name)));
    setSaved(null);
    setDraft(job);
    setIsNew(true);
    setRunTask(null);
    setWinTask(null);
    setPage('general');
  };

  async function save(): Promise<boolean> {
    if (!draft) return false;
    if (!draft.name.trim()) {
      setPage('general');
      void alertDialog({ message: tr('Bitte einen Namen für den Auftrag angeben.', 'Please enter a name for the job.'), kind: 'warning' });
      return false;
    }
    if (draft.email.enabled && !draft.email.to.trim()) {
      setPage('mail');
      void alertDialog({ message: tr('Bitte mindestens einen Empfänger für die Benachrichtigung angeben.', 'Please enter at least one recipient for the notification.'), kind: 'warning' });
      return false;
    }
    setBusy(true);
    try {
      const r = await api.automation.save(draft);
      setSaved(r.job);
      setDraft(structuredClone(r.job));
      setIsNew(false);
      await reload();
      if (r.windowsError) {
        void alertDialog({
          kind: 'warning',
          message: tr('Der Auftrag wurde gespeichert, aber die Windows-Aufgabe konnte nicht eingerichtet werden:\n\n{m}', 'The job was saved, but the Windows task could not be set up:\n\n{m}', { m: r.windowsError })
        });
      } else toast(tr('Auftrag „{n}“ gespeichert', 'Job "{n}" saved', { n: r.job.name }), 'success');
      loadWinTaskFor(r.job);
      return true;
    } catch (e) {
      void errorDialog(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const loadWinTaskFor = (job: AutomationJob) => {
    setWinTask(undefined);
    void api.automation.windowsTask(job.id).then(setWinTask, () => setWinTask(null));
  };

  const remove = async () => {
    if (!draft) return;
    if (isNew) {
      setDraft(null);
      setSaved(null);
      setIsNew(false);
      return;
    }
    const ok = await confirmDialog({
      title: tr('Auftrag löschen', 'Delete job'),
      message: saved?.windowsTask
        ? tr('Auftrag „{n}“, seinen Verlauf und die Windows-Aufgabe „{t}“ löschen?', 'Delete job "{n}", its history and the Windows task "{t}"?', { n: draft.name, t: saved.windowsTask })
        : tr('Auftrag „{n}“ und seinen Verlauf löschen?', 'Delete job "{n}" and its history?', { n: draft.name }),
      okLabel: tr('Löschen', 'Delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await api.automation.remove(draft.id);
      setDraft(null);
      setSaved(null);
      await reload();
    } catch (e) {
      void errorDialog(e);
    }
  };

  const run = async () => {
    if (!draft) return;
    if (dirty) {
      const a = await askDialog({
        message: tr('Der Auftrag muss vor der Ausführung gespeichert werden. Jetzt speichern?', 'The job must be saved before running. Save now?'),
        yesLabel: tr('Speichern und ausführen', 'Save and run'),
        noLabel: tr('Gespeicherte Fassung ausführen', 'Run saved version')
      });
      if (a === 'cancel') return;
      if (a === 'yes' && !(await save())) return;
      if (a === 'no' && isNew) return;
    }
    if (!draft.steps.some((s) => s.enabled)) {
      void alertDialog({ message: tr('Der Auftrag enthält keine aktiven Schritte.', 'The job contains no active steps.'), kind: 'warning' });
      return;
    }
    try {
      const id = await api.automation.run(draft.id);
      setRunTask(id);
      setPage('run');
      void reload();
    } catch (e) {
      void errorDialog(e);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = keyCombo(e);
    if (k === 'Ctrl+S') {
      e.preventDefault();
      e.stopPropagation();
      if (dirty && !busy) void save();
    } else if (k === 'F9' && draft) {
      e.preventDefault();
      e.stopPropagation();
      void run();
    }
  };

  const f = filter.trim().toLowerCase();
  const shown = (items ?? []).filter((i) => !f || i.job.name.toLowerCase().includes(f));
  const current = items?.find((i) => i.job.id === draft?.id);
  const running = !!current?.taskId;
  const patch = (p: Partial<AutomationJob>) => setDraft((d) => (d ? { ...d, ...p } : d));

  // the list may show a job that is running because of the in-app scheduler
  useEffect(() => {
    if (current?.taskId && current.taskId !== runTask) setRunTask(current.taskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.taskId]);

  return (
    <div className="ks-automation" onKeyDown={onKeyDown}>
      <Toolbar>
        <ToolbarButton icon={<Plus size={15} />} label={tr('Neuer Auftrag', 'New Job')} onClick={() => void create()} />
        <ToolbarButton icon={busy ? <Spinner size={14} /> : <Save size={15} />} label={tr('Speichern', 'Save')} disabled={!dirty || busy} onClick={() => void save()} title="Ctrl+S" />
        <ToolbarButton icon={<Trash2 size={15} />} label={tr('Löschen', 'Delete')} disabled={!draft || running} onClick={() => void remove()} />
        <ToolbarSep />
        <ToolbarButton icon={<Play size={15} />} label={tr('Jetzt ausführen', 'Run Now')} disabled={!draft || running || busy} onClick={() => void run()} title="F9" />
        <ToolbarSep />
        <ToolbarButton icon={<RefreshCw size={15} />} label={tr('Aktualisieren', 'Refresh')} onClick={() => void reload()} />
        <ToolbarButton
          icon={<FolderOpen size={15} />}
          label={tr('Ordner öffnen', 'Open Folder')}
          disabled={!env}
          onClick={() => env && void api.fs.mkdir(env.folder).then(() => api.app.showItemInFolder(env.folder))}
        />
      </Toolbar>
      <div className="ks-automation-main">
        <div className="ks-automation-list">
          <div className="ks-automation-list-head">
            <SearchInput value={filter} onChange={setFilter} placeholder={tr('Aufträge suchen', 'Search jobs')} />
          </div>
          <div className="ks-automation-jobs" tabIndex={0}>
            {items === null && (
              <div className="row" style={{ padding: 10 }}>
                <Spinner /> {tr('Lade …', 'Loading …')}
              </div>
            )}
            {isNew && draft && (
              <div className="ks-automation-job selected">
                <ObjIcon kind="automation" />
                <div className="ks-automation-job-text">
                  <span className="ks-automation-job-name ellipsis">{draft.name || tr('(ohne Namen)', '(unnamed)')}</span>
                  <span className="ks-automation-job-sub">{tr('Nicht gespeichert', 'Not saved')}</span>
                </div>
              </div>
            )}
            {shown.map((i) => (
              <div
                key={i.job.id}
                className={clsx('ks-automation-job', draft?.id === i.job.id && !isNew && 'selected')}
                onMouseDown={() => void select(i.job.id)}
                onDoubleClick={() => void select(i.job.id).then(() => setPage('steps'))}
              >
                <ObjIcon kind="automation" />
                <div className="ks-automation-job-text">
                  <span className="ks-automation-job-name ellipsis" title={i.job.name}>
                    {i.job.name}
                    {draft?.id === i.job.id && dirty ? ' *' : ''}
                  </span>
                  <span className="ks-automation-job-sub ellipsis" title={describeSchedule(i.job.schedule)}>
                    {describeSchedule(i.job.schedule)}
                    {i.job.schedule.enabled && i.job.schedule.runner === 'windows' ? ` · ${tr('Windows', 'Windows')}` : ''}
                  </span>
                  <span className="ks-automation-job-sub ellipsis">
                    {i.taskId ? (
                      <RunStatus status="running" />
                    ) : i.lastRun ? (
                      <>
                        <RunStatus status={i.lastRun.status} /> {formatStart(i.lastRun.startedAt)}
                      </>
                    ) : (
                      tr('Noch nicht ausgeführt', 'Not run yet')
                    )}
                    {i.nextRun ? ` · ${tr('nächste', 'next')} ${formatStart(i.nextRun)}` : ''}
                  </span>
                </div>
              </div>
            ))}
            {items && !items.length && !isNew && (
              <div className="faint" style={{ padding: 12 }}>
                {tr('Noch keine Aufträge.', 'No jobs yet.')}
              </div>
            )}
          </div>
        </div>
        <div className="ks-automation-editor">
          {!draft ? (
            <EmptyState icon={<ObjIcon kind="automation" size={44} dim />} title={tr('Automatisierung', 'Automation')}>
              <p>
                {tr(
                  'Aufträge führen mehrere Schritte nacheinander aus – SQL, Sicherungen und gespeicherte Profile – manuell, nach Zeitplan oder über die Windows-Aufgabenplanung.',
                  'Jobs run several steps in sequence – SQL, backups and saved profiles – manually, on a schedule or via the Windows Task Scheduler.'
                )}
              </p>
            </EmptyState>
          ) : (
            <>
              <TabStrip<Page>
                value={page}
                onChange={setPage}
                tabs={[
                  { id: 'general', label: tr('Allgemein', 'General'), icon: <Settings2 size={14} /> },
                  { id: 'steps', label: tr('Schritte', 'Steps'), icon: <ListChecks size={14} />, badge: draft.steps.length },
                  { id: 'schedule', label: tr('Zeitplan', 'Schedule'), icon: <CalendarClock size={14} /> },
                  { id: 'mail', label: tr('Benachrichtigung', 'Notification'), icon: <Mail size={14} /> },
                  { id: 'history', label: tr('Verlauf', 'History'), icon: <History size={14} />, hidden: isNew },
                  { id: 'run', label: tr('Ausführung', 'Execution'), icon: <SquareActivity size={14} />, hidden: !runTask }
                ]}
              />
              {page === 'general' && (
                <div className="ks-automation-page">
                  <Section title={tr('Auftrag', 'Job')}>
                    <Field label={tr('Name', 'Name')} labelWidth={150}>
                      <TextInput data-autofocus value={draft.name} invalid={!draft.name.trim()} onChange={(e) => patch({ name: e.target.value })} />
                    </Field>
                    <Field label={tr('Beschreibung', 'Description')} labelWidth={150} alignTop>
                      <TextArea rows={4} value={draft.description} onChange={(e) => patch({ description: e.target.value })} />
                    </Field>
                    <Field label={tr('Zeitplan', 'Schedule')} labelWidth={150}>
                      <span>{describeSchedule(draft.schedule)}</span>
                    </Field>
                    {!isNew && (
                      <Field label={tr('Auftrags-ID', 'Job id')} labelWidth={150} hint={tr('Befehlszeile: KS Table --run-job <ID>', 'Command line: KS Table --run-job <id>')}>
                        <span className="mono selectable">{draft.id}</span>
                      </Field>
                    )}
                  </Section>
                </div>
              )}
              {page === 'steps' && <StepsPage job={draft} kinds={kinds} onChange={(steps) => patch({ steps })} />}
              {page === 'schedule' && <SchedulePage job={draft} env={env} winTask={isNew ? null : winTask} dirty={dirty} onChange={(schedule) => patch({ schedule })} />}
              {page === 'mail' && <MailPage job={draft} onChange={(email) => patch({ email })} />}
              {page === 'history' && !isNew && <HistoryPage job={draft} refreshKey={historyKey} onCleared={() => void reload()} />}
              {page === 'run' && runTask && (
                <div className="ks-automation-page fill">
                  <TaskPanel taskId={runTask} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="ks-statusline">
        <span>{items ? tr('{n} Aufträge', '{n} jobs', { n: items.length }) : ''}</span>
        {draft && <span>{dirty ? tr('Geändert', 'Modified') : tr('Gespeichert', 'Saved')}</span>}
        {active && env && <span className="ellipsis" title={env.folder}>{env.folder}</span>}
      </div>
    </div>
  );
}

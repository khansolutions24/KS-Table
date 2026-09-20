// Shared UI pieces of the sync tools: connection/database picker, profile menu, script dialog, task dialog.

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Copy, FolderOpen, Save, Trash2 } from 'lucide-react';
import { tr } from '@shared/i18n';
import { SYNC_FILE_ENCODINGS } from '@shared/sync/encodings';
import { api } from '../../api/client';
import { ObjIcon } from '../../components/icons';
import { SqlHighlight } from '../../components/SqlHighlight';
import { TaskPanel, useTask } from '../../components/TaskPanel';
import { toast } from '../../components/Toast';
import { Button, Select, Spinner, TextInput, ToolbarButton } from '../../components/ui/controls';
import { confirmDialog, Dialog, errorDialog, openDialog, promptDialog } from '../../components/ui/Dialog';
import { showMenuBelow, SEP, type MenuItem } from '../../components/ui/Menu';
import { newQuery } from '../../actions/query';
import { useWorkspace } from '../../store/workspace';
import './sync.css';

/** Databases of a connection (opens the connection when necessary); non-system databases first */
export function useDatabases(connectionId: string): { names: string[]; loading: boolean; reload: () => void } {
  const conn = useWorkspace((s) => (connectionId ? s.conns[connectionId] : undefined));
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!connectionId || conn?.status === 'open' || conn?.status === 'connecting' || conn?.status === 'error') return;
    setLoading(true);
    void useWorkspace
      .getState()
      .openConnection(connectionId)
      .finally(() => setLoading(false));
  }, [connectionId, conn?.status]);
  const names = (conn?.databases ?? []).filter((d) => !d.system).map((d) => d.name);
  return { names, loading: loading || conn?.status === 'connecting', reload: () => void useWorkspace.getState().refreshConnection(connectionId) };
}

export function ConnectionSelect({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const profiles = useWorkspace((s) => s.profiles);
  return (
    <Select
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={[{ value: '', label: tr('(Verbindung wählen)', '(choose connection)') }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
    />
  );
}

/** Connection + database; `allowNew` lets the user type a database name that does not exist yet */
export function EndpointFields({
  title,
  connectionId,
  database,
  onChange,
  allowNew,
  disabled,
  extra
}: {
  title: ReactNode;
  connectionId: string;
  database: string;
  onChange: (connectionId: string, database: string) => void;
  allowNew?: boolean;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  const { names, loading } = useDatabases(connectionId);
  const listId = useId();
  return (
    <div className="ks-sync-endpoint">
      <div className="ks-sync-endpoint-title">{title}</div>
      <label className="ks-sync-endpoint-label">{tr('Verbindung', 'Connection')}</label>
      <ConnectionSelect value={connectionId} disabled={disabled} onChange={(id) => onChange(id, '')} />
      <label className="ks-sync-endpoint-label">
        {tr('Datenbank', 'Database')} {loading && <Spinner size={11} />}
      </label>
      {allowNew ? (
        <>
          <TextInput list={listId} value={database} disabled={disabled || !connectionId} placeholder={tr('Name (neu oder vorhanden)', 'Name (new or existing)')} onChange={(e) => onChange(connectionId, e.target.value)} />
          <datalist id={listId}>
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {database && !loading && !names.some((n) => n.toLowerCase() === database.toLowerCase()) && (
            <div className="ks-field-hint">{tr('Die Datenbank wird neu erstellt.', 'The database will be created.')}</div>
          )}
        </>
      ) : (
        <Select
          value={database}
          disabled={disabled || !connectionId}
          onChange={(d) => onChange(connectionId, d)}
          options={[
            { value: '', label: tr('(Datenbank wählen)', '(choose database)') },
            ...(database && !names.includes(database) ? [{ value: database, label: database }] : []),
            ...names.map((n) => ({ value: n, label: n }))
          ]}
        />
      )}
      {extra}
    </div>
  );
}

export function EncodingSelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return <Select value={value} disabled={disabled} onChange={onChange} options={SYNC_FILE_ENCODINGS.map((e) => ({ value: e.id, label: e.label }))} />;
}

// ───────────────────────── profiles ─────────────────────────

/** Toolbar buttons "Profil laden" / "Profil speichern" */
export function ProfileButtons<T>({ kind, current, onLoad }: { kind: string; current: () => T; onLoad: (data: unknown, name: string) => void }) {
  const [name, setName] = useState('');
  const load = async (el: HTMLElement) => {
    try {
      const list = await api.profiles.list(kind);
      const items: MenuItem[] = list.length
        ? list.map((p) => ({
            label: p.name,
            icon: <FolderOpen size={14} />,
            submenu: [
              {
                label: tr('Laden', 'Load'),
                icon: <FolderOpen size={14} />,
                onClick: () =>
                  void api.profiles
                    .load(kind, p.name)
                    .then((d) => {
                      onLoad(d, p.name);
                      setName(p.name);
                      toast(tr('Profil „{n}“ geladen', 'Profile "{n}" loaded', { n: p.name }), 'success');
                    })
                    .catch((e) => void errorDialog(e))
              },
              SEP,
              {
                label: tr('Löschen', 'Delete'),
                icon: <Trash2 size={14} />,
                danger: true,
                onClick: async () => {
                  if (!(await confirmDialog({ message: tr('Profil „{n}“ löschen?', 'Delete profile "{n}"?', { n: p.name }), danger: true, okLabel: tr('Löschen', 'Delete') }))) return;
                  await api.profiles.remove(kind, p.name).catch((e) => void errorDialog(e));
                }
              }
            ]
          }))
        : [{ label: tr('Keine gespeicherten Profile', 'No saved profiles'), disabled: true }];
      showMenuBelow(el, items);
    } catch (e) {
      void errorDialog(e);
    }
  };
  const save = async () => {
    const n = await promptDialog({
      title: tr('Profil speichern', 'Save Profile'),
      label: tr('Profilname', 'Profile name'),
      value: name,
      validate: (v) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
    });
    if (!n) return;
    try {
      const existing = await api.profiles.list(kind);
      if (existing.some((p) => p.name.toLowerCase() === n.trim().toLowerCase()) && n.trim() !== name) {
        if (!(await confirmDialog({ message: tr('Profil „{n}“ überschreiben?', 'Overwrite profile "{n}"?', { n: n.trim() }) }))) return;
      }
      await api.profiles.save(kind, n.trim(), current());
      setName(n.trim());
      toast(tr('Profil „{n}“ gespeichert', 'Profile "{n}" saved', { n: n.trim() }), 'success');
    } catch (e) {
      void errorDialog(e);
    }
  };
  return (
    <>
      <ToolbarButton icon={<FolderOpen size={15} />} label={tr('Profil laden', 'Load Profile')} onClick={(e) => void load(e.currentTarget)} />
      <ToolbarButton icon={<Save size={15} />} label={tr('Profil speichern', 'Save Profile')} onClick={() => void save()} />
    </>
  );
}

// ───────────────────────── dialogs ─────────────────────────

/** Read-only script preview with copy / open in query editor */
export function showScriptDialog(o: { title: string; sql: string; note?: string; connectionId?: string; database?: string | null }): Promise<void> {
  return openDialog<void>((close) => (
    <Dialog
      title={o.title}
      icon={<ObjIcon kind="query" size={16} />}
      width={900}
      height={620}
      resizable
      noPadding
      onClose={() => close()}
      footerLeft={
        <>
          <Button
            icon={<Copy size={14} />}
            onClick={() => void navigator.clipboard.writeText(o.sql).then(() => toast(tr('In die Zwischenablage kopiert', 'Copied to clipboard'), 'success'))}
          >
            {tr('Kopieren', 'Copy')}
          </Button>
          {o.connectionId && (
            <Button
              onClick={() => {
                newQuery(o.connectionId, o.database ?? null, o.sql, tr('Synchronisationsskript', 'Synchronization script'));
                close();
              }}
            >
              {tr('Im Abfrage-Editor öffnen', 'Open in Query Editor')}
            </Button>
          )}
          {o.note && <span className="muted">{o.note}</span>}
        </>
      }
      footer={<Button variant="primary" onClick={() => close()}>{tr('Schließen', 'Close')}</Button>}
    >
      <div className="ks-sql-preview">
        <SqlHighlight sql={o.sql} className="selectable" />
      </div>
    </Dialog>
  )).then(() => undefined);
}

function TaskDialogBody({ taskId, title, close }: { taskId: string; title: string; close: () => void }) {
  const { info } = useTask(taskId);
  const running = !info || info.status === 'running';
  return (
    <Dialog
      title={title}
      width={720}
      height={460}
      resizable
      onClose={() => {
        if (running) void api.tasks.cancel(taskId);
        close();
      }}
      footer={
        <Button variant="primary" disabled={running} onClick={close}>
          {tr('Schließen', 'Close')}
        </Button>
      }
    >
      <div className="ks-sync-taskdialog">
        <TaskPanel taskId={taskId} />
      </div>
    </Dialog>
  );
}

/** Shows a running task in a dialog; resolves with the task status when the dialog is closed */
export function showTaskDialog(taskId: string, title: string): Promise<void> {
  return openDialog<void>((close) => <TaskDialogBody taskId={taskId} title={title} close={() => close()} />).then(() => undefined);
}

/** Waits for a task to end; returns its result or throws its error */
export function waitForTask<T>(taskId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const check = async () => {
      const t = (await api.tasks.list()).find((x) => x.taskId === taskId);
      if (!t || t.status === 'running' || done) return;
      done = true;
      window.clearInterval(timer);
      if (t.status === 'done') resolve(t.result as T);
      else reject(new Error(t.message || tr('Abgebrochen', 'Cancelled')));
    };
    const timer = window.setInterval(() => void check(), 400);
    void check();
  });
}

export const numberFmt = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toLocaleString());

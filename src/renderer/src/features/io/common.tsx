// Shared pieces of the io wizards: wizard frame, profile buttons, small inputs and helpers.

import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { FolderOpen, Save, Trash2, TriangleAlert } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { ProfileInfo } from '@shared/apis/profiles';
import { formatDateTime } from '@shared/util';
import { api } from '../../api/client';
import { confirmDialog, Dialog, errorDialog, openDialog, promptDialog } from '../../components/ui/Dialog';
import { Button, EmptyState, Select, TextInput } from '../../components/ui/controls';
import { toast } from '../../components/Toast';
import { useTask } from '../../components/TaskPanel';
import { metaSession, openSessionWithPrompt, useWorkspace } from '../../store/workspace';
import './io.css';

export interface WizardStep {
  id: string;
  label: string;
}

export function Wizard({
  steps,
  step,
  onStep,
  maxStep,
  children,
  footerLeft,
  canNext = true,
  onNext,
  onStart,
  startLabel,
  running,
  startDisabled
}: {
  steps: WizardStep[];
  step: number;
  onStep: (i: number) => void;
  /** highest step that may be opened by clicking the indicator */
  maxStep: number;
  children: ReactNode;
  footerLeft?: ReactNode;
  canNext?: boolean;
  /** Validation before moving on; return false to stay */
  onNext?: () => boolean | Promise<boolean>;
  onStart: () => void;
  startLabel?: string;
  running: boolean;
  startDisabled?: boolean;
}) {
  const last = step === steps.length - 1;
  const next = async () => {
    if (onNext && !(await onNext())) return;
    onStep(Math.min(step + 1, steps.length - 1));
  };
  return (
    <div
      className="ks-wizard"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.ctrlKey && !running) {
          e.preventDefault();
          e.stopPropagation();
          if (last) {
            if (!startDisabled) onStart();
          } else if (canNext) void next();
        }
      }}
    >
      <div className="ks-wizard-steps" role="tablist">
        {steps.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={i === step}
            className={clsx('ks-wizard-step ks-io-step-btn', i === step && 'active', i < step && 'done')}
            disabled={running || i > maxStep}
            onClick={() => onStep(i)}
          >
            <span className="num">{i + 1}</span>
            <span>{s.label}</span>
          </button>
        ))}
      </div>
      <div className="ks-wizard-body">{children}</div>
      <div className="ks-wizard-footer">
        {footerLeft}
        <div className="spacer" />
        <Button disabled={step === 0 || running} onClick={() => onStep(step - 1)}>
          {tr('Zurück', 'Back')}
        </Button>
        {!last && (
          <Button variant="primary" disabled={!canNext || running} onClick={() => void next()}>
            {tr('Weiter', 'Next')}
          </Button>
        )}
        {last && (
          <Button variant="primary" disabled={running || startDisabled} onClick={onStart}>
            {startLabel ?? tr('Starten', 'Start')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Profile load / save buttons for a wizard kind */
export function ProfileButtons<T>({
  kind,
  current,
  onLoad,
  disabled
}: {
  kind: string;
  current: () => T | null;
  onLoad: (data: T, name: string) => void;
  disabled?: boolean;
}) {
  const [name, setName] = useState<string | null>(null);
  const save = async () => {
    const data = current();
    if (!data) return;
    const n = await promptDialog({
      title: tr('Profil speichern', 'Save Profile'),
      label: tr('Name des Profils:', 'Profile name:'),
      value: name ?? '',
      validate: (v) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
    });
    if (!n) return;
    try {
      const existing = await api.profiles.list(kind);
      if (existing.some((p) => p.name.toLowerCase() === n.trim().toLowerCase()) && n.trim() !== name) {
        const okOverwrite = await confirmDialog({
          title: tr('Profil speichern', 'Save Profile'),
          message: tr('Das Profil „{n}“ existiert bereits. Überschreiben?', 'Profile "{n}" already exists. Overwrite?', { n: n.trim() }),
          okLabel: tr('Überschreiben', 'Overwrite'),
          danger: true
        });
        if (!okOverwrite) return;
      }
      await api.profiles.save(kind, n.trim(), data);
      setName(n.trim());
      toast(tr('Profil „{n}“ gespeichert.', 'Profile "{n}" saved.', { n: n.trim() }), 'success');
    } catch (e) {
      void errorDialog(e);
    }
  };
  const load = async () => {
    const picked = await openDialog<string>((close) => <ProfilePicker kind={kind} close={close} />);
    if (!picked) return;
    try {
      const data = (await api.profiles.load(kind, picked)) as T;
      onLoad(data, picked);
      setName(picked);
      toast(tr('Profil „{n}“ geladen.', 'Profile "{n}" loaded.', { n: picked }));
    } catch (e) {
      void errorDialog(e);
    }
  };
  return (
    <>
      <Button icon={<FolderOpen size={14} />} disabled={disabled} onClick={() => void load()}>
        {tr('Profil laden …', 'Load Profile …')}
      </Button>
      <Button icon={<Save size={14} />} disabled={disabled} onClick={() => void save()}>
        {tr('Profil speichern …', 'Save Profile …')}
      </Button>
      {name && <span className="muted ellipsis" style={{ maxWidth: 200 }}>{name}</span>}
    </>
  );
}

function ProfilePicker({ kind, close }: { kind: string; close: (v?: string) => void }) {
  const [list, setList] = useState<ProfileInfo[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const reload = () =>
    api.profiles
      .list(kind)
      .then(setList)
      .catch((e) => {
        setList([]);
        void errorDialog(e);
      });
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  const remove = async () => {
    if (!sel) return;
    if (!(await confirmDialog({ title: tr('Profil löschen', 'Delete Profile'), message: tr('Profil „{n}“ löschen?', 'Delete profile "{n}"?', { n: sel }), danger: true, okLabel: tr('Löschen', 'Delete') }))) return;
    try {
      await api.profiles.remove(kind, sel);
      setSel(null);
      await reload();
    } catch (e) {
      void errorDialog(e);
    }
  };
  return (
    <Dialog
      title={tr('Profil laden', 'Load Profile')}
      width={480}
      onClose={() => close()}
      onSubmit={() => sel && close(sel)}
      footerLeft={
        <Button variant="ghost" icon={<Trash2 size={14} />} disabled={!sel} onClick={() => void remove()}>
          {tr('Löschen', 'Delete')}
        </Button>
      }
      footer={
        <>
          <Button type="submit" variant="primary" disabled={!sel}>
            {tr('Laden', 'Load')}
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-io-profile-list" tabIndex={0}>
        {list === null ? null : list.length === 0 ? (
          <EmptyState title={tr('Keine gespeicherten Profile', 'No saved profiles')} />
        ) : (
          list.map((p) => (
            <div
              key={p.name}
              className={clsx('ks-io-list-item', sel === p.name && 'selected')}
              onMouseDown={() => setSel(p.name)}
              onDoubleClick={() => close(p.name)}
            >
              <span className="ellipsis">{p.name}</span>
              <span className="faint">{formatDateTime(p.mtime)}</span>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}

/** Text input for delimiters with presets; stores real characters (\t for tab) */
export function DelimiterInput({
  value,
  onChange,
  presets,
  disabled
}: {
  value: string;
  onChange: (v: string) => void;
  presets: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const known = presets.some((p) => p.value === value);
  const [custom, setCustom] = useState(!known);
  useEffect(() => {
    if (!presets.some((p) => p.value === value)) setCustom(true);
  }, [value, presets]);
  return (
    <div className="ks-io-inline">
      <Select
        className="ks-io-medium"
        disabled={disabled}
        value={custom ? '\u0000custom' : value}
        onChange={(v) => {
          if (v === '\u0000custom') setCustom(true);
          else {
            setCustom(false);
            onChange(v);
          }
        }}
        options={[...presets, { value: '\u0000custom', label: tr('Andere …', 'Other …') }]}
      />
      {custom && <TextInput className="ks-io-short" disabled={disabled} value={value} maxLength={8} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

export const FIELD_DELIMITERS = () => [
  { value: ',', label: tr('Komma (,)', 'Comma (,)') },
  { value: ';', label: tr('Semikolon (;)', 'Semicolon (;)') },
  { value: '\t', label: tr('Tabulator', 'Tab') },
  { value: '|', label: tr('Senkrechter Strich (|)', 'Pipe (|)') },
  { value: ' ', label: tr('Leerzeichen', 'Space') }
];

export const QUALIFIERS = () => [
  { value: '"', label: tr('Doppeltes Anführungszeichen (")', 'Double quote (")') },
  { value: "'", label: tr("Einfaches Anführungszeichen (')", "Single quote (')") },
  { value: '', label: tr('Keiner', 'None') }
];

export function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="ks-io-hint">
      <TriangleAlert size={15} />
      <div>{children}</div>
    </div>
  );
}

/** Runs a metadata call with the navigator session or, if the connection is not open, a temporary session. */
export async function withMeta<T>(connectionId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
  let sid: string | null = null;
  try {
    sid = metaSession(connectionId);
  } catch {
    sid = null;
  }
  if (sid) return fn(sid);
  const info = await openSessionWithPrompt(connectionId, null);
  try {
    return await fn(info.sessionId);
  } finally {
    void api.session.close(info.sessionId);
  }
}

/** Databases of a connection (from the workspace, loaded on demand) */
export function useDatabases(connectionId: string): string[] {
  const dbs = useWorkspace((s) => s.conns[connectionId]?.databases);
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (dbs?.length) {
      setNames(dbs.filter((d) => !d.system).map((d) => d.name));
      return;
    }
    let cancelled = false;
    void withMeta(connectionId, (sid) => api.meta.databases(sid))
      .then((l) => !cancelled && setNames(l.filter((d) => !d.system).map((d) => d.name)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connectionId, dbs]);
  return names;
}

/** Status of a task: running / finished callback */
export function useTaskDone(taskId: string | null, onDone: (status: string, result: unknown) => void): boolean {
  const { info } = useTask(taskId);
  const status = info?.status;
  useEffect(() => {
    if (taskId && status && status !== 'running') onDone(status, info?.result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, status]);
  return !!taskId && (!info || info.status === 'running');
}

export function documentsDir(): Promise<string> {
  return api.app.info().then((i) => i.documentsDir);
}

export function baseOf(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

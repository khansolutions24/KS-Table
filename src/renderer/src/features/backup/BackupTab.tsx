// Backup tab: create a backup, restore a backup or extract a SQL script (params.mode).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, FolderOpen, Play, Save, Upload } from 'lucide-react';
import type { BackupFileInfo, BackupOptions, BackupProfile, BackupResult, ExtractOptions, ExtractResult, RestoreOptions, RestoreResult } from '@shared/apis/backup';
import { BACKUP_EXT, defaultBackupOptions, defaultExtractOptions, defaultRestoreOptions, normalizeBackupOptions, objectKey } from '@shared/backup/options';
import { tr } from '@shared/i18n';
import { formatBytes, formatDuration, formatNumber } from '@shared/util';
import { api, errorMessage } from '../../api/client';
import { ObjIcon } from '../../components/icons';
import { TaskPanel, useTask } from '../../components/TaskPanel';
import { toast } from '../../components/Toast';
import { confirmDialog, errorDialog, promptDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, Field, RadioGroup, Section, Spinner, TextInput } from '../../components/ui/controls';
import { showMenuBelow } from '../../components/ui/Menu';
import { PathInput } from '../../components/ui/PathInput';
import { useTabs, type TabProps } from '../../store/tabs';
import { getProfile, useWorkspace } from '../../store/workspace';
import { BackupOptionsForm, ManifestInfo, manifestItems, ObjectChecklist, useConnectionDatabases } from './parts';
import './backup.css';

type Mode = 'backup' | 'restore' | 'extract';

interface Params {
  connectionId: string;
  database: string | null;
  mode: Mode;
  file?: string;
}

const LW = 150;

export default function BackupTab({ tab }: TabProps) {
  const p = tab.params as unknown as Params;
  const [mode] = useState<Mode>(p.mode ?? 'backup');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const { info } = useTask(taskId);
  const running = !!taskId && (!info || info.status === 'running');
  const profile = useWorkspace((s) => s.profiles.find((x) => x.id === p.connectionId));
  const handled = useRef<string | null>(null);

  useEffect(() => {
    useTabs.getState().update(tab.id, { subtitle: `${profile?.name ?? ''}${p.database ? ` / ${p.database}` : ''}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.name]);

  // refresh navigator lists once a task finished
  useEffect(() => {
    if (!info || info.status === 'running' || handled.current === info.taskId) return;
    handled.current = info.taskId;
    if (info.status !== 'done') return;
    const ws = useWorkspace.getState();
    if (info.kind === 'backup' && p.database) {
      void ws.refreshDatabase(p.connectionId, p.database, ['backups']);
      toast(tr('Sicherung erstellt', 'Backup created'), 'success');
    } else if (info.kind === 'restore') {
      const r = info.result as RestoreResult | undefined;
      void ws.refreshConnection(p.connectionId);
      if (r?.database && ws.conns[p.connectionId]?.dbs[r.database]?.loaded) void ws.refreshDatabase(p.connectionId, r.database);
    }
  }, [info, p.connectionId, p.database]);

  const start = (id: string) => {
    handled.current = null;
    setTaskId(id);
    setShowProgress(true);
  };

  if (!p.connectionId || !profile) {
    return (
      <div className="ks-wizard">
        <div className="ks-wizard-body">
          <div className="faint">{tr('Die Verbindung wurde nicht gefunden.', 'The connection was not found.')}</div>
        </div>
      </div>
    );
  }

  const title =
    mode === 'backup' ? tr('Neue Sicherung', 'New Backup') : mode === 'restore' ? tr('Sicherung wiederherstellen', 'Restore Backup') : tr('SQL aus Sicherung extrahieren', 'Extract SQL from Backup');

  return (
    <div className="ks-wizard">
      <div className="ks-wizard-steps">
        <div className={`ks-wizard-step ${showProgress ? 'done' : 'active'}`}>
          <span className="num">1</span>
          {title}
        </div>
        <div className={`ks-wizard-step ${showProgress ? 'active' : ''}`}>
          <span className="num">2</span>
          {tr('Ausführung', 'Execution')}
        </div>
      </div>
      {showProgress && taskId ? (
        <ProgressView taskId={taskId} running={running} onBack={() => setShowProgress(false)} />
      ) : mode === 'backup' ? (
        <BackupMode connectionId={p.connectionId} database={p.database ?? ''} busy={running} onStarted={start} onShowProgress={taskId ? () => setShowProgress(true) : undefined} />
      ) : (
        <FileMode
          mode={mode}
          connectionId={p.connectionId}
          database={p.database ?? ''}
          initialFile={p.file ?? ''}
          busy={running}
          onStarted={start}
          onShowProgress={taskId ? () => setShowProgress(true) : undefined}
        />
      )}
    </div>
  );
}

function ProgressView({ taskId, running, onBack }: { taskId: string; running: boolean; onBack: () => void }) {
  const { info } = useTask(taskId);
  let summary: ReactNode = null;
  if (info?.status === 'done') {
    if (info.kind === 'backup') {
      const r = info.result as BackupResult;
      summary = (
        <div className="ks-backup-summary success selectable">
          {tr('Sicherung „{f}“ erstellt: {o} Objekte, {r} Datensätze, {s} in {d}.', 'Backup "{f}" created: {o} objects, {r} records, {s} in {d}.', {
            f: r.file,
            o: r.objects,
            r: formatNumber(r.rows),
            s: formatBytes(r.size),
            d: formatDuration(r.durationMs)
          })}
        </div>
      );
    } else if (info.kind === 'restore') {
      const r = info.result as RestoreResult;
      summary = (
        <div className={`ks-backup-summary ${r.errors ? 'error' : 'success'}`}>
          {tr('Datenbank „{db}“: {o} Objekte erstellt, {r} Datensätze eingefügt, {e} Fehler, {w} Warnungen.', 'Database "{db}": {o} objects created, {r} records inserted, {e} errors, {w} warnings.', {
            db: r.database,
            o: r.objects,
            r: formatNumber(r.rows),
            e: r.errors,
            w: r.warnings
          })}
        </div>
      );
    } else {
      const r = info.result as ExtractResult;
      summary = (
        <div className="ks-backup-summary success selectable row">
          <span className="grow">
            {tr('SQL-Skript „{f}“ geschrieben ({s}, {n} Anweisungen).', 'SQL script "{f}" written ({s}, {n} statements).', { f: r.file, s: formatBytes(r.size), n: formatNumber(r.statements) })}
          </span>
          <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void api.app.showItemInFolder(r.file)}>
            {tr('Im Explorer anzeigen', 'Show in Explorer')}
          </Button>
        </div>
      );
    }
  }
  return (
    <>
      <div className="ks-backup-progress">
        {summary}
        <TaskPanel taskId={taskId} />
      </div>
      <div className="ks-wizard-footer">
        <Button icon={<ArrowLeft size={14} />} disabled={running} onClick={onBack}>
          {tr('Zurück zu den Einstellungen', 'Back to settings')}
        </Button>
        <div className="spacer" />
        {running && <Spinner />}
      </div>
    </>
  );
}

function BackupMode({
  connectionId,
  database,
  busy,
  onStarted,
  onShowProgress
}: {
  connectionId: string;
  database: string;
  busy: boolean;
  onStarted: (taskId: string) => void;
  onShowProgress?: () => void;
}) {
  const [options, setOptions] = useState<BackupOptions>(defaultBackupOptions);
  const [folder, setFolder] = useState('');
  const conn = getProfile(connectionId);

  useEffect(() => {
    if (database) void api.backup.folder(connectionId, database).then(setFolder).catch(() => undefined);
  }, [connectionId, database]);

  const invalid = !database
    ? tr('Bitte zuerst eine Datenbank auswählen.', 'Please select a database first.')
    : !options.structure && !options.data
      ? tr('Bitte Struktur und/oder Daten auswählen.', 'Please select structure and/or data.')
      : options.selection === 'custom' && !options.objects.length
        ? tr('Es sind keine Objekte ausgewählt.', 'No objects are selected.')
        : options.selection === 'all' && !Object.values(options.types).some(Boolean)
          ? tr('Bitte mindestens einen Objekttyp auswählen.', 'Please select at least one object type.')
          : null;

  const run = async () => {
    if (invalid) return;
    try {
      if (options.fileName.trim() && folder) {
        const target = `${folder}${folder.includes('\\') ? '\\' : '/'}${options.fileName.trim().replace(/\.ksbak$/i, '')}${BACKUP_EXT}`;
        const st = await api.fs.stat(target);
        if (st.exists && !(await confirmDialog({ message: tr('Die Sicherung „{f}“ existiert bereits. Überschreiben?', 'Backup "{f}" already exists. Overwrite?', { f: target }), okLabel: tr('Überschreiben', 'Overwrite'), danger: true }))) return;
      }
      onStarted(await api.backup.start(connectionId, database, options));
    } catch (e) {
      void errorDialog(e);
    }
  };

  const saveProfile = async () => {
    const name = await promptDialog({
      title: tr('Profil speichern', 'Save profile'),
      label: tr('Name des Sicherungsprofils (auch in der Automatisierung verwendbar):', 'Name of the backup profile (usable in automation):'),
      value: `${database}`,
      validate: (v) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
    });
    if (!name) return;
    try {
      const existing = await api.profiles.list('backup');
      if (existing.some((x) => x.name.toLowerCase() === name.trim().toLowerCase())) {
        if (!(await confirmDialog({ message: tr('Das Profil „{n}“ existiert bereits. Überschreiben?', 'Profile "{n}" already exists. Overwrite?', { n: name }), okLabel: tr('Überschreiben', 'Overwrite') }))) return;
      }
      const data: BackupProfile = { connectionId, database, options };
      await api.profiles.save('backup', name.trim(), data);
      toast(tr('Profil „{n}“ gespeichert', 'Profile "{n}" saved', { n: name.trim() }), 'success');
    } catch (e) {
      void errorDialog(e);
    }
  };

  const loadProfile = async (el: HTMLElement) => {
    try {
      const list = await api.profiles.list('backup');
      const items = await Promise.all(
        list.map(async (x) => {
          const data = (await api.profiles.load('backup', x.name).catch(() => null)) as Partial<BackupProfile> | null;
          return { x, data };
        })
      );
      const mine = items.filter((i) => i.data && i.data.connectionId === connectionId && i.data.database === database);
      showMenuBelow(
        el,
        mine.length
          ? mine.map(({ x, data }) => ({
              label: x.name,
              icon: <ObjIcon kind="backup" size={14} />,
              onClick: () => setOptions(normalizeBackupOptions(data?.options))
            }))
          : [{ label: tr('Keine Profile für diese Datenbank', 'No profiles for this database'), disabled: true }]
      );
    } catch (e) {
      void errorDialog(e);
    }
  };

  return (
    <>
      <div className="ks-wizard-body">
        <Section title={tr('Allgemein', 'General')}>
          <Field label={tr('Verbindung', 'Connection')} labelWidth={LW}>
            <span className="row">
              <ObjIcon kind={conn?.type === 'mariadb' ? 'connection-mariadb' : 'connection'} size={14} />
              {conn?.name}
            </span>
          </Field>
          <Field label={tr('Datenbank', 'Database')} labelWidth={LW}>
            <span className="row">
              <ObjIcon kind="database" size={14} />
              {database || '–'}
            </span>
          </Field>
          <Field label={tr('Speicherort', 'Location')} labelWidth={LW}>
            <span className="row">
              <span className="ellipsis selectable" title={folder}>
                {folder}
              </span>
              {folder && <Button size="sm" icon={<FolderOpen size={13} />} title={tr('Im Explorer anzeigen', 'Show in Explorer')} onClick={() => void api.fs.mkdir(folder).then(() => api.app.showItemInFolder(folder))} />}
            </span>
          </Field>
        </Section>
        {database && <BackupOptionsForm connectionId={connectionId} database={database} value={options} onChange={setOptions} disabled={busy} />}
      </div>
      <div className="ks-wizard-footer">
        <Button icon={<Upload size={14} />} onClick={(e) => void loadProfile(e.currentTarget)} disabled={busy || !database}>
          {tr('Profil laden', 'Load profile')}
        </Button>
        <Button icon={<Save size={14} />} onClick={() => void saveProfile()} disabled={busy || !!invalid}>
          {tr('Profil speichern', 'Save profile')}
        </Button>
        <div className="spacer" />
        {invalid && <span className="muted">{invalid}</span>}
        {onShowProgress && <Button onClick={onShowProgress}>{tr('Letzte Ausführung', 'Last run')}</Button>}
        <Button variant="primary" icon={<Play size={14} />} disabled={busy || !!invalid} onClick={() => void run()}>
          {tr('Sicherung starten', 'Start backup')}
        </Button>
      </div>
    </>
  );
}

type Target = 'same' | 'other' | 'new';

function FileMode({
  mode,
  connectionId,
  database,
  initialFile,
  busy,
  onStarted,
  onShowProgress
}: {
  mode: 'restore' | 'extract';
  connectionId: string;
  database: string;
  initialFile: string;
  busy: boolean;
  onStarted: (taskId: string) => void;
  onShowProgress?: () => void;
}) {
  const [file, setFile] = useState(initialFile);
  const [info, setInfo] = useState<BackupFileInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ro, setRo] = useState<RestoreOptions>(() => defaultRestoreOptions(database));
  const [xo, setXo] = useState<ExtractOptions>(() => defaultExtractOptions(database));
  const [target, setTarget] = useState<Target>('same');
  const [otherDb, setOtherDb] = useState('');
  const [newDb, setNewDb] = useState('');
  const [sqlFile, setSqlFile] = useState('');
  const [folder, setFolder] = useState('');
  const databases = useConnectionDatabases(connectionId);

  useEffect(() => {
    if (database) void api.backup.folder(connectionId, database).then(setFolder).catch(() => undefined);
  }, [connectionId, database]);

  useEffect(() => {
    const f = file.trim();
    setInfo(null);
    setLoadError(null);
    if (!f) return;
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      api.backup
        .info(f)
        .then((i) => {
          if (cancelled) return;
          setInfo(i);
          setSelected(new Set(i.manifest.objects.map(objectKey)));
          setRo((o) => ({ ...o, structure: i.manifest.options.structure, data: i.manifest.options.data }));
          setXo((o) => ({ ...o, structure: i.manifest.options.structure, data: i.manifest.options.data, databaseName: o.databaseName || i.manifest.database }));
          setSqlFile((s) => s || f.replace(/\.ksbak$/i, '') + '.sql');
          if (!database) setTarget('new');
          setNewDb((n) => n || `${i.manifest.database}_restore`);
        })
        .catch((e) => !cancelled && setLoadError(errorMessage(e)))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [file, database]);

  const items = useMemo(() => (info ? manifestItems(info.manifest) : []), [info]);
  const allSelected = !!info && selected.size === info.manifest.objects.length;
  const objects = info ? (allSelected ? null : info.manifest.objects.filter((o) => selected.has(objectKey(o))).map(({ type, name }) => ({ type, name }))) : null;
  const targetDb = target === 'same' ? database : target === 'other' ? otherDb.trim() : newDb.trim();

  const structure = mode === 'restore' ? ro.structure : xo.structure;
  const data = mode === 'restore' ? ro.data : xo.data;
  const invalid = !info
    ? tr('Bitte eine gültige Sicherungsdatei wählen.', 'Please choose a valid backup file.')
    : !selected.size
      ? tr('Es sind keine Objekte ausgewählt.', 'No objects are selected.')
      : !structure && !data
        ? tr('Bitte Struktur und/oder Daten auswählen.', 'Please select structure and/or data.')
        : mode === 'restore' && !targetDb
          ? tr('Bitte eine Zieldatenbank angeben.', 'Please specify a target database.')
          : mode === 'extract' && !sqlFile.trim()
            ? tr('Bitte eine Zieldatei angeben.', 'Please choose a target file.')
            : null;

  const run = async () => {
    if (invalid || !info) return;
    try {
      if (mode === 'restore') {
        const exists = databases.some((d) => d.toLowerCase() === targetDb.toLowerCase());
        if (target === 'new' && exists) {
          if (!(await confirmDialog({ message: tr('Die Datenbank „{db}“ existiert bereits. Trotzdem hinein wiederherstellen?', 'Database "{db}" already exists. Restore into it anyway?', { db: targetDb }), danger: true, okLabel: tr('Wiederherstellen', 'Restore') }))) return;
        } else if (target !== 'new' && ro.structure && ro.dropExisting) {
          const ok = await confirmDialog({
            title: tr('Sicherung wiederherstellen', 'Restore backup'),
            message: tr(
              'Die ausgewählten Objekte werden in „{db}“ gelöscht und aus der Sicherung neu erstellt. Vorhandene Daten dieser Objekte gehen verloren.\n\nFortfahren?',
              'The selected objects are dropped in "{db}" and recreated from the backup. Existing data of these objects is lost.\n\nContinue?',
              { db: targetDb }
            ),
            okLabel: tr('Wiederherstellen', 'Restore'),
            danger: true
          });
          if (!ok) return;
        }
        onStarted(await api.backup.restore(connectionId, info.path, { ...ro, targetDatabase: targetDb, createDatabase: target === 'new', objects }));
      } else {
        const st = await api.fs.stat(sqlFile.trim());
        if (st.exists && !(await confirmDialog({ message: tr('Die Datei „{f}“ existiert bereits. Überschreiben?', 'File "{f}" already exists. Overwrite?', { f: sqlFile.trim() }), okLabel: tr('Überschreiben', 'Overwrite'), danger: true }))) return;
        onStarted(await api.backup.extract(info.path, sqlFile.trim(), { ...xo, objects }));
      }
    } catch (e) {
      void errorDialog(e);
    }
  };

  const setR = (patch: Partial<RestoreOptions>) => setRo((o) => ({ ...o, ...patch }));
  const setX = (patch: Partial<ExtractOptions>) => setXo((o) => ({ ...o, ...patch }));

  return (
    <>
      <div className="ks-wizard-body">
        <Section title={tr('Sicherungsdatei', 'Backup file')}>
          <Field label={tr('Datei', 'File')} labelWidth={LW}>
            <PathInput
              value={file}
              onChange={setFile}
              disabled={busy}
              title={tr('Sicherung öffnen', 'Open backup')}
              filters={[{ name: tr('KS-Table-Sicherung', 'KS Table backup'), extensions: ['ksbak'] }]}
              placeholder={folder ? `${folder}…` : undefined}
            />
          </Field>
          {loading && (
            <div className="row">
              <Spinner /> {tr('Lese Sicherung …', 'Reading backup …')}
            </div>
          )}
          {loadError && <div className="danger-text">{loadError}</div>}
          {info && <ManifestInfo manifest={info.manifest} size={info.size} mtime={info.mtime} file={info.path} />}
        </Section>
        {info && (
          <div className="ks-backup-grid">
            <Section title={tr('Objektauswahl', 'Object selection')}>
              <ObjectChecklist items={items} selected={selected} onChange={setSelected} disabled={busy} />
              <div className="ks-backup-hint">
                {tr('{s} von {n} Objekten ausgewählt', '{s} of {n} objects selected', { s: selected.size, n: items.length })}
              </div>
            </Section>
            {mode === 'restore' ? (
              <div className="col" style={{ gap: 12 }}>
                <Section title={tr('Ziel', 'Target')}>
                  <RadioGroup
                    value={target}
                    disabled={busy}
                    onChange={setTarget}
                    options={[
                      { value: 'same', label: tr('Aktuelle Datenbank „{db}“', 'Current database "{db}"', { db: database || '–' }), disabled: !database },
                      { value: 'other', label: tr('Andere vorhandene Datenbank', 'Other existing database') },
                      { value: 'new', label: tr('Neue Datenbank', 'New database') }
                    ]}
                  />
                  {target === 'other' && (
                    <Field label={tr('Datenbank', 'Database')} labelWidth={LW}>
                      <TextInput list="ks-backup-dbs" value={otherDb} disabled={busy} onChange={(e) => setOtherDb(e.target.value)} />
                      <datalist id="ks-backup-dbs">
                        {databases.map((d) => (
                          <option key={d} value={d} />
                        ))}
                      </datalist>
                    </Field>
                  )}
                  {target === 'new' && (
                    <Field label={tr('Name', 'Name')} labelWidth={LW} hint={tr('Zeichensatz und Sortierung werden aus der Sicherung übernommen.', 'Character set and collation are taken from the backup.')}>
                      <TextInput value={newDb} disabled={busy} onChange={(e) => setNewDb(e.target.value)} />
                    </Field>
                  )}
                </Section>
                <Section title={tr('Optionen', 'Options')}>
                  <div className="row" style={{ gap: 16 }}>
                    <Checkbox disabled={busy || !info.manifest.options.structure} checked={ro.structure} onChange={(structure) => setR({ structure })} label={tr('Struktur erstellen', 'Create structure')} />
                    <Checkbox disabled={busy || !info.manifest.options.data} checked={ro.data} onChange={(d) => setR({ data: d })} label={tr('Daten einfügen', 'Insert data')} />
                  </div>
                  <Checkbox disabled={busy || !ro.structure} checked={ro.dropExisting} onChange={(dropExisting) => setR({ dropExisting })} label={tr('Vorhandene Objekte vorher löschen', 'Drop existing objects first')} />
                  <Checkbox disabled={busy || !ro.data} checked={ro.emptyTables} onChange={(emptyTables) => setR({ emptyTables })} label={tr('Vorhandene Tabellen vor dem Einfügen leeren', 'Empty existing tables before inserting')} />
                  <Checkbox disabled={busy || !ro.data} checked={ro.transaction} onChange={(transaction) => setR({ transaction })} label={tr('Daten in einer Transaktion einfügen (Rollback bei Fehler)', 'Insert data in one transaction (rollback on error)')} />
                  <Checkbox disabled={busy} checked={ro.disableForeignKeys} onChange={(disableForeignKeys) => setR({ disableForeignKeys })} label={tr('Fremdschlüsselprüfung deaktivieren', 'Disable foreign key checks')} />
                  <Checkbox disabled={busy} checked={ro.continueOnError} onChange={(continueOnError) => setR({ continueOnError })} label={tr('Bei Fehlern fortfahren', 'Continue on error')} />
                  <Checkbox disabled={busy} checked={ro.keepDefiner} onChange={(keepDefiner) => setR({ keepDefiner })} label={tr('DEFINER beibehalten (sonst aktueller Benutzer)', 'Keep DEFINER (otherwise current user)')} />
                  <div className="ks-backup-hint">
                    {tr(
                      'Reihenfolge: Tabellen, Daten, Funktionen und Prozeduren, Ansichten (nach Abhängigkeiten), Trigger, Ereignisse.',
                      'Order: tables, data, functions and procedures, views (by dependencies), triggers, events.'
                    )}
                  </div>
                </Section>
              </div>
            ) : (
              <div className="col" style={{ gap: 12 }}>
                <Section title={tr('Zieldatei', 'Target file')}>
                  <PathInput
                    mode="save"
                    value={sqlFile}
                    onChange={setSqlFile}
                    disabled={busy}
                    title={tr('SQL-Skript speichern', 'Save SQL script')}
                    filters={[{ name: tr('SQL-Skript', 'SQL script'), extensions: ['sql'] }]}
                  />
                </Section>
                <Section title={tr('Optionen', 'Options')}>
                  <div className="row" style={{ gap: 16 }}>
                    <Checkbox disabled={busy || !info.manifest.options.structure} checked={xo.structure} onChange={(structure) => setX({ structure })} label={tr('Struktur', 'Structure')} />
                    <Checkbox disabled={busy || !info.manifest.options.data} checked={xo.data} onChange={(d) => setX({ data: d })} label={tr('Daten', 'Data')} />
                  </div>
                  <Checkbox disabled={busy || !xo.structure} checked={xo.dropStatements} onChange={(dropStatements) => setX({ dropStatements })} label={tr('DROP-Anweisungen vor CREATE', 'DROP statements before CREATE')} />
                  <Checkbox disabled={busy} checked={xo.keepDefiner} onChange={(keepDefiner) => setX({ keepDefiner })} label={tr('DEFINER beibehalten', 'Keep DEFINER')} />
                  <Checkbox disabled={busy} checked={xo.createDatabase} onChange={(createDatabase) => setX({ createDatabase })} label={tr('CREATE DATABASE und USE voranstellen', 'Prepend CREATE DATABASE and USE')} />
                  {xo.createDatabase && (
                    <Field label={tr('Datenbankname', 'Database name')} labelWidth={LW}>
                      <TextInput value={xo.databaseName} disabled={busy} onChange={(e) => setX({ databaseName: e.target.value })} />
                    </Field>
                  )}
                </Section>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="ks-wizard-footer">
        <div className="spacer" />
        {invalid && file.trim() && !loading && <span className="muted">{invalid}</span>}
        {onShowProgress && <Button onClick={onShowProgress}>{tr('Letzte Ausführung', 'Last run')}</Button>}
        <Button variant="primary" icon={<Play size={14} />} disabled={busy || !!invalid} onClick={() => void run()}>
          {mode === 'restore' ? tr('Wiederherstellen', 'Restore') : tr('SQL extrahieren', 'Extract SQL')}
        </Button>
      </div>
    </>
  );
}

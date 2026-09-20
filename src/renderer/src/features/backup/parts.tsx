// Building blocks of the backup feature (also used by the automation job editor).

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import type { BackupManifest, BackupObjectRef, BackupObjectType, BackupOptions } from '@shared/apis/backup';
import { BACKUP_OBJECT_TYPES, backupTypeLabel, consistencyLabel, objectKey } from '@shared/backup/options';
import { tr } from '@shared/i18n';
import { formatBytes, formatDateTime, formatNumber } from '@shared/util';
import { api } from '../../api/client';
import { ObjIcon } from '../../components/icons';
import { Button, Checkbox, Field, RadioGroup, SearchInput, Section, Select, Spinner, TextArea, TextInput } from '../../components/ui/controls';
import { openSessionWithPrompt, useWorkspace } from '../../store/workspace';
import './backup.css';

export interface ChecklistItem extends BackupObjectRef {
  detail?: string;
}

/** Objects grouped by type with check boxes (selection = object keys). */
export function ObjectChecklist({
  items,
  selected,
  onChange,
  disabled,
  loading,
  onReload
}: {
  items: ChecklistItem[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  loading?: boolean;
  onReload?: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const f = filter.trim().toLowerCase();
  const groups = useMemo(
    () =>
      BACKUP_OBJECT_TYPES.map((type) => ({ type, all: items.filter((i) => i.type === type) }))
        .filter((g) => g.all.length)
        .map((g) => ({ ...g, shown: f ? g.all.filter((i) => i.name.toLowerCase().includes(f)) : g.all })),
    [items, f]
  );
  const setMany = (list: BackupObjectRef[], on: boolean) => {
    const next = new Set(selected);
    for (const i of list) {
      if (on) next.add(objectKey(i));
      else next.delete(objectKey(i));
    }
    onChange(next);
  };
  return (
    <div>
      <div className="ks-backup-toolbar">
        <SearchInput value={filter} onChange={setFilter} className="grow" placeholder={tr('Objekte filtern', 'Filter objects')} />
        <Button size="sm" disabled={disabled} onClick={() => setMany(items, true)}>
          {tr('Alle', 'All')}
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => setMany(items, false)}>
          {tr('Keine', 'None')}
        </Button>
        {onReload && <Button size="sm" icon={<RefreshCw size={13} />} disabled={loading} title={tr('Aktualisieren', 'Refresh')} onClick={onReload} />}
      </div>
      <div className={`ks-backup-objects${disabled ? ' disabled' : ''}`}>
        {loading && (
          <div className="row" style={{ padding: 8 }}>
            <Spinner /> {tr('Lade Objekte …', 'Loading objects …')}
          </div>
        )}
        {!loading && !items.length && <div className="faint" style={{ padding: 8 }}>{tr('Keine Objekte', 'No objects')}</div>}
        {!loading &&
          groups.map((g) => {
            const n = g.all.filter((i) => selected.has(objectKey(i))).length;
            const open = !collapsed[g.type];
            return (
              <div key={g.type}>
                <div className="ks-backup-group">
                  <button type="button" className="ks-icon-btn" onClick={() => setCollapsed((c) => ({ ...c, [g.type]: open }))} title={open ? tr('Zuklappen', 'Collapse') : tr('Aufklappen', 'Expand')}>
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <Checkbox
                    checked={n === g.all.length}
                    indeterminate={n > 0 && n < g.all.length}
                    disabled={disabled}
                    onChange={(v) => setMany(g.all, v)}
                    label={
                      <span className="ks-backup-group-head">
                        {backupTypeLabel(g.type, true)}
                        <span className="ks-backup-count">
                          {n}/{g.all.length}
                        </span>
                      </span>
                    }
                  />
                </div>
                {open &&
                  g.shown.map((i) => (
                    <div key={objectKey(i)} className="ks-backup-item">
                      <Checkbox
                        checked={selected.has(objectKey(i))}
                        disabled={disabled}
                        onChange={(v) => setMany([i], v)}
                        label={
                          <>
                            <ObjIcon kind={i.type} size={14} />
                            {i.name}
                            {i.detail && <span className="ks-backup-count">{i.detail}</span>}
                          </>
                        }
                      />
                    </div>
                  ))}
              </div>
            );
          })}
      </div>
    </div>
  );
}

/** Objects of a database for the custom selection */
export async function loadDatabaseObjects(connectionId: string, database: string): Promise<ChecklistItem[]> {
  const info = await openSessionWithPrompt(connectionId, null);
  const sid = info.sessionId;
  try {
    const [tables, views, routines, triggers, events] = await Promise.all([
      api.meta.tables(sid, database),
      api.meta.views(sid, database),
      api.meta.routines(sid, database),
      api.meta.triggers(sid, database),
      api.meta.events(sid, database)
    ]);
    return [
      ...tables.map((t) => ({ type: 'table' as const, name: t.name, detail: t.rows !== null ? `~${formatNumber(t.rows)}` : undefined })),
      ...views.map((v) => ({ type: 'view' as const, name: v.name })),
      ...routines.map((r) => ({ type: (r.type === 'FUNCTION' ? 'function' : 'procedure') as BackupObjectType, name: r.name })),
      ...triggers.map((t) => ({ type: 'trigger' as const, name: t.name, detail: t.table })),
      ...events.map((e) => ({ type: 'event' as const, name: e.name }))
    ];
  } finally {
    void api.session.close(sid);
  }
}

export function manifestItems(m: BackupManifest): ChecklistItem[] {
  return m.objects.map((o) => ({
    type: o.type,
    name: o.name,
    detail: o.type === 'table' ? (o.rows !== null ? tr('{n} Datensätze', '{n} records', { n: formatNumber(o.rows) }) : tr('nur Struktur', 'structure only')) : o.table
  }));
}

/** Backup options (objects, content, consistency, compression, comment, file name). */
export function BackupOptionsForm({
  connectionId,
  database,
  value,
  onChange,
  disabled,
  compact
}: {
  connectionId: string;
  database: string;
  value: BackupOptions;
  onChange: (o: BackupOptions) => void;
  disabled?: boolean;
  /** automation editor: narrower layout */
  compact?: boolean;
}) {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const set = (patch: Partial<BackupOptions>) => onChange({ ...value, ...patch });
  const custom = value.selection === 'custom';

  const reload = () => {
    if (!connectionId || !database) return;
    setLoading(true);
    setLoadError(null);
    loadDatabaseObjects(connectionId, database)
      .then(setItems)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    setItems([]);
    if (custom) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, database, custom]);

  const selected = useMemo(() => new Set(value.objects.map(objectKey)), [value.objects]);
  const lw = 150;

  const objects = (
    <Section title={tr('Objektauswahl', 'Object selection')}>
      <RadioGroup
        value={value.selection}
        disabled={disabled}
        onChange={(selection) => {
          // switching to a custom selection starts with all objects checked
          if (selection === 'custom' && !value.objects.length && items.length) set({ selection, objects: items.map(({ type, name }) => ({ type, name })) });
          else set({ selection });
        }}
        options={[
          { value: 'all', label: tr('Alle Objekte der gewählten Typen (auch später angelegte)', 'All objects of the chosen types (including ones created later)') },
          { value: 'custom', label: tr('Ausgewählte Objekte', 'Selected objects') }
        ]}
      />
      {!custom ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: '4px 16px', paddingLeft: 20 }}>
          {BACKUP_OBJECT_TYPES.map((t) => (
            <Checkbox
              key={t}
              disabled={disabled}
              checked={value.types[t]}
              onChange={(v) => set({ types: { ...value.types, [t]: v } })}
              label={
                <span className="row" style={{ gap: 5 }}>
                  <ObjIcon kind={t} size={14} />
                  {backupTypeLabel(t, true)}
                </span>
              }
            />
          ))}
        </div>
      ) : (
        <>
          {loadError && <div className="danger-text">{loadError}</div>}
          <ObjectChecklist
            items={items}
            loading={loading}
            onReload={reload}
            disabled={disabled}
            selected={selected}
            onChange={(next) => set({ objects: items.filter((i) => next.has(objectKey(i))).map(({ type, name }) => ({ type, name })) })}
          />
          <div className="ks-backup-hint">{tr('{n} Objekte ausgewählt', '{n} objects selected', { n: value.objects.length })}</div>
        </>
      )}
    </Section>
  );

  const options = (
    <div className="col" style={{ gap: 12 }}>
      <Section title={tr('Inhalt', 'Content')}>
        <div className="row" style={{ gap: 16 }}>
          <Checkbox disabled={disabled} checked={value.structure} onChange={(structure) => set({ structure })} label={tr('Struktur', 'Structure')} />
          <Checkbox disabled={disabled} checked={value.data} onChange={(data) => set({ data })} label={tr('Daten', 'Data')} />
        </div>
        {!value.structure && (
          <div className="ks-backup-hint">
            {tr('Ohne Struktur werden nur Tabellendaten gesichert (keine Ansichten, Routinen, Trigger, Ereignisse).', 'Without structure only table data is saved (no views, routines, triggers, events).')}
          </div>
        )}
        {!value.structure && !value.data && <div className="danger-text">{tr('Bitte Struktur und/oder Daten auswählen.', 'Please select structure and/or data.')}</div>}
      </Section>
      <Section title={tr('Konsistenz', 'Consistency')}>
        <RadioGroup
          value={value.consistency}
          disabled={disabled}
          onChange={(consistency) => set({ consistency })}
          options={(['snapshot', 'lock', 'none'] as const).map((c) => ({ value: c, label: consistencyLabel(c) }))}
        />
      </Section>
      <Section title={tr('Datei', 'File')}>
        <Field label={tr('Dateiname', 'File name')} labelWidth={lw} hint={tr('Leer = Zeitstempel (JJJJMMTThhmmss); gleicher Name überschreibt', 'Empty = time stamp (YYYYMMDDhhmmss); same name overwrites')}>
          <TextInput disabled={disabled} value={value.fileName} placeholder={tr('(Zeitstempel)', '(time stamp)')} onChange={(e) => set({ fileName: e.target.value })} />
        </Field>
        <Field label={tr('Komprimierung', 'Compression')} labelWidth={lw}>
          <Select
            disabled={disabled}
            value={String(value.compression)}
            onChange={(v) => set({ compression: Number(v) })}
            options={Array.from({ length: 10 }, (_, i) => ({
              value: String(i),
              label: i === 0 ? tr('0 – keine', '0 – none') : i === 1 ? tr('1 – schnell', '1 – fast') : i === 6 ? tr('6 – Standard', '6 – default') : i === 9 ? tr('9 – maximal', '9 – best') : String(i)
            }))}
            style={{ width: 160 }}
          />
        </Field>
        <Field label={tr('Kommentar', 'Comment')} labelWidth={lw} alignTop>
          <TextArea disabled={disabled} rows={3} value={value.comment} onChange={(e) => set({ comment: e.target.value })} />
        </Field>
      </Section>
    </div>
  );

  if (compact) {
    return (
      <div className="col" style={{ gap: 12 }}>
        {objects}
        {options}
      </div>
    );
  }
  return (
    <div className="ks-backup-grid">
      {objects}
      {options}
    </div>
  );
}

/** Details of a backup file (manifest). */
export function ManifestInfo({ manifest, size, mtime, file }: { manifest: BackupManifest; size: number; mtime: number; file: string }) {
  const m = manifest;
  const count = (t: BackupObjectType) => m.objects.filter((o) => o.type === t).length;
  const counts = BACKUP_OBJECT_TYPES.filter((t) => count(t))
    .map((t) => `${count(t)} ${backupTypeLabel(t, true)}`)
    .join(', ');
  const content = [m.options.structure && tr('Struktur', 'Structure'), m.options.data && tr('Daten', 'Data')].filter(Boolean).join(' + ');
  return (
    <div className="ks-backup-info selectable">
      <span>{tr('Datei', 'File')}</span>
      <span>{file}</span>
      <span>{tr('Erstellt', 'Created')}</span>
      <span>
        {formatDateTime(new Date(m.created))} ({m.app})
      </span>
      <span>{tr('Größe', 'Size')}</span>
      <span>{formatBytes(size)}</span>
      <span>{tr('Server', 'Server')}</span>
      <span>
        {m.server.type === 'mariadb' ? 'MariaDB' : 'MySQL'} {m.server.version} – {m.connectionName}
      </span>
      <span>{tr('Datenbank', 'Database')}</span>
      <span>
        {m.database} ({m.charset} / {m.collation})
      </span>
      <span>{tr('Inhalt', 'Content')}</span>
      <span>
        {content}, {consistencyLabel(m.options.consistency)}
      </span>
      <span>{tr('Objekte', 'Objects')}</span>
      <span>{counts || '–'}</span>
      <span>{tr('Datensätze', 'Records')}</span>
      <span>{formatNumber(m.totals.rows)}</span>
      {m.comment && (
        <>
          <span>{tr('Kommentar', 'Comment')}</span>
          <span style={{ whiteSpace: 'pre-wrap' }}>{m.comment}</span>
        </>
      )}
      <span>{tr('Geändert', 'Modified')}</span>
      <span>{formatDateTime(mtime)}</span>
    </div>
  );
}

export function useConnectionDatabases(connectionId: string): string[] {
  const dbs = useWorkspace((s) => s.conns[connectionId]?.databases);
  return useMemo(() => (dbs ?? []).filter((d) => !d.system).map((d) => d.name), [dbs]);
}

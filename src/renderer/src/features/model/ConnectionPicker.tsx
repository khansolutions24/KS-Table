// Connection + database selection used by reverse engineering, synchronization and the data dictionary.

import { useEffect, useId, useState } from 'react';
import { tr } from '@shared/i18n';
import { Field, Select, Spinner, TextInput } from '../../components/ui/controls';
import { useWorkspace } from '../../store/workspace';

export function ConnectionDbPicker({
  connectionId,
  database,
  onChange,
  labelWidth = 120,
  allowNew = false,
  disabled
}: {
  connectionId: string;
  database: string;
  onChange: (connectionId: string, database: string) => void;
  labelWidth?: number;
  /** Free text database name (target that may not exist yet) */
  allowNew?: boolean;
  disabled?: boolean;
}) {
  const listId = useId();
  const profiles = useWorkspace((s) => s.profiles);
  const conn = useWorkspace((s) => (connectionId ? s.conns[connectionId] : undefined));
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!connectionId) return;
    const st = useWorkspace.getState().conns[connectionId]?.status;
    if (st === 'open' || st === 'connecting') return;
    setOpening(true);
    void useWorkspace
      .getState()
      .openConnection(connectionId)
      .finally(() => setOpening(false));
  }, [connectionId]);

  const dbs = conn?.status === 'open' ? conn.databases.filter((d) => !d.system).map((d) => d.name) : [];

  return (
    <>
      <Field label={tr('Verbindung', 'Connection')} labelWidth={labelWidth}>
        <Select
          value={connectionId}
          disabled={disabled}
          onChange={(v) => onChange(v, '')}
          options={[{ value: '', label: tr('(Verbindung wählen)', '(Choose connection)') }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
        />
      </Field>
      <Field label={tr('Datenbank', 'Database')} labelWidth={labelWidth}>
        <div className="row">
          {allowNew ? (
            <>
              <TextInput
                list={listId}
                value={database}
                disabled={disabled || !connectionId}
                placeholder={tr('Datenbank wählen oder neu eingeben', 'Choose or enter a new database')}
                onChange={(e) => onChange(connectionId, e.target.value)}
              />
              <datalist id={listId}>
                {dbs.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </>
          ) : (
            <Select
              value={database}
              disabled={disabled || !connectionId || conn?.status !== 'open'}
              onChange={(v) => onChange(connectionId, v)}
              options={[{ value: '', label: tr('(Datenbank wählen)', '(Choose database)') }, ...(dbs.includes(database) || !database ? dbs : [database, ...dbs])]}
            />
          )}
          {(opening || conn?.status === 'connecting') && <Spinner size={14} />}
        </div>
      </Field>
    </>
  );
}

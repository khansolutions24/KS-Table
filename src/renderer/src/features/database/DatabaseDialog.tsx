// New / edit database dialog (name, character set, collation, SQL preview).

import { useEffect, useMemo, useState } from 'react';
import { tr } from '@shared/i18n';
import type { CharsetInfo, CollationInfo } from '@shared/types';
import { quoteId } from '@shared/sql/quote';
import { api } from '../../api/client';
import { runSql } from '../../actions/sql';
import { ObjIcon } from '../../components/icons';
import { SqlHighlight } from '../../components/SqlHighlight';
import { Dialog, errorDialog } from '../../components/ui/Dialog';
import { Button, Field, Select, TabStrip, TextInput } from '../../components/ui/controls';
import { metaSession, useWorkspace } from '../../store/workspace';

export function DatabaseDialog({
  connectionId,
  database,
  onClose
}: {
  connectionId: string;
  database?: string;
  onClose: (name?: string) => void;
}) {
  const edit = !!database;
  const info = useWorkspace((s) => s.conns[connectionId]?.databases.find((d) => d.name === database));
  const [name, setName] = useState(database ?? '');
  const [charset, setCharset] = useState(info?.charset ?? '');
  const [collation, setCollation] = useState(info?.collation ?? '');
  const [charsets, setCharsets] = useState<CharsetInfo[]>([]);
  const [collations, setCollations] = useState<CollationInfo[]>([]);
  const [tab, setTab] = useState<'general' | 'sql'>('general');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sid = metaSession(connectionId);
    Promise.all([api.meta.charsets(sid), api.meta.collations(sid)])
      .then(([a, b]) => {
        setCharsets(a);
        setCollations(b);
      })
      .catch((e) => void errorDialog(e));
  }, [connectionId]);

  const sql = useMemo(() => {
    const n = name.trim();
    if (!n) return '';
    if (edit) {
      if (charset === (info?.charset ?? '') && collation === (info?.collation ?? '')) return '';
      return `ALTER DATABASE ${quoteId(n)}${charset ? ` CHARACTER SET ${charset}` : ''}${collation ? ` COLLATE ${collation}` : ''};`;
    }
    return `CREATE DATABASE ${quoteId(n)}${charset ? ` CHARACTER SET ${charset}` : ''}${collation ? ` COLLATE ${collation}` : ''};`;
  }, [name, charset, collation, edit, info]);

  const filteredCollations = collations.filter((c) => !charset || c.charset === charset);

  const save = async () => {
    if (!name.trim()) {
      setTab('general');
      return;
    }
    if (!sql) {
      onClose(name.trim());
      return;
    }
    setBusy(true);
    try {
      await runSql(connectionId, sql);
      onClose(name.trim());
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={edit ? tr('Datenbank bearbeiten – {n}', 'Edit Database – {n}', { n: database! }) : tr('Neue Datenbank', 'New Database')}
      icon={<ObjIcon kind="database" size={18} />}
      width={520}
      height={340}
      noPadding
      onClose={() => onClose()}
      onSubmit={() => void save()}
      footer={
        <>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            OK
          </Button>
          <Button onClick={() => onClose()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <TabStrip
        tabs={[
          { id: 'general', label: tr('Allgemein', 'General') },
          { id: 'sql', label: tr('SQL-Vorschau', 'SQL Preview') }
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'general' ? (
        <div className="ks-form" style={{ padding: 16 }}>
          <Field label={tr('Datenbankname', 'Database name')} labelWidth={130}>
            <TextInput data-autofocus value={name} disabled={edit} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={tr('Zeichensatz', 'Character set')} labelWidth={130}>
            <Select
              value={charset}
              onChange={(v) => {
                setCharset(v);
                setCollation(charsets.find((c) => c.charset === v)?.defaultCollation ?? '');
              }}
              options={[{ value: '', label: tr('(Serverstandard)', '(Server default)') }, ...charsets.map((c) => ({ value: c.charset, label: `${c.charset} – ${c.description}` }))]}
            />
          </Field>
          <Field label={tr('Sortierung', 'Collation')} labelWidth={130}>
            <Select
              value={collation}
              onChange={setCollation}
              options={[
                { value: '', label: tr('(Standard des Zeichensatzes)', '(Character set default)') },
                ...filteredCollations.map((c) => ({ value: c.collation, label: c.isDefault ? `${c.collation} (${tr('Standard', 'default')})` : c.collation }))
              ]}
            />
          </Field>
        </div>
      ) : (
        <div className="ks-sql-preview">
          {sql ? <SqlHighlight sql={sql} className="selectable" /> : <div className="faint" style={{ padding: 16 }}>{tr('Keine Änderungen', 'No changes')}</div>}
        </div>
      )}
    </Dialog>
  );
}

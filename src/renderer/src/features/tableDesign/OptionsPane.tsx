// Options tab of the table designer (engine dependent table options and partitioning).

import { useState } from 'react';
import { Eraser, Layers } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { TableOptions } from '@shared/types';
import { SqlHighlight } from '../../components/SqlHighlight';
import { Button, Checkbox, Field, Section, Select, TextInput } from '../../components/ui/controls';
import { openPartitionDialog } from './PartitionDialog';
import { charsetOptions, collationOptions } from './serverLists';
import type { PaneProps } from './types';

const LW = 160;
type Tri = '' | 'DEFAULT' | '0' | '1';

export function OptionsPane(p: PaneProps) {
  const { edit, update, lists } = p;
  const o = edit.options;
  const [all, setAll] = useState(false);
  const set = (patch: Partial<TableOptions>) => update((e) => ({ ...e, options: { ...e.options, ...patch } }));
  const engine = o.engine.toUpperCase();
  const innodb = all || engine === 'INNODB' || engine === '';
  const myisam = all || engine === 'MYISAM' || engine === 'ARIA';
  const merge = all || engine === 'MRG_MYISAM' || engine === 'MERGE';
  const num = (k: keyof TableOptions, hint?: string) => (
    <Field label={labelOf(k)} labelWidth={LW} hint={hint}>
      <TextInput style={{ width: 160 }} value={String(o[k])} onChange={(e) => set({ [k]: e.target.value.replace(/\D/g, '') } as Partial<TableOptions>)} />
    </Field>
  );
  const tri = (k: 'packKeys' | 'statsAutoRecalc' | 'statsPersistent') => (
    <Field label={labelOf(k)} labelWidth={LW}>
      <Select<Tri>
        style={{ width: 160 }}
        value={o[k]}
        onChange={(v) => set({ [k]: v } as Partial<TableOptions>)}
        options={[
          { value: '', label: tr('(nicht gesetzt)', '(not set)') },
          { value: 'DEFAULT', label: 'DEFAULT' },
          { value: '0', label: '0' },
          { value: '1', label: '1' }
        ]}
      />
    </Field>
  );
  const engines = lists.engines.map((e) => e.engine);
  if (o.engine && !engines.includes(o.engine)) engines.push(o.engine);

  return (
    <div className="ks-dsg-scroll">
      <div className="ks-dsg-form">
        <Section title={tr('Allgemein', 'General')}>
          <div className="ks-dsg-two-col">
            <Field label="Engine" labelWidth={LW}>
              <Select value={o.engine} onChange={(v) => set({ engine: v })} options={[{ value: '', label: tr('(Serverstandard)', '(server default)') }, ...engines]} />
            </Field>
            {num('autoIncrement', tr('Nächster Auto-Increment-Wert', 'Next auto increment value'))}
            <Field label={tr('Zeichensatz', 'Character set')} labelWidth={LW}>
              <Select value={o.charset} onChange={(v) => set({ charset: v, collation: '' })} options={charsetOptions(lists, o.charset, tr('(Datenbankstandard)', '(database default)'))} />
            </Field>
            <Field label={tr('Sortierung', 'Collation')} labelWidth={LW}>
              <Select value={o.collation} onChange={(v) => set({ collation: v })} options={collationOptions(lists, o.charset, o.collation, tr('(Standard)', '(default)'))} />
            </Field>
            <Field label={tr('Zeilenformat', 'Row format')} labelWidth={LW}>
              <Select
                value={o.rowFormat}
                onChange={(v) => set({ rowFormat: v })}
                options={[
                  { value: '', label: tr('(Standard)', '(default)') },
                  ...['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT', 'PAGE'].concat(
                    o.rowFormat && !['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT', 'PAGE'].includes(o.rowFormat) ? [o.rowFormat] : []
                  )
                ]}
              />
            </Field>
            {num('keyBlockSize')}
          </div>
          <Checkbox checked={all} onChange={setAll} label={tr('Optionen aller Engines anzeigen', 'Show options of all engines')} />
        </Section>
        {innodb && (
          <Section title="InnoDB">
            <div className="ks-dsg-two-col">
              {tri('statsAutoRecalc')}
              {tri('statsPersistent')}
              {num('statsSamplePages')}
              <Field label={labelOf('tablespace')} labelWidth={LW}>
                <TextInput value={o.tablespace} placeholder="innodb_file_per_table" onChange={(e) => set({ tablespace: e.target.value })} />
              </Field>
              <Field label={labelOf('compression')} labelWidth={LW}>
                <Select value={o.compression} onChange={(v) => set({ compression: v })} options={[{ value: '', label: tr('(nicht gesetzt)', '(not set)') }, 'None', 'Zlib', 'LZ4']} />
              </Field>
              <Field label={labelOf('encryption')} labelWidth={LW}>
                <Select<TableOptions['encryption']>
                  value={o.encryption}
                  onChange={(v) => set({ encryption: v })}
                  options={[
                    { value: '', label: tr('(nicht gesetzt)', '(not set)') },
                    { value: 'Y', label: tr('Ja (Y)', 'Yes (Y)') },
                    { value: 'N', label: tr('Nein (N)', 'No (N)') }
                  ]}
                />
              </Field>
            </div>
          </Section>
        )}
        {myisam && (
          <Section title="MyISAM / Aria">
            <div className="ks-dsg-two-col">
              {num('avgRowLength')}
              {num('maxRows')}
              {num('minRows')}
              {tri('packKeys')}
              <Field label="" labelWidth={LW}>
                <div className="col" style={{ gap: 4 }}>
                  <Checkbox checked={o.checksum} onChange={(v) => set({ checksum: v })} label={tr('Prüfsumme führen (CHECKSUM)', 'Live checksum (CHECKSUM)')} />
                  <Checkbox checked={o.delayKeyWrite} onChange={(v) => set({ delayKeyWrite: v })} label={tr('Schlüssel verzögert schreiben', 'Delay key write')} />
                </div>
              </Field>
            </div>
          </Section>
        )}
        {(innodb || myisam) && (
          <Section title={tr('Verzeichnisse', 'Directories')}>
            <Field label={labelOf('dataDirectory')} labelWidth={LW}>
              <TextInput value={o.dataDirectory} onChange={(e) => set({ dataDirectory: e.target.value })} />
            </Field>
            {myisam && (
              <Field label={labelOf('indexDirectory')} labelWidth={LW}>
                <TextInput value={o.indexDirectory} onChange={(e) => set({ indexDirectory: e.target.value })} />
              </Field>
            )}
          </Section>
        )}
        {merge && (
          <Section title="MERGE">
            <Field label={labelOf('insertMethod')} labelWidth={LW}>
              <Select<TableOptions['insertMethod']>
                style={{ width: 160 }}
                value={o.insertMethod}
                onChange={(v) => set({ insertMethod: v })}
                options={[{ value: '', label: tr('(nicht gesetzt)', '(not set)') }, 'NO', 'FIRST', 'LAST']}
              />
            </Field>
            <Field label={labelOf('union')} labelWidth={LW} hint={tr('Kommagetrennte Tabellen, z. B. `t1`,`t2`', 'Comma separated tables, e.g. `t1`,`t2`')}>
              <TextInput className="mono" value={o.union} onChange={(e) => set({ union: e.target.value })} />
            </Field>
          </Section>
        )}
        <Section title={tr('Partitionierung', 'Partitioning')}>
          {edit.partition.trim() ? (
            <div className="ks-td-partition-preview">
              <SqlHighlight sql={edit.partition} className="selectable" />
            </div>
          ) : (
            <div className="faint">{tr('Die Tabelle ist nicht partitioniert.', 'The table is not partitioned.')}</div>
          )}
          <div className="row">
            <Button
              icon={<Layers size={14} />}
              onClick={async () => {
                const r = await openPartitionDialog(edit.partition, edit.fields.map((f) => f.name).filter(Boolean));
                if (r !== null) update((e) => ({ ...e, partition: r }));
              }}
            >
              {tr('Partitionierung …', 'Partitioning …')}
            </Button>
            <Button icon={<Eraser size={14} />} disabled={!edit.partition.trim()} onClick={() => update((e) => ({ ...e, partition: '' }))}>
              {tr('Partitionierung entfernen', 'Remove partitioning')}
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function labelOf(k: keyof TableOptions): string {
  switch (k) {
    case 'autoIncrement':
      return 'Auto Increment';
    case 'keyBlockSize':
      return tr('Schlüsselblockgröße', 'Key block size');
    case 'statsAutoRecalc':
      return tr('Statistik automatisch', 'Stats auto recalc');
    case 'statsPersistent':
      return tr('Statistik persistent', 'Stats persistent');
    case 'statsSamplePages':
      return tr('Statistik-Stichproben', 'Stats sample pages');
    case 'tablespace':
      return 'Tablespace';
    case 'compression':
      return tr('Komprimierung', 'Compression');
    case 'encryption':
      return tr('Verschlüsselung', 'Encryption');
    case 'avgRowLength':
      return tr('Mittlere Zeilenlänge', 'Avg row length');
    case 'maxRows':
      return tr('Max. Zeilen', 'Max rows');
    case 'minRows':
      return tr('Min. Zeilen', 'Min rows');
    case 'packKeys':
      return tr('Schlüssel packen', 'Pack keys');
    case 'dataDirectory':
      return tr('Datenverzeichnis', 'Data directory');
    case 'indexDirectory':
      return tr('Indexverzeichnis', 'Index directory');
    case 'insertMethod':
      return tr('Einfügemethode', 'Insert method');
    case 'union':
      return tr('Tabellen (UNION)', 'Tables (UNION)');
    default:
      return k;
  }
}

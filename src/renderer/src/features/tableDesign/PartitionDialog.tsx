// Partitioning dialog: structured editor for PARTITION BY clauses with a raw SQL mode.

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { tr } from '@shared/i18n';
import {
  newPartitionDef,
  newPartitionItem,
  parsePartitionClause,
  partitionClauseSql,
  type PartitionDef,
  type PartitionItemDef,
  type PartitionMethod
} from '@shared/sql/ddl';
import { uniqueName } from '@shared/util';
import { SqlHighlight } from '../../components/SqlHighlight';
import { Button, Checkbox, Field, IconButton, RadioGroup, Select, TextArea, TextInput } from '../../components/ui/controls';
import { alertDialog, Dialog, openDialog } from '../../components/ui/Dialog';

const LW = 150;

function Body({ initial, columns, close }: { initial: string; columns: string[]; close: (v?: string | null) => void }) {
  const parsed = useMemo(() => (initial.trim() ? parsePartitionClause(initial) : newPartitionDef()), [initial]);
  const [mode, setMode] = useState<'form' | 'raw'>(parsed ? 'form' : 'raw');
  const [def, setDef] = useState<PartitionDef>(parsed ?? newPartitionDef());
  const [raw, setRaw] = useState(initial);
  const [sel, setSel] = useState(0);
  const set = (patch: Partial<PartitionDef>) => setDef((d) => ({ ...d, ...patch }));
  const setItem = (i: number, patch: Partial<PartitionItemDef>) => setDef((d) => ({ ...d, partitions: d.partitions.map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
  const hashLike = def.method === 'HASH' || def.method === 'KEY';
  const clause = mode === 'form' ? (def.expr.trim() || def.method === 'KEY' ? partitionClauseSql(def) : '') : raw.trim();

  const switchMode = (m: 'form' | 'raw') => {
    if (m === mode) return;
    if (m === 'raw') {
      setRaw(clause);
      setMode('raw');
      return;
    }
    const p = raw.trim() ? parsePartitionClause(raw) : newPartitionDef();
    if (!p) {
      void alertDialog({ kind: 'warning', message: tr('Der SQL-Text kann nicht im Formular dargestellt werden.', 'The SQL text cannot be shown in the form.') });
      return;
    }
    setDef(p);
    setMode('form');
  };

  const submit = () => {
    if (mode === 'form') {
      if (!def.expr.trim() && def.method !== 'KEY') {
        void alertDialog({ kind: 'warning', message: tr('Bitte einen Ausdruck bzw. Spalten angeben.', 'Please enter an expression or columns.') });
        return;
      }
      if ((def.method === 'RANGE' || def.method === 'LIST') && !def.partitions.length) {
        void alertDialog({ kind: 'warning', message: tr('RANGE und LIST brauchen mindestens eine Partition.', 'RANGE and LIST need at least one partition.') });
        return;
      }
      if (def.partitions.some((x) => !x.name.trim() || ((def.method === 'RANGE' || def.method === 'LIST') && !x.values.trim()))) {
        void alertDialog({ kind: 'warning', message: tr('Jede Partition braucht einen Namen und Werte.', 'Every partition needs a name and values.') });
        return;
      }
    } else if (raw.trim() && !/^\s*PARTITION\s+BY\b/i.test(raw)) {
      void alertDialog({ kind: 'warning', message: tr('Der Text muss mit PARTITION BY beginnen.', 'The text must start with PARTITION BY.') });
      return;
    }
    close(clause);
  };

  const move = (dir: -1 | 1) =>
    setDef((d) => {
      const j = sel + dir;
      if (j < 0 || j >= d.partitions.length) return d;
      const n = [...d.partitions];
      [n[sel], n[j]] = [n[j], n[sel]];
      setSel(j);
      return { ...d, partitions: n };
    });

  return (
    <Dialog
      title={tr('Partitionierung', 'Partitioning')}
      width={900}
      height={680}
      resizable
      onClose={() => close(null)}
      onSubmit={submit}
      footerLeft={
        <RadioGroup
          inline
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'form', label: tr('Formular', 'Form') },
            { value: 'raw', label: tr('SQL-Text', 'SQL text') }
          ]}
        />
      }
      footer={
        <>
          <Button type="submit" variant="primary">
            OK
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      {mode === 'raw' ? (
        <div className="ks-td-part-dialog">
          <span className="muted">{tr('PARTITION BY … (leer = keine Partitionierung)', 'PARTITION BY … (empty = no partitioning)')}</span>
          <TextArea className="mono" style={{ flex: 1, resize: 'none' }} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </div>
      ) : (
        <div className="ks-td-part-dialog">
          <div className="ks-dsg-two-col">
            <div className="ks-form">
              <Field label={tr('Partitionieren nach', 'Partition by')} labelWidth={LW}>
                <div className="row">
                  <Select<PartitionMethod>
                    style={{ width: 120 }}
                    value={def.method}
                    onChange={(method) => set({ method, linear: false, columns: false, keyAlgorithm: '', count: method === 'HASH' || method === 'KEY' ? def.count || '4' : '' })}
                    options={['RANGE', 'LIST', 'HASH', 'KEY']}
                  />
                  {hashLike && <Checkbox checked={def.linear} onChange={(linear) => set({ linear })} label="LINEAR" />}
                  {!hashLike && <Checkbox checked={def.columns} onChange={(c) => set({ columns: c })} label="COLUMNS" />}
                </div>
              </Field>
              <Field
                label={def.method === 'KEY' || def.columns ? tr('Spalten', 'Columns') : tr('Ausdruck', 'Expression')}
                labelWidth={LW}
                hint={columns.length ? `${tr('Felder', 'Fields')}: ${columns.join(', ')}` : undefined}
              >
                <TextInput className="mono" value={def.expr} placeholder={def.method === 'KEY' ? tr('(leer = Primärschlüssel)', '(empty = primary key)') : 'YEAR(`created_at`)'} onChange={(e) => set({ expr: e.target.value })} />
              </Field>
              {def.method === 'KEY' && (
                <Field label={tr('Algorithmus', 'Algorithm')} labelWidth={LW}>
                  <Select style={{ width: 120 }} value={def.keyAlgorithm} onChange={(keyAlgorithm) => set({ keyAlgorithm })} options={[{ value: '', label: tr('(Standard)', '(default)') }, '1', '2']} />
                </Field>
              )}
              {hashLike && (
                <Field label={tr('Anzahl Partitionen', 'Partitions')} labelWidth={LW} hint={tr('Wird ignoriert, wenn Partitionen einzeln definiert sind', 'Ignored when partitions are defined below')}>
                  <TextInput style={{ width: 120 }} value={def.count} onChange={(e) => set({ count: e.target.value.replace(/\D/g, '') })} />
                </Field>
              )}
            </div>
            <div className="ks-form">
              <Field label={tr('Unterpartitionen', 'Subpartition by')} labelWidth={LW}>
                <div className="row">
                  <Select<PartitionDef['subMethod']>
                    style={{ width: 120 }}
                    value={def.subMethod}
                    disabled={hashLike}
                    onChange={(subMethod) => set({ subMethod, subLinear: false, subKeyAlgorithm: '' })}
                    options={[{ value: '', label: tr('(keine)', '(none)') }, 'HASH', 'KEY']}
                  />
                  {def.subMethod && <Checkbox checked={def.subLinear} onChange={(subLinear) => set({ subLinear })} label="LINEAR" />}
                </div>
              </Field>
              {def.subMethod && (
                <>
                  <Field label={def.subMethod === 'KEY' ? tr('Spalten', 'Columns') : tr('Ausdruck', 'Expression')} labelWidth={LW}>
                    <TextInput className="mono" value={def.subExpr} onChange={(e) => set({ subExpr: e.target.value })} />
                  </Field>
                  <Field label={tr('Anzahl je Partition', 'Count per partition')} labelWidth={LW}>
                    <TextInput style={{ width: 120 }} value={def.subCount} onChange={(e) => set({ subCount: e.target.value.replace(/\D/g, '') })} />
                  </Field>
                </>
              )}
            </div>
          </div>
          <div className="row">
            <strong>{tr('Partitionen', 'Partitions')}</strong>
            <div className="spacer" />
            <IconButton
              icon={<Plus size={14} />}
              title={tr('Partition hinzufügen', 'Add partition')}
              onClick={() => {
                const name = uniqueName(`p${def.partitions.length}`, def.partitions.map((x) => x.name));
                set({ partitions: [...def.partitions, newPartitionItem(name)] });
                setSel(def.partitions.length);
              }}
            />
            <IconButton
              icon={<Trash2 size={14} />}
              title={tr('Partition entfernen', 'Remove partition')}
              disabled={!def.partitions.length}
              onClick={() => set({ partitions: def.partitions.filter((_, k) => k !== sel) })}
            />
            <IconButton icon={<ArrowUp size={14} />} title={tr('Nach oben', 'Move up')} disabled={sel <= 0} onClick={() => move(-1)} />
            <IconButton icon={<ArrowDown size={14} />} title={tr('Nach unten', 'Move down')} disabled={sel >= def.partitions.length - 1} onClick={() => move(1)} />
          </div>
          <div className="ks-td-part-grid">
            <table className="ks-table ks-dsg-grid">
              <thead>
                <tr>
                  <th style={{ minWidth: 110 }}>{tr('Name', 'Name')}</th>
                  {!hashLike && <th style={{ minWidth: 170 }}>{def.method === 'RANGE' ? 'VALUES LESS THAN' : 'VALUES IN'}</th>}
                  <th style={{ width: 100 }}>Engine</th>
                  <th style={{ minWidth: 140 }}>{tr('Kommentar', 'Comment')}</th>
                  <th style={{ minWidth: 140 }}>{tr('Datenverzeichnis', 'Data directory')}</th>
                  <th style={{ minWidth: 140 }}>{tr('Indexverzeichnis', 'Index directory')}</th>
                  <th style={{ width: 80 }}>{tr('Max. Zeilen', 'Max rows')}</th>
                  <th style={{ width: 80 }}>{tr('Min. Zeilen', 'Min rows')}</th>
                  <th style={{ minWidth: 110 }}>Tablespace</th>
                </tr>
              </thead>
              <tbody>
                {def.partitions.map((x, i) => (
                  <tr key={i} className={clsx(sel === i && 'selected')} onMouseDown={() => setSel(i)} onFocus={() => setSel(i)}>
                    <td>
                      <input className="ks-dsg-cell" value={x.name} spellCheck={false} onChange={(e) => setItem(i, { name: e.target.value })} />
                    </td>
                    {!hashLike && (
                      <td>
                        <input
                          className="ks-dsg-cell mono"
                          value={x.values}
                          spellCheck={false}
                          placeholder={def.method === 'RANGE' ? '2020 | MAXVALUE' : '1, 2, 3'}
                          onChange={(e) => setItem(i, { values: e.target.value })}
                        />
                      </td>
                    )}
                    <td>
                      <input className="ks-dsg-cell" value={x.engine} onChange={(e) => setItem(i, { engine: e.target.value })} />
                    </td>
                    <td>
                      <input className="ks-dsg-cell" value={x.comment} onChange={(e) => setItem(i, { comment: e.target.value })} />
                    </td>
                    <td>
                      <input className="ks-dsg-cell" value={x.dataDirectory} onChange={(e) => setItem(i, { dataDirectory: e.target.value })} />
                    </td>
                    <td>
                      <input className="ks-dsg-cell" value={x.indexDirectory} onChange={(e) => setItem(i, { indexDirectory: e.target.value })} />
                    </td>
                    <td>
                      <input className="ks-dsg-cell" value={x.maxRows} onChange={(e) => setItem(i, { maxRows: e.target.value.replace(/\D/g, '') })} />
                    </td>
                    <td>
                      <input className="ks-dsg-cell" value={x.minRows} onChange={(e) => setItem(i, { minRows: e.target.value.replace(/\D/g, '') })} />
                    </td>
                    <td>
                      <input className="ks-dsg-cell" value={x.tablespace} onChange={(e) => setItem(i, { tablespace: e.target.value })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!def.partitions.length && (
              <div className="ks-dsg-grid-empty">
                {hashLike ? tr('Partitionen werden anhand der Anzahl erzeugt.', 'Partitions are generated from the count.') : tr('Noch keine Partitionen', 'No partitions yet')}
              </div>
            )}
          </div>
          <div className="ks-td-partition-preview">
            {clause ? <SqlHighlight sql={clause} className="selectable" /> : <div className="faint" style={{ padding: 8 }}>–</div>}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Resolves with the new PARTITION BY clause ('' = none) or null when cancelled */
export function openPartitionDialog(current: string, columns: string[]): Promise<string | null> {
  return openDialog<string | null>((close) => <Body initial={current} columns={columns} close={close} />).then((v) => (v === undefined ? null : v));
}

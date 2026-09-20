// Compact table editor of the model designer: fields, indexes, foreign keys, checks, triggers,
// options and a DDL preview of a TableDesign that lives only in the model.

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, KeyRound, Plus, Table2, Trash2 } from 'lucide-react';
import { tr } from '@shared/i18n';
import { newField, newId } from '@shared/defaults';
import type { ModelDoc } from '@shared/model/types';
import { ensureFkIndexes, newIndex } from '@shared/model/util';
import { createTableSql, supportsCharset } from '@shared/sql/ddl';
import type { CheckDef, DefaultKind, FieldDef, FkAction, ForeignKeyDef, IndexDef, IndexField, TableDesign, TriggerDef } from '@shared/types';
import { uniqueName } from '@shared/util';
import { SqlHighlight } from '../../components/SqlHighlight';
import { Button, Checkbox, Field, Select, TabStrip, TextArea, TextInput } from '../../components/ui/controls';
import { alertDialog, Dialog, openDialog } from '../../components/ui/Dialog';
import { changeType, DATA_TYPES, validateDesign } from '../tableDesign/model';

type Page = 'fields' | 'indexes' | 'fks' | 'checks' | 'triggers' | 'options' | 'sql';

export function openTableEditor(doc: ModelDoc, design: TableDesign, tableId: string | null, page: Page = 'fields'): Promise<TableDesign | null> {
  return openDialog<TableDesign | null>((close) => <TableEditor doc={doc} initial={design} tableId={tableId} page={page} close={close} />).then((v) => v ?? null);
}

const FK_ACTIONS: FkAction[] = ['', 'RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];
const ENGINES = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV', 'Aria', 'ROCKSDB'];
const ROW_FORMATS = ['', 'DEFAULT', 'DYNAMIC', 'COMPACT', 'REDUNDANT', 'COMPRESSED', 'FIXED'];
const TYPE_LIST_ID = 'ks-te-types';

const lc = (s: string) => s.toLowerCase();

function formatIndexFields(fields: IndexField[]): string {
  return fields.map((p) => (p.expr && !p.name ? `(${p.expr})` : `${p.name}${p.subPart ? `(${p.subPart})` : ''}`) + (p.order ? ` ${p.order}` : '')).join(', ');
}

function parseIndexFields(text: string): IndexField[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(.*?)(?:\s+(ASC|DESC))?$/i.exec(s)!;
      const body = m[1].trim();
      const order = (m[2]?.toUpperCase() ?? '') as IndexField['order'];
      if (body.startsWith('(') && body.endsWith(')')) return { name: '', subPart: '', order, expr: body.slice(1, -1) };
      const p = /^(.+?)\s*\((\d+)\)$/.exec(body);
      return p ? { name: p[1].trim(), subPart: p[2], order } : { name: body, subPart: '', order };
    });
}

const listText = (a: string[]) => a.join(', ');
const parseList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function TableEditor({ doc, initial, tableId, page: initialPage, close }: { doc: ModelDoc; initial: TableDesign; tableId: string | null; page: Page; close: (v?: TableDesign | null) => void }) {
  const [d, setD] = useState<TableDesign>(() => structuredClone(initial));
  const [page, setPage] = useState<Page>(initialPage);
  const [selField, setSelField] = useState<string | null>(initial.fields[0]?.id ?? null);
  const set = (patch: Partial<TableDesign>) => setD((x) => ({ ...x, ...patch }));
  const fieldNames = d.fields.map((f) => f.name);
  const otherTables = doc.tables.filter((t) => t.id !== tableId).map((t) => t.design);

  const updateField = (id: string, fn: (f: FieldDef) => FieldDef) =>
    setD((x) => {
      const old = x.fields.find((f) => f.id === id);
      if (!old) return x;
      const nf = fn(old);
      let next: TableDesign = { ...x, fields: x.fields.map((f) => (f.id === id ? nf : f)) };
      if (old.name !== nf.name && old.name) {
        const ren = (n: string) => (lc(n) === lc(old.name) ? nf.name : n);
        next = {
          ...next,
          primaryKey: next.primaryKey.map(ren),
          indexes: next.indexes.map((ix) => ({ ...ix, fields: ix.fields.map((p) => ({ ...p, name: p.name ? ren(p.name) : p.name })) })),
          foreignKeys: next.foreignKeys.map((fk) => ({
            ...fk,
            fields: fk.fields.map(ren),
            refFields: !fk.refSchema && lc(fk.refTable) === lc(x.name) ? fk.refFields.map(ren) : fk.refFields
          }))
        };
      }
      return next;
    });

  const togglePk = (f: FieldDef, on: boolean) =>
    setD((x) => ({
      ...x,
      primaryKey: on ? [...x.primaryKey.filter((n) => lc(n) !== lc(f.name)), f.name] : x.primaryKey.filter((n) => lc(n) !== lc(f.name)),
      fields: x.fields.map((y) => (y.id === f.id && on ? { ...y, notNull: true, defaultKind: y.defaultKind === 'null' ? 'none' : y.defaultKind } : y))
    }));

  const moveField = (dir: -1 | 1) => {
    const i = d.fields.findIndex((f) => f.id === selField);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.fields.length) return;
    const fields = [...d.fields];
    [fields[i], fields[j]] = [fields[j], fields[i]];
    set({ fields });
  };

  const addField = () => {
    const f = newField({ name: uniqueName('field', fieldNames) });
    const i = d.fields.findIndex((x) => x.id === selField);
    const fields = [...d.fields];
    fields.splice(i < 0 ? fields.length : i + 1, 0, f);
    set({ fields });
    setSelField(f.id);
  };

  const removeField = () => {
    const f = d.fields.find((x) => x.id === selField);
    if (!f) return;
    const n = lc(f.name);
    const i = d.fields.indexOf(f);
    setD((x) => ({
      ...x,
      fields: x.fields.filter((y) => y.id !== f.id),
      primaryKey: x.primaryKey.filter((p) => lc(p) !== n),
      indexes: x.indexes.map((ix) => ({ ...ix, fields: ix.fields.filter((p) => lc(p.name) !== n || !p.name) })).filter((ix) => ix.fields.length),
      foreignKeys: x.foreignKeys.filter((fk) => !fk.fields.some((c) => lc(c) === n))
    }));
    setSelField(d.fields[i + 1]?.id ?? d.fields[i - 1]?.id ?? null);
  };

  const sql = useMemo(() => {
    try {
      return createTableSql({ ...d, schema: '' }, { serverType: doc.target.type }).join(';\n\n') + ';';
    } catch (e) {
      return `-- ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [d, doc.target.type]);

  const submit = async () => {
    const name = d.name.trim();
    const errors: string[] = [];
    if (!name) errors.push(tr('Bitte einen Tabellennamen eingeben.', 'Please enter a table name.'));
    if (doc.tables.some((t) => t.id !== tableId && lc(t.design.name) === lc(name)) || doc.views.some((v) => lc(v.name) === lc(name))) {
      errors.push(tr('Ein Objekt namens „{n}“ existiert bereits im Modell.', 'An object named "{n}" already exists in the model.', { n: name }));
    }
    const final = ensureFkIndexes({ ...d, name, fields: d.fields.map((f) => ({ ...f, name: f.name.trim() })) });
    for (const p of validateDesign({ ...final, schema: '' })) errors.push(p.message);
    for (const fk of final.foreignKeys) {
      if (fk.refSchema) continue;
      const parent = lc(fk.refTable) === lc(name) ? final : otherTables.find((t) => lc(t.name) === lc(fk.refTable));
      if (!parent) errors.push(tr('Fremdschlüssel „{f}“: Tabelle „{t}“ ist nicht im Modell.', 'Foreign key "{f}": table "{t}" is not part of the model.', { f: fk.name, t: fk.refTable }));
      else
        for (const c of fk.refFields)
          if (!parent.fields.some((x) => lc(x.name) === lc(c)))
            errors.push(tr('Fremdschlüssel „{f}“: Feld „{c}“ fehlt in „{t}“.', 'Foreign key "{f}": field "{c}" is missing in "{t}".', { f: fk.name, c, t: parent.name }));
    }
    if (errors.length) {
      await alertDialog({ title: tr('Tabelle prüfen', 'Check table'), kind: 'warning', message: [...new Set(errors)].slice(0, 12).join('\n') });
      return;
    }
    close(final);
  };

  const cur = d.fields.find((f) => f.id === selField) ?? null;

  return (
    <Dialog
      title={tr('Tabelle im Modell bearbeiten – {n}', 'Edit Model Table – {n}', { n: d.name || tr('Unbenannt', 'Untitled') })}
      icon={<Table2 size={16} />}
      width={980}
      height={680}
      resizable
      noPadding
      onClose={() => close(null)}
      footer={
        <>
          <Button variant="primary" onClick={() => void submit()}>
            OK
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <datalist id={TYPE_LIST_ID}>
        {DATA_TYPES.map((t) => (
          <option key={t.name} value={t.name} />
        ))}
      </datalist>
      <div className="ks-te">
        <div className="ks-te-head">
          <label>{tr('Name', 'Name')}</label>
          <TextInput data-autofocus value={d.name} onChange={(e) => set({ name: e.target.value })} />
          <label>{tr('Kommentar', 'Comment')}</label>
          <TextInput value={d.comment} onChange={(e) => set({ comment: e.target.value })} />
        </div>
        <TabStrip<Page>
          value={page}
          onChange={setPage}
          tabs={[
            { id: 'fields', label: tr('Felder', 'Fields'), badge: d.fields.length },
            { id: 'indexes', label: tr('Indizes', 'Indexes'), badge: d.indexes.length || undefined },
            { id: 'fks', label: tr('Fremdschlüssel', 'Foreign Keys'), badge: d.foreignKeys.length || undefined },
            { id: 'checks', label: tr('Prüfungen', 'Checks'), badge: d.checks.length || undefined },
            { id: 'triggers', label: tr('Trigger', 'Triggers'), badge: d.triggers.length || undefined },
            { id: 'options', label: tr('Optionen', 'Options') },
            { id: 'sql', label: 'SQL' }
          ]}
        />

        {page === 'fields' && (
          <div className="ks-te-page">
            <div className="ks-te-tools">
              <Button size="sm" icon={<Plus size={13} />} onClick={addField}>
                {tr('Feld hinzufügen', 'Add field')}
              </Button>
              <Button size="sm" icon={<Trash2 size={13} />} disabled={!cur} onClick={removeField}>
                {tr('Löschen', 'Delete')}
              </Button>
              <Button size="sm" icon={<ArrowUp size={13} />} disabled={!cur} onClick={() => moveField(-1)} title={tr('Nach oben', 'Move up')} />
              <Button size="sm" icon={<ArrowDown size={13} />} disabled={!cur} onClick={() => moveField(1)} title={tr('Nach unten', 'Move down')} />
            </div>
            <div className="ks-te-grid-wrap">
              <table className="ks-te-grid">
                <thead>
                  <tr>
                    <th style={{ width: 28 }} />
                    <th>{tr('Name', 'Name')}</th>
                    <th style={{ width: 140 }}>{tr('Typ', 'Type')}</th>
                    <th style={{ width: 70 }}>{tr('Länge', 'Length')}</th>
                    <th style={{ width: 70 }}>{tr('Dezimalen', 'Decimals')}</th>
                    <th style={{ width: 60 }}>{tr('Not Null', 'Not Null')}</th>
                    <th style={{ width: 36 }}>PK</th>
                    <th style={{ width: 36 }}>AI</th>
                    <th style={{ width: 150 }}>{tr('Standardwert', 'Default')}</th>
                    <th>{tr('Kommentar', 'Comment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.fields.map((f) => {
                    const pk = d.primaryKey.some((n) => lc(n) === lc(f.name));
                    return (
                      <tr key={f.id} className={f.id === selField ? 'sel' : undefined} onMouseDown={() => setSelField(f.id)}>
                        <td className="c">{pk && <KeyRound size={12} style={{ color: 'var(--c-key)' }} />}</td>
                        <td>
                          <TextInput value={f.name} invalid={!f.name.trim()} onChange={(e) => updateField(f.id, (x) => ({ ...x, name: e.target.value }))} />
                        </td>
                        <td>
                          <TextInput list={TYPE_LIST_ID} value={f.type} onChange={(e) => updateField(f.id, (x) => ({ ...changeType(x, e.target.value), type: e.target.value.toUpperCase() }))} />
                        </td>
                        <td>
                          <TextInput value={f.length} onChange={(e) => updateField(f.id, (x) => ({ ...x, length: e.target.value.trim() }))} />
                        </td>
                        <td>
                          <TextInput value={f.decimals} onChange={(e) => updateField(f.id, (x) => ({ ...x, decimals: e.target.value.trim() }))} />
                        </td>
                        <td className="c">
                          <Checkbox checked={f.notNull} onChange={(v) => updateField(f.id, (x) => ({ ...x, notNull: v, defaultKind: v && x.defaultKind === 'null' ? 'none' : x.defaultKind }))} />
                        </td>
                        <td className="c">
                          <Checkbox checked={pk} onChange={(v) => togglePk(f, v)} />
                        </td>
                        <td className="c">
                          <Checkbox checked={f.autoIncrement} onChange={(v) => updateField(f.id, (x) => ({ ...x, autoIncrement: v }))} />
                        </td>
                        <td>
                          <TextInput
                            value={f.defaultKind === 'null' ? 'NULL' : f.defaultKind === 'empty' ? "''" : f.defaultValue}
                            placeholder={f.defaultKind === 'none' ? tr('(kein)', '(none)') : ''}
                            disabled={f.defaultKind === 'null' || f.defaultKind === 'empty'}
                            onChange={(e) => updateField(f.id, (x) => ({ ...x, defaultValue: e.target.value, defaultKind: e.target.value === '' ? 'none' : x.defaultKind === 'expression' ? 'expression' : 'value' }))}
                          />
                        </td>
                        <td>
                          <TextInput value={f.comment} onChange={(e) => updateField(f.id, (x) => ({ ...x, comment: e.target.value }))} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {cur && <FieldDetail f={cur} onChange={(fn) => updateField(cur.id, fn)} />}
          </div>
        )}

        {page === 'indexes' && (
          <ListPage<IndexDef>
            items={d.indexes}
            onChange={(indexes) => set({ indexes })}
            create={() => newIndex(uniqueName(`idx_${d.name || 'table'}`, d.indexes.map((i) => i.name)), [])}
            head={[tr('Name', 'Name'), tr('Felder (z. B. name(20) DESC, id)', 'Fields (e.g. name(20) DESC, id)'), tr('Typ', 'Type'), tr('Methode', 'Method'), tr('Kommentar', 'Comment')]}
            row={(ix, up) => {
              const bad = ix.fields.some((p) => p.name && !fieldNames.some((n) => lc(n) === lc(p.name))) || !ix.fields.length;
              return [
                <TextInput key="n" value={ix.name} onChange={(e) => up({ name: e.target.value })} />,
                <IndexFieldsInput key="f" value={ix.fields} invalid={bad} onChange={(fields) => up({ fields })} />,
                <Select key="t" value={ix.type} onChange={(type) => up({ type })} options={['NORMAL', 'UNIQUE', 'FULLTEXT', 'SPATIAL']} />,
                <Select key="m" value={ix.method} onChange={(method) => up({ method })} options={['', 'BTREE', 'HASH']} />,
                <TextInput key="c" value={ix.comment} onChange={(e) => up({ comment: e.target.value })} />
              ];
            }}
          />
        )}

        {page === 'fks' && (
          <ListPage<ForeignKeyDef>
            items={d.foreignKeys}
            onChange={(foreignKeys) => set({ foreignKeys })}
            create={() => ({
              id: newId('r'),
              name: uniqueName(`fk_${d.name || 'table'}`, doc.tables.flatMap((t) => t.design.foreignKeys.map((f) => f.name)).concat(d.foreignKeys.map((f) => f.name))),
              fields: [],
              refSchema: '',
              refTable: otherTables[0]?.name ?? d.name,
              refFields: otherTables[0]?.primaryKey ?? [],
              onDelete: '',
              onUpdate: ''
            })}
            head={[tr('Name', 'Name'), tr('Felder', 'Fields'), tr('Referenzierte Tabelle', 'Referenced table'), tr('Referenzierte Felder', 'Referenced fields'), 'ON DELETE', 'ON UPDATE']}
            row={(fk, up) => {
              const tables = [d.name, ...otherTables.map((t) => t.name)].filter(Boolean);
              const parent = lc(fk.refTable) === lc(d.name) ? d : otherTables.find((t) => lc(t.name) === lc(fk.refTable));
              const badFields = !fk.fields.length || fk.fields.some((c) => !fieldNames.some((n) => lc(n) === lc(c)));
              const badRef = !fk.refSchema && (!parent || fk.refFields.length !== fk.fields.length || fk.refFields.some((c) => !parent.fields.some((x) => lc(x.name) === lc(c))));
              return [
                <TextInput key="n" value={fk.name} onChange={(e) => up({ name: e.target.value })} />,
                <ListInput key="f" value={fk.fields} invalid={badFields} onChange={(fields) => up({ fields })} />,
                fk.refSchema ? (
                  <TextInput key="t" value={`${fk.refSchema}.${fk.refTable}`} disabled />
                ) : (
                  <Select
                    key="t"
                    value={fk.refTable}
                    onChange={(refTable) => {
                      const p = lc(refTable) === lc(d.name) ? d : otherTables.find((t) => t.name === refTable);
                      up({ refTable, refFields: p?.primaryKey ?? [] });
                    }}
                    options={tables.includes(fk.refTable) ? tables : [fk.refTable, ...tables]}
                  />
                ),
                <ListInput key="r" value={fk.refFields} invalid={badRef} onChange={(refFields) => up({ refFields })} />,
                <Select key="d" value={fk.onDelete} onChange={(onDelete) => up({ onDelete })} options={FK_ACTIONS.map((a) => ({ value: a, label: a || tr('(Standard)', '(default)') }))} />,
                <Select key="u" value={fk.onUpdate} onChange={(onUpdate) => up({ onUpdate })} options={FK_ACTIONS.map((a) => ({ value: a, label: a || tr('(Standard)', '(default)') }))} />
              ];
            }}
          />
        )}

        {page === 'checks' && (
          <ListPage<CheckDef>
            items={d.checks}
            onChange={(checks) => set({ checks })}
            create={() => ({ id: newId('k'), name: uniqueName(`chk_${d.name || 'table'}`, d.checks.map((c) => c.name)), expr: '', enforced: true })}
            head={[tr('Name', 'Name'), tr('Ausdruck', 'Expression'), tr('Erzwungen', 'Enforced')]}
            row={(c, up) => [
              <TextInput key="n" value={c.name} onChange={(e) => up({ name: e.target.value })} />,
              <TextInput key="e" className="mono" value={c.expr} invalid={!c.expr.trim()} onChange={(e) => up({ expr: e.target.value })} />,
              <Checkbox key="f" checked={c.enforced} onChange={(enforced) => up({ enforced })} />
            ]}
          />
        )}

        {page === 'triggers' && (
          <ListPage<TriggerDef>
            items={d.triggers}
            onChange={(triggers) => set({ triggers })}
            create={() => ({
              id: newId('t'),
              name: uniqueName(`trg_${d.name || 'table'}`, d.triggers.map((t) => t.name)),
              timing: 'BEFORE',
              event: 'INSERT',
              body: 'BEGIN\n  \nEND',
              definer: '',
              orderType: '',
              orderOther: ''
            })}
            head={[tr('Name', 'Name'), tr('Zeitpunkt', 'Timing'), tr('Ereignis', 'Event'), tr('Anweisung', 'Statement')]}
            row={(t, up) => [
              <TextInput key="n" value={t.name} onChange={(e) => up({ name: e.target.value })} />,
              <Select key="t" value={t.timing} onChange={(timing) => up({ timing })} options={['BEFORE', 'AFTER']} />,
              <Select key="e" value={t.event} onChange={(event) => up({ event })} options={['INSERT', 'UPDATE', 'DELETE']} />,
              <TextArea key="b" className="mono" rows={3} value={t.body} onChange={(e) => up({ body: e.target.value })} />
            ]}
          />
        )}

        {page === 'options' && (
          <div className="ks-te-scroll">
            <div className="ks-form" style={{ maxWidth: 620 }}>
              {(
                [
                  ['engine', tr('Engine', 'Engine')],
                  ['charset', tr('Zeichensatz', 'Character set')],
                  ['collation', tr('Sortierung', 'Collation')],
                  ['rowFormat', tr('Zeilenformat', 'Row format')],
                  ['autoIncrement', 'Auto Increment'],
                  ['tablespace', 'Tablespace']
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={label} labelWidth={150}>
                  {k === 'rowFormat' ? (
                    <Select value={d.options.rowFormat} onChange={(v) => set({ options: { ...d.options, rowFormat: v } })} options={ROW_FORMATS.map((r) => ({ value: r, label: r || tr('(Standard)', '(default)') }))} />
                  ) : (
                    <>
                      <TextInput list={k === 'engine' ? 'ks-te-engines' : undefined} value={d.options[k]} onChange={(e) => set({ options: { ...d.options, [k]: e.target.value.trim() } })} />
                      {k === 'engine' && (
                        <datalist id="ks-te-engines">
                          {ENGINES.map((x) => (
                            <option key={x} value={x} />
                          ))}
                        </datalist>
                      )}
                    </>
                  )}
                </Field>
              ))}
              <Field label={tr('Partitionierung', 'Partitioning')} labelWidth={150} alignTop hint={tr('Vollständige PARTITION BY …-Klausel', 'Complete PARTITION BY … clause')}>
                <TextArea className="mono" rows={4} value={d.partition} onChange={(e) => set({ partition: e.target.value })} />
              </Field>
            </div>
          </div>
        )}

        {page === 'sql' && (
          <div className="ks-sql-preview selectable">
            <SqlHighlight sql={sql} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function FieldDetail({ f, onChange }: { f: FieldDef; onChange: (fn: (f: FieldDef) => FieldDef) => void }) {
  const set = (p: Partial<FieldDef>) => onChange((x) => ({ ...x, ...p }));
  const T = f.type.toUpperCase();
  const isEnum = T === 'ENUM' || T === 'SET';
  const LW = 120;
  return (
    <div className="ks-te-detail">
      <div className="ks-te-cols2">
        <div className="ks-form">
          <Field label={tr('Standardwert', 'Default')} labelWidth={LW}>
            <Select<DefaultKind>
              value={f.defaultKind}
              onChange={(defaultKind) => set({ defaultKind })}
              options={[
                { value: 'none', label: tr('Kein Standardwert', 'No default') },
                { value: 'null', label: 'NULL', disabled: f.notNull },
                { value: 'empty', label: tr('Leere Zeichenkette', 'Empty string') },
                { value: 'value', label: tr('Wert', 'Value') },
                { value: 'expression', label: tr('Ausdruck', 'Expression') }
              ]}
            />
          </Field>
          {(f.defaultKind === 'value' || f.defaultKind === 'expression') && (
            <Field label={f.defaultKind === 'value' ? tr('Wert', 'Value') : tr('Ausdruck', 'Expression')} labelWidth={LW}>
              <TextInput className={f.defaultKind === 'expression' ? 'mono' : undefined} value={f.defaultValue} onChange={(e) => set({ defaultValue: e.target.value })} />
            </Field>
          )}
          {isEnum && (
            <Field label={tr('Werte', 'Values')} labelWidth={LW} alignTop hint={tr('Ein Wert pro Zeile', 'One value per line')}>
              <TextArea rows={3} value={f.values.join('\n')} onChange={(e) => set({ values: e.target.value.split('\n') })} />
            </Field>
          )}
          {supportsCharset(T) && (
            <>
              <Field label={tr('Zeichensatz', 'Character set')} labelWidth={LW}>
                <TextInput value={f.charset} placeholder={tr('(Tabelle)', '(table)')} onChange={(e) => set({ charset: e.target.value.trim() })} />
              </Field>
              <Field label={tr('Sortierung', 'Collation')} labelWidth={LW}>
                <TextInput value={f.collation} placeholder={tr('(Tabelle)', '(table)')} onChange={(e) => set({ collation: e.target.value.trim() })} />
              </Field>
            </>
          )}
        </div>
        <div className="ks-form">
          <div className="row" style={{ flexWrap: 'wrap', gap: '4px 14px' }}>
            <Checkbox checked={f.unsigned} onChange={(unsigned) => set({ unsigned })} label="UNSIGNED" />
            <Checkbox checked={f.zerofill} onChange={(zerofill) => set({ zerofill })} label="ZEROFILL" />
            <Checkbox checked={f.onUpdateCurrentTimestamp} onChange={(onUpdateCurrentTimestamp) => set({ onUpdateCurrentTimestamp })} label="ON UPDATE CURRENT_TIMESTAMP" />
            <Checkbox checked={f.invisible} onChange={(invisible) => set({ invisible })} label="INVISIBLE" />
          </div>
          <div className="row">
            <Checkbox checked={f.generated} onChange={(generated) => set({ generated })} label={tr('Berechnete Spalte', 'Generated column')} />
            {f.generated && <Select value={f.generatedStored ? 'S' : 'V'} onChange={(v) => set({ generatedStored: v === 'S' })} options={[{ value: 'V', label: 'VIRTUAL' }, { value: 'S', label: 'STORED' }]} style={{ width: 110 }} />}
          </div>
          {f.generated && (
            <Field label={tr('Ausdruck', 'Expression')} labelWidth={LW}>
              <TextInput className="mono" value={f.generatedExpr} onChange={(e) => set({ generatedExpr: e.target.value })} />
            </Field>
          )}
        </div>
      </div>
    </div>
  );
}

function IndexFieldsInput({ value, onChange, invalid }: { value: IndexField[]; onChange: (v: IndexField[]) => void; invalid: boolean }) {
  const [text, setText] = useState(() => formatIndexFields(value));
  return (
    <TextInput
      value={text}
      invalid={invalid}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseIndexFields(e.target.value));
      }}
    />
  );
}

function ListInput({ value, onChange, invalid }: { value: string[]; onChange: (v: string[]) => void; invalid: boolean }) {
  const [text, setText] = useState(() => listText(value));
  const outside = listText(parseList(text)) !== listText(value);
  return (
    <TextInput
      value={outside ? listText(value) : text}
      invalid={invalid}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}

function ListPage<T extends { id: string }>({
  items,
  onChange,
  create,
  head,
  row
}: {
  items: T[];
  onChange: (items: T[]) => void;
  create: () => T;
  head: string[];
  row: (item: T, update: (p: Partial<T>) => void) => React.ReactNode[];
}) {
  const [sel, setSel] = useState<string | null>(items[0]?.id ?? null);
  return (
    <div className="ks-te-page">
      <div className="ks-te-tools">
        <Button
          size="sm"
          icon={<Plus size={13} />}
          onClick={() => {
            const it = create();
            onChange([...items, it]);
            setSel(it.id);
          }}
        >
          {tr('Hinzufügen', 'Add')}
        </Button>
        <Button size="sm" icon={<Trash2 size={13} />} disabled={!items.some((i) => i.id === sel)} onClick={() => onChange(items.filter((i) => i.id !== sel))}>
          {tr('Löschen', 'Delete')}
        </Button>
      </div>
      <div className="ks-te-grid-wrap">
        <table className="ks-te-grid">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className={it.id === sel ? 'sel' : undefined} onMouseDown={() => setSel(it.id)}>
                {row(it, (p) => onChange(items.map((x) => (x.id === it.id ? { ...x, ...p } : x)))).map((cell, i) => (
                  <td key={i}>{cell}</td>
                ))}
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={head.length} className="faint" style={{ padding: 12 }}>
                  {tr('Keine Einträge', 'No entries')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

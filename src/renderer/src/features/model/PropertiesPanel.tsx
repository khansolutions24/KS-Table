// Right pane of the model designer: properties of the model or of the selected object / relation.

import { KeyRound, Link2, Pencil } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { ModelDoc, ModelTable, ShapeKind } from '@shared/model/types';
import { fkIsOptional, fkIsUnique, relationKey, typeLabel } from '@shared/model/util';
import type { FkAction } from '@shared/types';
import { Button, Checkbox, Field, NumberInput, Select, TextArea, TextInput } from '../../components/ui/controls';
import { ColorPicker } from './colors';

export type Selection = { kind: 'none' } | { kind: 'object'; id: string } | { kind: 'many'; ids: string[] } | { kind: 'relation'; tableId: string; fkId: string };

const FK_ACTIONS: FkAction[] = ['', 'RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];

export function PropertiesPanel({
  doc,
  sel,
  change,
  editTable,
  editView
}: {
  doc: ModelDoc;
  sel: Selection;
  change: (fn: (d: ModelDoc) => ModelDoc) => void;
  editTable: (id: string, page?: 'fields' | 'fks') => void;
  editView: (id: string) => void;
}) {
  const LW = 92;
  const updTable = (id: string, fn: (t: ModelTable) => ModelTable) => change((d) => ({ ...d, tables: d.tables.map((t) => (t.id === id ? fn(t) : t)) }));
  const upd = <K extends 'views' | 'notes' | 'labels' | 'shapes' | 'layers'>(key: K, id: string, patch: Partial<ModelDoc[K][number]>) =>
    change((d) => ({ ...d, [key]: (d[key] as { id: string }[]).map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
  const pos = (o: { x: number; y: number }, key: 'tables' | 'views' | 'notes' | 'labels' | 'shapes' | 'layers', id: string) => (
    <Field label={tr('Position', 'Position')} labelWidth={LW}>
      <div className="ks-md-xy">
        <NumberInput value={Math.round(o.x)} onChange={(v) => change((d) => ({ ...d, [key]: (d[key] as { id: string; x: number }[]).map((x) => (x.id === id ? { ...x, x: v === '' ? 0 : v } : x)) }))} />
        <NumberInput value={Math.round(o.y)} onChange={(v) => change((d) => ({ ...d, [key]: (d[key] as { id: string; y: number }[]).map((x) => (x.id === id ? { ...x, y: v === '' ? 0 : v } : x)) }))} />
      </div>
    </Field>
  );
  const size = (o: { width: number; height: number }, key: 'notes' | 'shapes' | 'layers', id: string) => (
    <Field label={tr('Größe', 'Size')} labelWidth={LW}>
      <div className="ks-md-xy">
        <NumberInput value={Math.round(o.width)} min={20} onChange={(v) => upd(key, id, { width: Math.max(20, v === '' ? 20 : v) })} />
        <NumberInput value={Math.round(o.height)} min={20} onChange={(v) => upd(key, id, { height: Math.max(20, v === '' ? 20 : v) })} />
      </div>
    </Field>
  );

  let body: React.ReactNode;
  if (sel.kind === 'none') {
    const rel = doc.tables.reduce((n, t) => n + t.design.foreignKeys.length, 0);
    body = (
      <>
        <h4>{tr('Modell', 'Model')}</h4>
        <Field label={tr('Name', 'Name')} labelWidth={LW}>
          <TextInput value={doc.name} onChange={(e) => change((d) => ({ ...d, name: e.target.value }))} />
        </Field>
        <Field label={tr('Beschreibung', 'Description')} labelWidth={LW} alignTop>
          <TextArea rows={4} value={doc.description} onChange={(e) => change((d) => ({ ...d, description: e.target.value }))} />
        </Field>
        <Field label={tr('Zielserver', 'Target server')} labelWidth={LW}>
          <Select value={doc.target.type} onChange={(type) => change((d) => ({ ...d, target: { ...d.target, type } }))} options={[{ value: 'mysql', label: 'MySQL' }, { value: 'mariadb', label: 'MariaDB' }]} />
        </Field>
        <Field label={tr('Version', 'Version')} labelWidth={LW}>
          <TextInput value={doc.target.version} onChange={(e) => change((d) => ({ ...d, target: { ...d.target, version: e.target.value } }))} />
        </Field>
        <Field label={tr('Datenbank', 'Database')} labelWidth={LW} hint={tr('Standardziel für Skript und Synchronisation', 'Default target for script and synchronization')}>
          <TextInput value={doc.schema} onChange={(e) => change((d) => ({ ...d, schema: e.target.value.trim() }))} />
        </Field>
        <h4>{tr('Statistik', 'Statistics')}</h4>
        <div className="muted">
          {tr('{t} Tabellen · {v} Ansichten · {r} Beziehungen', '{t} tables · {v} views · {r} relations', { t: doc.tables.length, v: doc.views.length, r: rel })}
          {doc.source && (
            <div>
              {tr('Übernommen aus {c} / {d}', 'Imported from {c} / {d}', { c: doc.source.connection, d: doc.source.database })}
            </div>
          )}
        </div>
      </>
    );
  } else if (sel.kind === 'many') {
    body = (
      <>
        <h4>{tr('{n} Objekte ausgewählt', '{n} objects selected', { n: sel.ids.length })}</h4>
        <Field label={tr('Farbe', 'Color')} labelWidth={LW}>
          <ColorPicker
            value={null}
            onChange={(color) =>
              change((d) => {
                const ids = new Set(sel.ids);
                const set = <T extends { id: string; color: string | null }>(list: T[]) => list.map((o) => (ids.has(o.id) ? { ...o, color } : o));
                return { ...d, tables: set(d.tables), views: set(d.views), notes: set(d.notes), labels: set(d.labels), shapes: set(d.shapes), layers: set(d.layers) };
              })
            }
          />
        </Field>
      </>
    );
  } else if (sel.kind === 'relation') {
    const t = doc.tables.find((x) => x.id === sel.tableId);
    const fk = t?.design.foreignKeys.find((f) => f.id === sel.fkId);
    if (t && fk) {
      const updFk = (patch: Partial<typeof fk>) =>
        updTable(t.id, (x) => ({ ...x, design: { ...x.design, foreignKeys: x.design.foreignKeys.map((f) => (f.id === fk.id ? { ...f, ...patch } : f)) } }));
      const key = relationKey(t.id, fk.id);
      body = (
        <>
          <h4>
            <Link2 size={12} /> {tr('Beziehung', 'Relation')}
          </h4>
          <Field label={tr('Name', 'Name')} labelWidth={LW}>
            <TextInput value={fk.name} onChange={(e) => updFk({ name: e.target.value })} />
          </Field>
          <Field label={tr('Von', 'From')} labelWidth={LW}>
            <span className="ellipsis">
              {t.design.name} ({fk.fields.join(', ')})
            </span>
          </Field>
          <Field label={tr('Nach', 'To')} labelWidth={LW}>
            <span className="ellipsis">
              {fk.refSchema ? `${fk.refSchema}.` : ''}
              {fk.refTable} ({fk.refFields.join(', ')})
            </span>
          </Field>
          <Field label={tr('Kardinalität', 'Cardinality')} labelWidth={LW}>
            <span>
              {fkIsUnique(t.design, fk) ? '1 : 1' : 'n : 1'} · {fkIsOptional(t.design, fk) ? tr('optional', 'optional') : tr('erforderlich', 'mandatory')}
            </span>
          </Field>
          <Field label="ON DELETE" labelWidth={LW}>
            <Select value={fk.onDelete} onChange={(onDelete) => updFk({ onDelete })} options={FK_ACTIONS.map((a) => ({ value: a, label: a || tr('(Standard)', '(default)') }))} />
          </Field>
          <Field label="ON UPDATE" labelWidth={LW}>
            <Select value={fk.onUpdate} onChange={(onUpdate) => updFk({ onUpdate })} options={FK_ACTIONS.map((a) => ({ value: a, label: a || tr('(Standard)', '(default)') }))} />
          </Field>
          <Field label={tr('Linienfarbe', 'Line color')} labelWidth={LW}>
            <ColorPicker
              value={doc.relationColors[key] ?? null}
              onChange={(c) =>
                change((d) => {
                  const relationColors = { ...d.relationColors };
                  if (c) relationColors[key] = c;
                  else delete relationColors[key];
                  return { ...d, relationColors };
                })
              }
            />
          </Field>
          <Button icon={<Pencil size={13} />} onClick={() => editTable(t.id, 'fks')}>
            {tr('Fremdschlüssel bearbeiten …', 'Edit Foreign Keys …')}
          </Button>
        </>
      );
    }
  } else {
    const id = sel.id;
    const table = doc.tables.find((x) => x.id === id);
    const view = doc.views.find((x) => x.id === id);
    const note = doc.notes.find((x) => x.id === id);
    const label = doc.labels.find((x) => x.id === id);
    const shape = doc.shapes.find((x) => x.id === id);
    const layer = doc.layers.find((x) => x.id === id);
    if (table) {
      const d = table.design;
      body = (
        <>
          <h4>{tr('Tabelle', 'Table')}</h4>
          <Field label={tr('Name', 'Name')} labelWidth={LW}>
            <TextInput value={d.name} readOnly onDoubleClick={() => editTable(id)} title={tr('Umbenennen im Tabelleneditor', 'Rename in the table editor')} />
          </Field>
          <Field label={tr('Kommentar', 'Comment')} labelWidth={LW} alignTop>
            <TextArea rows={2} value={d.comment} onChange={(e) => updTable(id, (t) => ({ ...t, design: { ...t.design, comment: e.target.value } }))} />
          </Field>
          <Field label={tr('Engine', 'Engine')} labelWidth={LW}>
            <span>{d.options.engine || tr('(Standard)', '(default)')}</span>
          </Field>
          {pos(table, 'tables', id)}
          <Field label={tr('Farbe', 'Color')} labelWidth={LW}>
            <ColorPicker value={table.color} onChange={(color) => updTable(id, (t) => ({ ...t, color }))} />
          </Field>
          <Button icon={<Pencil size={13} />} onClick={() => editTable(id)}>
            {tr('Tabelle bearbeiten …', 'Edit Table …')}
          </Button>
          <h4>{tr('Felder ({n})', 'Fields ({n})', { n: d.fields.length })}</h4>
          <div className="ks-md-fields">
            {d.fields.map((f) => (
              <div key={f.id}>
                {d.primaryKey.some((p) => p.toLowerCase() === f.name.toLowerCase()) ? <KeyRound size={11} style={{ color: 'var(--c-key)' }} /> : <span style={{ width: 11 }} />}
                <span className="ellipsis">{f.name}</span>
                <span className="t">{typeLabel(f)}</span>
              </div>
            ))}
          </div>
          <div className="muted">
            {tr('{i} Indizes · {f} Fremdschlüssel · {c} Prüfungen · {t} Trigger', '{i} indexes · {f} foreign keys · {c} checks · {t} triggers', {
              i: d.indexes.length,
              f: d.foreignKeys.length,
              c: d.checks.length,
              t: d.triggers.length
            })}
          </div>
        </>
      );
    } else if (view) {
      body = (
        <>
          <h4>{tr('Ansicht', 'View')}</h4>
          <Field label={tr('Name', 'Name')} labelWidth={LW}>
            <TextInput value={view.name} readOnly onDoubleClick={() => editView(id)} />
          </Field>
          <Field label={tr('Kommentar', 'Comment')} labelWidth={LW} alignTop>
            <TextArea rows={2} value={view.comment} onChange={(e) => upd('views', id, { comment: e.target.value })} />
          </Field>
          {pos(view, 'views', id)}
          <Field label={tr('Farbe', 'Color')} labelWidth={LW}>
            <ColorPicker value={view.color} onChange={(color) => upd('views', id, { color })} />
          </Field>
          <Button icon={<Pencil size={13} />} onClick={() => editView(id)}>
            {tr('Ansicht bearbeiten …', 'Edit View …')}
          </Button>
        </>
      );
    } else if (note) {
      body = (
        <>
          <h4>{tr('Notiz', 'Note')}</h4>
          <TextArea className="ks-md-note-text" value={note.text} onChange={(e) => upd('notes', id, { text: e.target.value })} />
          {pos(note, 'notes', id)}
          {size(note, 'notes', id)}
          <Field label={tr('Farbe', 'Color')} labelWidth={LW}>
            <ColorPicker value={note.color} onChange={(color) => upd('notes', id, { color })} />
          </Field>
        </>
      );
    } else if (label) {
      body = (
        <>
          <h4>{tr('Beschriftung', 'Label')}</h4>
          <Field label={tr('Text', 'Text')} labelWidth={LW}>
            <TextInput value={label.text} onChange={(e) => upd('labels', id, { text: e.target.value })} />
          </Field>
          <Field label={tr('Schriftgröße', 'Font size')} labelWidth={LW}>
            <NumberInput value={label.fontSize} min={8} max={96} onChange={(v) => upd('labels', id, { fontSize: Math.min(96, Math.max(8, v === '' ? 16 : v)) })} />
          </Field>
          <Field label="" labelWidth={LW}>
            <div className="row">
              <Checkbox checked={label.bold} onChange={(bold) => upd('labels', id, { bold })} label={tr('Fett', 'Bold')} />
              <Checkbox checked={label.italic} onChange={(italic) => upd('labels', id, { italic })} label={tr('Kursiv', 'Italic')} />
            </div>
          </Field>
          {pos(label, 'labels', id)}
          <Field label={tr('Farbe', 'Color')} labelWidth={LW}>
            <ColorPicker value={label.color} onChange={(color) => upd('labels', id, { color })} />
          </Field>
        </>
      );
    } else if (shape) {
      body = (
        <>
          <h4>{tr('Form', 'Shape')}</h4>
          <Field label={tr('Art', 'Kind')} labelWidth={LW}>
            <Select<ShapeKind>
              value={shape.kind}
              onChange={(kind) => upd('shapes', id, { kind })}
              options={[
                { value: 'rect', label: tr('Rechteck', 'Rectangle') },
                { value: 'rounded', label: tr('Abgerundetes Rechteck', 'Rounded rectangle') },
                { value: 'ellipse', label: tr('Ellipse', 'Ellipse') },
                { value: 'diamond', label: tr('Raute', 'Diamond') }
              ]}
            />
          </Field>
          <Field label={tr('Text', 'Text')} labelWidth={LW} alignTop>
            <TextArea rows={2} value={shape.text} onChange={(e) => upd('shapes', id, { text: e.target.value })} />
          </Field>
          {pos(shape, 'shapes', id)}
          {size(shape, 'shapes', id)}
          <Field label={tr('Farbe', 'Color')} labelWidth={LW}>
            <ColorPicker value={shape.color} onChange={(color) => upd('shapes', id, { color })} />
          </Field>
        </>
      );
    } else if (layer) {
      body = (
        <>
          <h4>{tr('Ebene', 'Layer')}</h4>
          <Field label={tr('Name', 'Name')} labelWidth={LW}>
            <TextInput value={layer.name} onChange={(e) => upd('layers', id, { name: e.target.value })} />
          </Field>
          {pos(layer, 'layers', id)}
          {size(layer, 'layers', id)}
          <Field label={tr('Farbe', 'Color')} labelWidth={LW}>
            <ColorPicker value={layer.color} onChange={(color) => upd('layers', id, { color })} />
          </Field>
          <div className="muted" style={{ fontSize: 12 }}>
            {tr('Objekte innerhalb der Ebene werden mit ihr verschoben.', 'Objects inside the layer move together with it.')}
          </div>
        </>
      );
    }
  }
  return (
    <div className="ks-md-props">
      <div className="ks-md-panel-head">{tr('Eigenschaften', 'Properties')}</div>
      <div className="ks-md-panel-body">
        <div className="ks-md-form">{body}</div>
      </div>
    </div>
  );
}

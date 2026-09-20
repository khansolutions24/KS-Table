// Indexes, foreign keys and checks tabs of the table designer.

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Ellipsis, Plus, SquareFunction, Trash2, TriangleAlert } from 'lucide-react';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import type { FkAction, ForeignKeyDef, IndexDef, IndexField, IndexType, TableDesign } from '@shared/types';
import { Button, IconButton, Toolbar, ToolbarButton } from '../../components/ui/controls';
import { Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { useWorkspace } from '../../store/workspace';
import { pickOrdered } from './common/OrderedPicker';
import { fieldName, SELF_TABLE, typeInfo } from './model';
import { getColumns, getTableNames } from './serverLists';
import type { PaneProps } from './types';

function useRowSelection<T extends { id: string }>(rows: T[]) {
  const [sel, setSel] = useState<string | null>(rows[0]?.id ?? null);
  const current = rows.find((r) => r.id === sel) ?? null;
  return { sel: current?.id ?? null, setSel, current };
}

// ───────────────────────── Indexes ─────────────────────────

export function partsLabel(e: TableDesign, parts: IndexField[]): string {
  return parts
    .map((p) => (p.name ? `${fieldName(e, p.name)}${p.subPart ? `(${p.subPart})` : ''}${p.order ? ` ${p.order}` : ''}` : `(${p.expr ?? ''})${p.order ? ` ${p.order}` : ''}`))
    .join(', ');
}

export function IndexesPane(p: PaneProps) {
  const { edit, update } = p;
  const { sel, setSel } = useRowSelection(edit.indexes);
  const set = (id: string, patch: Partial<IndexDef>) => update((e) => ({ ...e, indexes: e.indexes.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const add = () => {
    const ix: IndexDef = { id: newId('i'), name: '', fields: [], type: 'NORMAL', method: '', comment: '', invisible: false, parser: '', keyBlockSize: '' };
    update((e) => ({ ...e, indexes: [...e.indexes, ix] }));
    setSel(ix.id);
    void editParts(ix);
  };
  const editParts = async (ix: IndexDef) => {
    const parts = await pickIndexParts(edit, ix, p.features.functionalIndexes, p.features.descIndexes);
    if (parts) set(ix.id, { fields: parts });
  };
  return (
    <div className="ks-td-pane">
      <Toolbar>
        <ToolbarButton icon={<Plus size={15} />} label={tr('Index hinzufügen', 'Add Index')} onClick={add} />
        <ToolbarButton
          icon={<Trash2 size={15} />}
          label={tr('Index löschen', 'Delete Index')}
          disabled={!sel}
          onClick={() => update((e) => ({ ...e, indexes: e.indexes.filter((x) => x.id !== sel) }))}
        />
      </Toolbar>
      <div className="ks-dsg-grid-wrap">
        <table className="ks-table ks-dsg-grid">
          <thead>
            <tr>
              <th style={{ minWidth: 180 }}>{tr('Name', 'Name')}</th>
              <th style={{ minWidth: 240 }}>{tr('Felder', 'Fields')}</th>
              <th style={{ width: 110 }}>{tr('Indextyp', 'Index type')}</th>
              <th style={{ width: 90 }}>{tr('Methode', 'Method')}</th>
              <th style={{ minWidth: 180 }}>{tr('Kommentar', 'Comment')}</th>
              {(p.features.invisibleIndexes || edit.indexes.some((i) => i.invisible)) && <th className="ks-dsg-center">{tr('Unsichtbar', 'Invisible')}</th>}
              <th style={{ width: 100 }}>{tr('Parser', 'Parser')}</th>
              <th style={{ width: 90 }}>Key Block Size</th>
            </tr>
          </thead>
          <tbody>
            {edit.indexes.map((ix) => {
              const ft = ix.type === 'FULLTEXT';
              const plain = ft || ix.type === 'SPATIAL';
              return (
                <tr key={ix.id} className={clsx(sel === ix.id && 'selected', p.problems.has(ix.id) && 'problem')} onMouseDown={() => setSel(ix.id)} onFocus={() => setSel(ix.id)}>
                  <td>
                    <input className="ks-dsg-cell" value={ix.name} placeholder={tr('(automatisch)', '(automatic)')} spellCheck={false} onChange={(e) => set(ix.id, { name: e.target.value })} />
                  </td>
                  <td>
                    <div className="ks-dsg-picker" onDoubleClick={() => void editParts(ix)}>
                      <span title={partsLabel(edit, ix.fields)}>{partsLabel(edit, ix.fields) || <span className="faint">{tr('(keine Felder)', '(no fields)')}</span>}</span>
                      <IconButton icon={<Ellipsis size={14} />} title={tr('Felder wählen', 'Choose fields')} onClick={() => void editParts(ix)} />
                    </div>
                  </td>
                  <td>
                    <select
                      className="ks-dsg-cell"
                      value={ix.type}
                      onChange={(e) => {
                        const type = e.target.value as IndexType;
                        const flat = type === 'FULLTEXT' || type === 'SPATIAL';
                        set(ix.id, {
                          type,
                          method: flat ? '' : ix.method,
                          parser: type === 'FULLTEXT' ? ix.parser : '',
                          fields: flat ? ix.fields.map((f) => ({ ...f, subPart: '', order: '' })) : ix.fields
                        });
                      }}
                    >
                      {(['NORMAL', 'UNIQUE', 'FULLTEXT', 'SPATIAL'] as IndexType[]).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select className="ks-dsg-cell" value={ix.method} disabled={plain} onChange={(e) => set(ix.id, { method: e.target.value as IndexDef['method'] })}>
                      <option value="">{tr('(Standard)', '(default)')}</option>
                      <option value="BTREE">BTREE</option>
                      <option value="HASH">HASH</option>
                    </select>
                  </td>
                  <td>
                    <input className="ks-dsg-cell" value={ix.comment} onChange={(e) => set(ix.id, { comment: e.target.value })} />
                  </td>
                  {(p.features.invisibleIndexes || edit.indexes.some((i) => i.invisible)) && (
                    <td className="ks-dsg-center">
                      <input type="checkbox" checked={ix.invisible} onChange={(e) => set(ix.id, { invisible: e.target.checked })} />
                    </td>
                  )}
                  <td>
                    <input className="ks-dsg-cell" value={ix.parser} disabled={!ft} placeholder={ft ? 'ngram' : ''} onChange={(e) => set(ix.id, { parser: e.target.value.trim() })} />
                  </td>
                  <td>
                    <input className="ks-dsg-cell" value={ix.keyBlockSize} onChange={(e) => set(ix.id, { keyBlockSize: e.target.value.replace(/\D/g, '') })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!edit.indexes.length && <div className="ks-dsg-grid-empty">{tr('Keine Indizes', 'No indexes')}</div>}
      </div>
    </div>
  );
}

function IndexPartsBody({
  edit,
  ix,
  functional,
  desc,
  close
}: {
  edit: TableDesign;
  ix: IndexDef;
  functional: boolean;
  desc: boolean;
  close: (v?: IndexField[] | null) => void;
}) {
  const [parts, setParts] = useState<IndexField[]>(ix.fields.map((f) => ({ ...f })));
  const [left, setLeft] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const flat = ix.type === 'FULLTEXT' || ix.type === 'SPATIAL';
  const used = new Set(parts.map((x) => x.name).filter(Boolean));
  const add = (id: string | null) => {
    if (!id || used.has(id)) return;
    setParts((ps) => [...ps, { name: id, subPart: '', order: '' }]);
    setSel(parts.length);
  };
  const setPart = (i: number, patch: Partial<IndexField>) => setParts((ps) => ps.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const move = (dir: -1 | 1) =>
    setParts((ps) => {
      const j = sel + dir;
      if (j < 0 || j >= ps.length) return ps;
      const n = [...ps];
      [n[sel], n[j]] = [n[j], n[sel]];
      setSel(j);
      return n;
    });
  return (
    <Dialog
      title={tr('Indexfelder – {n}', 'Index fields – {n}', { n: ix.name || tr('neuer Index', 'new index') })}
      width={760}
      onClose={() => close(null)}
      onSubmit={() => close(parts.filter((x) => x.name || x.expr?.trim()))}
      footerLeft={
        functional && !flat ? (
          <Button
            icon={<SquareFunction size={14} />}
            onClick={() => {
              setParts((ps) => [...ps, { name: '', subPart: '', order: '', expr: '' }]);
              setSel(parts.length);
            }}
          >
            {tr('Ausdruck hinzufügen', 'Add expression')}
          </Button>
        ) : undefined
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
      <div className="ks-td-idx-dialog">
        <div className="ks-dsg-list">
          {edit.fields
            .filter((f) => !used.has(f.id))
            .map((f) => (
              <div
                key={f.id}
                className={clsx('ks-dsg-list-item', left === f.id && 'selected')}
                onMouseDown={() => setLeft(f.id)}
                onDoubleClick={() => add(f.id)}
              >
                <span className="ellipsis">{f.name || tr('(ohne Name)', '(unnamed)')}</span>
                <span className="faint">{f.type}</span>
              </div>
            ))}
        </div>
        <div className="ks-dsg-list-buttons" style={{ justifyContent: 'center' }}>
          <Button size="sm" disabled={!left} onClick={() => add(left)}>
            →
          </Button>
          <Button size="sm" disabled={!parts.length} onClick={() => setParts((ps) => ps.filter((_, k) => k !== sel))}>
            ←
          </Button>
          <IconButton icon={<ArrowUp size={14} />} title={tr('Nach oben', 'Move up')} disabled={sel <= 0} onClick={() => move(-1)} />
          <IconButton icon={<ArrowDown size={14} />} title={tr('Nach unten', 'Move down')} disabled={sel >= parts.length - 1} onClick={() => move(1)} />
        </div>
        <div className="ks-td-idx-parts">
          <table className="ks-table ks-dsg-grid">
            <thead>
              <tr>
                <th>#</th>
                <th style={{ minWidth: 200 }}>{tr('Feld / Ausdruck', 'Field / expression')}</th>
                <th style={{ width: 90 }}>{tr('Präfixlänge', 'Prefix length')}</th>
                <th style={{ width: 90 }}>{tr('Sortierung', 'Order')}</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((x, i) => {
                const f = edit.fields.find((ff) => ff.id === x.name);
                const g = f ? typeInfo(f.type).group : 'other';
                return (
                  <tr key={i} className={clsx(sel === i && 'selected')} onMouseDown={() => setSel(i)}>
                    <td className="faint">{i + 1}</td>
                    <td>
                      {x.name ? (
                        <span style={{ padding: '0 5px' }}>{f?.name ?? x.name}</span>
                      ) : (
                        <input
                          className="ks-dsg-cell mono"
                          value={x.expr ?? ''}
                          placeholder="lower(`email`)"
                          spellCheck={false}
                          autoFocus
                          onChange={(e) => setPart(i, { expr: e.target.value })}
                        />
                      )}
                    </td>
                    <td>
                      <input
                        className="ks-dsg-cell"
                        value={x.subPart}
                        disabled={flat || !x.name || (g !== 'string' && g !== 'binary')}
                        onChange={(e) => setPart(i, { subPart: e.target.value.replace(/\D/g, '') })}
                      />
                    </td>
                    <td>
                      <select className="ks-dsg-cell" value={x.order} disabled={flat} onChange={(e) => setPart(i, { order: e.target.value as IndexField['order'] })}>
                        <option value="">–</option>
                        <option value="ASC">ASC</option>
                        {(desc || x.order === 'DESC') && <option value="DESC">DESC</option>}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!parts.length && <div className="ks-dsg-grid-empty">{tr('Felder links doppelklicken', 'Double-click fields on the left')}</div>}
        </div>
      </div>
    </Dialog>
  );
}

function pickIndexParts(edit: TableDesign, ix: IndexDef, functional: boolean, desc: boolean): Promise<IndexField[] | null> {
  return openDialog<IndexField[] | null>((close) => <IndexPartsBody edit={edit} ix={ix} functional={functional} desc={desc} close={close} />).then((v) => v ?? null);
}

// ───────────────────────── Foreign keys ─────────────────────────

const FK_ACTIONS: FkAction[] = ['', 'RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];

export function ForeignKeysPane(p: PaneProps) {
  const { edit, update } = p;
  const { sel, setSel } = useRowSelection(edit.foreignKeys);
  const set = (id: string, patch: Partial<ForeignKeyDef>) => update((e) => ({ ...e, foreignKeys: e.foreignKeys.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const add = () => {
    const fk: ForeignKeyDef = { id: newId('r'), name: '', fields: [], refSchema: p.database, refTable: '', refFields: [], onDelete: '', onUpdate: '' };
    update((e) => ({ ...e, foreignKeys: [...e.foreignKeys, fk] }));
    setSel(fk.id);
  };
  return (
    <div className="ks-td-pane">
      <Toolbar>
        <ToolbarButton icon={<Plus size={15} />} label={tr('Fremdschlüssel hinzufügen', 'Add Foreign Key')} onClick={add} />
        <ToolbarButton
          icon={<Trash2 size={15} />}
          label={tr('Fremdschlüssel löschen', 'Delete Foreign Key')}
          disabled={!sel}
          onClick={() => update((e) => ({ ...e, foreignKeys: e.foreignKeys.filter((x) => x.id !== sel) }))}
        />
      </Toolbar>
      <div className="ks-dsg-grid-wrap">
        <table className="ks-table ks-dsg-grid">
          <thead>
            <tr>
              <th style={{ minWidth: 170 }}>{tr('Name', 'Name')}</th>
              <th style={{ minWidth: 160 }}>{tr('Felder', 'Fields')}</th>
              <th style={{ minWidth: 140 }}>{tr('Ref. Datenbank', 'Ref. database')}</th>
              <th style={{ minWidth: 160 }}>{tr('Ref. Tabelle', 'Ref. table')}</th>
              <th style={{ minWidth: 160 }}>{tr('Ref. Felder', 'Ref. fields')}</th>
              <th style={{ width: 110 }}>{tr('Beim Löschen', 'On delete')}</th>
              <th style={{ width: 110 }}>{tr('Beim Aktualisieren', 'On update')}</th>
            </tr>
          </thead>
          <tbody>
            {edit.foreignKeys.map((fk) => (
              <FkRow key={fk.id} {...p} fk={fk} selected={sel === fk.id} onSelect={() => setSel(fk.id)} set={(patch) => set(fk.id, patch)} />
            ))}
          </tbody>
        </table>
        {!edit.foreignKeys.length && <div className="ks-dsg-grid-empty">{tr('Keine Fremdschlüssel', 'No foreign keys')}</div>}
      </div>
    </div>
  );
}

function FkRow(p: PaneProps & { fk: ForeignKeyDef; selected: boolean; onSelect: () => void; set: (patch: Partial<ForeignKeyDef>) => void }) {
  const { fk, edit, set } = p;
  const databases = useWorkspace((s) => s.conns[p.connectionId]?.databases ?? []);
  const [tables, setTables] = useState<string[]>([]);
  const schema = fk.refSchema || p.database;
  const self = fk.refTable === SELF_TABLE;
  const ownName = edit.origName ?? edit.name;

  useEffect(() => {
    let alive = true;
    getTableNames(p.connectionId, schema)
      .then((t) => alive && setTables(t))
      .catch(() => alive && setTables([]));
    return () => {
      alive = false;
    };
  }, [p.connectionId, schema]);

  const tableOptions = tables.filter((t) => !(schema === p.database && t === ownName));
  if (fk.refTable && !self && !tableOptions.includes(fk.refTable)) tableOptions.push(fk.refTable);

  const pickFields = async () => {
    const r = await pickOrdered({
      title: tr('Felder des Fremdschlüssels', 'Foreign key fields'),
      items: edit.fields.map((f) => ({ value: f.id, label: f.name || tr('(ohne Name)', '(unnamed)'), hint: f.type })),
      selected: fk.fields
    });
    if (r) set({ fields: r });
  };
  const pickRefFields = async () => {
    try {
      const items = self
        ? edit.fields.map((f) => ({ value: f.id, label: f.name, hint: f.type }))
        : (await getColumns(p.connectionId, schema, fk.refTable)).map((c) => ({ value: c.name, label: c.name, hint: c.columnType }));
      const r = await pickOrdered({ title: tr('Referenzierte Felder', 'Referenced fields'), items, selected: fk.refFields });
      if (r) set({ refFields: r });
    } catch (e) {
      void errorDialog(e);
    }
  };
  const refLabel = fk.refFields.map((f) => (self ? fieldName(edit, f) : f)).join(', ');
  return (
    <tr className={clsx(p.selected && 'selected', p.problems.has(fk.id) && 'problem')} onMouseDown={p.onSelect} onFocus={p.onSelect}>
      <td>
        <input className="ks-dsg-cell" value={fk.name} placeholder={tr('(automatisch)', '(automatic)')} spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
      </td>
      <td>
        <div className="ks-dsg-picker" onDoubleClick={() => void pickFields()}>
          <span>{fk.fields.map((f) => fieldName(edit, f)).join(', ') || <span className="faint">–</span>}</span>
          <IconButton icon={<Ellipsis size={14} />} title={tr('Felder wählen', 'Choose fields')} onClick={() => void pickFields()} />
        </div>
      </td>
      <td>
        <select className="ks-dsg-cell" value={schema} onChange={(e) => set({ refSchema: e.target.value, refTable: '', refFields: [] })}>
          {[...new Set([p.database, schema, ...databases.map((d) => d.name)])].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select className="ks-dsg-cell" value={fk.refTable} onChange={(e) => set({ refTable: e.target.value, refFields: [] })}>
          <option value="">–</option>
          {schema === p.database && <option value={SELF_TABLE}>{edit.name ? `${edit.name} ${tr('(diese Tabelle)', '(this table)')}` : tr('(diese Tabelle)', '(this table)')}</option>}
          {tableOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </td>
      <td>
        <div className="ks-dsg-picker" onDoubleClick={() => fk.refTable && void pickRefFields()}>
          <span>{refLabel || <span className="faint">–</span>}</span>
          <IconButton icon={<Ellipsis size={14} />} title={tr('Referenzierte Felder wählen', 'Choose referenced fields')} disabled={!fk.refTable} onClick={() => void pickRefFields()} />
        </div>
      </td>
      <td>
        <select className="ks-dsg-cell" value={fk.onDelete} onChange={(e) => set({ onDelete: e.target.value as FkAction })}>
          {FK_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a || tr('(Standard)', '(default)')}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select className="ks-dsg-cell" value={fk.onUpdate} onChange={(e) => set({ onUpdate: e.target.value as FkAction })}>
          {FK_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a || tr('(Standard)', '(default)')}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );
}

// ───────────────────────── Checks ─────────────────────────

export function ChecksPane(p: PaneProps) {
  const { edit, update } = p;
  const { sel, setSel } = useRowSelection(edit.checks);
  const set = (id: string, patch: Partial<TableDesign['checks'][number]>) =>
    update((e) => ({ ...e, checks: e.checks.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  return (
    <div className="ks-td-pane">
      <Toolbar>
        <ToolbarButton
          icon={<Plus size={15} />}
          label={tr('Check hinzufügen', 'Add Check')}
          onClick={() => {
            const c = { id: newId('k'), name: '', expr: '', enforced: true };
            update((e) => ({ ...e, checks: [...e.checks, c] }));
            setSel(c.id);
          }}
        />
        <ToolbarButton icon={<Trash2 size={15} />} label={tr('Check löschen', 'Delete Check')} disabled={!sel} onClick={() => update((e) => ({ ...e, checks: e.checks.filter((x) => x.id !== sel) }))} />
      </Toolbar>
      {!p.features.checks && (
        <div className="ks-dsg-banner">
          <TriangleAlert size={15} />
          {tr('Dieser Server prüft CHECK-Einschränkungen nicht (MySQL ab 8.0.16, MariaDB ab 10.2.1).', 'This server does not enforce CHECK constraints (MySQL 8.0.16+, MariaDB 10.2.1+).')}
        </div>
      )}
      <div className="ks-dsg-grid-wrap">
        <table className="ks-table ks-dsg-grid">
          <thead>
            <tr>
              <th style={{ minWidth: 200 }}>{tr('Name', 'Name')}</th>
              <th style={{ minWidth: 420 }}>{tr('Ausdruck', 'Expression')}</th>
              {p.features.checkEnforced && <th className="ks-dsg-center">{tr('Erzwungen', 'Enforced')}</th>}
            </tr>
          </thead>
          <tbody>
            {edit.checks.map((c) => (
              <tr key={c.id} className={clsx(sel === c.id && 'selected', p.problems.has(c.id) && 'problem')} onMouseDown={() => setSel(c.id)} onFocus={() => setSel(c.id)}>
                <td>
                  <input className="ks-dsg-cell" value={c.name} placeholder={tr('(automatisch)', '(automatic)')} spellCheck={false} onChange={(e) => set(c.id, { name: e.target.value })} />
                </td>
                <td>
                  <input className="ks-dsg-cell mono" value={c.expr} placeholder="`price` >= 0" spellCheck={false} onChange={(e) => set(c.id, { expr: e.target.value })} />
                </td>
                {p.features.checkEnforced && (
                  <td className="ks-dsg-center">
                    <input type="checkbox" checked={c.enforced} onChange={(e) => set(c.id, { enforced: e.target.checked })} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!edit.checks.length && <div className="ks-dsg-grid-empty">{tr('Keine Checks', 'No checks')}</div>}
      </div>
    </div>
  );
}

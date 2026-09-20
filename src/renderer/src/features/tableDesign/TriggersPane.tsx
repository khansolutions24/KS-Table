// Triggers tab of the table designer: trigger list and the body of the selected trigger.

import { useState } from 'react';
import clsx from 'clsx';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Plus, Trash2 } from 'lucide-react';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import type { TriggerDef } from '@shared/types';
import { uniqueName } from '@shared/util';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { Toolbar, ToolbarButton } from '../../components/ui/controls';
import type { PaneProps } from './types';

export function TriggersPane(p: PaneProps) {
  const { edit, update } = p;
  const [sel, setSel] = useState<string | null>(edit.triggers[0]?.id ?? null);
  const current = edit.triggers.find((t) => t.id === sel) ?? null;
  const set = (id: string, patch: Partial<TriggerDef>) => update((e) => ({ ...e, triggers: e.triggers.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const add = () => {
    const base = `trg_${edit.name || 'table'}_bi`;
    const t: TriggerDef = {
      id: newId('t'),
      name: uniqueName(base, edit.triggers.map((x) => x.name)),
      timing: 'BEFORE',
      event: 'INSERT',
      body: 'BEGIN\n  \nEND',
      definer: '',
      orderType: '',
      orderOther: ''
    };
    update((e) => ({ ...e, triggers: [...e.triggers, t] }));
    setSel(t.id);
  };
  return (
    <div className="ks-td-pane">
      <Toolbar>
        <ToolbarButton icon={<Plus size={15} />} label={tr('Trigger hinzufügen', 'Add Trigger')} onClick={add} />
        <ToolbarButton
          icon={<Trash2 size={15} />}
          label={tr('Trigger löschen', 'Delete Trigger')}
          disabled={!current}
          onClick={() => {
            update((e) => ({ ...e, triggers: e.triggers.filter((x) => x.id !== sel) }));
            setSel(edit.triggers.find((x) => x.id !== sel)?.id ?? null);
          }}
        />
      </Toolbar>
      <Group orientation="vertical" className="ks-td-split">
        <Panel id="list" defaultSize="40%" minSize="70px">
          <div className="ks-dsg-grid-wrap">
            <table className="ks-table ks-dsg-grid">
              <thead>
                <tr>
                  <th style={{ minWidth: 200 }}>{tr('Name', 'Name')}</th>
                  <th style={{ width: 100 }}>{tr('Zeitpunkt', 'Timing')}</th>
                  <th style={{ width: 100 }}>{tr('Ereignis', 'Event')}</th>
                  {p.features.triggerOrder && <th style={{ width: 110 }}>{tr('Reihenfolge', 'Order')}</th>}
                  {p.features.triggerOrder && <th style={{ minWidth: 160 }}>{tr('Bezugstrigger', 'Other trigger')}</th>}
                  <th style={{ minWidth: 170 }}>Definer</th>
                </tr>
              </thead>
              <tbody>
                {edit.triggers.map((t) => {
                  const others = edit.triggers.filter((o) => o.id !== t.id && o.timing === t.timing && o.event === t.event && o.name);
                  return (
                    <tr key={t.id} className={clsx(sel === t.id && 'selected', p.problems.has(t.id) && 'problem')} onMouseDown={() => setSel(t.id)} onFocus={() => setSel(t.id)}>
                      <td>
                        <input className="ks-dsg-cell" value={t.name} spellCheck={false} onChange={(e) => set(t.id, { name: e.target.value })} />
                      </td>
                      <td>
                        <select className="ks-dsg-cell" value={t.timing} onChange={(e) => set(t.id, { timing: e.target.value as TriggerDef['timing'], orderType: '', orderOther: '' })}>
                          <option value="BEFORE">BEFORE</option>
                          <option value="AFTER">AFTER</option>
                        </select>
                      </td>
                      <td>
                        <select className="ks-dsg-cell" value={t.event} onChange={(e) => set(t.id, { event: e.target.value as TriggerDef['event'], orderType: '', orderOther: '' })}>
                          <option value="INSERT">INSERT</option>
                          <option value="UPDATE">UPDATE</option>
                          <option value="DELETE">DELETE</option>
                        </select>
                      </td>
                      {p.features.triggerOrder && (
                        <td>
                          <select className="ks-dsg-cell" value={t.orderType} onChange={(e) => set(t.id, { orderType: e.target.value as TriggerDef['orderType'] })}>
                            <option value="">–</option>
                            <option value="FOLLOWS">FOLLOWS</option>
                            <option value="PRECEDES">PRECEDES</option>
                          </select>
                        </td>
                      )}
                      {p.features.triggerOrder && (
                        <td>
                          <select className="ks-dsg-cell" value={t.orderOther} disabled={!t.orderType} onChange={(e) => set(t.id, { orderOther: e.target.value })}>
                            <option value="">–</option>
                            {[...new Set([...others.map((o) => o.name), ...(t.orderOther ? [t.orderOther] : [])])].map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td>
                        <input
                          className="ks-dsg-cell"
                          value={t.definer}
                          placeholder={tr('(aktueller Benutzer)', '(current user)')}
                          spellCheck={false}
                          onChange={(e) => set(t.id, { definer: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!edit.triggers.length && <div className="ks-dsg-grid-empty">{tr('Keine Trigger', 'No triggers')}</div>}
          </div>
        </Panel>
        <Separator className="ks-dsg-sep-v" />
        <Panel id="body" defaultSize="60%" minSize="80px">
          <div className="ks-td-pane">
            <div className="ks-td-trigger-head">
              {current
                ? tr('Definition von „{n}“ (eine Anweisung oder BEGIN … END)', 'Definition of "{n}" (one statement or BEGIN … END)', { n: current.name })
                : tr('Kein Trigger ausgewählt', 'No trigger selected')}
            </div>
            {current && (
              <div className="ks-dsg-editor">
                <SqlEditor
                  key={current.id}
                  value={current.body}
                  onChange={(body) => set(current.id, { body })}
                  completion={{ connectionId: p.connectionId, database: p.database }}
                />
              </div>
            )}
          </div>
        </Panel>
      </Group>
    </div>
  );
}

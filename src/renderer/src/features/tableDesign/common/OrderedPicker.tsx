// Dialog to choose an ordered subset of items (fields of a foreign key, referenced fields, …).

import { useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { tr } from '@shared/i18n';
import { Button, IconButton } from '../../../components/ui/controls';
import { Dialog, openDialog } from '../../../components/ui/Dialog';
import './designer.css';

export interface PickItem {
  value: string;
  label: string;
  hint?: string;
}

function PickerBody({
  title,
  items,
  initial,
  close
}: {
  title: string;
  items: PickItem[];
  initial: string[];
  close: (v?: string[] | null) => void;
}) {
  const [chosen, setChosen] = useState<string[]>(initial.filter((v) => items.some((i) => i.value === v)));
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);
  const label = (v: string) => items.find((i) => i.value === v);
  const available = items.filter((i) => !chosen.includes(i.value));
  const add = (v: string | null) => {
    if (!v || chosen.includes(v)) return;
    setChosen((c) => [...c, v]);
    setRight(v);
    setLeft(null);
  };
  const remove = (v: string | null) => {
    if (!v) return;
    setChosen((c) => c.filter((x) => x !== v));
    setLeft(v);
    setRight(null);
  };
  const move = (dir: -1 | 1) => {
    if (!right) return;
    setChosen((c) => {
      const i = c.indexOf(right);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.length) return c;
      const n = [...c];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  };
  return (
    <Dialog
      title={title}
      width={560}
      onClose={() => close(null)}
      onSubmit={() => close(chosen)}
      footer={
        <>
          <Button type="submit" variant="primary">
            OK
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-dsg-pick">
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <span className="muted">{tr('Verfügbar', 'Available')}</span>
          <div className="ks-dsg-list" style={{ height: 260 }}>
            {available.map((i) => (
              <div
                key={i.value}
                className={clsx('ks-dsg-list-item', left === i.value && 'selected')}
                onMouseDown={() => setLeft(i.value)}
                onDoubleClick={() => add(i.value)}
              >
                <span className="ellipsis">{i.label}</span>
                {i.hint && <span className="faint ellipsis">{i.hint}</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="ks-dsg-list-buttons" style={{ justifyContent: 'center' }}>
          <IconButton icon={<ArrowRight size={15} />} title={tr('Hinzufügen', 'Add')} disabled={!left} onClick={() => add(left)} />
          <IconButton icon={<ArrowLeft size={15} />} title={tr('Entfernen', 'Remove')} disabled={!right} onClick={() => remove(right)} />
        </div>
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <span className="muted">{tr('Ausgewählt (Reihenfolge)', 'Selected (order)')}</span>
          <div className="ks-dsg-list" style={{ height: 260 }}>
            {chosen.map((v, k) => (
              <div
                key={v}
                className={clsx('ks-dsg-list-item', right === v && 'selected')}
                onMouseDown={() => setRight(v)}
                onDoubleClick={() => remove(v)}
              >
                <span className="faint">{k + 1}.</span>
                <span className="ellipsis">{label(v)?.label ?? v}</span>
                {label(v)?.hint && <span className="faint ellipsis">{label(v)?.hint}</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="ks-dsg-list-buttons" style={{ justifyContent: 'center' }}>
          <IconButton icon={<ArrowUp size={15} />} title={tr('Nach oben', 'Move up')} disabled={!right} onClick={() => move(-1)} />
          <IconButton icon={<ArrowDown size={15} />} title={tr('Nach unten', 'Move down')} disabled={!right} onClick={() => move(1)} />
        </div>
      </div>
    </Dialog>
  );
}

/** Resolves with the chosen values in order, or null when cancelled */
export function pickOrdered(o: { title: string; items: PickItem[]; selected: string[] }): Promise<string[] | null> {
  return openDialog<string[] | null>((close) => <PickerBody title={o.title} items={o.items} initial={o.selected} close={close} />).then((v) => v ?? null);
}

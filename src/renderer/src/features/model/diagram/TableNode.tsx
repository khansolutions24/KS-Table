// Table / view box of the diagrams: header, column rows with key markers and types,
// per column anchor handles for relation lines and drag handles for the relation tool.

import { memo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { Glasses, KeyRound, Link2, Table2 } from 'lucide-react';
import { tr } from '@shared/i18n';
import { columnHandle, headerHandle, type ColumnView, type TableFlowNode } from './types';

function columnTitle(c: ColumnView): string {
  const parts = [`${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`];
  if (c.pk) parts.push(tr('Primärschlüssel', 'Primary key'));
  if (c.fk) parts.push(tr('Fremdschlüssel', 'Foreign key'));
  if (c.unique) parts.push(tr('Eindeutig', 'Unique'));
  if (c.ai) parts.push('AUTO_INCREMENT');
  if (c.generated) parts.push(tr('Berechnet', 'Generated'));
  if (c.comment) parts.push(c.comment);
  return parts.join('\n');
}

function TableNodeImpl({ data, selected }: NodeProps<TableFlowNode>) {
  const hl = data.highlight ? new Set(data.highlight) : null;
  const style = {
    '--dg-color': data.color ?? (data.kind === 'view' ? 'var(--c-view)' : 'var(--c-table)'),
    width: data.width
  } as CSSProperties;
  return (
    <div className={clsx('ks-dg-table', data.kind === 'view' && 'is-view', selected && 'selected', data.connectable && 'connectable')} style={style}>
      <div className="ks-dg-head" title={data.comment || data.name}>
        <Handle type="source" position={Position.Left} id={headerHandle('l')} className="ks-dg-anchor" isConnectable={false} />
        <Handle type="source" position={Position.Right} id={headerHandle('r')} className="ks-dg-anchor" isConnectable={false} />
        {data.connectable && data.kind === 'table' && <Handle type="source" position={Position.Right} id={headerHandle('d')} className="ks-dg-drag" />}
        {data.kind === 'view' ? <Glasses size={13} className="ks-dg-head-icon" /> : <Table2 size={13} className="ks-dg-head-icon" />}
        <span className="ks-dg-title">{data.name}</span>
      </div>
      {data.showComments && data.comment && <div className="ks-dg-comment">{data.comment}</div>}
      {data.columns.length > 0 && (
        <div className="ks-dg-cols">
          {data.columns.map((c) => (
            <div key={c.name} className={clsx('ks-dg-col', c.pk && 'pk', hl?.has(c.name.toLowerCase()) && 'hl')} title={columnTitle(c)}>
              <Handle type="source" position={Position.Left} id={columnHandle(c.name, 'l')} className="ks-dg-anchor" isConnectable={false} />
              <Handle type="source" position={Position.Right} id={columnHandle(c.name, 'r')} className="ks-dg-anchor" isConnectable={false} />
              {data.connectable && data.kind === 'table' && <Handle type="source" position={Position.Right} id={columnHandle(c.name, 'd')} className="ks-dg-drag" />}
              <span className={clsx('ks-dg-key', c.pk ? 'is-pk' : c.fk && 'is-fk')}>
                {c.pk ? <KeyRound size={11} /> : c.fk ? <Link2 size={11} /> : c.unique ? <span className="ks-dg-uq">U</span> : c.indexed ? <span className="ks-dg-ix" /> : null}
              </span>
              <span className={clsx('ks-dg-name', !c.nullable && 'nn', c.fk && 'fk')}>{c.name}</span>
              {data.showTypes && <span className="ks-dg-type">{c.type}</span>}
              {data.showComments && c.comment && <span className="ks-dg-ccomment">{c.comment}</span>}
            </div>
          ))}
        </div>
      )}
      {data.hidden ? <div className="ks-dg-more">{tr('+ {n} weitere Felder', '+ {n} more fields', { n: data.hidden })}</div> : null}
      {data.lines && data.lines.length > 0 && (
        <div className="ks-dg-sql">
          {data.lines.map((l, i) => (
            <div key={i}>{l || ' '}</div>
          ))}
        </div>
      )}
      {data.kind === 'table' && data.columns.length === 0 && !data.hidden && <div className="ks-dg-more">{tr('Keine Felder', 'No fields')}</div>}
    </div>
  );
}

export const TableNode = memo(TableNodeImpl);

// Relation line between a child table (foreign key columns) and its parent table with
// crow's foot or simple arrow notation drawn at the line ends.

import { memo, type ReactNode } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Position, type EdgeProps } from '@xyflow/react';
import type { RelationFlowEdge } from './types';

const bar = (x: number, y: number, key: string) => <line key={key} x1={x} y1={y - 6} x2={x} y2={y + 6} />;
const circle = (x: number, y: number, key: string) => <circle key={key} cx={x} cy={y} r={4} className="ks-dg-glyph-fill" />;

/** Parent end: exactly one (||) or zero or one (o|) */
function parentGlyph(x: number, y: number, dir: number, optional: boolean): ReactNode[] {
  return optional ? [bar(x + dir * 8, y, 'b1'), circle(x + dir * 16, y, 'c')] : [bar(x + dir * 7, y, 'b1'), bar(x + dir * 12, y, 'b2')];
}

/** Child end: zero or many (o<) or zero or one (o|) for one-to-one relations */
function childGlyph(x: number, y: number, dir: number, many: boolean): ReactNode[] {
  if (!many) return [bar(x + dir * 8, y, 'b1'), circle(x + dir * 16, y, 'c')];
  const tip = x + dir * 12;
  return [
    <line key="f1" x1={x} y1={y - 7} x2={tip} y2={y} />,
    <line key="f2" x1={x} y1={y + 7} x2={tip} y2={y} />,
    <line key="f3" x1={x} y1={y} x2={tip} y2={y} />,
    circle(x + dir * 18, y, 'c')
  ];
}

function RelationEdgeImpl(p: EdgeProps<RelationFlowEdge>) {
  const d = p.data;
  const [path, lx, ly] = getSmoothStepPath({
    sourceX: p.sourceX,
    sourceY: p.sourceY,
    sourcePosition: p.sourcePosition,
    targetX: p.targetX,
    targetY: p.targetY,
    targetPosition: p.targetPosition,
    borderRadius: 10,
    offset: 28
  });
  const active = p.selected || d?.highlighted;
  const color = active ? 'var(--accent)' : (d?.color ?? 'var(--dg-edge)');
  const strokeWidth = active ? 2 : 1.4;
  const sDir = p.sourcePosition === Position.Left ? -1 : 1;
  const tDir = p.targetPosition === Position.Left ? -1 : 1;
  const arrow = d?.notation === 'arrow';
  return (
    <>
      <BaseEdge id={p.id} path={path} style={{ stroke: color, strokeWidth }} interactionWidth={16} />
      <g className="ks-dg-glyph" style={{ stroke: color, strokeWidth }}>
        {arrow ? (
          <polygon
            points={`${p.targetX},${p.targetY} ${p.targetX + tDir * 11},${p.targetY - 5} ${p.targetX + tDir * 11},${p.targetY + 5}`}
            style={{ fill: color }}
          />
        ) : (
          <>
            {childGlyph(p.sourceX, p.sourceY, sDir, d?.many ?? true)}
            {parentGlyph(p.targetX, p.targetY, tDir, d?.optional ?? false)}
          </>
        )}
      </g>
      {d?.showLabel && d.label && (
        <EdgeLabelRenderer>
          <div className="ks-dg-edge-label" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, borderColor: active ? 'var(--accent)' : undefined }}>
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const RelationEdge = memo(RelationEdgeImpl);

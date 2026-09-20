// Builds relation edges (foreign keys) with anchor sides that follow the current node positions.

import type { Node } from '@xyflow/react';
import type { Notation } from '@shared/model/types';
import { columnHandle, headerHandle, nodeRect, pickSides, type RelationFlowEdge } from './types';

export interface RelationSpec {
  id: string;
  /** Child node (foreign key table) */
  source: string;
  /** Parent node (referenced table) */
  target: string;
  /** Visible column rows used as anchors (null = header) */
  sourceColumn: string | null;
  targetColumn: string | null;
  many: boolean;
  optional: boolean;
  color: string | null;
  label: string;
}

export function buildEdges(
  specs: RelationSpec[],
  nodes: Node[],
  o: { notation: Notation; showLabels: boolean; highlightId: string | null; selectedIds?: Set<string> }
): RelationFlowEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: RelationFlowEdge[] = [];
  for (const r of specs) {
    const a = byId.get(r.source);
    const b = byId.get(r.target);
    if (!a || !b || a.hidden || b.hidden) continue;
    const { s, t } = pickSides(nodeRect(a), nodeRect(b), r.source === r.target);
    out.push({
      id: r.id,
      type: 'relation',
      source: r.source,
      target: r.target,
      sourceHandle: r.sourceColumn ? columnHandle(r.sourceColumn, s) : headerHandle(s),
      targetHandle: r.targetColumn ? columnHandle(r.targetColumn, t) : headerHandle(t),
      selected: o.selectedIds?.has(r.id) ?? false,
      data: {
        notation: o.notation,
        many: r.many,
        optional: r.optional,
        color: r.color,
        label: r.label,
        showLabel: o.showLabels,
        highlighted: o.highlightId === r.id
      }
    });
  }
  return out;
}

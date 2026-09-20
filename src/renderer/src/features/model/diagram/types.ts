// Node / edge data of the diagram components shared by the ER view and the model designer.

import type { Edge, Node, Rect } from '@xyflow/react';
import type { Notation } from '@shared/model/types';

export interface ColumnView {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  unique: boolean;
  indexed: boolean;
  nullable: boolean;
  ai: boolean;
  generated: boolean;
  comment: string;
}

export interface TableNodeData extends Record<string, unknown> {
  kind: 'table' | 'view';
  name: string;
  comment: string;
  color: string | null;
  columns: ColumnView[];
  /** Views: first lines of the definition */
  lines?: string[];
  /** Columns not shown (keys only mode) */
  hidden?: number;
  showTypes: boolean;
  showComments: boolean;
  /** Relation tool active: rows become connection handles */
  connectable: boolean;
  /** Columns of a hovered / selected relation (lower case) */
  highlight?: string[] | null;
  width?: number;
}

export type TableFlowNode = Node<TableNodeData, 'table'>;

export interface RelationEdgeData extends Record<string, unknown> {
  notation: Notation;
  /** Child side may have many rows (false = one-to-one) */
  many: boolean;
  /** Foreign key columns are nullable → parent optional */
  optional: boolean;
  color: string | null;
  label: string;
  showLabel: boolean;
  highlighted: boolean;
}

export type RelationFlowEdge = Edge<RelationEdgeData, 'relation'>;

export type HandleSide = 'l' | 'r' | 'd';

/** Handle id of a column row ('l'/'r' = edge anchors, 'd' = drag source of the relation tool) */
export function columnHandle(column: string, side: HandleSide): string {
  return `c:${encodeURIComponent(column)}:${side}`;
}

export function headerHandle(side: HandleSide): string {
  return `h:${side}`;
}

/** Column of a handle id (null for the header handles) */
export function handleColumn(id: string | null | undefined): string | null {
  if (!id || !id.startsWith('c:')) return null;
  const end = id.lastIndexOf(':');
  return decodeURIComponent(id.slice(2, end));
}

/** Sides for an edge between two node rectangles (child → parent). */
export function pickSides(a: Rect, b: Rect, self: boolean): { s: 'l' | 'r'; t: 'l' | 'r' } {
  if (self) return { s: 'r', t: 'r' };
  if (a.x + a.width + 24 <= b.x) return { s: 'r', t: 'l' };
  if (b.x + b.width + 24 <= a.x) return { s: 'l', t: 'r' };
  return a.x + a.width / 2 <= b.x + b.width / 2 ? { s: 'l', t: 'l' } : { s: 'r', t: 'r' };
}

export function nodeRect(n: Node, fallbackWidth = 200, fallbackHeight = 120): Rect {
  return {
    x: n.position.x,
    y: n.position.y,
    width: n.measured?.width ?? n.width ?? fallbackWidth,
    height: n.measured?.height ?? n.height ?? fallbackHeight
  };
}

/** Size estimate of a table node before it was measured (for the first layout). */
export function estimateTableSize(name: string, columns: { name: string; type: string }[], showTypes: boolean): { width: number; height: number } {
  let w = name.length * 7.6 + 56;
  for (const c of columns) w = Math.max(w, 40 + c.name.length * 7 + (showTypes ? c.type.length * 6.4 + 22 : 0));
  return { width: Math.round(Math.min(420, Math.max(150, w))), height: 34 + Math.max(1, columns.length) * 22 + 6 };
}

// Automatic layout: dagre for every connected group of tables, groups and single tables
// packed in rows (shelf packing) so that unrelated tables do not form one long column.

import dagre from '@dagrejs/dagre';

export interface LayoutItem {
  id: string;
  width: number;
  height: number;
}

export interface LayoutLink {
  /** Child (referencing) item */
  from: string;
  /** Parent (referenced) item */
  to: string;
}

export interface LayoutOptions {
  nodeSep?: number;
  rankSep?: number;
  /** Space between packed groups */
  gap?: number;
  origin?: { x: number; y: number };
}

interface Placed {
  ids: string[];
  pos: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

function components(items: LayoutItem[], links: LayoutLink[]): string[][] {
  const parent = new Map(items.map((i) => [i.id, i.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const l of links) {
    if (!parent.has(l.from) || !parent.has(l.to)) continue;
    const a = find(l.from);
    const b = find(l.to);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<string, string[]>();
  for (const i of items) {
    const r = find(i.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i.id);
  }
  return [...groups.values()];
}

function layoutGroup(ids: string[], byId: Map<string, LayoutItem>, links: LayoutLink[], o: Required<Omit<LayoutOptions, 'origin'>>): Placed {
  if (ids.length === 1) {
    const it = byId.get(ids[0])!;
    return { ids, pos: new Map([[it.id, { x: 0, y: 0 }]]), width: it.width, height: it.height };
  }
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: o.nodeSep, ranksep: o.rankSep, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const set = new Set(ids);
  for (const id of ids) {
    const it = byId.get(id)!;
    g.setNode(id, { width: it.width, height: it.height });
  }
  for (const l of links) if (l.from !== l.to && set.has(l.from) && set.has(l.to)) g.setEdge(l.to, l.from);
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const n = g.node(id) as { x: number; y: number; width: number; height: number };
    const x = n.x - n.width / 2;
    const y = n.y - n.height / 2;
    pos.set(id, { x, y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + n.width);
    maxY = Math.max(maxY, y + n.height);
  }
  for (const p of pos.values()) {
    p.x -= minX;
    p.y -= minY;
  }
  return { ids, pos, width: maxX - minX, height: maxY - minY };
}

/** Top-left positions for all items. */
export function layoutGraph(items: LayoutItem[], links: LayoutLink[], opts: LayoutOptions = {}): Map<string, { x: number; y: number }> {
  const o = { nodeSep: opts.nodeSep ?? 36, rankSep: opts.rankSep ?? 90, gap: opts.gap ?? 70 };
  const origin = opts.origin ?? { x: 0, y: 0 };
  const byId = new Map(items.map((i) => [i.id, i]));
  const groups = components(items, links)
    .map((ids) => layoutGroup(ids, byId, links, o))
    .sort((a, b) => b.ids.length - a.ids.length || b.width * b.height - a.width * a.height);
  const totalArea = groups.reduce((s, g) => s + (g.width + o.gap) * (g.height + o.gap), 0);
  const maxRow = Math.max(groups[0]?.width ?? 0, Math.sqrt(totalArea) * 1.5);
  const out = new Map<string, { x: number; y: number }>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const g of groups) {
    if (x > 0 && x + g.width > maxRow) {
      x = 0;
      y += rowH + o.gap;
      rowH = 0;
    }
    for (const [id, p] of g.pos) out.set(id, { x: Math.round(origin.x + x + p.x), y: Math.round(origin.y + y + p.y) });
    x += g.width + o.gap;
    rowH = Math.max(rowH, g.height);
  }
  return out;
}

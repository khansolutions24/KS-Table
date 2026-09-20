// ER diagram of a database (third view mode of the table list in the Objects tab):
// tables with columns / keys, foreign key lines, auto layout, zoom, minimap, relation tool,
// context menus, image export / print; positions are remembered per connection and database.

import '@xyflow/react/dist/style.css';
import './model.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type Node,
  type NodeChange,
  type Viewport
} from '@xyflow/react';
import {
  BookOpen,
  Columns3,
  Eye,
  FileImage,
  Image,
  KeyRound,
  LayoutDashboard,
  Link2,
  Map as MapIcon,
  Maximize,
  MousePointer2,
  Network,
  Printer,
  RefreshCw,
  Fullscreen,
  Tag,
  Trash2,
  Type,
  Wrench,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import type { DiagramTable, SchemaDiagram } from '@shared/apis/model';
import { tr } from '@shared/i18n';
import type { Notation } from '@shared/model/types';
import { qname, quoteId } from '@shared/sql/quote';
import { uniqueName } from '@shared/util';
import type { ErViewProps } from '../objects/ObjectsTab';
import { api } from '../../api/client';
import * as O from '../../actions/objects';
import { runSql } from '../../actions/sql';
import { SqlHighlight } from '../../components/SqlHighlight';
import { toast } from '../../components/Toast';
import { IconButton, Select, Spinner } from '../../components/ui/controls';
import { confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { SEP, showContextMenu, showMenuBelow, type MenuItem } from '../../components/ui/Menu';
import { keyCombo } from '../../lib/shortcuts';
import { useResolvedTheme } from '../../lib/theme';
import { metaSession } from '../../store/workspace';
import { colorMenuItems } from './colors';
import { openDictionaryDialog } from './DictionaryDialog';
import { openModelTab } from './files';
import { buildEdges, type RelationSpec } from './diagram/edges';
import { printImage, renderDiagram, saveImage, withLightTheme, type ImageFormat } from './diagram/image';
import { layoutGraph } from './diagram/layout';
import { RelationEdge } from './diagram/RelationEdge';
import { TableNode } from './diagram/TableNode';
import { estimateTableSize, handleColumn, nodeRect, type ColumnView, type TableFlowNode } from './diagram/types';

interface ErState {
  pos: Record<string, { x: number; y: number }>;
  colors: Record<string, string>;
  viewport: Viewport | null;
  showTypes: boolean;
  keysOnly: boolean;
  minimap: boolean;
  labels: boolean;
  notation: Notation;
}

const defaultState = (): ErState => ({ pos: {}, colors: {}, viewport: null, showTypes: true, keysOnly: false, minimap: true, labels: false, notation: 'crowsfoot' });
const storageKey = (cid: string, db: string) => `ks-er:${cid}:${db}`;

function loadState(cid: string, db: string): ErState {
  try {
    const raw = localStorage.getItem(storageKey(cid, db));
    return raw ? { ...defaultState(), ...(JSON.parse(raw) as Partial<ErState>) } : defaultState();
  } catch {
    return defaultState();
  }
}

function storeState(cid: string, db: string, s: ErState): void {
  try {
    localStorage.setItem(storageKey(cid, db), JSON.stringify(s));
  } catch {
    // storage full / unavailable – layout is not remembered
  }
}

const nodeTypes = { table: TableNode };
const edgeTypes = { relation: RelationEdge };
/** Separator of edge ids (table + constraint name) */
const SEP_ID = String.fromCharCode(1);
const lc = (s: string) => s.toLowerCase();
const sameSet = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((x) => b.includes(x));

function visibleColumns(t: DiagramTable, referenced: Set<string>, keysOnly: boolean): ColumnView[] {
  const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns.map(lc)));
  return t.columns
    .map((c) => ({
      name: c.name,
      type: c.type,
      pk: c.pk,
      fk: fkCols.has(lc(c.name)),
      unique: c.unique,
      indexed: c.indexed,
      nullable: c.nullable,
      ai: c.autoIncrement,
      generated: c.generated,
      comment: c.comment
    }))
    .filter((c) => !keysOnly || c.pk || c.fk || referenced.has(lc(c.name)));
}

export default function ErDiagramView(props: ErViewProps) {
  return (
    <ReactFlowProvider>
      <ErInner key={`${props.connectionId}:${props.database}`} {...props} />
    </ReactFlowProvider>
  );
}

function ErInner({ connectionId, database, selected, onSelect, onOpen }: ErViewProps) {
  const theme = useResolvedTheme();
  const rf = useReactFlow<TableFlowNode>();
  const { zoom } = useViewport();
  const rootRef = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState<ErState>(() => loadState(connectionId, database));
  const stRef = useRef(st);
  stRef.current = st;
  const [schema, setSchema] = useState<SchemaDiagram | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<TableFlowNode[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [tool, setTool] = useState<'select' | 'relation'>('select');
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [selEdges, setSelEdges] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const update = useCallback(
    (patch: Partial<ErState>) => {
      setSt((cur) => {
        const next = { ...cur, ...patch };
        storeState(connectionId, database, next);
        return next;
      });
    },
    [connectionId, database]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSchema(await api.model.schemaDiagram(metaSession(connectionId), database));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, database]);

  useEffect(() => {
    void load();
  }, [load]);

  const tables = useMemo(() => new Map((schema?.tables ?? []).map((t) => [t.name, t])), [schema]);

  /** Columns referenced by foreign keys of other tables (lower case per table) */
  const referenced = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const t of schema?.tables ?? []) {
      for (const fk of t.foreignKeys) {
        if (lc(fk.refSchema) !== lc(database)) continue;
        if (!m.has(fk.refTable)) m.set(fk.refTable, new Set());
        fk.refColumns.forEach((c) => m.get(fk.refTable)!.add(lc(c)));
      }
    }
    return m;
  }, [schema, database]);

  const specs = useMemo<RelationSpec[]>(() => {
    const out: RelationSpec[] = [];
    for (const t of schema?.tables ?? []) {
      for (const fk of t.foreignKeys) {
        const parent = tables.get(fk.refTable);
        if (!parent || lc(fk.refSchema) !== lc(database)) continue;
        const childCols = visibleColumns(t, referenced.get(t.name) ?? new Set(), st.keysOnly).map((c) => lc(c.name));
        const parentCols = visibleColumns(parent, referenced.get(parent.name) ?? new Set(), st.keysOnly).map((c) => lc(c.name));
        const unique = sameSet(t.primaryKey.map(lc), fk.columns.map(lc)) || t.uniqueKeys.some((u) => sameSet(u.map(lc), fk.columns.map(lc)));
        out.push({
          id: `${t.name}${SEP_ID}${fk.name}`,
          source: t.name,
          target: parent.name,
          sourceColumn: childCols.includes(lc(fk.columns[0])) ? fk.columns[0] : null,
          targetColumn: parentCols.includes(lc(fk.refColumns[0])) ? fk.refColumns[0] : null,
          many: !unique,
          optional: fk.columns.some((c) => t.columns.find((x) => x.name === c)?.nullable),
          color: null,
          label: fk.name
        });
      }
    }
    return out;
  }, [schema, tables, referenced, database, st.keysOnly]);

  // (re)build nodes when the schema or display options change; keep positions of existing nodes
  useEffect(() => {
    if (!schema) return;
    const s = stRef.current;
    const hl = hoverEdge ? specs.find((r) => r.id === hoverEdge) : null;
    const hlFk = hl ? tables.get(hl.source)?.foreignKeys.find((f) => `${hl.source}${SEP_ID}${f.name}` === hl.id) : null;
    {
      const prev = nodesRef.current;
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const sel = new Set(selectedRef.current);
      const next: TableFlowNode[] = schema.tables.map((t) => {
        const cols = visibleColumns(t, referenced.get(t.name) ?? new Set(), s.keysOnly);
        const old = prevById.get(t.name);
        let highlight: string[] | null = null;
        if (hl && hlFk) {
          if (t.name === hl.source) highlight = hlFk.columns.map(lc);
          if (t.name === hl.target) highlight = [...(highlight ?? []), ...hlFk.refColumns.map(lc)];
        }
        return {
          id: t.name,
          type: 'table',
          position: old?.position ?? s.pos[t.name] ?? { x: 0, y: 0 },
          selected: old ? old.selected : sel.has(t.name),
          measured: old && old.data.columns.length === cols.length && old.data.showTypes === s.showTypes ? old.measured : undefined,
          data: {
            kind: 'table',
            name: t.name,
            comment: t.comment,
            color: s.colors[t.name] ?? null,
            columns: cols,
            hidden: t.columns.length - cols.length,
            showTypes: s.showTypes,
            showComments: false,
            connectable: tool === 'relation',
            highlight
          }
        };
      });
      // tables without a stored position get an automatic layout next to the known ones
      const missing = schema.tables.filter((t) => !prevById.has(t.name) && !s.pos[t.name]);
      if (missing.length) {
        const placed = next.filter((n) => prevById.has(n.id) || s.pos[n.id]);
        const originY = placed.length ? Math.max(...placed.map((n) => n.position.y + (n.measured?.height ?? 200))) + 80 : 0;
        const positions = layoutGraph(
          missing.map((t) => ({ id: t.name, ...estimateTableSize(t.name, visibleColumns(t, referenced.get(t.name) ?? new Set(), s.keysOnly), s.showTypes) })),
          missing.flatMap((t) => t.foreignKeys.map((f) => ({ from: t.name, to: f.refTable }))),
          { origin: { x: 0, y: originY } }
        );
        for (const n of next) {
          const p = positions.get(n.id);
          if (p) n.position = p;
        }
        const pos = { ...s.pos };
        for (const n of next) pos[n.id] = n.position;
        update({ pos });
      }
      setNodes(next);
    }
  }, [schema, referenced, tables, specs, st.keysOnly, st.showTypes, st.colors, tool, hoverEdge, update]);

  // selection from outside (list view / toolbar)
  useEffect(() => {
    const sel = new Set(selected);
    setNodes((ns) => (ns.some((n) => !!n.selected !== sel.has(n.id)) ? ns.map((n) => (!!n.selected !== sel.has(n.id) ? { ...n, selected: sel.has(n.id) } : n)) : ns));
  }, [selected]);

  // initial viewport
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !nodes.length || nodes.some((n) => !n.measured)) return;
    initialized.current = true;
    const vp = stRef.current.viewport;
    if (vp) void rf.setViewport(vp);
    else void rf.fitView({ padding: 0.1, maxZoom: 1 });
  }, [nodes, rf]);

  const edges = useMemo(
    () => buildEdges(specs, nodes, { notation: st.notation, showLabels: st.labels, highlightId: hoverEdge, selectedIds: selEdges }),
    [specs, nodes, st.notation, st.labels, hoverEdge, selEdges]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<TableFlowNode>[]) => {
      setNodes((ns) => {
        const next = applyNodeChanges(changes, ns);
        if (changes.some((c) => c.type === 'select')) {
          const names = next.filter((n) => n.selected).map((n) => n.id);
          const cur = selectedRef.current;
          if (names.length !== cur.length || names.some((n) => !cur.includes(n))) queueMicrotask(() => onSelect(names));
        }
        return next;
      });
    },
    [onSelect]
  );

  const savePositions = useCallback(() => {
    const pos = { ...stRef.current.pos };
    for (const n of rf.getNodes()) pos[n.id] = n.position;
    update({ pos });
  }, [rf, update]);

  const autoLayout = (onlySelected: boolean) => {
    const all = rf.getNodes();
    const target = onlySelected ? all.filter((n) => n.selected) : all;
    if (!target.length) return;
    const ids = new Set(target.map((n) => n.id));
    const origin = onlySelected ? { x: Math.min(...target.map((n) => n.position.x)), y: Math.min(...target.map((n) => n.position.y)) } : { x: 0, y: 0 };
    const positions = layoutGraph(
      target.map((n) => ({ id: n.id, width: nodeRect(n).width, height: nodeRect(n).height })),
      target.flatMap((n) => (tables.get(n.id)?.foreignKeys ?? []).filter((f) => ids.has(f.refTable)).map((f) => ({ from: n.id, to: f.refTable }))),
      { origin }
    );
    setNodes((ns) => ns.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n)));
    const pos = { ...stRef.current.pos };
    for (const [id, p] of positions) pos[id] = p;
    update({ pos });
    if (!onlySelected) window.setTimeout(() => void rf.fitView({ padding: 0.1, maxZoom: 1, duration: 200 }), 30);
  };

  const exportImage = async (format: ImageFormat, only?: string[]) => {
    const el = rootRef.current;
    if (!el) return;
    setBusy(true);
    try {
      const list = only ? rf.getNodes().filter((n) => only.includes(n.id)) : rf.getNodes();
      const url = await renderDiagram(el, list, format, { only: !!only });
      const file = await saveImage(url, `${only?.length === 1 ? only[0] : database}.${format}`, format);
      if (file) toast(tr('Bild gespeichert: {f}', 'Image saved: {f}', { f: file }), 'success');
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  const print = async () => {
    const el = rootRef.current;
    if (!el) return;
    setBusy(true);
    try {
      const url = await withLightTheme(() => renderDiagram(el, rf.getNodes(), 'png'));
      printImage(url, database);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  const setColor = (names: string[], color: string | null) => {
    const colors = { ...stRef.current.colors };
    for (const n of names) {
      if (color) colors[n] = color;
      else delete colors[n];
    }
    update({ colors });
  };

  const selectConnected = (name: string) => {
    const ids = new Set([name]);
    for (const r of specs) {
      if (r.source === name) ids.add(r.target);
      if (r.target === name) ids.add(r.source);
    }
    setNodes((ns) => ns.map((n) => ({ ...n, selected: ids.has(n.id) })));
    onSelect([...ids]);
  };

  const dropForeignKey = async (edgeId: string) => {
    const [table, fk] = edgeId.split(SEP_ID);
    const sql = `ALTER TABLE ${qname(database, table)} DROP FOREIGN KEY ${quoteId(fk)}`;
    const ok = await confirmDialog({
      title: tr('Fremdschlüssel löschen', 'Delete Foreign Key'),
      message: (
        <>
          {tr('Soll der Fremdschlüssel „{f}“ der Tabelle „{t}“ gelöscht werden?', 'Delete foreign key "{f}" of table "{t}"?', { f: fk, t: table })}
          <div className="ks-sqlbox" style={{ marginTop: 10 }}>
            <SqlHighlight sql={sql} />
          </div>
        </>
      ),
      okLabel: tr('Löschen', 'Delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await runSql(connectionId, sql);
      setSelEdges(new Set());
      toast(tr('Fremdschlüssel gelöscht', 'Foreign key deleted'), 'success');
      await load();
    } catch (e) {
      void errorDialog(e);
    }
  };

  const onConnect = async (c: Connection) => {
    const child = tables.get(c.source);
    const parent = tables.get(c.target);
    if (!child || !parent) return;
    const childCol = handleColumn(c.sourceHandle);
    if (!childCol) {
      toast(tr('Ziehen Sie ein Feld der Detailtabelle auf ein Feld der referenzierten Tabelle.', 'Drag a field of the child table onto a field of the referenced table.'));
      return;
    }
    const parentCols = handleColumn(c.targetHandle) ? [handleColumn(c.targetHandle)!] : parent.primaryKey;
    if (parentCols.length !== 1) {
      toast(tr('Die referenzierte Tabelle hat keinen einspaltigen Primärschlüssel – bitte ein Zielfeld wählen.', 'The referenced table has no single-column primary key – please drop onto a target field.'));
      return;
    }
    const names = (schema?.tables ?? []).flatMap((t) => t.foreignKeys.map((f) => f.name));
    const name = uniqueName(`fk_${child.name}_${parent.name}`.slice(0, 60), names);
    const sql = `ALTER TABLE ${qname(database, child.name)}\n  ADD CONSTRAINT ${quoteId(name)} FOREIGN KEY (${quoteId(childCol)}) REFERENCES ${qname(database, parent.name)} (${quoteId(parentCols[0])})`;
    const ok = await confirmDialog({
      title: tr('Fremdschlüssel anlegen', 'Create Foreign Key'),
      message: (
        <>
          {tr('„{c}“ referenziert „{p}“. Folgende Anweisung wird ausgeführt:', '"{c}" references "{p}". The following statement will be executed:', {
            c: `${child.name}.${childCol}`,
            p: `${parent.name}.${parentCols[0]}`
          })}
          <div className="ks-sqlbox" style={{ marginTop: 10 }}>
            <SqlHighlight sql={sql} />
          </div>
        </>
      ),
      okLabel: tr('Anlegen', 'Create')
    });
    if (!ok) return;
    try {
      await runSql(connectionId, sql);
      toast(tr('Fremdschlüssel „{n}“ angelegt', 'Foreign key "{n}" created', { n: name }), 'success');
      await load();
    } catch (e) {
      void errorDialog(e);
    }
  };

  const nodeMenu = (e: React.MouseEvent, node: Node) => {
    const cur = rf.getNodes().filter((n) => n.selected).map((n) => n.id);
    const names = cur.includes(node.id) ? cur : [node.id];
    if (!cur.includes(node.id)) {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id })));
      onSelect([node.id]);
    }
    const one = names.length === 1;
    const items: MenuItem[] = [
      { label: tr('Tabelle öffnen', 'Open Table'), icon: <Eye size={14} />, disabled: !one, onClick: () => onOpen(node.id) },
      { label: tr('Tabelle entwerfen', 'Design Table'), icon: <Wrench size={14} />, disabled: !one, onClick: () => O.designTable(connectionId, database, node.id) },
      SEP,
      { label: tr('Verbundene Tabellen auswählen', 'Select Connected Tables'), icon: <Link2 size={14} />, disabled: !one, onClick: () => selectConnected(node.id) },
      { label: tr('Auswahl automatisch anordnen', 'Auto Arrange Selection'), icon: <LayoutDashboard size={14} />, disabled: names.length < 2, onClick: () => autoLayout(true) },
      { label: tr('Farbe', 'Color'), icon: <span className="ks-color-dot" style={{ background: stRef.current.colors[node.id] ?? 'var(--c-table)' }} />, submenu: colorMenuItems(stRef.current.colors[node.id] ?? null, (c) => setColor(names, c)) },
      SEP,
      { label: tr('Als PNG speichern …', 'Save as PNG …'), icon: <Image size={14} />, onClick: () => void exportImage('png', names) },
      { label: tr('Name kopieren', 'Copy Name'), onClick: () => O.copyNames(names) },
      SEP,
      { label: tr('Tabelle löschen …', 'Delete Table …'), icon: <Trash2 size={14} />, danger: true, onClick: () => void O.dropObjects(connectionId, database, names.map((n) => ({ type: 'table' as const, name: n }))).then(load) }
    ];
    showContextMenu(e, items);
  };

  const edgeMenu = (e: React.MouseEvent, edgeId: string) => {
    setSelEdges(new Set([edgeId]));
    const spec = specs.find((s) => s.id === edgeId);
    if (!spec) return;
    showContextMenu(e, [
      { label: tr('Fremdschlüssel entwerfen', 'Design Foreign Key'), icon: <Wrench size={14} />, onClick: () => O.designTable(connectionId, database, spec.source) },
      { label: tr('Gehe zu „{t}“', 'Go to "{t}"', { t: spec.target }), onClick: () => focusTable(spec.target) },
      { label: tr('Gehe zu „{t}“', 'Go to "{t}"', { t: spec.source }), hidden: spec.source === spec.target, onClick: () => focusTable(spec.source) },
      SEP,
      { label: tr('Fremdschlüssel löschen …', 'Delete Foreign Key …'), icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, onClick: () => void dropForeignKey(edgeId) }
    ]);
  };

  const focusTable = (name: string) => {
    const n = rf.getNode(name);
    if (!n) return;
    setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === name })));
    onSelect([name]);
    void rf.fitView({ nodes: [{ id: name }], maxZoom: Math.max(zoom, 1), duration: 250, padding: 0.4 });
  };

  const paneMenu = (e: React.MouseEvent | MouseEvent) => {
    showContextMenu(e, [
      { label: tr('Neue Tabelle', 'New Table'), icon: <Columns3 size={14} />, onClick: () => O.designTable(connectionId, database, null) },
      SEP,
      { label: tr('Automatisch anordnen', 'Auto Arrange'), icon: <LayoutDashboard size={14} />, onClick: () => autoLayout(false) },
      { label: tr('Alles anzeigen', 'Fit to View'), icon: <Maximize size={14} />, onClick: () => void rf.fitView({ padding: 0.1, duration: 200 }) },
      { label: tr('Alle Tabellen auswählen', 'Select All Tables'), shortcut: 'Ctrl+A', onClick: () => selectAll() },
      SEP,
      { label: tr('Als PNG exportieren …', 'Export as PNG …'), icon: <Image size={14} />, onClick: () => void exportImage('png') },
      { label: tr('Als SVG exportieren …', 'Export as SVG …'), icon: <FileImage size={14} />, onClick: () => void exportImage('svg') },
      { label: tr('Drucken …', 'Print …'), icon: <Printer size={14} />, onClick: () => void print() },
      SEP,
      { label: tr('Aktualisieren', 'Refresh'), icon: <RefreshCw size={14} />, shortcut: 'F5', onClick: () => void load() }
    ]);
  };

  const selectAll = () => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
    onSelect(nodes.map((n) => n.id));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const combo = keyCombo(e);
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (combo) {
      case 'Ctrl+=':
      case 'Ctrl++':
      case 'Ctrl+Shift++':
        stop();
        void rf.zoomIn({ duration: 150 });
        return;
      case 'Ctrl+-':
        stop();
        void rf.zoomOut({ duration: 150 });
        return;
      case 'Ctrl+0':
        stop();
        void rf.zoomTo(1, { duration: 150 });
        return;
      case 'F5':
        stop();
        void load();
        return;
      case 'Ctrl+A':
        stop();
        selectAll();
        return;
      case 'Escape':
        if (tool !== 'select') {
          stop();
          setTool('select');
        }
        return;
      case 'R':
        stop();
        setTool((t) => (t === 'relation' ? 'select' : 'relation'));
        return;
      case 'Delete':
        if (selEdges.size === 1) {
          stop();
          void dropForeignKey([...selEdges][0]);
        } else if (selected.length) {
          stop();
          void O.dropObjects(connectionId, database, selected.map((n) => ({ type: 'table' as const, name: n }))).then(load);
        }
        return;
      case 'Enter':
        if (selected.length === 1) {
          stop();
          onOpen(selected[0]);
        }
        return;
    }
  };

  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => undefined);
  };

  const exportMenu = (el: HTMLElement) =>
    showMenuBelow(el, [
      { label: tr('Als PNG exportieren …', 'Export as PNG …'), icon: <Image size={14} />, onClick: () => void exportImage('png') },
      { label: tr('Als SVG exportieren …', 'Export as SVG …'), icon: <FileImage size={14} />, onClick: () => void exportImage('svg') },
      { label: tr('Drucken …', 'Print …'), icon: <Printer size={14} />, onClick: () => void print() },
      SEP,
      { label: tr('Datenwörterbuch erstellen …', 'Create Data Dictionary …'), icon: <BookOpen size={14} />, onClick: () => void openDictionaryDialog({ kind: 'database', connectionId, database }) },
      { label: tr('In Modell übernehmen', 'Reverse to Model'), icon: <Network size={14} />, onClick: () => openModelTab(null, { connectionId, database }) }
    ]);

  return (
    <div
      className="ks-er"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (!t.closest('input, textarea, select, button, [tabindex]:not(.ks-er)')) rootRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className="ks-dg">
        <ReactFlow<TableFlowNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={savePositions}
          onNodeDoubleClick={(_, n) => onOpen(n.id)}
          onNodeContextMenu={nodeMenu}
          onEdgeClick={(_, ed) => setSelEdges(new Set([ed.id]))}
          onEdgeContextMenu={(e, ed) => edgeMenu(e, ed.id)}
          onEdgeMouseEnter={(_, ed) => setHoverEdge(ed.id)}
          onEdgeMouseLeave={() => setHoverEdge(null)}
          onPaneClick={() => {
            setSelEdges(new Set());
            if (selectedRef.current.length) onSelect([]);
          }}
          onPaneContextMenu={paneMenu}
          onMoveEnd={(_, vp) => update({ viewport: vp })}
          onConnect={(c) => void onConnect(c)}
          connectionMode={ConnectionMode.Loose}
          nodesConnectable={tool === 'relation'}
          nodesDraggable={tool === 'select'}
          colorMode={theme}
          minZoom={0.05}
          maxZoom={3}
          deleteKeyCode={null}
          selectionKeyCode="Shift"
          multiSelectionKeyCode="Control"
          zoomOnDoubleClick={false}
          onlyRenderVisibleElements={nodes.length > 150}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          {st.minimap && <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => (n.data as { color?: string | null }).color ?? 'var(--xy-minimap-node-background-color)'} />}
        </ReactFlow>
        {tool === 'relation' && (
          <div className="ks-dg-hint">
            {tr('Feld der Detailtabelle auf das referenzierte Feld ziehen · Esc beendet', 'Drag a child table field onto the referenced field · Esc to finish')}
          </div>
        )}
        {(loading || busy) && (
          <div className="ks-er-overlay">
            <Spinner size={22} />
          </div>
        )}
        {error && !loading && (
          <div className="ks-er-overlay">
            <div className="col" style={{ alignItems: 'center' }}>
              <span className="danger-text">{error}</span>
              <button type="button" className="ks-btn" onClick={() => void load()}>
                {tr('Erneut versuchen', 'Retry')}
              </button>
            </div>
          </div>
        )}
        {!loading && !error && schema && !schema.tables.length && <div className="ks-dg-hint">{tr('Die Datenbank enthält keine Tabellen.', 'The database contains no tables.')}</div>}
      </div>
      <div className="ks-er-bar">
        <IconButton icon={<RefreshCw size={15} />} title={`${tr('Aktualisieren', 'Refresh')} (F5)`} onClick={() => void load()} />
        <IconButton icon={<LayoutDashboard size={15} />} title={tr('Automatisch anordnen (alle bzw. Auswahl)', 'Auto arrange (all or selection)')} onClick={() => autoLayout(selected.length > 1)} />
        <span className="ks-er-sep" />
        <IconButton icon={<MousePointer2 size={15} />} title={`${tr('Auswählen', 'Select')} (Esc)`} active={tool === 'select'} onClick={() => setTool('select')} />
        <IconButton icon={<Link2 size={15} />} title={`${tr('Beziehung hinzufügen', 'Add relation')} (R)`} active={tool === 'relation'} onClick={() => setTool((t) => (t === 'relation' ? 'select' : 'relation'))} />
        <span className="ks-er-sep" />
        <IconButton icon={<Type size={15} />} title={tr('Datentypen anzeigen', 'Show data types')} active={st.showTypes} onClick={() => update({ showTypes: !st.showTypes })} />
        <IconButton icon={<KeyRound size={15} />} title={tr('Nur Schlüsselfelder', 'Key fields only')} active={st.keysOnly} onClick={() => update({ keysOnly: !st.keysOnly })} />
        <IconButton icon={<Tag size={15} />} title={tr('Namen der Beziehungen', 'Relation names')} active={st.labels} onClick={() => update({ labels: !st.labels })} />
        <IconButton icon={<MapIcon size={15} />} title={tr('Übersicht', 'Overview')} active={st.minimap} onClick={() => update({ minimap: !st.minimap })} />
        <Select<Notation>
          value={st.notation}
          title={tr('Notation', 'Notation')}
          onChange={(notation) => update({ notation })}
          options={[
            { value: 'crowsfoot', label: tr('Krähenfuß', "Crow's foot") },
            { value: 'arrow', label: tr('Einfache Pfeile', 'Simple arrows') }
          ]}
        />
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12, marginRight: 8 }}>
          {schema ? tr('{t} Tabellen · {r} Beziehungen', '{t} tables · {r} relations', { t: schema.tables.length, r: specs.length }) : ''}
        </span>
        <IconButton icon={<ZoomOut size={15} />} title={`${tr('Verkleinern', 'Zoom out')} (Ctrl+-)`} onClick={() => void rf.zoomOut({ duration: 150 })} />
        <button type="button" className="ks-zoom-label" title={`${tr('Originalgröße', 'Actual size')} (Ctrl+0)`} onClick={() => void rf.zoomTo(1, { duration: 150 })}>
          {Math.round(zoom * 100)} %
        </button>
        <IconButton icon={<ZoomIn size={15} />} title={`${tr('Vergrößern', 'Zoom in')} (Ctrl+=)`} onClick={() => void rf.zoomIn({ duration: 150 })} />
        <IconButton icon={<Maximize size={15} />} title={tr('Alles anzeigen', 'Fit to view')} onClick={() => void rf.fitView({ padding: 0.1, duration: 200 })} />
        <span className="ks-er-sep" />
        <IconButton icon={<Image size={15} />} title={tr('Exportieren', 'Export')} onClick={(e) => exportMenu(e.currentTarget)} />
        <IconButton icon={<Fullscreen size={15} />} title={tr('Vollbild', 'Full screen')} onClick={toggleFullscreen} />
      </div>
    </div>
  );
}

// Model designer: .ksmodel documents with tables, views, relations, notes, labels, shapes and layers
// on a canvas; reverse / forward engineering, synchronization, image export and data dictionary.

import '@xyflow/react/dist/style.css';
import './model.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams
} from '@xyflow/react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  BookOpen,
  Copy,
  DatabaseZap,
  Eye,
  FileCode,
  FileImage,
  FilePlus,
  FolderOpen,
  GitCompare,
  Glasses,
  Image,
  Layers,
  LayoutDashboard,
  Link2,
  Maximize,
  MousePointer2,
  Network,
  Pencil,
  Printer,
  Redo2,
  Save,
  Shapes,
  StickyNote,
  Table2,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import { tr } from '@shared/i18n';
import { newField, newId, newTableDesign } from '@shared/defaults';
import { newModelDoc, isModelEmpty, type ModelDoc, type ModelTable, type ShapeKind } from '@shared/model/types';
import { ensureFkIndexes, brokenIncomingFks, fkIsOptional, fkIsUnique, incomingFks, propagateTableChange, relationKey, typeLabel, uniqueTableName } from '@shared/model/util';
import type { FileEntry } from '@shared/api';
import { formatDateTime, uniqueName } from '@shared/util';
import { api } from '../../api/client';
import { toast } from '../../components/Toast';
import { Button, IconButton, SearchInput, Spinner, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { askDialog, confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { SEP, showContextMenu, showMenuBelow, type MenuItem } from '../../components/ui/Menu';
import { baseName } from '../../lib/files';
import { keyCombo } from '../../lib/shortcuts';
import { useResolvedTheme } from '../../lib/theme';
import { setCloseGuard, useTabs, type TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { colorMenuItems } from './colors';
import { openDictionaryDialog } from './DictionaryDialog';
import { listModelFiles, modelTabKey, modelTitle, openModelTab, pickModelFile, pickModelSavePath, readModel, writeModel } from './files';
import { PropertiesPanel, type Selection } from './PropertiesPanel';
import { openReverseDialog, reverseInto } from './ReverseDialog';
import { openScriptDialog } from './ScriptDialog';
import { openSyncDialog } from './SyncDialog';
import { openTableEditor } from './TableEditorDialog';
import { openViewEditor } from './ViewEditorDialog';
import { useModelDoc } from './useModelDoc';
import { CanvasContext, LabelNode, LayerNode, NoteNode, ShapeNode, type AnnotationData } from './diagram/AnnotationNodes';
import { buildEdges, type RelationSpec } from './diagram/edges';
import { printImage, renderDiagram, saveImage, withLightTheme, type ImageFormat } from './diagram/image';
import { layoutGraph } from './diagram/layout';
import { RelationEdge } from './diagram/RelationEdge';
import { TableNode } from './diagram/TableNode';
import { handleColumn, nodeRect, type ColumnView, type TableNodeData } from './diagram/types';

type Tool = 'select' | 'relation' | 'table' | 'view' | 'note' | 'label' | 'shape' | 'layer';
type FlowNode = Node<TableNodeData, 'table'> | Node<AnnotationData, 'note' | 'label' | 'shape' | 'layer'>;

const nodeTypes = { table: TableNode, note: NoteNode, label: LabelNode, shape: ShapeNode, layer: LayerNode };
const edgeTypes = { relation: RelationEdge };
const lc = (s: string) => s.toLowerCase();
const EDGE_SEP = '/';

interface Params {
  file: string | null;
  reverse?: { connectionId: string; database: string };
}

export default function ModelTab(props: TabProps) {
  return (
    <ReactFlowProvider>
      <ModelDesigner {...props} />
    </ReactFlowProvider>
  );
}

function tableColumns(doc: ModelDoc, t: ModelTable): { cols: ColumnView[]; hidden: number } {
  const d = t.design;
  const pk = new Set(d.primaryKey.map(lc));
  const fk = new Set(d.foreignKeys.flatMap((f) => f.fields.map(lc)));
  const indexed = new Set(d.indexes.flatMap((i) => i.fields.map((p) => lc(p.name))));
  const unique = new Set(d.indexes.filter((i) => i.type === 'UNIQUE' && i.fields.length === 1).map((i) => lc(i.fields[0].name)));
  const referenced = new Set(incomingFks(doc, d.name).flatMap((r) => r.fk.refFields.map(lc)));
  const all = d.fields.map<ColumnView>((f) => ({
    name: f.name,
    type: typeLabel(f),
    pk: pk.has(lc(f.name)),
    fk: fk.has(lc(f.name)),
    unique: unique.has(lc(f.name)),
    indexed: indexed.has(lc(f.name)) || pk.has(lc(f.name)),
    nullable: !f.notNull,
    ai: f.autoIncrement,
    generated: f.generated,
    comment: f.comment
  }));
  const cols = doc.display.keysOnly ? all.filter((c) => c.pk || c.fk || referenced.has(lc(c.name))) : all;
  return { cols, hidden: all.length - cols.length };
}

function ModelDesigner({ tab, active }: TabProps) {
  const params = tab.params as unknown as Params;
  const theme = useResolvedTheme();
  const rf = useReactFlow<FlowNode>();
  const { zoom } = useViewport();
  const profilesDir = useWorkspace((s) => s.profilesDir);
  const m = useModelDoc(newModelDoc(tr('Neues Modell', 'New Model')));
  const { doc, change } = m;
  const [file, setFile] = useState<string | null>(params.file);
  const [loading, setLoading] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [shapeKind, setShapeKind] = useState<ShapeKind>('rect');
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [sel, setSel] = useState<Selection>({ kind: 'none' });
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [recent, setRecent] = useState<FileEntry[]>([]);
  const [lastSync, setLastSync] = useState<{ connectionId: string; database: string } | null>(params.reverse ?? null);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ dirty: m.dirty, file, doc });
  stateRef.current = { dirty: m.dirty, file, doc };

  // ───────────── file handling ─────────────

  useEffect(() => {
    let alive = true;
    const init = async () => {
      if (params.file) {
        setLoading(tr('Modell wird geladen …', 'Loading model …'));
        try {
          const d = await readModel(params.file);
          if (alive) m.reset(d);
        } catch (e) {
          void errorDialog(e);
        }
      } else if (params.reverse) {
        const r = params.reverse;
        setLoading(tr('Datenbank wird eingelesen …', 'Reading database …'));
        try {
          if (!(await useWorkspace.getState().openConnection(r.connectionId))) return;
          const sid = useWorkspace.getState().conns[r.connectionId]!.sessionId!;
          const [tables, views] = await Promise.all([api.meta.tables(sid, r.database), api.meta.views(sid, r.database)]);
          const d = await reverseInto(newModelDoc(r.database), {
            ...r,
            tables: tables.filter((t) => t.type === 'BASE TABLE').map((t) => t.name),
            views: views.map((v) => v.name)
          });
          if (alive) {
            m.reset(d, true);
            window.setTimeout(() => void rf.fitView({ padding: 0.08, maxZoom: 1 }), 80);
          }
        } catch (e) {
          void errorDialog(e);
        }
      }
      if (alive) setLoading(null);
    };
    void init();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!file && isModelEmpty(doc)) void listModelFiles().then(setRecent).catch(() => setRecent([]));
  }, [file, doc, profilesDir]);

  useEffect(() => {
    useTabs.getState().update(tab.id, { title: modelTitle(file, doc.name), dirty: m.dirty, subtitle: file ?? undefined, key: file ? modelTabKey(file) : undefined });
  }, [tab.id, file, doc.name, m.dirty]);

  const saveTo = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const d = { ...stateRef.current.doc, viewport: rf.getViewport(), updatedAt: Date.now() };
        await writeModel(path, d);
        m.markSaved();
        setFile(path);
        toast(tr('Modell gespeichert', 'Model saved'), 'success');
        return true;
      } catch (e) {
        void errorDialog(e);
        return false;
      }
    },
    [m, rf]
  );

  const saveAs = useCallback(async (): Promise<boolean> => {
    const p = await pickModelSavePath(stateRef.current.doc.name, stateRef.current.file);
    if (!p) return false;
    const other = useTabs.getState().tabs.find((t) => t.key === modelTabKey(p) && t.id !== tab.id);
    if (other) {
      toast(tr('Diese Datei ist bereits in einem anderen Tab geöffnet.', 'This file is already open in another tab.'), 'error');
      return false;
    }
    return saveTo(p);
  }, [saveTo, tab.id]);

  const save = useCallback(async (): Promise<boolean> => (stateRef.current.file ? saveTo(stateRef.current.file) : saveAs()), [saveTo, saveAs]);

  useEffect(() => {
    setCloseGuard(tab.id, async () => {
      if (!stateRef.current.dirty) return true;
      const a = await askDialog({
        title: tr('Modell schließen', 'Close model'),
        message: tr('Die Änderungen am Modell „{n}“ wurden nicht gespeichert. Jetzt speichern?', 'The changes to model "{n}" have not been saved. Save now?', { n: stateRef.current.doc.name }),
        yesLabel: tr('Speichern', 'Save'),
        noLabel: tr('Verwerfen', 'Discard')
      });
      if (a === 'cancel') return false;
      if (a === 'no') return true;
      return save();
    });
    return () => setCloseGuard(tab.id, null);
  }, [tab.id, save]);

  const openFile = async (path?: string) => {
    const p = path ?? (await pickModelFile());
    if (!p) return;
    if (!file && isModelEmpty(doc) && !m.dirty) {
      const other = useTabs.getState().tabs.find((t) => t.key === modelTabKey(p));
      if (other) {
        useTabs.getState().activate(other.id);
        return;
      }
      setLoading(tr('Modell wird geladen …', 'Loading model …'));
      try {
        m.reset(await readModel(p));
        setFile(p);
        window.setTimeout(() => {
          const vp = stateRef.current.doc.viewport;
          if (vp) void rf.setViewport(vp);
          else void rf.fitView({ padding: 0.08, maxZoom: 1 });
        }, 80);
      } catch (e) {
        void errorDialog(e);
      } finally {
        setLoading(null);
      }
    } else openModelTab(p);
  };

  // ───────────── nodes & edges ─────────────

  const tableByName = useMemo(() => new Map(doc.tables.map((t) => [lc(t.design.name), t])), [doc.tables]);

  useEffect(() => {
    const hl = hoverEdge ?? selEdge;
    const [hlTable, hlFk] = hl ? hl.split(EDGE_SEP) : [null, null];
    const hlDef = hlTable ? doc.tables.find((t) => t.id === hlTable)?.design.foreignKeys.find((f) => f.id === hlFk) : undefined;
    const hlParent = hlDef ? tableByName.get(lc(hlDef.refTable))?.id : undefined;
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      const keep = (id: string, w?: number, h?: number) => {
        const o = old.get(id);
        return {
          selected: o?.selected ?? false,
          measured: o?.measured && (w === undefined || (o.measured.width === w && o.measured.height === h)) ? o.measured : undefined,
          dragging: false
        };
      };
      const out: FlowNode[] = [];
      for (const l of doc.layers) {
        out.push({ id: l.id, type: 'layer', position: { x: l.x, y: l.y }, width: l.width, height: l.height, zIndex: -1, ...keep(l.id, l.width, l.height), data: { text: l.name, color: l.color } });
      }
      for (const t of doc.tables) {
        const { cols, hidden } = tableColumns(doc, t);
        let highlight: string[] | null = null;
        if (hlDef && t.id === hlTable) highlight = hlDef.fields.map(lc);
        if (hlDef && t.id === hlParent) highlight = [...(highlight ?? []), ...hlDef.refFields.map(lc)];
        const o = old.get(t.id);
        const sameShape = o && o.type === 'table' && o.data.columns.length === cols.length && o.data.showTypes === doc.display.showTypes && o.data.showComments === doc.display.showComments;
        out.push({
          id: t.id,
          type: 'table',
          position: { x: t.x, y: t.y },
          selected: o?.selected ?? false,
          measured: sameShape ? o.measured : undefined,
          data: {
            kind: 'table',
            name: t.design.name,
            comment: t.design.comment,
            color: t.color,
            columns: cols,
            hidden,
            showTypes: doc.display.showTypes,
            showComments: doc.display.showComments,
            connectable: tool === 'relation',
            highlight
          }
        });
      }
      for (const v of doc.views) {
        const lines = v.definition
          .replace(/\s+/g, ' ')
          .replace(/\s+(from|where|join|left join|inner join|group by|order by|having|union)\s+/gi, '\n$1 ')
          .split('\n')
          .slice(0, 6)
          .map((s) => (s.length > 56 ? `${s.slice(0, 55)}…` : s));
        out.push({
          id: v.id,
          type: 'table',
          position: { x: v.x, y: v.y },
          ...keep(v.id),
          measured: old.get(v.id)?.measured,
          data: { kind: 'view', name: v.name, comment: v.comment, color: v.color, columns: [], lines, showTypes: false, showComments: doc.display.showComments, connectable: false }
        });
      }
      for (const n of doc.notes) out.push({ id: n.id, type: 'note', position: { x: n.x, y: n.y }, width: n.width, height: n.height, ...keep(n.id, n.width, n.height), data: { text: n.text, color: n.color } });
      for (const s of doc.shapes)
        out.push({ id: s.id, type: 'shape', position: { x: s.x, y: s.y }, width: s.width, height: s.height, ...keep(s.id, s.width, s.height), data: { text: s.text, color: s.color, shape: s.kind } });
      for (const l of doc.labels)
        out.push({
          id: l.id,
          type: 'label',
          position: { x: l.x, y: l.y },
          ...keep(l.id),
          measured: undefined,
          data: { text: l.text, color: l.color, fontSize: l.fontSize, bold: l.bold, italic: l.italic }
        });
      return out;
    });
  }, [doc, tool, hoverEdge, selEdge, tableByName]);

  const specs = useMemo<RelationSpec[]>(() => {
    const out: RelationSpec[] = [];
    for (const t of doc.tables) {
      const childCols = new Set(tableColumns(doc, t).cols.map((c) => lc(c.name)));
      for (const fk of t.design.foreignKeys) {
        if (fk.refSchema) continue;
        const parent = tableByName.get(lc(fk.refTable));
        if (!parent) continue;
        const parentCols = parent === t ? childCols : new Set(tableColumns(doc, parent).cols.map((c) => lc(c.name)));
        out.push({
          id: `${t.id}${EDGE_SEP}${fk.id}`,
          source: t.id,
          target: parent.id,
          sourceColumn: fk.fields[0] && childCols.has(lc(fk.fields[0])) ? fk.fields[0] : null,
          targetColumn: fk.refFields[0] && parentCols.has(lc(fk.refFields[0])) ? fk.refFields[0] : null,
          many: !fkIsUnique(t.design, fk),
          optional: fkIsOptional(t.design, fk),
          color: doc.relationColors[relationKey(t.id, fk.id)] ?? null,
          label: fk.name
        });
      }
    }
    return out;
  }, [doc, tableByName]);

  const edges = useMemo(
    () => buildEdges(specs, nodes, { notation: doc.display.notation, showLabels: doc.display.showRelationNames, highlightId: hoverEdge, selectedIds: selEdge ? new Set([selEdge]) : undefined }),
    [specs, nodes, doc.display.notation, doc.display.showRelationNames, hoverEdge, selEdge]
  );

  // initial viewport of loaded documents
  const viewportDone = useRef(false);
  useEffect(() => {
    if (viewportDone.current || loading || !nodes.length || nodes.some((n) => n.type === 'table' && !n.measured)) return;
    viewportDone.current = true;
    if (doc.viewport) void rf.setViewport(doc.viewport);
    else void rf.fitView({ padding: 0.08, maxZoom: 1 });
  }, [nodes, loading, doc.viewport, rf]);

  // ───────────── document operations ─────────────

  const commitPositions = useCallback(() => {
    const pos = new Map(rf.getNodes().map((n) => [n.id, n.position]));
    change((d) => {
      let changed = false;
      const mv = <T extends { id: string; x: number; y: number }>(list: T[]): T[] =>
        list.map((o) => {
          const p = pos.get(o.id);
          if (!p || (Math.round(p.x) === Math.round(o.x) && Math.round(p.y) === Math.round(o.y))) return o;
          changed = true;
          return { ...o, x: Math.round(p.x), y: Math.round(p.y) };
        });
      const next = { ...d, tables: mv(d.tables), views: mv(d.views), notes: mv(d.notes), labels: mv(d.labels), shapes: mv(d.shapes), layers: mv(d.layers) };
      return changed ? next : d;
    });
  }, [change, rf]);

  const canvasActions = useMemo(
    () => ({
      editingId,
      stopEditing: () => setEditingId(null),
      commitBox: (id: string, b: { x: number; y: number; width: number; height: number }) =>
        change((d) => {
          const box = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
          const set = <T extends { id: string }>(list: T[]) => list.map((o) => (o.id === id ? { ...o, ...box } : o));
          return { ...d, notes: set(d.notes), shapes: set(d.shapes), layers: set(d.layers) };
        }),
      commitText: (id: string, text: string) =>
        change((d) => ({
          ...d,
          notes: d.notes.map((o) => (o.id === id ? { ...o, text } : o)),
          labels: d.labels.map((o) => (o.id === id ? { ...o, text } : o)),
          shapes: d.shapes.map((o) => (o.id === id ? { ...o, text } : o)),
          layers: d.layers.map((o) => (o.id === id ? { ...o, name: text } : o))
        }))
    }),
    [change, editingId]
  );

  const selectOnly = (ids: string[]) => {
    const s = new Set(ids);
    setSelEdge(null);
    setNodes((ns) => ns.map((n) => (!!n.selected !== s.has(n.id) ? { ...n, selected: s.has(n.id) } : n)));
    setSel(ids.length === 0 ? { kind: 'none' } : ids.length === 1 ? { kind: 'object', id: ids[0] } : { kind: 'many', ids });
  };

  const editTable = async (id: string | null, page?: 'fields' | 'fks', at?: { x: number; y: number }) => {
    const cur = stateRef.current.doc;
    const t = id ? cur.tables.find((x) => x.id === id) : undefined;
    let design = t?.design;
    if (!design) {
      design = newTableDesign('');
      design.name = uniqueTableName(cur, 'table');
    }
    const res = await openTableEditor(cur, design, t?.id ?? null, page);
    if (!res) return;
    if (t) {
      const broken = brokenIncomingFks(stateRef.current.doc, t.id, t.design, res);
      if (broken.length) {
        const ok = await confirmDialog({
          title: tr('Beziehungen entfernen', 'Remove relations'),
          message: tr('Folgende Fremdschlüssel verweisen auf entfernte Felder und werden gelöscht:\n\n{l}', 'The following foreign keys reference removed fields and will be deleted:\n\n{l}', {
            l: broken.map((b) => `• ${b.table}.${b.fk}`).join('\n')
          }),
          danger: true
        });
        if (!ok) return;
      }
      change((d) => ({ ...d, tables: propagateTableChange(d, t.id, t.design, res) }));
    } else {
      const nt: ModelTable = { id: newId('mt'), design: res, x: at?.x ?? 0, y: at?.y ?? 0, color: null };
      change((d) => ({ ...d, tables: [...d.tables, nt] }));
      window.setTimeout(() => selectOnly([nt.id]), 30);
    }
  };

  const editView = async (id: string | null, at?: { x: number; y: number }) => {
    const cur = stateRef.current.doc;
    const v = id
      ? cur.views.find((x) => x.id === id)
      : { id: newId('mv'), name: uniqueTableName(cur, 'view'), definition: 'SELECT\n  \nFROM ', algorithm: '' as const, security: '' as const, checkOption: '' as const, comment: '', x: at?.x ?? 0, y: at?.y ?? 0, color: null };
    if (!v) return;
    const res = await openViewEditor(cur, v);
    if (!res) return;
    change((d) => ({ ...d, views: id ? d.views.map((x) => (x.id === id ? res : x)) : [...d.views, res] }));
  };

  const editObject = (id: string) => {
    const d = stateRef.current.doc;
    if (d.tables.some((t) => t.id === id)) void editTable(id);
    else if (d.views.some((v) => v.id === id)) void editView(id);
    else setEditingId(id);
  };

  const deleteObjects = async (ids: string[], edgeId: string | null) => {
    const d = stateRef.current.doc;
    const set = new Set(ids);
    const tables = d.tables.filter((t) => set.has(t.id));
    if (edgeId && !ids.length) {
      const [tid, fid] = edgeId.split(EDGE_SEP);
      change((x) => ({ ...x, tables: x.tables.map((t) => (t.id === tid ? { ...t, design: { ...t.design, foreignKeys: t.design.foreignKeys.filter((f) => f.id !== fid) } } : t)) }));
      setSelEdge(null);
      return;
    }
    if (!ids.length) return;
    if (tables.length || d.views.some((v) => set.has(v.id))) {
      const names = [...tables.map((t) => t.design.name), ...d.views.filter((v) => set.has(v.id)).map((v) => v.name)];
      const ok = await confirmDialog({
        title: tr('Aus Modell löschen', 'Delete from model'),
        message: tr('Folgende Objekte und ihre Beziehungen aus dem Modell löschen?\n\n{l}', 'Delete the following objects and their relations from the model?\n\n{l}', {
          l: names.slice(0, 15).map((n) => `• ${n}`).join('\n') + (names.length > 15 ? '\n…' : '')
        }),
        okLabel: tr('Löschen', 'Delete'),
        danger: true
      });
      if (!ok) return;
    }
    const removed = new Set(tables.map((t) => lc(t.design.name)));
    change((x) => ({
      ...x,
      tables: x.tables.filter((t) => !set.has(t.id)).map((t) => {
        const fks = t.design.foreignKeys.filter((f) => f.refSchema || !removed.has(lc(f.refTable)));
        return fks.length === t.design.foreignKeys.length ? t : { ...t, design: { ...t.design, foreignKeys: fks } };
      }),
      views: x.views.filter((o) => !set.has(o.id)),
      notes: x.notes.filter((o) => !set.has(o.id)),
      labels: x.labels.filter((o) => !set.has(o.id)),
      shapes: x.shapes.filter((o) => !set.has(o.id)),
      layers: x.layers.filter((o) => !set.has(o.id))
    }));
    setSel({ kind: 'none' });
  };

  const duplicate = (ids: string[]) => {
    const d = stateRef.current.doc;
    const set = new Set(ids);
    const newIds: string[] = [];
    change((x) => {
      let cur = x;
      for (const t of x.tables.filter((o) => set.has(o.id))) {
        const design = structuredClone(t.design);
        design.name = uniqueTableName(cur, t.design.name);
        delete design.origName;
        design.foreignKeys = design.foreignKeys.map((f) => ({ ...f, id: newId('r'), origName: undefined, name: uniqueName(`${f.name}_copy`, cur.tables.flatMap((y) => y.design.foreignKeys.map((z) => z.name))) }));
        design.indexes = design.indexes.map((i) => ({ ...i, id: newId('i'), origName: undefined }));
        design.fields = design.fields.map((f) => ({ ...f, id: newId('f'), origName: undefined }));
        design.checks = design.checks.map((c) => ({ ...c, id: newId('k'), origName: undefined, name: `${c.name}_copy` }));
        design.triggers = [];
        const nt = { ...t, id: newId('mt'), design, x: t.x + 40, y: t.y + 40 };
        newIds.push(nt.id);
        cur = { ...cur, tables: [...cur.tables, nt] };
      }
      const copy = <K extends 'notes' | 'labels' | 'shapes' | 'layers'>(key: K) => {
        for (const o of (x[key] as { id: string; x: number; y: number }[]).filter((q) => set.has(q.id))) {
          const n = { ...o, id: newId('mo'), x: o.x + 30, y: o.y + 30 };
          newIds.push(n.id);
          cur = { ...cur, [key]: [...(cur[key] as unknown[]), n] };
        }
      };
      copy('notes');
      copy('labels');
      copy('shapes');
      copy('layers');
      return cur;
    });
    if (!d) return;
    window.setTimeout(() => selectOnly(newIds), 30);
  };

  const onConnect = (c: Connection) => {
    const d = stateRef.current.doc;
    const child = d.tables.find((t) => t.id === c.source);
    const parent = d.tables.find((t) => t.id === c.target);
    if (!child || !parent) return;
    let childCol = handleColumn(c.sourceHandle);
    const targetCol = handleColumn(c.targetHandle);
    const refCols = targetCol ? [targetCol] : parent.design.primaryKey;
    if (refCols.length !== 1) {
      toast(tr('Bitte auf ein Feld der referenzierten Tabelle ziehen (kein einspaltiger Primärschlüssel).', 'Please drop onto a field of the referenced table (no single-column primary key).'));
      return;
    }
    const refField = parent.design.fields.find((f) => lc(f.name) === lc(refCols[0]));
    if (!refField) return;
    let design = child.design;
    if (!childCol) {
      // header → header: create the foreign key column in the child table
      childCol = uniqueName(`${parent.design.name}_${refField.name}`, design.fields.map((f) => f.name));
      design = {
        ...design,
        fields: [
          ...design.fields,
          newField({ name: childCol, type: refField.type, length: refField.length, decimals: refField.decimals, unsigned: refField.unsigned, values: refField.values, notNull: true })
        ]
      };
    }
    if (design.foreignKeys.some((f) => !f.refSchema && lc(f.refTable) === lc(parent.design.name) && f.fields.length === 1 && lc(f.fields[0]) === lc(childCol!))) {
      toast(tr('Diese Beziehung existiert bereits.', 'This relation already exists.'));
      return;
    }
    const name = uniqueName(`fk_${child.design.name}_${parent.design.name}`.slice(0, 60), d.tables.flatMap((t) => t.design.foreignKeys.map((f) => f.name)));
    design = ensureFkIndexes({
      ...design,
      foreignKeys: [...design.foreignKeys, { id: newId('r'), name, fields: [childCol], refSchema: '', refTable: parent.design.name, refFields: [refField.name], onDelete: '', onUpdate: '' }]
    });
    change((x) => ({ ...x, tables: x.tables.map((t) => (t.id === child.id ? { ...t, design } : t)) }));
    toast(tr('Beziehung „{n}“ angelegt', 'Relation "{n}" created', { n: name }), 'success');
  };

  const place = (e: React.MouseEvent) => {
    if (tool === 'select' || tool === 'relation') return false;
    let p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (doc.display.snapToGrid) {
      const g = doc.display.gridSize;
      p = { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
    }
    const at = { x: Math.round(p.x), y: Math.round(p.y) };
    const t = tool;
    setTool('select');
    if (t === 'table') void editTable(null, undefined, at);
    else if (t === 'view') void editView(null, at);
    else {
      const id = newId('mo');
      change((d) => {
        if (t === 'note') return { ...d, notes: [...d.notes, { id, ...at, text: tr('Notiz', 'Note'), width: 200, height: 110, color: null }] };
        if (t === 'label') return { ...d, labels: [...d.labels, { id, ...at, text: tr('Beschriftung', 'Label'), fontSize: 18, bold: true, italic: false, color: null }] };
        if (t === 'shape') return { ...d, shapes: [...d.shapes, { id, ...at, kind: shapeKind, text: '', width: 140, height: 90, color: null }] };
        return { ...d, layers: [...d.layers, { id, ...at, name: tr('Ebene', 'Layer'), width: 480, height: 320, color: null }] };
      });
      window.setTimeout(() => {
        selectOnly([id]);
        if (t !== 'layer' && t !== 'shape') setEditingId(id);
      }, 30);
    }
    return true;
  };

  // layer drag moves the contained objects
  const dragGroup = useRef<{ layer: string; start: { x: number; y: number }; members: Map<string, { x: number; y: number }> } | null>(null);
  const onNodeDragStart = (_: unknown, node: FlowNode) => {
    dragGroup.current = null;
    if (node.type !== 'layer') return;
    const r = nodeRect(node);
    const members = new Map<string, { x: number; y: number }>();
    for (const n of rf.getNodes()) {
      if (n.id === node.id || n.selected) continue;
      const b = nodeRect(n);
      if (b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height) members.set(n.id, { ...n.position });
    }
    dragGroup.current = { layer: node.id, start: { ...node.position }, members };
  };
  const onNodeDrag = (_: unknown, node: FlowNode) => {
    const g = dragGroup.current;
    if (!g || g.layer !== node.id || !g.members.size) return;
    const dx = node.position.x - g.start.x;
    const dy = node.position.y - g.start.y;
    setNodes((ns) => ns.map((n) => (g.members.has(n.id) ? { ...n, position: { x: g.members.get(n.id)!.x + dx, y: g.members.get(n.id)!.y + dy } } : n)));
  };

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  const onSelectionChange = useCallback(({ nodes: sn, edges: se }: OnSelectionChangeParams) => {
    if (sn.length === 0 && se.length === 1) return;
    const ids = sn.map((n) => n.id);
    setSel((cur) => {
      if (ids.length === 0) return cur.kind === 'relation' ? cur : { kind: 'none' };
      return ids.length === 1 ? { kind: 'object', id: ids[0] } : { kind: 'many', ids };
    });
  }, []);

  // ───────────── arrangement ─────────────

  const selectedNodes = () => rf.getNodes().filter((n) => n.selected);

  const align = (mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'hdist' | 'vdist') => {
    const list = selectedNodes().map((n) => ({ n, r: nodeRect(n) }));
    if (list.length < 2) return;
    const pos = new Map<string, { x: number; y: number }>();
    const minX = Math.min(...list.map((i) => i.r.x));
    const maxR = Math.max(...list.map((i) => i.r.x + i.r.width));
    const minY = Math.min(...list.map((i) => i.r.y));
    const maxB = Math.max(...list.map((i) => i.r.y + i.r.height));
    if (mode === 'hdist' || mode === 'vdist') {
      if (list.length < 3) return;
      const h = mode === 'hdist';
      const sorted = [...list].sort((a, b) => (h ? a.r.x - b.r.x : a.r.y - b.r.y));
      const total = sorted.reduce((s, i) => s + (h ? i.r.width : i.r.height), 0);
      const gap = ((h ? maxR - minX : maxB - minY) - total) / (sorted.length - 1);
      let cur = h ? minX : minY;
      for (const i of sorted) {
        pos.set(i.n.id, h ? { x: cur, y: i.r.y } : { x: i.r.x, y: cur });
        cur += (h ? i.r.width : i.r.height) + gap;
      }
    } else {
      for (const { n, r } of list) {
        const p = { x: r.x, y: r.y };
        if (mode === 'left') p.x = minX;
        if (mode === 'right') p.x = maxR - r.width;
        if (mode === 'center') p.x = (minX + maxR) / 2 - r.width / 2;
        if (mode === 'top') p.y = minY;
        if (mode === 'bottom') p.y = maxB - r.height;
        if (mode === 'middle') p.y = (minY + maxB) / 2 - r.height / 2;
        pos.set(n.id, p);
      }
    }
    setNodes((ns) => ns.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n)));
    window.setTimeout(commitPositions, 0);
  };

  const autoLayout = (onlySelected: boolean) => {
    const all = rf.getNodes().filter((n) => n.type === 'table');
    const target = onlySelected ? all.filter((n) => n.selected) : all;
    if (!target.length) return;
    const ids = new Set(target.map((n) => n.id));
    const d = stateRef.current.doc;
    const origin = onlySelected ? { x: Math.min(...target.map((n) => n.position.x)), y: Math.min(...target.map((n) => n.position.y)) } : { x: 0, y: 0 };
    const links = d.tables.flatMap((t) =>
      t.design.foreignKeys.filter((f) => !f.refSchema).map((f) => ({ from: t.id, to: tableByName.get(lc(f.refTable))?.id ?? '' }))
    ).filter((l) => ids.has(l.from) && ids.has(l.to));
    const positions = layoutGraph(target.map((n) => ({ id: n.id, ...nodeRect(n) })), links, { origin });
    setNodes((ns) => ns.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n)));
    window.setTimeout(() => {
      commitPositions();
      if (!onlySelected) void rf.fitView({ padding: 0.08, maxZoom: 1, duration: 200 });
    }, 0);
  };

  // ───────────── export ─────────────

  const exportImage = async (format: ImageFormat, onlyIds?: string[]) => {
    const el = canvasRef.current;
    if (!el) return;
    setLoading(tr('Bild wird erstellt …', 'Rendering image …'));
    try {
      const list = onlyIds ? rf.getNodes().filter((n) => onlyIds.includes(n.id)) : rf.getNodes();
      const url = await renderDiagram(el, list, format, { only: !!onlyIds });
      const out = await saveImage(url, `${doc.name || 'model'}.${format}`, format);
      if (out) toast(tr('Bild gespeichert: {f}', 'Image saved: {f}', { f: out }), 'success');
    } catch (e) {
      void errorDialog(e);
    } finally {
      setLoading(null);
    }
  };

  const print = async () => {
    const el = canvasRef.current;
    if (!el) return;
    setLoading(tr('Druckansicht wird erstellt …', 'Preparing print …'));
    try {
      const url = await withLightTheme(() => renderDiagram(el, rf.getNodes(), 'png'));
      printImage(url, doc.name);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setLoading(null);
    }
  };

  const reverse = async () => {
    const r = await openReverseDialog(lastSync ?? undefined);
    if (!r) return;
    setLoading(tr('Datenbank wird eingelesen …', 'Reading database …'));
    try {
      const next = await reverseInto(stateRef.current.doc, r);
      change(() => next);
      setLastSync({ connectionId: r.connectionId, database: r.database });
      window.setTimeout(() => void rf.fitView({ padding: 0.08, maxZoom: 1, duration: 200 }), 100);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setLoading(null);
    }
  };

  const sync = () =>
    void openSyncDialog(doc, lastSync ?? (doc.schema ? { connectionId: '', database: doc.schema } : null), (views, target) => {
      setLastSync(target);
      if (views.length) {
        const byId = new Map(views.map((v) => [v.id, v]));
        change((d) => ({ ...d, views: d.views.map((v) => (byId.has(v.id) ? { ...v, syncedAs: { source: byId.get(v.id)!.source, server: byId.get(v.id)!.server } } : v)) }));
      }
    });

  const setDisplay = (patch: Partial<ModelDoc['display']>) => change((d) => ({ ...d, display: { ...d.display, ...patch } }));

  // ───────────── menus & keyboard ─────────────

  const fileMenu = (el: HTMLElement) =>
    showMenuBelow(el, [
      { label: tr('Neues Modell', 'New Model'), icon: <FilePlus size={14} />, onClick: () => openModelTab(null) },
      { label: tr('Öffnen …', 'Open …'), icon: <FolderOpen size={14} />, onClick: () => void openFile() },
      SEP,
      { label: tr('Speichern', 'Save'), icon: <Save size={14} />, shortcut: 'Ctrl+S', onClick: () => void save() },
      { label: tr('Speichern unter …', 'Save As …'), shortcut: 'Ctrl+Shift+S', onClick: () => void saveAs() },
      { label: tr('Im Explorer anzeigen', 'Show in Explorer'), disabled: !file, onClick: () => file && void api.app.showItemInFolder(file) }
    ]);

  const viewMenu = (el: HTMLElement) => {
    const ds = doc.display;
    showMenuBelow(el, [
      { type: 'header', label: tr('Notation', 'Notation') },
      { label: tr('Krähenfuß', "Crow's foot"), checked: ds.notation === 'crowsfoot', onClick: () => setDisplay({ notation: 'crowsfoot' }) },
      { label: tr('Einfache Pfeile', 'Simple arrows'), checked: ds.notation === 'arrow', onClick: () => setDisplay({ notation: 'arrow' }) },
      SEP,
      { label: tr('Datentypen', 'Data types'), checked: ds.showTypes, onClick: () => setDisplay({ showTypes: !ds.showTypes }) },
      { label: tr('Kommentare', 'Comments'), checked: ds.showComments, onClick: () => setDisplay({ showComments: !ds.showComments }) },
      { label: tr('Nur Schlüsselfelder', 'Key fields only'), checked: ds.keysOnly, onClick: () => setDisplay({ keysOnly: !ds.keysOnly }) },
      { label: tr('Namen der Beziehungen', 'Relation names'), checked: ds.showRelationNames, onClick: () => setDisplay({ showRelationNames: !ds.showRelationNames }) },
      SEP,
      { label: tr('Raster anzeigen', 'Show grid'), checked: ds.showGrid, onClick: () => setDisplay({ showGrid: !ds.showGrid }) },
      { label: tr('Am Raster ausrichten', 'Snap to grid'), checked: ds.snapToGrid, onClick: () => setDisplay({ snapToGrid: !ds.snapToGrid }) },
      { label: tr('Übersicht', 'Overview'), checked: ds.showMinimap, onClick: () => setDisplay({ showMinimap: !ds.showMinimap }) }
    ]);
  };

  const alignItems = (): MenuItem[] => [
    { label: tr('Links ausrichten', 'Align Left'), icon: <AlignStartVertical size={14} />, onClick: () => align('left') },
    { label: tr('Horizontal zentrieren', 'Align Center'), icon: <AlignCenterVertical size={14} />, onClick: () => align('center') },
    { label: tr('Rechts ausrichten', 'Align Right'), icon: <AlignEndVertical size={14} />, onClick: () => align('right') },
    SEP,
    { label: tr('Oben ausrichten', 'Align Top'), icon: <AlignStartHorizontal size={14} />, onClick: () => align('top') },
    { label: tr('Vertikal zentrieren', 'Align Middle'), icon: <AlignCenterHorizontal size={14} />, onClick: () => align('middle') },
    { label: tr('Unten ausrichten', 'Align Bottom'), icon: <AlignEndHorizontal size={14} />, onClick: () => align('bottom') },
    SEP,
    { label: tr('Horizontal verteilen', 'Distribute Horizontally'), icon: <AlignHorizontalDistributeCenter size={14} />, onClick: () => align('hdist') },
    { label: tr('Vertikal verteilen', 'Distribute Vertically'), icon: <AlignVerticalDistributeCenter size={14} />, onClick: () => align('vdist') }
  ];

  const exportItems = (): MenuItem[] => [
    { label: tr('Als PNG exportieren …', 'Export as PNG …'), icon: <Image size={14} />, onClick: () => void exportImage('png') },
    { label: tr('Als SVG exportieren …', 'Export as SVG …'), icon: <FileImage size={14} />, onClick: () => void exportImage('svg') },
    { label: tr('Drucken …', 'Print …'), icon: <Printer size={14} />, onClick: () => void print() },
    SEP,
    { label: tr('Datenwörterbuch erstellen …', 'Create Data Dictionary …'), icon: <BookOpen size={14} />, onClick: () => void openDictionaryDialog({ kind: 'model', doc, file }) }
  ];

  const nodeMenu = (e: React.MouseEvent, node: FlowNode) => {
    const selectedIds = selectedNodes().map((n) => n.id);
    const ids = selectedIds.includes(node.id) ? selectedIds : [node.id];
    if (!selectedIds.includes(node.id)) selectOnly([node.id]);
    const d = stateRef.current.doc;
    const table = d.tables.find((t) => t.id === node.id);
    const colorOf = (id: string) => [...d.tables, ...d.views, ...d.notes, ...d.labels, ...d.shapes, ...d.layers].find((o) => o.id === id)?.color ?? null;
    const applyColor = (color: string | null) =>
      change((x) => {
        const s = new Set(ids);
        const set = <T extends { id: string; color: string | null }>(l: T[]) => l.map((o) => (s.has(o.id) ? { ...o, color } : o));
        return { ...x, tables: set(x.tables), views: set(x.views), notes: set(x.notes), labels: set(x.labels), shapes: set(x.shapes), layers: set(x.layers) };
      });
    const connected = () => {
      if (!table) return;
      const out = new Set([table.id]);
      for (const s of specs) {
        if (s.source === table.id) out.add(s.target);
        if (s.target === table.id) out.add(s.source);
      }
      selectOnly([...out]);
    };
    showContextMenu(e, [
      { label: table ? tr('Tabelle bearbeiten …', 'Edit Table …') : node.type === 'table' ? tr('Ansicht bearbeiten …', 'Edit View …') : tr('Text bearbeiten', 'Edit Text'), icon: <Pencil size={14} />, disabled: ids.length > 1, onClick: () => editObject(node.id) },
      { label: tr('Fremdschlüssel …', 'Foreign Keys …'), icon: <Link2 size={14} />, hidden: !table, onClick: () => void editTable(node.id, 'fks') },
      { label: tr('Verbundene Tabellen auswählen', 'Select Connected Tables'), hidden: !table, onClick: connected },
      SEP,
      { label: tr('Duplizieren', 'Duplicate'), icon: <Copy size={14} />, shortcut: 'Ctrl+D', hidden: d.views.some((v) => ids.includes(v.id)), onClick: () => duplicate(ids) },
      { label: tr('Farbe', 'Color'), submenu: colorMenuItems(colorOf(node.id), applyColor) },
      { label: tr('Ausrichten', 'Align'), disabled: ids.length < 2, submenu: alignItems() },
      { label: tr('Auswahl automatisch anordnen', 'Auto Arrange Selection'), icon: <LayoutDashboard size={14} />, disabled: ids.length < 2, onClick: () => autoLayout(true) },
      SEP,
      { label: tr('Als PNG speichern …', 'Save as PNG …'), icon: <Image size={14} />, onClick: () => void exportImage('png', ids) },
      SEP,
      { label: tr('Aus Modell löschen', 'Delete from Model'), icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, onClick: () => void deleteObjects(ids, null) }
    ]);
  };

  const edgeMenu = (e: React.MouseEvent, edgeId: string) => {
    setSelEdge(edgeId);
    const [tid, fid] = edgeId.split(EDGE_SEP);
    setSel({ kind: 'relation', tableId: tid, fkId: fid });
    const spec = specs.find((s) => s.id === edgeId);
    const d = stateRef.current.doc;
    const key = relationKey(tid, fid);
    showContextMenu(e, [
      { label: tr('Fremdschlüssel bearbeiten …', 'Edit Foreign Key …'), icon: <Pencil size={14} />, onClick: () => void editTable(tid, 'fks') },
      { label: tr('Zur referenzierten Tabelle', 'Go to Referenced Table'), onClick: () => spec && focusNode(spec.target) },
      { label: tr('Zur Detailtabelle', 'Go to Child Table'), onClick: () => spec && focusNode(spec.source) },
      {
        label: tr('Linienfarbe', 'Line Color'),
        submenu: colorMenuItems(d.relationColors[key] ?? null, (c) =>
          change((x) => {
            const relationColors = { ...x.relationColors };
            if (c) relationColors[key] = c;
            else delete relationColors[key];
            return { ...x, relationColors };
          })
        )
      },
      SEP,
      { label: tr('Beziehung löschen', 'Delete Relation'), icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, onClick: () => void deleteObjects([], edgeId) }
    ]);
  };

  const focusNode = (id: string) => {
    selectOnly([id]);
    void rf.fitView({ nodes: [{ id }], padding: 0.5, maxZoom: Math.max(1, zoom), duration: 250 });
  };

  const paneMenu = (e: React.MouseEvent | MouseEvent) => {
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const at = { x: Math.round(p.x), y: Math.round(p.y) };
    showContextMenu(e, [
      { label: tr('Neue Tabelle …', 'New Table …'), icon: <Table2 size={14} />, onClick: () => void editTable(null, undefined, at) },
      { label: tr('Neue Ansicht …', 'New View …'), icon: <Glasses size={14} />, onClick: () => void editView(null, at) },
      SEP,
      { label: tr('Einfügen aus Datenbank …', 'Import from Database …'), icon: <DatabaseZap size={14} />, onClick: () => void reverse() },
      { label: tr('Automatisch anordnen', 'Auto Arrange'), icon: <LayoutDashboard size={14} />, onClick: () => autoLayout(false) },
      { label: tr('Alles auswählen', 'Select All'), shortcut: 'Ctrl+A', onClick: () => selectOnly(rf.getNodes().map((n) => n.id)) },
      SEP,
      ...exportItems()
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const combo = keyCombo(e);
    const inField = !!(e.target as HTMLElement).closest('input, textarea, select, .monaco-editor');
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (combo === 'Ctrl+S') {
      stop();
      void save();
      return;
    }
    if (combo === 'Ctrl+Shift+S') {
      stop();
      void saveAs();
      return;
    }
    if (inField) return;
    const ids = selectedNodes().map((n) => n.id);
    switch (combo) {
      case 'Ctrl+Z':
        stop();
        m.undo();
        return;
      case 'Ctrl+Y':
      case 'Ctrl+Shift+Z':
        stop();
        m.redo();
        return;
      case 'Delete':
        stop();
        void deleteObjects(ids, selEdge);
        return;
      case 'Ctrl+A':
        stop();
        selectOnly(rf.getNodes().map((n) => n.id));
        return;
      case 'Ctrl+D':
        stop();
        if (ids.length) duplicate(ids);
        return;
      case 'F2':
      case 'Enter':
        if (ids.length === 1) {
          stop();
          editObject(ids[0]);
        }
        return;
      case 'Escape':
        stop();
        if (tool !== 'select') setTool('select');
        else selectOnly([]);
        return;
      case 'R':
        stop();
        setTool((t) => (t === 'relation' ? 'select' : 'relation'));
        return;
      case 'T':
        stop();
        setTool('table');
        return;
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
    }
  };

  // ───────────── render ─────────────

  const toolBtn = (t: Tool, icon: ReactNode, label: string, key?: string) => (
    <ToolbarButton icon={icon} title={key ? `${label} (${key})` : label} active={tool === t} onClick={() => setTool((cur) => (cur === t ? 'select' : t))} />
  );

  const q = search.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const selectedIdSet = new Set(sel.kind === 'object' ? [sel.id] : sel.kind === 'many' ? sel.ids : []);
  const listItem = (id: string, icon: ReactNode, name: string, color: string | null) => (
    <div
      key={id}
      className={`ks-md-item ${selectedIdSet.has(id) ? 'selected' : ''}`}
      onClick={() => focusNode(id)}
      onDoubleClick={() => editObject(id)}
      onContextMenu={(e) => {
        const n = rf.getNode(id);
        if (n) nodeMenu(e, n);
      }}
      title={name}
    >
      {icon}
      <span className="ellipsis">{name || ' '}</span>
      {color && <span className="ks-md-dot" style={{ background: color }} />}
    </div>
  );
  const annotations = [
    ...doc.layers.map((o) => ({ id: o.id, name: o.name, icon: <Layers size={13} />, color: o.color })),
    ...doc.notes.map((o) => ({ id: o.id, name: o.text.split('\n')[0], icon: <StickyNote size={13} />, color: o.color })),
    ...doc.labels.map((o) => ({ id: o.id, name: o.text, icon: <Type size={13} />, color: o.color })),
    ...doc.shapes.map((o) => ({ id: o.id, name: o.text.split('\n')[0] || tr('Form', 'Shape'), icon: <Shapes size={13} />, color: o.color }))
  ].filter((a) => match(a.name));
  const relCount = specs.length;
  const placing = tool !== 'select' && tool !== 'relation';
  const empty = isModelEmpty(doc);

  return (
    <div
      className="ks-md"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (!t.closest('input, textarea, select, button, .monaco-editor, [tabindex]:not(.ks-md)')) rootRef.current?.focus({ preventScroll: true });
      }}
    >
      <Toolbar>
        <ToolbarButton icon={<FolderOpen size={15} />} label={tr('Datei', 'File')} dropdown onClick={(e) => fileMenu(e.currentTarget)} />
        <ToolbarButton icon={<Save size={15} />} title={`${tr('Speichern', 'Save')} (Ctrl+S)`} onClick={() => void save()} />
        <ToolbarSep />
        <ToolbarButton icon={<Undo2 size={15} />} title={`${tr('Rückgängig', 'Undo')} (Ctrl+Z)`} disabled={!m.canUndo} onClick={m.undo} />
        <ToolbarButton icon={<Redo2 size={15} />} title={`${tr('Wiederholen', 'Redo')} (Ctrl+Y)`} disabled={!m.canRedo} onClick={m.redo} />
        <ToolbarSep />
        {toolBtn('select', <MousePointer2 size={15} />, tr('Auswählen', 'Select'), 'Esc')}
        {toolBtn('table', <Table2 size={15} />, tr('Tabelle hinzufügen', 'Add table'), 'T')}
        {toolBtn('view', <Glasses size={15} />, tr('Ansicht hinzufügen', 'Add view'))}
        {toolBtn('relation', <Link2 size={15} />, tr('Beziehung zeichnen', 'Draw relation'), 'R')}
        {toolBtn('note', <StickyNote size={15} />, tr('Notiz hinzufügen', 'Add note'))}
        {toolBtn('label', <Type size={15} />, tr('Beschriftung hinzufügen', 'Add label'))}
        <ToolbarButton
          icon={<Shapes size={15} />}
          title={tr('Form hinzufügen', 'Add shape')}
          active={tool === 'shape'}
          onClick={() => setTool((cur) => (cur === 'shape' ? 'select' : 'shape'))}
          onDropdown={(e) =>
            showMenuBelow(e.currentTarget, [
              { label: tr('Rechteck', 'Rectangle'), checked: shapeKind === 'rect', onClick: () => (setShapeKind('rect'), setTool('shape')) },
              { label: tr('Abgerundetes Rechteck', 'Rounded rectangle'), checked: shapeKind === 'rounded', onClick: () => (setShapeKind('rounded'), setTool('shape')) },
              { label: tr('Ellipse', 'Ellipse'), checked: shapeKind === 'ellipse', onClick: () => (setShapeKind('ellipse'), setTool('shape')) },
              { label: tr('Raute', 'Diamond'), checked: shapeKind === 'diamond', onClick: () => (setShapeKind('diamond'), setTool('shape')) }
            ])
          }
        />
        {toolBtn('layer', <Layers size={15} />, tr('Ebene hinzufügen', 'Add layer'))}
        <ToolbarSep />
        <ToolbarButton icon={<Trash2 size={15} />} title={`${tr('Löschen', 'Delete')} (Del)`} disabled={sel.kind === 'none' && !selEdge} onClick={() => void deleteObjects(selectedNodes().map((n) => n.id), selEdge)} />
        <ToolbarButton icon={<AlignStartVertical size={15} />} title={tr('Ausrichten', 'Align')} dropdown disabled={sel.kind !== 'many'} onClick={(e) => showMenuBelow(e.currentTarget, alignItems())} />
        <ToolbarButton icon={<LayoutDashboard size={15} />} label={tr('Anordnen', 'Arrange')} onClick={() => autoLayout(sel.kind === 'many')} />
        <ToolbarButton icon={<Eye size={15} />} label={tr('Ansicht', 'View')} dropdown onClick={(e) => viewMenu(e.currentTarget)} />
        <ToolbarSep />
        <ToolbarButton icon={<DatabaseZap size={15} />} label={tr('Aus Datenbank', 'From Database')} onClick={() => void reverse()} />
        <ToolbarButton icon={<FileCode size={15} />} label={tr('SQL-Skript', 'SQL Script')} disabled={empty} onClick={() => void openScriptDialog(doc)} />
        <ToolbarButton icon={<GitCompare size={15} />} label={tr('Synchronisieren', 'Synchronize')} disabled={!doc.tables.length && !doc.views.length} onClick={sync} />
        <ToolbarButton icon={<Image size={15} />} label={tr('Export', 'Export')} dropdown disabled={empty} onClick={(e) => showMenuBelow(e.currentTarget, exportItems())} />
      </Toolbar>
      <div className="ks-md-body">
        <div className="ks-md-side">
          <div className="ks-md-panel-head">{tr('Objekte', 'Objects')}</div>
          <SearchInput value={search} onChange={setSearch} className="ks-md-search" />
          <div className="ks-md-panel-body">
            <div className="ks-md-group">
              {tr('Tabellen', 'Tables')} <span className="spacer" />
              {doc.tables.length}
            </div>
            {doc.tables.filter((t) => match(t.design.name)).map((t) => listItem(t.id, <Table2 size={13} style={{ color: 'var(--c-table)' }} />, t.design.name, t.color))}
            <div className="ks-md-group">
              {tr('Ansichten', 'Views')} <span className="spacer" />
              {doc.views.length}
            </div>
            {doc.views.filter((v) => match(v.name)).map((v) => listItem(v.id, <Glasses size={13} style={{ color: 'var(--c-view)' }} />, v.name, v.color))}
            {annotations.length > 0 && <div className="ks-md-group">{tr('Anmerkungen', 'Annotations')}</div>}
            {annotations.map((a) => listItem(a.id, a.icon, a.name, a.color))}
          </div>
        </div>
        <div className={`ks-md-canvas ${placing ? 'placing' : ''}`} ref={canvasRef}>
          <CanvasContext.Provider value={canvasActions}>
            <div className="ks-dg">
              <ReactFlow<FlowNode>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onSelectionChange={onSelectionChange}
                onNodeDragStart={onNodeDragStart}
                onNodeDrag={onNodeDrag}
                onNodeDragStop={() => {
                  dragGroup.current = null;
                  commitPositions();
                }}
                onSelectionDragStop={commitPositions}
                onNodeClick={(e, n) => {
                  if (placing && n.type === 'layer') place(e);
                  setSelEdge(null);
                }}
                onNodeDoubleClick={(_, n) => editObject(n.id)}
                onNodeContextMenu={nodeMenu}
                onEdgeClick={(_, ed) => {
                  const [tid, fid] = ed.id.split(EDGE_SEP);
                  selectOnly([]);
                  setSel({ kind: 'relation', tableId: tid, fkId: fid });
                  setSelEdge(ed.id);
                }}
                onEdgeDoubleClick={(_, ed) => void editTable(ed.id.split(EDGE_SEP)[0], 'fks')}
                onEdgeContextMenu={(e, ed) => edgeMenu(e, ed.id)}
                onEdgeMouseEnter={(_, ed) => setHoverEdge(ed.id)}
                onEdgeMouseLeave={() => setHoverEdge(null)}
                onPaneClick={(e) => {
                  if (place(e)) return;
                  setSelEdge(null);
                  setSel({ kind: 'none' });
                  setEditingId(null);
                }}
                onPaneContextMenu={paneMenu}
                onConnect={onConnect}
                connectionMode={ConnectionMode.Loose}
                nodesConnectable={tool === 'relation'}
                nodesDraggable={tool === 'select'}
                snapToGrid={doc.display.snapToGrid}
                snapGrid={[doc.display.gridSize, doc.display.gridSize]}
                colorMode={theme}
                minZoom={0.05}
                maxZoom={3}
                deleteKeyCode={null}
                selectionKeyCode="Shift"
                multiSelectionKeyCode="Control"
                zoomOnDoubleClick={false}
                proOptions={{ hideAttribution: true }}
              >
                {doc.display.showGrid && <Background variant={BackgroundVariant.Lines} gap={doc.display.gridSize} lineWidth={0.4} />}
                {doc.display.showMinimap && <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => ((n.data as { color?: string | null }).color ?? 'var(--xy-minimap-node-background-color)')} />}
                <Panel position="bottom-left">
                  <div className="ks-md-zoom">
                    <IconButton icon={<ZoomOut size={14} />} title={`${tr('Verkleinern', 'Zoom out')} (Ctrl+-)`} onClick={() => void rf.zoomOut({ duration: 150 })} />
                    <button type="button" className="ks-zoom-label" title={`${tr('Originalgröße', 'Actual size')} (Ctrl+0)`} onClick={() => void rf.zoomTo(1, { duration: 150 })}>
                      {Math.round(zoom * 100)} %
                    </button>
                    <IconButton icon={<ZoomIn size={14} />} title={`${tr('Vergrößern', 'Zoom in')} (Ctrl+=)`} onClick={() => void rf.zoomIn({ duration: 150 })} />
                    <IconButton icon={<Maximize size={14} />} title={tr('Alles anzeigen', 'Fit to view')} onClick={() => void rf.fitView({ padding: 0.08, duration: 200 })} />
                  </div>
                </Panel>
              </ReactFlow>
            </div>
          </CanvasContext.Provider>
          {tool === 'relation' && (
            <div className="ks-dg-hint">
              {tr('Feld der Detailtabelle auf das referenzierte Feld ziehen (Kopf auf Kopf legt das Feld an) · Esc beendet', 'Drag a child field onto the referenced field (header onto header creates the field) · Esc to finish')}
            </div>
          )}
          {placing && <div className="ks-dg-hint">{tr('Klicken Sie auf die Zeichenfläche, um das Objekt zu platzieren · Esc bricht ab', 'Click on the canvas to place the object · Esc to cancel')}</div>}
          {empty && !loading && !file && tool === 'select' && (
            <div className="ks-md-start">
              <h3>{tr('Neues Datenmodell', 'New Data Model')}</h3>
              <p>
                {tr(
                  'Entwerfen Sie Tabellen und Beziehungen unabhängig von einer Datenbank oder übernehmen Sie die Struktur einer bestehenden Datenbank.',
                  'Design tables and relations independently of a database or import the structure of an existing database.'
                )}
              </p>
              <div className="ks-md-start-actions">
                <Button icon={<Table2 size={15} />} onClick={() => void editTable(null, undefined, { x: 0, y: 0 })}>
                  {tr('Tabelle anlegen', 'Create Table')}
                </Button>
                <Button icon={<DatabaseZap size={15} />} onClick={() => void reverse()}>
                  {tr('Aus Datenbank …', 'From Database …')}
                </Button>
                <Button icon={<FolderOpen size={15} />} onClick={() => void openFile()}>
                  {tr('Modell öffnen …', 'Open Model …')}
                </Button>
                <Button icon={<Network size={15} />} onClick={() => setTool('relation')} disabled={doc.tables.length < 1}>
                  {tr('Beziehung zeichnen', 'Draw Relation')}
                </Button>
              </div>
              {recent.length > 0 && (
                <div className="ks-md-recent">
                  <div className="ks-md-group" style={{ padding: '0 0 4px' }}>
                    {tr('Zuletzt bearbeitet', 'Recent models')}
                  </div>
                  {recent.slice(0, 8).map((r) => (
                    <div key={r.path} className="ks-md-recent-item" onDoubleClick={() => void openFile(r.path)} onClick={() => void openFile(r.path)} title={r.path}>
                      <Network size={14} style={{ color: 'var(--c-model)' }} />
                      <span className="ellipsis">{baseName(r.path).replace(/\.ksmodel$/i, '')}</span>
                      <span className="muted">{formatDateTime(r.mtime)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {loading && (
            <div className="ks-er-overlay">
              <div className="col" style={{ alignItems: 'center' }}>
                <Spinner size={22} />
                <span className="muted">{loading}</span>
              </div>
            </div>
          )}
        </div>
        <PropertiesPanel doc={doc} sel={sel} change={(fn) => change(fn, 'props')} editTable={(id, page) => void editTable(id, page)} editView={(id) => void editView(id)} />
      </div>
      <div className="ks-statusline">
        <span>{tr('{t} Tabellen · {v} Ansichten · {r} Beziehungen', '{t} tables · {v} views · {r} relations', { t: doc.tables.length, v: doc.views.length, r: relCount })}</span>
        <span className="ellipsis">{file ?? tr('Nicht gespeichert', 'Not saved')}</span>
        <div className="spacer" />
        {m.dirty && <span>{tr('Geändert', 'Modified')}</span>}
        <span>{doc.target.type === 'mariadb' ? 'MariaDB' : 'MySQL'} {doc.target.version}</span>
      </div>
    </div>
  );
}

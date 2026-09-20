// Visual query builder dialog: table list, diagram canvas (joins), field grid, options and live SQL preview.

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Group, Panel, Separator } from 'react-resizable-panels';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Copy, Eraser, Plus, TriangleAlert, Workflow, X } from 'lucide-react';
import type { CompletionTable } from '@shared/api';
import { tr } from '@shared/i18n';
import { quoteString } from '@shared/sql/quote';
import { api, RpcError } from '../../api/client';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { ObjIcon } from '../../components/icons';
import { toast } from '../../components/Toast';
import { alertDialog, confirmDialog, Dialog, errorDialog, promptDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, EmptyState, IconButton, SearchInput, Select, Spinner, TabStrip, TextArea, TextInput } from '../../components/ui/controls';
import { SEP, showMenuBelow } from '../../components/ui/Menu';
import { useResolvedTheme } from '../../lib/theme';
import { metaSession, useWorkspace } from '../../store/workspace';
import type { QueryBuilderOptions } from './index';
import {
  addJoin,
  addTable,
  AGGREGATES,
  emptyState,
  generateSql,
  isColumnSelected,
  JOIN_OPERATORS,
  JOIN_TYPES,
  moveField,
  newField,
  removeTables,
  setAggregate,
  setAlias,
  tableLabel,
  toggleColumn,
  updateField,
  type Aggregate,
  type QbColumn,
  type QbForeignKey,
  type QbState,
  type QbTable
} from './model';
import { analyzeSelect, buildState, type TableMeta } from './parse';
import './queryBuilder.css';

interface DbMeta {
  tables: (CompletionTable & { pk: Set<string> })[];
  fks: QbForeignKey[];
}

async function loadDbMeta(connectionId: string, db: string): Promise<DbMeta> {
  const sid = metaSession(connectionId);
  const [tables, keyRes] = await Promise.all([
    api.meta.completion(sid, db),
    api.query.execute(
      sid,
      `SELECT TABLE_NAME, COLUMN_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ${quoteString(db)}
          AND (CONSTRAINT_NAME = 'PRIMARY' OR (REFERENCED_TABLE_NAME IS NOT NULL AND REFERENCED_TABLE_SCHEMA = TABLE_SCHEMA))
        ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      { history: false, noSplit: true }
    )
  ]);
  const err = keyRes.results.find((r) => r.kind === 'error');
  if (err?.error) throw new RpcError(err.error);
  const pk = new Map<string, Set<string>>();
  const fkMap = new Map<string, QbForeignKey>();
  for (const row of keyRes.results[0]?.rows ?? []) {
    const [t, c, cn, rt, rc] = row.map((v) => (typeof v === 'string' ? v : v === null ? null : new TextDecoder().decode(v)));
    if (!t || !c || !cn) continue;
    if (cn === 'PRIMARY') {
      if (!pk.has(t)) pk.set(t, new Set());
      pk.get(t)!.add(c);
    } else if (rt && rc) {
      const key = `${t}|${cn}`;
      let fk = fkMap.get(key);
      if (!fk) {
        fk = { name: cn, table: t, columns: [], refTable: rt, refColumns: [] };
        fkMap.set(key, fk);
      }
      fk.columns.push(c);
      fk.refColumns.push(rc);
    }
  }
  return { tables: tables.map((t) => ({ ...t, pk: pk.get(t.name) ?? new Set<string>() })), fks: [...fkMap.values()] };
}

const columnsOf = (t: DbMeta['tables'][number]): QbColumn[] => t.columns.map((c) => ({ name: c.name, type: c.type, pk: t.pk.has(c.name) }));

// ───────────────────────── context for canvas nodes / edges ─────────────────────────

interface Ctx {
  qb: QbState;
  update: (fn: (s: QbState) => QbState) => void;
  editAlias: (tableId: string) => void;
}

const QbContext = createContext<Ctx | null>(null);
const useQb = (): Ctx => useContext(QbContext)!;

type TableNodeT = Node<{ tableId: string }, 'qbTable'>;
type JoinEdgeT = Edge<{ joinId: string }, 'join'>;

const TableNode = memo(function TableNode({ data, selected }: NodeProps<TableNodeT>) {
  const { qb, update, editAlias } = useQb();
  const t = qb.tables.find((x) => x.id === data.tableId);
  if (!t) return null;
  return (
    <div className={clsx('ks-qb-node', selected && 'selected')}>
      <div className="ks-qb-node-head" onDoubleClick={() => editAlias(t.id)} title={tr('Doppelklick: Alias festlegen', 'Double click: set alias')}>
        <ObjIcon kind={t.kind} size={13} />
        <span className="ellipsis">{t.schema ? `${t.schema}.${t.name}` : t.name}</span>
        {t.alias && <span className="ks-qb-alias">{t.alias}</span>}
        <span className="spacer" />
        <button type="button" className="ks-qb-node-close nodrag" title={tr('Entfernen', 'Remove')} onClick={() => update((s) => removeTables(s, [t.id]))}>
          <X size={12} />
        </button>
      </div>
      <label className="ks-qb-col nodrag">
        <input type="checkbox" checked={isColumnSelected(qb, t.id, '*')} onChange={(e) => update((s) => toggleColumn(s, t.id, '*', e.target.checked))} />
        <span className="ks-qb-col-name">* {tr('(alle Felder)', '(all fields)')}</span>
      </label>
      {t.columns.map((c) => (
        <div key={c.name} className="ks-qb-col">
          <Handle type="source" position={Position.Left} id={`l:${c.name}`} className="ks-qb-handle" />
          <input className="nodrag" type="checkbox" checked={isColumnSelected(qb, t.id, c.name)} onChange={(e) => update((s) => toggleColumn(s, t.id, c.name, e.target.checked))} />
          {c.pk && <ObjIcon kind="key" size={11} />}
          <span className="ks-qb-col-name">{c.name}</span>
          <span className="ks-qb-col-type">{c.type}</span>
          <Handle type="source" position={Position.Right} id={`r:${c.name}`} className="ks-qb-handle" />
        </div>
      ))}
    </div>
  );
});

function JoinEdge(p: EdgeProps<JoinEdgeT>) {
  const { qb, update } = useQb();
  const j = qb.joins.find((x) => x.id === p.data?.joinId);
  const [path, lx, ly] = getBezierPath(p);
  if (!j) return null;
  const setJ = (patch: Partial<typeof j>) => update((s) => ({ ...s, joins: s.joins.map((x) => (x.id === j.id ? { ...x, ...patch } : x)) }));
  const left = qb.tables.find((t) => t.id === j.left.tableId);
  const right = qb.tables.find((t) => t.id === j.right.tableId);
  const menu = (el: HTMLElement) =>
    showMenuBelow(el, [
      { type: 'header', label: `${left ? tableLabel(left) : '?'}.${j.left.column} ${j.op} ${right ? tableLabel(right) : '?'}.${j.right.column}` },
      ...JOIN_TYPES.map((type) => ({
        label:
          type === 'INNER'
            ? tr('INNER JOIN – nur passende Zeilen', 'INNER JOIN – matching rows only')
            : type === 'LEFT'
              ? tr('LEFT JOIN – alle Zeilen aus {t}', 'LEFT JOIN – all rows of {t}', { t: left ? tableLabel(left) : '' })
              : type === 'RIGHT'
                ? tr('RIGHT JOIN – alle Zeilen aus {t}', 'RIGHT JOIN – all rows of {t}', { t: right ? tableLabel(right) : '' })
                : tr('CROSS JOIN – ohne Bedingung', 'CROSS JOIN – without condition'),
        checked: j.type === type,
        onClick: () => setJ({ type })
      })),
      SEP,
      { label: tr('Operator', 'Operator'), submenu: JOIN_OPERATORS.map((op) => ({ label: op, checked: j.op === op, onClick: () => setJ({ op }) })) },
      {
        label: tr('Seiten tauschen', 'Swap sides'),
        onClick: () =>
          setJ({
            left: j.right,
            right: j.left,
            type: j.type === 'LEFT' ? 'RIGHT' : j.type === 'RIGHT' ? 'LEFT' : j.type,
            op: ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=' } as Record<string, typeof j.op>)[j.op] ?? j.op
          })
      },
      SEP,
      { label: tr('Verknüpfung entfernen', 'Remove join'), danger: true, onClick: () => update((s) => ({ ...s, joins: s.joins.filter((x) => x.id !== j.id) })) }
    ]);
  return (
    <>
      <BaseEdge id={p.id} path={path} className={clsx('ks-qb-edge', j.type !== 'INNER' && 'outer')} interactionWidth={14} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={clsx('ks-qb-edge-label nodrag nopan', `t-${j.type.toLowerCase()}`)}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          title={tr('Klicken: Verknüpfungsart und Operator ändern', 'Click: change join type and operator')}
          onClick={(e) => menu(e.currentTarget)}
        >
          {j.type}
          {j.type !== 'CROSS' && j.op !== '=' ? ` ${j.op}` : ''}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { qbTable: TableNode } as unknown as NodeTypes;
const edgeTypes = { join: JoinEdge } as unknown as EdgeTypes;
const DRAG_MIME = 'application/x-ks-qb-table';

function Canvas({ onDropTable }: { onDropTable: (name: string, pos: { x: number; y: number }) => void }) {
  const { qb, update } = useQb();
  const rf = useReactFlow();
  const theme = useResolvedTheme();
  const [nodes, setNodes] = useState<TableNodeT[]>([]);

  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return qb.tables.map((t) => byId.get(t.id) ?? { id: t.id, type: 'qbTable' as const, position: { x: t.x, y: t.y }, data: { tableId: t.id }, dragHandle: '.ks-qb-node-head' });
    });
  }, [qb.tables]);

  const edges: JoinEdgeT[] = useMemo(() => {
    const pos = new Map(nodes.map((n) => [n.id, n.position.x]));
    return qb.joins.map((j) => {
      const leftFirst = (pos.get(j.left.tableId) ?? 0) <= (pos.get(j.right.tableId) ?? 0);
      return {
        id: j.id,
        type: 'join' as const,
        source: j.left.tableId,
        target: j.right.tableId,
        sourceHandle: `${leftFirst ? 'r' : 'l'}:${j.left.column}`,
        targetHandle: `${leftFirst ? 'l' : 'r'}:${j.right.column}`,
        data: { joinId: j.id }
      };
    });
  }, [qb.joins, nodes]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.sourceHandle || !c.targetHandle || c.source === c.target) return;
      update((s) => addJoin(s, { tableId: c.source, column: c.sourceHandle!.slice(2) }, { tableId: c.target, column: c.targetHandle!.slice(2) }));
    },
    [update]
  );

  return (
    <div
      className="ks-qb-canvas"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const name = e.dataTransfer.getData(DRAG_MIME);
        if (!name) return;
        e.preventDefault();
        onDropTable(name, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <ReactFlow<TableNodeT, JoinEdgeT>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={(changes: NodeChange<TableNodeT>[]) => setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), ns))}
        onNodesDelete={(del) => update((s) => removeTables(s, del.map((n) => n.id)))}
        onConnect={onConnect}
        isValidConnection={(c) => c.source !== c.target}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={28}
        deleteKeyCode={['Delete']}
        colorMode={theme}
        minZoom={0.2}
        maxZoom={2}
        fitView={qb.tables.length > 0}
        fitViewOptions={{ maxZoom: 1, padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!qb.tables.length && (
        <div className="ks-qb-canvas-empty">
          {tr('Tabellen per Doppelklick oder Ziehen aus der Liste hinzufügen.', 'Add tables by double click or by dragging them from the list.')}
          <br />
          {tr('Verknüpfungen: Spalte auf eine Spalte einer anderen Tabelle ziehen.', 'Joins: drag a column onto a column of another table.')}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── dialog ─────────────────────────

export function QueryBuilderDialog({ opts, close }: { opts: QueryBuilderOptions; close: (sql?: string | null) => void }) {
  const cid = opts.connectionId;
  const databases = useWorkspace((s) => s.conns[cid]?.databases ?? []);
  const [database, setDatabase] = useState(opts.database ?? '');
  const [meta, setMeta] = useState<DbMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [qb, setQb] = useState<QbState>(() => emptyState(opts.database ?? ''));
  const [search, setSearch] = useState('');
  const [bottom, setBottom] = useState<'fields' | 'options'>('fields');
  const cache = useRef(new Map<string, Promise<DbMeta>>());

  const getMeta = useCallback(
    (db: string) => {
      let p = cache.current.get(db);
      if (!p) {
        p = loadDbMeta(cid, db);
        p.catch(() => cache.current.delete(db));
        cache.current.set(db, p);
      }
      return p;
    },
    [cid]
  );

  // initial load: metadata + parse incoming SQL
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!(await useWorkspace.getState().openConnection(cid))) throw new Error(tr('Die Verbindung ist nicht geöffnet.', 'The connection is not open.'));
        const db = opts.database ?? '';
        const m = db ? await getMeta(db) : null;
        if (cancelled) return;
        setMeta(m);
        const sql = (opts.sql ?? '').trim();
        if (sql && db) {
          const a = analyzeSelect(sql);
          if (!a.ok) setNotice(a.reason);
          else {
            const metas = new Map<string, DbMeta>([[db.toLowerCase(), m!]]);
            for (const t of a.tables) {
              const tdb = t.db ?? db;
              if (!metas.has(tdb.toLowerCase())) metas.set(tdb.toLowerCase(), await getMeta(tdb).catch(() => ({ tables: [], fks: [] })));
            }
            const r = buildState(a.ast, db, (tdb, name): TableMeta | null => {
              const dm = metas.get((tdb ?? db).toLowerCase());
              const t = dm?.tables.find((x) => x.name.toLowerCase() === name.toLowerCase());
              return t ? { kind: t.type, columns: columnsOf(t) } : null;
            });
            if (cancelled) return;
            if ('error' in r) setNotice(r.error);
            else setQb(r.state);
          }
        } else if (sql) setNotice(tr('Wählen Sie eine Datenbank aus.', 'Choose a database.'));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeDatabase = async (db: string) => {
    if (db === database) return;
    if (qb.tables.length && !(await confirmDialog({ message: tr('Beim Wechsel der Datenbank wird die Abfrage geleert. Fortfahren?', 'Changing the database clears the query. Continue?') }))) return;
    setDatabase(db);
    setQb(emptyState(db));
    setNotice(null);
    setMeta(null);
    if (!db) return;
    setLoading(true);
    setError(null);
    try {
      setMeta(await getMeta(db));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const update = useCallback((fn: (s: QbState) => QbState) => setQb((s) => fn(s)), []);

  const editAlias = useCallback(
    async (tableId: string) => {
      const t = qb.tables.find((x) => x.id === tableId);
      if (!t) return;
      const v = await promptDialog({ title: tr('Alias', 'Alias'), label: tr('Alias für „{t}“ (leer = kein Alias):', 'Alias for "{t}" (empty = no alias):', { t: t.name }), value: t.alias });
      if (v === null) return;
      setQb((s) => {
        const r = setAlias(s, tableId, v);
        if ('error' in r) {
          void alertDialog({ kind: 'warning', message: tr('Der Name „{n}“ wird bereits verwendet.', 'The name "{n}" is already used.', { n: r.error }) });
          return s;
        }
        return r.state;
      });
    },
    [qb.tables]
  );

  const ctx = useMemo<Ctx>(() => ({ qb, update, editAlias: (id) => void editAlias(id) }), [qb, update, editAlias]);

  const addByName = (name: string, pos?: { x: number; y: number }) => {
    const t = meta?.tables.find((x) => x.name === name);
    if (!t || !meta) return;
    setQb((s) => {
      const n = s.tables.length;
      const p = pos ?? { x: 40 + (n % 4) * 280, y: 40 + Math.floor(n / 4) * 320 + (n % 2) * 30 };
      return addTable(s, { schema: null, name: t.name, kind: t.type, columns: columnsOf(t) }, p, meta.fks).state;
    });
  };

  const sql = useMemo(() => generateSql(qb), [qb]);
  const f = search.trim().toLowerCase();
  const list = (meta?.tables ?? []).filter((t) => !f || t.name.toLowerCase().includes(f));

  const submit = () => {
    if (!sql) {
      void alertDialog({ kind: 'warning', message: tr('Fügen Sie mindestens eine Tabelle hinzu.', 'Add at least one table.') });
      return;
    }
    close(sql);
  };

  return (
    <Dialog
      title={tr('Abfrage-Generator', 'Query Builder')}
      icon={<Workflow size={16} />}
      width={1240}
      height={780}
      resizable
      noPadding
      className="ks-qb-dialog"
      onClose={() => close(null)}
      footerLeft={
        <>
          <Button size="sm" icon={<Eraser size={13} />} disabled={!qb.tables.length && !qb.fields.length} onClick={() => setQb(emptyState(database))}>
            {tr('Leeren', 'Clear')}
          </Button>
          <span className="muted">{tr('{t} Tabelle(n), {j} Verknüpfung(en)', '{t} table(s), {j} join(s)', { t: qb.tables.length, j: qb.joins.length })}</span>
        </>
      }
      footer={
        <>
          <Button variant="primary" onClick={submit}>
            OK
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <QbContext.Provider value={ctx}>
        <div className="ks-qb">
          {notice && (
            <div className="ks-qb-notice">
              <TriangleAlert size={14} />
              <span className="selectable">
                {tr('Die vorhandene Abfrage konnte nicht übernommen werden – der Generator startet leer.', 'The existing query could not be loaded – the builder starts empty.')} {notice}
              </span>
              <span className="spacer" />
              <IconButton icon={<X size={13} />} onClick={() => setNotice(null)} title={tr('Schließen', 'Close')} />
            </div>
          )}
          <Group orientation="horizontal" className="ks-qb-group">
            <Panel id="qb-list" defaultSize="220px" minSize="150px" maxSize="40%" groupResizeBehavior="preserve-pixel-size" className="ks-qb-panel" style={{ overflow: 'hidden' }}>
              <div className="ks-qb-list">
                <Select
                  value={database}
                  onChange={(v) => void changeDatabase(v)}
                  title={tr('Datenbank', 'Database')}
                  options={[
                    { value: '', label: tr('(Datenbank wählen)', '(choose database)') },
                    ...(database && !databases.some((d) => d.name === database) ? [{ value: database, label: database }] : []),
                    ...databases.map((d) => ({ value: d.name, label: d.name }))
                  ]}
                />
                <SearchInput value={search} onChange={setSearch} />
                <div className="ks-qb-list-items">
                  {loading && <Spinner size={18} />}
                  {error && <div className="danger-text selectable">{error}</div>}
                  {!loading &&
                    list.map((t) => (
                      <div
                        key={t.name}
                        className="ks-qb-list-item"
                        draggable
                        title={tr('Doppelklick oder ziehen, um hinzuzufügen', 'Double click or drag to add')}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(DRAG_MIME, t.name);
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onDoubleClick={() => addByName(t.name)}
                      >
                        <ObjIcon kind={t.type} size={14} />
                        <span className="ellipsis">{t.name}</span>
                      </div>
                    ))}
                  {!loading && meta && !list.length && <div className="faint">{tr('Keine Treffer', 'No matches')}</div>}
                </div>
              </div>
            </Panel>
            <Separator className="ks-qb-sep-v" />
            <Panel id="qb-center" minSize="30%" className="ks-qb-panel" style={{ overflow: 'hidden' }}>
              <Group orientation="vertical" className="ks-qb-group">
                <Panel id="qb-canvas" defaultSize="58%" minSize="80px" className="ks-qb-panel" style={{ overflow: 'hidden' }}>
                  <ReactFlowProvider>
                    <Canvas onDropTable={addByName} />
                  </ReactFlowProvider>
                </Panel>
                <Separator className="ks-qb-sep-h" />
                <Panel id="qb-bottom" minSize="80px" className="ks-qb-panel" style={{ overflow: 'hidden' }}>
                  <TabStrip
                    value={bottom}
                    onChange={setBottom}
                    tabs={[
                      { id: 'fields', label: tr('Felder und Kriterien', 'Fields and Criteria'), badge: qb.fields.length || undefined },
                      { id: 'options', label: tr('Optionen', 'Options') }
                    ]}
                    right={
                      bottom === 'fields' && (
                        <Button size="sm" icon={<Plus size={13} />} onClick={() => setQb((s) => ({ ...s, fields: [...s.fields, newField()] }))}>
                          {tr('Ausdruck', 'Expression')}
                        </Button>
                      )
                    }
                  />
                  {bottom === 'fields' ? <FieldGrid /> : <OptionsPane />}
                </Panel>
              </Group>
            </Panel>
            <Separator className="ks-qb-sep-v" />
            <Panel id="qb-sql" defaultSize="320px" minSize="180px" maxSize="50%" groupResizeBehavior="preserve-pixel-size" className="ks-qb-panel" style={{ overflow: 'hidden' }}>
              <div className="ks-qb-sql-head">
                <b>SQL</b>
                <span className="spacer" />
                <IconButton
                  icon={<Copy size={13} />}
                  title={tr('Kopieren', 'Copy')}
                  disabled={!sql}
                  onClick={() => void navigator.clipboard.writeText(sql).then(() => toast(tr('SQL kopiert', 'SQL copied')), (e) => void errorDialog(e))}
                />
              </div>
              <div className="ks-qb-sql">
                <SqlEditor value={sql} readOnly options={{ lineNumbers: 'off', minimap: { enabled: false }, wordWrap: 'on', folding: false, renderLineHighlight: 'none' }} />
              </div>
            </Panel>
          </Group>
          {!loading && !database && (
            <div className="ks-qb-overlay">
              <EmptyState title={tr('Keine Datenbank ausgewählt', 'No database selected')}>{tr('Wählen Sie links eine Datenbank aus.', 'Choose a database on the left.')}</EmptyState>
            </div>
          )}
        </div>
      </QbContext.Provider>
    </Dialog>
  );
}

function FieldGrid() {
  const { qb, update } = useQb();
  const orCount = Math.max(2, ...qb.fields.map((f) => f.criteria.length - 1));
  const aggLabel = (a: Aggregate) => (a ? a : tr('(keine)', '(none)'));
  const label = (tableId?: string, column?: string) => {
    const t = qb.tables.find((x) => x.id === tableId);
    return t ? `${tableLabel(t as QbTable)}.${column}` : (column ?? '');
  };
  if (!qb.fields.length) {
    return <div className="ks-qb-fields-empty muted">{tr('Felder in den Tabellen anhaken oder einen Ausdruck hinzufügen.', 'Tick fields in the tables or add an expression.')}</div>;
  }
  const setCrit = (id: string, criteria: string[], i: number, v: string) => {
    const next = criteria.slice();
    while (next.length <= i) next.push('');
    next[i] = v;
    while (next.length && !next[next.length - 1].trim()) next.pop();
    update((s) => updateField(s, id, { criteria: next }));
  };
  return (
    <div className="ks-qb-fields">
      <table className="ks-table">
        <thead>
          <tr>
            <th style={{ width: 52 }} />
            <th style={{ minWidth: 170 }}>{tr('Feld / Ausdruck', 'Field / Expression')}</th>
            <th style={{ width: 120 }}>{tr('Alias', 'Alias')}</th>
            <th style={{ width: 130 }}>{tr('Aggregat', 'Aggregate')}</th>
            <th style={{ width: 60 }} title={tr('In der Ausgabe anzeigen', 'Show in output')}>
              {tr('Ausgabe', 'Output')}
            </th>
            <th style={{ width: 70 }}>GROUP BY</th>
            <th style={{ width: 110 }}>{tr('Sortierung', 'Sort')}</th>
            <th style={{ width: 150 }} title={tr('z. B. > 10, LIKE \'a%\', IN (1,2) oder ein Wert', "e.g. > 10, LIKE 'a%', IN (1,2) or a value")}>
              {tr('Kriterium', 'Criteria')}
            </th>
            {Array.from({ length: orCount }, (_, i) => (
              <th key={i} style={{ width: 130 }}>
                {tr('Oder', 'Or')}
              </th>
            ))}
            <th style={{ width: 30 }} />
          </tr>
        </thead>
        <tbody>
          {qb.fields.map((f, idx) => (
            <tr key={f.id} className={clsx(!f.visible && 'ks-qb-hidden-field')}>
              <td className="ks-qb-cell">
                <IconButton icon={<ArrowUp size={12} />} title={tr('Nach oben', 'Move up')} disabled={idx === 0} onClick={() => update((s) => moveField(s, f.id, -1))} />
                <IconButton icon={<ArrowDown size={12} />} title={tr('Nach unten', 'Move down')} disabled={idx === qb.fields.length - 1} onClick={() => update((s) => moveField(s, f.id, 1))} />
              </td>
              <td className="ks-qb-cell">
                {f.tableId ? (
                  <span className="mono ellipsis">{label(f.tableId, f.column)}</span>
                ) : (
                  <TextInput className="mono" value={f.expr} placeholder={tr('SQL-Ausdruck', 'SQL expression')} onChange={(e) => update((s) => updateField(s, f.id, { expr: e.target.value }))} />
                )}
              </td>
              <td className="ks-qb-cell">
                <TextInput value={f.alias} disabled={f.column === '*' || f.expr === '*' && !f.aggregate} onChange={(e) => update((s) => updateField(s, f.id, { alias: e.target.value }))} />
              </td>
              <td className="ks-qb-cell">
                <Select
                  value={f.aggregate}
                  disabled={f.column === '*'}
                  onChange={(v) => update((s) => setAggregate(s, f.id, v))}
                  options={AGGREGATES.map((a) => ({ value: a, label: aggLabel(a) }))}
                />
              </td>
              <td className="ks-qb-cell center">
                <Checkbox checked={f.visible} onChange={(v) => update((s) => updateField(s, f.id, { visible: v }))} />
              </td>
              <td className="ks-qb-cell center">
                <Checkbox checked={f.groupBy} disabled={!!f.aggregate || f.column === '*'} onChange={(v) => update((s) => updateField(s, f.id, { groupBy: v }))} />
              </td>
              <td className="ks-qb-cell">
                <Select
                  value={f.sort}
                  disabled={f.column === '*' || (f.expr === '*' && !f.aggregate)}
                  onChange={(v) =>
                    update((s) =>
                      updateField(s, f.id, {
                        sort: v,
                        sortOrder: v ? (f.sort ? f.sortOrder : Math.max(-1, ...s.fields.map((x) => (x.sort ? (x.sortOrder ?? -1) : -1))) + 1) : null
                      })
                    )
                  }
                  options={[
                    { value: '', label: '–' },
                    { value: 'ASC', label: tr('Aufsteigend', 'Ascending') },
                    { value: 'DESC', label: tr('Absteigend', 'Descending') }
                  ]}
                />
              </td>
              {Array.from({ length: orCount + 1 }, (_, i) => (
                <td key={i} className="ks-qb-cell">
                  <TextInput className="mono" value={f.criteria[i] ?? ''} disabled={f.column === '*' || f.expr === '*'} onChange={(e) => setCrit(f.id, f.criteria, i, e.target.value)} />
                </td>
              ))}
              <td className="ks-qb-cell">
                <IconButton icon={<X size={13} />} title={tr('Feld entfernen', 'Remove field')} onClick={() => update((s) => ({ ...s, fields: s.fields.filter((x) => x.id !== f.id) }))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OptionsPane() {
  const { qb, update } = useQb();
  const digits = (v: string) => v.replace(/[^\d]/g, '');
  return (
    <div className="ks-qb-options">
      <div className="ks-qb-options-row">
        <Checkbox checked={qb.distinct} onChange={(v) => update((s) => ({ ...s, distinct: v }))} label={tr('Nur eindeutige Zeilen (DISTINCT)', 'Distinct rows only (DISTINCT)')} />
        <span className="spacer" />
        <label>LIMIT</label>
        <TextInput style={{ width: 90 }} value={qb.limit} placeholder={tr('alle', 'all')} onChange={(e) => update((s) => ({ ...s, limit: digits(e.target.value) }))} />
        <label>OFFSET</label>
        <TextInput style={{ width: 90 }} value={qb.offset} placeholder="0" onChange={(e) => update((s) => ({ ...s, offset: digits(e.target.value) }))} />
      </div>
      <div className="ks-qb-options-cols">
        <label className="col">
          <span>{tr('Zusätzliche WHERE-Bedingung (mit AND verknüpft)', 'Additional WHERE condition (combined with AND)')}</span>
          <TextArea className="mono" rows={4} value={qb.where} onChange={(e) => update((s) => ({ ...s, where: e.target.value }))} />
        </label>
        <label className="col">
          <span>{tr('Zusätzliche HAVING-Bedingung', 'Additional HAVING condition')}</span>
          <TextArea className="mono" rows={4} value={qb.having} onChange={(e) => update((s) => ({ ...s, having: e.target.value }))} />
        </label>
      </div>
    </div>
  );
}

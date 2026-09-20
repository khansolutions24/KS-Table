// Tree of privilege objects: server (global) → databases → tables / views (→ columns), functions, procedures.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Server } from 'lucide-react';
import type { PrivTarget } from '@shared/apis/users';
import { tr } from '@shared/i18n';
import { makeTarget, targetKey } from '@shared/users/privileges';
import { api, errorMessage } from '../../api/client';
import { ObjIcon, type ObjKind } from '../../components/icons';
import { Spinner } from '../../components/ui/controls';
import { keyCombo } from '../../lib/shortcuts';
import { metaSession, useWorkspace } from '../../store/workspace';
import type { SchemaInfo } from '@shared/types';

interface TreeNode {
  key: string;
  target: PrivTarget;
  label: string;
  kind: ObjKind | 'server';
  expandable: boolean;
}

interface Row extends TreeNode {
  depth: number;
  placeholder?: 'loading' | 'error' | 'empty';
  message?: string;
}

type Children = { loading: boolean; error?: string; nodes: TreeNode[] };

export const GLOBAL_TARGET: PrivTarget = makeTarget('global');
const GLOBAL_KEY = targetKey(GLOBAL_TARGET);
const NO_DBS: SchemaInfo[] = [];

function iconOf(kind: TreeNode['kind'], size = 15): ReactNode {
  if (kind === 'server') return <Server size={size} style={{ color: 'var(--c-mysql)', flex: 'none' }} />;
  return <ObjIcon kind={kind} size={size} />;
}

export interface ObjectTreeProps {
  connectionId: string;
  /** Show the server (global privileges) as root node */
  showGlobal: boolean;
  /** Selected node keys (targetKey) */
  selected: string[];
  multi?: boolean;
  onSelect(targets: PrivTarget[], keys: string[]): void;
  /** Double click / Enter */
  onOpen?(target: PrivTarget): void;
  /** Extra content at the end of a row (e.g. number of accounts) */
  badge?(target: PrivTarget): ReactNode;
  className?: string;
}

export function ObjectTree(p: ObjectTreeProps) {
  const databases = useWorkspace((s) => s.conns[p.connectionId]?.databases ?? NO_DBS);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(p.showGlobal ? [GLOBAL_KEY] : []));
  const [children, setChildren] = useState<Record<string, Children>>({});
  const [focusKey, setFocusKey] = useState<string | null>(p.selected[0] ?? null);
  const targets = useRef(new Map<string, PrivTarget>([[GLOBAL_KEY, GLOBAL_TARGET]]));
  const listRef = useRef<HTMLDivElement>(null);

  const mk = (target: PrivTarget, label: string, kind: TreeNode['kind'], expandable: boolean): TreeNode => {
    const key = targetKey(target) + (kind === 'view' ? '|v' : '');
    targets.current.set(key, target);
    return { key, target, label, kind, expandable };
  };

  const dbNodes = useMemo(() => databases.map((d) => mk(makeTarget('database', d.name), d.name, 'database', true)), [databases]);

  const loadChildren = async (n: TreeNode) => {
    const cur = children[n.key];
    if (cur && !cur.error) return;
    setChildren((c) => ({ ...c, [n.key]: { loading: true, nodes: [] } }));
    try {
      const sid = metaSession(p.connectionId);
      const t = n.target;
      let nodes: TreeNode[] = [];
      if (t.level === 'database') {
        const [tables, views, routines] = await Promise.all([api.meta.tables(sid, t.db), api.meta.views(sid, t.db), api.meta.routines(sid, t.db)]);
        nodes = [
          ...tables.map((x) => mk(makeTarget('table', t.db, x.name), x.name, 'table', true)),
          ...views.map((x) => mk(makeTarget('table', t.db, x.name), x.name, 'view', true)),
          ...routines.map((r) => mk(makeTarget('routine', t.db, r.name, '', r.type), r.name, r.type === 'FUNCTION' ? 'function' : 'procedure', false))
        ];
      } else if (t.level === 'table') {
        const cols = await api.meta.columns(sid, t.db, t.name);
        nodes = cols.map((c) => mk(makeTarget('column', t.db, t.name, c.name), c.name, 'column', false));
      }
      setChildren((c) => ({ ...c, [n.key]: { loading: false, nodes } }));
    } catch (e) {
      setChildren((c) => ({ ...c, [n.key]: { loading: false, nodes: [], error: errorMessage(e) } }));
    }
  };

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ ...n, depth });
        if (!n.expandable || !expanded.has(n.key)) continue;
        const ch: Children | undefined = n.key === GLOBAL_KEY ? { loading: false, nodes: dbNodes } : children[n.key];
        if (!ch || ch.loading) out.push({ ...n, key: `${n.key}#loading`, depth: depth + 1, placeholder: 'loading', expandable: false });
        else if (ch.error) out.push({ ...n, key: `${n.key}#error`, depth: depth + 1, placeholder: 'error', message: ch.error, expandable: false });
        else if (!ch.nodes.length) out.push({ ...n, key: `${n.key}#empty`, depth: depth + 1, placeholder: 'empty', expandable: false });
        else walk(ch.nodes, depth + 1);
      }
    };
    walk(p.showGlobal ? [{ key: GLOBAL_KEY, target: GLOBAL_TARGET, label: tr('Server (globale Rechte)', 'Server (global privileges)'), kind: 'server', expandable: true }] : dbNodes, 0);
    return out;
  }, [p.showGlobal, dbNodes, children, expanded]);

  const selectable = rows.filter((r) => !r.placeholder);

  const toggle = (n: Row) => {
    if (!n.expandable) return;
    const open = !expanded.has(n.key);
    setExpanded((s) => {
      const next = new Set(s);
      if (open) next.add(n.key);
      else next.delete(n.key);
      return next;
    });
    if (open && n.key !== GLOBAL_KEY) void loadChildren(n);
  };

  const emit = (keys: string[]) => {
    p.onSelect(keys.map((k) => targets.current.get(k)).filter((t): t is PrivTarget => !!t), keys);
  };

  const click = (e: React.MouseEvent, r: Row) => {
    setFocusKey(r.key);
    if (p.multi && (e.ctrlKey || e.metaKey)) emit(p.selected.includes(r.key) ? p.selected.filter((k) => k !== r.key) : [...p.selected, r.key]);
    else emit([r.key]);
  };

  const move = (delta: number) => {
    if (!selectable.length) return;
    const idx = selectable.findIndex((r) => r.key === focusKey);
    const next = selectable[Math.max(0, Math.min(selectable.length - 1, idx < 0 ? 0 : idx + delta))];
    setFocusKey(next.key);
    emit([next.key]);
    listRef.current?.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const r = selectable.find((x) => x.key === focusKey);
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (keyCombo(e)) {
      case 'ArrowDown':
        stop();
        move(1);
        break;
      case 'ArrowUp':
        stop();
        move(-1);
        break;
      case 'ArrowRight':
        stop();
        if (r?.expandable && !expanded.has(r.key)) toggle(r);
        else move(1);
        break;
      case 'ArrowLeft':
        stop();
        if (r?.expandable && expanded.has(r.key)) toggle(r);
        else if (r) {
          const idx = rows.findIndex((x) => x.key === r.key);
          for (let i = idx - 1; i >= 0; i--) {
            if (rows[i].depth < r.depth && !rows[i].placeholder) {
              setFocusKey(rows[i].key);
              emit([rows[i].key]);
              break;
            }
          }
        }
        break;
      case 'Space':
        if (p.multi && r) {
          stop();
          emit(p.selected.includes(r.key) ? p.selected.filter((k) => k !== r.key) : [...p.selected, r.key]);
        }
        break;
      case 'Enter':
        if (r) {
          stop();
          if (p.onOpen) p.onOpen(r.target);
          else toggle(r);
        }
        break;
    }
  };

  return (
    <div className={clsx('ks-users-tree', p.className)} ref={listRef} tabIndex={0} onKeyDown={onKeyDown}>
      {rows.map((r) =>
        r.placeholder ? (
          <div key={r.key} className="ks-users-tree-row placeholder" style={{ paddingLeft: 24 + r.depth * 16 }}>
            {r.placeholder === 'loading' ? <Spinner size={12} /> : null}
            <span className={clsx('ellipsis', r.placeholder === 'error' ? 'danger-text' : 'faint')}>
              {r.placeholder === 'loading' ? tr('Wird geladen …', 'Loading …') : r.placeholder === 'error' ? r.message : tr('(leer)', '(empty)')}
            </span>
          </div>
        ) : (
          <div
            key={r.key}
            data-key={r.key}
            className={clsx('ks-users-tree-row', p.selected.includes(r.key) && 'selected', focusKey === r.key && 'focused')}
            style={{ paddingLeft: 4 + r.depth * 16 }}
            onMouseDown={(e) => {
              if (e.button === 0) click(e, r);
            }}
            onDoubleClick={() => (p.onOpen ? p.onOpen(r.target) : toggle(r))}
            title={r.label}
          >
            <span
              className="ks-users-tree-twisty"
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                toggle(r);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {r.expandable ? expanded.has(r.key) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
            </span>
            {iconOf(r.kind)}
            <span className="ellipsis grow">{r.label}</span>
            {p.badge?.(r.target)}
          </div>
        )
      )}
      {!rows.length && <div className="ks-users-tree-row placeholder faint">{tr('Keine Datenbanken', 'No databases')}</div>}
    </div>
  );
}

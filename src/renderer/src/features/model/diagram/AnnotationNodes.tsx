// Notes, labels, shapes and layers of the model designer (resizable, inline text editing).

import { createContext, memo, useContext, useEffect, useRef, type CSSProperties } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import type { ShapeKind } from '@shared/model/types';

export interface CanvasActions {
  commitBox: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  commitText: (id: string, text: string) => void;
  editingId: string | null;
  stopEditing: () => void;
}

export const CanvasContext = createContext<CanvasActions>({ commitBox: () => undefined, commitText: () => undefined, editingId: null, stopEditing: () => undefined });

export interface AnnotationData extends Record<string, unknown> {
  text: string;
  color: string | null;
  /** labels */
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  /** shapes */
  shape?: ShapeKind;
}

export type AnnotationNode = Node<AnnotationData, 'note' | 'label' | 'shape' | 'layer'>;

function InlineEditor({ id, text, multiline }: { id: string; text: string; multiline: boolean }) {
  const ctx = useContext(CanvasContext);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  const done = (save: boolean) => {
    if (save && ref.current && ref.current.value !== text) ctx.commitText(id, ref.current.value);
    ctx.stopEditing();
  };
  return (
    <textarea
      ref={ref}
      className="ks-md-edit nodrag nowheel nopan"
      defaultValue={text}
      spellCheck={false}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') done(false);
        else if (e.key === 'Enter' && (!multiline || e.ctrlKey)) {
          e.preventDefault();
          done(true);
        }
      }}
    />
  );
}

function Resizer({ id, selected, minWidth = 40, minHeight = 30 }: { id: string; selected: boolean; minWidth?: number; minHeight?: number }) {
  const ctx = useContext(CanvasContext);
  return (
    <NodeResizer
      isVisible={selected}
      minWidth={minWidth}
      minHeight={minHeight}
      lineClassName="ks-dg-noexport"
      handleClassName="ks-dg-noexport"
      onResizeEnd={(_, p) => ctx.commitBox(id, { x: p.x, y: p.y, width: p.width, height: p.height })}
    />
  );
}

const colorVar = (c: string | null, fallback: string) => ({ '--obj-color': c ?? fallback }) as CSSProperties;

export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps<AnnotationNode>) {
  const editing = useContext(CanvasContext).editingId === id;
  return (
    <>
      <Resizer id={id} selected={selected} minWidth={80} minHeight={40} />
      <div className="ks-md-note" style={colorVar(data.color, '#ca8a04')}>
        {editing ? <InlineEditor id={id} text={data.text} multiline /> : data.text}
      </div>
    </>
  );
});

export const LabelNode = memo(function LabelNode({ id, data }: NodeProps<AnnotationNode>) {
  const editing = useContext(CanvasContext).editingId === id;
  const style = {
    ...colorVar(data.color, 'var(--fg)'),
    fontSize: data.fontSize ?? 16,
    fontWeight: data.bold ? 700 : 400,
    fontStyle: data.italic ? 'italic' : 'normal'
  } as CSSProperties;
  return (
    <div className="ks-md-label" style={style}>
      {editing ? <InlineEditor id={id} text={data.text} multiline={false} /> : data.text || ' '}
    </div>
  );
});

function shapePath(kind: ShapeKind): JSX.Element {
  switch (kind) {
    case 'ellipse':
      return <ellipse cx="50%" cy="50%" rx="49%" ry="49%" />;
    case 'diamond':
      return <polygon points="50,1 99,50 50,99 1,50" vectorEffect="non-scaling-stroke" />;
    case 'rounded':
      return <rect x="0.5%" y="0.5%" width="99%" height="99%" rx="14" />;
    default:
      return <rect x="0.5%" y="0.5%" width="99%" height="99%" rx="2" />;
  }
}

export const ShapeNode = memo(function ShapeNode({ id, data, selected }: NodeProps<AnnotationNode>) {
  const editing = useContext(CanvasContext).editingId === id;
  const kind = data.shape ?? 'rect';
  return (
    <>
      <Resizer id={id} selected={selected} />
      <div className="ks-md-shape" style={colorVar(data.color, '#64748b')}>
        <svg className="ks-md-shape-bg" viewBox={kind === 'diamond' ? '0 0 100 100' : undefined} preserveAspectRatio="none">
          <g style={{ fill: 'color-mix(in srgb, var(--obj-color) 16%, var(--bg-panel))', stroke: 'var(--obj-color)', strokeWidth: 1.5 }}>{shapePath(kind)}</g>
        </svg>
        {editing ? <InlineEditor id={id} text={data.text} multiline /> : <span>{data.text}</span>}
      </div>
    </>
  );
});

export const LayerNode = memo(function LayerNode({ id, data, selected }: NodeProps<AnnotationNode>) {
  const editing = useContext(CanvasContext).editingId === id;
  return (
    <>
      <Resizer id={id} selected={selected} minWidth={120} minHeight={80} />
      <div className="ks-md-layer" style={colorVar(data.color, '#64748b')}>
        <div className="ks-md-layer-title">{editing ? <InlineEditor id={id} text={data.text} multiline={false} /> : data.text}</div>
      </div>
    </>
  );
});

// Model document state with undo / redo history and dirty tracking.

import { useCallback, useRef, useState } from 'react';
import type { ModelDoc } from '@shared/model/types';

const LIMIT = 150;

export interface ModelDocState {
  doc: ModelDoc;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Applies a change and records it for undo */
  change: (fn: (d: ModelDoc) => ModelDoc, coalesce?: string) => void;
  /** Replaces the document (open / new) and clears the history */
  reset: (doc: ModelDoc, dirty?: boolean) => void;
  /** Marks the current state as saved */
  markSaved: (doc?: ModelDoc) => void;
  undo: () => void;
  redo: () => void;
  getDoc: () => ModelDoc;
}

interface Hist {
  past: ModelDoc[];
  present: ModelDoc;
  future: ModelDoc[];
  saved: ModelDoc | null;
}

export function useModelDoc(initial: ModelDoc): ModelDocState {
  const [h, setH] = useState<Hist>({ past: [], present: initial, future: [], saved: initial });
  const ref = useRef(h);
  ref.current = h;

  const last = useRef<{ key: string; time: number } | null>(null);
  const change = useCallback((fn: (d: ModelDoc) => ModelDoc, coalesce?: string) => {
    const now = Date.now();
    const merge = !!coalesce && last.current?.key === coalesce && now - last.current.time < 1500;
    last.current = coalesce ? { key: coalesce, time: now } : null;
    setH((cur) => {
      const next = fn(cur.present);
      if (next === cur.present) return cur;
      if (merge && cur.past.length) return { ...cur, present: { ...next, updatedAt: now }, future: [] };
      return { past: [...cur.past, cur.present].slice(-LIMIT), present: { ...next, updatedAt: Date.now() }, future: [], saved: cur.saved };
    });
  }, []);

  const reset = useCallback((doc: ModelDoc, dirty = false) => setH({ past: [], present: doc, future: [], saved: dirty ? null : doc }), []);

  const markSaved = useCallback((doc?: ModelDoc) => setH((cur) => ({ ...cur, present: doc ?? cur.present, saved: doc ?? cur.present })), []);

  const undo = useCallback(
    () =>
      setH((cur) =>
        cur.past.length ? { past: cur.past.slice(0, -1), present: cur.past[cur.past.length - 1], future: [cur.present, ...cur.future], saved: cur.saved } : cur
      ),
    []
  );

  const redo = useCallback(
    () => setH((cur) => (cur.future.length ? { past: [...cur.past, cur.present], present: cur.future[0], future: cur.future.slice(1), saved: cur.saved } : cur)),
    []
  );

  const getDoc = useCallback(() => ref.current.present, []);

  return {
    doc: h.present,
    dirty: h.present !== h.saved,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    change,
    reset,
    markSaved,
    undo,
    redo,
    getDoc
  };
}

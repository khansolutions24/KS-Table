// Shared behaviour of the object designers: dirty flag on the tab, close guard, save command / Ctrl+S and
// designer specific shortcuts while the tab is active, own session for previews and executions.

import { useCallback, useEffect, useRef } from 'react';
import { tr } from '@shared/i18n';
import { api, RpcError } from '../../../api/client';
import { askDialog, hasOpenDialog } from '../../../components/ui/Dialog';
import { keyCombo } from '../../../lib/shortcuts';
import { setCloseGuard, useTabs, type TabInfo } from '../../../store/tabs';
import { openSessionWithPrompt } from '../../../store/workspace';

export interface DesignerTabOptions {
  tab: TabInfo;
  active: boolean;
  dirty: boolean;
  /** Saves the object; resolves true when it was saved */
  save: () => Promise<boolean>;
  /** Object name for the "save changes?" question */
  objectLabel: () => string;
  /** Additional shortcuts while the tab is active, e.g. { 'Ctrl+O': openData, F9: execute } */
  shortcuts?: Record<string, () => void>;
  /** Edit > Find */
  onFind?: () => void;
}

export function useDesignerTab(o: DesignerTabOptions): void {
  const ref = useRef(o);
  ref.current = o;

  useEffect(() => {
    const t = useTabs.getState().tabs.find((x) => x.id === o.tab.id);
    if (t && !!t.dirty !== o.dirty) useTabs.getState().update(o.tab.id, { dirty: o.dirty });
  }, [o.dirty, o.tab.id]);

  useEffect(() => {
    setCloseGuard(o.tab.id, async () => {
      const cur = ref.current;
      if (!cur.dirty) return true;
      const answer = await askDialog({
        title: tr('Ungespeicherte Änderungen', 'Unsaved changes'),
        message: tr('Sollen die Änderungen an {n} gespeichert werden?', 'Do you want to save the changes to {n}?', { n: cur.objectLabel() }),
        yesLabel: tr('Speichern', 'Save'),
        noLabel: tr('Nicht speichern', "Don't save")
      });
      if (answer === 'cancel') return false;
      if (answer === 'no') return true;
      return cur.save();
    });
    return () => setCloseGuard(o.tab.id, null);
  }, [o.tab.id]);

  useEffect(() => {
    if (!o.active) return;
    const onCommand = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail === 'save') void ref.current.save();
      else if (detail === 'find') ref.current.onFind?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (hasOpenDialog() || e.defaultPrevented) return;
      const combo = keyCombo(e);
      const fn = combo === 'Ctrl+S' ? () => void ref.current.save() : combo === 'Ctrl+F' && ref.current.onFind ? ref.current.onFind : ref.current.shortcuts?.[combo];
      if (!fn) return;
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    window.addEventListener('ks-command', onCommand);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('ks-command', onCommand);
      window.removeEventListener('keydown', onKey);
    };
  }, [o.active]);
}

/** Lets a pending edit in a focused input commit (blur) before an action reads the state */
export async function commitPendingEdits(): Promise<void> {
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
    el.blur();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Session of the tab itself (opened on first use, closed on unmount) */
export function useOwnSession(connectionId: string, database: string | null): () => Promise<string> {
  const ref = useRef<Promise<string> | null>(null);
  useEffect(
    () => () => {
      const p = ref.current;
      ref.current = null;
      if (p) void p.then((sid) => api.session.close(sid)).catch(() => undefined);
    },
    []
  );
  return useCallback(() => {
    if (!ref.current) {
      const p = openSessionWithPrompt(connectionId, database).then((info) => info.sessionId);
      ref.current = p;
      p.catch(() => {
        if (ref.current === p) ref.current = null;
      });
    }
    return ref.current;
  }, [connectionId, database]);
}

/** Executes one statement (not split) in a session and throws its error */
export async function execChecked(sessionId: string, sql: string): Promise<void> {
  const r = await api.query.execute(sessionId, sql, { noSplit: true, stopOnError: true });
  const err = r.results.find((x) => x.kind === 'error');
  if (err?.error) throw new RpcError(err.error);
}

/** Updates key, title and params of a designer tab after its object got a (new) name */
export function renameDesignerTab(tabId: string, key: string, title: string, params: Record<string, unknown>): void {
  const s = useTabs.getState();
  s.update(tabId, { key, title });
  s.updateParams(tabId, params);
}

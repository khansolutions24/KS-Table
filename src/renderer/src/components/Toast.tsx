import { create } from 'zustand';
import clsx from 'clsx';
import { CircleAlert, Check, Info, X } from 'lucide-react';

interface ToastItem {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let seq = 0;

export function toast(text: string, kind: ToastItem['kind'] = 'info', ms = 3200): void {
  const id = ++seq;
  useToasts.setState((s) => ({ items: [...s.items.slice(-4), { id, text, kind }] }));
  window.setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), ms);
}

export function ToastHost() {
  const items = useToasts((s) => s.items);
  return (
    <div className="ks-toasts">
      {items.map((t) => (
        <div key={t.id} className={clsx('ks-toast', t.kind)}>
          {t.kind === 'success' ? <Check size={15} /> : t.kind === 'error' ? <CircleAlert size={15} /> : <Info size={15} />}
          <span>{t.text}</span>
          <button
            type="button"
            onClick={() => useToasts.setState((s) => ({ items: s.items.filter((x) => x.id !== t.id) }))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

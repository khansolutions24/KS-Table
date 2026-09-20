// Modal dialogs: a promise based dialog stack plus confirm/alert/prompt/error helpers.

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import clsx from 'clsx';
import { CircleX, Info, TriangleAlert, X, Copy } from 'lucide-react';
import { tr } from '@shared/i18n';
import { RpcError } from '../../api/client';
import { Button, TextArea, TextInput } from './controls';

interface Entry {
  id: number;
  render: (close: (value?: unknown) => void) => ReactNode;
  resolve: (value: unknown) => void;
}

const useDialogStore = create<{ stack: Entry[] }>(() => ({ stack: [] }));
let seq = 0;

export function openDialog<T = unknown>(render: (close: (value?: T) => void) => ReactNode): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const entry: Entry = {
      id: ++seq,
      render: render as Entry['render'],
      resolve: resolve as Entry['resolve']
    };
    useDialogStore.setState((s) => ({ stack: [...s.stack, entry] }));
  });
}

function closeEntry(id: number, value: unknown): void {
  const entry = useDialogStore.getState().stack.find((e) => e.id === id);
  useDialogStore.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) }));
  entry?.resolve(value);
}

export function hasOpenDialog(): boolean {
  return useDialogStore.getState().stack.length > 0;
}

export function DialogHost() {
  const stack = useDialogStore((s) => s.stack);
  return createPortal(
    <>
      {stack.map((e) => (
        <Fragment key={e.id}>{e.render((v) => closeEntry(e.id, v))}</Fragment>
      ))}
    </>,
    document.body
  );
}

export interface DialogProps {
  title: ReactNode;
  icon?: ReactNode;
  width?: number | string;
  height?: number | string;
  onClose: () => void;
  onSubmit?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** content left of the footer buttons */
  footerLeft?: ReactNode;
  className?: string;
  bodyClassName?: string;
  resizable?: boolean;
  noPadding?: boolean;
  style?: CSSProperties;
}

export function Dialog(p: DialogProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const root = formRef.current;
    if (!root) return;
    const el =
      root.querySelector<HTMLElement>('[data-autofocus]') ??
      root.querySelector<HTMLElement>('.ks-dialog-body input:not([type=hidden]):not([disabled]):not([type=checkbox]):not([type=radio]), .ks-dialog-body select, .ks-dialog-body textarea') ??
      root.querySelector<HTMLElement>('.ks-dialog-footer .ks-btn-primary, .ks-dialog-footer .ks-btn-danger');
    el?.focus();
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const sx = e.clientX - offset.x;
    const sy = e.clientY - offset.y;
    const move = (ev: MouseEvent) => setOffset({ x: ev.clientX - sx, y: Math.max(-window.innerHeight / 2 + 40, ev.clientY - sy) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      className="ks-dialog-overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          p.onClose();
        }
      }}
    >
      <form
        ref={formRef}
        className={clsx('ks-dialog', p.resizable && 'resizable', p.className)}
        style={{ width: p.width ?? 480, height: p.height, transform: `translate(${offset.x}px, ${offset.y}px)`, ...p.style }}
        role="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit?.();
        }}
      >
        <div className="ks-dialog-title" onMouseDown={startDrag} onDoubleClick={() => setOffset({ x: 0, y: 0 })}>
          {p.icon}
          <span className="ks-dialog-title-text">{p.title}</span>
          <button type="button" className="ks-dialog-close" onClick={p.onClose} title={tr('Schließen', 'Close')}>
            <X size={16} />
          </button>
        </div>
        <div className={clsx('ks-dialog-body', p.noPadding && 'no-padding', p.bodyClassName)}>{p.children}</div>
        {(p.footer || p.footerLeft) && (
          <div className="ks-dialog-footer">
            {p.footerLeft && <div className="ks-dialog-footer-left">{p.footerLeft}</div>}
            <div className="spacer" />
            {p.footer}
          </div>
        )}
      </form>
    </div>
  );
}

type MsgKind = 'info' | 'warning' | 'error';

function MsgIcon({ kind }: { kind: MsgKind }) {
  if (kind === 'error') return <CircleX className="ks-msg-icon error" size={30} />;
  if (kind === 'warning') return <TriangleAlert className="ks-msg-icon warning" size={30} />;
  return <Info className="ks-msg-icon info" size={30} />;
}

export function confirmDialog(o: {
  title?: string;
  message: ReactNode;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  kind?: MsgKind;
}): Promise<boolean> {
  return openDialog<boolean>((close) => (
    <Dialog
      title={o.title ?? tr('Bestätigen', 'Confirm')}
      width={460}
      onClose={() => close(false)}
      onSubmit={() => close(true)}
      footer={
        <>
          <Button type="submit" variant={o.danger ? 'danger' : 'primary'}>
            {o.okLabel ?? 'OK'}
          </Button>
          <Button onClick={() => close(false)}>{o.cancelLabel ?? tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-msg">
        <MsgIcon kind={o.kind ?? (o.danger ? 'warning' : 'info')} />
        <div className="ks-msg-text">{o.message}</div>
      </div>
    </Dialog>
  )).then((v) => !!v);
}

/** Three-way question (e.g. save changes?) → 'yes' | 'no' | 'cancel' */
export function askDialog(o: {
  title?: string;
  message: ReactNode;
  yesLabel?: string;
  noLabel?: string;
}): Promise<'yes' | 'no' | 'cancel'> {
  return openDialog<'yes' | 'no' | 'cancel'>((close) => (
    <Dialog
      title={o.title ?? tr('Frage', 'Question')}
      width={460}
      onClose={() => close('cancel')}
      onSubmit={() => close('yes')}
      footer={
        <>
          <Button type="submit" variant="primary">
            {o.yesLabel ?? tr('Ja', 'Yes')}
          </Button>
          <Button onClick={() => close('no')}>{o.noLabel ?? tr('Nein', 'No')}</Button>
          <Button onClick={() => close('cancel')}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-msg">
        <MsgIcon kind="warning" />
        <div className="ks-msg-text">{o.message}</div>
      </div>
    </Dialog>
  )).then((v) => v ?? 'cancel');
}

export function alertDialog(o: { title?: string; message: ReactNode; kind?: MsgKind; details?: string }): Promise<void> {
  return openDialog<void>((close) => (
    <Dialog
      title={o.title ?? (o.kind === 'error' ? tr('Fehler', 'Error') : o.kind === 'warning' ? tr('Warnung', 'Warning') : 'KS Table')}
      width={o.details ? 620 : 460}
      onClose={() => close()}
      onSubmit={() => close()}
      footer={<Button type="submit" variant="primary">OK</Button>}
    >
      <div className="ks-msg">
        <MsgIcon kind={o.kind ?? 'info'} />
        <div className="ks-msg-text selectable">
          {o.message}
          {o.details && <Details text={o.details} />}
        </div>
      </div>
    </Dialog>
  )).then(() => undefined);
}

function Details({ text }: { text: string }) {
  return (
    <div className="ks-msg-details">
      <pre className="selectable">{text}</pre>
      <button type="button" className="ks-icon-btn" title={tr('Kopieren', 'Copy')} onClick={() => void navigator.clipboard.writeText(text)}>
        <Copy size={13} />
      </button>
    </div>
  );
}

export function errorDialog(e: unknown, title?: string): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  let details: string | undefined;
  if (e instanceof RpcError) {
    const parts: string[] = [];
    if (e.errno) parts.push(`${tr('Fehlercode', 'Error code')}: ${e.errno}${e.sqlState ? ` (SQLSTATE ${e.sqlState})` : ''}`);
    else if (e.code && !/^[A-Z_]+_REQUIRED$/.test(e.code)) parts.push(`${tr('Code', 'Code')}: ${e.code}`);
    if (e.sql) parts.push(e.sql);
    if (parts.length) details = parts.join('\n\n');
  }
  return alertDialog({ title: title ?? tr('Fehler', 'Error'), message, kind: 'error', details });
}

export function promptDialog(o: {
  title: string;
  label?: ReactNode;
  value?: string;
  placeholder?: string;
  password?: boolean;
  multiline?: boolean;
  okLabel?: string;
  width?: number;
  validate?: (v: string) => string | null;
}): Promise<string | null> {
  return openDialog<string | null>((close) => <PromptBody o={o} close={close} />).then((v) => (v === undefined ? null : v));
}

function PromptBody({
  o,
  close
}: {
  o: Parameters<typeof promptDialog>[0];
  close: (v?: string | null) => void;
}) {
  const [value, setValue] = useState(o.value ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const err = o.validate?.(value) ?? null;
    if (err) {
      setError(err);
      return;
    }
    close(value);
  };
  return (
    <Dialog
      title={o.title}
      width={o.width ?? 440}
      onClose={() => close(null)}
      onSubmit={submit}
      footer={
        <>
          <Button type="submit" variant="primary">
            {o.okLabel ?? 'OK'}
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 6 }}>
        {o.label && <label>{o.label}</label>}
        {o.multiline ? (
          <TextArea data-autofocus rows={8} value={value} placeholder={o.placeholder} onChange={(e) => setValue(e.target.value)} />
        ) : (
          <TextInput
            data-autofocus
            type={o.password ? 'password' : 'text'}
            value={value}
            placeholder={o.placeholder}
            invalid={!!error}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        {error && <div className="danger-text">{error}</div>}
      </div>
    </Dialog>
  );
}

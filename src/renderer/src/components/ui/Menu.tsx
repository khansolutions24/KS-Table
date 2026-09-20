// Menu system: context menus, dropdowns and the top menu bar (one open menu at a time).

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import clsx from 'clsx';
import { Check, ChevronRight } from 'lucide-react';

export interface MenuAction {
  type?: 'item';
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  hidden?: boolean;
  onClick?: () => void;
  submenu?: MenuItem[];
}
export interface MenuSeparator {
  type: 'separator';
}
export interface MenuHeader {
  type: 'header';
  label: string;
}
export type MenuItem = MenuAction | MenuSeparator | MenuHeader;

export const SEP: MenuSeparator = { type: 'separator' };

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
  owner?: string;
  minWidth?: number;
  onClose?: () => void;
  seq?: number;
}

export const useMenuStore = create<{ menu: OpenMenu | null }>(() => ({ menu: null }));

let seq = 0;

export function showMenu(menu: OpenMenu): void {
  useMenuStore.setState({ menu: { ...menu, seq: ++seq } });
}

type PointerLike = { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void };

export function showContextMenu(e: PointerLike, items: MenuItem[]): void {
  e.preventDefault?.();
  e.stopPropagation?.();
  showMenu({ x: e.clientX, y: e.clientY, items });
}

export function showMenuBelow(el: HTMLElement, items: MenuItem[], owner?: string): void {
  const r = el.getBoundingClientRect();
  showMenu({ x: r.left, y: r.bottom + 1, items, owner, minWidth: Math.max(r.width, 170) });
}

export function closeMenu(): void {
  const m = useMenuStore.getState().menu;
  if (!m) return;
  useMenuStore.setState({ menu: null });
  m.onClose?.();
}

const isAction = (i: MenuItem): i is MenuAction => !i.type || i.type === 'item';

function cleanSeparators(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (isAction(it) && it.hidden) continue;
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

export function MenuHost() {
  const menu = useMenuStore((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.ks-menu')) return;
      if (menu.owner && t.closest(`[data-menu-owner="${menu.owner}"]`)) return;
      closeMenu();
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.target as HTMLElement).closest('.ks-menu')) closeMenu();
    };
    const onBlur = () => closeMenu();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('wheel', onWheel, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [menu]);
  if (!menu) return null;
  return createPortal(
    <MenuPopup key={menu.seq} items={menu.items} x={menu.x} y={menu.y} minWidth={menu.minWidth} onDone={closeMenu} />,
    document.body
  );
}

interface PopupProps {
  items: MenuItem[];
  x: number;
  y: number;
  minWidth?: number;
  /** x coordinate to flip to (left edge of the parent item) when there is no room on the right */
  flipX?: number;
  onDone: () => void;
  onBack?: () => void;
}

function MenuPopup({ items, x, y, minWidth, flipX, onDone, onBack }: PopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = cleanSeparators(items);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 4) left = flipX !== undefined ? flipX - r.width : window.innerWidth - r.width - 4;
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ left: Math.max(4, left), top: Math.max(4, top) });
    el.focus({ preventScroll: true });
  }, [x, y, flipX]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const openSub = (i: number) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSub({ index: i, x: r.right - 3, y: r.top - 5, flipX: r.left + 3 });
  };

  const activate = (i: number) => {
    const it = visible[i];
    if (!it || !isAction(it) || it.disabled) return;
    if (it.submenu) {
      openSub(i);
      return;
    }
    onDone();
    it.onClick?.();
  };

  const move = (dir: 1 | -1) => {
    const n = visible.length;
    let i = active;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      const it = visible[i];
      if (isAction(it) && !it.disabled) {
        setActive(i);
        return;
      }
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'ArrowRight': {
        const it = visible[active];
        if (it && isAction(it) && it.submenu) {
          e.preventDefault();
          openSub(active);
        }
        break;
      }
      case 'ArrowLeft':
        if (onBack) {
          e.preventDefault();
          onBack();
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(active);
        break;
      case 'Escape':
        e.preventDefault();
        if (onBack) onBack();
        else onDone();
        break;
      case 'Tab':
        e.preventDefault();
        break;
    }
  };

  const subItem = sub ? visible[sub.index] : undefined;

  return (
    <div
      ref={ref}
      className="ks-menu"
      tabIndex={-1}
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, minWidth, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {visible.map((it, i) => {
        if (it.type === 'separator') return <div key={i} className="ks-menu-sep" />;
        if (it.type === 'header') return <div key={i} className="ks-menu-header">{it.label}</div>;
        return (
          <div
            key={i}
            data-index={i}
            className={clsx('ks-menu-item', i === active && 'active', it.disabled && 'disabled', it.danger && 'danger')}
            onMouseEnter={() => {
              setActive(i);
              window.clearTimeout(timer.current);
              if (it.submenu && !it.disabled) timer.current = window.setTimeout(() => openSub(i), 110);
              else if (sub) timer.current = window.setTimeout(() => setSub(null), 150);
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => activate(i)}
          >
            <span className="ks-menu-icon">{it.checked ? <Check size={14} /> : it.icon}</span>
            <span className="ks-menu-label">{it.label}</span>
            {it.shortcut && <span className="ks-menu-shortcut">{it.shortcut}</span>}
            {it.submenu && <ChevronRight size={14} className="ks-menu-arrow" />}
          </div>
        );
      })}
      {sub && subItem && isAction(subItem) && subItem.submenu && (
        <MenuPopup
          key={sub.index}
          items={subItem.submenu}
          x={sub.x}
          y={sub.y}
          flipX={sub.flipX}
          onDone={onDone}
          onBack={() => {
            setSub(null);
            ref.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

export interface TopMenu {
  id: string;
  label: string;
  items: () => MenuItem[];
}

export function MenuBar({ menus }: { menus: TopMenu[] }) {
  const openOwner = useMenuStore((s) => s.menu?.owner);
  const open = (m: TopMenu, el: HTMLElement) => showMenuBelow(el, m.items(), `menubar:${m.id}`);
  return (
    <div className="ks-menubar">
      {menus.map((m) => {
        const owner = `menubar:${m.id}`;
        return (
          <div
            key={m.id}
            data-menu-owner={owner}
            className={clsx('ks-menubar-item', openOwner === owner && 'open')}
            onMouseDown={(e) => {
              e.preventDefault();
              if (openOwner === owner) closeMenu();
              else open(m, e.currentTarget);
            }}
            onMouseEnter={(e) => {
              if (openOwner && openOwner.startsWith('menubar:') && openOwner !== owner) open(m, e.currentTarget);
            }}
          >
            {m.label}
          </div>
        );
      })}
    </div>
  );
}

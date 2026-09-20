// Favorites: bookmarks for tabs (table data, designers, queries, tools) and navigator objects.
// Stored as one JSON profile: <profilesDir>/profiles/favorites/favorites.json

import { useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Pencil, Star, Trash2 } from 'lucide-react';
import { create } from 'zustand';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { api } from '../../api/client';
import { designEvent, designRoutine, openTable } from '../../actions/objects';
import { openSavedQuery } from '../../actions/query';
import { Button } from '../../components/ui/controls';
import { alertDialog, Dialog, errorDialog, openDialog, promptDialog } from '../../components/ui/Dialog';
import { toast } from '../../components/Toast';
import { TabIconView } from '../../layout/TabArea';
import { joinPath } from '../../lib/files';
import { parseKey, useNav, type NodeRef } from '../../store/nav';
import { activeTab, OBJECTS_TAB, useTabs, type TabInfo } from '../../store/tabs';
import { getProfile, queriesDir, useWorkspace } from '../../store/workspace';
import './favorites.css';

export interface Favorite {
  id: string;
  name: string;
  icon: string;
  connectionId?: string;
  /** Reopens a tab … */
  tab?: Omit<TabInfo, 'id' | 'dirty'>;
  /** … or a navigator object */
  object?: NodeRef;
  createdAt: number;
}

const KIND = 'favorites';
const FILE = 'favorites';

export const useFavorites = create<{ items: Favorite[]; loaded: boolean }>(() => ({ items: [], loaded: false }));

export async function loadFavorites(): Promise<void> {
  try {
    const data = await api.profiles.load(KIND, FILE);
    useFavorites.setState({ items: Array.isArray(data) ? (data as Favorite[]) : [], loaded: true });
  } catch {
    useFavorites.setState({ items: [], loaded: true });
  }
}

async function save(items: Favorite[]): Promise<void> {
  useFavorites.setState({ items });
  try {
    await api.profiles.save(KIND, FILE, items);
  } catch (e) {
    void errorDialog(e, tr('Favoriten konnten nicht gespeichert werden', 'Could not save the favorites'));
  }
}

/** The active tab, or the object selected in the navigator when the objects tab is active. */
function currentTarget(): Omit<Favorite, 'id' | 'createdAt'> | null {
  const t = activeTab();
  if (t && t.id !== OBJECTS_TAB) {
    const { id: _id, dirty: _dirty, ...tab } = t;
    return { name: t.title, icon: t.icon, connectionId: t.connectionId, tab };
  }
  const key = useNav.getState().selectedKey;
  const ref = key ? parseKey(key) : null;
  if (ref?.kind === 'object' && ref.connectionId && ref.database && ref.name && ref.objectType && ref.objectType !== 'backup') {
    return { name: `${ref.name} @${ref.database}`, icon: ref.objectType, connectionId: ref.connectionId, object: ref };
  }
  return null;
}

const nameRequired = (v: string) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.'));

export async function addFavorite(): Promise<void> {
  const target = currentTarget();
  if (!target) {
    void alertDialog({
      title: tr('Zu Favoriten hinzufügen', 'Add to Favorites'),
      message: tr(
        'Öffne zuerst ein Objekt (Tabelle, Abfrage, Designer …) oder wähle es im Navigationsbereich aus.',
        'Open an object (table, query, designer …) first or select it in the navigation pane.'
      )
    });
    return;
  }
  if (!useFavorites.getState().loaded) await loadFavorites();
  const name = await promptDialog({
    title: tr('Zu Favoriten hinzufügen', 'Add to Favorites'),
    label: tr('Name des Favoriten:', 'Favorite name:'),
    value: target.name,
    okLabel: tr('Hinzufügen', 'Add'),
    validate: nameRequired
  });
  if (name === null) return;
  const fav: Favorite = { ...target, name: name.trim(), id: newId('fav'), createdAt: Date.now() };
  await save([...useFavorites.getState().items, fav]);
  toast(tr('„{n}“ zu den Favoriten hinzugefügt', 'Added “{n}” to Favorites', { n: fav.name }), 'success');
}

export async function openFavorite(f: Favorite): Promise<void> {
  if (f.connectionId && !getProfile(f.connectionId)) {
    void alertDialog({
      title: f.name,
      message: tr('Die Verbindung dieses Favoriten existiert nicht mehr.', 'The connection of this favorite no longer exists.')
    });
    return;
  }
  if (f.connectionId && !(await useWorkspace.getState().openConnection(f.connectionId))) return;
  if (f.tab) {
    useTabs.getState().open({ ...f.tab });
    return;
  }
  const o = f.object;
  if (!o?.connectionId || !o.database || !o.name) return;
  switch (o.objectType) {
    case 'table':
    case 'view':
      openTable(o.connectionId, o.database, o.name, o.objectType === 'view');
      break;
    case 'function':
    case 'procedure':
      designRoutine(o.connectionId, o.database, o.name, o.objectType === 'function' ? 'FUNCTION' : 'PROCEDURE');
      break;
    case 'event':
      designEvent(o.connectionId, o.database, o.name);
      break;
    case 'query':
      openSavedQuery(o.connectionId, o.database, joinPath(queriesDir(useWorkspace.getState().profilesDir, o.connectionId, o.database), `${o.name}.sql`));
      break;
  }
}

function describe(f: Favorite): string {
  const conn = f.connectionId ? (getProfile(f.connectionId)?.name ?? '?') : '';
  const db = (f.tab?.params?.database as string | undefined) ?? f.object?.database;
  return [conn, db].filter(Boolean).join(' / ');
}

export function manageFavorites(): Promise<unknown> {
  return openDialog((close) => <ManageDialog close={() => close()} />);
}

function ManageDialog({ close }: { close: () => void }) {
  const items = useFavorites((s) => s.items);
  const [sel, setSel] = useState<string | null>(items[0]?.id ?? null);
  const idx = items.findIndex((f) => f.id === sel);

  const move = (d: -1 | 1) => {
    const j = idx + d;
    if (idx < 0 || j < 0 || j >= items.length) return;
    const next = [...items];
    [next[idx], next[j]] = [next[j], next[idx]];
    void save(next);
  };

  const rename = async () => {
    const f = items[idx];
    if (!f) return;
    const name = await promptDialog({ title: tr('Favorit umbenennen', 'Rename Favorite'), label: tr('Name des Favoriten:', 'Favorite name:'), value: f.name, validate: nameRequired });
    if (name !== null) void save(useFavorites.getState().items.map((x) => (x.id === f.id ? { ...x, name: name.trim() } : x)));
  };

  const remove = () => {
    const f = items[idx];
    if (!f) return;
    const next = items.filter((x) => x.id !== f.id);
    setSel(next[Math.min(idx, next.length - 1)]?.id ?? null);
    void save(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const j = Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      setSel(items[j]?.id ?? null);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      remove();
    } else if (e.key === 'F2') {
      e.preventDefault();
      void rename();
    }
  };

  return (
    <Dialog
      title={tr('Favoriten verwalten', 'Manage Favorites')}
      icon={<Star size={16} />}
      width={600}
      onClose={close}
      footer={
        <Button variant="primary" onClick={close}>
          {tr('Schließen', 'Close')}
        </Button>
      }
    >
      <div className="ks-fav-manage">
        <div className="ks-fav-list" role="listbox" tabIndex={0} onKeyDown={onKeyDown} data-autofocus>
          {items.map((f) => (
            <div
              key={f.id}
              role="option"
              aria-selected={f.id === sel}
              className={clsx('ks-fav-item', f.id === sel && 'sel')}
              onClick={() => setSel(f.id)}
              onDoubleClick={() => {
                close();
                void openFavorite(f);
              }}
            >
              <TabIconView icon={f.icon} size={15} />
              <span className="name">{f.name}</span>
              <span className="where">{describe(f)}</span>
            </div>
          ))}
          {!items.length && <div className="ks-fav-empty">{tr('Noch keine Favoriten vorhanden.', 'No favorites yet.')}</div>}
        </div>
        <div className="ks-fav-actions">
          <Button icon={<Pencil size={14} />} disabled={idx < 0} onClick={() => void rename()}>
            {tr('Umbenennen', 'Rename')}
          </Button>
          <Button icon={<Trash2 size={14} />} disabled={idx < 0} onClick={remove}>
            {tr('Entfernen', 'Remove')}
          </Button>
          <Button icon={<ArrowUp size={14} />} disabled={idx <= 0} onClick={() => move(-1)}>
            {tr('Nach oben', 'Move Up')}
          </Button>
          <Button icon={<ArrowDown size={14} />} disabled={idx < 0 || idx >= items.length - 1} onClick={() => move(1)}>
            {tr('Nach unten', 'Move Down')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

void loadFavorites();

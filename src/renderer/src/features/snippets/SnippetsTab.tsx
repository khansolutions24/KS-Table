// Code snippets manager: group tree, editor, new / duplicate / save / delete, insert into a new query.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Code, CopyPlus, FilePlus, Folder, Lock, Plus, Save, Trash2 } from 'lucide-react';
import type { Snippet } from '@shared/apis/snippets';
import { tr } from '@shared/i18n';
import { api } from '../../api/client';
import { newQuery } from '../../actions/query';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { toast } from '../../components/Toast';
import { Checkbox, EmptyState, Field, SearchInput, Spinner, TextInput, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { askDialog, confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { showContextMenu } from '../../components/ui/Menu';
import { keyCombo } from '../../lib/shortcuts';
import { currentContext } from '../../store/nav';
import { setCloseGuard, useTabs, type TabProps } from '../../store/tabs';
import './snippets.css';

/** Snippet text with Monaco placeholders replaced by their default text */
export function expandSnippet(sql: string): string {
  let out = sql;
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(/\$\{\d+\|([^,|}]*)[^}]*\|\}/g, '$1')
      .replace(/\$\{\d+:([^{}]*)\}/g, '$1')
      .replace(/\$\{\d+\}/g, '')
      .replace(/\$\d+/g, '');
    if (next === out) break;
    out = next;
  }
  return out.replace(/\\\$/g, '$');
}

const NEW_ID = '__new__';

type Draft = Snippet & { isNew?: boolean };

const fp = (s: Draft | null) => (s ? JSON.stringify([s.name, s.group, s.description, s.sql]) : '');

export default function SnippetsTab({ tab, active }: TabProps) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showBuiltIn, setShowBuiltIn] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnippets(await api.snippets.list());
    } catch (e) {
      void errorDialog(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = !!draft && !draft.builtIn && fp(draft) !== baseline;
  useEffect(() => {
    useTabs.getState().update(tab.id, { dirty });
  }, [dirty, tab.id]);

  const groups = useMemo(() => [...new Set(snippets.map((s) => s.group).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [snippets]);

  const tree = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = snippets.filter(
      (s) => (showBuiltIn || !s.builtIn) && (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q) || s.group.toLowerCase().includes(q))
    );
    const map = new Map<string, Snippet[]>();
    for (const s of list) {
      const g = s.group || tr('(Ohne Gruppe)', '(No group)');
      map.set(g, [...(map.get(g) ?? []), s]);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([group, items]) => ({ group, items: items.sort((a, b) => Number(!!b.builtIn) - Number(!!a.builtIn) || a.name.localeCompare(b.name)) }));
  }, [snippets, search, showBuiltIn]);

  const confirmLeave = async (): Promise<boolean> => {
    if (!dirty) return true;
    const a = await askDialog({
      title: tr('Ungespeicherte Änderungen', 'Unsaved changes'),
      message: tr('Änderungen am Snippet „{n}“ speichern?', 'Save changes to the snippet "{n}"?', { n: draft?.name || tr('Unbenannt', 'Untitled') }),
      yesLabel: tr('Speichern', 'Save'),
      noLabel: tr('Verwerfen', 'Discard')
    });
    if (a === 'cancel') return false;
    if (a === 'no') return true;
    return saveRef.current();
  };

  const select = async (s: Snippet) => {
    if (draft?.id === s.id) return;
    if (!(await confirmLeave())) return;
    setDraft({ ...s });
    setBaseline(fp(s));
  };

  const create = async (base?: Snippet) => {
    if (!(await confirmLeave())) return;
    const d: Draft = base
      ? { ...base, id: NEW_ID, name: `${base.name} (${tr('Kopie', 'copy')})`, builtIn: false, isNew: true }
      : { id: NEW_ID, name: '', group: draft?.group ?? groups[0] ?? '', description: '', sql: '', builtIn: false, isNew: true };
    setDraft(d);
    setBaseline(base ? '' : fp(d));
  };

  const save = async (): Promise<boolean> => {
    if (!draft || draft.builtIn || busy) return false;
    if (!draft.name.trim()) {
      toast(tr('Bitte einen Namen eingeben.', 'Please enter a name.'), 'error');
      return false;
    }
    setBusy(true);
    try {
      const saved = await api.snippets.save({
        id: draft.isNew ? '' : draft.id,
        name: draft.name.trim(),
        group: draft.group.trim(),
        description: draft.description,
        sql: draft.sql
      });
      await load();
      setDraft({ ...saved });
      setBaseline(fp(saved));
      toast(tr('Snippet gespeichert', 'Snippet saved'), 'success');
      return true;
    } catch (e) {
      void errorDialog(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const remove = async (s: Snippet) => {
    if (s.builtIn) return;
    const ok = await confirmDialog({
      title: tr('Snippet löschen', 'Delete snippet'),
      message: tr('Soll das Snippet „{n}“ wirklich gelöscht werden?', 'Do you really want to delete the snippet "{n}"?', { n: s.name }),
      okLabel: tr('Löschen', 'Delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await api.snippets.remove(s.id);
      if (draft?.id === s.id) {
        setDraft(null);
        setBaseline('');
      }
      await load();
    } catch (e) {
      void errorDialog(e);
    }
  };

  const insertIntoQuery = (s: Draft) => {
    const ctx = currentContext();
    if (!ctx.connectionId) {
      toast(tr('Bitte zuerst im Navigator eine Verbindung auswählen.', 'Please select a connection in the navigator first.'));
      return;
    }
    newQuery(ctx.connectionId, ctx.database ?? null, expandSnippet(s.sql), s.name ? `${s.name} – ${tr('Abfrage', 'Query')}` : undefined);
  };

  useEffect(() => {
    setCloseGuard(tab.id, async () => {
      if (!dirtyRef.current) return true;
      const a = await askDialog({
        title: tr('Ungespeicherte Änderungen', 'Unsaved changes'),
        message: tr('Geändertes Snippet speichern?', 'Save the changed snippet?'),
        yesLabel: tr('Speichern', 'Save'),
        noLabel: tr('Verwerfen', 'Discard')
      });
      if (a === 'cancel') return false;
      if (a === 'no') return true;
      return saveRef.current();
    });
    return () => setCloseGuard(tab.id, null);
  }, [tab.id]);

  useEffect(() => {
    if (!active) return;
    const onCmd = (e: Event) => {
      if ((e as CustomEvent).detail === 'save') void saveRef.current();
    };
    window.addEventListener('ks-command', onCmd);
    return () => window.removeEventListener('ks-command', onCmd);
  }, [active]);

  const readOnly = !!draft?.builtIn;
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div
      className="ks-editor-layout"
      onKeyDown={(e) => {
        if (keyCombo(e) === 'Ctrl+S') {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }
      }}
    >
      <Toolbar>
        <ToolbarButton icon={<Plus size={15} />} label={tr('Neues Snippet', 'New Snippet')} onClick={() => void create()} />
        <ToolbarButton icon={<CopyPlus size={15} />} label={tr('Duplizieren', 'Duplicate')} disabled={!draft || draft.isNew} onClick={() => draft && void create(draft)} />
        <ToolbarButton icon={busy ? <Spinner size={14} /> : <Save size={15} />} label={tr('Speichern', 'Save')} disabled={!draft || readOnly || (!dirty && !draft.isNew) || busy} onClick={() => void save()} />
        <ToolbarButton icon={<Trash2 size={15} />} label={tr('Löschen', 'Delete')} disabled={!draft || readOnly || draft.isNew} onClick={() => draft && void remove(draft)} />
        <ToolbarSep />
        <ToolbarButton icon={<FilePlus size={15} />} label={tr('In neue Abfrage einfügen', 'Insert into New Query')} disabled={!draft?.sql} onClick={() => draft && insertIntoQuery(draft)} />
      </Toolbar>
      <div className="ks-snippets">
        <div className="ks-snippets-side">
          <div className="ks-snippets-side-head">
            <SearchInput value={search} onChange={setSearch} placeholder={tr('Snippets suchen', 'Search snippets')} />
            <Checkbox checked={showBuiltIn} onChange={setShowBuiltIn} label={tr('Mitgelieferte Snippets anzeigen', 'Show built-in snippets')} />
          </div>
          <div className="ks-snippets-tree">
            {loading && !snippets.length && <Spinner />}
            {tree.map(({ group, items }) => {
              const open = !collapsed.has(group) || !!search;
              return (
                <div key={group}>
                  <div
                    className="ks-snippets-group"
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c);
                        if (n.has(group)) n.delete(group);
                        else n.add(group);
                        return n;
                      })
                    }
                  >
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Folder size={14} className="ks-snippets-folder" />
                    <span className="ellipsis grow">{group}</span>
                    <span className="faint">{items.length}</span>
                  </div>
                  {open &&
                    items.map((s) => (
                      <div
                        key={s.id}
                        className={clsx('ks-snippets-item', draft?.id === s.id && 'selected')}
                        title={s.description || s.name}
                        onClick={() => void select(s)}
                        onDoubleClick={() => insertIntoQuery(s)}
                        onContextMenu={(e) =>
                          showContextMenu(e, [
                            { label: tr('In neue Abfrage einfügen', 'Insert into New Query'), icon: <FilePlus size={14} />, onClick: () => insertIntoQuery(s) },
                            { label: tr('Duplizieren', 'Duplicate'), icon: <CopyPlus size={14} />, onClick: () => void create(s) },
                            { label: tr('Löschen', 'Delete'), icon: <Trash2 size={14} />, danger: true, disabled: !!s.builtIn, onClick: () => void remove(s) }
                          ])
                        }
                      >
                        {s.builtIn ? <Lock size={12} className="faint" /> : <Code size={13} className="ks-snippets-code" />}
                        <span className="ellipsis grow">{s.name}</span>
                      </div>
                    ))}
                </div>
              );
            })}
            {!loading && !tree.length && <div className="faint" style={{ padding: 10 }}>{search ? tr('Keine Treffer', 'No matches') : tr('Keine Snippets', 'No snippets')}</div>}
          </div>
        </div>
        <div className="ks-snippets-editor">
          {!draft ? (
            <EmptyState icon={<Code size={40} />} title={tr('Kein Snippet ausgewählt', 'No snippet selected')}>
              {tr('Wählen Sie links ein Snippet aus oder legen Sie ein neues an.', 'Select a snippet on the left or create a new one.')}
            </EmptyState>
          ) : (
            <>
              <div className="ks-form ks-snippets-form">
                {readOnly && (
                  <div className="ks-snippets-readonly">
                    <Lock size={13} />
                    {tr('Mitgeliefertes Snippet – schreibgeschützt. Mit „Duplizieren“ eine bearbeitbare Kopie anlegen.', 'Built-in snippet – read-only. Use "Duplicate" to create an editable copy.')}
                  </div>
                )}
                <Field label={tr('Name', 'Name')} labelWidth={110}>
                  <TextInput data-autofocus value={draft.name} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <Field label={tr('Gruppe', 'Group')} labelWidth={110}>
                  <TextInput value={draft.group} disabled={readOnly} list={`ks-snippet-groups-${tab.id}`} placeholder={tr('Vorhandene Gruppe wählen oder neue eingeben', 'Choose an existing group or type a new one')} onChange={(e) => set({ group: e.target.value })} />
                  <datalist id={`ks-snippet-groups-${tab.id}`}>
                    {groups.map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                </Field>
                <Field label={tr('Beschreibung', 'Description')} labelWidth={110}>
                  <TextInput value={draft.description} disabled={readOnly} onChange={(e) => set({ description: e.target.value })} />
                </Field>
              </div>
              <div className="ks-snippets-code-wrap">
                <SqlEditor key={draft.id} value={draft.sql} readOnly={readOnly} onChange={(sql) => set({ sql })} completion={null} />
              </div>
              <div className="ks-snippets-hint">
                {tr(
                  'Platzhalter: ${1:text} springt beim Einfügen im Editor mit Tab von Feld zu Feld; ${2|a,b|} bietet eine Auswahl, $0 markiert die Endposition. Gleiche Nummern werden gemeinsam bearbeitet.',
                  'Placeholders: ${1:text} lets you tab from field to field after inserting in the editor; ${2|a,b|} offers a choice, $0 marks the final position. Equal numbers are edited together.'
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="ks-statusline">
        <span>{tr('{n} Snippets', '{n} snippets', { n: snippets.length })}</span>
        <span>{tr('{n} eigene', '{n} custom', { n: snippets.filter((s) => !s.builtIn).length })}</span>
        {draft && <span>{readOnly ? tr('Schreibgeschützt', 'Read-only') : dirty || draft.isNew ? tr('Nicht gespeichert', 'Not saved') : tr('Gespeichert', 'Saved')}</span>}
      </div>
    </div>
  );
}

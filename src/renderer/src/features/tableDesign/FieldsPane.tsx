// Fields tab of the table designer: editable field grid, find bar and property panel of the selected field.

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  ArrowDown,
  ArrowUp,
  BetweenHorizontalStart,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  GripVertical,
  KeyRound,
  Plus,
  Trash2,
  X
} from 'lucide-react';
import { newField } from '@shared/defaults';
import { tr } from '@shared/i18n';
import type { FieldDef } from '@shared/types';
import { toast } from '../../components/Toast';
import { Checkbox, Field, IconButton, RadioGroup, SearchInput, Select, TextInput, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { showContextMenu, showMenuBelow, SEP, type MenuItem } from '../../components/ui/Menu';
import { keyCombo } from '../../lib/shortcuts';
import {
  acceptsEmptyString,
  applyTypeText,
  currentTimestampValue,
  deleteFields,
  fieldsFromClipboard,
  fieldsToClipboard,
  insertFieldAt,
  isCurrentTimestampDefault,
  isTemporalOnUpdate,
  moveFieldTo,
  normalizeField,
  renameFieldInExpressions,
  togglePrimaryKey,
  triggersMentioning,
  TYPE_GROUPS,
  typeInfo,
  typesFor
} from './model';
import { charsetOptions, collationOptions } from './serverLists';
import type { PaneProps } from './types';

const LW = 150;

interface Props extends PaneProps {
  selected: string | null;
  onSelect: (id: string | null) => void;
  findOpen: boolean;
  onFindClose: () => void;
}

export function FieldsPane(p: Props) {
  const { edit, update, selected, onSelect } = p;
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const focusName = useRef<string | null>(null);
  const nameAtFocus = useRef<{ id: string; name: string } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const field = edit.fields.find((f) => f.id === selected) ?? null;
  const index = field ? edit.fields.indexOf(field) : -1;

  useEffect(() => {
    if (!focusName.current) return;
    const el = wrap.current?.querySelector<HTMLInputElement>(`[data-field-name="${focusName.current}"]`);
    focusName.current = null;
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  });

  const setField = (id: string, patch: Partial<FieldDef>) =>
    update((e) => ({ ...e, fields: e.fields.map((x) => (x.id === id ? normalizeField({ ...x, ...patch }) : x)) }));

  const add = (at: number) => {
    const f = newField({ name: '' });
    update((e) => insertFieldAt(e, at, f));
    onSelect(f.id);
    focusName.current = f.id;
  };
  const remove = (id: string) => {
    const i = edit.fields.findIndex((f) => f.id === id);
    update((e) => deleteFields(e, new Set([id])));
    const next = edit.fields[i + 1] ?? edit.fields[i - 1];
    onSelect(next && next.id !== id ? next.id : null);
  };
  const move = (id: string, dir: -1 | 1) => {
    const i = edit.fields.findIndex((f) => f.id === id);
    if (i < 0 || i + dir < 0 || i + dir >= edit.fields.length) return;
    update((e) => moveFieldTo(e, id, i + dir));
    requestAnimationFrame(() => wrap.current?.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  const copy = (f: FieldDef) => {
    void navigator.clipboard.writeText(fieldsToClipboard([f])).then(() => toast(tr('Felddefinition kopiert', 'Field definition copied')));
  };
  const paste = async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = '';
    }
    const list = fieldsFromClipboard(text, edit.fields.map((f) => f.name));
    if (!list?.length) {
      toast(tr('Die Zwischenablage enthält keine Felddefinitionen.', 'The clipboard contains no field definitions.'), 'error');
      return;
    }
    const at = index >= 0 ? index + 1 : edit.fields.length;
    update((e) => {
      let n = e;
      list.forEach((f, k) => (n = insertFieldAt(n, at + k, f)));
      return n;
    });
    onSelect(list[0].id);
  };

  const commitRename = (id: string) => {
    const s = nameAtFocus.current;
    nameAtFocus.current = null;
    const cur = edit.fields.find((f) => f.id === id);
    if (!s || s.id !== id || !cur || !s.name || s.name === cur.name || !cur.name) return;
    update((e) => renameFieldInExpressions(e, s.name, cur.name));
    const trig = triggersMentioning(edit, s.name);
    if (trig.length) {
      toast(
        tr('Trigger verwenden noch „{o}“: {t}', 'Triggers still use "{o}": {t}', { o: s.name, t: trig.join(', ') }),
        'info',
        6000
      );
    }
  };

  // find
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? edit.fields.filter((f) => f.name.toLowerCase().includes(q)).map((f) => f.id) : [];
  }, [query, edit.fields]);
  const findStep = (dir: 1 | -1) => {
    if (!matches.length) return;
    const cur = selected ? matches.indexOf(selected) : -1;
    const next = matches[(cur + dir + matches.length) % matches.length] ?? matches[0];
    onSelect(next);
    wrap.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const combo = keyCombo(e);
    if (!selected) return;
    if (combo === 'Ctrl+ArrowUp' || combo === 'Ctrl+ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      move(selected, combo === 'Ctrl+ArrowUp' ? -1 : 1);
    } else if (combo === 'ArrowUp' || combo === 'ArrowDown') {
      const t = e.target as HTMLElement;
      if (t.tagName === 'SELECT') return;
      const i = edit.fields.findIndex((f) => f.id === selected);
      const next = edit.fields[i + (combo === 'ArrowUp' ? -1 : 1)];
      if (!next) return;
      e.preventDefault();
      onSelect(next.id);
      const col = t.closest('td')?.cellIndex;
      requestAnimationFrame(() => {
        const row = wrap.current?.querySelector<HTMLTableRowElement>(`[data-row="${next.id}"]`);
        row?.scrollIntoView({ block: 'nearest' });
        const target = col !== undefined ? row?.cells[col]?.querySelector<HTMLElement>('input, button, select') : null;
        target?.focus();
      });
    } else if (combo === 'Ctrl+Delete') {
      e.preventDefault();
      remove(selected);
    }
  };

  const rowMenu = (e: React.MouseEvent, f: FieldDef) => {
    onSelect(f.id);
    const i = edit.fields.indexOf(f);
    const items: MenuItem[] = [
      { label: tr('Feld hinzufügen', 'Add Field'), icon: <Plus size={14} />, onClick: () => add(edit.fields.length) },
      { label: tr('Feld einfügen', 'Insert Field'), icon: <BetweenHorizontalStart size={14} />, onClick: () => add(i) },
      { label: tr('Feld löschen', 'Delete Field'), icon: <Trash2 size={14} />, shortcut: 'Ctrl+Del', onClick: () => remove(f.id) },
      SEP,
      { label: tr('Umbenennen', 'Rename'), onClick: () => wrap.current?.querySelector<HTMLInputElement>(`[data-field-name="${f.id}"]`)?.select() },
      { label: tr('Primärschlüssel', 'Primary Key'), icon: <KeyRound size={14} />, checked: edit.primaryKey.includes(f.id), onClick: () => update((x) => togglePrimaryKey(x, f.id)) },
      SEP,
      { label: tr('Nach oben', 'Move Up'), icon: <ArrowUp size={14} />, shortcut: 'Ctrl+↑', disabled: i === 0, onClick: () => move(f.id, -1) },
      { label: tr('Nach unten', 'Move Down'), icon: <ArrowDown size={14} />, shortcut: 'Ctrl+↓', disabled: i === edit.fields.length - 1, onClick: () => move(f.id, 1) },
      SEP,
      { label: tr('Felddefinition kopieren', 'Copy Field Definition'), icon: <Copy size={14} />, onClick: () => copy(f) },
      { label: tr('Felddefinition einfügen', 'Paste Field Definition'), icon: <ClipboardPaste size={14} />, onClick: () => void paste() }
    ];
    showContextMenu(e, items);
  };

  const dropOn = () => {
    if (!drag || !drop || drag === drop.id) return;
    const from = edit.fields.findIndex((f) => f.id === drag);
    let to = edit.fields.findIndex((f) => f.id === drop.id) + (drop.after ? 1 : 0);
    if (from < to) to--;
    update((e) => moveFieldTo(e, drag, to));
  };

  return (
    <div className="ks-td-pane">
      <Toolbar>
        <ToolbarButton icon={<Plus size={15} />} label={tr('Feld hinzufügen', 'Add Field')} onClick={() => add(edit.fields.length)} />
        <ToolbarButton icon={<BetweenHorizontalStart size={15} />} label={tr('Feld einfügen', 'Insert Field')} onClick={() => add(index >= 0 ? index : 0)} />
        <ToolbarButton icon={<Trash2 size={15} />} label={tr('Feld löschen', 'Delete Field')} disabled={!field} onClick={() => field && remove(field.id)} />
        <ToolbarSep />
        <ToolbarButton
          icon={<KeyRound size={15} />}
          label={tr('Primärschlüssel', 'Primary Key')}
          active={!!field && edit.primaryKey.includes(field.id)}
          disabled={!field}
          onClick={() => field && update((e) => togglePrimaryKey(e, field.id))}
        />
        <ToolbarSep />
        <ToolbarButton icon={<ArrowUp size={15} />} label={tr('Nach oben', 'Move Up')} disabled={index <= 0} onClick={() => field && move(field.id, -1)} />
        <ToolbarButton
          icon={<ArrowDown size={15} />}
          label={tr('Nach unten', 'Move Down')}
          disabled={index < 0 || index >= edit.fields.length - 1}
          onClick={() => field && move(field.id, 1)}
        />
      </Toolbar>
      {p.findOpen && (
        <div className="ks-td-find">
          <SearchInput
            value={query}
            onChange={setQuery}
            autoFocus
            placeholder={tr('Feldname suchen', 'Find field name')}
            onKeyDown={(e) => {
              const c = keyCombo(e);
              if (c === 'Enter' || c === 'F3') {
                e.preventDefault();
                findStep(1);
              } else if (c === 'Shift+Enter' || c === 'Shift+F3') {
                e.preventDefault();
                findStep(-1);
              } else if (c === 'Escape') {
                e.stopPropagation();
                p.onFindClose();
              }
            }}
          />
          <span className="ks-td-find-count">
            {query.trim() ? tr('{n} Treffer', '{n} matches', { n: matches.length }) : ''}
          </span>
          <IconButton icon={<ChevronUp size={14} />} title={tr('Vorheriger (Umschalt+F3)', 'Previous (Shift+F3)')} disabled={!matches.length} onClick={() => findStep(-1)} />
          <IconButton icon={<ChevronDown size={14} />} title={tr('Nächster (F3)', 'Next (F3)')} disabled={!matches.length} onClick={() => findStep(1)} />
          <IconButton icon={<X size={14} />} title={tr('Schließen', 'Close')} onClick={p.onFindClose} />
        </div>
      )}
      <Group orientation="vertical" className="ks-td-split">
        <Panel id="grid" defaultSize="62%" minSize="80px">
          <div className="ks-dsg-grid-wrap" ref={wrap} onKeyDown={onGridKey}>
            <datalist id="ks-td-types">
              {typesFor(p.server).map((t) => (
                <option key={t.name} value={t.name} />
              ))}
            </datalist>
            <table className="ks-table ks-dsg-grid ks-td-grid">
              <thead>
                <tr>
                  <th />
                  <th className="num">#</th>
                  <th style={{ minWidth: 180 }}>{tr('Name', 'Name')}</th>
                  <th style={{ minWidth: 150 }}>{tr('Typ', 'Type')}</th>
                  <th style={{ width: 70 }}>{tr('Länge', 'Length')}</th>
                  <th style={{ width: 70 }}>{tr('Dezimalstellen', 'Decimals')}</th>
                  <th className="ks-dsg-center">{tr('Nicht NULL', 'Not Null')}</th>
                  <th className="ks-dsg-center">{tr('Virtuell', 'Virtual')}</th>
                  <th className="ks-dsg-center">{tr('Schlüssel', 'Key')}</th>
                  <th style={{ minWidth: 220 }}>{tr('Kommentar', 'Comment')}</th>
                </tr>
              </thead>
              <tbody>
                {edit.fields.map((f, i) => {
                  const info = typeInfo(f.type);
                  const pk = edit.primaryKey.indexOf(f.id);
                  return (
                    <tr
                      key={f.id}
                      data-row={f.id}
                      className={clsx(
                        selected === f.id && 'selected',
                        p.problems.has(f.id) && 'problem',
                        drag === f.id && 'dragging',
                        drop?.id === f.id && drag && drag !== f.id && (drop.after ? 'drop-after' : 'drop-before'),
                        matches.includes(f.id) && 'match'
                      )}
                      onMouseDown={() => onSelect(f.id)}
                      onFocus={() => selected !== f.id && onSelect(f.id)}
                      onContextMenu={(e) => rowMenu(e, f)}
                      onDragOver={(e) => {
                        if (!drag) return;
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        setDrop({ id: f.id, after: e.clientY > r.top + r.height / 2 });
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        dropOn();
                        setDrag(null);
                        setDrop(null);
                      }}
                    >
                      <td
                        className="handle"
                        draggable
                        title={tr('Ziehen zum Verschieben', 'Drag to move')}
                        onDragStart={(e) => {
                          setDrag(f.id);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', f.name);
                        }}
                        onDragEnd={() => {
                          setDrag(null);
                          setDrop(null);
                        }}
                      >
                        <GripVertical size={12} />
                      </td>
                      <td className="num">{i + 1}</td>
                      <td>
                        <input
                          className="ks-dsg-cell"
                          data-field-name={f.id}
                          value={f.name}
                          spellCheck={false}
                          placeholder={tr('Feldname', 'field name')}
                          onFocus={() => (nameAtFocus.current = { id: f.id, name: f.name })}
                          onChange={(e) => setField(f.id, { name: e.target.value })}
                          onBlur={() => commitRename(f.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                        />
                      </td>
                      <td>
                        <TypeCell
                          field={f}
                          onCommit={(text) => update((e) => ({ ...e, fields: e.fields.map((x) => (x.id === f.id ? applyTypeText(x, text) : x)) }))}
                          onMenu={(el) =>
                            showMenuBelow(
                              el,
                              TYPE_GROUPS.map((g) => ({
                                label: g.label(),
                                submenu: typesFor(p.server)
                                  .filter((t) => t.group === g.id)
                                  .map((t) => ({
                                    label: t.name,
                                    checked: t.name === f.type.toUpperCase(),
                                    onClick: () => update((e) => ({ ...e, fields: e.fields.map((x) => (x.id === f.id ? applyTypeText(x, t.name) : x)) }))
                                  }))
                              }))
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="ks-dsg-cell"
                          value={info.fsp || info.length === 'no' ? '' : f.length}
                          disabled={!!info.fsp || info.length === 'no'}
                          onChange={(e) => setField(f.id, { length: e.target.value.replace(/\D/g, '') })}
                        />
                      </td>
                      <td>
                        <input
                          className="ks-dsg-cell"
                          value={info.fsp ? f.length : info.decimals ? f.decimals : ''}
                          disabled={!info.fsp && !info.decimals}
                          title={info.fsp ? tr('Sekundenbruchteile (0–6)', 'Fractional seconds (0–6)') : undefined}
                          onChange={(e) => {
                            const v = e.target.value.replace(/\D/g, '');
                            setField(f.id, info.fsp ? { length: v } : { decimals: v });
                          }}
                        />
                      </td>
                      <td className="ks-dsg-center">
                        <input
                          type="checkbox"
                          checked={f.notNull}
                          disabled={pk >= 0}
                          title={pk >= 0 ? tr('Felder des Primärschlüssels sind immer NOT NULL', 'Primary key fields are always NOT NULL') : undefined}
                          onChange={(e) => setField(f.id, { notNull: e.target.checked })}
                        />
                      </td>
                      <td className="ks-dsg-center">
                        <input
                          type="checkbox"
                          checked={f.generated}
                          onChange={(e) =>
                            setField(f.id, e.target.checked ? { generated: true, autoIncrement: false, defaultKind: 'none', defaultValue: '', onUpdateCurrentTimestamp: false } : { generated: false })
                          }
                        />
                      </td>
                      <td className="ks-dsg-center">
                        <button
                          type="button"
                          className={clsx('ks-td-key', pk >= 0 && 'on')}
                          title={tr('Primärschlüssel umschalten', 'Toggle primary key')}
                          onClick={() => update((e) => togglePrimaryKey(e, f.id))}
                        >
                          {pk >= 0 && <KeyRound size={13} />}
                          {pk >= 0 && edit.primaryKey.length > 1 && <span className="ks-td-key-order">{pk + 1}</span>}
                        </button>
                      </td>
                      <td>
                        <input className="ks-dsg-cell" value={f.comment} onChange={(e) => setField(f.id, { comment: e.target.value })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!edit.fields.length && <div className="ks-dsg-grid-empty">{tr('Noch keine Felder – „Feld hinzufügen“ legt eines an.', 'No fields yet – "Add Field" creates one.')}</div>}
          </div>
        </Panel>
        <Separator className="ks-dsg-sep-v" />
        <Panel id="props" defaultSize="38%" minSize="60px">
          {field ? (
            <FieldProperties {...p} field={field} setField={(patch) => setField(field.id, patch)} />
          ) : (
            <div className="ks-td-props faint">{tr('Kein Feld ausgewählt', 'No field selected')}</div>
          )}
        </Panel>
      </Group>
    </div>
  );
}

function TypeCell({ field, onCommit, onMenu }: { field: FieldDef; onCommit: (text: string) => void; onMenu: (el: HTMLElement) => void }) {
  const [text, setText] = useState(field.type);
  useEffect(() => setText(field.type), [field.type]);
  const commit = () => {
    if (text.trim() && text.trim().toUpperCase() !== field.type.toUpperCase()) onCommit(text);
    else setText(field.type);
  };
  return (
    <div className="ks-td-type">
      <input
        className="ks-dsg-cell"
        list="ks-td-types"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setText(field.type);
        }}
      />
      <button type="button" className="ks-td-type-btn" tabIndex={-1} title={tr('Datentyp wählen', 'Choose data type')} onClick={(e) => onMenu(e.currentTarget.parentElement!)}>
        <ChevronDown size={13} />
      </button>
    </div>
  );
}

type DefaultChoice = FieldDef['defaultKind'] | 'ct';

function FieldProperties(p: Props & { field: FieldDef; setField: (patch: Partial<FieldDef>) => void }) {
  const { field: f, setField, features, lists } = p;
  const t = f.type.toUpperCase();
  const info = typeInfo(t);
  const temporal = isTemporalOnUpdate(t);
  const choice: DefaultChoice = isCurrentTimestampDefault(f) ? 'ct' : f.defaultKind;
  const defaultOptions: { value: DefaultChoice; label: string }[] = [
    { value: 'none', label: tr('(kein Standardwert)', '(no default)') },
    ...(!f.notNull || choice === 'null' ? [{ value: 'null' as const, label: 'NULL' }] : []),
    ...(acceptsEmptyString(t) || choice === 'empty' ? [{ value: 'empty' as const, label: tr('Leere Zeichenkette', 'Empty string') }] : []),
    ...(temporal || choice === 'ct' ? [{ value: 'ct' as const, label: 'CURRENT_TIMESTAMP' }] : []),
    { value: 'value', label: tr('Wert', 'Value') },
    { value: 'expression', label: tr('Ausdruck', 'Expression') }
  ];
  const setDefault = (c: DefaultChoice) => {
    if (c === 'ct') setField({ defaultKind: 'expression', defaultValue: currentTimestampValue(f) });
    else if (c === 'value' || c === 'expression') setField({ defaultKind: c, defaultValue: choice === 'value' || choice === 'expression' ? f.defaultValue : '' });
    else setField({ defaultKind: c, defaultValue: '' });
  };
  const noDefault = f.generated || f.autoIncrement;

  return (
    <div className="ks-td-props">
      <div className="ks-td-props-title">
        {f.name || tr('(ohne Name)', '(unnamed)')} <span className="faint">{t}</span>
      </div>
      <div className="ks-td-props-grid">
        <div className="ks-form">
          {f.generated ? (
            <>
              <Field label={tr('Ausdruck', 'Expression')} labelWidth={LW}>
                <TextInput className="mono" value={f.generatedExpr} placeholder="`price` * 1.19" onChange={(e) => setField({ generatedExpr: e.target.value })} />
              </Field>
              <Field label={tr('Speicherung', 'Storage')} labelWidth={LW}>
                <RadioGroup
                  inline
                  value={f.generatedStored ? 'STORED' : 'VIRTUAL'}
                  onChange={(v) => setField({ generatedStored: v === 'STORED' })}
                  options={[
                    { value: 'VIRTUAL', label: tr('VIRTUAL (berechnet beim Lesen)', 'VIRTUAL (computed on read)') },
                    { value: 'STORED', label: tr('STORED (gespeichert)', 'STORED (stored)') }
                  ]}
                />
              </Field>
            </>
          ) : (
            <Field label={tr('Standardwert', 'Default')} labelWidth={LW}>
              <div className="ks-td-default">
                <Select value={choice} disabled={noDefault} onChange={setDefault} options={defaultOptions} />
                {(choice === 'value' || choice === 'expression') && (
                  <TextInput
                    className={choice === 'expression' ? 'mono' : undefined}
                    value={f.defaultValue}
                    disabled={noDefault}
                    placeholder={choice === 'expression' ? "(uuid())" : ''}
                    onChange={(e) => setField({ defaultValue: e.target.value })}
                  />
                )}
              </div>
            </Field>
          )}
          {info.charset && (
            <>
              <Field label={tr('Zeichensatz', 'Character set')} labelWidth={LW}>
                <Select
                  value={f.charset}
                  onChange={(v) => setField({ charset: v, collation: '' })}
                  options={charsetOptions(lists, f.charset, tr('(Tabellenstandard)', '(table default)'))}
                />
              </Field>
              <Field label={tr('Sortierung', 'Collation')} labelWidth={LW}>
                <Select
                  value={f.collation}
                  onChange={(v) => setField({ collation: v, charset: f.charset || lists.collations.find((c) => c.collation === v)?.charset || '' })}
                  options={collationOptions(lists, f.charset || p.edit.options.charset, f.collation, tr('(Standard)', '(default)'))}
                />
              </Field>
            </>
          )}
          {info.group === 'spatial' && features.srid && (
            <Field label="SRID" labelWidth={LW} hint={tr('z. B. 4326 für WGS 84; leer = keine', 'e.g. 4326 for WGS 84; empty = none')}>
              <TextInput value={f.srid} style={{ width: 120 }} onChange={(e) => setField({ srid: e.target.value.replace(/\D/g, '') })} />
            </Field>
          )}
          {(t === 'ENUM' || t === 'SET') && <ValuesEditor values={f.values} onChange={(values) => setField({ values })} />}
        </div>
        <div className="ks-td-checks">
          {info.integer && (
            <Checkbox
              checked={f.autoIncrement}
              disabled={f.generated}
              label="Auto Increment"
              onChange={(v) => setField(v ? { autoIncrement: true, defaultKind: 'none', defaultValue: '', notNull: true } : { autoIncrement: false })}
            />
          )}
          {info.numeric && <Checkbox checked={f.unsigned} label={tr('Vorzeichenlos (UNSIGNED)', 'Unsigned')} onChange={(v) => setField({ unsigned: v, zerofill: v && f.zerofill })} />}
          {info.numeric && <Checkbox checked={f.zerofill} label={tr('Mit Nullen auffüllen (ZEROFILL)', 'Zerofill')} onChange={(v) => setField({ zerofill: v })} />}
          {temporal && (
            <Checkbox
              checked={f.onUpdateCurrentTimestamp}
              disabled={f.generated}
              label={tr('Bei Aktualisierung CURRENT_TIMESTAMP', 'On update CURRENT_TIMESTAMP')}
              onChange={(v) => setField({ onUpdateCurrentTimestamp: v })}
            />
          )}
          {info.charset && features.binaryAttr && t !== 'ENUM' && t !== 'SET' && (
            <Checkbox checked={f.binary} label={tr('Binär (BINARY)', 'Binary')} onChange={(v) => setField({ binary: v })} />
          )}
          {(features.invisibleColumns || f.invisible) && (
            <Checkbox checked={f.invisible} label={tr('Unsichtbar (INVISIBLE)', 'Invisible')} onChange={(v) => setField({ invisible: v })} />
          )}
        </div>
      </div>
    </div>
  );
}

function ValuesEditor({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const [sel, setSel] = useState(0);
  const set = (i: number, v: string) => onChange(values.map((x, k) => (k === i ? v : x)));
  const move = (dir: -1 | 1) => {
    const j = sel + dir;
    if (sel < 0 || j < 0 || j >= values.length) return;
    const n = [...values];
    [n[sel], n[j]] = [n[j], n[sel]];
    onChange(n);
    setSel(j);
  };
  return (
    <Field label={tr('Werte', 'Values')} labelWidth={LW} alignTop>
      <div className="ks-td-values">
        <div className="ks-dsg-list">
          {values.map((v, i) => (
            <div key={i} className={clsx('ks-dsg-list-item', sel === i && 'selected')} onMouseDown={() => setSel(i)}>
              <span className="faint">{i + 1}.</span>
              <input value={v} spellCheck={false} onFocus={() => setSel(i)} onChange={(e) => set(i, e.target.value)} />
            </div>
          ))}
          {!values.length && <div className="ks-dsg-list-item faint">{tr('Keine Werte', 'No values')}</div>}
        </div>
        <div className="ks-dsg-list-buttons">
          <IconButton
            icon={<Plus size={14} />}
            title={tr('Wert hinzufügen', 'Add value')}
            onClick={() => {
              onChange([...values, '']);
              setSel(values.length);
            }}
          />
          <IconButton
            icon={<Trash2 size={14} />}
            title={tr('Wert entfernen', 'Remove value')}
            disabled={sel < 0 || sel >= values.length}
            onClick={() => {
              onChange(values.filter((_, k) => k !== sel));
              setSel(Math.max(0, sel - 1));
            }}
          />
          <IconButton icon={<ArrowUp size={14} />} title={tr('Nach oben', 'Move up')} disabled={sel <= 0} onClick={() => move(-1)} />
          <IconButton icon={<ArrowDown size={14} />} title={tr('Nach unten', 'Move down')} disabled={sel >= values.length - 1} onClick={() => move(1)} />
        </div>
      </div>
    </Field>
  );
}

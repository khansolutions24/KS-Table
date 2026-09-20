// Dialogs of the table viewer: foreign key data selection, date/time picker, columns, find & replace.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { CellValue, FetchResult } from '@shared/types';
import { quoteId, quoteString, escapeLike } from '@shared/sql/quote';
import { api, errorMessage } from '../../api/client';
import { columnFromMeta, columnFromResult, type GridColumnDef } from '../../components/grid/cellFormat';
import { DataGrid, type DataGridHandle } from '../../components/grid/DataGrid';
import { Dialog, openDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, Field, IconButton, SearchInput, Select, Spinner, TextInput } from '../../components/ui/controls';
import type { FkRef } from './useTableData';

// ───────────── Foreign key data selection ─────────────

function FkPicker({ sessionId, fk, current, close }: { sessionId: string; fk: FkRef; current: CellValue; close: (v?: CellValue) => void }) {
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState<FetchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [row, setRow] = useState<number | null>(null);
  const grid = useRef<DataGridHandle>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      let where: string | undefined;
      if (applied.trim() && data) {
        const cols = data.columns.filter((c) => !c.binary).map((c) => quoteId(c.name));
        where = `CONCAT_WS(' ', ${cols.join(', ')}) LIKE ${quoteString(`%${escapeLike(applied.trim())}%`)}`;
      }
      const res = await api.data.fetch(sessionId, { schema: fk.refSchema, table: fk.refTable, where, offset: 0, limit: showAll ? null : 1000 });
      setData(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, showAll]);

  const columns: GridColumnDef[] = useMemo(() => {
    if (!data) return [];
    const byName = new Map(data.meta.map((m) => [m.name, m]));
    return data.columns.map((c) => {
      const m = byName.get(c.name);
      return { ...(m ? columnFromMeta(m) : columnFromResult(c)), id: c.name, title: c.name };
    });
  }, [data]);
  const refIdx = data ? data.columns.findIndex((c) => c.name === fk.refColumn) : -1;

  useEffect(() => {
    if (!data || refIdx < 0 || current === null) return;
    const idx = data.rows.findIndex((r) => r[refIdx] === current);
    if (idx >= 0) {
      setRow(idx);
      setTimeout(() => grid.current?.selectCell(idx, refIdx), 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const choose = (r: number | null) => {
    if (!data || r === null || refIdx < 0) return;
    close(data.rows[r][refIdx]);
  };

  return (
    <Dialog
      title={tr('Fremdschlüsseldaten auswählen – {t}', 'Select foreign key data – {t}', { t: `${fk.refTable}.${fk.refColumn}` })}
      width={860}
      height={560}
      resizable
      noPadding
      onClose={() => close()}
      onSubmit={() => choose(row)}
      footerLeft={
        <span className="muted">
          {data ? tr('{n} Datensätze', '{n} records', { n: data.rows.length }) : ''}
          {data && !showAll && data.rows.length >= 1000 ? ` (${tr('begrenzt', 'limited')})` : ''}
        </span>
      }
      footer={
        <>
          <Button type="submit" variant="primary" disabled={row === null}>
            {tr('Auswählen', 'Select')}
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-td-fk-bar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={tr('Filtern (Enter)', 'Filter (Enter)')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              setApplied(search);
            }
          }}
          className="grow"
        />
        <Checkbox checked={showAll} onChange={setShowAll} label={tr('Alle anzeigen', 'Show all')} />
        <IconButton icon={<RefreshCw size={14} />} title={tr('Aktualisieren', 'Refresh')} onClick={() => void load()} />
      </div>
      <div className="ks-td-fk-grid">
        {loading && !data ? (
          <div className="ks-tab-loading">
            <Spinner />
          </div>
        ) : error ? (
          <div className="danger-text" style={{ padding: 12 }}>
            {error}
          </div>
        ) : data ? (
          <DataGrid
            ref={grid}
            columns={columns}
            rowCount={data.rows.length}
            getValue={(r, c) => data.rows[r][c]}
            onSelectionChange={(s) => setRow(s.cell?.row ?? null)}
            onRowActivated={(r) => choose(r)}
          />
        ) : null}
      </div>
    </Dialog>
  );
}

export function pickForeignKey(sessionId: string, fk: FkRef, current: CellValue): Promise<CellValue | undefined> {
  return openDialog<CellValue>((close) => <FkPicker sessionId={sessionId} fk={fk} current={current} close={close} />);
}

// ───────────── Date / time picker ─────────────

const pad = (n: number) => String(n).padStart(2, '0');

function nowText(kind: 'date' | 'datetime' | 'time'): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return kind === 'date' ? date : kind === 'time' ? time : `${date} ${time}`;
}

function DateTimePicker({
  kind,
  value,
  nullable,
  title,
  close
}: {
  kind: 'date' | 'datetime' | 'time';
  value: string | null;
  nullable: boolean;
  title: string;
  close: (v?: string | null) => void;
}) {
  const [text, setText] = useState(value ?? '');
  const nativeType = kind === 'date' ? 'date' : kind === 'time' ? 'time' : 'datetime-local';
  const nativeValue = kind === 'datetime' ? text.replace(' ', 'T').slice(0, 19) : kind === 'time' ? text.slice(0, 8) : text.slice(0, 10);
  const validNative = kind === 'time' ? /^\d{2}:\d{2}(:\d{2})?$/.test(nativeValue) : nativeValue.length >= 10;
  return (
    <Dialog
      title={title}
      width={420}
      onClose={() => close()}
      onSubmit={() => close(text)}
      footerLeft={
        <>
          <Button size="sm" onClick={() => setText(nowText(kind))}>
            {kind === 'date' ? tr('Heute', 'Today') : tr('Jetzt', 'Now')}
          </Button>
          {nullable && (
            <Button size="sm" onClick={() => close(null)}>
              NULL
            </Button>
          )}
        </>
      }
      footer={
        <>
          <Button type="submit" variant="primary">
            OK
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-form">
        <Field label={tr('Auswahl', 'Picker')} labelWidth={90}>
          <input
            className="ks-input"
            type={nativeType}
            step={1}
            value={validNative ? nativeValue : ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              if (kind === 'datetime') {
                const frac = /\.\d+$/.exec(text)?.[0] ?? '';
                const base = v.replace('T', ' ');
                setText((base.length === 16 ? `${base}:00` : base) + frac);
              } else if (kind === 'time') setText(v.length === 5 ? `${v}:00` : v);
              else setText(v);
            }}
          />
        </Field>
        <Field label={tr('Wert', 'Value')} labelWidth={90} hint={kind === 'datetime' ? 'YYYY-MM-DD HH:MM:SS[.ffffff]' : kind === 'time' ? 'HH:MM:SS' : 'YYYY-MM-DD'}>
          <TextInput data-autofocus className="mono" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** undefined = cancelled, null = NULL */
export function pickDateTime(kind: 'date' | 'datetime' | 'time', value: string | null, nullable: boolean, title: string): Promise<string | null | undefined> {
  return openDialog<string | null>((close) => <DateTimePicker kind={kind} value={value} nullable={nullable} title={title} close={close} />);
}

// ───────────── Show / hide / order columns ─────────────

function ColumnsChooser({
  columns,
  order,
  hidden,
  close
}: {
  columns: GridColumnDef[];
  order: string[];
  hidden: string[];
  close: (v?: { order: string[]; hidden: string[] }) => void;
}) {
  const initial = useMemo(() => {
    const ids = columns.map((c) => c.id);
    const pos = (id: string) => {
      const k = order.indexOf(id);
      return k < 0 ? 1e6 + ids.indexOf(id) : k;
    };
    return [...ids].sort((a, b) => pos(a) - pos(b));
  }, [columns, order]);
  const [list, setList] = useState(initial);
  const [hide, setHide] = useState(new Set(hidden));
  const [sel, setSel] = useState<string | null>(null);
  const move = (dir: -1 | 1) => {
    if (!sel) return;
    const i = list.indexOf(sel);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const n = list.slice();
    [n[i], n[j]] = [n[j], n[i]];
    setList(n);
  };
  const byId = new Map(columns.map((c) => [c.id, c]));
  return (
    <Dialog
      title={tr('Spalten anzeigen / ausblenden', 'Show / hide columns')}
      width={440}
      height={520}
      noPadding
      onClose={() => close()}
      onSubmit={() => close({ order: list, hidden: [...hide] })}
      footerLeft={
        <>
          <Button size="sm" onClick={() => setHide(new Set())}>
            {tr('Alle', 'All')}
          </Button>
          <Button size="sm" onClick={() => setHide(new Set(list.slice(1)))}>
            {tr('Keine', 'None')}
          </Button>
          <Button size="sm" onClick={() => setList(columns.map((c) => c.id))}>
            {tr('Standardreihenfolge', 'Default order')}
          </Button>
        </>
      }
      footer={
        <>
          <Button type="submit" variant="primary">
            OK
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-td-cols">
        <div className="ks-td-cols-list">
          {list.map((id) => (
            <div key={id} className={`ks-td-cols-item ${sel === id ? 'selected' : ''}`} onMouseDown={() => setSel(id)}>
              <Checkbox
                checked={!hide.has(id)}
                onChange={(v) => {
                  const n = new Set(hide);
                  if (v) n.delete(id);
                  else n.add(id);
                  setHide(n);
                }}
              />
              <span className="ellipsis">{id}</span>
              <span className="faint ks-td-cols-type">{byId.get(id)?.typeLabel.toLowerCase()}</span>
            </div>
          ))}
        </div>
        <div className="ks-td-cols-side">
          <IconButton icon={<ArrowUp size={15} />} title={tr('Nach oben', 'Move up')} disabled={!sel} onClick={() => move(-1)} />
          <IconButton icon={<ArrowDown size={15} />} title={tr('Nach unten', 'Move down')} disabled={!sel} onClick={() => move(1)} />
        </div>
      </div>
    </Dialog>
  );
}

export function chooseColumns(columns: GridColumnDef[], order: string[], hidden: string[]): Promise<{ order: string[]; hidden: string[] } | undefined> {
  return openDialog((close) => <ColumnsChooser columns={columns} order={order} hidden={hidden} close={close} />);
}

// ───────────── Find & replace ─────────────

export interface ReplaceOptions {
  find: string;
  replace: string;
  column: string;
  matchCase: boolean;
  wholeCell: boolean;
}

function ReplaceForm({ columns, close }: { columns: GridColumnDef[]; close: (v?: ReplaceOptions) => void }) {
  const [o, setO] = useState<ReplaceOptions>({ find: '', replace: '', column: '*', matchCase: false, wholeCell: false });
  return (
    <Dialog
      title={tr('Suchen und ersetzen', 'Find and replace')}
      width={480}
      onClose={() => close()}
      onSubmit={() => o.find && close(o)}
      footer={
        <>
          <Button type="submit" variant="primary" disabled={!o.find}>
            {tr('Alle ersetzen', 'Replace all')}
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-form">
        <Field label={tr('Suchen nach', 'Find what')} labelWidth={110}>
          <TextInput data-autofocus value={o.find} onChange={(e) => setO({ ...o, find: e.target.value })} />
        </Field>
        <Field label={tr('Ersetzen durch', 'Replace with')} labelWidth={110}>
          <TextInput value={o.replace} onChange={(e) => setO({ ...o, replace: e.target.value })} />
        </Field>
        <Field label={tr('Spalte', 'Column')} labelWidth={110}>
          <Select value={o.column} onChange={(column) => setO({ ...o, column })} options={[{ value: '*', label: tr('(alle Textspalten)', '(all text columns)') }, ...columns.map((c) => ({ value: c.id, label: c.title }))]} />
        </Field>
        <Field label="" labelWidth={110}>
          <div className="col" style={{ gap: 4 }}>
            <Checkbox checked={o.matchCase} onChange={(matchCase) => setO({ ...o, matchCase })} label={tr('Groß-/Kleinschreibung beachten', 'Match case')} />
            <Checkbox checked={o.wholeCell} onChange={(wholeCell) => setO({ ...o, wholeCell })} label={tr('Nur ganze Zellinhalte', 'Match whole cell')} />
          </div>
        </Field>
        <div className="ks-field-hint">
          {tr('Ersetzt Werte auf der aktuellen Seite. Die Änderungen werden erst mit „Übernehmen“ gespeichert.', 'Replaces values on the current page. Changes are saved with "Apply".')}
        </div>
      </div>
    </Dialog>
  );
}

export function askReplace(columns: GridColumnDef[]): Promise<ReplaceOptions | undefined> {
  return openDialog<ReplaceOptions>((close) => <ReplaceForm columns={columns} close={close} />);
}

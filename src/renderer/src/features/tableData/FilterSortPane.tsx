// Filter & sort pane of the table viewer (builder and text mode).

import { useState } from 'react';
import { ArrowDown, ArrowUp, Ellipsis, Plus, Trash2, X } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { SortSpec } from '@shared/types';
import { quoteId } from '@shared/sql/quote';
import { api } from '../../api/client';
import type { GridColumnDef } from '../../components/grid/cellFormat';
import { Button, Checkbox, IconButton, Select, TabStrip, TextArea, TextInput } from '../../components/ui/controls';
import { showMenuBelow, type MenuItem } from '../../components/ui/Menu';
import { keyCombo } from '../../lib/shortcuts';
import { buildWhere, FILTER_OPS, newCond, opArity, type FilterCond, type FilterModel, type FilterOp } from './filter';

interface Props {
  columns: GridColumnDef[];
  filter: FilterModel;
  sort: SortSpec[];
  sessionId: string | null;
  database: string;
  table: string;
  onApply: (filter: FilterModel, sort: SortSpec[]) => void;
  onClose: () => void;
}

export function FilterSortPane({ columns, filter, sort, sessionId, database, table, onApply, onClose }: Props) {
  const [draft, setDraft] = useState<FilterModel>(filter);
  const [sortDraft, setSortDraft] = useState<SortSpec[]>(sort);
  const [tab, setTab] = useState<'filter' | 'sort'>('filter');
  const firstCol = columns[0]?.id ?? '';

  const setCond = (id: string, patch: Partial<FilterCond>) =>
    setDraft((d) => ({ ...d, conds: d.conds.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const removeCond = (id: string) => setDraft((d) => ({ ...d, conds: d.conds.filter((c) => c.id !== id) }));

  const pickValue = async (el: HTMLElement, c: FilterCond) => {
    if (!sessionId || !c.column) return;
    const col = quoteId(c.column);
    try {
      const res = await api.query.execute(
        sessionId,
        `SELECT DISTINCT ${col} FROM ${quoteId(database)}.${quoteId(table)} WHERE ${col} IS NOT NULL ORDER BY 1 LIMIT 300`,
        { history: false, maxRows: 300 }
      );
      const rows = res.results[0]?.rows ?? [];
      const items: MenuItem[] = rows.map((r) => {
        const v = r[0] instanceof Uint8Array ? '' : String(r[0]);
        return { label: v.length > 60 ? `${v.slice(0, 60)}…` : v || tr('(leer)', '(empty)'), onClick: () => setCond(c.id, { value: v }) };
      });
      showMenuBelow(el, items.length ? items : [{ label: tr('Keine Werte', 'No values'), disabled: true }]);
    } catch {
      // ignore
    }
  };

  const apply = () => onApply(draft, draft.mode === 'sql' && draft.orderSql.trim() ? [] : sortDraft);

  const preview = buildWhere(draft, columns);

  return (
    <div
      className="ks-td-filter"
      onKeyDown={(e) => {
        if (keyCombo(e) === 'Ctrl+R' || (keyCombo(e) === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT')) {
          e.preventDefault();
          e.stopPropagation();
          apply();
        }
      }}
    >
      <TabStrip
        tabs={[
          { id: 'filter', label: tr('Filter', 'Filter'), badge: draft.mode === 'builder' ? draft.conds.filter((c) => c.enabled).length || undefined : undefined },
          { id: 'sort', label: tr('Sortierung', 'Sort'), badge: sortDraft.length || undefined, hidden: draft.mode === 'sql' }
        ]}
        value={draft.mode === 'sql' ? 'filter' : tab}
        onChange={setTab}
        right={
          <>
            <Select
              value={draft.mode}
              onChange={(mode) => setDraft((d) => ({ ...d, mode, sql: mode === 'sql' && !d.sql ? buildWhere(d, columns) : d.sql }))}
              options={[
                { value: 'builder', label: tr('Assistent', 'Builder') },
                { value: 'sql', label: tr('Textmodus (SQL)', 'Text mode (SQL)') }
              ]}
              style={{ width: 160, height: 24 }}
            />
            <IconButton icon={<X size={14} />} title={tr('Schließen', 'Close')} onClick={onClose} />
          </>
        }
      />
      <div className="ks-td-filter-body">
        {draft.mode === 'sql' ? (
          <div className="ks-td-filter-sql">
            <label>WHERE</label>
            <TextArea
              className="mono"
              rows={3}
              value={draft.sql}
              placeholder="status = 'active' AND price > 100"
              onChange={(e) => setDraft((d) => ({ ...d, sql: e.target.value }))}
            />
            <label>ORDER BY</label>
            <TextArea className="mono" rows={2} value={draft.orderSql} placeholder="created_at DESC, id" onChange={(e) => setDraft((d) => ({ ...d, orderSql: e.target.value }))} />
          </div>
        ) : tab === 'filter' ? (
          <div className="ks-td-conds">
            {draft.conds.length === 0 && <div className="faint">{tr('Keine Bedingungen – alle Datensätze werden angezeigt.', 'No conditions – all records are shown.')}</div>}
            {draft.conds.map((c, i) => {
              const ar = opArity(c.op);
              return (
                <div key={c.id} className="ks-td-cond">
                  <Checkbox checked={c.enabled} onChange={(v) => setCond(c.id, { enabled: v })} title={tr('Bedingung aktiv', 'Condition enabled')} />
                  {i > 0 ? (
                    <Select value={c.join} onChange={(join) => setCond(c.id, { join })} options={[{ value: 'AND', label: tr('und', 'and') }, { value: 'OR', label: tr('oder', 'or') }]} style={{ width: 70 }} />
                  ) : (
                    <span className="ks-td-cond-where">{tr('wo', 'where')}</span>
                  )}
                  <Button size="sm" variant={c.not ? 'primary' : 'default'} onClick={() => setCond(c.id, { not: !c.not })} title={tr('Bedingung umkehren (NOT)', 'Negate condition (NOT)')}>
                    NOT
                  </Button>
                  <Select value={c.column} onChange={(column) => setCond(c.id, { column })} options={columns.map((x) => ({ value: x.id, label: x.title }))} style={{ width: 170 }} />
                  <Select value={c.op} onChange={(op) => setCond(c.id, { op: op as FilterOp })} options={FILTER_OPS.map((o) => ({ value: o.op, label: o.label() }))} style={{ width: 200 }} />
                  {ar !== 0 && (
                    <>
                      <TextInput
                        className="ks-td-cond-value"
                        value={c.value}
                        placeholder={ar === 'list' ? tr('Werte, durch Komma getrennt', 'values, comma separated') : c.op === 'custom' ? "> 10 AND … / LIKE 'a%'" : tr('Wert', 'value')}
                        onChange={(e) => setCond(c.id, { value: e.target.value })}
                      />
                      {c.op !== 'custom' && (
                        <IconButton icon={<Ellipsis size={14} />} title={tr('Wert aus Liste wählen', 'Pick a value from the list')} onClick={(e) => void pickValue(e.currentTarget, c)} />
                      )}
                    </>
                  )}
                  {ar === 2 && (
                    <>
                      <span className="muted">{tr('und', 'and')}</span>
                      <TextInput className="ks-td-cond-value" value={c.value2} onChange={(e) => setCond(c.id, { value2: e.target.value })} />
                    </>
                  )}
                  <IconButton icon={<Trash2 size={14} />} title={tr('Bedingung entfernen', 'Remove condition')} onClick={() => removeCond(c.id)} />
                </div>
              );
            })}
            <div className="row">
              <Button size="sm" icon={<Plus size={13} />} onClick={() => setDraft((d) => ({ ...d, conds: [...d.conds, newCond(firstCol)] }))}>
                {tr('Bedingung hinzufügen', 'Add condition')}
              </Button>
              {draft.conds.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setDraft((d) => ({ ...d, conds: [] }))}>
                  {tr('Alle entfernen', 'Remove all')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="ks-td-conds">
            {sortDraft.length === 0 && <div className="faint">{tr('Keine Sortierung festgelegt.', 'No sort order defined.')}</div>}
            {sortDraft.map((s, i) => (
              <div key={i} className="ks-td-cond">
                <span className="ks-td-sort-idx">{i + 1}.</span>
                <Select
                  value={s.column}
                  onChange={(column) => setSortDraft((l) => l.map((x, j) => (j === i ? { ...x, column } : x)))}
                  options={columns.map((x) => ({ value: x.id, label: x.title }))}
                  style={{ width: 200 }}
                />
                <Select
                  value={s.desc ? 'DESC' : 'ASC'}
                  onChange={(v) => setSortDraft((l) => l.map((x, j) => (j === i ? { ...x, desc: v === 'DESC' } : x)))}
                  options={[
                    { value: 'ASC', label: tr('aufsteigend', 'ascending') },
                    { value: 'DESC', label: tr('absteigend', 'descending') }
                  ]}
                  style={{ width: 130 }}
                />
                <IconButton
                  icon={<ArrowUp size={14} />}
                  disabled={i === 0}
                  title={tr('Nach oben', 'Move up')}
                  onClick={() => setSortDraft((l) => { const n = l.slice(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}
                />
                <IconButton
                  icon={<ArrowDown size={14} />}
                  disabled={i === sortDraft.length - 1}
                  title={tr('Nach unten', 'Move down')}
                  onClick={() => setSortDraft((l) => { const n = l.slice(); [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })}
                />
                <IconButton icon={<Trash2 size={14} />} title={tr('Entfernen', 'Remove')} onClick={() => setSortDraft((l) => l.filter((_, j) => j !== i))} />
              </div>
            ))}
            <div className="row">
              <Button size="sm" icon={<Plus size={13} />} onClick={() => setSortDraft((l) => [...l, { column: firstCol, desc: false }])}>
                {tr('Sortierfeld hinzufügen', 'Add sort field')}
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="ks-td-filter-foot">
        <code className="ks-td-filter-preview ellipsis selectable" title={preview}>
          {preview ? `WHERE ${preview}` : ''}
        </code>
        <div className="spacer" />
        <Button
          size="sm"
          onClick={() => {
            const cleared: FilterModel = { mode: draft.mode, conds: [], sql: '', orderSql: '' };
            setDraft(cleared);
            setSortDraft([]);
            onApply(cleared, []);
          }}
        >
          {tr('Zurücksetzen', 'Reset')}
        </Button>
        <Button size="sm" variant="primary" onClick={apply} title="Ctrl+R">
          {tr('Anwenden', 'Apply')}
        </Button>
      </div>
    </div>
  );
}

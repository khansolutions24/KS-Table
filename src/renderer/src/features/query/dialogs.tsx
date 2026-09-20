// Dialogs of the query editor: parameter values, saving a query, viewing / editing a cell value.

import { useEffect, useMemo, useState } from 'react';
import { Download, FileCode, Upload } from 'lucide-react';
import type { CellValue, EditValue } from '@shared/types';
import { tr } from '@shared/i18n';
import { toHex } from '@shared/sql/quote';
import { formatBytes } from '@shared/util';
import { api } from '../../api/client';
import { geometryToWkt, imageMime, type GridColumnDef } from '../../components/grid/cellFormat';
import { Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, Field, Select, TextArea, TextInput } from '../../components/ui/controls';
import { toast } from '../../components/Toast';
import { pickOpenFile, pickSaveFile } from '../../lib/files';
import { validateParam, type ParamMode, type ParamValue } from './sqlParams';

// ───────────────────────── parameters ─────────────────────────

const MODES = (): { value: ParamMode; label: string }[] => [
  { value: 'auto', label: tr('Automatisch', 'Automatic') },
  { value: 'text', label: tr('Text', 'Text') },
  { value: 'number', label: tr('Zahl', 'Number') },
  { value: 'raw', label: tr('SQL-Ausdruck', 'SQL expression') },
  { value: 'null', label: 'NULL' }
];

/** Asks for the values of the query parameters; resolves null when cancelled. */
export function openParamsDialog(names: string[], last: Record<string, ParamValue>): Promise<Record<string, ParamValue> | null> {
  return openDialog<Record<string, ParamValue> | null>((close) => <ParamsDialog names={names} last={last} close={close} />).then((v) => v ?? null);
}

function ParamsDialog({ names, last, close }: { names: string[]; last: Record<string, ParamValue>; close: (v?: Record<string, ParamValue> | null) => void }) {
  const [vals, setVals] = useState<Record<string, ParamValue>>(() => Object.fromEntries(names.map((n) => [n, last[n] ?? { mode: 'auto', value: '' }])));
  const [error, setError] = useState<string | null>(null);
  const set = (n: string, patch: Partial<ParamValue>) => {
    setVals((v) => ({ ...v, [n]: { ...v[n], ...patch } }));
    setError(null);
  };
  const submit = () => {
    for (const n of names) {
      const e = validateParam(vals[n]);
      if (e) {
        setError(`:${n} – ${e}`);
        return;
      }
    }
    close(vals);
  };
  return (
    <Dialog
      title={tr('Abfrageparameter', 'Query Parameters')}
      width={600}
      onClose={() => close(null)}
      onSubmit={submit}
      footer={
        <>
          <Button type="submit" variant="primary">
            {tr('Ausführen', 'Run')}
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <div className="muted">
          {tr(
            'Die Abfrage enthält Platzhalter. Die Werte werden als SQL-Literale eingesetzt („Automatisch“: Zahlen ohne, Text mit Anführungszeichen).',
            'The query contains placeholders. Values are inserted as SQL literals ("Automatic": numbers unquoted, text quoted).'
          )}
        </div>
        <div className="ks-query-params">
          <table className="ks-table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>{tr('Parameter', 'Parameter')}</th>
                <th style={{ width: 150 }}>{tr('Typ', 'Type')}</th>
                <th>{tr('Wert', 'Value')}</th>
              </tr>
            </thead>
            <tbody>
              {names.map((n, i) => (
                <tr key={n}>
                  <td className="mono selectable">:{n}</td>
                  <td>
                    <Select value={vals[n].mode} onChange={(mode) => set(n, { mode })} options={MODES()} />
                  </td>
                  <td>
                    <TextInput
                      data-autofocus={i === 0 ? '' : undefined}
                      value={vals[n].mode === 'null' ? '' : vals[n].value}
                      placeholder={vals[n].mode === 'null' ? 'NULL' : vals[n].mode === 'raw' ? 'NOW()' : ''}
                      disabled={vals[n].mode === 'null'}
                      className={vals[n].mode === 'raw' ? 'mono' : undefined}
                      onChange={(e) => set(n, { value: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <div className="danger-text">{error}</div>}
      </div>
    </Dialog>
  );
}

// ───────────────────────── save query ─────────────────────────

export function openSaveQueryDialog(o: { name: string; database: string | null; databases: string[] }): Promise<{ name: string; database: string } | null> {
  return openDialog<{ name: string; database: string } | null>((close) => <SaveQueryDialog o={o} close={close} />).then((v) => v ?? null);
}

function SaveQueryDialog({ o, close }: { o: { name: string; database: string | null; databases: string[] }; close: (v?: { name: string; database: string } | null) => void }) {
  const dbs = o.database && !o.databases.includes(o.database) ? [o.database, ...o.databases] : o.databases;
  const [name, setName] = useState(o.name);
  const [db, setDb] = useState(o.database ?? dbs[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!name.trim()) return setError(tr('Bitte einen Namen eingeben.', 'Please enter a name.'));
    if (!db) return setError(tr('Bitte eine Datenbank auswählen.', 'Please choose a database.'));
    close({ name: name.trim(), database: db });
  };
  return (
    <Dialog
      title={tr('Abfrage speichern', 'Save Query')}
      icon={<FileCode size={16} />}
      width={460}
      onClose={() => close(null)}
      onSubmit={submit}
      footer={
        <>
          <Button type="submit" variant="primary">
            {tr('Speichern', 'Save')}
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-form">
        <Field label={tr('Name', 'Name')} labelWidth={110}>
          <TextInput data-autofocus value={name} invalid={!!error && !name.trim()} onChange={(e) => (setName(e.target.value), setError(null))} onFocus={(e) => e.currentTarget.select()} />
        </Field>
        <Field label={tr('Datenbank', 'Database')} labelWidth={110} hint={tr('Gespeicherte Abfragen gehören zu einer Datenbank.', 'Saved queries belong to a database.')}>
          <Select value={db} onChange={setDb} options={dbs.length ? dbs : [{ value: '', label: tr('(keine Datenbank)', '(no database)') }]} />
        </Field>
        {error && <div className="danger-text">{error}</div>}
      </div>
    </Dialog>
  );
}

// ───────────────────────── value viewer / editor ─────────────────────────

export function openValueDialog(o: { title: string; value: CellValue; column: GridColumnDef; editable: boolean }): Promise<EditValue | undefined> {
  return openDialog<EditValue | undefined>((close) => <ValueDialog o={o} close={close} />);
}

function hexDump(bytes: Uint8Array, max = 4096): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i += 16) {
    const chunk = bytes.subarray(i, Math.min(i + 16, n));
    const hex = toHex(chunk).replace(/(..)/g, '$1 ').trim().padEnd(47, ' ');
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  if (bytes.length > max) lines.push('…');
  return lines.join('\n');
}

function prettyJson(v: string): string {
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

function ValueDialog({ o, close }: { o: { title: string; value: CellValue; column: GridColumnDef; editable: boolean }; close: (v?: EditValue) => void }) {
  const c = o.column;
  const binary = o.value instanceof Uint8Array || c.kind === 'blob' || c.kind === 'binary' || c.kind === 'geometry' || c.kind === 'bit';
  const canEdit = o.editable && !c.readonly && c.kind !== 'geometry' && c.kind !== 'bit';
  const [isNull, setIsNull] = useState(o.value === null);
  const [text, setText] = useState(() => (typeof o.value === 'string' ? (c.kind === 'json' ? prettyJson(o.value) : o.value) : ''));
  const [bytes, setBytes] = useState<Uint8Array | null>(o.value instanceof Uint8Array ? o.value : null);
  const [changed, setChanged] = useState(false);
  const mime = bytes ? imageMime(bytes) : null;
  const url = useMemo(() => (bytes && mime ? URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime })) : null), [bytes, mime]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  const submit = () => {
    if (!canEdit || !changed) return close(undefined);
    if (isNull) return close(null);
    if (binary) return close(bytes ?? new Uint8Array());
    close(text);
  };

  const load = async () => {
    const p = await pickOpenFile({ title: tr('Datei laden', 'Load file') });
    if (!p) return;
    try {
      setBytes(await api.fs.readBinary(p));
      setIsNull(false);
      setChanged(true);
    } catch (e) {
      void errorDialog(e);
    }
  };

  const saveAs = async () => {
    if (!bytes && typeof o.value !== 'string') return;
    const p = await pickSaveFile({ title: tr('Wert speichern unter', 'Save value as') });
    if (!p) return;
    try {
      if (bytes) await api.fs.writeBinary(p, bytes);
      else await api.fs.writeText(p, text);
      toast(tr('Gespeichert', 'Saved'), 'success');
    } catch (e) {
      void errorDialog(e);
    }
  };

  return (
    <Dialog
      title={o.title}
      width={720}
      height={520}
      resizable
      noPadding
      onClose={() => close(undefined)}
      footerLeft={
        <>
          {canEdit && <Checkbox checked={isNull} onChange={(v) => (setIsNull(v), setChanged(true))} label="NULL" />}
          {binary && canEdit && (
            <Button size="sm" icon={<Upload size={13} />} onClick={() => void load()}>
              {tr('Datei laden …', 'Load file …')}
            </Button>
          )}
          {(bytes || typeof o.value === 'string') && (
            <Button size="sm" icon={<Download size={13} />} onClick={() => void saveAs()}>
              {tr('Speichern unter …', 'Save as …')}
            </Button>
          )}
          {c.kind === 'json' && canEdit && (
            <Button size="sm" onClick={() => setText((t) => prettyJson(t))}>
              {tr('JSON formatieren', 'Format JSON')}
            </Button>
          )}
        </>
      }
      footer={
        <>
          {canEdit && (
            <Button variant="primary" onClick={submit}>
              OK
            </Button>
          )}
          <Button onClick={() => close(undefined)}>{canEdit ? tr('Abbrechen', 'Cancel') : tr('Schließen', 'Close')}</Button>
        </>
      }
    >
      <div className="ks-query-value">
        <div className="ks-query-value-info muted">
          {c.typeLabel}
          {bytes ? ` · ${formatBytes(bytes.length)}` : typeof o.value === 'string' ? ` · ${tr('{n} Zeichen', '{n} characters', { n: o.value.length })}` : ''}
          {mime ? ` · ${mime}` : ''}
        </div>
        {isNull && !changed ? (
          <div className="ks-query-value-null faint">NULL</div>
        ) : binary ? (
          <div className="ks-query-value-bin">
            {url && <img src={url} alt="" className="ks-query-value-img" />}
            {c.kind === 'geometry' && bytes ? (
              <pre className="ks-sql selectable">{`SRID ${geometryToWkt(bytes).srid}\n${geometryToWkt(bytes).wkt}`}</pre>
            ) : (
              bytes && <pre className="ks-sql selectable ks-query-hex">{hexDump(bytes)}</pre>
            )}
          </div>
        ) : (
          <TextArea
            data-autofocus
            className="mono ks-query-value-text"
            value={text}
            readOnly={!canEdit}
            onChange={(e) => {
              setText(e.target.value);
              setIsNull(false);
              setChanged(true);
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

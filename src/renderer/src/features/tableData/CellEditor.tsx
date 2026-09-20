// Cell value viewer / editor (Text, Hex, Image, Web, field info) – side pane of the table viewer
// and dialog for BLOB / long text / JSON / geometry values.

import { useEffect, useMemo, useState } from 'react';
import { Check, Download, Eraser, FolderOpen, Braces } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { CellValue, ColumnMeta, EditValue } from '@shared/types';
import { fromHex, quoteString, toHex } from '@shared/sql/quote';
import { formatBytes } from '@shared/util';
import { api } from '../../api/client';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { editText, geometryToWkt, imageMime, type GridColumnDef } from '../../components/grid/cellFormat';
import { Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { Button, Select, TabStrip, TextArea } from '../../components/ui/controls';
import { pickOpenFile, pickSaveFile } from '../../lib/files';

type EditorTab = 'text' | 'hex' | 'image' | 'web' | 'field';
type Lang = 'plaintext' | 'json' | 'xml' | 'html' | 'mysql';

export interface CellEditorProps {
  column: GridColumnDef | null;
  meta?: ColumnMeta;
  value: CellValue;
  editable: boolean;
  nullText: string;
  onSet: (v: EditValue) => void;
}

const textDecoder = new TextDecoder('utf-8', { fatal: false });
const textEncoder = new TextEncoder();

function hexDump(bytes: Uint8Array, max = 64 * 1024): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const chunk = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > max) lines.push(tr('… ({n} weitere Bytes)', '… ({n} more bytes)', { n: bytes.length - max }));
  return lines.join('\n');
}

export function CellEditor({ column, meta, value, editable, nullText, onSet }: CellEditorProps) {
  const binary = value instanceof Uint8Array;
  const isGeometry = column?.kind === 'geometry';
  const isImage = binary && !!imageMime(value as Uint8Array);
  const initialTab: EditorTab = isImage ? 'image' : binary && !isGeometry && column?.kind !== 'bit' ? 'hex' : 'text';
  const [tab, setTab] = useState<EditorTab>(initialTab);
  const asText = useMemo(() => {
    if (value === null) return '';
    if (value instanceof Uint8Array) {
      if (column && (isGeometry || column.kind === 'bit')) return editText(value, column);
      return textDecoder.decode(value.length > 2_000_000 ? value.subarray(0, 2_000_000) : value);
    }
    return value;
  }, [value, column, isGeometry]);
  const [draft, setDraft] = useState(asText);
  const [hexDraft, setHexDraft] = useState('');
  const [lang, setLang] = useState<Lang>(column?.kind === 'json' ? 'json' : 'plaintext');

  useEffect(() => {
    setDraft(asText);
    setHexDraft(value instanceof Uint8Array && value.length <= 256 * 1024 ? toHex(value).replace(/(..)/g, '$1 ').trim() : '');
    setTab(initialTab);
    setLang(column?.kind === 'json' || /^\s*[[{]/.test(asText) ? 'json' : 'plaintext');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, column?.id]);

  const imgUrl = useMemo(() => {
    if (!(value instanceof Uint8Array)) return null;
    const mime = imageMime(value);
    return mime ? URL.createObjectURL(new Blob([value as BlobPart], { type: mime })) : null;
  }, [value]);
  useEffect(() => () => {
    if (imgUrl) URL.revokeObjectURL(imgUrl);
  }, [imgUrl]);

  if (!column) return <div className="ks-td-celled-empty faint">{tr('Keine Zelle ausgewählt', 'No cell selected')}</div>;

  const canEdit = editable && !column.readonly;
  const applyText = () => {
    if (isGeometry) {
      const srid = value instanceof Uint8Array ? geometryToWkt(value).srid : 0;
      onSet(draft.trim() ? { expr: `ST_GeomFromText(${quoteString(draft.trim())}, ${srid})` } : null);
    } else if (binary || column.kind === 'blob' || column.kind === 'binary') onSet(textEncoder.encode(draft));
    else onSet(draft);
  };

  const load = async () => {
    const file = await pickOpenFile({ title: tr('Wert aus Datei laden', 'Load value from file') });
    if (!file) return;
    try {
      if (binary || column.kind === 'blob' || column.kind === 'binary') onSet(await api.fs.readBinary(file));
      else onSet(await api.fs.readText(file));
    } catch (e) {
      void errorDialog(e);
    }
  };

  const save = async () => {
    const file = await pickSaveFile({ title: tr('Wert in Datei speichern', 'Save value to file'), defaultPath: `${column.id}${isImage ? `.${imageMime(value as Uint8Array)!.split('/')[1]}` : binary ? '.bin' : '.txt'}` });
    if (!file) return;
    try {
      if (value instanceof Uint8Array) await api.fs.writeBinary(file, value);
      else await api.fs.writeText(file, value ?? '');
    } catch (e) {
      void errorDialog(e);
    }
  };

  const pairs: [string, string][] = meta
    ? [
        [tr('Name', 'Name'), meta.name],
        [tr('Typ', 'Type'), meta.columnType],
        [tr('NULL erlaubt', 'Nullable'), meta.nullable ? tr('Ja', 'Yes') : tr('Nein', 'No')],
        [tr('Standardwert', 'Default'), meta.defaultValue ?? 'NULL'],
        [tr('Schlüssel', 'Key'), meta.key || '–'],
        [tr('Extra', 'Extra'), meta.extra || '–'],
        [tr('Zeichensatz', 'Charset'), meta.charset ?? '–'],
        [tr('Sortierung', 'Collation'), meta.collation ?? '–'],
        [tr('Kommentar', 'Comment'), meta.comment || '–'],
        ...(meta.generationExpression ? ([[tr('Ausdruck', 'Expression'), meta.generationExpression]] as [string, string][]) : [])
      ]
    : [
        [tr('Name', 'Name'), column.title],
        [tr('Typ', 'Type'), column.typeLabel]
      ];

  return (
    <div className="ks-td-celled">
      <TabStrip
        tabs={[
          { id: 'text', label: tr('Text', 'Text') },
          { id: 'hex', label: 'Hex', hidden: !binary || isGeometry },
          { id: 'image', label: tr('Bild', 'Image'), hidden: !binary || isGeometry },
          { id: 'web', label: 'Web', hidden: binary },
          { id: 'field', label: tr('Feld', 'Field') }
        ]}
        value={tab}
        onChange={setTab}
        right={<span className="faint ks-td-celled-size">{value === null ? nullText : binary ? formatBytes((value as Uint8Array).length) : `${asText.length} ${tr('Zeichen', 'chars')}`}</span>}
      />
      <div className="ks-td-celled-body">
        {tab === 'text' && (
          <div className="ks-td-celled-text">
            <div className="ks-td-celled-bar">
              <Select
                value={lang}
                onChange={setLang}
                options={[
                  { value: 'plaintext', label: tr('Nur Text', 'Plain text') },
                  { value: 'json', label: 'JSON' },
                  { value: 'xml', label: 'XML' },
                  { value: 'html', label: 'HTML' },
                  { value: 'mysql', label: 'SQL' }
                ]}
                style={{ width: 120, height: 24 }}
              />
              {lang === 'json' && (
                <Button
                  size="sm"
                  icon={<Braces size={13} />}
                  onClick={() => {
                    try {
                      setDraft(JSON.stringify(JSON.parse(draft), null, 2));
                    } catch (e) {
                      void errorDialog(e, tr('Ungültiges JSON', 'Invalid JSON'));
                    }
                  }}
                >
                  {tr('Formatieren', 'Format')}
                </Button>
              )}
            </div>
            <div className="ks-td-celled-editor">
              <SqlEditor
                value={draft}
                onChange={setDraft}
                language={lang}
                readOnly={!canEdit}
                options={{ lineNumbers: 'off', wordWrap: 'on', minimap: { enabled: false }, folding: lang !== 'plaintext', glyphMargin: false }}
              />
            </div>
          </div>
        )}
        {tab === 'hex' && value instanceof Uint8Array && (
          <div className="ks-td-celled-hex">
            <pre className="selectable">{hexDump(value)}</pre>
            {canEdit && value.length <= 256 * 1024 && (
              <TextArea className="mono" rows={4} value={hexDraft} onChange={(e) => setHexDraft(e.target.value)} placeholder="00 FF 1A …" />
            )}
          </div>
        )}
        {tab === 'image' && (
          <div className="ks-td-celled-image">
            {imgUrl ? <img src={imgUrl} alt="" /> : <div className="faint">{tr('Kein Bildformat erkannt', 'No image format detected')}</div>}
          </div>
        )}
        {tab === 'web' && <iframe className="ks-td-celled-web" sandbox="" srcDoc={draft} title="web" />}
        {tab === 'field' && (
          <div className="ks-td-celled-field">
            {pairs.map(([k, v]) => (
              <div key={k} className="ks-info-pair">
                <div className="ks-info-key">{k}</div>
                <div className="ks-info-val selectable">{v}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="ks-td-celled-foot">
        <Button size="sm" icon={<FolderOpen size={13} />} disabled={!canEdit} onClick={() => void load()}>
          {tr('Laden …', 'Load …')}
        </Button>
        <Button size="sm" icon={<Download size={13} />} disabled={value === null} onClick={() => void save()}>
          {tr('Speichern …', 'Save …')}
        </Button>
        <div className="spacer" />
        <Button size="sm" icon={<Eraser size={13} />} disabled={!canEdit || (value === null && !meta?.nullable)} onClick={() => onSet(null)}>
          NULL
        </Button>
        {(tab === 'text' || tab === 'hex') && (
          <Button
            size="sm"
            variant="primary"
            icon={<Check size={13} />}
            disabled={!canEdit}
            onClick={() => (tab === 'hex' ? onSet(fromHex(hexDraft)) : applyText())}
          >
            {tr('Übernehmen', 'Apply')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Opens the cell editor as dialog; resolves with the new value or undefined (cancelled). */
export function openValueEditor(p: Omit<CellEditorProps, 'onSet'> & { title: string }): Promise<EditValue | undefined> {
  return openDialog<EditValue>((close) => (
    <Dialog title={p.title} width={780} height={560} resizable noPadding onClose={() => close()}>
      <CellEditor {...p} onSet={(v) => close(v)} />
    </Dialog>
  ));
}

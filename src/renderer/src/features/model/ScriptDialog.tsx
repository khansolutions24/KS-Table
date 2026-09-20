// Forward engineering: SQL script of the model with options, preview, save / copy / open in the query editor.

import { useMemo, useState } from 'react';
import { Copy, FileCode, FolderOpen } from 'lucide-react';
import { tr } from '@shared/i18n';
import { defaultScriptOptions, modelScript, scriptText, type ScriptOptions } from '@shared/model/forward';
import type { ModelDoc } from '@shared/model/types';
import { safeFileName } from '@shared/util';
import { api } from '../../api/client';
import { newQuery } from '../../actions/query';
import { SqlHighlight } from '../../components/SqlHighlight';
import { toast } from '../../components/Toast';
import { Button, Checkbox, Field, Select, TextInput } from '../../components/ui/controls';
import { Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { joinPath, pickSaveFile } from '../../lib/files';
import { modelsDir } from './files';

export function openScriptDialog(doc: ModelDoc): Promise<void> {
  return openDialog<void>((close) => <ScriptDialog doc={doc} close={() => close()} />).then(() => undefined);
}

function ScriptDialog({ doc, close }: { doc: ModelDoc; close: () => void }) {
  const [o, setO] = useState<ScriptOptions>(() => defaultScriptOptions(doc));
  const [tables, setTables] = useState<Set<string>>(() => new Set(doc.tables.map((t) => t.id)));
  const [views, setViews] = useState<Set<string>>(() => new Set(doc.views.map((v) => v.id)));
  const set = (p: Partial<ScriptOptions>) => setO((x) => ({ ...x, ...p }));
  const text = useMemo(() => {
    const opts = { ...o, tableIds: [...tables], viewIds: [...views] };
    return scriptText(doc, modelScript(doc, opts), opts);
  }, [doc, o, tables, views]);

  const toggle = (setFn: typeof setTables, id: string, on: boolean) =>
    setFn((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const save = async () => {
    const p = await pickSaveFile({
      title: tr('SQL-Skript speichern', 'Save SQL script'),
      defaultPath: joinPath(modelsDir(), `${safeFileName(doc.name || 'model')}.sql`),
      filters: [{ name: 'SQL', extensions: ['sql'] }]
    });
    if (!p) return;
    try {
      const file = /\.sql$/i.test(p) ? p : `${p}.sql`;
      await api.fs.writeText(file, text);
      toast(tr('Skript gespeichert: {f}', 'Script saved: {f}', { f: file }), 'success');
      close();
    } catch (e) {
      void errorDialog(e);
    }
  };

  const all = doc.tables.length + doc.views.length;
  const selectedCount = tables.size + views.size;
  return (
    <Dialog
      title={tr('SQL-Skript erzeugen', 'Generate SQL Script')}
      icon={<FileCode size={16} />}
      width={1000}
      height={660}
      resizable
      noPadding
      onClose={close}
      footerLeft={
        <>
          <Button icon={<Copy size={14} />} onClick={() => void navigator.clipboard.writeText(text).then(() => toast(tr('In die Zwischenablage kopiert', 'Copied to clipboard')))}>
            {tr('Kopieren', 'Copy')}
          </Button>
          <Button
            icon={<FileCode size={14} />}
            onClick={() => {
              if (newQuery(undefined, o.schema.trim() || undefined, text, `${doc.name} – SQL`)) close();
            }}
          >
            {tr('Im Abfrage-Editor öffnen', 'Open in Query Editor')}
          </Button>
        </>
      }
      footer={
        <>
          <Button variant="primary" icon={<FolderOpen size={14} />} onClick={() => void save()}>
            {tr('Speichern …', 'Save …')}
          </Button>
          <Button onClick={close}>{tr('Schließen', 'Close')}</Button>
        </>
      }
    >
      <div className="ks-md-split">
        <div className="ks-md-split-left">
          <div className="ks-form">
            <Field label={tr('Datenbank', 'Database')} labelWidth={90} hint={tr('Leer = unqualifizierte Namen', 'Empty = unqualified names')}>
              <TextInput value={o.schema} onChange={(e) => set({ schema: e.target.value })} />
            </Field>
            <Field label={tr('Server', 'Server')} labelWidth={90}>
              <Select value={o.serverType} onChange={(serverType) => set({ serverType })} options={[{ value: 'mysql', label: 'MySQL' }, { value: 'mariadb', label: 'MariaDB' }]} />
            </Field>
            <Checkbox checked={o.createDatabase} disabled={!o.schema.trim()} onChange={(createDatabase) => set({ createDatabase })} label="CREATE DATABASE IF NOT EXISTS" />
            <Checkbox checked={o.drop} onChange={(drop) => set({ drop })} label={tr('DROP-Anweisungen voranstellen', 'Prepend DROP statements')} />
            <Checkbox checked={o.ifNotExists} onChange={(ifNotExists) => set({ ifNotExists })} label="IF NOT EXISTS" />
            <Checkbox checked={o.foreignKeys} onChange={(foreignKeys) => set({ foreignKeys })} label={tr('Fremdschlüssel', 'Foreign keys')} />
            <Checkbox checked={o.separateForeignKeys} disabled={!o.foreignKeys} onChange={(separateForeignKeys) => set({ separateForeignKeys })} label={tr('Fremdschlüssel am Ende (ALTER TABLE)', 'Foreign keys at the end (ALTER TABLE)')} />
            <Checkbox checked={o.triggers} onChange={(triggers) => set({ triggers })} label={tr('Trigger', 'Triggers')} />
            <Checkbox checked={o.views} onChange={(v) => set({ views: v })} label={tr('Ansichten', 'Views')} />
            <Checkbox checked={o.autoIncrement} onChange={(autoIncrement) => set({ autoIncrement })} label={tr('AUTO_INCREMENT-Startwerte', 'AUTO_INCREMENT start values')} />
            <Checkbox checked={o.comments} onChange={(comments) => set({ comments })} label={tr('Kommentare', 'Comments')} />
          </div>
          <div className="ks-md-listbar">
            <b>{tr('Objekte', 'Objects')}</b>
            <span className="muted">
              {selectedCount}/{all}
            </span>
            <div className="spacer" />
            <Button
              size="sm"
              variant="link"
              onClick={() => {
                const on = selectedCount < all;
                setTables(new Set(on ? doc.tables.map((t) => t.id) : []));
                setViews(new Set(on ? doc.views.map((v) => v.id) : []));
              }}
            >
              {selectedCount < all ? tr('Alle', 'All') : tr('Keine', 'None')}
            </Button>
          </div>
          <div className="ks-md-objlist">
            {doc.tables.map((t) => (
              <Checkbox key={t.id} checked={tables.has(t.id)} onChange={(v) => toggle(setTables, t.id, v)} label={t.design.name} />
            ))}
            {doc.views.map((v) => (
              <Checkbox key={v.id} checked={views.has(v.id)} disabled={!o.views} onChange={(on) => toggle(setViews, v.id, on)} label={`${v.name} (${tr('Ansicht', 'view')})`} />
            ))}
          </div>
        </div>
        <div className="ks-md-split-right">
          <div className="ks-sql-preview selectable">
            <SqlHighlight sql={text} />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

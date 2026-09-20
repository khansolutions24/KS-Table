// Data dictionary generation: self-contained HTML document for a database or a model.

import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { tr } from '@shared/i18n';
import { buildDictionaryHtml, defaultDictionaryOptions, type DictionaryInput, type DictionaryOptions } from '@shared/model/dictionary';
import type { ModelDoc } from '@shared/model/types';
import { formatDateTime, safeFileName } from '@shared/util';
import { api } from '../../api/client';
import { toast } from '../../components/Toast';
import { Button, Checkbox, Field, Spinner, TextArea, TextInput } from '../../components/ui/controls';
import { Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { PathInput } from '../../components/ui/PathInput';
import { joinPath } from '../../lib/files';
import { getProfile, metaSession } from '../../store/workspace';
import { ConnectionDbPicker } from './ConnectionPicker';
import { dictionaryDir, fileUrl } from './files';

export type DictionarySource = { kind: 'database'; connectionId: string; database: string } | { kind: 'model'; doc: ModelDoc; file: string | null };

type Prefs = DictionaryOptions & { open: boolean };
const PREFS_KEY = 'ks-model-dictionary';

function loadPrefs(): Prefs {
  const def: Prefs = { ...defaultDictionaryOptions(), open: true };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...def, ...(JSON.parse(raw) as Partial<Prefs>) } : def;
  } catch {
    return def;
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // storage unavailable – options are not remembered
  }
}

export function openDictionaryDialog(src: DictionarySource): Promise<void> {
  return openDialog<void>((close) => <DictionaryDialog src={src} close={() => close()} />).then(() => undefined);
}

const defaultPath = (title: string) => joinPath(dictionaryDir(), `${safeFileName(title.trim() || 'dictionary')}.html`);

function DictionaryDialog({ src, close }: { src: DictionarySource; close: () => void }) {
  const [cid, setCid] = useState(src.kind === 'database' ? src.connectionId : '');
  const [db, setDb] = useState(src.kind === 'database' ? src.database : '');
  const initialTitle = src.kind === 'model' ? src.doc.name : src.database;
  const [title, setTitle] = useState(initialTitle);
  const [subtitle, setSubtitle] = useState('');
  const [description, setDescription] = useState(src.kind === 'model' ? src.doc.description : '');
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [path, setPath] = useState(() => defaultPath(initialTitle));
  const [pathTouched, setPathTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const isDb = src.kind === 'database';
  const set = (p: Partial<Prefs>) => setPrefs((cur) => ({ ...cur, ...p }));

  const changeDb = (c: string, d: string) => {
    setCid(c);
    setDb(d);
    if (title === db || !title) {
      setTitle(d);
      if (!pathTouched) setPath(defaultPath(d));
    }
  };

  const generate = async () => {
    if (isDb && (!cid || !db)) {
      toast(tr('Bitte Verbindung und Datenbank wählen.', 'Please choose a connection and a database.'));
      return;
    }
    if (!path.trim()) return;
    setBusy(true);
    try {
      let input: DictionaryInput;
      let serverType: 'mysql' | 'mariadb' = 'mysql';
      if (src.kind === 'model') {
        serverType = src.doc.target.type;
        input = {
          title: title.trim() || src.doc.name,
          subtitle,
          description,
          source: `${tr('Modell', 'Model')} ${src.file ?? src.doc.name}`,
          server: `${serverType === 'mariadb' ? 'MariaDB' : 'MySQL'} ${src.doc.target.version}`,
          charset: '',
          collation: '',
          generatedAt: formatDateTime(Date.now()),
          tables: src.doc.tables.map((t) => ({ design: t.design })),
          views: src.doc.views.map((v) => ({ name: v.name, definition: v.definition, algorithm: v.algorithm, security: v.security, checkOption: v.checkOption, comment: v.comment })),
          routines: [],
          events: []
        };
      } else {
        const data = await api.model.dictionaryData(metaSession(cid), db);
        serverType = /mariadb/i.test(data.server) ? 'mariadb' : 'mysql';
        input = {
          title: title.trim() || db,
          subtitle,
          description,
          source: `${tr('Verbindung', 'Connection')} ${getProfile(cid)?.name ?? ''} · ${tr('Datenbank', 'Database')} ${db}`,
          server: data.server,
          charset: data.charset,
          collation: data.collation,
          generatedAt: formatDateTime(Date.now()),
          tables: data.tables.map((t) => ({ design: t.design, status: t.status })),
          views: data.views,
          routines: data.routines,
          events: data.events
        };
      }
      const html = buildDictionaryHtml(input, { ...prefs, serverType });
      const file = /\.html?$/i.test(path.trim()) ? path.trim() : `${path.trim()}.html`;
      await api.fs.writeText(file, html);
      savePrefs(prefs);
      close();
      toast(tr('Datenwörterbuch erstellt: {f}', 'Data dictionary created: {f}', { f: file }), 'success');
      if (prefs.open) await api.app.openExternal(fileUrl(file));
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  const LW = 120;
  return (
    <Dialog
      title={tr('Datenwörterbuch erstellen', 'Create Data Dictionary')}
      icon={<BookOpen size={16} />}
      width={620}
      onClose={close}
      onSubmit={() => void generate()}
      footer={
        <>
          <Button type="submit" variant="primary" disabled={busy} icon={busy ? <Spinner size={13} /> : undefined}>
            {tr('Erstellen', 'Create')}
          </Button>
          <Button onClick={close}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-form">
        {isDb ? (
          <ConnectionDbPicker connectionId={cid} database={db} onChange={changeDb} labelWidth={LW} />
        ) : (
          <Field label={tr('Quelle', 'Source')} labelWidth={LW}>
            <span>
              {tr('Modell', 'Model')} „{src.doc.name}“ · {tr('{t} Tabellen, {v} Ansichten', '{t} tables, {v} views', { t: src.doc.tables.length, v: src.doc.views.length })}
            </span>
          </Field>
        )}
        <Field label={tr('Titel', 'Title')} labelWidth={LW}>
          <TextInput data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={tr('Untertitel', 'Subtitle')} labelWidth={LW}>
          <TextInput value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
        </Field>
        <Field label={tr('Einleitung', 'Introduction')} labelWidth={LW} alignTop>
          <TextArea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={tr('Inhalt', 'Contents')} labelWidth={LW} alignTop>
          <div className="ks-te-cols2">
            <Checkbox checked={prefs.toc} onChange={(v) => set({ toc: v })} label={tr('Inhaltsverzeichnis', 'Table of contents')} />
            <Checkbox checked={prefs.indexes} onChange={(v) => set({ indexes: v })} label={tr('Indizes', 'Indexes')} />
            <Checkbox checked={prefs.foreignKeys} onChange={(v) => set({ foreignKeys: v })} label={tr('Fremdschlüssel', 'Foreign keys')} />
            <Checkbox checked={prefs.referencedBy} onChange={(v) => set({ referencedBy: v })} label={tr('Referenziert von', 'Referenced by')} />
            <Checkbox checked={prefs.checks} onChange={(v) => set({ checks: v })} label={tr('Prüfbedingungen', 'Check constraints')} />
            <Checkbox checked={prefs.triggers} onChange={(v) => set({ triggers: v })} label={tr('Trigger', 'Triggers')} />
            <Checkbox checked={prefs.views} onChange={(v) => set({ views: v })} label={tr('Ansichten', 'Views')} />
            {isDb && <Checkbox checked={prefs.routines} onChange={(v) => set({ routines: v })} label={tr('Funktionen und Prozeduren', 'Functions and procedures')} />}
            {isDb && <Checkbox checked={prefs.events} onChange={(v) => set({ events: v })} label={tr('Ereignisse', 'Events')} />}
            <Checkbox checked={prefs.ddl} onChange={(v) => set({ ddl: v })} label={tr('DDL-Anweisungen', 'DDL statements')} />
            <Checkbox checked={prefs.autoDark} onChange={(v) => set({ autoDark: v })} label={tr('Dunkles Farbschema unterstützen', 'Support dark color scheme')} />
          </div>
        </Field>
        <Field label={tr('Datei', 'File')} labelWidth={LW}>
          <PathInput
            value={path}
            mode="save"
            filters={[{ name: 'HTML', extensions: ['html'] }]}
            onChange={(v) => {
              setPath(v);
              setPathTouched(true);
            }}
          />
        </Field>
        <Field label="" labelWidth={LW}>
          <Checkbox checked={prefs.open} onChange={(v) => set({ open: v })} label={tr('Nach dem Erstellen öffnen', 'Open after creation')} />
        </Field>
      </div>
    </Dialog>
  );
}

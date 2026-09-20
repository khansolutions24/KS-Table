// Forward engineering to a live database: compares the model with a database, previews the
// statements per object and executes the selected ones.

import { useMemo, useState } from 'react';
import { CircleAlert, GitCompare, Play } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { ModelDoc } from '@shared/model/types';
import { matchTables, planSync, syncStatements, type SyncItem, type SyncOptions } from '@shared/model/sync';
import { quoteId } from '@shared/sql/quote';
import { api, errorMessage } from '../../api/client';
import { SqlHighlight } from '../../components/SqlHighlight';
import { toast } from '../../components/Toast';
import { Button, Checkbox, Spinner } from '../../components/ui/controls';
import { confirmDialog, Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { isUserCancelled, metaSession, openSessionWithPrompt, useWorkspace } from '../../store/workspace';
import { ConnectionDbPicker } from './ConnectionPicker';

export interface SyncedView {
  id: string;
  source: string;
  server: string;
}

export function openSyncDialog(doc: ModelDoc, initial: { connectionId: string; database: string } | null, onSynced: (views: SyncedView[], target: { connectionId: string; database: string }) => void): Promise<void> {
  return openDialog<void>((close) => <SyncDialog doc={doc} initial={initial} onSynced={onSynced} close={() => close()} />).then(() => undefined);
}

const ACTION_LABEL: Record<SyncItem['action'], () => string> = {
  create: () => tr('Erstellen', 'Create'),
  alter: () => tr('Ändern', 'Modify'),
  drop: () => tr('Löschen', 'Delete'),
  same: () => tr('Identisch', 'Identical')
};

function SyncDialog({
  doc: initialDoc,
  initial,
  onSynced,
  close
}: {
  doc: ModelDoc;
  initial: { connectionId: string; database: string } | null;
  onSynced: (views: SyncedView[], target: { connectionId: string; database: string }) => void;
  close: () => void;
}) {
  const [docState, setDoc] = useState(initialDoc);
  const doc = docState;
  const [cid, setCid] = useState(initial?.connectionId ?? '');
  const [db, setDb] = useState(initial?.database ?? doc.schema);
  const [dropColumns, setDropColumns] = useState(true);
  const [triggers, setTriggers] = useState(true);
  const [views, setViews] = useState(true);
  const [showSame, setShowSame] = useState(false);
  const [items, setItems] = useState<SyncItem[] | null>(null);
  const [dbExists, setDbExists] = useState(true);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<'compare' | 'run' | null>(null);
  const [log, setLog] = useState<{ ok: boolean; text: string }[]>([]);
  const serverType = useWorkspace((s) => (cid ? s.conns[cid]?.server?.type : undefined)) ?? doc.target.type;

  const opts = (): SyncOptions => ({ schema: db.trim(), serverType, dropColumns, triggers, views, includeDefiner: false });

  const compare = async (doc: ModelDoc = docState) => {
    const schema = db.trim();
    if (!cid || !schema) {
      toast(tr('Bitte Verbindung und Datenbank wählen.', 'Please choose a connection and a database.'));
      return;
    }
    setBusy('compare');
    try {
      if (!(await useWorkspace.getState().openConnection(cid))) return;
      const sid = metaSession(cid);
      const exists = (await api.meta.databases(sid)).some((d) => d.name.toLowerCase() === schema.toLowerCase());
      setDbExists(exists);
      const dbTables = exists ? (await api.meta.tables(sid, schema)).filter((t) => t.type === 'BASE TABLE').map((t) => t.name) : [];
      const matches = matchTables(
        doc.tables.map((t) => t.design),
        dbTables
      );
      const names = matches.filter((m) => m.model && m.dbName).map((m) => m.dbName!);
      const designs = names.length ? await api.model.tableDesigns(sid, schema, names) : [];
      const dbViews = exists && views ? await api.model.viewDefinitions(sid, schema, null) : [];
      const plan = planSync({ tables: matches, dbDesigns: new Map(designs.map((d) => [d.name.toLowerCase(), d])), modelViews: doc.views, dbViews }, opts());
      setItems(plan);
      setChecked(new Set(plan.filter((i) => i.action === 'create' || i.action === 'alter').map((i) => i.key)));
      setCurrent(plan.find((i) => i.action !== 'same')?.key ?? null);
      setLog([]);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(null);
    }
  };

  const statements = useMemo(() => (items ? syncStatements(items, checked) : []), [items, checked]);
  const cur = items?.find((i) => i.key === current) ?? null;
  const preview = cur ? cur.statements.map((s) => `${s.sql};`).join('\n\n') : statements.map((s) => `${s};`).join('\n\n');

  const execute = async () => {
    if (!items || !statements.length) return;
    const schema = db.trim();
    const destructive = items.filter((i) => checked.has(i.key) && i.destructive);
    const ok = await confirmDialog({
      title: tr('Synchronisieren', 'Synchronize'),
      message: destructive.length
        ? tr('{n} Anweisungen werden in „{d}“ ausgeführt. Dabei werden Tabellen oder Spalten gelöscht ({o}) – Daten gehen verloren.', '{n} statements will be executed in "{d}". Tables or columns will be dropped ({o}) – data will be lost.', {
            n: statements.length,
            d: schema,
            o: destructive.map((i) => i.name).join(', ')
          })
        : tr('{n} Anweisungen werden in „{d}“ ausgeführt.', '{n} statements will be executed in "{d}".', { n: statements.length, d: schema }),
      okLabel: tr('Ausführen', 'Execute'),
      danger: destructive.length > 0
    });
    if (!ok) return;
    setBusy('run');
    const lines: { ok: boolean; text: string }[] = [];
    const push = (l: { ok: boolean; text: string }) => {
      lines.push(l);
      setLog([...lines]);
    };
    let sid: string | null = null;
    let failed = false;
    let nextDoc = doc;
    try {
      const info = await openSessionWithPrompt(cid, null);
      sid = info.sessionId;
      const exec = async (sql: string) => {
        const r = await api.query.execute(sid!, sql, { noSplit: true, stopOnError: true, history: true });
        const err = r.results.find((x) => x.kind === 'error');
        if (err) throw new Error(err.error?.message ?? tr('Unbekannter Fehler', 'Unknown error'));
      };
      if (!dbExists) {
        await exec(`CREATE DATABASE IF NOT EXISTS ${quoteId(schema)}`);
        push({ ok: true, text: `CREATE DATABASE ${quoteId(schema)}` });
      }
      await api.session.useDatabase(sid, schema);
      for (const s of statements) {
        try {
          await exec(s);
          push({ ok: true, text: s.split('\n')[0] });
        } catch (e) {
          push({ ok: false, text: `${s.split('\n')[0]}\n  → ${errorMessage(e)}` });
          failed = true;
          break;
        }
      }
      if (!failed) push({ ok: true, text: tr('Synchronisation abgeschlossen.', 'Synchronization finished.') });
      // remember how the server rewrote view definitions so that they compare as identical later
      const syncedViewNames = items.filter((i) => i.kind === 'view' && i.action !== 'drop' && checked.has(i.key)).map((i) => i.name);
      if (!failed && syncedViewNames.length) {
        const defs = await api.model.viewDefinitions(sid, schema, syncedViewNames);
        const synced: SyncedView[] = [];
        for (const v of doc.views) {
          const d = defs.find((x) => x.name.toLowerCase() === v.name.toLowerCase());
          if (d) synced.push({ id: v.id, source: v.definition, server: d.definition });
        }
        const byId = new Map(synced.map((s) => [s.id, s]));
        nextDoc = { ...doc, views: doc.views.map((v) => (byId.has(v.id) ? { ...v, syncedAs: { source: byId.get(v.id)!.source, server: byId.get(v.id)!.server } } : v)) };
        setDoc(nextDoc);
        onSynced(synced, { connectionId: cid, database: schema });
      } else if (!failed) onSynced([], { connectionId: cid, database: schema });
      void useWorkspace.getState().refreshConnection(cid);
    } catch (e) {
      if (!isUserCancelled(e)) push({ ok: false, text: errorMessage(e) });
      failed = true;
    } finally {
      if (sid) await api.session.close(sid).catch(() => undefined);
      setBusy(null);
    }
    if (!failed) {
      toast(tr('Datenbank synchronisiert', 'Database synchronized'), 'success');
      const logSnapshot = [...lines];
      await compare(nextDoc);
      setLog(logSnapshot);
    }
  };

  const list = (items ?? []).filter((i) => showSame || i.action !== 'same');
  const diffCount = (items ?? []).filter((i) => i.action !== 'same').length;

  return (
    <Dialog
      title={tr('Modell mit Datenbank synchronisieren', 'Synchronize Model with Database')}
      icon={<GitCompare size={16} />}
      width={1060}
      height={700}
      resizable
      noPadding
      onClose={close}
      footerLeft={items && <span className="muted">{tr('{n} Anweisungen ausgewählt', '{n} statements selected', { n: statements.length })}</span>}
      footer={
        <>
          <Button variant="primary" icon={busy === 'run' ? <Spinner size={13} /> : <Play size={14} />} disabled={!!busy || !statements.length} onClick={() => void execute()}>
            {tr('Ausführen', 'Execute')}
          </Button>
          <Button onClick={close}>{tr('Schließen', 'Close')}</Button>
        </>
      }
    >
      <div className="ks-md-split">
        <div className="ks-md-split-left">
          <div className="ks-form">
            <ConnectionDbPicker
              connectionId={cid}
              database={db}
              allowNew
              labelWidth={90}
              onChange={(c, d) => {
                setCid(c);
                setDb(d);
                setItems(null);
              }}
            />
            <Checkbox checked={dropColumns} onChange={setDropColumns} label={tr('Nicht modellierte Felder und Indizes löschen', 'Drop fields and indexes not in the model')} />
            <Checkbox checked={triggers} onChange={setTriggers} label={tr('Trigger vergleichen', 'Compare triggers')} />
            <Checkbox checked={views} onChange={setViews} label={tr('Ansichten vergleichen', 'Compare views')} />
            <Button variant="primary" icon={busy === 'compare' ? <Spinner size={13} /> : <GitCompare size={14} />} disabled={!!busy || !cid || !db.trim()} onClick={() => void compare()}>
              {tr('Vergleichen', 'Compare')}
            </Button>
          </div>
          {items && (
            <div className="muted" style={{ fontSize: 12 }}>
              {!dbExists && <div>{tr('Die Datenbank existiert noch nicht und wird angelegt.', 'The database does not exist yet and will be created.')}</div>}
              {diffCount
                ? tr('{n} von {t} Objekten unterscheiden sich.', '{n} of {t} objects differ.', { n: diffCount, t: items.length })
                : tr('Modell und Datenbank sind identisch.', 'Model and database are identical.')}
            </div>
          )}
        </div>
        <div className="ks-md-split-right">
          <div className="ks-md-pane-title">
            <b>{tr('Unterschiede', 'Differences')}</b>
            <div className="spacer" />
            <Checkbox checked={showSame} onChange={setShowSame} label={tr('Identische anzeigen', 'Show identical')} />
          </div>
          <div className="ks-sync-list" style={{ flex: '0 0 40%' }}>
            {!items && <div className="ks-md-empty">{tr('Klicken Sie auf „Vergleichen“.', 'Click "Compare".')}</div>}
            {items && !list.length && <div className="ks-md-empty">{tr('Keine Unterschiede.', 'No differences.')}</div>}
            {list.map((i) => (
              <div key={i.key} className={`ks-sync-row ${i.key === current ? 'current' : ''}`} onClick={() => setCurrent(i.key)}>
                <Checkbox
                  checked={checked.has(i.key)}
                  disabled={i.action === 'same'}
                  onChange={(v) =>
                    setChecked((s) => {
                      const n = new Set(s);
                      if (v) n.add(i.key);
                      else n.delete(i.key);
                      return n;
                    })
                  }
                />
                <span className={`ks-sync-badge ${i.action}`}>{ACTION_LABEL[i.action]()}</span>
                <span className="muted">{i.kind === 'table' ? tr('Tabelle', 'Table') : tr('Ansicht', 'View')}</span>
                <span className="ellipsis">
                  {i.name}
                  {i.renamed && i.dbName ? ` ← ${i.dbName}` : ''}
                </span>
                {i.destructive && <CircleAlert size={14} style={{ color: 'var(--danger)' }} />}
              </div>
            ))}
          </div>
          <div className="ks-md-pane-title">
            {cur ? tr('Anweisungen für „{n}“', 'Statements for "{n}"', { n: cur.name }) : tr('Alle ausgewählten Anweisungen', 'All selected statements')}
            <div className="spacer" />
            {cur && (
              <Button size="sm" variant="link" onClick={() => setCurrent(null)}>
                {tr('Alle anzeigen', 'Show all')}
              </Button>
            )}
          </div>
          <div className="ks-sql-preview selectable">
            <SqlHighlight sql={preview || tr('-- keine Anweisungen', '-- no statements')} />
          </div>
          {log.length > 0 && (
            <div className="ks-sync-log selectable">
              {log.map((l, k) => (
                <div key={k} className={l.ok ? 'ok' : 'err'}>
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

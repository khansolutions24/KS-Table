// Structure synchronization: compare the structure of two databases, review differences (DDL diff) and
// deploy the generated statements to the target.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, FileCode, GitCompare, Play, Save } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import clsx from 'clsx';
import { tr } from '@shared/i18n';
import type { StructCompareResult, StructDiffItem, StructStatus, StructSyncProfile } from '@shared/apis/sync';
import { defaultStructSyncOptions, normalizeStructSyncProfile } from '@shared/sync/defaults';
import { buildStructScript, objectTypeLabel, structScriptText } from '@shared/sync/structScript';
import { formatDateTime } from '@shared/util';
import { api } from '../../api/client';
import { ObjIcon } from '../../components/icons';
import { SqlHighlight } from '../../components/SqlHighlight';
import { TaskPanel } from '../../components/TaskPanel';
import { toast } from '../../components/Toast';
import { Checkbox, IconButton, SearchInput, Section, TabStrip, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { pickSaveFile } from '../../lib/files';
import { keyCombo } from '../../lib/shortcuts';
import { useTabs, type TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { EndpointFields, ProfileButtons, showScriptDialog, showTaskDialog, waitForTask } from './common';
import { DdlDiff } from './DdlDiff';

type View = 'setup' | 'result';

const STATUS_ORDER: StructStatus[] = ['create', 'alter', 'drop', 'same'];

function statusLabel(s: StructStatus): string {
  switch (s) {
    case 'create':
      return tr('Nur in Quelle – erstellen', 'Only in source – create');
    case 'alter':
      return tr('Unterschiedlich – ändern', 'Different – alter');
    case 'drop':
      return tr('Nur im Ziel – löschen', 'Only in target – drop');
    case 'same':
      return tr('Identisch', 'Identical');
  }
}

export default function StructSyncTab({ tab }: TabProps) {
  const [p, setP] = useState<StructSyncProfile>(() => ({
    version: 1,
    source: { connectionId: (tab.params.connectionId as string | null) ?? '', database: (tab.params.database as string | null) ?? '' },
    target: { connectionId: (tab.params.connectionId as string | null) ?? '', database: '' },
    options: defaultStructSyncOptions()
  }));
  const [view, setView] = useState<View>('setup');
  const [compareTask, setCompareTask] = useState<string | null>(null);
  const [result, setResult] = useState<StructCompareResult | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [showSame, setShowSame] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<StructStatus>>(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const profiles = useWorkspace((s) => s.profiles);
  const listRef = useRef<HTMLDivElement>(null);
  const o = p.options;

  useEffect(() => {
    const n = profiles.find((x) => x.id === p.target.connectionId)?.name;
    useTabs.getState().update(tab.id, { subtitle: n ? `${tr('Ziel', 'Target')}: ${n}${p.target.database ? ` / ${p.target.database}` : ''}` : undefined });
  }, [p.target.connectionId, p.target.database, profiles, tab.id]);

  const compare = async (profile = p) => {
    const prof = normalizeStructSyncProfile(profile);
    if (!prof.source.connectionId || !prof.source.database || !prof.target.connectionId || !prof.target.database) {
      void errorDialog(new Error(tr('Bitte Quelle und Ziel vollständig wählen.', 'Please choose source and target completely.')));
      return;
    }
    setBusy(true);
    setView('result');
    try {
      const id = await api.sync.startStructCompare(prof);
      setCompareTask(id);
      setResult(null);
      const r = await waitForTask<StructCompareResult>(id);
      setResult(r);
      setChecked(new Set(r.items.filter((i) => i.status === 'create' || i.status === 'alter' || (i.status === 'drop' && r.options.dropExtra)).map((i) => i.id)));
      setCurrent((c) => (c && r.items.some((i) => i.id === c) ? c : (r.items.find((i) => i.status !== 'same')?.id ?? r.items[0]?.id ?? null)));
      setCompareTask(null);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(false);
    }
  };

  const script = useMemo(() => (result ? buildStructScript(result.items, checked) : []), [result, checked]);
  const scriptText = () =>
    result
      ? structScriptText(script, [
          tr('KS Table – Struktursynchronisation', 'KS Table – Structure synchronization'),
          `${tr('Quelle', 'Source')}: ${profiles.find((x) => x.id === result.source.connectionId)?.name ?? ''} / ${result.source.database}`,
          `${tr('Ziel', 'Target')}: ${profiles.find((x) => x.id === result.target.connectionId)?.name ?? ''} / ${result.target.database}`,
          `${tr('Erstellt', 'Created')}: ${formatDateTime(Date.now())}`
        ])
      : '';

  const deploy = async () => {
    if (!result || !script.length) return;
    const drops = result.items.filter((i) => i.status === 'drop' && checked.has(i.id)).length;
    const ok = await confirmDialog({
      title: tr('Struktursynchronisation ausführen', 'Run Structure Synchronization'),
      message:
        tr('{n} Anweisungen werden in „{d}“ ausgeführt.', '{n} statements will be executed in "{d}".', { n: script.length, d: result.target.database }) +
        (drops ? `\n\n${tr('Achtung: {k} Objekte werden gelöscht.', 'Warning: {k} objects will be dropped.', { k: drops })}` : ''),
      danger: true,
      okLabel: tr('Ausführen', 'Execute')
    });
    if (!ok) return;
    try {
      const id = await api.sync.startStructDeploy(result.target, script, o.continueOnError);
      await showTaskDialog(id, tr('Struktursynchronisation', 'Structure Synchronization'));
      if (useWorkspace.getState().conns[result.target.connectionId]?.dbs[result.target.database]?.loaded) {
        void useWorkspace.getState().refreshDatabase(result.target.connectionId, result.target.database);
      }
      await compare({ ...p, source: result.source, target: result.target });
    } catch (e) {
      void errorDialog(e);
    }
  };

  const saveScript = async () => {
    if (!script.length) return;
    const file = await pickSaveFile({ title: tr('Skript speichern', 'Save Script'), defaultPath: `${result?.target.database ?? 'sync'}_structure.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (!file) return;
    try {
      await api.fs.writeText(file, scriptText());
      toast(tr('Skript gespeichert', 'Script saved'), 'success');
    } catch (e) {
      void errorDialog(e);
    }
  };

  const swap = () => setP((x) => ({ ...x, source: x.target, target: x.source }));
  const setOpt = (k: keyof StructSyncProfile['options'], v: boolean) => setP((x) => ({ ...x, options: { ...x.options, [k]: v } }));
  const opt = (k: keyof StructSyncProfile['options'], label: string) => <Checkbox checked={o[k]} disabled={busy} onChange={(v) => setOpt(k, v)} label={label} />;

  // ── result list
  const filter = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const items = (result?.items ?? []).filter((i) => !filter || i.name.toLowerCase().includes(filter));
    return STATUS_ORDER.filter((s) => s !== 'same' || showSame)
      .map((s) => ({
        status: s,
        items: items.filter((i) => i.status === s).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
      }))
      .filter((g) => g.items.length);
  }, [result, filter, showSame]);
  const visible = groups.flatMap((g) => (collapsed.has(g.status) ? [] : g.items));
  const item: StructDiffItem | undefined = result?.items.find((i) => i.id === current);
  const toggle = (ids: string[], on: boolean) =>
    setChecked((c) => {
      const n = new Set(c);
      for (const id of ids) if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const onListKey = (e: React.KeyboardEvent) => {
    const combo = keyCombo(e);
    const idx = visible.findIndex((i) => i.id === current);
    if (combo === 'ArrowDown' || combo === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const next = visible[Math.max(0, Math.min(visible.length - 1, idx + (combo === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        setCurrent(next.id);
        listRef.current?.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (combo === 'Space' && item && item.status !== 'same') {
      e.preventDefault();
      e.stopPropagation();
      toggle([item.id], !checked.has(item.id));
    }
  };

  const counts = STATUS_ORDER.map((s) => ({ s, n: result?.items.filter((i) => i.status === s).length ?? 0 }));

  return (
    <div className="ks-sync">
      <Toolbar>
        <ProfileButtons
          kind="structSync"
          current={() => normalizeStructSyncProfile(p)}
          onLoad={(d) => {
            setP(normalizeStructSyncProfile(d));
            setView('setup');
          }}
        />
        <ToolbarSep />
        <ToolbarButton icon={<GitCompare size={15} />} label={tr('Vergleichen', 'Compare')} disabled={busy} onClick={() => void compare()} />
        <ToolbarButton icon={<FileCode size={15} />} label={tr('Skript anzeigen', 'Show Script')} disabled={busy || !script.length} onClick={() => void showScriptDialog({ title: tr('Bereitstellungsskript', 'Deployment Script'), sql: scriptText(), connectionId: result?.target.connectionId, database: result?.target.database })} />
        <ToolbarButton icon={<Save size={15} />} label={tr('Skript speichern', 'Save Script')} disabled={busy || !script.length} onClick={() => void saveScript()} />
        <ToolbarButton icon={<Play size={15} />} label={tr('Ausführen', 'Execute')} disabled={busy || !script.length} onClick={() => void deploy()} />
      </Toolbar>
      <TabStrip<View>
        value={view}
        onChange={setView}
        tabs={[
          { id: 'setup', label: tr('Quelle, Ziel und Optionen', 'Source, Target and Options') },
          { id: 'result', label: tr('Ergebnis', 'Result'), hidden: !result && !compareTask }
        ]}
      />
      <div className="ks-sync-body">
        {view === 'setup' && (
          <div className="ks-sync-scroll">
            <div className="ks-sync-endpoints">
              <EndpointFields title={tr('Quelle', 'Source')} connectionId={p.source.connectionId} database={p.source.database} disabled={busy} onChange={(connectionId, database) => setP((x) => ({ ...x, source: { connectionId, database } }))} />
              <IconButton className="ks-sync-swap" icon={<ArrowLeftRight size={16} />} title={tr('Quelle und Ziel tauschen', 'Swap source and target')} disabled={busy} onClick={swap} />
              <EndpointFields title={tr('Ziel', 'Target')} connectionId={p.target.connectionId} database={p.target.database} disabled={busy} onChange={(connectionId, database) => setP((x) => ({ ...x, target: { connectionId, database } }))} />
            </div>
            <Section title={tr('Vergleichsoptionen', 'Compare Options')}>
              <div className="ks-sync-options">
                {opt('ignoreAutoIncrement', tr('AUTO_INCREMENT-Wert ignorieren', 'Ignore AUTO_INCREMENT value'))}
                {opt('ignoreComments', tr('Kommentare ignorieren', 'Ignore comments'))}
                {opt('ignoreCharset', tr('Zeichensatz und Sortierung ignorieren', 'Ignore character set and collation'))}
                {opt('ignoreDefiner', tr('DEFINER ignorieren', 'Ignore DEFINER'))}
                {opt('ignoreTableOptions', tr('Tabellenoptionen ignorieren', 'Ignore table options'))}
                {opt('ignorePartitions', tr('Partitionierung ignorieren', 'Ignore partitioning'))}
              </div>
            </Section>
            <Section title={tr('Objekte', 'Objects')}>
              <div className="ks-sync-options">
                {opt('views', tr('Ansichten vergleichen', 'Compare views'))}
                {opt('routines', tr('Funktionen und Prozeduren vergleichen', 'Compare functions and procedures'))}
                {opt('triggers', tr('Trigger vergleichen', 'Compare triggers'))}
                {opt('events', tr('Ereignisse vergleichen', 'Compare events'))}
                {opt('dropExtra', tr('Objekte, die nur im Ziel existieren, zum Löschen vormerken', 'Mark objects that only exist in the target for deletion'))}
                {opt('continueOnError', tr('Bei Fehlern fortfahren', 'Continue on error'))}
              </div>
            </Section>
          </div>
        )}

        {view === 'result' && !result && compareTask && (
          <div className="ks-sync-scroll">
            <TaskPanel taskId={compareTask} />
          </div>
        )}

        {view === 'result' && result && (
          <Group orientation="horizontal" className="ks-sync-split">
            <Panel defaultSize="36" minSize={220}>
              <div className="ks-sync-pane">
                <div className="ks-sync-pane-head">
                  <Checkbox
                    checked={visible.filter((i) => i.status !== 'same').every((i) => checked.has(i.id)) && visible.some((i) => i.status !== 'same')}
                    onChange={(v) => toggle(visible.filter((i) => i.status !== 'same').map((i) => i.id), v)}
                    title={tr('Alle auswählen', 'Select all')}
                  />
                  <SearchInput value={search} onChange={setSearch} className="grow" />
                  <Checkbox checked={showSame} onChange={setShowSame} label={tr('Identische', 'Identical')} />
                </div>
                <div className="ks-sync-list" style={{ border: 'none', borderRadius: 0 }} tabIndex={0} ref={listRef} onKeyDown={onListKey}>
                  {!groups.length ? (
                    <div className="ks-sync-empty">
                      {result.items.every((i) => i.status === 'same') ? tr('Die Strukturen sind identisch.', 'The structures are identical.') : tr('Keine Treffer', 'No matches')}
                    </div>
                  ) : (
                    <table className="ks-table">
                      <tbody>
                        {groups.map((g) => {
                          const selectable = g.items.filter(() => g.status !== 'same');
                          const n = selectable.filter((i) => checked.has(i.id)).length;
                          return [
                            <tr key={`g:${g.status}`} className="group">
                              <td className="chk">
                                {g.status !== 'same' && (
                                  <Checkbox checked={n === selectable.length} indeterminate={n > 0 && n < selectable.length} onChange={(v) => toggle(selectable.map((i) => i.id), v)} />
                                )}
                              </td>
                              <td
                                onClick={() =>
                                  setCollapsed((c) => {
                                    const x = new Set(c);
                                    if (x.has(g.status)) x.delete(g.status);
                                    else x.add(g.status);
                                    return x;
                                  })
                                }
                              >
                                <span className={`ks-sync-status ${g.status}`}>
                                  {collapsed.has(g.status) ? '▸' : '▾'} {statusLabel(g.status)} ({g.items.length})
                                </span>
                              </td>
                            </tr>,
                            ...(collapsed.has(g.status)
                              ? []
                              : g.items.map((i) => (
                                  <tr key={i.id} data-id={i.id} className={clsx(current === i.id && 'selected')} onMouseDown={() => setCurrent(i.id)}>
                                    <td className="chk">{i.status !== 'same' && <Checkbox checked={checked.has(i.id)} onChange={(v) => toggle([i.id], v)} />}</td>
                                    <td title={`${objectTypeLabel(i.type)} ${i.name}${i.table ? ` (${i.table})` : ''}`}>
                                      <span className="ks-sync-name">
                                        <ObjIcon kind={i.type} size={14} />
                                        {i.name}
                                        {i.table && <span className="faint">({i.table})</span>}
                                      </span>
                                    </td>
                                  </tr>
                                )))
                          ];
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </Panel>
            <Separator className="ks-sync-sep v" />
            <Panel minSize={300}>
              <Group orientation="vertical" className="ks-sync-split">
                <Panel defaultSize="62" minSize={120}>
                  <div className="ks-sync-pane">
                    <div className="ks-sync-pane-head">
                      <span className="grow ellipsis">
                        <b>{tr('Quelle', 'Source')}</b>: {result.source.database}
                      </span>
                      <span className="grow ellipsis">
                        <b>{tr('Ziel', 'Target')}</b>: {result.target.database}
                      </span>
                    </div>
                    {item && item.details.length > 0 && (
                      <ul className="ks-sync-details">
                        {item.details.map((d, k) => (
                          <li key={k}>{d}</li>
                        ))}
                      </ul>
                    )}
                    <div className="ks-sync-pane-body">{item ? <DdlDiff original={item.sourceDdl} modified={item.targetDdl} /> : <div className="ks-sync-empty">{tr('Kein Objekt ausgewählt', 'No object selected')}</div>}</div>
                  </div>
                </Panel>
                <Separator className="ks-sync-sep h" />
                <Panel minSize={80}>
                  <div className="ks-sync-pane">
                    <div className="ks-sync-pane-head">{tr('Anweisungen für das ausgewählte Objekt', 'Statements for the selected object')}</div>
                    <div className="ks-sql-preview">
                      {item && item.statements.length ? (
                        <SqlHighlight className="selectable" sql={item.statements.map((s) => `${s.sql.trim()};`).join('\n\n')} />
                      ) : (
                        <div className="ks-sync-empty">{tr('Keine Änderungen', 'No changes')}</div>
                      )}
                    </div>
                  </div>
                </Panel>
              </Group>
            </Panel>
          </Group>
        )}
      </div>
      <div className="ks-statusline">
        {result ? (
          <>
            {counts.map((c) => (
              <span key={c.s} className={`ks-sync-status ${c.s}`}>
                {statusLabel(c.s)}: {c.n}
              </span>
            ))}
            <span>{tr('{n} Anweisungen ausgewählt', '{n} statements selected', { n: script.length })}</span>
          </>
        ) : (
          <span>{tr('Quelle und Ziel wählen und „Vergleichen“ klicken.', 'Choose source and target and click "Compare".')}</span>
        )}
      </div>
    </div>
  );
}

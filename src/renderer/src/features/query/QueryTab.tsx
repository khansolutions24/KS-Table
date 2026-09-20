// Query editor tab: SQL editor with own session, execution, results, explain, profiling, transactions, snippets, saving.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import clsx from 'clsx';
import {
  CaseLower,
  CaseUpper,
  Code,
  FolderOpen,
  Gauge,
  ListTree,
  Minimize2,
  Play,
  RotateCcw,
  Save,
  Square,
  Undo2,
  WandSparkles,
  Workflow,
  Check
} from 'lucide-react';
import type { Snippet } from '@shared/apis/snippets';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { isUnsafeWrite, splitStatements, statementAt, type SplitStatement } from '@shared/sql/splitter';
import type { ServerInfo } from '@shared/types';
import { formatDuration, formatNumber, safeFileName } from '@shared/util';
import { api, errorMessage, onEvent } from '../../api/client';
import { beautifySql, minifySql } from '../../components/editor/monaco';
import { SqlEditor, monaco, type MonacoEditor } from '../../components/editor/SqlEditor';
import { ObjIcon } from '../../components/icons';
import { toast } from '../../components/Toast';
import { askDialog, confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { Checkbox, IconButton, SearchInput, Select, Spinner, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { SEP, showMenuBelow } from '../../components/ui/Menu';
import { keyCombo } from '../../lib/shortcuts';
import { baseName, joinPath, pickOpenFile, pickSaveFile, stripExt } from '../../lib/files';
import { getSettings } from '../../store/settings';
import { setCloseGuard, useTabs, type TabProps } from '../../store/tabs';
import { getProfile, isUserCancelled, openSessionWithPrompt, queriesDir, useWorkspace } from '../../store/workspace';
import { openQueryBuilder } from '../queryBuilder';
import { openParamsDialog, openSaveQueryDialog } from './dialogs';
import { pendingCount } from './gridEdits';
import { createQueryStore, newResultSet, patchResult, visibleTabIds, type ResultSet, type ResultsHost } from './queryStore';
import { ResultsPanel } from './ResultsPanel';
import { resultNameIn } from './resultNames';
import { collectProfiles, detectEditable, execChecked, maxProfileId, runExplain, statusSnapshot, type MetaCache } from './runner';
import { ensureSnippetCompletion, loadSnippets } from './snippetSource';
import { paramNames, substituteParams, type ParamValue } from './sqlParams';
import { statusDelta } from './statusDiff';
import { foldTxState, nextTxState, type TxState } from './txState';
import './query.css';

interface QueryParams {
  connectionId: string;
  database: string | null;
  sql: string | null;
  file: string | null;
  saved?: boolean;
}

const MAX_RESULT_TABS = 30;
const i15 = { size: 15 };

/** Keys the tab handles itself (stop them from reaching the global shortcuts) */
const TAB_KEYS = new Set(['Ctrl+R', 'F9', 'Ctrl+Shift+R', 'Ctrl+E', 'Ctrl+S', 'Ctrl+Shift+F', 'Ctrl+T', 'Ctrl+Shift+S']);

export default function QueryTab({ tab, active }: TabProps) {
  const params = tab.params as unknown as QueryParams;
  const store = useMemo(() => createQueryStore(), []);
  const running = store((s) => s.running);
  const cancelling = store((s) => s.cancelling);
  const progress = store((s) => s.progress);
  const lastRun = store((s) => s.lastRun);

  const [cid, setCid] = useState(params.connectionId);
  const [db, setDb] = useState<string | null>(params.database ?? null);
  const [text, setText] = useState(params.file ? '' : (params.sql ?? ''));
  const [savedText, setSavedText] = useState('');
  const [file, setFile] = useState<string | null>(params.file ?? null);
  const [savedQuery, setSavedQuery] = useState(!!params.saved);
  const [loading, setLoading] = useState(!!params.file);
  const [sessionState, setSessionState] = useState<'idle' | 'connecting' | 'open' | 'error'>('idle');
  const [server, setServer] = useState<ServerInfo | undefined>();
  const [tx, setTx] = useState<TxState>({ autocommit: true, open: false });
  const [wantAutocommit, setWantAutocommit] = useState(() => getSettings().query.autoCommit);
  const [stopOnError, setStopOnError] = useState(() => getSettings().query.stopOnError);
  const [profiling, setProfiling] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0 });

  const profiles = useWorkspace((s) => s.profiles);
  const conn = useWorkspace((s) => s.conns[cid]);
  const profilesDir = useWorkspace((s) => s.profilesDir);

  const editorRef = useRef<MonacoEditor | null>(null);
  const sessionRef = useRef<{ id: string; cid: string } | null>(null);
  const openingRef = useRef<Promise<string> | null>(null);
  const unmounted = useRef(false);
  const profilingApplied = useRef(false);
  const paramValues = useRef<Record<string, ParamValue>>({});
  const runMap = useRef<{ start: number; end: number }[]>([]);
  const metaCache = useRef<MetaCache>(new Map());
  const s = useRef({ cid, db, text, savedText, file, savedQuery, tx, wantAutocommit, stopOnError, profiling, active, server });
  s.current = { cid, db, text, savedText, file, savedQuery, tx, wantAutocommit, stopOnError, profiling, active, server };

  const dirty = text !== savedText;
  const profile = profiles.find((p) => p.id === cid);

  // ───────────── session ─────────────

  const closeSession = useCallback(async () => {
    const cur = sessionRef.current;
    sessionRef.current = null;
    openingRef.current = null;
    profilingApplied.current = false;
    if (cur) await api.session.close(cur.id).catch(() => undefined);
  }, []);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current && sessionRef.current.cid === s.current.cid) return sessionRef.current.id;
    if (openingRef.current) return openingRef.current;
    const connectionId = s.current.cid;
    const p = (async () => {
      setSessionState('connecting');
      try {
        await useWorkspace.getState().openConnection(connectionId);
        let info;
        try {
          info = await openSessionWithPrompt(connectionId, s.current.db);
        } catch (e) {
          // database may no longer exist: open without it
          if (!s.current.db || isUserCancelled(e)) throw e;
          info = await openSessionWithPrompt(connectionId, null);
          toast(errorMessage(e), 'error');
          setDb(null);
        }
        if (unmounted.current || s.current.cid !== connectionId) {
          await api.session.close(info.sessionId).catch(() => undefined);
          throw new Error(tr('Die Sitzung wurde verworfen.', 'The session was discarded.'));
        }
        sessionRef.current = { id: info.sessionId, cid: connectionId };
        setServer(info.server);
        let st: TxState = { autocommit: true, open: false };
        if (!s.current.wantAutocommit) {
          await execChecked(info.sessionId, 'SET autocommit = 0');
          st = { autocommit: false, open: false };
        }
        setTx(st);
        setSessionState('open');
        return info.sessionId;
      } catch (e) {
        setSessionState(isUserCancelled(e) ? 'idle' : 'error');
        throw e;
      } finally {
        openingRef.current = null;
      }
    })();
    openingRef.current = p;
    return p;
  }, []);

  useEffect(() => {
    unmounted.current = false;
    void ensureSession().catch((e) => {
      if (!isUserCancelled(e) && !unmounted.current) void errorDialog(e, tr('Verbindung fehlgeschlagen', 'Connection failed'));
    });
    ensureSnippetCompletion();
    return () => {
      unmounted.current = true;
      void closeSession();
    };
  }, [ensureSession, closeSession]);

  useEffect(
    () =>
      onEvent('session:lost', (e) => {
        if (e.sessionId !== sessionRef.current?.id) return;
        profilingApplied.current = false;
        const wasOpen = s.current.tx.open;
        const sid = e.sessionId;
        setTx({ autocommit: true, open: false });
        if (!s.current.wantAutocommit) void execChecked(sid, 'SET autocommit = 0').then(() => setTx({ autocommit: false, open: false }), () => undefined);
        toast(
          wasOpen
            ? tr('Die Verbindung wurde wiederhergestellt – die offene Transaktion ist verloren.', 'The connection was re-established – the open transaction is lost.')
            : e.message,
          wasOpen ? 'error' : 'info'
        );
      }),
    []
  );

  // ───────────── file loading, dirty state, close guard ─────────────

  useEffect(() => {
    if (!params.file) return;
    let cancelled = false;
    api.fs
      .readText(params.file)
      .then((t) => {
        if (cancelled) return;
        setText(t);
        setSavedText(t);
      })
      .catch((e) => !cancelled && void errorDialog(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!!tab.dirty !== dirty) useTabs.getState().update(tab.id, { dirty });
  }, [dirty, tab.id, tab.dirty]);

  useEffect(() => {
    const subtitle = `${getProfile(cid)?.name ?? ''}${db ? ` / ${db}` : ''}${file ? `\n${file}` : ''}`;
    if (tab.subtitle !== subtitle || tab.connectionId !== cid) useTabs.getState().update(tab.id, { subtitle, connectionId: cid });
  }, [cid, db, file, tab.id, tab.subtitle, tab.connectionId, profiles]);

  // ───────────── editor helpers ─────────────

  const model = () => editorRef.current?.getModel() ?? null;

  const replaceRange = (range: monaco.IRange, value: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.pushUndoStop();
    ed.executeEdits('ks-query', [{ range, text: value, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.focus();
  };

  const selectionOrAll = (): { range: monaco.IRange; text: string; isSelection: boolean } | null => {
    const ed = editorRef.current;
    const m = model();
    if (!ed || !m) return null;
    const sel = ed.getSelection();
    if (sel && !sel.isEmpty()) return { range: sel, text: m.getValueInRange(sel), isSelection: true };
    return { range: m.getFullModelRange(), text: m.getValue(), isSelection: false };
  };

  /** Text to execute: selection, the statement at the cursor, or everything */
  const executionTarget = (mode: 'all' | 'current'): { text: string; offset: number } | null => {
    const ed = editorRef.current;
    const m = model();
    if (!ed || !m) return null;
    const sel = ed.getSelection();
    if (sel && !sel.isEmpty()) return { text: m.getValueInRange(sel), offset: m.getOffsetAt(sel.getStartPosition()) };
    const full = m.getValue();
    if (mode === 'all') return { text: full, offset: 0 };
    const pos = ed.getPosition();
    const st = statementAt(full, pos ? m.getOffsetAt(pos) : 0);
    if (!st) return null;
    return { text: full.slice(st.start, st.end + st.delimiter.length), offset: st.start };
  };

  const selectOffsets = (start: number, end: number) => {
    const ed = editorRef.current;
    const m = model();
    if (!ed || !m) return;
    const len = m.getValueLength();
    const a = m.getPositionAt(Math.min(start, len));
    const b = m.getPositionAt(Math.min(end, len));
    const sel = new monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column);
    ed.setSelection(sel);
    ed.revealRangeInCenterIfOutsideViewport(sel);
    ed.focus();
  };

  // ───────────── execution ─────────────

  const applyProfiling = async (sid: string, on: boolean) => {
    if (profilingApplied.current === on) return;
    await execChecked(sid, `SET profiling = ${on ? 1 : 0}`);
    profilingApplied.current = on;
  };

  const run = async (mode: 'all' | 'current') => {
    if (store.getState().running) return;
    const target = executionTarget(mode);
    if (!target || !target.text.trim()) {
      toast(tr('Keine Anweisung zum Ausführen.', 'No statement to run.'));
      return;
    }
    const statements: SplitStatement[] = splitStatements(target.text);
    if (!statements.length) {
      toast(tr('Keine Anweisung zum Ausführen.', 'No statement to run.'));
      return;
    }
    const pendingResults = store.getState().results.filter((r) => !r.pinned && pendingCount(r.editState) > 0);
    if (
      pendingResults.length &&
      !(await confirmDialog({
        message: tr('Ergebnisse mit nicht übernommenen Änderungen werden ersetzt. Änderungen verwerfen?', 'Results with changes that were not applied will be replaced. Discard the changes?'),
        okLabel: tr('Verwerfen', 'Discard'),
        danger: true
      }))
    )
      return;

    // parameters
    let sql = target.text;
    const names = paramNames(sql);
    if (names.length) {
      const values = await openParamsDialog(names, paramValues.current);
      if (!values) return;
      paramValues.current = { ...paramValues.current, ...values };
      try {
        sql = substituteParams(sql, values);
      } catch (e) {
        void errorDialog(e);
        return;
      }
    }

    if (getSettings().query.confirmUnsafe) {
      const unsafe = splitStatements(sql).filter((x) => isUnsafeWrite(x.sql));
      if (
        unsafe.length &&
        !(await confirmDialog({
          title: tr('Ohne WHERE-Bedingung', 'Without WHERE condition'),
          message: tr(
            'Die folgende(n) Anweisung(en) ändern oder löschen alle Datensätze der Tabelle:\n\n{s}\n\nTrotzdem ausführen?',
            'The following statement(s) change or delete all records of the table:\n\n{s}\n\nRun anyway?',
            { s: unsafe.map((u) => `• ${u.sql.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n') }
          ),
          okLabel: tr('Ausführen', 'Run'),
          danger: true
        }))
      )
        return;
    }

    let sid: string;
    try {
      sid = await ensureSession();
    } catch (e) {
      if (!isUserCancelled(e)) void errorDialog(e);
      return;
    }

    const queryId = newId('q');
    const startedAt = Date.now();
    store.setState({ running: 'run', cancelling: false, progress: { index: 0, total: statements.length, sql: statements[0].sql }, startedAt });
    const off = onEvent('query:progress', (e) => {
      if (e.queryId === queryId) store.setState({ progress: { index: e.index, total: e.total, sql: e.sql } });
    });
    const wantProfile = s.current.profiling;
    let profileStart = 0;
    let snapA: Map<string, number> | null = null;
    let snapB: Map<string, number> | null = null;
    let profileError: string | null = null;
    try {
      if (wantProfile) {
        try {
          await applyProfiling(sid, true);
          profileStart = await maxProfileId(sid);
          snapA = await statusSnapshot(sid);
          snapB = await statusSnapshot(sid);
        } catch (e) {
          profileError = errorMessage(e);
        }
      } else if (profilingApplied.current) {
        await applyProfiling(sid, false).catch(() => undefined);
      }

      const res = await api.query.execute(sid, sql, { maxRows: getSettings().query.maxRows, stopOnError: s.current.stopOnError, queryId });

      // map statements back to the editor (only when the text was not changed by parameters)
      const executed = splitStatements(sql);
      const mapped = executed.length === statements.length;
      runMap.current = mapped ? statements.map((x) => ({ start: target.offset + x.start, end: target.offset + x.end })) : [];

      // results
      const keep = store.getState().results.filter((r) => r.pinned);
      const fresh: ResultSet[] = [];
      let hidden = 0;
      let rows = 0;
      let affected = 0;
      const perStatement = new Map<number, number>();
      for (const r of res.results) {
        if (r.kind === 'ok') affected += r.affectedRows ?? 0;
        if (r.kind !== 'resultset') continue;
        rows += r.rows?.length ?? 0;
        if (keep.length + fresh.length >= MAX_RESULT_TABS) {
          hidden++;
          continue;
        }
        const n = (perStatement.get(r.index) ?? 0) + 1;
        perStatement.set(r.index, n);
        const st = statements[r.index];
        const prevEnd = r.index > 0 && statements[r.index - 1] ? statements[r.index - 1].end : 0;
        const named = mapped && st ? resultNameIn(target.text.slice(prevEnd, st.start)) : null;
        const title = named ? (n > 1 ? `${named} (${n})` : named) : tr('Ergebnis {n}', 'Result {n}', { n: keep.length + fresh.length + 1 });
        fresh.push(
          newResultSet({
            title,
            statementIndex: r.index,
            sql: r.sql,
            columns: r.columns ?? [],
            rows: r.rows ?? [],
            truncated: !!r.truncated,
            durationMs: r.durationMs,
            startedAt: r.startedAt
          })
        );
      }
      const errors = res.results.filter((r) => r.kind === 'error');

      // transaction state
      setTx((cur) => foldTxState(cur, res.results.map((r) => ({ sql: r.sql, ok: r.kind !== 'error', errno: r.error?.errno }))));
      if (res.database !== s.current.db) setDb(res.database);

      // profiling
      let profileData = null;
      let statusData = null;
      if (wantProfile && !profileError) {
        try {
          const snapC = await statusSnapshot(sid);
          statusData = snapA && snapB ? statusDelta(snapA, snapB, snapC) : null;
          profileData = await collectProfiles(sid, profileStart);
        } catch (e) {
          profileError = errorMessage(e);
        }
      }

      const prevActive = store.getState().activeTab;
      store.setState({
        results: [...keep, ...fresh],
        messages: { runId: queryId, results: res.results, totalMs: res.totalMs, cancelled: res.cancelled, mapped, startedAt, hiddenResults: hidden },
        profile: wantProfile ? profileData : null,
        profileError: wantProfile ? profileError : null,
        status: wantProfile ? statusData : null,
        activeTab: errors.length || !fresh.length ? (wantProfile && !errors.length && !fresh.length ? 'profile' : 'messages') : fresh[0].id,
        lastRun: { totalMs: res.totalMs, rows, affected, statements: res.results.length, errors: errors.length, cancelled: res.cancelled }
      });
      if (keep.some((k) => k.id === prevActive) && !errors.length && !fresh.length) store.setState({ activeTab: prevActive });
      if (errors.length === 1 && mapped && res.results.length > 1) {
        const i = errors[0].index;
        if (runMap.current[i]) selectOffsets(runMap.current[i].start, runMap.current[i].end);
      }

      // editable detection
      const connectionId = s.current.cid;
      for (const r of fresh) {
        void detectEditable(connectionId, r.columns, metaCache.current).then(({ info, reason }) => {
          patchResult(store, r.id, { editable: info, readOnlyReason: info ? null : reason });
        });
      }
      if (res.results.some((r) => /^\s*(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(r.sql) && r.kind !== 'error')) {
        metaCache.current.clear();
        const d = s.current.db;
        if (d && useWorkspace.getState().conns[connectionId]?.dbs[d]?.loaded) void useWorkspace.getState().refreshDatabase(connectionId, d, ['tables', 'views', 'routines', 'events']);
      }
    } catch (e) {
      void errorDialog(e);
    } finally {
      off();
      store.setState({ running: null, cancelling: false, progress: null });
    }
  };

  const stop = async () => {
    const sid = sessionRef.current?.id;
    if (!store.getState().running || !sid) return;
    store.setState({ cancelling: true });
    try {
      await api.query.cancel(sid);
    } catch (e) {
      void errorDialog(e);
    }
  };

  const explain = async () => {
    if (store.getState().running) return;
    const target = executionTarget('current');
    const stmt = target ? splitStatements(target.text)[0]?.sql : undefined;
    if (!stmt) {
      toast(tr('Keine Anweisung zum Erklären.', 'No statement to explain.'));
      return;
    }
    let sql = stmt;
    const names = paramNames(sql);
    if (names.length) {
      const values = await openParamsDialog(names, paramValues.current);
      if (!values) return;
      paramValues.current = { ...paramValues.current, ...values };
      sql = substituteParams(sql, values);
    }
    let sid: string;
    try {
      sid = await ensureSession();
    } catch (e) {
      if (!isUserCancelled(e)) void errorDialog(e);
      return;
    }
    store.setState({ running: 'explain', startedAt: Date.now() });
    try {
      const data = await runExplain(sid, sql, s.current.server);
      store.setState({ explain: data, activeTab: 'explain' });
    } catch (e) {
      void errorDialog(e);
    } finally {
      store.setState({ running: null });
    }
  };

  // ───────────── transactions ─────────────

  const txCommand = async (sql: 'START TRANSACTION' | 'COMMIT' | 'ROLLBACK') => {
    try {
      const sid = await ensureSession();
      await execChecked(sid, sql, true);
      setTx((cur) => nextTxState(cur, sql, true));
      toast(sql === 'START TRANSACTION' ? tr('Transaktion gestartet', 'Transaction started') : sql === 'COMMIT' ? tr('Transaktion bestätigt', 'Transaction committed') : tr('Transaktion zurückgesetzt', 'Transaction rolled back'), 'success');
    } catch (e) {
      if (!isUserCancelled(e)) void errorDialog(e);
    }
  };

  const setAutocommit = async (on: boolean) => {
    if (on && s.current.tx.open) {
      const ok = await confirmDialog({
        message: tr('Beim Einschalten von Auto-Commit wird die offene Transaktion bestätigt (COMMIT). Fortfahren?', 'Turning on auto-commit commits the open transaction. Continue?'),
        okLabel: tr('Bestätigen', 'Commit')
      });
      if (!ok) return;
    }
    setWantAutocommit(on);
    if (!sessionRef.current) return;
    try {
      const sql = `SET autocommit = ${on ? 1 : 0}`;
      await execChecked(sessionRef.current.id, sql, true);
      setTx((cur) => nextTxState(cur, sql, true));
    } catch (e) {
      void errorDialog(e);
    }
  };

  // ───────────── connection / database ─────────────

  const confirmLoseTx = async (): Promise<boolean> =>
    !s.current.tx.open ||
    confirmDialog({
      message: tr('Die offene Transaktion wird dabei zurückgesetzt (ROLLBACK). Fortfahren?', 'The open transaction will be rolled back. Continue?'),
      okLabel: tr('Fortfahren', 'Continue'),
      danger: true
    });

  const changeConnection = async (next: string) => {
    if (next === s.current.cid || store.getState().running) return;
    if (!(await confirmLoseTx())) return;
    await closeSession();
    setCid(next);
    s.current.cid = next;
    setDb(null);
    s.current.db = null;
    setServer(undefined);
    setTx({ autocommit: true, open: false });
    metaCache.current.clear();
    store.setState((st) => ({
      results: st.results
        .filter((r) => r.pinned)
        .map((r) => ({ ...r, editable: null, readOnlyReason: tr('Das Ergebnis stammt von einer anderen Verbindung.', 'The result comes from another connection.') })),
      activeTab: 'messages'
    }));
    useTabs.getState().updateParams(tab.id, { connectionId: next, database: null });
    void ensureSession().catch((e) => !isUserCancelled(e) && void errorDialog(e, tr('Verbindung fehlgeschlagen', 'Connection failed')));
  };

  const changeDatabase = async (next: string) => {
    if (!next || next === s.current.db || store.getState().running) return;
    try {
      const sid = await ensureSession();
      await api.session.useDatabase(sid, next);
      setDb(next);
      useTabs.getState().updateParams(tab.id, { database: next });
    } catch (e) {
      if (!isUserCancelled(e)) void errorDialog(e);
    }
  };

  // ───────────── saving / opening ─────────────

  const writeFile = async (path: string, content: string) => {
    await api.fs.writeText(path, content);
    setSavedText(content);
  };

  const saveToQueries = async (): Promise<boolean> => {
    const conns = useWorkspace.getState().conns[s.current.cid];
    const name = s.current.file ? stripExt(baseName(s.current.file)) : tr('Neue Abfrage', 'New query');
    const choice = await openSaveQueryDialog({ name, database: s.current.db, databases: (conns?.databases ?? []).map((d) => d.name) });
    if (!choice) return false;
    const dir = queriesDir(useWorkspace.getState().profilesDir, s.current.cid, choice.database);
    const path = joinPath(dir, `${safeFileName(choice.name)}.sql`);
    try {
      const st = await api.fs.stat(path);
      if (st.exists && path.toLowerCase() !== (s.current.file ?? '').toLowerCase()) {
        const ok = await confirmDialog({
          message: tr('Die Abfrage „{n}“ existiert bereits. Überschreiben?', 'The query "{n}" already exists. Overwrite?', { n: choice.name }),
          okLabel: tr('Überschreiben', 'Overwrite'),
          danger: true
        });
        if (!ok) return false;
      }
      const content = s.current.text;
      await writeFile(path, content);
      setFile(path);
      setSavedQuery(true);
      useTabs.getState().update(tab.id, { title: `${stripExt(baseName(path))} @${choice.database}`, key: `query:${path.toLowerCase()}` });
      useTabs.getState().updateParams(tab.id, { file: path, saved: true });
      if (useWorkspace.getState().conns[s.current.cid]?.status === 'open') void useWorkspace.getState().refreshDatabase(s.current.cid, choice.database, ['queries']);
      toast(tr('Abfrage gespeichert', 'Query saved'), 'success');
      return true;
    } catch (e) {
      void errorDialog(e);
      return false;
    }
  };

  const save = async (): Promise<boolean> => {
    const f = s.current.file;
    if (!f) return saveToQueries();
    try {
      await writeFile(f, s.current.text);
      toast(tr('Gespeichert', 'Saved'), 'success');
      return true;
    } catch (e) {
      void errorDialog(e);
      return false;
    }
  };

  const saveAs = async (): Promise<boolean> => {
    const path = await pickSaveFile({
      title: tr('Speichern unter', 'Save as'),
      defaultPath: s.current.file ?? `${tr('Abfrage', 'query')}.sql`,
      filters: [
        { name: 'SQL', extensions: ['sql'] },
        { name: tr('Alle Dateien', 'All files'), extensions: ['*'] }
      ]
    });
    if (!path) return false;
    try {
      await writeFile(path, s.current.text);
      setFile(path);
      setSavedQuery(false);
      useTabs.getState().update(tab.id, { title: baseName(path), key: `query:${path.toLowerCase()}` });
      useTabs.getState().updateParams(tab.id, { file: path, saved: false });
      toast(tr('Gespeichert', 'Saved'), 'success');
      return true;
    } catch (e) {
      void errorDialog(e);
      return false;
    }
  };

  const openFile = async () => {
    if (s.current.text !== s.current.savedText && s.current.text.trim()) {
      const a = await askDialog({ message: tr('Änderungen an dieser Abfrage speichern?', 'Save changes to this query?') });
      if (a === 'cancel' || (a === 'yes' && !(await save()))) return;
    }
    const path = await pickOpenFile({
      title: tr('SQL-Datei öffnen', 'Open SQL file'),
      filters: [
        { name: 'SQL', extensions: ['sql'] },
        { name: tr('Alle Dateien', 'All files'), extensions: ['*'] }
      ]
    });
    if (!path) return;
    try {
      const content = await api.fs.readText(path);
      setText(content);
      setSavedText(content);
      setFile(path);
      setSavedQuery(false);
      useTabs.getState().update(tab.id, { title: baseName(path), key: `query:${path.toLowerCase()}` });
      useTabs.getState().updateParams(tab.id, { file: path, saved: false, sql: null });
    } catch (e) {
      void errorDialog(e);
    }
  };

  useEffect(() => {
    setCloseGuard(tab.id, async () => {
      const cur = s.current;
      if (cur.text !== cur.savedText && (cur.text.trim() || cur.file)) {
        const a = await askDialog({
          title: tr('Abfrage schließen', 'Close query'),
          message: tr('Änderungen an „{t}“ speichern?', 'Save changes to "{t}"?', { t: useTabs.getState().tabs.find((x) => x.id === tab.id)?.title ?? '' })
        });
        if (a === 'cancel') return false;
        if (a === 'yes' && !(await save())) return false;
      }
      if (cur.tx.open) {
        const ok = await confirmDialog({
          message: tr('Auf dieser Registerkarte ist eine Transaktion offen. Sie wird beim Schließen zurückgesetzt. Schließen?', 'A transaction is open in this tab. It will be rolled back when closing. Close?'),
          okLabel: tr('Schließen', 'Close'),
          danger: true
        });
        if (!ok) return false;
      }
      const pending = store.getState().results.some((r) => pendingCount(r.editState) > 0);
      if (pending) {
        return confirmDialog({
          message: tr('Ergebnisse enthalten nicht übernommene Änderungen. Trotzdem schließen?', 'Results contain changes that were not applied. Close anyway?'),
          okLabel: tr('Schließen', 'Close'),
          danger: true
        });
      }
      return true;
    });
    return () => setCloseGuard(tab.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // ───────────── query builder, formatting, snippets ─────────────

  const queryBuilder = async () => {
    const target = selectionOrAll();
    if (!target) return;
    try {
      const out = await openQueryBuilder({ connectionId: s.current.cid, database: s.current.db, sql: target.text });
      if (out !== null) replaceRange(target.range, out);
    } catch (e) {
      void errorDialog(e);
    }
  };

  const format = (kind: 'beautify' | 'minify') => {
    const target = selectionOrAll();
    if (!target || !target.text.trim()) return;
    const out = kind === 'beautify' ? beautifySql(target.text) : minifySql(target.text);
    if (out !== target.text) replaceRange(target.range, out);
  };

  const transformCase = (upper: boolean) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    ed.trigger('ks-query', upper ? 'editor.action.transformToUppercase' : 'editor.action.transformToLowercase', null);
  };

  const insertSnippet = (sn: Snippet) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    const ctrl = ed.getContribution('snippetController2') as unknown as { insert(t: string): void } | null;
    if (ctrl) ctrl.insert(sn.sql);
    else ed.executeEdits('ks-query', [{ range: ed.getSelection()!, text: sn.sql, forceMoveMarkers: true }]);
  };

  // ───────────── actions / keyboard ─────────────

  const actions = {
    run: () => void run('all'),
    runCurrent: () => void run('current'),
    stop: () => void stop(),
    explain: () => void explain(),
    beautify: () => format('beautify'),
    minify: () => format('minify'),
    upper: () => transformCase(true),
    lower: () => transformCase(false),
    save: () => void save(),
    saveAs: () => void saveAs(),
    builder: () => void queryBuilder()
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const onMount = (ed: MonacoEditor, m: typeof monaco) => {
    editorRef.current = ed;
    const K = m.KeyMod;
    const C = m.KeyCode;
    const add = (id: keyof typeof actions, label: string, keys: number[], group: string, order: number) =>
      ed.addAction({ id: `ks.query.${id}`, label, keybindings: keys, contextMenuGroupId: group, contextMenuOrder: order, run: () => actionsRef.current[id]() });
    add('run', tr('Ausführen', 'Run'), [K.CtrlCmd | C.KeyR, C.F9], '0_ks_run', 1);
    add('runCurrent', tr('Markierung / aktuelle Anweisung ausführen', 'Run Selection / Current Statement'), [K.CtrlCmd | K.Shift | C.KeyR], '0_ks_run', 2);
    add('explain', tr('Erklären (EXPLAIN)', 'Explain'), [K.CtrlCmd | C.KeyE], '0_ks_run', 3);
    add('stop', tr('Ausführung stoppen', 'Stop Execution'), [K.CtrlCmd | C.KeyT], '0_ks_run', 4);
    add('beautify', tr('SQL formatieren', 'Beautify SQL'), [K.CtrlCmd | K.Shift | C.KeyF], '1_ks_format', 1);
    add('minify', tr('SQL komprimieren', 'Minify SQL'), [], '1_ks_format', 2);
    add('upper', tr('In Großbuchstaben', 'Upper Case'), [], '1_ks_format', 3);
    add('lower', tr('In Kleinbuchstaben', 'Lower Case'), [], '1_ks_format', 4);
    add('builder', tr('Abfrage-Generator …', 'Query Builder …'), [], '1_ks_format', 5);
    add('save', tr('Speichern', 'Save'), [K.CtrlCmd | C.KeyS], '2_ks_file', 1);
    add('saveAs', tr('Speichern unter …', 'Save As …'), [K.CtrlCmd | K.Shift | C.KeyS], '2_ks_file', 2);
    ed.onDidChangeCursorSelection((e) => {
      const mm = ed.getModel();
      const sel = e.selection;
      setCursor({ line: sel.positionLineNumber, col: sel.positionColumn, sel: mm && !sel.isEmpty() ? mm.getValueLengthInRange(sel) : 0 });
    });
  };

  useEffect(() => {
    if (!active) return;
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d === 'save') void actionsRef.current.save();
      else if (d === 'find') {
        editorRef.current?.focus();
        void editorRef.current?.getAction('actions.find')?.run();
      }
    };
    window.addEventListener('ks-command', h);
    return () => window.removeEventListener('ks-command', h);
  }, [active]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => editorRef.current?.layout());
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const combo = keyCombo(e);
    const inEditor = !!(e.target as HTMLElement).closest('.monaco-editor');
    if (/^Alt\+[1-9]$/.test(combo)) {
      const ids = visibleTabIds(store.getState());
      const id = ids[Number(combo.slice(4)) - 1];
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        store.setState({ activeTab: id });
      }
      return;
    }
    if (!TAB_KEYS.has(combo)) return;
    e.stopPropagation();
    if (inEditor) return; // handled by the Monaco actions
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    e.preventDefault();
    const map: Record<string, () => void> = {
      'Ctrl+R': actions.run,
      F9: actions.run,
      'Ctrl+Shift+R': actions.runCurrent,
      'Ctrl+E': actions.explain,
      'Ctrl+S': actions.save,
      'Ctrl+Shift+S': actions.saveAs,
      'Ctrl+T': actions.stop,
      'Ctrl+Shift+F': actions.beautify
    };
    map[combo]?.();
  };

  const host: ResultsHost = useMemo(
    () => ({
      connectionId: () => s.current.cid,
      database: () => s.current.db,
      sessionId: () => sessionRef.current?.id ?? null,
      inTransaction: () => s.current.tx.open,
      selectStatement: (index) => {
        const r = runMap.current[index];
        if (r) selectOffsets(r.start, r.end);
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const completion = useMemo(() => ({ connectionId: cid, database: db }), [cid, db]);

  // ───────────── render ─────────────

  const databases = conn?.databases ?? [];
  const dbOptions = [
    { value: '', label: tr('(keine Datenbank)', '(no database)') },
    ...(db && !databases.some((d) => d.name === db) ? [{ value: db, label: db }] : []),
    ...databases.map((d) => ({ value: d.name, label: d.name }))
  ];
  const busy = !!running;
  const elapsed = useElapsed(store((st) => st.startedAt), busy);

  return (
    <div className="ks-query" onKeyDown={onKeyDown}>
      <Toolbar className="ks-query-toolbar">
        <Select
          className="ks-query-conn"
          value={cid}
          disabled={busy}
          title={tr('Verbindung', 'Connection')}
          onChange={(v) => void changeConnection(v)}
          options={profiles.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Select className="ks-query-db" value={db ?? ''} disabled={busy} title={tr('Datenbank', 'Database')} onChange={(v) => void changeDatabase(v)} options={dbOptions} />
        <ToolbarSep />
        <ToolbarButton
          icon={<Play {...i15} className="ks-query-run-icon" />}
          label={tr('Ausführen', 'Run')}
          title={tr('Ausführen (Strg+R / F9) – mit Markierung nur die Markierung', 'Run (Ctrl+R / F9) – only the selection if text is selected')}
          disabled={busy}
          onClick={actions.run}
          onDropdown={(e) =>
            showMenuBelow(e.currentTarget, [
              { label: tr('Alles ausführen', 'Run All'), shortcut: 'Ctrl+R', onClick: actions.run },
              { label: tr('Markierung / aktuelle Anweisung ausführen', 'Run Selection / Current Statement'), shortcut: 'Ctrl+Shift+R', onClick: actions.runCurrent },
              SEP,
              { label: tr('Bei Fehler fortfahren', 'Continue on Error'), checked: !stopOnError, onClick: () => setStopOnError((x) => !x) }
            ])
          }
        />
        <ToolbarButton icon={<Square {...i15} />} label={tr('Stopp', 'Stop')} title={tr('Ausführung stoppen (Strg+T)', 'Stop execution (Ctrl+T)')} disabled={!busy || cancelling} onClick={actions.stop} />
        <ToolbarButton icon={<ListTree {...i15} />} label={tr('Erklären', 'Explain')} title={tr('Ausführungsplan (Strg+E)', 'Execution plan (Ctrl+E)')} disabled={busy} onClick={actions.explain} />
        <ToolbarSep />
        <ToolbarButton icon={<Workflow {...i15} />} label={tr('Abfrage-Generator', 'Query Builder')} onClick={actions.builder} />
        <ToolbarButton
          icon={<WandSparkles {...i15} />}
          title={tr('SQL formatieren (Strg+Umschalt+F)', 'Beautify SQL (Ctrl+Shift+F)')}
          onClick={actions.beautify}
          onDropdown={(e) =>
            showMenuBelow(e.currentTarget, [
              { label: tr('SQL formatieren', 'Beautify SQL'), icon: <WandSparkles size={14} />, shortcut: 'Ctrl+Shift+F', onClick: actions.beautify },
              { label: tr('SQL komprimieren', 'Minify SQL'), icon: <Minimize2 size={14} />, onClick: actions.minify },
              SEP,
              { label: tr('In Großbuchstaben', 'Upper Case'), icon: <CaseUpper size={14} />, onClick: actions.upper },
              { label: tr('In Kleinbuchstaben', 'Lower Case'), icon: <CaseLower size={14} />, onClick: actions.lower }
            ])
          }
        />
        <IconButton icon={<Code {...i15} />} title={tr('Code-Snippets', 'Code snippets')} active={showSnippets} onClick={() => setShowSnippets((x) => !x)} />
        <IconButton icon={<Gauge {...i15} />} title={tr('Profil und Status bei der Ausführung erfassen', 'Capture profile and status when running')} active={profiling} onClick={() => setProfiling((x) => !x)} />
        <ToolbarSep />
        <ToolbarButton
          icon={<Save {...i15} />}
          title={tr('Speichern (Strg+S)', 'Save (Ctrl+S)')}
          onClick={actions.save}
          onDropdown={(e) =>
            showMenuBelow(e.currentTarget, [
              { label: tr('Speichern', 'Save'), shortcut: 'Ctrl+S', onClick: actions.save },
              { label: tr('Als gespeicherte Abfrage speichern …', 'Save as Saved Query …'), icon: <ObjIcon kind="query" size={14} />, onClick: () => void saveToQueries() },
              { label: tr('Speichern unter (externe Datei) …', 'Save As (External File) …'), shortcut: 'Ctrl+Shift+S', onClick: actions.saveAs }
            ])
          }
        />
        <IconButton icon={<FolderOpen {...i15} />} title={tr('SQL-Datei öffnen …', 'Open SQL file …')} onClick={() => void openFile()} />
        <ToolbarSep />
        <Checkbox
          className="ks-query-autocommit"
          checked={wantAutocommit}
          onChange={(v) => void setAutocommit(v)}
          label="Auto-Commit"
          title={tr('Aus: Änderungen müssen mit COMMIT bestätigt werden', 'Off: changes must be committed with COMMIT')}
        />
        <IconButton icon={<Play size={13} />} title={tr('Transaktion starten', 'Begin transaction')} disabled={busy || tx.open} onClick={() => void txCommand('START TRANSACTION')} />
        <IconButton icon={<Check {...i15} />} title={tr('Bestätigen (COMMIT)', 'Commit')} disabled={busy || (!tx.open && tx.autocommit)} onClick={() => void txCommand('COMMIT')} />
        <IconButton icon={<Undo2 {...i15} />} title={tr('Zurücksetzen (ROLLBACK)', 'Rollback')} disabled={busy || (!tx.open && tx.autocommit)} onClick={() => void txCommand('ROLLBACK')} />
        {tx.open && <span className="ks-badge warning ks-query-txbadge">{tr('Transaktion offen', 'Transaction open')}</span>}
      </Toolbar>
      <div className="ks-query-body">
        <Group orientation="vertical" className="ks-query-split">
          <Panel id="editor" minSize="60px" defaultSize="55%" className="ks-query-panel" style={{ overflow: 'hidden' }}>
            <div className="ks-query-editor-row">
              <div className="ks-query-editor">
                {loading ? (
                  <div className="ks-tab-loading">
                    <Spinner size={22} />
                  </div>
                ) : (
                  <SqlEditor value={text} onChange={setText} completion={completion} onMount={onMount} />
                )}
              </div>
              {showSnippets && <SnippetsPane onInsert={insertSnippet} onClose={() => setShowSnippets(false)} />}
            </div>
          </Panel>
          <Separator className="ks-query-sep" />
          <Panel id="results" minSize="60px" className="ks-query-panel" style={{ overflow: 'hidden' }}>
            <ResultsPanel store={store} host={host} />
          </Panel>
        </Group>
      </div>
      <div className="ks-statusline">
        <span className={clsx('ks-query-conn-dot', sessionState)} title={sessionState} />
        <span className="ellipsis">
          {profile?.name ?? '?'}
          {server ? ` · ${server.type === 'mariadb' ? 'MariaDB' : 'MySQL'} ${server.version.split('-')[0]}` : ''}
          {db ? ` · ${db}` : ''}
        </span>
        {!tx.autocommit && <span>{tr('Auto-Commit aus', 'Auto-commit off')}</span>}
        {savedQuery && file ? <span className="faint">{tr('Gespeicherte Abfrage', 'Saved query')}</span> : file ? <span className="faint ellipsis">{file}</span> : null}
        <span className="spacer" />
        {busy ? (
          <span className="row">
            <Spinner size={12} />
            {cancelling
              ? tr('Wird abgebrochen …', 'Cancelling …')
              : running === 'explain'
                ? tr('Erklären …', 'Explaining …')
                : progress && progress.total > 1
                  ? tr('Anweisung {i} von {n}', 'Statement {i} of {n}', { i: progress.index + 1, n: progress.total })
                  : tr('Wird ausgeführt …', 'Running …')}
            {` · ${formatDuration(elapsed)}`}
          </span>
        ) : lastRun ? (
          <span className={clsx(lastRun.errors > 0 && 'danger-text')}>
            {lastRun.errors > 0 ? `${tr('{n} Fehler', '{n} error(s)', { n: lastRun.errors })} · ` : ''}
            {lastRun.cancelled ? `${tr('abgebrochen', 'cancelled')} · ` : ''}
            {tr('{r} Zeilen', '{r} rows', { r: formatNumber(lastRun.rows) })}
            {lastRun.affected ? ` · ${tr('{a} betroffen', '{a} affected', { a: formatNumber(lastRun.affected) })}` : ''}
            {` · ${formatDuration(lastRun.totalMs)}`}
          </span>
        ) : null}
        <span>
          {tr('Z {l}, Sp {c}', 'Ln {l}, Col {c}', { l: cursor.line, c: cursor.col })}
          {cursor.sel ? ` (${tr('{n} markiert', '{n} selected', { n: cursor.sel })})` : ''}
        </span>
      </div>
    </div>
  );
}

function useElapsed(startedAt: number | null, runningNow: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!runningNow) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [runningNow]);
  return runningNow && startedAt ? Math.max(0, now - startedAt) : 0;
}

function SnippetsPane({ onInsert, onClose }: { onInsert: (s: Snippet) => void; onClose: () => void }) {
  const [list, setList] = useState<Snippet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const load = (force = false) => {
    setError(null);
    loadSnippets(force).then(setList, (e) => setError(errorMessage(e)));
  };
  useEffect(() => load(), []);
  const f = search.trim().toLowerCase();
  const groups = new Map<string, Snippet[]>();
  for (const sn of list ?? []) {
    if (f && !`${sn.name} ${sn.description} ${sn.sql}`.toLowerCase().includes(f)) continue;
    const g = sn.group || tr('Allgemein', 'General');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(sn);
  }
  return (
    <div className="ks-query-snippets">
      <div className="ks-query-snippets-head">
        <b>{tr('Code-Snippets', 'Code Snippets')}</b>
        <span className="spacer" />
        <IconButton icon={<RotateCcw size={13} />} title={tr('Aktualisieren', 'Refresh')} onClick={() => load(true)} />
        <IconButton icon={<span className="ks-query-x">×</span>} title={tr('Schließen', 'Close')} onClick={onClose} />
      </div>
      <SearchInput value={search} onChange={setSearch} className="ks-query-snippets-search" />
      <div className="ks-query-snippets-list">
        {!list && !error && <Spinner size={16} />}
        {error && <div className="danger-text">{error}</div>}
        {[...groups].map(([g, items]) => (
          <div key={g}>
            <div className="ks-query-snippets-group" onClick={() => setClosed((c) => ({ ...c, [g]: !c[g] }))}>
              {closed[g] && !f ? '▸' : '▾'} {g}
            </div>
            {(!closed[g] || f) &&
              items.map((sn) => (
                <div
                  key={sn.id}
                  className="ks-query-snippet"
                  title={`${sn.description}\n\n${sn.sql}\n\n${tr('Doppelklick zum Einfügen', 'Double click to insert')}`}
                  onDoubleClick={() => onInsert(sn)}
                >
                  <span className="ellipsis">{sn.name}</span>
                  <span className="faint ellipsis">{sn.description}</span>
                </div>
              ))}
          </div>
        ))}
        {list && !groups.size && <div className="faint">{tr('Keine Treffer', 'No matches')}</div>}
      </div>
    </div>
  );
}

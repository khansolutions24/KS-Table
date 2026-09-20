// Command line console in the style of the mysql client, running on its own session.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Plug, Square } from 'lucide-react';
import { tr } from '@shared/i18n';
import { quoteId } from '@shared/sql/quote';
import { api, errorMessage, onEvent } from '../../api/client';
import { Spinner, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { keyCombo } from '../../lib/shortcuts';
import { useTabs, type TabProps } from '../../store/tabs';
import { getProfile, isUserCancelled, openSessionWithPrompt } from '../../store/workspace';
import { formatStatementResult } from './consoleFormat';
import { feedLine, initialScanState, promptFor, type ConsoleCommand, type ScanState } from './consoleParser';
import './console.css';

type BlockKind = 'input' | 'result' | 'error' | 'info';
interface Block {
  id: number;
  kind: BlockKind;
  text: string;
}

const MAX_BLOCKS = 3000;
const MAX_ROWS = 10000;
const HISTORY_MAX = 500;

function historyKey(cid: string) {
  return `ks-console-history:${cid}`;
}

function loadHistory(cid: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(historyKey(cid)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function helpText(): string {
  return [
    tr('Liste der Konsolenbefehle (Befehle am Zeilenanfang, Anweisungen enden mit dem Trennzeichen):', 'List of console commands (commands at line start, statements end with the delimiter):'),
    `clear     (\\c)  ${tr('Aktuelle Eingabe verwerfen (am Zeilenanfang: Ausgabe leeren)', 'Discard the current input (at line start: clear the output)')}`,
    `cls             ${tr('Ausgabe leeren (auch Strg+L)', 'Clear the output (also Ctrl+L)')}`,
    `delimiter (\\d)  ${tr('Trennzeichen für Anweisungen setzen', 'Set the statement delimiter')}`,
    `ego       (\\G)  ${tr('Anweisung ausführen, Ergebnis vertikal anzeigen', 'Execute the statement, show the result vertically')}`,
    `go        (\\g)  ${tr('Anweisung ausführen', 'Execute the statement')}`,
    `help      (\\h)  ${tr('Diese Hilfe anzeigen; „help <Thema>“ fragt die Serverhilfe ab', 'Show this help; "help <topic>" queries the server help')}`,
    `print     (\\p)  ${tr('Aktuelle Eingabe anzeigen', 'Print the current input')}`,
    `quit      (\\q)  ${tr('Konsole schließen', 'Close the console')}`,
    `status    (\\s)  ${tr('Status der Verbindung anzeigen', 'Show the connection status')}`,
    `use       (\\u)  ${tr('Datenbank wechseln', 'Change the database')}`,
    `warnings  (\\W)  ${tr('Warnungen nach jeder Anweisung anzeigen', 'Show warnings after every statement')}`,
    `nowarning (\\w)  ${tr('Warnungen nicht anzeigen', 'Do not show warnings')}`,
    '',
    tr(
      'Tasten: ↑/↓ Verlauf, Strg+C bricht eine laufende Anweisung ab bzw. verwirft die Eingabe, Strg+L leert die Ausgabe.',
      'Keys: ↑/↓ history, Ctrl+C cancels a running statement or discards the input, Ctrl+L clears the output.'
    )
  ].join('\n');
}

export default function ConsoleTab({ tab, active }: TabProps) {
  const params = tab.params as { connectionId: string; database: string | null };
  const cid = params.connectionId;
  const profile = getProfile(cid);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [input, setInput] = useState('');
  const [scan, setScan] = useState<ScanState>(() => initialScanState());
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<{ id: string; threadId: number; version: string; server: 'mysql' | 'mariadb' } | null>(null);
  const [database, setDatabase] = useState<string | null>(params.database);
  const [connecting, setConnecting] = useState(false);
  const seq = useRef(0);
  const outRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionRef = useRef<string | null>(null);
  const scanRef = useRef(scan);
  scanRef.current = scan;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const history = useRef<string[]>(loadHistory(cid));
  const histPos = useRef<number>(-1);
  const draft = useRef('');
  const showWarnings = useRef(false);
  const databaseRef = useRef(database);
  databaseRef.current = database;
  /** Mount generation: sessions opened by an older mount are closed right away */
  const generation = useRef(0);

  const print = useCallback((kind: BlockKind, text: string) => {
    setBlocks((b) => {
      const next = [...b, { id: ++seq.current, kind, text }];
      return next.length > MAX_BLOCKS ? next.slice(next.length - MAX_BLOCKS) : next;
    });
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    const gen = generation.current;
    try {
      const info = await openSessionWithPrompt(cid, databaseRef.current);
      if (gen !== generation.current) {
        void api.session.close(info.sessionId).catch(() => undefined);
        return;
      }
      sessionRef.current = info.sessionId;
      setSession({ id: info.sessionId, threadId: info.threadId, version: info.server.version, server: info.server.type });
      setDatabase(info.database);
      print(
        'info',
        [
          tr('Willkommen in der KS Table Konsole. Befehle enden mit ; oder \\g.', 'Welcome to the KS Table console. Commands end with ; or \\g.'),
          tr('Ihre Verbindungs-ID ist {id}', 'Your connection id is {id}', { id: info.threadId }),
          `${tr('Serverversion', 'Server version')}: ${info.server.version} ${info.server.versionComment}`,
          '',
          tr("Geben Sie 'help;' oder '\\h' für Hilfe ein. '\\c' verwirft die aktuelle Eingabe.", "Type 'help;' or '\\h' for help. Type '\\c' to clear the current input statement.")
        ].join('\n')
      );
    } catch (e) {
      if (isUserCancelled(e)) print('error', tr('Verbindung abgebrochen.', 'Connection cancelled.'));
      else print('error', `ERROR: ${errorMessage(e)}`);
    } finally {
      setConnecting(false);
    }
  }, [cid, print]);

  useEffect(() => {
    generation.current++;
    void connect();
    return () => {
      generation.current++;
      const sid = sessionRef.current;
      sessionRef.current = null;
      if (sid) void api.session.close(sid).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () =>
      onEvent('session:lost', (e) => {
        if (e.sessionId === sessionRef.current) {
          print('info', e.message);
          void api.session
            .info(e.sessionId)
            .then((i) => {
              setSession((s) => (s ? { ...s, threadId: i.threadId } : s));
              setDatabase(i.database);
            })
            .catch(() => undefined);
        }
      }),
    [print]
  );

  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks, scan.buffer]);

  useEffect(() => {
    if (active) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [active]);

  const execSql = async (cmd: Extract<ConsoleCommand, { kind: 'sql' }>) => {
    const sid = sessionRef.current;
    if (!sid) {
      print('error', tr('ERROR: Keine Verbindung. Mit „Neu verbinden“ erneut verbinden.', 'ERROR: Not connected. Use "Reconnect".'));
      return;
    }
    try {
      const res = await api.query.execute(sid, cmd.sql, { noSplit: true, maxRows: MAX_ROWS, stopOnError: true, history: true });
      for (const r of res.results) {
        const out = formatStatementResult(r, {
          vertical: cmd.vertical,
          showWarnings: showWarnings.current,
          truncatedNote: tr('Hinweis: Ausgabe auf {n} Zeilen begrenzt.', 'Note: output limited to {n} rows.', { n: MAX_ROWS }),
          cancelledNote: '^C'
        });
        print(out.kind, out.text);
      }
      if (res.cancelled && !res.results.some((r) => r.kind === 'error')) print('error', tr('Abgebrochen', 'Cancelled'));
      setDatabase(res.database);
    } catch (e) {
      print('error', `ERROR: ${errorMessage(e)}`);
    }
  };

  const status = async () => {
    const sid = sessionRef.current;
    const lines = ['--------------', `KS Table ${tr('Konsole', 'console')} – ${profile?.name ?? ''}`, ''];
    if (!sid || !session) {
      lines.push(tr('Nicht verbunden', 'Not connected'));
    } else {
      try {
        const r = await api.query.execute(sid, 'SELECT CONNECTION_ID(), DATABASE(), CURRENT_USER(), @@character_set_client, @@character_set_connection, @@version_comment, @@hostname, @@port, (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = \'Uptime\')', { noSplit: true, history: false });
        const row = r.results[0]?.rows?.[0] ?? [];
        const v = (i: number) => (row[i] === null || row[i] === undefined ? '' : String(row[i]));
        const up = Number(v(8));
        const pad = (s: string) => s.padEnd(22);
        lines.push(
          `${pad('Connection id:')}${v(0)}`,
          `${pad('Current database:')}${v(1)}`,
          `${pad('Current user:')}${v(2)}`,
          `${pad('Server version:')}${session.version} ${v(5)}`,
          `${pad('Server host:')}${v(6)} (${profile?.host ?? ''}:${v(7)})`,
          `${pad('Client characterset:')}${v(3)}`,
          `${pad('Conn.  characterset:')}${v(4)}`,
          `${pad('Using delimiter:')}${scanRef.current.delimiter}`,
          ...(Number.isFinite(up) && v(8) ? [`${pad('Uptime:')}${Math.floor(up / 86400)} days ${Math.floor((up % 86400) / 3600)} hours ${Math.floor((up % 3600) / 60)} min ${up % 60} sec`] : [])
        );
      } catch (e) {
        lines.push(`ERROR: ${errorMessage(e)}`);
      }
    }
    lines.push('--------------');
    print('info', lines.join('\n'));
  };

  const runCommand = async (cmd: ConsoleCommand, pending: string) => {
    if (cmd.kind === 'sql') return execSql(cmd);
    switch (cmd.name) {
      case 'help':
        print('info', helpText());
        break;
      case 'clear':
        setBlocks([]);
        break;
      case 'quit':
        print('info', 'Bye');
        void useTabs.getState().close(tab.id);
        break;
      case 'status':
        await status();
        break;
      case 'use':
        if (!cmd.arg) print('error', tr('USE erfordert einen Datenbanknamen', 'USE must be followed by a database name'));
        else await execSql({ kind: 'sql', sql: `USE ${quoteId(cmd.arg)}`, vertical: false });
        break;
      case 'delimiter':
        if (!cmd.arg) print('error', tr('DELIMITER erfordert ein Zeichen', 'DELIMITER must be followed by a character'));
        break;
      case 'reset':
        break;
      case 'print':
        print('info', `--------------\n${cmd.arg || pending}\n--------------`);
        break;
      case 'warnings':
        showWarnings.current = true;
        print('info', tr('Warnungen werden angezeigt.', 'Show warnings enabled.'));
        break;
      case 'nowarnings':
        showWarnings.current = false;
        print('info', tr('Warnungen werden nicht angezeigt.', 'Show warnings disabled.'));
        break;
      case 'noquery':
        print('error', 'ERROR: No query specified');
        break;
      case 'unsupported':
        print('error', tr('Der Befehl „{c}“ wird in dieser Konsole nicht unterstützt.', 'The command "{c}" is not supported in this console.', { c: cmd.arg }));
        break;
      default:
        print('error', tr('Unbekannter Befehl {c}', 'Unknown command {c}', { c: cmd.arg }));
    }
  };

  const enqueue = (commands: ConsoleCommand[], pending: string) => {
    if (!commands.length) return;
    queue.current = queue.current.then(async () => {
      setBusy(true);
      try {
        for (const c of commands) await runCommand(c, pending);
      } finally {
        setBusy(false);
      }
    });
  };

  const mainPrompt = session?.server === 'mariadb' ? `MariaDB [${database ?? '(none)'}]> ` : 'mysql> ';

  /** Feeds complete lines (echoed with their prompt) into the parser */
  const submitLines = (lines: string[]) => {
    let st = scanRef.current;
    const all: ConsoleCommand[] = [];
    for (const line of lines) {
      print('input', `${promptFor(st, mainPrompt)}${line}`);
      const before = st.buffer;
      const r = feedLine(st, line);
      st = r.state;
      if (r.commands.some((c) => c.kind === 'client' && c.name === 'reset')) st = { ...st, buffer: '' };
      all.push(...r.commands.map((c) => (c.kind === 'client' && c.name === 'print' && !c.arg ? { ...c, arg: before.trim() } : c)));
      if (line.trim()) {
        const h = history.current;
        if (h[h.length - 1] !== line) h.push(line);
        if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
      }
    }
    try {
      localStorage.setItem(historyKey(cid), JSON.stringify(history.current));
    } catch {
      // storage unavailable
    }
    histPos.current = -1;
    setScan(st);
    scanRef.current = st;
    enqueue(all, st.buffer);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const combo = keyCombo(e);
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const el = e.currentTarget;
    switch (combo) {
      case 'Enter':
        stop();
        submitLines([input]);
        setInput('');
        return;
      case 'Ctrl+C':
        if (el.selectionStart !== el.selectionEnd) {
          e.stopPropagation();
          return;
        }
        stop();
        if (busy && sessionRef.current) {
          print('info', tr('^C – Anweisung wird abgebrochen …', '^C – cancelling the statement …'));
          void api.query.cancel(sessionRef.current).catch((err) => print('error', `ERROR: ${errorMessage(err)}`));
        } else {
          print('input', `${promptFor(scanRef.current, mainPrompt)}${input}^C`);
          const st = { ...scanRef.current, buffer: '', quote: '' as const, comment: false };
          setScan(st);
          setInput('');
        }
        return;
      case 'Ctrl+L':
        stop();
        setBlocks([]);
        return;
      case 'ArrowUp': {
        if (input.includes('\n') && el.selectionStart > input.indexOf('\n')) return;
        const h = history.current;
        if (!h.length) return;
        stop();
        if (histPos.current < 0) {
          draft.current = input;
          histPos.current = h.length - 1;
        } else histPos.current = Math.max(0, histPos.current - 1);
        setInput(h[histPos.current]);
        return;
      }
      case 'ArrowDown': {
        if (histPos.current < 0) return;
        stop();
        const h = history.current;
        if (histPos.current >= h.length - 1) {
          histPos.current = -1;
          setInput(draft.current);
        } else {
          histPos.current++;
          setInput(h[histPos.current]);
        }
        return;
      }
      case 'Tab':
        stop();
        setInput((v) => `${v}    `);
        return;
      default:
        e.stopPropagation();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/\r|\n/.test(text)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const combined = input.slice(0, el.selectionStart) + text + input.slice(el.selectionEnd);
    const lines = combined.split(/\r\n|\r|\n/);
    const last = lines.pop() ?? '';
    submitLines(lines);
    setInput(last);
  };

  const reconnect = async () => {
    const sid = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    if (sid) await api.session.close(sid).catch(() => undefined);
    print('info', tr('Verbinde neu …', 'Reconnecting …'));
    await connect();
  };

  const prompt = promptFor(scan, mainPrompt);

  return (
    <div className="ks-editor-layout">
      <Toolbar>
        <ToolbarButton icon={<Square size={14} />} label={tr('Abbrechen', 'Stop')} disabled={!busy || !session} onClick={() => sessionRef.current && void api.query.cancel(sessionRef.current)} />
        <ToolbarButton icon={<Eraser size={15} />} label={tr('Ausgabe leeren', 'Clear Output')} onClick={() => setBlocks([])} />
        <ToolbarSep />
        <ToolbarButton icon={connecting ? <Spinner size={14} /> : <Plug size={15} />} label={tr('Neu verbinden', 'Reconnect')} disabled={connecting || busy} onClick={() => void reconnect()} />
      </Toolbar>
      <div
        className="ks-console"
        ref={outRef}
        onMouseUp={() => {
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
      >
        {blocks.map((b) => (
          <pre key={b.id} className={`ks-console-block ${b.kind}`}>
            {b.text}
          </pre>
        ))}
        <div className="ks-console-inputline">
          <span className="ks-console-prompt">{busy ? '' : prompt}</span>
          <textarea
            ref={inputRef}
            className="ks-console-input"
            value={input}
            rows={1}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setInput(e.target.value);
              histPos.current = -1;
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
      </div>
      <div className="ks-statusline">
        <span>{profile?.name ?? ''}</span>
        <span>{session ? tr('Verbindungs-ID {id}', 'Connection id {id}', { id: session.threadId }) : connecting ? tr('Verbinde …', 'Connecting …') : tr('Nicht verbunden', 'Not connected')}</span>
        <span>{tr('Datenbank: {d}', 'Database: {d}', { d: database ?? '–' })}</span>
        <span>{tr('Trennzeichen: {d}', 'Delimiter: {d}', { d: scan.delimiter })}</span>
        <span className="spacer" />
        {busy && (
          <span className="row">
            <Spinner size={12} /> {tr('Läuft … (Strg+C bricht ab)', 'Running … (Ctrl+C cancels)')}
          </span>
        )}
      </div>
    </div>
  );
}



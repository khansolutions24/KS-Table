// Information pane: general properties and DDL of the selected object.

import { useEffect, useState, type ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { ObjectKind } from '@shared/types';
import { formatBytes, formatDateTime, formatNumber } from '@shared/util';
import { quoteId } from '@shared/sql/quote';
import { api, errorMessage } from '../api/client';
import { ObjIcon, type ObjKind } from '../components/icons';
import { SqlHighlight } from '../components/SqlHighlight';
import { EmptyState, IconButton, Spinner, TabStrip } from '../components/ui/controls';
import { toast } from '../components/Toast';
import { useInfoTarget, type InfoTarget } from '../store/nav';
import { metaSession, useWorkspace } from '../store/workspace';

type Pair = [string, ReactNode];

const yesNo = (b: boolean | undefined) => (b ? tr('Ja', 'Yes') : tr('Nein', 'No'));
const dt = (s: string | null | undefined) => (s ? s.replace('T', ' ').slice(0, 19) : '');

function useGeneral(t: InfoTarget | null): { title: string; kind: ObjKind; pairs: Pair[] } | null {
  const profiles = useWorkspace((s) => s.profiles);
  const conns = useWorkspace((s) => s.conns);
  if (!t) return null;
  const p = profiles.find((x) => x.id === t.connectionId);
  const cs = conns[t.connectionId];
  if (!p) return null;
  if (t.objectType === 'connection') {
    return {
      title: p.name,
      kind: p.type === 'mariadb' ? 'connection-mariadb' : 'connection',
      pairs: [
        [tr('Typ', 'Type'), p.type === 'mariadb' ? 'MariaDB' : 'MySQL'],
        [tr('Host', 'Host'), p.socketPath || p.host],
        [tr('Port', 'Port'), String(p.port)],
        [tr('Benutzer', 'User'), p.user],
        [tr('Status', 'Status'), cs?.status === 'open' ? tr('Verbunden', 'Connected') : tr('Getrennt', 'Disconnected')],
        [tr('Serverversion', 'Server version'), cs?.server?.version ?? '–'],
        [tr('Datenbanken', 'Databases'), cs?.status === 'open' ? String(cs.databases.length) : '–'],
        [tr('SSH-Tunnel', 'SSH tunnel'), p.ssh.enabled ? `${p.ssh.user}@${p.ssh.host}:${p.ssh.port}` : tr('Nein', 'No')],
        ['SSL', yesNo(p.ssl.enabled)],
        [tr('Zeichensatz', 'Encoding'), p.encoding]
      ]
    };
  }
  const db = t.database ?? '';
  const ds = cs?.dbs[db];
  if (t.objectType === 'database') {
    const info = cs?.databases.find((d) => d.name === db);
    const size = ds?.tables.reduce((a, x) => a + (x.dataLength ?? 0) + (x.indexLength ?? 0), 0);
    return {
      title: db,
      kind: 'database',
      pairs: [
        [tr('Zeichensatz', 'Character set'), info?.charset ?? ''],
        [tr('Sortierung', 'Collation'), info?.collation ?? ''],
        [tr('Tabellen', 'Tables'), ds?.loaded ? String(ds.tables.length) : '–'],
        [tr('Ansichten', 'Views'), ds?.loaded ? String(ds.views.length) : '–'],
        [tr('Routinen', 'Routines'), ds?.loaded ? String(ds.routines.length) : '–'],
        [tr('Ereignisse', 'Events'), ds?.loaded ? String(ds.events.length) : '–'],
        [tr('Größe', 'Size'), ds?.loaded ? formatBytes(size) : '–']
      ]
    };
  }
  const name = t.name ?? '';
  switch (t.objectType) {
    case 'table': {
      const x = ds?.tables.find((y) => y.name === name);
      if (!x) break;
      return {
        title: name,
        kind: 'table',
        pairs: [
          [tr('Zeilen', 'Rows'), formatNumber(x.rows)],
          ['Engine', x.engine ?? ''],
          ['Auto Increment', formatNumber(x.autoIncrement)],
          [tr('Zeilenformat', 'Row format'), x.rowFormat ?? ''],
          [tr('Datenlänge', 'Data length'), formatBytes(x.dataLength)],
          [tr('Indexlänge', 'Index length'), formatBytes(x.indexLength)],
          [tr('Max. Datenlänge', 'Max data length'), formatBytes(x.maxDataLength)],
          [tr('Freier Speicher', 'Data free'), formatBytes(x.dataFree)],
          [tr('Durchschn. Zeilenlänge', 'Avg row length'), formatBytes(x.avgRowLength)],
          [tr('Sortierung', 'Collation'), x.collation ?? ''],
          [tr('Erstellt', 'Created'), dt(x.createTime)],
          [tr('Geändert', 'Modified'), dt(x.updateTime)],
          [tr('Geprüft', 'Checked'), dt(x.checkTime)],
          [tr('Erstelloptionen', 'Create options'), x.createOptions],
          [tr('Kommentar', 'Comment'), x.comment]
        ]
      };
    }
    case 'view': {
      const x = ds?.views.find((y) => y.name === name);
      if (!x) break;
      return {
        title: name,
        kind: 'view',
        pairs: [
          ['Definer', x.definer],
          [tr('Sicherheit', 'Security'), x.securityType],
          [tr('Prüfoption', 'Check option'), x.checkOption],
          [tr('Aktualisierbar', 'Updatable'), yesNo(x.isUpdatable)],
          [tr('Zeichensatz (Client)', 'Client charset'), x.characterSetClient],
          [tr('Sortierung (Verbindung)', 'Connection collation'), x.collationConnection]
        ]
      };
    }
    case 'function':
    case 'procedure': {
      const x = ds?.routines.find((y) => y.name === name && (y.type === 'FUNCTION') === (t.objectType === 'function'));
      if (!x) break;
      return {
        title: name,
        kind: t.objectType,
        pairs: [
          [tr('Typ', 'Type'), x.type === 'FUNCTION' ? tr('Funktion', 'Function') : tr('Prozedur', 'Procedure')],
          ...(x.returns ? ([[tr('Rückgabetyp', 'Returns'), x.returns]] as Pair[]) : []),
          ['Definer', x.definer],
          [tr('Sicherheit', 'Security'), x.securityType],
          [tr('Deterministisch', 'Deterministic'), yesNo(x.deterministic)],
          [tr('Datenzugriff', 'Data access'), x.dataAccess],
          [tr('Erstellt', 'Created'), dt(x.created)],
          [tr('Geändert', 'Modified'), dt(x.modified)],
          [tr('Kommentar', 'Comment'), x.comment]
        ]
      };
    }
    case 'event': {
      const x = ds?.events.find((y) => y.name === name);
      if (!x) break;
      return {
        title: name,
        kind: 'event',
        pairs: [
          [tr('Status', 'Status'), x.status],
          [tr('Typ', 'Type'), x.eventType],
          [
            tr('Zeitplan', 'Schedule'),
            x.eventType === 'ONE TIME' ? `AT ${dt(x.executeAt)}` : `EVERY ${x.intervalValue ?? ''} ${x.intervalField ?? ''}`
          ],
          [tr('Beginnt', 'Starts'), dt(x.starts)],
          [tr('Endet', 'Ends'), dt(x.ends)],
          [tr('Zuletzt ausgeführt', 'Last executed'), dt(x.lastExecuted)],
          [tr('Nach Abschluss', 'On completion'), x.onCompletion],
          ['Definer', x.definer],
          [tr('Zeitzone', 'Time zone'), x.timeZone],
          [tr('Kommentar', 'Comment'), x.comment]
        ]
      };
    }
    case 'query':
    case 'backup': {
      const list = t.objectType === 'query' ? ds?.queries : ds?.backups;
      const x = list?.find((y) => y.name === name);
      if (!x) break;
      return {
        title: name,
        kind: t.objectType,
        pairs: [
          [tr('Datei', 'File'), <span className="selectable" key="f">{x.path}</span>],
          [tr('Größe', 'Size'), formatBytes(x.size)],
          [t.objectType === 'backup' ? tr('Erstellt', 'Created') : tr('Geändert', 'Modified'), formatDateTime(x.mtime)]
        ]
      };
    }
  }
  return { title: name, kind: (t.objectType as ObjKind) ?? 'table', pairs: [] };
}

const DDL_KINDS: Record<string, ObjectKind> = {
  table: 'table',
  view: 'view',
  function: 'function',
  procedure: 'procedure',
  event: 'event'
};

function useDdl(t: InfoTarget | null, enabled: boolean) {
  const [state, setState] = useState<{ loading: boolean; text?: string; error?: string }>({ loading: false });
  const conns = useWorkspace((s) => s.conns);
  const key = t ? `${t.connectionId}|${t.database}|${t.objectType}|${t.name}` : '';
  useEffect(() => {
    if (!enabled || !t) return;
    let cancelled = false;
    const run = async (): Promise<string> => {
      if (t.objectType === 'database' && t.database) {
        const info = conns[t.connectionId]?.databases.find((d) => d.name === t.database);
        return `CREATE DATABASE ${quoteId(t.database)}${info ? ` CHARACTER SET ${info.charset} COLLATE ${info.collation}` : ''};`;
      }
      if (t.objectType === 'query') {
        const f = conns[t.connectionId]?.dbs[t.database ?? '']?.queries.find((q) => q.name === t.name);
        return f ? api.fs.readText(f.path) : '';
      }
      const kind = t.objectType ? DDL_KINDS[t.objectType] : undefined;
      if (!kind || !t.database || !t.name) return '';
      return api.meta.ddl(metaSession(t.connectionId), t.database, kind, t.name);
    };
    setState({ loading: true });
    run()
      .then((text) => !cancelled && setState({ loading: false, text }))
      .catch((e) => !cancelled && setState({ loading: false, error: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return state;
}

export function InfoPane() {
  const target = useInfoTarget((s) => s.target);
  const [tab, setTab] = useState<'general' | 'ddl'>('general');
  const general = useGeneral(target);
  const hasDdl = !!target && target.objectType !== 'connection' && target.objectType !== 'backup';
  const ddl = useDdl(target, tab === 'ddl' && hasDdl);

  return (
    <div className="ks-info">
      <TabStrip
        tabs={[
          { id: 'general', label: tr('Allgemein', 'General') },
          { id: 'ddl', label: 'DDL', hidden: !hasDdl }
        ]}
        value={tab === 'ddl' && !hasDdl ? 'general' : tab}
        onChange={setTab}
      />
      {!general ? (
        <EmptyState title={tr('Kein Objekt ausgewählt', 'No object selected')} />
      ) : tab === 'general' || !hasDdl ? (
        <div className="ks-info-body">
          <div className="ks-info-head">
            <ObjIcon kind={general.kind} size={28} />
            <div className="ks-info-title selectable">{general.title}</div>
          </div>
          <div className="ks-info-grid">
            {general.pairs
              .filter(([, v]) => v !== '' && v !== null && v !== undefined)
              .map(([k, v]) => (
                <div key={k} className="ks-info-pair">
                  <div className="ks-info-key">{k}</div>
                  <div className="ks-info-val selectable">{v}</div>
                </div>
              ))}
          </div>
        </div>
      ) : (
        <div className="ks-info-ddl">
          {ddl.loading ? (
            <div className="ks-tab-loading">
              <Spinner />
            </div>
          ) : ddl.error ? (
            <div className="danger-text" style={{ padding: 12 }}>
              {ddl.error}
            </div>
          ) : (
            <>
              <IconButton
                className="ks-info-copy"
                icon={<Copy size={14} />}
                title={tr('Kopieren', 'Copy')}
                onClick={() => {
                  void navigator.clipboard.writeText(ddl.text ?? '');
                  toast(tr('DDL kopiert', 'DDL copied'));
                }}
              />
              <SqlHighlight sql={ddl.text ?? ''} className="selectable" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

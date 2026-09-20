// Privilege manager: object tree on the left, accounts × privileges of the selected object on the right.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { FileCode, RefreshCw, Save, Undo2, UserMinus, UserPlus } from 'lucide-react';
import type { AccountGrants, PrivGrant, PrivTarget, UsersServerInfo } from '@shared/apis/users';
import { tr } from '@shared/i18n';
import { dbMatches, GRANT_OPTION, grantOptionApplies, privsForLevel, sortPrivs, targetKey, unescapeDbPattern } from '@shared/users/privileges';
import { grantStatements } from '@shared/users/grants';
import { accountKey, accountLabel, accountSql } from '@shared/users/statements';
import { api, errorMessage, RpcError } from '../../api/client';
import { ObjIcon } from '../../components/icons';
import { SqlHighlight } from '../../components/SqlHighlight';
import { toast } from '../../components/Toast';
import { Button, Checkbox, EmptyState, Spinner, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { askDialog, confirmDialog, Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { SEP, showContextMenu } from '../../components/ui/Menu';
import { keyCombo } from '../../lib/shortcuts';
import { setCloseGuard, useTabs, type TabProps } from '../../store/tabs';
import { getProfile, metaSession } from '../../store/workspace';
import { GLOBAL_TARGET, ObjectTree } from './ObjectTree';
import { pickAccounts } from './pickers';
import { PrivMatrix, type MatrixRow } from './PrivMatrix';
import { targetKind, targetLabel } from './UserDesignTab';
import { serverInfoFor, useUsersVersion } from './usersStore';
import './users.css';

function sameTarget(g: PrivTarget, t: PrivTarget): boolean {
  return (
    g.level === t.level &&
    (t.level === 'global' || dbMatches(g.db, t.db)) &&
    g.name === t.name &&
    g.column === t.column &&
    g.routineType === t.routineType
  );
}

const entryOf = (list: PrivGrant[], t: PrivTarget) => list.find((g) => sameTarget(g, t));
const countKey = (t: PrivTarget) => `${t.level}|${unescapeDbPattern(t.db)}|${t.name}|${t.column}|${t.routineType}`;

export default function PrivilegesTab({ tab, active }: TabProps) {
  const cid = (tab.params as { connectionId: string }).connectionId;
  const [server, setServer] = useState<UsersServerInfo | null>(null);
  const [orig, setOrig] = useState<AccountGrants[]>([]);
  const [edits, setEdits] = useState<Record<string, PrivGrant[]>>({});
  const [extra, setExtra] = useState<Record<string, string[]>>({});
  const [node, setNode] = useState<{ key: string; target: PrivTarget }>({ key: targetKey(GLOBAL_TARGET), target: GLOBAL_TARGET });
  const [selected, setSelected] = useState<string[]>([]);
  const [showSystem, setShowSystem] = useState(false);
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(
    async (refreshInfo: boolean) => {
      setStatus((s) => ({ ...s, loading: true }));
      try {
        const [info, list] = await Promise.all([serverInfoFor(cid, refreshInfo), api.users.allGrants(metaSession(cid))]);
        setServer(info);
        setOrig(list);
        setStatus({ loading: false, error: null });
        return list;
      } catch (e) {
        setStatus({ loading: false, error: errorMessage(e) });
        return null;
      }
    },
    [cid]
  );

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  const byKey = useMemo(() => new Map(orig.map((a) => [accountKey(a), a])), [orig]);
  const grantsOf = useCallback((k: string) => edits[k] ?? byKey.get(k)?.grants ?? [], [edits, byKey]);
  const target = node.target;

  const changes = useMemo(() => {
    if (!server) return [];
    const out: { account: AccountGrants; key: string; statements: ReturnType<typeof grantStatements> }[] = [];
    for (const [k, list] of Object.entries(edits)) {
      const a = byKey.get(k);
      if (!a) continue;
      const st = grantStatements(accountSql(server, a, a.isRole), a.grants, list, server.serverType);
      if (st.length) out.push({ account: a, key: k, statements: st });
    }
    return out;
  }, [edits, byKey, server]);
  const dirty = changes.length > 0;

  useEffect(() => {
    useTabs.getState().update(tab.id, { dirty });
  }, [dirty, tab.id]);

  const rows = useMemo(() => {
    const ex = new Set(extra[node.key] ?? []);
    return orig
      .filter((a) => {
        const k = accountKey(a);
        if (ex.has(k)) return true;
        if (!showSystem && a.system) return false;
        return !!entryOf(grantsOf(k), target);
      })
      .sort((a, b) => Number(a.isRole) - Number(b.isRole) || accountLabel(a).localeCompare(accountLabel(b)));
  }, [orig, extra, node.key, showSystem, grantsOf, target]);

  const columns = useMemo(() => {
    if (!server) return [];
    const names = privsForLevel(server.privileges, target.level);
    for (const a of rows) for (const p of entryOf(grantsOf(accountKey(a)), target)?.privs ?? []) if (p !== GRANT_OPTION && !names.includes(p)) names.push(p);
    if (grantOptionApplies(target.level)) names.push(GRANT_OPTION);
    return names.map((priv) => ({ priv, title: server.privileges.find((p) => p.name === priv)?.comment }));
  }, [server, target, rows, grantsOf]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of orig) {
      if (!showSystem && a.system) continue;
      for (const g of grantsOf(accountKey(a))) if (g.privs.length) m.set(countKey(g), (m.get(countKey(g)) ?? 0) + 1);
    }
    return m;
  }, [orig, showSystem, grantsOf]);

  const toggle = (k: string, priv: string, on: boolean) =>
    setEdits((prev) => {
      const list = (prev[k] ?? byKey.get(k)?.grants ?? []).map((g) => ({ ...g, privs: [...g.privs] }));
      let e = entryOf(list, target);
      if (!e) {
        e = { ...target, privs: [] };
        list.push(e);
      }
      e.privs = sortPrivs(on ? [...e.privs, priv] : e.privs.filter((p) => p !== priv));
      return { ...prev, [k]: list };
    });

  const clearPrivs = (keys: string[]) =>
    setEdits((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        const list = (prev[k] ?? byKey.get(k)?.grants ?? []).map((g) => ({ ...g, privs: [...g.privs] }));
        const e = entryOf(list, target);
        if (e) e.privs = [];
        next[k] = list;
      }
      return next;
    });

  const addAccounts = async () => {
    const present = new Set(rows.map((a) => accountKey(a)));
    const candidates = orig
      .filter((a) => !present.has(accountKey(a)))
      .map((a) => ({ key: accountKey(a), label: accountLabel(a), isRole: a.isRole, system: a.system }));
    const keys = await pickAccounts(candidates, tr('Konten für „{o}“ hinzufügen', 'Add accounts for "{o}"', { o: targetLabel(target) }));
    if (!keys?.length) return;
    setExtra((prev) => ({ ...prev, [node.key]: [...new Set([...(prev[node.key] ?? []), ...keys])] }));
    setSelected(keys);
  };

  const save = async (): Promise<boolean> => {
    if (!server || busy) return false;
    if (!changes.length) return true;
    setBusy(true);
    const sid = metaSession(cid);
    const applied: string[] = [];
    let failure: { label: string; error: RpcError } | null = null;
    try {
      for (const c of changes) {
        const res = await api.users.apply(sid, c.statements);
        if (res.error) {
          failure = { label: accountLabel(c.account), error: new RpcError(res.error) };
          break;
        }
        applied.push(c.key);
      }
    } catch (e) {
      failure = { label: '', error: e instanceof RpcError ? e : new RpcError({ message: errorMessage(e) }) };
    }
    const list = await loadAll(false);
    if (list) {
      setEdits((prev) => {
        const next = { ...prev };
        for (const k of applied) delete next[k];
        return next;
      });
      if (!failure) setExtra({});
    }
    setBusy(false);
    useUsersVersion.getState().bump(cid);
    if (failure) {
      await errorDialog(failure.error, failure.label ? tr('Fehler bei {a}', 'Error for {a}', { a: failure.label }) : undefined);
      return false;
    }
    toast(tr('Rechte gespeichert', 'Privileges saved'), 'success');
    return true;
  };

  const discard = async () => {
    if (dirty && !(await confirmDialog({ message: tr('Alle ungespeicherten Änderungen verwerfen?', 'Discard all unsaved changes?'), danger: true, okLabel: tr('Verwerfen', 'Discard') }))) return;
    setEdits({});
    setExtra({});
  };

  const refresh = async () => {
    if (dirty && !(await confirmDialog({ message: tr('Ungespeicherte Änderungen verwerfen und neu laden?', 'Discard unsaved changes and reload?'), danger: true, okLabel: tr('Neu laden', 'Reload') }))) return;
    setEdits({});
    setExtra({});
    await loadAll(true);
  };

  const preview = () => {
    const text = changes.map((c) => `-- ${accountLabel(c.account)}\n${c.statements.map((s) => `${s.display};`).join('\n')}`).join('\n\n');
    void openDialog<void>((close) => (
      <Dialog
        title={tr('SQL-Vorschau', 'SQL Preview')}
        width={760}
        height={520}
        noPadding
        resizable
        onClose={() => close()}
        onSubmit={() => close()}
        footerLeft={
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(text);
              toast(tr('SQL kopiert', 'SQL copied'));
            }}
          >
            {tr('Kopieren', 'Copy')}
          </Button>
        }
        footer={<Button type="submit" variant="primary">OK</Button>}
      >
        <div className="ks-users-sql">
          <SqlHighlight sql={text} className="selectable" />
        </div>
      </Dialog>
    ));
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    setCloseGuard(tab.id, async () => {
      if (!dirtyRef.current) return true;
      const a = await askDialog({
        title: tr('Ungespeicherte Änderungen', 'Unsaved changes'),
        message: tr('Geänderte Rechte speichern?', 'Save the changed privileges?'),
        yesLabel: tr('Speichern', 'Save'),
        noLabel: tr('Verwerfen', 'Discard')
      });
      if (a === 'cancel') return false;
      if (a === 'no') return true;
      return saveRef.current();
    });
    return () => setCloseGuard(tab.id, null);
  }, [tab.id]);

  useEffect(() => {
    if (!active) return;
    const onCmd = (e: Event) => {
      if ((e as CustomEvent).detail === 'save') void saveRef.current();
    };
    window.addEventListener('ks-command', onCmd);
    return () => window.removeEventListener('ks-command', onCmd);
  }, [active]);

  if (!server) {
    return status.loading ? (
      <div className="ks-tab-loading">
        <Spinner size={22} />
      </div>
    ) : (
      <EmptyState icon={<ObjIcon kind="role" size={40} dim />} title={tr('Rechte konnten nicht geladen werden', 'Privileges could not be loaded')}>
        <p className="selectable">{status.error}</p>
        <Button icon={<RefreshCw size={14} />} onClick={() => void loadAll(true)}>
          {tr('Erneut versuchen', 'Try again')}
        </Button>
      </EmptyState>
    );
  }

  const matrixRows: MatrixRow[] = rows.map((a) => {
    const k = accountKey(a);
    const cur = entryOf(grantsOf(k), target);
    const before = entryOf(a.grants, target);
    return {
      key: k,
      icon: <ObjIcon kind={a.isRole ? 'role' : 'user'} size={15} dim={a.system} />,
      label: accountLabel(a),
      title: a.error ?? accountLabel(a),
      has: (p) => !!cur?.privs.includes(p),
      applicable: () => true,
      changed: (p) => !!cur?.privs.includes(p) !== !!before?.privs.includes(p)
    };
  });

  const levelText =
    target.level === 'global'
      ? tr('Globale Rechte (alle Datenbanken)', 'Global privileges (all databases)')
      : target.level === 'database'
        ? tr('Datenbank', 'Database')
        : target.level === 'table'
          ? tr('Tabelle / Ansicht', 'Table / view')
          : target.level === 'column'
            ? tr('Spalte', 'Column')
            : target.routineType === 'FUNCTION'
              ? tr('Funktion', 'Function')
              : tr('Prozedur', 'Procedure');

  return (
    <div
      className="ks-editor-layout"
      onKeyDown={(e) => {
        if (keyCombo(e) === 'Ctrl+S') {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }
      }}
    >
      <Toolbar>
        <ToolbarButton icon={busy ? <Spinner size={14} /> : <Save size={15} />} label={tr('Speichern', 'Save')} disabled={!dirty || busy} onClick={() => void save()} />
        <ToolbarButton icon={<Undo2 size={15} />} label={tr('Verwerfen', 'Discard')} disabled={!dirty || busy} onClick={() => void discard()} />
        <ToolbarSep />
        <ToolbarButton icon={<UserPlus size={15} />} label={tr('Konten hinzufügen …', 'Add accounts …')} onClick={() => void addAccounts()} />
        <ToolbarButton icon={<UserMinus size={15} />} label={tr('Rechte entfernen', 'Remove privileges')} disabled={!selected.length} onClick={() => clearPrivs(selected)} />
        <ToolbarSep />
        <ToolbarButton icon={<FileCode size={15} />} label={tr('SQL-Vorschau', 'SQL Preview')} disabled={!dirty} onClick={preview} />
        <ToolbarButton icon={status.loading ? <Spinner size={14} /> : <RefreshCw size={15} />} label={tr('Aktualisieren', 'Refresh')} disabled={busy} onClick={() => void refresh()} />
        <div className="spacer" />
        <Checkbox checked={showSystem} onChange={setShowSystem} label={tr('Systemkonten anzeigen', 'Show system accounts')} />
      </Toolbar>
      <div className="ks-editor-main">
        <Group orientation="horizontal" className="ks-users-privmgr-panels">
          <Panel id="tree" defaultSize="300px" minSize="180px" maxSize="55%">
            <div className="ks-users-panel">
              <div className="ks-users-panel-head">{tr('Objekte', 'Objects')}</div>
              <ObjectTree
                connectionId={cid}
                showGlobal
                selected={[node.key]}
                onSelect={(targets, keys) => {
                  if (!targets[0]) return;
                  setNode({ key: keys[0], target: targets[0] });
                  setSelected([]);
                }}
                badge={(t) => {
                  const n = counts.get(countKey(t));
                  return n ? <span className="ks-users-tree-badge">{n}</span> : null;
                }}
              />
            </div>
          </Panel>
          <Separator className="ks-users-splitter" />
          <Panel id="matrix" minSize="30%">
            <div className="ks-users-panel">
              <div className="ks-users-panel-head">
                {target.level === 'global' ? <ObjIcon kind="connection" size={15} /> : <ObjIcon kind={targetKind(target)} size={15} />}
                <span className="ellipsis">{target.level === 'global' ? getProfile(cid)?.name ?? '' : targetLabel(target)}</span>
                <span className="faint" style={{ fontWeight: 400 }}>
                  {levelText}
                </span>
              </div>
              <PrivMatrix
                head={tr('Konto', 'Account')}
                columns={columns}
                rows={matrixRows}
                selected={selected}
                onSelect={setSelected}
                onToggle={toggle}
                disabled={busy}
                onRowMenu={(e, key) => {
                  const keys = selected.includes(key) ? selected : [key];
                  if (!selected.includes(key)) setSelected([key]);
                  showContextMenu(e, [
                    {
                      label: tr('Alle Rechte gewähren', 'Grant all privileges'),
                      onClick: () => keys.forEach((k) => columns.forEach((c) => c.priv !== GRANT_OPTION && toggle(k, c.priv, true)))
                    },
                    { label: tr('Rechte entfernen', 'Remove privileges'), icon: <UserMinus size={14} />, onClick: () => clearPrivs(keys) },
                    SEP,
                    { label: tr('Konten hinzufügen …', 'Add accounts …'), icon: <UserPlus size={14} />, onClick: () => void addAccounts() }
                  ]);
                }}
                empty={
                  <div className="col" style={{ alignItems: 'center', gap: 10 }}>
                    <span>{tr('Kein Konto hat Rechte auf diesem Objekt.', 'No account has privileges on this object.')}</span>
                    <Button icon={<UserPlus size={14} />} onClick={() => void addAccounts()}>
                      {tr('Konten hinzufügen …', 'Add accounts …')}
                    </Button>
                  </div>
                }
              />
            </div>
          </Panel>
        </Group>
      </div>
      <div className="ks-statusline">
        <span>{tr('{n} Konten mit Rechten', '{n} accounts with privileges', { n: rows.length })}</span>
        <span>{dirty ? tr('{n} geänderte Konten', '{n} changed accounts', { n: changes.length }) : tr('Keine Änderungen', 'No changes')}</span>
        {orig.some((a) => a.error) && <span className="danger-text">{tr('Rechte einzelner Konten konnten nicht gelesen werden', 'Privileges of some accounts could not be read')}</span>}
      </div>
    </div>
  );
}

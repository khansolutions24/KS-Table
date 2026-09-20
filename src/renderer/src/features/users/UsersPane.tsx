// Accounts and roles of a connection (objects tab, category "Benutzer").

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, PanelRight, Pencil, RefreshCw, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import type { AccountDetails, AccountSummary, UsersServerInfo } from '@shared/apis/users';
import { tr } from '@shared/i18n';
import { accountKey, accountLabel, dropAccountStatement } from '@shared/users/statements';
import { api, errorMessage, RpcError } from '../../api/client';
import { ObjIcon } from '../../components/icons';
import { ObjectTable, type OTColumn } from '../../components/ObjectTable';
import { SqlHighlight } from '../../components/SqlHighlight';
import { toast } from '../../components/Toast';
import { Button, Checkbox, EmptyState, IconButton, SearchInput, Spinner, Toolbar, ToolbarButton, ToolbarSep } from '../../components/ui/controls';
import { confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { SEP, showContextMenu, type MenuItem } from '../../components/ui/Menu';
import { useTabs } from '../../store/tabs';
import { metaSession, useWorkspace } from '../../store/workspace';
import { openPrivilegeManager, openUserDesigner, serverInfoFor, userTabKey, useUsersVersion } from './usersStore';
import './users.css';

function statusText(a: AccountSummary): string {
  if (a.isRole) return '';
  const parts: string[] = [];
  if (a.locked) parts.push(tr('Gesperrt', 'Locked'));
  if (a.passwordExpired) parts.push(tr('Passwort abgelaufen', 'Password expired'));
  return parts.join(', ') || tr('Aktiv', 'Active');
}

function typeText(a: AccountSummary): string {
  if (a.isRole) return tr('Rolle', 'Role');
  return a.system ? tr('Systemkonto', 'System account') : tr('Benutzer', 'User');
}

const COLUMNS: OTColumn<AccountSummary>[] = [
  { id: 'name', label: tr('Name', 'Name'), width: 220, render: (a) => a.user || tr('(anonym)', '(anonymous)'), sortValue: (a) => a.user },
  { id: 'host', label: tr('Host', 'Host'), width: 150, render: (a) => a.host, sortValue: (a) => a.host },
  { id: 'type', label: tr('Typ', 'Type'), width: 110, render: typeText, sortValue: typeText },
  { id: 'plugin', label: tr('Authentifizierung', 'Authentication'), width: 170, render: (a) => a.plugin, sortValue: (a) => a.plugin },
  { id: 'status', label: tr('Status', 'Status'), width: 170, render: statusText, sortValue: statusText },
  { id: 'comment', label: tr('Kommentar', 'Comment'), width: 280, render: (a) => a.comment, sortValue: (a) => a.comment }
];

async function dropAccounts(connectionId: string, server: UsersServerInfo, list: AccountSummary[]): Promise<void> {
  if (!list.length) return;
  const system = list.some((a) => a.system);
  const one = list[0];
  const message =
    (list.length === 1
      ? tr('Soll {t} „{n}“ wirklich gelöscht werden?', 'Do you really want to delete {t} "{n}"?', {
          t: one.isRole ? tr('die Rolle', 'the role') : tr('der Benutzer', 'the user'),
          n: accountLabel(one)
        })
      : tr('Sollen {c} Konten wirklich gelöscht werden?\n\n{list}', 'Do you really want to delete {c} accounts?\n\n{list}', {
          c: list.length,
          list: list.slice(0, 12).map((a) => `• ${accountLabel(a)}`).join('\n') + (list.length > 12 ? '\n…' : '')
        })) +
    (system ? `\n\n${tr('Achtung: Systemkonten werden vom Server selbst benötigt.', 'Warning: system accounts are required by the server itself.')}` : '');
  const ok = await confirmDialog({ title: tr('Konten löschen', 'Delete accounts'), message, okLabel: tr('Löschen', 'Delete'), danger: true });
  if (!ok) return;
  const keys = new Set(list.map((a) => userTabKey(connectionId, a)));
  const ids = useTabs.getState().tabs.filter((t) => t.key && keys.has(t.key)).map((t) => t.id);
  if (!(await useTabs.getState().closeMany(ids))) return;
  try {
    const res = await api.users.apply(metaSession(connectionId), list.map((a) => dropAccountStatement(server, a, a.isRole)));
    if (res.error) void errorDialog(new RpcError(res.error));
    else toast(list.length === 1 ? tr('„{n}“ gelöscht', '"{n}" deleted', { n: accountLabel(one) }) : tr('{n} Konten gelöscht', '{n} accounts deleted', { n: list.length }), 'success');
  } catch (e) {
    void errorDialog(e);
  }
  useUsersVersion.getState().bump(connectionId);
}

function AccountInfo({ connectionId, account, version }: { connectionId: string; account: AccountSummary; version: number }) {
  const [details, setDetails] = useState<AccountDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    api.users
      .details(metaSession(connectionId), account.user, account.host)
      .then((d) => !cancelled && setDetails(d))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [connectionId, account.user, account.host, version]);

  const chips = (list: { user: string; host: string; admin?: boolean }[]) =>
    list.length ? (
      <div className="ks-users-chips">
        {list.map((r) => (
          <span key={accountKey(r)} className="ks-users-chip" title={r.admin ? tr('Mit Admin-Option', 'With admin option') : undefined}>
            <ObjIcon kind="role" size={12} />
            <span className="ellipsis">{accountLabel(r)}</span>
            {r.admin ? <span className="faint">A</span> : null}
          </span>
        ))}
      </div>
    ) : (
      <span className="faint">{tr('keine', 'none')}</span>
    );

  return (
    <div className="ks-users-info">
      <div className="ks-users-info-head">
        <ObjIcon kind={account.isRole ? 'role' : 'user'} size={28} />
        <div className="grow">
          <div className="ks-users-info-title selectable">{accountLabel(account)}</div>
          <div className="ks-users-info-sub">
            {typeText(account)}
            {!account.isRole && account.plugin ? ` · ${account.plugin}` : ''}
          </div>
        </div>
      </div>
      {error && <div className="danger-text">{error}</div>}
      {!details && !error && <Spinner />}
      {details && (
        <>
          {!details.isRole && (
            <div>
              <div className="ks-users-info-label">{tr('Status', 'Status')}</div>
              <div className="selectable">
                {statusText(account)} · {details.hasPassword ? tr('Passwort gesetzt', 'Password set') : tr('Kein Passwort', 'No password')}
              </div>
            </div>
          )}
          <div>
            <div className="ks-users-info-label">{tr('Mitglied von', 'Member of')}</div>
            {chips(details.roles)}
          </div>
          {details.isRole && (
            <div>
              <div className="ks-users-info-label">{tr('Mitglieder', 'Members')}</div>
              {chips(details.members)}
            </div>
          )}
          {!details.isRole && details.defaultRoles.length > 0 && (
            <div>
              <div className="ks-users-info-label">{tr('Standardrollen', 'Default roles')}</div>
              {chips(details.defaultRoles)}
            </div>
          )}
          <div>
            <div className="ks-users-info-label">{tr('Rechte (SHOW GRANTS)', 'Privileges (SHOW GRANTS)')}</div>
            <div className="ks-users-grants">
              <SqlHighlight sql={details.showGrants.map((l) => `${l};`).join('\n')} className="selectable" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function UsersPane({ connectionId }: { connectionId: string }) {
  const [server, setServer] = useState<UsersServerInfo | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [showInfo, setShowInfo] = useState(true);
  const version = useUsersVersion((s) => s.versions[connectionId] ?? 0);
  const sessionId = useWorkspace((s) => s.conns[connectionId]?.sessionId);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const [info, list] = await Promise.all([serverInfoFor(connectionId), api.users.list(metaSession(connectionId))]);
      setServer(info);
      setAccounts(list);
      setState({ loading: false, error: null });
    } catch (e) {
      setState({ loading: false, error: errorMessage(e) });
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load, version, sessionId]);

  useEffect(() => setSelected([]), [connectionId]);

  const rows = useMemo(() => {
    const f = search.trim().toLowerCase();
    return accounts.filter((a) => (showSystem || !a.system) && (!f || accountLabel(a).toLowerCase().includes(f) || a.comment.toLowerCase().includes(f)));
  }, [accounts, search, showSystem]);
  const byKey = useMemo(() => new Map(accounts.map((a) => [accountKey(a), a])), [accounts]);
  const selItems = selected.map((k) => byKey.get(k)).filter((a): a is AccountSummary => !!a);
  const one = selItems.length === 1 ? selItems[0] : null;

  const edit = (a: AccountSummary) => openUserDesigner(connectionId, { user: a.user, host: a.host }, a.isRole);
  const drop = (list: AccountSummary[]) => server && void dropAccounts(connectionId, server, list);
  const copy = (list: AccountSummary[]) => {
    void navigator.clipboard.writeText(list.map(accountLabel).join('\n'));
    toast(tr('Kopiert', 'Copied'));
  };

  const menu = (e: React.MouseEvent, row: AccountSummary | null, keys: string[]) => {
    const list = keys.map((k) => byKey.get(k)).filter((a): a is AccountSummary => !!a);
    const items: MenuItem[] = [
      { label: tr('Bearbeiten …', 'Edit …'), icon: <Pencil size={14} />, disabled: list.length !== 1, onClick: () => row && edit(row) },
      { label: tr('Neuer Benutzer …', 'New User …'), icon: <UserPlus size={14} />, onClick: () => openUserDesigner(connectionId, null, false) },
      { label: tr('Neue Rolle …', 'New Role …'), icon: <Users size={14} />, hidden: !server?.roles, onClick: () => openUserDesigner(connectionId, null, true) },
      SEP,
      { label: tr('Löschen', 'Delete'), icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, disabled: !list.length, onClick: () => drop(list) },
      SEP,
      { label: tr('Rechte-Manager', 'Privilege Manager'), icon: <ShieldCheck size={14} />, onClick: () => openPrivilegeManager(connectionId) },
      { label: tr('Name kopieren', 'Copy Name'), icon: <Copy size={14} />, shortcut: 'Ctrl+C', disabled: !list.length, onClick: () => copy(list) },
      SEP,
      { label: tr('Aktualisieren', 'Refresh'), icon: <RefreshCw size={14} />, shortcut: 'F5', onClick: () => void load() }
    ];
    showContextMenu(e, items);
  };

  const onKey = (combo: string, keys: string[]): boolean => {
    const list = keys.map((k) => byKey.get(k)).filter((a): a is AccountSummary => !!a);
    if (combo === 'F5') void load();
    else if (combo === 'Delete' && list.length) drop(list);
    else if (combo === 'Ctrl+C' && list.length) copy(list);
    else return false;
    return true;
  };

  if (state.error && !accounts.length) {
    return (
      <div className="ks-users-pane">
        <EmptyState icon={<ObjIcon kind="user" size={40} dim />} title={tr('Konten konnten nicht geladen werden', 'Accounts could not be loaded')}>
          <p className="selectable">{state.error}</p>
          <Button icon={<RefreshCw size={14} />} onClick={() => void load()}>
            {tr('Erneut versuchen', 'Try again')}
          </Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="ks-users-pane">
      <Toolbar>
        <ToolbarButton icon={<UserPlus size={15} />} label={tr('Neuer Benutzer', 'New User')} onClick={() => openUserDesigner(connectionId, null, false)} />
        {server?.roles && <ToolbarButton icon={<Users size={15} />} label={tr('Neue Rolle', 'New Role')} onClick={() => openUserDesigner(connectionId, null, true)} />}
        <ToolbarButton icon={<Pencil size={15} />} label={tr('Bearbeiten', 'Edit')} disabled={!one} onClick={() => one && edit(one)} />
        <ToolbarButton icon={<Trash2 size={15} />} label={tr('Löschen', 'Delete')} disabled={!selItems.length} onClick={() => drop(selItems)} />
        <ToolbarSep />
        <ToolbarButton icon={<ShieldCheck size={15} />} label={tr('Rechte-Manager', 'Privilege Manager')} onClick={() => openPrivilegeManager(connectionId)} />
        <ToolbarSep />
        <ToolbarButton icon={state.loading ? <Spinner size={14} /> : <RefreshCw size={15} />} label={tr('Aktualisieren', 'Refresh')} onClick={() => void load()} />
        <div className="spacer" />
        <Checkbox checked={showSystem} onChange={setShowSystem} label={tr('Systemkonten', 'System accounts')} />
        <SearchInput value={search} onChange={setSearch} className="ks-users-search" placeholder={tr('Konten suchen', 'Search accounts')} />
        <IconButton icon={<PanelRight size={15} />} active={showInfo} title={tr('Details anzeigen', 'Show details')} onClick={() => setShowInfo((v) => !v)} />
      </Toolbar>
      <div className="ks-users-main">
        <div className="ks-users-list">
          {state.loading && !accounts.length ? (
            <div className="ks-tab-loading">
              <Spinner size={22} />
            </div>
          ) : (
            <ObjectTable<AccountSummary>
              columns={COLUMNS}
              rows={rows}
              rowKey={accountKey}
              nameOf={accountLabel}
              iconOf={(a) => <ObjIcon kind={a.isRole ? 'role' : 'user'} dim={a.system || a.locked} />}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={edit}
              onContextMenu={menu}
              onKey={onKey}
              empty={<span className="faint">{search ? tr('Keine Treffer', 'No matches') : tr('Keine Konten', 'No accounts')}</span>}
            />
          )}
        </div>
        {showInfo && one && <AccountInfo connectionId={connectionId} account={one} version={version} />}
      </div>
      <div className="ks-objects-status">
        {selItems.length > 1
          ? tr('{s} von {n} Konten ausgewählt', '{s} of {n} accounts selected', { s: selItems.length, n: rows.length })
          : one
            ? accountLabel(one)
            : tr('{u} Benutzer, {r} Rollen', '{u} users, {r} roles', { u: rows.filter((a) => !a.isRole).length, r: rows.filter((a) => a.isRole).length })}
        {server && (
          <span className="spacer" style={{ textAlign: 'right' }}>
            {tr('Angemeldet als {u}', 'Signed in as {u}', { u: server.currentUser })}
          </span>
        )}
      </div>
    </div>
  );
}

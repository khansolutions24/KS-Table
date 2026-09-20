// Designer for user accounts and roles: general, advanced, member of / members, server privileges,
// object privileges and SQL preview. Saves the difference as CREATE/ALTER/RENAME USER, GRANT/REVOKE, SET DEFAULT ROLE.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, Copy, Eraser, Plus, RotateCcw, Save, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import type { AccountDetails, AccountModel, AccountRef, AccountSummary, PrivGrant, PrivTarget, RequireCurrent, UsersServerInfo } from '@shared/apis/users';
import { tr } from '@shared/i18n';
import {
  GRANT_OPTION,
  OBJECT_PRIV_ORDER,
  compareTargets,
  grantOptionApplies,
  isDbWildcard,
  makeTarget,
  privsForLevel,
  sortPrivs,
  targetKey
} from '@shared/users/privileges';
import {
  accountKey,
  accountLabel,
  buildAccountStatements,
  draftOf,
  modelFingerprint,
  modelRef,
  newAccountModel,
  validateDraft,
  type AccountDraft
} from '@shared/users/statements';
import { api, errorMessage, RpcError } from '../../api/client';
import { ObjIcon, type ObjKind } from '../../components/icons';
import { SqlHighlight } from '../../components/SqlHighlight';
import { toast } from '../../components/Toast';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  NumberInput,
  RadioGroup,
  SearchInput,
  Section,
  Select,
  Spinner,
  TabStrip,
  TextInput,
  Toolbar,
  ToolbarButton,
  ToolbarSep
} from '../../components/ui/controls';
import { alertDialog, askDialog, confirmDialog, errorDialog } from '../../components/ui/Dialog';
import { SEP, showContextMenu } from '../../components/ui/Menu';
import { keyCombo } from '../../lib/shortcuts';
import { setCloseGuard, useTabs, type TabProps } from '../../store/tabs';
import { metaSession } from '../../store/workspace';
import { pickPrivTargets } from './pickers';
import { PrivMatrix, type MatrixRow } from './PrivMatrix';
import { designerTitle, openPrivilegeManager, serverInfoFor, toModel, userTabKey, useUsersVersion } from './usersStore';
import './users.css';

type SectionId = 'general' | 'advanced' | 'memberOf' | 'members' | 'server' | 'objects' | 'sql';

interface Params {
  connectionId: string;
  user: string | null;
  host: string | null;
  role?: boolean;
}

const LW = 180;

const fingerprint = (d: AccountDraft) => modelFingerprint(d, { password: d.password, expireNow: d.expireNow });
const num = (v: number | '', min = 0) => (v === '' ? min : Math.max(min, Math.floor(v)));

export function targetLabel(t: PrivTarget): string {
  switch (t.level) {
    case 'global':
      return '*.*';
    case 'database':
      return `${t.db}.*${isDbWildcard(t.db) ? ` (${tr('Muster', 'pattern')})` : ''}`;
    case 'column':
      return `${t.db}.${t.name}.${t.column}`;
    case 'routine':
      return `${t.db}.${t.name} (${t.routineType === 'FUNCTION' ? tr('Funktion', 'Function') : tr('Prozedur', 'Procedure')})`;
    default:
      return `${t.db}.${t.name}`;
  }
}

export function targetKind(t: PrivTarget): ObjKind {
  if (t.level === 'database') return 'database';
  if (t.level === 'column') return 'column';
  if (t.level === 'routine') return t.routineType === 'FUNCTION' ? 'function' : 'procedure';
  return 'table';
}

export default function UserDesignTab({ tab, active }: TabProps) {
  const params = tab.params as unknown as Params;
  const cid = params.connectionId;
  const [ref, setRef] = useState<AccountRef | null>(
    typeof params.user === 'string' && typeof params.host === 'string' ? { user: params.user, host: params.host } : null
  );
  const [server, setServer] = useState<UsersServerInfo | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [details, setDetails] = useState<AccountDetails | null>(null);
  const [orig, setOrig] = useState<AccountModel | null>(null);
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [confirm, setConfirm] = useState('');
  const [section, setSection] = useState<SectionId>('general');
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [busy, setBusy] = useState(false);
  const [privFilter, setPrivFilter] = useState('');
  const [objSel, setObjSel] = useState<string[]>([]);

  const load = useCallback(
    async (target: AccountRef | null) => {
      setStatus({ loading: true, error: null });
      try {
        const sid = metaSession(cid);
        const [info, list] = await Promise.all([serverInfoFor(cid), api.users.list(sid)]);
        const det = target ? await api.users.details(sid, target.user, target.host) : null;
        const model = det ? toModel(det) : newAccountModel(info, !!params.role);
        const d = draftOf(model);
        if (!det) d.password = '';
        setServer(info);
        setAccounts(list);
        setDetails(det);
        setOrig(det ? model : null);
        setDraft(d);
        setBaseline(fingerprint(d));
        setConfirm('');
        setObjSel([]);
        setStatus({ loading: false, error: null });
      } catch (e) {
        setStatus({ loading: false, error: errorMessage(e) });
      }
    },
    [cid, params.role]
  );

  useEffect(() => {
    void load(ref);
    // loads once; later reloads are explicit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (patch: Partial<AccountDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const dirty = !!draft && fingerprint(draft) !== baseline;
  const statements = useMemo(() => (server && draft ? buildAccountStatements(server, orig, draft) : []), [server, orig, draft]);
  const problem = useMemo(
    () => (server && draft ? validateDraft(server, orig, draft, draft.isRole ? null : confirm) : null),
    [server, orig, draft, confirm]
  );

  useEffect(() => {
    useTabs.getState().update(tab.id, { dirty });
  }, [dirty, tab.id]);

  const save = async (): Promise<boolean> => {
    if (!server || !draft || busy) return false;
    if (problem) {
      await alertDialog({ message: problem, kind: 'warning' });
      return false;
    }
    if (!statements.length) {
      setBaseline(fingerprint(draft));
      return true;
    }
    setBusy(true);
    try {
      const sid = metaSession(cid);
      const res = await api.users.apply(sid, statements);
      const executed = statements.slice(0, res.executed);
      const moved = executed.some((s) => /^(CREATE (USER|ROLE)|RENAME USER)\b/.test(s.sql));
      const identity = moved ? modelRef(server, draft) : orig ? modelRef(server, orig) : null;
      const passwordSent = executed.some((s) => s.sql !== s.display);
      if (identity) {
        const det = await api.users.details(sid, identity.user, identity.host);
        const model = toModel(det);
        setDetails(det);
        setOrig(model);
        setRef(identity);
        useTabs.getState().update(tab.id, { key: userTabKey(cid, identity), title: designerTitle(identity, model.isRole) });
        useTabs.getState().updateParams(tab.id, { user: identity.user, host: identity.host });
        if (!res.error) {
          const d = draftOf(model);
          setDraft(d);
          setBaseline(fingerprint(d));
          setConfirm('');
        } else {
          // keep the remaining changes; a password that was already set is not sent again
          if (passwordSent) {
            setDraft((d) => (d ? { ...d, password: null } : d));
            setConfirm('');
          }
          setBaseline(fingerprint(draftOf(model)));
        }
        useUsersVersion.getState().bump(cid);
        setAccounts(await api.users.list(sid));
      }
      if (res.error) {
        await errorDialog(new RpcError(res.error), tr('Speichern fehlgeschlagen', 'Saving failed'));
        return false;
      }
      toast(tr('„{a}“ gespeichert', '"{a}" saved', { a: accountLabel(identity ?? modelRef(server, draft)) }), 'success');
      return true;
    } catch (e) {
      await errorDialog(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const labelRef = useRef('');
  labelRef.current = draft ? accountLabel(modelRef(server ?? { roleHost: true }, draft)) || tr('Unbenannt', 'Untitled') : '';

  useEffect(() => {
    setCloseGuard(tab.id, async () => {
      if (!dirtyRef.current) return true;
      const a = await askDialog({
        title: tr('Ungespeicherte Änderungen', 'Unsaved changes'),
        message: tr('Änderungen an „{n}“ speichern?', 'Save changes to "{n}"?', { n: labelRef.current }),
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

  const reload = async () => {
    if (dirty && !(await confirmDialog({ message: tr('Ungespeicherte Änderungen verwerfen und neu laden?', 'Discard unsaved changes and reload?'), danger: true, okLabel: tr('Neu laden', 'Reload') }))) return;
    await load(ref);
  };

  // ───────── object privileges helpers ─────────
  const updatePrivs = (keys: string[], fn: (g: PrivGrant) => string[]) =>
    setDraft((d) => (d ? { ...d, grants: d.grants.map((g) => (keys.includes(targetKey(g)) ? { ...g, privs: sortPrivs(fn(g)) } : g)) } : d));
  const togglePriv = (target: PrivTarget, priv: string, on: boolean) =>
    setDraft((d) => {
      if (!d) return d;
      const k = targetKey(target);
      const grants = d.grants.map((g) => ({ ...g, privs: [...g.privs] }));
      let e = grants.find((g) => targetKey(g) === k);
      if (!e) {
        e = { ...target, privs: [] };
        grants.push(e);
      }
      e.privs = sortPrivs(on ? [...e.privs, priv] : e.privs.filter((p) => p !== priv));
      return { ...d, grants };
    });
  const applicable = (level: PrivTarget['level'], priv: string) =>
    priv === GRANT_OPTION ? grantOptionApplies(level) : !!server?.privileges.find((p) => p.name === priv)?.levels.includes(level);
  const origHas = (t: PrivTarget, priv: string) => !!orig?.grants.find((g) => targetKey(g) === targetKey(t))?.privs.includes(priv);

  const addTargets = async () => {
    const targets = await pickPrivTargets(cid);
    if (!targets) return;
    setDraft((d) => {
      if (!d) return d;
      const have = new Set(d.grants.map(targetKey));
      const fresh = targets.filter((t) => !have.has(targetKey(t))).map((t) => ({ ...t, privs: [] as string[] }));
      return { ...d, grants: [...d.grants, ...fresh] };
    });
    setObjSel(targets.map(targetKey));
  };
  const removeTargets = (keys: string[]) => {
    setDraft((d) => (d ? { ...d, grants: d.grants.filter((g) => g.level === 'global' || !keys.includes(targetKey(g))) } : d));
    setObjSel([]);
  };
  const allFor = (g: PrivGrant) => (server ? privsForLevel(server.privileges, g.level) : []);

  // ───────── rendering ─────────
  if (status.loading && !draft) {
    return (
      <div className="ks-tab-loading">
        <Spinner size={22} />
      </div>
    );
  }
  if (!server || !draft) {
    return (
      <EmptyState icon={<ObjIcon kind="user" size={40} dim />} title={tr('Konto konnte nicht geladen werden', 'The account could not be loaded')}>
        <p className="selectable">{status.error}</p>
        <Button icon={<RotateCcw size={14} />} onClick={() => void load(ref)}>
          {tr('Erneut versuchen', 'Try again')}
        </Button>
      </EmptyState>
    );
  }

  const d = draft;
  const isRole = d.isRole;
  const self = new Set([accountKey(modelRef(server, d)), ...(orig ? [accountKey(modelRef(server, orig))] : [])]);
  const plugins = [...new Set([...server.plugins, ...(d.plugin ? [d.plugin] : [])])];

  const general = (
    <div className="ks-users-scroll">
      <div className="ks-form ks-users-form">
        <Field label={isRole ? tr('Rollenname', 'Role name') : tr('Benutzername', 'User name')} labelWidth={LW}>
          <TextInput
            data-autofocus
            value={d.user}
            disabled={!!orig && isRole && !server.renameRole}
            onChange={(e) => set({ user: e.target.value })}
          />
        </Field>
        {(!isRole || server.roleHost) && (
          <Field
            label={tr('Host', 'Host')}
            labelWidth={LW}
            hint={tr('% = beliebiger Host; auch localhost, IP-Adressen, Muster wie 192.168.1.% oder Rechnernamen', '% = any host; also localhost, IP addresses, patterns like 192.168.1.% or host names')}
          >
            <TextInput value={d.host} list={`ks-users-hosts-${tab.id}`} onChange={(e) => set({ host: e.target.value })} />
            <datalist id={`ks-users-hosts-${tab.id}`}>
              {['%', 'localhost', '127.0.0.1', '::1'].map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </Field>
        )}
        {isRole ? (
          <div className="ks-users-note">
            {tr(
              'Eine Rolle bündelt Rechte. Sie kann Benutzern oder anderen Rollen zugewiesen werden (Registerkarte „Mitglieder“).',
              'A role bundles privileges. It can be granted to users or other roles (tab "Members").'
            )}
          </div>
        ) : (
          <>
            <Field label={tr('Authentifizierung', 'Authentication')} labelWidth={LW}>
              <Select value={d.plugin} onChange={(plugin) => set({ plugin })} options={plugins.map((p) => ({ value: p, label: p === server.defaultPlugin ? `${p} (${tr('Standard', 'default')})` : p }))} />
            </Field>
            <Field label={tr('Passwort', 'Password')} labelWidth={LW}>
              <TextInput
                type="password"
                autoComplete="new-password"
                value={d.password ?? ''}
                placeholder={orig ? (details?.hasPassword ? tr('(unverändert)', '(unchanged)') : tr('(kein Passwort gesetzt)', '(no password set)')) : ''}
                onChange={(e) => set({ password: orig && e.target.value === '' ? null : e.target.value })}
              />
            </Field>
            <Field label={tr('Passwort bestätigen', 'Confirm password')} labelWidth={LW}>
              <TextInput type="password" autoComplete="new-password" value={confirm} invalid={(d.password ?? '') !== confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            {server.passwordExpire && (
              <Field label={tr('Passwortablauf', 'Password expiry')} labelWidth={LW}>
                <div className="ks-users-inline">
                  <Select
                    value={d.expirePolicy}
                    onChange={(expirePolicy) => set({ expirePolicy })}
                    options={[
                      { value: 'default', label: tr('Serverstandard', 'Server default') },
                      { value: 'never', label: tr('Läuft nie ab', 'Never expires') },
                      { value: 'interval', label: tr('Nach Anzahl Tagen', 'After a number of days') }
                    ]}
                  />
                  {d.expirePolicy === 'interval' && (
                    <>
                      <NumberInput value={d.expireDays} min={1} max={65535} style={{ width: 90 }} onChange={(v) => set({ expireDays: num(v, 1) })} />
                      <span>{tr('Tage', 'days')}</span>
                    </>
                  )}
                </div>
              </Field>
            )}
            <Field label="" labelWidth={LW}>
              <div className="col" style={{ gap: 4 }}>
                {server.passwordExpire && (
                  <Checkbox
                    checked={d.expireNow}
                    onChange={(expireNow) => set({ expireNow })}
                    label={tr('Passwort sofort ablaufen lassen (Änderung bei der nächsten Anmeldung)', 'Expire the password now (change at the next login)')}
                  />
                )}
                {server.accountLock && (
                  <Checkbox checked={d.locked} onChange={(locked) => set({ locked })} label={tr('Konto gesperrt (keine Anmeldung möglich)', 'Account locked (no login possible)')} />
                )}
              </div>
            </Field>
            {server.comment && (
              <Field label={tr('Kommentar', 'Comment')} labelWidth={LW}>
                <TextInput value={d.comment} onChange={(e) => set({ comment: e.target.value })} />
              </Field>
            )}
            {details && (
              <Section title={tr('Aktueller Zustand', 'Current state')}>
                <div className="ks-users-note">
                  {details.hasPassword ? tr('Ein Passwort ist gesetzt.', 'A password is set.') : tr('Es ist kein Passwort gesetzt.', 'No password is set.')}{' '}
                  {details.passwordExpired ? tr('Das Passwort ist abgelaufen.', 'The password has expired.') : ''}
                  {details.locked ? ` ${tr('Das Konto ist gesperrt.', 'The account is locked.')}` : ''}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );

  const policySelect = (value: number | null, onChange: (v: number | null) => void, unit: string, fallback: number) => (
    <div className="ks-users-inline">
      <Select
        value={value === null ? 'default' : 'value'}
        onChange={(v) => onChange(v === 'default' ? null : fallback)}
        options={[
          { value: 'default', label: tr('Serverstandard', 'Server default') },
          { value: 'value', label: tr('Eigener Wert', 'Custom value') }
        ]}
      />
      {value !== null && (
        <>
          <NumberInput value={value} min={0} style={{ width: 90 }} onChange={(v) => onChange(num(v))} />
          <span>{unit}</span>
        </>
      )}
    </div>
  );

  const advanced = (
    <div className="ks-users-scroll">
      <div className="ks-form ks-users-form">
        <Section title={tr('Ressourcenlimits (0 = unbegrenzt)', 'Resource limits (0 = unlimited)')}>
          <Field label={tr('Abfragen pro Stunde', 'Queries per hour')} labelWidth={LW}>
            <NumberInput value={d.maxQueries} min={0} style={{ width: 140 }} onChange={(v) => set({ maxQueries: num(v) })} />
          </Field>
          <Field label={tr('Änderungen pro Stunde', 'Updates per hour')} labelWidth={LW}>
            <NumberInput value={d.maxUpdates} min={0} style={{ width: 140 }} onChange={(v) => set({ maxUpdates: num(v) })} />
          </Field>
          <Field label={tr('Verbindungen pro Stunde', 'Connections per hour')} labelWidth={LW}>
            <NumberInput value={d.maxConnections} min={0} style={{ width: 140 }} onChange={(v) => set({ maxConnections: num(v) })} />
          </Field>
          <Field label={tr('Gleichzeitige Verbindungen', 'Simultaneous connections')} labelWidth={LW}>
            <NumberInput value={d.maxUserConnections} min={0} style={{ width: 140 }} onChange={(v) => set({ maxUserConnections: num(v) })} />
          </Field>
          {server.maxStatementTime && (
            <Field label={tr('Max. Ausführungszeit (s)', 'Max. statement time (s)')} labelWidth={LW}>
              <NumberInput value={d.maxStatementTime} min={0} step={0.1} style={{ width: 140 }} onChange={(v) => set({ maxStatementTime: v === '' ? 0 : Math.max(0, v) })} />
            </Field>
          )}
        </Section>
        <Section title={tr('Verschlüsselte Verbindung (SSL/TLS)', 'Encrypted connection (SSL/TLS)')}>
          <RadioGroup
            value={d.ssl}
            onChange={(ssl) => set({ ssl })}
            options={[
              { value: 'NONE', label: tr('Nicht erforderlich', 'Not required') },
              { value: 'SSL', label: tr('Verschlüsselte Verbindung erforderlich', 'Encrypted connection required') },
              { value: 'X509', label: tr('Gültiges X.509-Clientzertifikat erforderlich', 'Valid X.509 client certificate required') },
              { value: 'SPECIFIED', label: tr('Bestimmte Angaben erforderlich', 'Specific requirements') }
            ]}
          />
          <fieldset className="ks-plain-fieldset" disabled={d.ssl !== 'SPECIFIED'}>
            <div className="ks-form">
              <Field label={tr('Cipher', 'Cipher')} labelWidth={LW}>
                <TextInput value={d.sslCipher} placeholder="ECDHE-RSA-AES256-GCM-SHA384" onChange={(e) => set({ sslCipher: e.target.value })} />
              </Field>
              <Field label={tr('Zertifikatsaussteller', 'Certificate issuer')} labelWidth={LW}>
                <TextInput value={d.x509Issuer} placeholder="/C=DE/O=Beispiel/CN=CA" onChange={(e) => set({ x509Issuer: e.target.value })} />
              </Field>
              <Field label={tr('Zertifikatsbetreff', 'Certificate subject')} labelWidth={LW}>
                <TextInput value={d.x509Subject} placeholder="/C=DE/O=Beispiel/CN=client" onChange={(e) => set({ x509Subject: e.target.value })} />
              </Field>
            </div>
          </fieldset>
        </Section>
        {(server.passwordOptions || server.failedLogin) && (
          <Section title={tr('Passwortrichtlinie', 'Password policy')}>
            {server.passwordOptions && (
              <>
                <Field label={tr('Passwortverlauf', 'Password history')} labelWidth={LW} hint={tr('Anzahl früherer Passwörter, die nicht erneut verwendet werden dürfen', 'Number of previous passwords that must not be reused')}>
                  {policySelect(d.passwordHistory, (passwordHistory) => set({ passwordHistory }), tr('Passwörter', 'passwords'), 5)}
                </Field>
                <Field label={tr('Wiederverwendung', 'Reuse interval')} labelWidth={LW} hint={tr('Tage, bevor ein Passwort erneut verwendet werden darf', 'Days before a password may be reused')}>
                  {policySelect(d.passwordReuseDays, (passwordReuseDays) => set({ passwordReuseDays }), tr('Tage', 'days'), 365)}
                </Field>
                <Field label={tr('Aktuelles Passwort', 'Current password')} labelWidth={LW} hint={tr('Muss beim Ändern des eigenen Passworts angegeben werden', 'Must be given when users change their own password')}>
                  <Select<RequireCurrent>
                    value={d.requireCurrent}
                    onChange={(requireCurrent) => set({ requireCurrent })}
                    options={[
                      { value: 'default', label: tr('Serverstandard', 'Server default') },
                      { value: 'required', label: tr('Erforderlich', 'Required') },
                      { value: 'optional', label: tr('Optional', 'Optional') }
                    ]}
                    style={{ width: 220 }}
                  />
                </Field>
              </>
            )}
            {server.failedLogin && (
              <>
                <Field label={tr('Fehlversuche bis Sperre', 'Failed attempts until lock')} labelWidth={LW} hint={tr('0 = keine temporäre Sperre', '0 = no temporary lock')}>
                  <NumberInput value={d.failedLoginAttempts} min={0} max={32767} style={{ width: 140 }} onChange={(v) => set({ failedLoginAttempts: num(v) })} />
                </Field>
                <Field label={tr('Sperrdauer', 'Lock duration')} labelWidth={LW}>
                  <div className="ks-users-inline">
                    <Select
                      value={d.passwordLockDays < 0 ? 'unbounded' : d.passwordLockDays === 0 ? 'off' : 'days'}
                      onChange={(v) => set({ passwordLockDays: v === 'unbounded' ? -1 : v === 'off' ? 0 : 1 })}
                      options={[
                        { value: 'off', label: tr('Keine', 'None') },
                        { value: 'days', label: tr('Tage', 'Days') },
                        { value: 'unbounded', label: tr('Bis zur Entsperrung', 'Until unlocked') }
                      ]}
                    />
                    {d.passwordLockDays > 0 && (
                      <NumberInput value={d.passwordLockDays} min={1} max={32767} style={{ width: 90 }} onChange={(v) => set({ passwordLockDays: num(v, 1) })} />
                    )}
                  </div>
                </Field>
              </>
            )}
          </Section>
        )}
      </div>
    </div>
  );

  // roles granted to this account
  const roleCandidates: AccountRef[] = (() => {
    const list: AccountRef[] = accounts.filter((a) => a.isRole).map((a) => ({ user: a.user, host: a.host }));
    for (const r of d.roles) if (!list.some((x) => accountKey(x) === accountKey(r))) list.push(r);
    return list.filter((r) => !self.has(accountKey(r))).sort((a, b) => accountLabel(a).localeCompare(accountLabel(b)));
  })();
  const hasRole = (r: AccountRef) => d.roles.find((x) => accountKey(x) === accountKey(r));
  const origRole = (r: AccountRef) => orig?.roles.find((x) => accountKey(x) === accountKey(r));
  const isDefault = (r: AccountRef, list: AccountRef[]) => list.some((x) => accountKey(x) === accountKey(r));
  const setRole = (r: AccountRef, on: boolean) =>
    setDraft((x) => {
      if (!x) return x;
      const k = accountKey(r);
      const roles = on ? [...x.roles.filter((y) => accountKey(y) !== k), { user: r.user, host: r.host, admin: false }] : x.roles.filter((y) => accountKey(y) !== k);
      return { ...x, roles, defaultRoles: on ? x.defaultRoles : x.defaultRoles.filter((y) => accountKey(y) !== k) };
    });
  const setRoleAdmin = (r: AccountRef, admin: boolean) =>
    setDraft((x) => (x ? { ...x, roles: x.roles.map((y) => (accountKey(y) === accountKey(r) ? { ...y, admin } : y)) } : x));
  const setDefaultRole = (r: AccountRef, on: boolean) =>
    setDraft((x) => {
      if (!x) return x;
      const k = accountKey(r);
      const rest = x.defaultRoles.filter((y) => accountKey(y) !== k);
      const ref2 = { user: r.user, host: r.host };
      return { ...x, defaultRoles: on ? (server.defaultRoles === 'single' ? [ref2] : [...rest, ref2]) : rest };
    });
  const showDefaults = !isRole && server.defaultRoles !== 'none';

  const memberOf = (
    <div className="ks-users-scroll">
      <div className="col" style={{ gap: 10 }}>
        <div className="ks-users-note">
          {isRole
            ? tr('Rollen, deren Rechte diese Rolle zusätzlich erhält.', 'Roles whose privileges this role receives in addition.')
            : server.defaultRoles === 'single'
              ? tr('Zugewiesene Rollen. Die Standardrolle wird bei der Anmeldung automatisch aktiviert (MariaDB: eine Standardrolle).', 'Granted roles. The default role is activated automatically at login (MariaDB: one default role).')
              : tr('Zugewiesene Rollen. Standardrollen werden bei der Anmeldung automatisch aktiviert.', 'Granted roles. Default roles are activated automatically at login.')}
        </div>
        {roleCandidates.length ? (
          <table className="ks-table ks-users-roles">
            <thead>
              <tr>
                <th>{tr('Rolle', 'Role')}</th>
                <th className="check">{tr('Gewährt', 'Granted')}</th>
                <th className="check">{tr('Admin-Option', 'Admin option')}</th>
                {showDefaults && <th className="check">{tr('Standardrolle', 'Default role')}</th>}
              </tr>
            </thead>
            <tbody>
              {roleCandidates.map((r) => {
                const g = hasRole(r);
                const o = origRole(r);
                return (
                  <tr key={accountKey(r)}>
                    <td>
                      <span className="row">
                        <ObjIcon kind="role" size={14} />
                        {accountLabel(r)}
                      </span>
                    </td>
                    <td className={`check${!!g !== !!o ? ' changed' : ''}`}>
                      <input type="checkbox" checked={!!g} onChange={(e) => setRole(r, e.target.checked)} />
                    </td>
                    <td className={`check${!!g?.admin !== !!o?.admin ? ' changed' : ''}`}>
                      <input type="checkbox" checked={!!g?.admin} disabled={!g} onChange={(e) => setRoleAdmin(r, e.target.checked)} />
                    </td>
                    {showDefaults && (
                      <td className={`check${isDefault(r, d.defaultRoles) !== isDefault(r, orig?.defaultRoles ?? []) ? ' changed' : ''}`}>
                        <input type="checkbox" checked={isDefault(r, d.defaultRoles)} disabled={!g} onChange={(e) => setDefaultRole(r, e.target.checked)} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="faint">{tr('Auf diesem Server sind keine Rollen angelegt.', 'There are no roles on this server.')}</div>
        )}
      </div>
    </div>
  );

  // members of a role
  const memberCandidates = accounts
    .filter((a) => !self.has(accountKey(a)) && (!a.system || d.members.some((m) => accountKey(m) === accountKey(a))))
    .sort((a, b) => Number(a.isRole) - Number(b.isRole) || accountLabel(a).localeCompare(accountLabel(b)));
  const member = (a: AccountRef) => d.members.find((m) => accountKey(m) === accountKey(a));
  const origMember = (a: AccountRef) => orig?.members.find((m) => accountKey(m) === accountKey(a));
  const setMember = (a: AccountRef, on: boolean, admin = false) =>
    setDraft((x) => {
      if (!x) return x;
      const k = accountKey(a);
      const rest = x.members.filter((m) => accountKey(m) !== k);
      return { ...x, members: on ? [...rest, { user: a.user, host: a.host, admin }] : rest };
    });

  const members = (
    <div className="ks-users-scroll">
      <div className="col" style={{ gap: 10 }}>
        <div className="ks-users-note">{tr('Benutzer und Rollen, denen diese Rolle zugewiesen ist.', 'Users and roles this role is granted to.')}</div>
        <table className="ks-table ks-users-roles">
          <thead>
            <tr>
              <th>{tr('Konto', 'Account')}</th>
              <th>{tr('Typ', 'Type')}</th>
              <th className="check">{tr('Gewährt', 'Granted')}</th>
              <th className="check">{tr('Admin-Option', 'Admin option')}</th>
            </tr>
          </thead>
          <tbody>
            {memberCandidates.map((a) => {
              const m = member(a);
              const o = origMember(a);
              return (
                <tr key={accountKey(a)}>
                  <td>
                    <span className="row">
                      <ObjIcon kind={a.isRole ? 'role' : 'user'} size={14} dim={a.system} />
                      {accountLabel(a)}
                    </span>
                  </td>
                  <td>{a.isRole ? tr('Rolle', 'Role') : tr('Benutzer', 'User')}</td>
                  <td className={`check${!!m !== !!o ? ' changed' : ''}`}>
                    <input type="checkbox" checked={!!m} onChange={(e) => setMember(a, e.target.checked)} />
                  </td>
                  <td className={`check${!!m?.admin !== !!o?.admin ? ' changed' : ''}`}>
                    <input type="checkbox" checked={!!m?.admin} disabled={!m} onChange={(e) => setMember(a, true, e.target.checked)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  // server (global) privileges
  const globalTarget = makeTarget('global');
  const globalEntry = d.grants.find((g) => g.level === 'global');
  const globalNames = (() => {
    const names = privsForLevel(server.privileges, 'global');
    for (const p of globalEntry?.privs ?? []) if (p !== GRANT_OPTION && !names.includes(p)) names.push(p);
    return names;
  })();
  const f = privFilter.trim().toUpperCase();
  const visibleGlobal = globalNames.filter((n) => !f || n.includes(f));
  const isDynamic = (n: string) => server.privileges.find((p) => p.name === n)?.dynamic ?? /^[A-Z0-9_]+$/.test(n);
  const globalBox = (n: string) => {
    const on = !!globalEntry?.privs.includes(n);
    return (
      <Checkbox
        key={n}
        className={on !== origHas(globalTarget, n) ? 'changed' : undefined}
        checked={on}
        title={server.privileges.find((p) => p.name === n)?.comment || n}
        label={n}
        onChange={(v) => togglePriv(globalTarget, n, v)}
      />
    );
  };
  const setAllGlobal = (on: boolean) =>
    setDraft((x) => {
      if (!x) return x;
      const keepGo = x.grants.find((g) => g.level === 'global')?.privs.includes(GRANT_OPTION);
      const privs = on ? [...globalNames, ...(keepGo ? [GRANT_OPTION] : [])] : keepGo ? [GRANT_OPTION] : [];
      return { ...x, grants: [...x.grants.filter((g) => g.level !== 'global'), { ...globalTarget, privs: sortPrivs(privs) }] };
    });

  const serverPrivs = (
    <div className="ks-users-fill">
      <div className="ks-users-subbar">
        <SearchInput value={privFilter} onChange={setPrivFilter} placeholder={tr('Rechte filtern', 'Filter privileges')} />
        <Button size="sm" icon={<CheckCheck size={13} />} onClick={() => setAllGlobal(true)}>
          {tr('Alle gewähren', 'Grant all')}
        </Button>
        <Button size="sm" icon={<Eraser size={13} />} onClick={() => setAllGlobal(false)}>
          {tr('Alle entziehen', 'Revoke all')}
        </Button>
        <div className="spacer" />
        <Checkbox
          className={!!globalEntry?.privs.includes(GRANT_OPTION) !== origHas(globalTarget, GRANT_OPTION) ? 'changed' : undefined}
          checked={!!globalEntry?.privs.includes(GRANT_OPTION)}
          onChange={(v) => togglePriv(globalTarget, GRANT_OPTION, v)}
          label={tr('WITH GRANT OPTION (darf Rechte weitergeben)', 'WITH GRANT OPTION (may pass on privileges)')}
        />
      </div>
      <div className="ks-users-scroll">
        <div className="ks-users-privgroup">{tr('Statische Rechte', 'Static privileges')}</div>
        <div className="ks-users-privgrid">{visibleGlobal.filter((n) => !isDynamic(n)).map(globalBox)}</div>
        {visibleGlobal.some(isDynamic) && (
          <>
            <div className="ks-users-privgroup">{tr('Dynamische Rechte', 'Dynamic privileges')}</div>
            <div className="ks-users-privgrid">{visibleGlobal.filter(isDynamic).map(globalBox)}</div>
          </>
        )}
        {!visibleGlobal.length && <div className="faint">{tr('Keine Treffer', 'No matches')}</div>}
      </div>
    </div>
  );

  // object privileges
  const objectColumns = (() => {
    const avail = server.privileges.filter((p) => p.levels.some((l) => l !== 'global')).map((p) => p.name);
    const cols = OBJECT_PRIV_ORDER.filter((p) => avail.includes(p));
    for (const p of avail) if (!cols.includes(p)) cols.push(p);
    return [...cols, GRANT_OPTION].map((priv) => ({ priv, title: server.privileges.find((p) => p.name === priv)?.comment }));
  })();
  const objectGrants = d.grants.filter((g) => g.level !== 'global').sort(compareTargets);
  const objRows: MatrixRow[] = objectGrants.map((g) => ({
    key: targetKey(g),
    icon: <ObjIcon kind={targetKind(g)} size={15} />,
    label: targetLabel(g),
    title: targetLabel(g),
    has: (p) => g.privs.includes(p),
    applicable: (p) => applicable(g.level, p),
    changed: (p) => origHas(g, p) !== g.privs.includes(p)
  }));
  const selGrants = objectGrants.filter((g) => objSel.includes(targetKey(g)));
  const objectPrivs = (
    <div className="ks-users-fill">
      <div className="ks-users-subbar">
        <Button size="sm" icon={<Plus size={13} />} onClick={() => void addTargets()}>
          {tr('Objekt hinzufügen …', 'Add object …')}
        </Button>
        <Button size="sm" icon={<Trash2 size={13} />} disabled={!selGrants.length} onClick={() => removeTargets(objSel)}>
          {tr('Entfernen', 'Remove')}
        </Button>
        <Button size="sm" icon={<CheckCheck size={13} />} disabled={!selGrants.length} onClick={() => updatePrivs(objSel, (g) => [...allFor(g), ...(g.privs.includes(GRANT_OPTION) ? [GRANT_OPTION] : [])])}>
          {tr('Alle gewähren', 'Grant all')}
        </Button>
        <Button size="sm" icon={<Eraser size={13} />} disabled={!selGrants.length} onClick={() => updatePrivs(objSel, () => [])}>
          {tr('Alle entziehen', 'Revoke all')}
        </Button>
        <div className="spacer" />
        <span className="ks-users-note">{tr('Klick auf eine Spaltenüberschrift schaltet das Recht für alle bzw. die markierten Zeilen um.', 'Click a column header to toggle the privilege for all or the selected rows.')}</span>
      </div>
      <PrivMatrix
        head={tr('Objekt', 'Object')}
        columns={objectColumns}
        rows={objRows}
        selected={objSel}
        onSelect={setObjSel}
        onToggle={(key, priv, on) => {
          const g = objectGrants.find((x) => targetKey(x) === key);
          if (g) togglePriv(g, priv, on);
        }}
        onRowMenu={(e, key) => {
          const keys = objSel.includes(key) ? objSel : [key];
          if (!objSel.includes(key)) setObjSel([key]);
          showContextMenu(e, [
            { label: tr('Alle gewähren', 'Grant all'), icon: <CheckCheck size={14} />, onClick: () => updatePrivs(keys, (g) => [...allFor(g), ...(g.privs.includes(GRANT_OPTION) ? [GRANT_OPTION] : [])]) },
            { label: tr('Alle entziehen', 'Revoke all'), icon: <Eraser size={14} />, onClick: () => updatePrivs(keys, () => []) },
            SEP,
            { label: tr('Entfernen', 'Remove'), icon: <Trash2 size={14} />, danger: true, onClick: () => removeTargets(keys) }
          ]);
        }}
        empty={
          <div className="col" style={{ alignItems: 'center', gap: 10 }}>
            <span>{tr('Noch keine Rechte auf Datenbanken, Tabellen, Spalten oder Routinen.', 'No privileges on databases, tables, columns or routines yet.')}</span>
            <Button icon={<Plus size={14} />} onClick={() => void addTargets()}>
              {tr('Objekt hinzufügen …', 'Add object …')}
            </Button>
          </div>
        }
      />
    </div>
  );

  const sqlText = statements.map((s) => `${s.display};`).join('\n');
  const sqlPreview = (
    <div className="ks-users-fill">
      {problem && (
        <div className="ks-users-warning">
          <TriangleAlert size={15} />
          <span>{problem}</span>
        </div>
      )}
      <div className="ks-users-sql">
        {statements.length ? (
          <SqlHighlight sql={sqlText} className="selectable" />
        ) : (
          <div className="faint" style={{ padding: 16 }}>
            {tr('Keine Änderungen', 'No changes')}
          </div>
        )}
      </div>
    </div>
  );

  const label = accountLabel(modelRef(server, d)) || tr('Unbenannt', 'Untitled');

  return (
    <div
      className="ks-editor-layout ks-users-designer"
      onKeyDown={(e) => {
        if (keyCombo(e) === 'Ctrl+S') {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }
      }}
    >
      <Toolbar>
        <ToolbarButton icon={busy ? <Spinner size={14} /> : <Save size={15} />} label={tr('Speichern', 'Save')} disabled={busy || (!dirty && !!orig)} onClick={() => void save()} />
        {orig && <ToolbarButton icon={<RotateCcw size={15} />} label={tr('Neu laden', 'Reload')} disabled={busy} onClick={() => void reload()} />}
        <ToolbarSep />
        <ToolbarButton
          icon={<Copy size={15} />}
          label={tr('SQL kopieren', 'Copy SQL')}
          disabled={!statements.length}
          onClick={() => {
            void navigator.clipboard.writeText(sqlText);
            toast(tr('SQL kopiert', 'SQL copied'));
          }}
        />
        <ToolbarButton icon={<ShieldCheck size={15} />} label={tr('Rechte-Manager', 'Privilege Manager')} onClick={() => openPrivilegeManager(cid)} />
      </Toolbar>
      <TabStrip<SectionId>
        tabs={[
          { id: 'general', label: tr('Allgemein', 'General') },
          { id: 'advanced', label: tr('Erweitert', 'Advanced'), hidden: isRole },
          { id: 'memberOf', label: tr('Mitglied von', 'Member Of'), hidden: !server.roles },
          { id: 'members', label: tr('Mitglieder', 'Members'), hidden: !isRole || !server.roles },
          { id: 'server', label: tr('Serverrechte', 'Server Privileges') },
          { id: 'objects', label: tr('Rechte', 'Privileges'), badge: objectGrants.length || undefined },
          { id: 'sql', label: tr('SQL-Vorschau', 'SQL Preview'), badge: statements.length || undefined }
        ]}
        value={section}
        onChange={setSection}
      />
      <div className="ks-editor-main">
        {section === 'general' && general}
        {section === 'advanced' && !isRole && advanced}
        {section === 'memberOf' && memberOf}
        {section === 'members' && isRole && members}
        {section === 'server' && serverPrivs}
        {section === 'objects' && objectPrivs}
        {section === 'sql' && sqlPreview}
      </div>
      <div className="ks-statusline">
        <span className="ellipsis">{label}</span>
        <span>{orig ? (isRole ? tr('Bestehende Rolle', 'Existing role') : tr('Bestehender Benutzer', 'Existing user')) : isRole ? tr('Neue Rolle', 'New role') : tr('Neuer Benutzer', 'New user')}</span>
        <span>{dirty ? tr('{n} Anweisung(en) ausstehend', '{n} statement(s) pending', { n: statements.length }) : tr('Keine Änderungen', 'No changes')}</span>
        {problem && dirty && <span className="danger-text ellipsis">{problem}</span>}
        <span className="spacer" />
        <span>{server.serverType === 'mariadb' ? 'MariaDB' : 'MySQL'}</span>
      </div>
    </div>
  );
}

// New / edit connection dialog (General, Advanced, Databases, SSL, SSH, HTTP).

import { useState } from 'react';
import { Download, Plus, RefreshCw } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { ConnectionConfig } from '@shared/types';
import { api } from '../../api/client';
import { ObjIcon } from '../../components/icons';
import { alertDialog, Dialog, errorDialog } from '../../components/ui/Dialog';
import {
  Button,
  Checkbox,
  ColorSwatches,
  Field,
  NumberInput,
  RadioGroup,
  Section,
  Select,
  Spinner,
  TabStrip,
  TextArea,
  TextInput
} from '../../components/ui/controls';
import { PathInput } from '../../components/ui/PathInput';
import { toast } from '../../components/Toast';
import { useWorkspace } from '../../store/workspace';

type TabId = 'general' | 'advanced' | 'databases' | 'ssl' | 'ssh' | 'http';

const ENCODINGS = [
  'utf8mb4', 'utf8mb3', 'latin1', 'latin2', 'ascii', 'binary', 'cp1250', 'cp1251', 'cp1256', 'cp1257', 'cp850', 'cp852',
  'cp866', 'greek', 'hebrew', 'koi8r', 'koi8u', 'big5', 'gbk', 'gb2312', 'gb18030', 'sjis', 'cp932', 'ujis', 'eucjpms',
  'euckr', 'tis620', 'armscii8', 'geostd8', 'keybcs2', 'macce', 'macroman', 'swe7', 'dec8', 'hp8'
];

const TIMEZONES = ['SYSTEM', '+00:00', '+01:00', '+02:00', 'UTC', 'Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'America/New_York'];

const LW = 150;

export function ConnectionDialog({
  initial,
  isNew,
  onClose
}: {
  initial: ConnectionConfig;
  isNew: boolean;
  onClose: (saved?: ConnectionConfig) => void;
}) {
  const [c, setC] = useState<ConnectionConfig>(() => structuredClone(initial));
  const [tab, setTab] = useState<TabId>('general');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [manualDb, setManualDb] = useState('');
  const groups = useWorkspace((s) => s.groups);

  const set = (patch: Partial<ConnectionConfig>) => setC((x) => ({ ...x, ...patch }));
  const setSsl = (patch: Partial<ConnectionConfig['ssl']>) => setC((x) => ({ ...x, ssl: { ...x.ssl, ...patch } }));
  const setSsh = (patch: Partial<ConnectionConfig['ssh']>) => setC((x) => ({ ...x, ssh: { ...x.ssh, ...patch } }));
  const setHttp = (patch: Partial<ConnectionConfig['http']>) => setC((x) => ({ ...x, http: { ...x.http, ...patch } }));

  const downloadTunnelScript = async () => {
    const path = await api.dialog.saveFile({
      title: tr('PHP-Skript speichern', 'Save PHP script'),
      defaultPath: 'ks_tunnel.php',
      filters: [{ name: 'PHP', extensions: ['php'] }]
    });
    if (!path) return;
    try {
      await api.fs.writeText(path, await api.app.tunnelScript());
      toast(tr('Skript gespeichert. Bitte Benutzer/Passwort im Skript anpassen und hochladen.', 'Script saved. Edit the user/password in it, then upload it.'), 'success');
    } catch (e) {
      void errorDialog(e);
    }
  };

  const final = (): ConnectionConfig => ({ ...c, name: c.name.trim() || c.host.trim() || 'localhost', host: c.host.trim() });

  const validate = (cfg: ConnectionConfig): string | null => {
    if (!cfg.socketPath && !cfg.host) return tr('Bitte einen Host angeben.', 'Please enter a host.');
    if (!(cfg.port > 0 && cfg.port < 65536)) return tr('Der Port muss zwischen 1 und 65535 liegen.', 'The port must be between 1 and 65535.');
    if (cfg.ssh.enabled && (!cfg.ssh.host || !cfg.ssh.user)) return tr('Für den SSH-Tunnel sind Host und Benutzer erforderlich.', 'The SSH tunnel requires a host and a user.');
    if (cfg.ssh.enabled && cfg.ssh.authMethod === 'publicKey' && !cfg.ssh.privateKeyPath) {
      return tr('Bitte den privaten SSH-Schlüssel angeben.', 'Please choose the private SSH key.');
    }
    return null;
  };

  const test = async () => {
    const cfg = final();
    const err = validate(cfg);
    if (err) {
      void alertDialog({ message: err, kind: 'warning' });
      return;
    }
    setBusy('test');
    try {
      const r = await api.connections.test(cfg);
      await alertDialog({
        title: tr('Verbindung testen', 'Test Connection'),
        kind: 'info',
        message: tr('Verbindung erfolgreich.\n\nServer: {v}\n{c}\nDauer: {ms} ms', 'Connection successful.\n\nServer: {v}\n{c}\nTime: {ms} ms', {
          v: r.serverVersion,
          c: r.versionComment,
          ms: r.durationMs
        })
      });
    } catch (e) {
      void errorDialog(e, tr('Verbindung fehlgeschlagen', 'Connection failed'));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const cfg = final();
    const err = validate(cfg);
    if (err) {
      void alertDialog({ message: err, kind: 'warning' });
      return;
    }
    setBusy('save');
    try {
      const saved = await useWorkspace.getState().saveProfile(cfg);
      onClose(saved);
    } catch (e) {
      void errorDialog(e);
    } finally {
      setBusy(null);
    }
  };

  const fetchDatabases = async () => {
    setFetching(true);
    try {
      setFetched(await api.connections.listDatabases(final()));
    } catch (e) {
      void errorDialog(e, tr('Datenbanken konnten nicht abgerufen werden', 'Could not fetch databases'));
    } finally {
      setFetching(false);
    }
  };

  const allDbs = [...new Set([...(fetched ?? []), ...c.databases])].sort((a, b) => a.localeCompare(b));
  const toggleDb = (name: string, on: boolean) =>
    set({ databases: on ? [...c.databases, name] : c.databases.filter((d) => d !== name) });

  const typeLabel = c.type === 'mariadb' ? 'MariaDB' : 'MySQL';

  return (
    <Dialog
      title={isNew ? tr('Neue Verbindung ({t})', 'New Connection ({t})', { t: typeLabel }) : tr('Verbindung bearbeiten – {n}', 'Edit Connection – {n}', { n: initial.name })}
      icon={<ObjIcon kind={c.type === 'mariadb' ? 'connection-mariadb' : 'connection'} size={18} />}
      width={640}
      height={600}
      onClose={() => onClose()}
      onSubmit={() => void save()}
      noPadding
      footerLeft={
        <Button onClick={() => void test()} disabled={!!busy} icon={busy === 'test' ? <Spinner size={13} /> : undefined}>
          {tr('Verbindung testen', 'Test Connection')}
        </Button>
      }
      footer={
        <>
          <Button type="submit" variant="primary" disabled={!!busy}>
            OK
          </Button>
          <Button onClick={() => onClose()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <TabStrip
        tabs={[
          { id: 'general', label: tr('Allgemein', 'General') },
          { id: 'advanced', label: tr('Erweitert', 'Advanced') },
          { id: 'databases', label: tr('Datenbanken', 'Databases') },
          { id: 'ssl', label: 'SSL' },
          { id: 'ssh', label: 'SSH' },
          { id: 'http', label: 'HTTP' }
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="ks-conn-body">
        {tab === 'general' && (
          <div className="ks-form">
            <Field label={tr('Verbindungsname', 'Connection name')} labelWidth={LW}>
              <TextInput data-autofocus value={c.name} placeholder={c.host || 'localhost'} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label={tr('Servertyp', 'Server type')} labelWidth={LW}>
              <Select
                value={c.type}
                onChange={(type) => set({ type })}
                options={[
                  { value: 'mysql', label: 'MySQL' },
                  { value: 'mariadb', label: 'MariaDB' }
                ]}
              />
            </Field>
            <Section title={tr('Server', 'Server')}>
              <Field label={tr('Host', 'Host')} labelWidth={LW - 14}>
                <TextInput value={c.host} placeholder="localhost" onChange={(e) => set({ host: e.target.value })} />
              </Field>
              <Field label={tr('Port', 'Port')} labelWidth={LW - 14}>
                <NumberInput value={c.port} min={1} max={65535} style={{ width: 120 }} onChange={(v) => set({ port: v === '' ? 0 : v })} />
              </Field>
            </Section>
            <Section title={tr('Anmeldung', 'Authentication')}>
              <Field label={tr('Benutzername', 'User name')} labelWidth={LW - 14}>
                <TextInput value={c.user} onChange={(e) => set({ user: e.target.value })} />
              </Field>
              <Field label={tr('Passwort', 'Password')} labelWidth={LW - 14}>
                <TextInput type="password" value={c.password ?? ''} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
              </Field>
              <Field label="" labelWidth={LW - 14}>
                <Checkbox checked={c.savePassword} onChange={(v) => set({ savePassword: v })} label={tr('Passwort speichern', 'Save password')} />
              </Field>
            </Section>
            <Field label={tr('Farbe', 'Color')} labelWidth={LW}>
              <ColorSwatches value={c.color} onChange={(color) => set({ color })} />
            </Field>
            <Field label={tr('Gruppe', 'Group')} labelWidth={LW}>
              <Select
                value={c.groupId ?? ''}
                onChange={(v) => set({ groupId: v || null })}
                options={[{ value: '', label: tr('(Keine Gruppe)', '(No group)') }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
              />
            </Field>
          </div>
        )}

        {tab === 'advanced' && (
          <div className="ks-form">
            <Field label={tr('Zeichensatz', 'Encoding')} labelWidth={LW}>
              <Select value={c.encoding} onChange={(encoding) => set({ encoding })} options={ENCODINGS} style={{ width: 200 }} />
            </Field>
            <Field label={tr('Keep-Alive-Intervall', 'Keepalive interval')} labelWidth={LW} hint={tr('Sekunden, 0 = aus', 'seconds, 0 = off')}>
              <NumberInput value={c.keepAliveInterval} min={0} style={{ width: 120 }} onChange={(v) => set({ keepAliveInterval: v === '' ? 0 : v })} />
            </Field>
            <Field label={tr('Verbindungs-Timeout', 'Connect timeout')} labelWidth={LW} hint={tr('Sekunden', 'seconds')}>
              <NumberInput value={c.connectTimeout} min={1} style={{ width: 120 }} onChange={(v) => set({ connectTimeout: v === '' ? 15 : v })} />
            </Field>
            <Field label={tr('Sitzungszeitzone', 'Session time zone')} labelWidth={LW}>
              <TextInput list="ks-tz" value={c.timezone} placeholder={tr('Serverstandard', 'Server default')} onChange={(e) => set({ timezone: e.target.value })} />
              <datalist id="ks-tz">
                {TIMEZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Field label={tr('Named Pipe / Socket', 'Named pipe / socket')} labelWidth={LW} hint={tr('Leer = TCP/IP', 'Empty = TCP/IP')}>
              <TextInput
                value={c.socketPath}
                placeholder={window.ksBridge?.platform === 'win32' || !window.ksBridge ? '\\\\.\\pipe\\MySQL' : '/var/run/mysqld/mysqld.sock'}
                onChange={(e) => set({ socketPath: e.target.value })}
              />
            </Field>
            <Field label="" labelWidth={LW}>
              <div className="col" style={{ gap: 4 }}>
                <Checkbox checked={c.useCompression} onChange={(v) => set({ useCompression: v })} label={tr('Komprimierung verwenden', 'Use compression')} />
                <Checkbox checked={c.autoConnect} onChange={(v) => set({ autoConnect: v })} label={tr('Beim Programmstart automatisch verbinden', 'Auto connect at startup')} />
                <Checkbox
                  checked={c.readOnly}
                  onChange={(v) => set({ readOnly: v })}
                  label={tr('Schreibgeschützte Verbindung (nur lesende Transaktionen)', 'Read-only connection (read-only transactions)')}
                />
              </div>
            </Field>
            <Field label={tr('Init-SQL', 'Init SQL')} labelWidth={LW} alignTop hint={tr('Wird nach jedem Verbindungsaufbau ausgeführt', 'Executed after every connect')}>
              <TextArea className="mono" rows={4} value={c.initSql} placeholder="SET SESSION sql_mode = '…';" onChange={(e) => set({ initSql: e.target.value })} />
            </Field>
            <Field label={tr('Notizen', 'Notes')} labelWidth={LW} alignTop>
              <TextArea rows={3} value={c.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
          </div>
        )}

        {tab === 'databases' && (
          <div className="ks-form">
            <Checkbox
              checked={c.useCustomDatabaseList}
              onChange={(v) => set({ useCustomDatabaseList: v })}
              label={tr('Nur ausgewählte Datenbanken anzeigen', 'Show selected databases only')}
            />
            <div className="ks-conn-dblist-toolbar">
              <Button size="sm" icon={fetching ? <Spinner size={12} /> : <RefreshCw size={13} />} disabled={fetching} onClick={() => void fetchDatabases()}>
                {tr('Datenbanken abrufen', 'Fetch databases')}
              </Button>
              <div className="spacer" />
              <TextInput
                style={{ width: 200, height: 24 }}
                placeholder={tr('Datenbank hinzufügen', 'Add database')}
                value={manualDb}
                onChange={(e) => setManualDb(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (manualDb.trim()) toggleDb(manualDb.trim(), true);
                    setManualDb('');
                  }
                }}
              />
              <Button
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => {
                  if (manualDb.trim()) toggleDb(manualDb.trim(), true);
                  setManualDb('');
                }}
              />
            </div>
            <div className={`ks-conn-dblist ${c.useCustomDatabaseList ? '' : 'disabled'}`}>
              {allDbs.length === 0 && (
                <div className="faint" style={{ padding: 10 }}>
                  {tr('Klicken Sie auf „Datenbanken abrufen“.', 'Click "Fetch databases".')}
                </div>
              )}
              {allDbs.map((d) => (
                <Checkbox
                  key={d}
                  checked={c.databases.includes(d)}
                  disabled={!c.useCustomDatabaseList}
                  onChange={(v) => toggleDb(d, v)}
                  label={
                    <span className="row" style={{ gap: 6 }}>
                      <ObjIcon kind="database" size={14} />
                      {d}
                    </span>
                  }
                />
              ))}
            </div>
            <Checkbox
              checked={c.hideSystemDatabases}
              onChange={(v) => set({ hideSystemDatabases: v })}
              label={tr('Systemdatenbanken ausblenden (mysql, sys, information_schema, performance_schema)', 'Hide system databases (mysql, sys, information_schema, performance_schema)')}
            />
          </div>
        )}

        {tab === 'ssl' && (
          <div className="ks-form">
            <Checkbox checked={c.ssl.enabled} onChange={(v) => setSsl({ enabled: v })} label={tr('SSL verwenden', 'Use SSL')} />
            <fieldset className="ks-plain-fieldset" disabled={!c.ssl.enabled}>
              <div className="ks-form">
                <Field label={tr('CA-Zertifikat', 'CA certificate')} labelWidth={LW}>
                  <PathInput value={c.ssl.ca} onChange={(ca) => setSsl({ ca })} filters={[{ name: 'PEM', extensions: ['pem', 'crt', 'cer'] }]} />
                </Field>
                <Field label={tr('Client-Zertifikat', 'Client certificate')} labelWidth={LW}>
                  <PathInput value={c.ssl.cert} onChange={(cert) => setSsl({ cert })} filters={[{ name: 'PEM', extensions: ['pem', 'crt', 'cer'] }]} />
                </Field>
                <Field label={tr('Client-Schlüssel', 'Client key')} labelWidth={LW}>
                  <PathInput value={c.ssl.key} onChange={(key) => setSsl({ key })} filters={[{ name: 'PEM', extensions: ['pem', 'key'] }]} />
                </Field>
                <Field label={tr('Schlüssel-Passphrase', 'Key passphrase')} labelWidth={LW}>
                  <TextInput type="password" value={c.ssl.passphrase ?? ''} onChange={(e) => setSsl({ passphrase: e.target.value })} />
                </Field>
                <Field label={tr('Cipher', 'Cipher')} labelWidth={LW}>
                  <TextInput value={c.ssl.cipher} placeholder="ECDHE-RSA-AES256-GCM-SHA384" onChange={(e) => setSsl({ cipher: e.target.value })} />
                </Field>
                <Field label="" labelWidth={LW}>
                  <div className="col" style={{ gap: 4 }}>
                    <Checkbox
                      checked={c.ssl.verifyServerCert}
                      onChange={(v) => setSsl({ verifyServerCert: v })}
                      label={tr('Serverzertifikat gegen CA prüfen', 'Verify server certificate against CA')}
                    />
                    <Checkbox
                      checked={c.ssl.verifyIdentity}
                      disabled={!c.ssl.verifyServerCert}
                      onChange={(v) => setSsl({ verifyIdentity: v })}
                      label={tr('Hostnamen des Servers prüfen', 'Verify server host name')}
                    />
                  </div>
                </Field>
              </div>
            </fieldset>
          </div>
        )}

        {tab === 'ssh' && (
          <div className="ks-form">
            <Checkbox checked={c.ssh.enabled} onChange={(v) => setSsh({ enabled: v })} label={tr('SSH-Tunnel verwenden', 'Use SSH tunnel')} />
            <fieldset className="ks-plain-fieldset" disabled={!c.ssh.enabled}>
              <div className="ks-form">
                <Field label={tr('Host', 'Host')} labelWidth={LW}>
                  <TextInput value={c.ssh.host} onChange={(e) => setSsh({ host: e.target.value })} />
                </Field>
                <Field label={tr('Port', 'Port')} labelWidth={LW}>
                  <NumberInput value={c.ssh.port} min={1} max={65535} style={{ width: 120 }} onChange={(v) => setSsh({ port: v === '' ? 22 : v })} />
                </Field>
                <Field label={tr('Benutzername', 'User name')} labelWidth={LW}>
                  <TextInput value={c.ssh.user} onChange={(e) => setSsh({ user: e.target.value })} />
                </Field>
                <Field label={tr('Authentifizierung', 'Authentication')} labelWidth={LW}>
                  <RadioGroup
                    inline
                    value={c.ssh.authMethod}
                    onChange={(authMethod) => setSsh({ authMethod })}
                    options={[
                      { value: 'password', label: tr('Passwort', 'Password') },
                      { value: 'publicKey', label: tr('Öffentlicher Schlüssel', 'Public key') },
                      { value: 'agent', label: tr('SSH-Agent / Pageant', 'SSH agent / Pageant') }
                    ]}
                  />
                </Field>
                {c.ssh.authMethod === 'password' && (
                  <>
                    <Field label={tr('Passwort', 'Password')} labelWidth={LW}>
                      <TextInput type="password" value={c.ssh.password ?? ''} onChange={(e) => setSsh({ password: e.target.value })} autoComplete="new-password" />
                    </Field>
                    <Field label="" labelWidth={LW}>
                      <Checkbox checked={c.ssh.savePassword} onChange={(v) => setSsh({ savePassword: v })} label={tr('Passwort speichern', 'Save password')} />
                    </Field>
                  </>
                )}
                {c.ssh.authMethod === 'publicKey' && (
                  <>
                    <Field label={tr('Privater Schlüssel', 'Private key')} labelWidth={LW}>
                      <PathInput value={c.ssh.privateKeyPath} onChange={(privateKeyPath) => setSsh({ privateKeyPath })} />
                    </Field>
                    <Field label={tr('Passphrase', 'Passphrase')} labelWidth={LW}>
                      <TextInput type="password" value={c.ssh.passphrase ?? ''} onChange={(e) => setSsh({ passphrase: e.target.value })} />
                    </Field>
                    <Field label="" labelWidth={LW}>
                      <Checkbox checked={c.ssh.savePassphrase} onChange={(v) => setSsh({ savePassphrase: v })} label={tr('Passphrase speichern', 'Save passphrase')} />
                    </Field>
                  </>
                )}
                <div className="ks-field-hint">
                  {tr(
                    'Host und Port auf der Registerkarte „Allgemein“ werden vom SSH-Server aus aufgelöst (meist localhost).',
                    'Host and port on the "General" tab are resolved from the SSH server (usually localhost).'
                  )}
                </div>
              </div>
            </fieldset>
          </div>
        )}

        {tab === 'http' && (
          <div className="ks-form">
            <Checkbox checked={c.http.enabled} onChange={(v) => setHttp({ enabled: v })} label={tr('HTTP-Tunnel verwenden', 'Use HTTP tunnel')} />
            <fieldset className="ks-plain-fieldset" disabled={!c.http.enabled}>
              <div className="ks-form">
                <Field label={tr('Tunnel-URL', 'Tunnel URL')} labelWidth={LW} hint={c.http.url && !/^https:\/\//i.test(c.http.url) ? tr('Ohne HTTPS werden Passwörter und Abfragen unverschlüsselt übertragen.', 'Without HTTPS, passwords and queries travel unencrypted.') : undefined}>
                  <TextInput value={c.http.url} placeholder="https://example.com/ks_tunnel.php" onChange={(e) => setHttp({ url: e.target.value })} />
                </Field>
                <Field label="" labelWidth={LW}>
                  <Checkbox checked={c.http.base64} onChange={(v) => setHttp({ base64: v })} label={tr('Abfragen Base64-kodiert senden', 'Encode outgoing queries with Base64')} />
                </Field>
                <Field label={tr('HTTP-Benutzer', 'HTTP user')} labelWidth={LW}>
                  <TextInput value={c.http.authUser} onChange={(e) => setHttp({ authUser: e.target.value })} />
                </Field>
                <Field label={tr('HTTP-Passwort', 'HTTP password')} labelWidth={LW}>
                  <TextInput type="password" value={c.http.authPassword ?? ''} onChange={(e) => setHttp({ authPassword: e.target.value })} />
                </Field>
                <Field label="" labelWidth={LW}>
                  <Button size="sm" icon={<Download size={13} />} onClick={() => void downloadTunnelScript()}>
                    {tr('PHP-Skript herunterladen …', 'Download PHP script …')}
                  </Button>
                </Field>
              </div>
            </fieldset>
            <div className="ks-field-hint">
              {tr(
                'Der HTTP-Tunnel leitet Abfragen über ein PHP-Skript auf Ihrem Webserver weiter, wenn der MySQL-Port nicht direkt erreichbar ist. Laden Sie ks_tunnel.php herunter, tragen Sie darin Benutzer und Passwort ein und laden Sie es auf den Webserver hoch. Mehrere gleichzeitig geöffnete Tabs zu dieser Verbindung können sich serverseitig eine MySQL-Verbindung teilen; für Transaktionen empfiehlt sich ein SSH-Tunnel oder eine direkte Verbindung.',
                'The HTTP tunnel forwards queries through a PHP script on your web server when the MySQL port is not reachable directly. Download ks_tunnel.php, fill in a user and password, and upload it to the web server. Several tabs open to this connection at once can end up sharing one MySQL connection server-side; prefer an SSH tunnel or a direct connection for transactions.'
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

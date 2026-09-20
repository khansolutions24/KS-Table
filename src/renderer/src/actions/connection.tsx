// Connection profile actions (new / edit / delete / open / close / groups / import / export).

import type { ConnectionConfig, ServerType } from '@shared/types';
import { newId } from '@shared/defaults';
import { defaultConnection } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { uniqueName } from '@shared/util';
import { api, errorCode } from '../api/client';
import { confirmDialog, errorDialog, openDialog, promptDialog } from '../components/ui/Dialog';
import { toast } from '../components/Toast';
import { ConnectionDialog } from '../features/connection/ConnectionDialog';
import { pickOpenFile, pickSaveFile } from '../lib/files';
import { nodeKey, useNav } from '../store/nav';
import { closeTabsOfConnection } from '../store/tabs';
import { getProfile, useWorkspace } from '../store/workspace';

export async function newConnection(type: ServerType = 'mysql'): Promise<void> {
  const c = defaultConnection(type);
  const saved = await openDialog<ConnectionConfig>((close) => <ConnectionDialog initial={c} isNew onClose={close} />);
  if (saved) useNav.getState().select(nodeKey({ kind: 'connection', connectionId: saved.id }));
}

export async function editConnection(id: string): Promise<void> {
  const p = getProfile(id);
  if (!p) return;
  const saved = await openDialog<ConnectionConfig>((close) => <ConnectionDialog initial={p} isNew={false} onClose={close} />);
  if (saved && useWorkspace.getState().conns[id]?.status === 'open') {
    toast(tr('Änderungen gelten ab dem nächsten Verbindungsaufbau.', 'Changes apply from the next connect.'));
  }
}

export async function duplicateConnection(id: string): Promise<void> {
  const p = getProfile(id);
  if (!p) return;
  const names = useWorkspace.getState().profiles.map((x) => x.name);
  const copy: ConnectionConfig = { ...structuredClone(p), id: newId('c'), name: uniqueName(`${p.name} ${tr('Kopie', 'copy')}`, names) };
  const saved = await useWorkspace.getState().saveProfile(copy);
  useNav.getState().select(nodeKey({ kind: 'connection', connectionId: saved.id }));
}

export async function deleteConnection(id: string): Promise<void> {
  const p = getProfile(id);
  if (!p) return;
  const ok = await confirmDialog({
    title: tr('Verbindung löschen', 'Delete connection'),
    message: tr('Soll die Verbindung „{n}“ wirklich gelöscht werden?', 'Do you really want to delete the connection "{n}"?', { n: p.name }),
    okLabel: tr('Löschen', 'Delete'),
    danger: true
  });
  if (!ok) return;
  if (!(await closeTabsOfConnection(id))) return;
  await useWorkspace.getState().removeProfile(id);
}

export async function openConnection(id: string): Promise<boolean> {
  const ok = await useWorkspace.getState().openConnection(id);
  if (ok) useNav.getState().setExpanded(nodeKey({ kind: 'connection', connectionId: id }), true);
  return ok;
}

export async function closeConnection(id: string): Promise<void> {
  if (!(await closeTabsOfConnection(id))) return;
  await useWorkspace.getState().closeConnection(id);
  useNav.getState().setExpanded(nodeKey({ kind: 'connection', connectionId: id }), false);
}

export async function toggleConnection(id: string): Promise<void> {
  const st = useWorkspace.getState().conns[id]?.status;
  if (st === 'open') await closeConnection(id);
  else if (st !== 'connecting') await openConnection(id);
}

export async function setConnectionColor(id: string, color: string | null): Promise<void> {
  const p = getProfile(id);
  if (p) await useWorkspace.getState().saveProfile({ ...p, color });
}

export async function moveConnectionToGroup(id: string, groupId: string | null): Promise<void> {
  const p = getProfile(id);
  if (p) await useWorkspace.getState().saveProfile({ ...p, groupId });
}

export async function newGroup(connectionId?: string): Promise<void> {
  const name = await promptDialog({
    title: tr('Neue Gruppe', 'New group'),
    label: tr('Gruppenname', 'Group name'),
    validate: (v) => (v.trim() ? null : tr('Bitte einen Namen eingeben.', 'Please enter a name.'))
  });
  if (!name) return;
  const groups = useWorkspace.getState().groups;
  const g = { id: newId('g'), name: name.trim(), order: groups.length };
  await useWorkspace.getState().saveGroup(g);
  useNav.getState().setExpanded(nodeKey({ kind: 'group', groupId: g.id }), true);
  if (connectionId) await moveConnectionToGroup(connectionId, g.id);
}

export async function renameGroup(id: string): Promise<void> {
  const g = useWorkspace.getState().groups.find((x) => x.id === id);
  if (!g) return;
  const name = await promptDialog({ title: tr('Gruppe umbenennen', 'Rename group'), label: tr('Gruppenname', 'Group name'), value: g.name });
  if (name && name.trim()) await useWorkspace.getState().saveGroup({ ...g, name: name.trim() });
}

export async function deleteGroup(id: string): Promise<void> {
  const g = useWorkspace.getState().groups.find((x) => x.id === id);
  if (!g) return;
  const ok = await confirmDialog({
    title: tr('Gruppe löschen', 'Delete group'),
    message: tr('Gruppe „{n}“ löschen? Die enthaltenen Verbindungen bleiben erhalten.', 'Delete group "{n}"? The connections in it are kept.', { n: g.name }),
    danger: true,
    okLabel: tr('Löschen', 'Delete')
  });
  if (ok) await useWorkspace.getState().removeGroup(id);
}

export async function exportConnections(ids: string[] = []): Promise<void> {
  const file = await pickSaveFile({
    title: tr('Verbindungen exportieren', 'Export connections'),
    defaultPath: 'connections.kstconn',
    filters: [{ name: 'KS Table Connections', extensions: ['kstconn'] }]
  });
  if (!file) return;
  const pass = await promptDialog({
    title: tr('Passwörter exportieren?', 'Export passwords?'),
    label: tr(
      'Kennwort zum Verschlüsseln der gespeicherten Passwörter (leer lassen, um keine Passwörter zu exportieren):',
      'Passphrase to encrypt the saved passwords (leave empty to export no passwords):'
    ),
    password: true
  });
  if (pass === null) return;
  try {
    const n = await api.connections.exportFile(file, ids, pass || null);
    toast(tr('{n} Verbindungen exportiert', '{n} connections exported', { n }), 'success');
  } catch (e) {
    void errorDialog(e);
  }
}

export async function importConnections(): Promise<void> {
  const file = await pickOpenFile({
    title: tr('Verbindungen importieren', 'Import connections'),
    filters: [{ name: 'KS Table Connections', extensions: ['kstconn', 'json'] }]
  });
  if (!file) return;
  let passphrase: string | null = null;
  for (;;) {
    try {
      const n = await api.connections.importFile(file, passphrase);
      await useWorkspace.getState().load();
      toast(tr('{n} Verbindungen importiert', '{n} connections imported', { n }), 'success');
      return;
    } catch (e) {
      const code = errorCode(e);
      if (code === 'PASSPHRASE_REQUIRED' || code === 'PASSPHRASE_WRONG') {
        passphrase = await promptDialog({
          title: tr('Kennwort', 'Passphrase'),
          label:
            code === 'PASSPHRASE_WRONG'
              ? tr('Falsches Kennwort. Bitte erneut eingeben:', 'Wrong passphrase. Please try again:')
              : tr('Kennwort der Exportdatei:', 'Passphrase of the export file:'),
          password: true
        });
        if (passphrase === null) return;
        continue;
      }
      void errorDialog(e);
      return;
    }
  }
}

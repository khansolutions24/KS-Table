// Shared helpers of the users feature: server capabilities per connection, change notifications, tab helpers.

import { create } from 'zustand';
import type { AccountDetails, AccountModel, AccountRef, UsersServerInfo } from '@shared/apis/users';
import { tr } from '@shared/i18n';
import { accountLabel } from '@shared/users/statements';
import { api } from '../../api/client';
import { useTabs } from '../../store/tabs';
import { getProfile, metaSession } from '../../store/workspace';

const infoCache = new Map<string, { sessionId: string; info: Promise<UsersServerInfo> }>();

/** Server capabilities and privilege catalog (cached per navigator session) */
export function serverInfoFor(connectionId: string, refresh = false): Promise<UsersServerInfo> {
  const sid = metaSession(connectionId);
  const cached = infoCache.get(connectionId);
  if (cached && cached.sessionId === sid && !refresh) return cached.info;
  const info = api.users.serverInfo(sid);
  infoCache.set(connectionId, { sessionId: sid, info });
  info.catch(() => infoCache.delete(connectionId));
  return info;
}

/** Change counter per connection – bumped after account changes so that lists reload */
export const useUsersVersion = create<{ versions: Record<string, number>; bump(connectionId: string): void }>((set) => ({
  versions: {},
  bump: (connectionId) => set((s) => ({ versions: { ...s.versions, [connectionId]: (s.versions[connectionId] ?? 0) + 1 } }))
}));

export function userTabKey(connectionId: string, a: AccountRef): string {
  return `user:${connectionId}:${a.user}@${a.host.toLowerCase()}`;
}

export function designerTitle(a: AccountRef | null, role: boolean): string {
  const kind = role ? tr('Rolle', 'Role') : tr('Benutzer', 'User');
  return a ? `${accountLabel(a)} (${kind})` : `${tr('Unbenannt', 'Untitled')} (${kind})`;
}

export function openUserDesigner(connectionId: string, account: AccountRef | null, role = false): void {
  useTabs.getState().open({
    kind: 'userDesign',
    key: account ? userTabKey(connectionId, account) : undefined,
    title: designerTitle(account, role),
    icon: role ? 'role' : 'user',
    params: { connectionId, user: account?.user ?? null, host: account?.host ?? null, role },
    connectionId,
    subtitle: getProfile(connectionId)?.name ?? ''
  });
}

export function openPrivilegeManager(connectionId: string): void {
  const name = getProfile(connectionId)?.name ?? '';
  useTabs.getState().open({
    kind: 'privileges',
    key: `privileges:${connectionId}`,
    title: `${tr('Rechte-Manager', 'Privilege Manager')} – ${name}`,
    icon: 'role',
    params: { connectionId },
    connectionId,
    subtitle: name
  });
}

/** Editable part of loaded account details */
export function toModel(d: AccountDetails): AccountModel {
  const { hasPassword, passwordExpired, showGrants, ...model } = d;
  void hasPassword;
  void passwordExpired;
  void showGrants;
  return structuredClone(model);
}

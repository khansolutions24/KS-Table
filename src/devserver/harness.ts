// Backend test harness: boots the backend with an isolated user data directory and a
// connection profile for the portable test server (127.0.0.1:3307, root / kstable).
//
//   import { bootBackend } from '../../devserver/harness';
//   const { api, ctx, connectionId } = await bootBackend();
//   const s = await api.session.open(connectionId, 'ks_shop');
//   ...
//   await shutdown();

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConnection } from '@shared/defaults';
import { createBackend, type Backend } from '../backend/api';
import { setPlatform } from '../backend/platform';

export const TEST_CONNECTION_ID = 'harness-3307';

export async function bootBackend(): Promise<Backend & { connectionId: string }> {
  const dir = path.join(os.tmpdir(), 'ks-table-harness', String(process.pid));
  fs.mkdirSync(dir, { recursive: true });
  setPlatform({
    isElectron: false,
    appVersion: 'harness',
    electronVersion: '',
    userDataDir: dir,
    documentsDir: path.join(dir, 'docs'),
    openExternal: async () => undefined,
    showItemInFolder: () => undefined
  });
  const backend = createBackend();
  await backend.api.connections.save({
    ...defaultConnection('mysql'),
    id: TEST_CONNECTION_ID,
    name: 'Harness 3307',
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'kstable',
    savePassword: true
  });
  return Object.assign(backend, { connectionId: TEST_CONNECTION_ID });
}

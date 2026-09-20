// Connection profiles, stored in <userData>/connections.json with encrypted secrets.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ConnectionConfig, ConnectionGroup } from '@shared/types';
import { defaultConnection, newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { deepMerge, uniqueName } from '@shared/util';
import { KsError } from '../errors';
import { readJsonSync, writeJson } from '../util/jsonFile';
import { decryptSecret, decryptWithPassphrase, encryptSecret, encryptWithPassphrase } from '../util/secret';

interface StoreFile {
  version: 1;
  groups: ConnectionGroup[];
  connections: ConnectionConfig[];
}

type SecretFn = (value: string | undefined, keep: boolean) => string | undefined;

function mapSecrets(c: ConnectionConfig, fn: SecretFn): ConnectionConfig {
  return {
    ...c,
    password: fn(c.password, c.savePassword),
    ssl: { ...c.ssl, passphrase: fn(c.ssl.passphrase, true) },
    ssh: {
      ...c.ssh,
      password: fn(c.ssh.password, c.ssh.savePassword),
      passphrase: fn(c.ssh.passphrase, c.ssh.savePassphrase)
    },
    http: { ...c.http, authPassword: fn(c.http.authPassword, true) }
  };
}

function normalize(c: Partial<ConnectionConfig>): ConnectionConfig {
  return deepMerge(defaultConnection(c.type ?? 'mysql'), c);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class ConnectionStore {
  private readonly file: string;
  private groups: ConnectionGroup[];
  private connections: ConnectionConfig[];

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'connections.json');
    const raw = readJsonSync<Partial<StoreFile>>(this.file, {});
    this.groups = raw.groups ?? [];
    this.connections = (raw.connections ?? []).map((c) => mapSecrets(normalize(c), (v) => decryptSecret(v)));
  }

  list(): { connections: ConnectionConfig[]; groups: ConnectionGroup[] } {
    return { connections: clone(this.connections), groups: clone(this.groups) };
  }

  get(id: string): ConnectionConfig {
    const c = this.connections.find((x) => x.id === id);
    if (!c) throw new KsError(tr('Verbindung nicht gefunden', 'Connection not found'), 'NOT_FOUND');
    return clone(c);
  }

  async save(input: ConnectionConfig): Promise<ConnectionConfig> {
    const conn = normalize(input);
    conn.updatedAt = Date.now();
    const idx = this.connections.findIndex((x) => x.id === conn.id);
    if (idx >= 0) this.connections[idx] = conn;
    else {
      conn.createdAt = Date.now();
      this.connections.push(conn);
    }
    await this.persist();
    return clone(conn);
  }

  async remove(id: string): Promise<void> {
    this.connections = this.connections.filter((c) => c.id !== id);
    await this.persist();
  }

  async reorder(ids: string[]): Promise<void> {
    const pos = new Map(ids.map((id, i) => [id, i]));
    this.connections.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
    await this.persist();
  }

  async saveGroup(group: ConnectionGroup): Promise<ConnectionGroup> {
    const idx = this.groups.findIndex((g) => g.id === group.id);
    if (idx >= 0) this.groups[idx] = group;
    else this.groups.push(group);
    await this.persist();
    return group;
  }

  async removeGroup(id: string): Promise<void> {
    this.groups = this.groups.filter((g) => g.id !== id);
    for (const c of this.connections) if (c.groupId === id) c.groupId = null;
    await this.persist();
  }

  async exportFile(file: string, ids: string[], passphrase: string | null): Promise<number> {
    const salt = randomBytes(16);
    const list = this.connections
      .filter((c) => ids.length === 0 || ids.includes(c.id))
      .map((c) =>
        mapSecrets(c, (v, keep) => (passphrase && keep && v ? encryptWithPassphrase(v, passphrase, salt) : ''))
      );
    const doc = {
      format: 'ks-table-connections',
      version: 1,
      encrypted: !!passphrase,
      salt: salt.toString('base64'),
      connections: list
    };
    await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
    return list.length;
  }

  async importFile(file: string, passphrase: string | null): Promise<number> {
    let doc: { format?: string; encrypted?: boolean; salt?: string; connections?: ConnectionConfig[] };
    try {
      doc = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      throw new KsError(tr('Die Datei ist keine gültige Verbindungsdatei.', 'The file is not a valid connection file.'));
    }
    if (doc.format !== 'ks-table-connections' || !Array.isArray(doc.connections)) {
      throw new KsError(tr('Unbekanntes Dateiformat', 'Unknown file format'));
    }
    const hasSecrets = doc.encrypted && doc.connections.some((c) => c.password || c.ssh?.password || c.ssh?.passphrase);
    if (hasSecrets && !passphrase) {
      throw new KsError(tr('Die Datei ist mit einem Kennwort geschützt.', 'The file is protected with a passphrase.'), 'PASSPHRASE_REQUIRED');
    }
    const salt = Buffer.from(doc.salt ?? '', 'base64');
    const names = this.connections.map((c) => c.name);
    let n = 0;
    for (const raw of doc.connections) {
      let c: ConnectionConfig;
      try {
        c = mapSecrets(normalize(raw), (v) => (doc.encrypted && v && passphrase ? decryptWithPassphrase(v, passphrase, salt) : v));
      } catch {
        throw new KsError(tr('Falsches Kennwort', 'Wrong passphrase'), 'PASSPHRASE_WRONG');
      }
      c.id = newId('c');
      c.groupId = null;
      c.name = uniqueName(c.name || c.host, names);
      names.push(c.name);
      this.connections.push(c);
      n++;
    }
    await this.persist();
    return n;
  }

  private persist(): Promise<void> {
    const data: StoreFile = {
      version: 1,
      groups: this.groups,
      connections: this.connections.map((c) => mapSecrets(c, (v, keep) => (keep && v ? encryptSecret(v) : '')))
    };
    return writeJson(this.file, data);
  }
}

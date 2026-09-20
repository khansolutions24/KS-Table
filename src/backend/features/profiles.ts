// Saved profiles: <profilesDir>/profiles/<kind>/<name>.json

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProfileInfo, ProfilesApi } from '@shared/apis/profiles';
import { safeFileName } from '@shared/util';
import { profilesDir } from '../store/settings';

const dirOf = (kind: string) => path.join(profilesDir(), 'profiles', safeFileName(kind));
const fileOf = (kind: string, name: string) => path.join(dirOf(kind), `${safeFileName(name)}.json`);

export function createProfilesApi(): ProfilesApi {
  return {
    async list(kind) {
      let entries: string[];
      try {
        entries = await fs.readdir(dirOf(kind));
      } catch {
        return [];
      }
      const out: ProfileInfo[] = [];
      for (const e of entries) {
        if (!e.toLowerCase().endsWith('.json')) continue;
        const st = await fs.stat(path.join(dirOf(kind), e)).catch(() => null);
        out.push({ kind, name: e.slice(0, -5), mtime: st?.mtimeMs ?? 0 });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    async load(kind, name) {
      return JSON.parse(await fs.readFile(fileOf(kind, name), 'utf8')) as unknown;
    },
    async save(kind, name, data) {
      await fs.mkdir(dirOf(kind), { recursive: true });
      await fs.writeFile(fileOf(kind, name), JSON.stringify(data, null, 2), 'utf8');
    },
    async remove(kind, name) {
      await fs.rm(fileOf(kind, name), { force: true });
    }
  };
}

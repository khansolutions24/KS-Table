import path from 'node:path';
import type { DeepPartial } from '@shared/api';
import type { AppSettings } from '@shared/types';
import { defaultSettings } from '@shared/defaults';
import { setLang } from '@shared/i18n';
import { deepMerge } from '@shared/util';
import { readJsonSync, writeJson } from '../util/jsonFile';
import { decryptSecret, encryptSecret } from '../util/secret';

let file = '';
let docsDir = '';
let current: AppSettings = defaultSettings();

export function initSettings(userDataDir: string, documentsDir: string): AppSettings {
  file = path.join(userDataDir, 'settings.json');
  docsDir = documentsDir;
  const stored = readJsonSync<DeepPartial<AppSettings>>(file, {});
  current = deepMerge(defaultSettings(), stored);
  current.smtp.password = decryptSecret(current.smtp.password);
  // the language applies from startup on (renderer and backend stay in sync)
  setLang(current.language);
  return current;
}

export function getSettings(): AppSettings {
  return current;
}

export async function updateSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
  current = deepMerge(current, patch);
  await writeJson(file, { ...current, smtp: { ...current.smtp, password: encryptSecret(current.smtp.password) } });
  return current;
}

/** Folder for saved queries, backups, models and profiles */
export function profilesDir(): string {
  return current.profilesDir || path.join(docsDir, 'KS Table');
}

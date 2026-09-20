// Model files (.ksmodel) in the profiles folder, model tabs and file URLs.

import type { FileEntry } from '@shared/api';
import { tr } from '@shared/i18n';
import { MODEL_EXT, parseModelDoc, serializeModelDoc, type ModelDoc } from '@shared/model/types';
import { safeFileName } from '@shared/util';
import { api } from '../../api/client';
import { baseName, joinPath, pickOpenFile, pickSaveFile, stripExt } from '../../lib/files';
import { useTabs } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';

export function modelsDir(): string {
  return joinPath(useWorkspace.getState().profilesDir, 'models');
}

export function dictionaryDir(): string {
  return joinPath(useWorkspace.getState().profilesDir, 'dictionary');
}

export async function listModelFiles(): Promise<FileEntry[]> {
  const entries = await api.fs.list(modelsDir());
  return entries.filter((e) => !e.isDir && e.name.toLowerCase().endsWith(`.${MODEL_EXT}`)).sort((a, b) => b.mtime - a.mtime);
}

export async function readModel(path: string): Promise<ModelDoc> {
  return parseModelDoc(await api.fs.readText(path));
}

export async function writeModel(path: string, doc: ModelDoc): Promise<void> {
  await api.fs.writeText(path, serializeModelDoc(doc));
}

const filters = () => [{ name: tr('KS-Table-Modell', 'KS Table model'), extensions: [MODEL_EXT] }];

export async function pickModelFile(): Promise<string | null> {
  await api.fs.mkdir(modelsDir()).catch(() => undefined);
  return pickOpenFile({ title: tr('Modell öffnen', 'Open model'), defaultPath: modelsDir(), filters: [...filters(), { name: tr('Alle Dateien', 'All files'), extensions: ['*'] }] });
}

export async function pickModelSavePath(name: string, current: string | null): Promise<string | null> {
  await api.fs.mkdir(modelsDir()).catch(() => undefined);
  const p = await pickSaveFile({
    title: tr('Modell speichern unter', 'Save model as'),
    defaultPath: current ?? joinPath(modelsDir(), `${safeFileName(name.trim() || 'model')}.${MODEL_EXT}`),
    filters: filters()
  });
  if (!p) return null;
  return p.toLowerCase().endsWith(`.${MODEL_EXT}`) ? p : `${p}.${MODEL_EXT}`;
}

export const modelTabKey = (file: string): string => `model:${file.toLowerCase()}`;

export function modelTitle(file: string | null, name: string): string {
  return file ? stripExt(baseName(file)) : name || tr('Neues Modell', 'New Model');
}

/** Opens a model file (or a new model) in its own tab; an already open file is activated. */
export function openModelTab(file: string | null, reverse?: { connectionId: string; database: string }): void {
  const tabs = useTabs.getState();
  if (file) {
    const existing = tabs.tabs.find((t) => t.key === modelTabKey(file));
    if (existing) {
      tabs.activate(existing.id);
      return;
    }
  }
  tabs.open({
    kind: 'model',
    key: file ? modelTabKey(file) : undefined,
    title: modelTitle(file, reverse ? reverse.database : ''),
    icon: 'model',
    params: reverse ? { file, reverse } : { file },
    subtitle: file ?? undefined
  });
}

/** file:// URL of a local path (for opening generated documents in the default application). */
export function fileUrl(path: string): string {
  return encodeURI(`file:///${path.replace(/\\/g, '/').replace(/^\/+/, '')}`)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}

// File pickers: native dialogs in Electron, a path prompt in the browser dev mode.

import type { OpenFileOptions, SaveFileOptions } from '@shared/api';
import { tr } from '@shared/i18n';
import { api, isElectron } from '../api/client';
import { promptDialog } from '../components/ui/Dialog';

export async function pickOpenFile(opts: OpenFileOptions = {}): Promise<string | null> {
  if (isElectron) {
    const r = await api.dialog.openFile({ ...opts, multi: false });
    return r?.[0] ?? null;
  }
  return promptDialog({ title: opts.title ?? tr('Datei öffnen', 'Open file'), label: tr('Dateipfad', 'File path'), value: opts.defaultPath, width: 560 });
}

export async function pickOpenFiles(opts: OpenFileOptions = {}): Promise<string[] | null> {
  if (isElectron) return api.dialog.openFile({ ...opts, multi: true });
  const p = await pickOpenFile(opts);
  return p ? p.split(';').map((s) => s.trim()).filter(Boolean) : null;
}

export async function pickSaveFile(opts: SaveFileOptions = {}): Promise<string | null> {
  if (isElectron) return api.dialog.saveFile(opts);
  return promptDialog({ title: opts.title ?? tr('Speichern unter', 'Save as'), label: tr('Dateipfad', 'File path'), value: opts.defaultPath, width: 560 });
}

export async function pickDirectory(opts: { title?: string; defaultPath?: string } = {}): Promise<string | null> {
  if (isElectron) return api.dialog.openDirectory(opts);
  return promptDialog({ title: opts.title ?? tr('Ordner wählen', 'Choose folder'), label: tr('Ordnerpfad', 'Folder path'), value: opts.defaultPath, width: 560 });
}

export function joinPath(...parts: string[]): string {
  const sep = parts.some((p) => p.includes('\\')) ? '\\' : '/';
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep);
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(0, i) : '';
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

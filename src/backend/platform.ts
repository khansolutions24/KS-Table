// Host abstraction: the Electron main process and the dev WebSocket server
// provide different implementations (dialogs, window control, paths).

import type { OpenFileOptions, SaveFileOptions } from '@shared/api';

export interface WindowControls {
  minimize(): void;
  toggleMaximize(): boolean;
  close(): void;
  isMaximized(): boolean;
  setTitleBarColors(bg: string, fg: string): void;
  toggleDevTools(): void;
  reload(): void;
  editCommand(cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void;
}

export interface Platform {
  isElectron: boolean;
  appVersion: string;
  electronVersion: string;
  userDataDir: string;
  documentsDir: string;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): void;
  /** Move a file to the recycle bin (falls back to deleting when unavailable) */
  trashItem?(path: string): Promise<void>;
  openFileDialog?(opts: OpenFileOptions): Promise<string[] | null>;
  saveFileDialog?(opts: SaveFileOptions): Promise<string | null>;
  openDirectoryDialog?(opts: { title?: string; defaultPath?: string }): Promise<string | null>;
  window?: WindowControls;
  quit?(): void;
  relaunch?(): void;
}

let current: Platform | null = null;

export function setPlatform(p: Platform): void {
  current = p;
}

export function platform(): Platform {
  if (!current) throw new Error('Platform not initialized');
  return current;
}

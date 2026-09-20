// Electron main process.

import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { IPC_EVENT, IPC_INVOKE } from '@shared/api';
import { createBackend, dispatch, type Backend } from '../backend/api';
import { emit, onEmit } from '../backend/events';
import { setPlatform } from '../backend/platform';
import { runJobHeadless } from '../backend/features/automation';

let win: BrowserWindow | null = null;
let backend: Backend | null = null;
let allowClose = false;

/** `--run-job <id>`: runs an automation job without a window (Windows task scheduler) and exits with 0/1 */
const jobArg = process.argv.indexOf('--run-job');
const headlessJobId = jobArg >= 0 ? (process.argv[jobArg + 1] ?? '') : null;

if (headlessJobId === null && !app.requestSingleInstanceLock()) {
  app.quit();
}
if (headlessJobId !== null) {
  // the job may run while the main window is open: own Chromium session data, no GPU
  app.setPath('sessionData', path.join(app.getPath('temp'), 'ks-table-jobs'));
  app.disableHardwareAcceleration();
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'KS Table',
    icon: path.join(__dirname, '../../build/icon.png'),
    backgroundColor: '#f4f5f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#e9ecf1', symbolColor: '#2b2f36', height: 34 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => {
    win?.maximize();
    win?.show();
  });
  win.on('maximize', () => emit('window:state', { maximized: true }));
  win.on('unmaximize', () => emit('window:state', { maximized: false }));
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    emit('app:close-requested', null);
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  setPlatform({
    isElectron: true,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    userDataDir: app.getPath('userData'),
    documentsDir: app.getPath('documents'),
    openExternal: (url) => shell.openExternal(url),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    trashItem: (p) => shell.trashItem(p),
    openFileDialog: async (o) => {
      const r = await dialog.showOpenDialog(win!, {
        title: o.title,
        defaultPath: o.defaultPath,
        filters: o.filters,
        properties: o.multi ? ['openFile', 'multiSelections'] : ['openFile']
      });
      return r.canceled ? null : r.filePaths;
    },
    saveFileDialog: async (o) => {
      const r = await dialog.showSaveDialog(win!, { title: o.title, defaultPath: o.defaultPath, filters: o.filters });
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    openDirectoryDialog: async (o) => {
      const r = await dialog.showOpenDialog(win!, {
        title: o.title,
        defaultPath: o.defaultPath,
        properties: ['openDirectory', 'createDirectory']
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    window: {
      minimize: () => win?.minimize(),
      toggleMaximize: () => {
        if (!win) return false;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        return win.isMaximized();
      },
      close: () => {
        allowClose = true;
        win?.close();
      },
      isMaximized: () => win?.isMaximized() ?? false,
      setTitleBarColors: (bg, fg) => {
        try {
          win?.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 34 });
        } catch {
          // not supported on this platform
        }
      },
      toggleDevTools: () => win?.webContents.toggleDevTools(),
      reload: () => win?.webContents.reload(),
      editCommand: (cmd) => {
        const wc = win?.webContents;
        if (!wc) return;
        if (cmd === 'undo') wc.undo();
        else if (cmd === 'redo') wc.redo();
        else if (cmd === 'cut') wc.cut();
        else if (cmd === 'copy') wc.copy();
        else if (cmd === 'paste') wc.paste();
        else wc.selectAll();
      }
    },
    quit: () => {
      allowClose = true;
      app.quit();
    },
    relaunch: () => {
      allowClose = true;
      app.relaunch();
      app.exit(0);
    }
  });

  backend = createBackend();
  if (headlessJobId !== null) {
    const b = backend;
    void runJobHeadless(b.ctx, headlessJobId)
      .catch(() => 1)
      .then((code) => b.shutdown().finally(() => app.exit(code)));
    return;
  }
  ipcMain.handle(IPC_INVOKE, (_e, method: string, args: unknown[]) => dispatch(backend!.api, method, args));
  onEmit((channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC_EVENT, channel, payload);
  });
  createWindow();
});

app.on('window-all-closed', () => {
  void (backend?.shutdown() ?? Promise.resolve()).finally(() => app.quit());
});

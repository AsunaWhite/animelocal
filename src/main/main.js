'use strict';

/**
 * 主进程入口
 * ------------------------------------------------------------
 * 职责：创建窗口、处理系统级能力（文件、对话框、播放器）。
 * 界面的东西一律交给 src/renderer/，两边只通过 IPC 说话。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const catalog = require('./catalog');

// 启动探针：把关键节点写进 .dev/boot.log。
// 这台机器上 Electron 有时会在「还没跑到 js」的阶段就没了，靠这个日志判断死在哪一步。
const BOOT_LOG = path.join(__dirname, '..', '..', '.dev', 'boot.log');
fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
fs.writeFileSync(BOOT_LOG, '');
function trace(msg) {
  try {
    fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}
trace(`main.js loaded pid=${process.pid} argv=${process.argv.join(' ')}`);

const ARGS = new Set(process.argv.slice(1));
const IS_DEV = ARGS.has('--dev');
const IS_SHOT = ARGS.has('--shot'); // 截图模式：给人（和 AI）看界面用

const ROOT = path.join(__dirname, '..', '..');
const SHOT_DIR = path.join(ROOT, '.dev');

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  trace('createWindow:start');
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 660,
    title: '本季番剧库',
    backgroundColor: '#0f1116',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, // 渲染进程拿不到 Node，只能走 preload 暴露的 API
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    trace('ready-to-show');
    win.show();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  trace('loadFile called');

  if (IS_DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // 渲染进程的 console 转发到终端，方便排查
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    const tag = ['log', 'warn', 'error', 'debug'][level] || 'log';
    console.log(`[renderer:${tag}] ${message}  (${path.basename(source || '')}:${line})`);
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (IS_SHOT) {
    win.webContents.once('did-finish-load', () => {
      trace('did-finish-load');
      // 等渲染进程把数据画完（body.dataset.ready = '1'），最多等 25 秒
      const started = Date.now();
      const tick = async () => {
        let ready = false;
        try {
          ready = await win.webContents.executeJavaScript(
            "document.body.dataset.ready === '1'"
          );
        } catch {
          ready = false;
        }
        if (!ready && Date.now() - started < 25000) {
          setTimeout(tick, 250);
          return;
        }
        try {
          const image = await win.webContents.capturePage();
          fs.mkdirSync(SHOT_DIR, { recursive: true });
          const out = path.join(SHOT_DIR, 'shot.png');
          fs.writeFileSync(out, image.toPNG());
          trace(`shot saved ${image.getSize().width}x${image.getSize().height} ready=${ready}`);
          console.log('[shot] saved:', out);
        } catch (err) {
          console.error('[shot] failed:', err);
        } finally {
          app.exit(0);
        }
      };
      setTimeout(tick, 400);
    });
  }

  win.on('closed', () => {
    win = null;
  });
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('app:info', () => {
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    userData: app.getPath('userData'),
    isDev: IS_DEV,
  };
});

/**
 * 本季番剧表：优先读 24h 内的缓存，过期才去 yuc.wiki 抓。
 * 返回给渲染进程的封面统一换成可用 URL：本地缓存的走 file://，没下到的退回 https。
 */
ipcMain.handle('catalog:load', async (_event, opts = {}) => {
  const season = /^\d{6}$/.test(opts.season || '') ? opts.season : catalog.currentSeason();
  const data = await catalog.loadSeason(app.getPath('userData'), season, {
    force: Boolean(opts.force),
    log: (msg) => console.log('[catalog]', msg),
  });

  const entries = data.entries.map((entry) => {
    const local = entry.coverFile && fs.existsSync(entry.coverFile) ? entry.coverFile : null;
    return {
      ...entry,
      coverFile: undefined,
      coverUrl: local ? pathToFileURL(local).href : entry.cover || null,
    };
  });

  return {
    season: data.season,
    label: data.label,
    fetchedAt: data.fetchedAt,
    entries,
    fromCache: Boolean(data.fromCache),
    stale: Boolean(data.stale),
  };
});

// ---------------------------------------------------------------- 生命周期

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    trace('app ready');
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

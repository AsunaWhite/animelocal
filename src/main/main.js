'use strict';

/**
 * 主进程入口
 * ------------------------------------------------------------
 * 职责：创建窗口、处理系统级能力（文件、对话框、播放器）。
 * 界面的东西一律交给 src/renderer/，两边只通过 IPC 说话。
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const catalog = require('./catalog');
const library = require('./library');
const scanner = require('./scanner');
const player = require('./player');

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

// 截图前先执行一段界面脚本，用来验证交互（点按钮、切筛选）。
// 用法：node scripts/launch.js --shot "--eval=document.querySelector('.own-btn').click()"
// 代码里有引号嵌套时改用文件：--eval-file=.dev/click.js
const EVAL_ARG = process.argv.slice(1).find((a) => a.startsWith('--eval='));
const EVAL_FILE_ARG = process.argv.slice(1).find((a) => a.startsWith('--eval-file='));
let SHOT_EVAL = EVAL_ARG ? EVAL_ARG.slice('--eval='.length) : '';
if (!SHOT_EVAL && EVAL_FILE_ARG) {
  try {
    SHOT_EVAL = fs.readFileSync(
      path.resolve(path.join(__dirname, '..', '..'), EVAL_FILE_ARG.slice('--eval-file='.length)),
      'utf8'
    );
  } catch (err) {
    console.error('[shot] 读不到 eval 文件:', err.message);
  }
}

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
        if (SHOT_EVAL) {
          try {
            await win.webContents.executeJavaScript(SHOT_EVAL);
            await new Promise((r) => setTimeout(r, 700));
          } catch (err) {
            console.error('[shot] eval failed:', err);
          }
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

  // 勾选记录跟番剧表一起发过去，界面不用再多问一次
  const owned = new Set(library.ownedIds(app.getPath('userData'), season));

  const entries = data.entries.map((entry) => {
    const local = entry.coverFile && fs.existsSync(entry.coverFile) ? entry.coverFile : null;
    return {
      ...entry,
      coverFile: undefined,
      coverUrl: local ? pathToFileURL(local).href : entry.cover || null,
      owned: owned.has(entry.id),
    };
  });

  return {
    season: data.season,
    label: data.label,
    fetchedAt: data.fetchedAt,
    entries,
    ownedCount: owned.size,
    fromCache: Boolean(data.fromCache),
    stale: Boolean(data.stale),
  };
});

/** 勾上 / 取消勾上「这部我本地有」，写进 userData\library.json */
ipcMain.handle('library:toggle', (_event, payload = {}) => {
  const season = /^\d{6}$/.test(payload.season || '') ? payload.season : catalog.currentSeason();
  try {
    const result = library.setOwned(app.getPath('userData'), season, payload.id, Boolean(payload.owned));
    console.log(`[library] ${result.owned ? '勾上' : '取消'} ${payload.id} → 本季共 ${result.ownedCount} 部`);
    return { ok: true, ...result };
  } catch (err) {
    console.error('[library] 写入失败', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// ---------------------------------------------------------------- 扫资源目录

/** 把扫描结果里能省掉的字段去掉，别让几百条路径把 IPC 撑爆 */
function slimScan(scan) {
  if (!scan) return null;
  const strip = (list) =>
    (list || []).map((f) => ({
      path: f.path,
      name: f.name,
      dir: f.dir,
      size: f.size,
      ext: f.ext,
      episode: f.episode,
      kind: f.kind,
      range: f.range,
      showId: f.showId,
      showTitle: f.showTitle,
      score: f.score,
      matchedBy: f.matchedBy,
    }));
  return {
    root: scan.root,
    season: scan.season,
    scannedAt: scan.scannedAt,
    files: scan.files,
    matched: strip(scan.matched),
    unmatched: strip(scan.unmatched),
    extras: strip(scan.extras),
    errors: scan.errors,
    truncated: scan.truncated,
    tookMs: scan.tookMs,
  };
}

/** 弹系统对话框选资源目录 */
ipcMain.handle('scan:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择动画资源存放的目录',
    buttonLabel: '就这里',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: true, canceled: true };
  console.log('[scan] 选的目录:', res.filePaths[0]);
  return { ok: true, dir: res.filePaths[0] };
});

/** 上次的扫描结果（开机恢复用） */
ipcMain.handle('scan:state', () => {
  const scan = scanner.loadScan(app.getPath('userData'));
  return { ok: true, scan: slimScan(scan) };
});

/**
 * 开扫：先拿当季番剧表（有缓存就用缓存），再递归扫目录，边扫边把进度推给界面。
 * 结果存 userData\scan.json，下次打开不用重扫。
 */
ipcMain.handle('scan:run', async (event, payload = {}) => {
  const userData = app.getPath('userData');
  const previous = scanner.loadScan(userData);
  const season = /^\d{6}$/.test(payload.season || '') ? payload.season : catalog.currentSeason();
  const root = payload.root || (previous && previous.root);
  if (!root) return { ok: false, error: '还没选目录' };

  const sender = event.sender;
  let lastPush = 0;
  try {
    const data = await catalog.loadSeason(userData, season, {
      force: false,
      log: (msg) => console.log('[catalog]', msg),
    });
    const aliases = library.aliasMap(userData, season);
    const result = await scanner.scanDirectory({
      root,
      shows: data.entries,
      aliasMap: aliases,
      onProgress: ({ found, dir }) => {
        const now = Date.now();
        if (now - lastPush < 250) return; // 别刷太勤，界面会抖
        lastPush = now;
        if (!sender.isDestroyed()) sender.send('scan:progress', { found, dir });
      },
    });
    result.season = season;
    scanner.saveScan(userData, result);
    console.log(
      `[scan] ${root} → ${result.files} 个视频，认出 ${result.matched.length}，待确认 ${result.unmatched.length}，非正片 ${result.extras.length}，${result.tookMs}ms`
    );
    return { ok: true, scan: slimScan(result) };
  } catch (err) {
    console.error('[scan] 失败', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

/** 手动指派：把待确认的文件塞给某部动画，顺便记住认人的文件夹名 */
ipcMain.handle('scan:assign', (_event, payload = {}) => {
  const userData = app.getPath('userData');
  try {
    const scan = scanner.loadScan(userData);
    if (!scan) return { ok: false, error: '还没有扫描结果' };

    const target = [...(scan.unmatched || []), ...(scan.matched || [])].find(
      (f) => f.path === payload.path
    );
    if (!target) return { ok: false, error: '找不到这个文件，可能重新扫过了' };

    const showId = String(payload.showId || '');
    const showTitle = String(payload.showTitle || '');
    const episode =
      payload.episode === null || payload.episode === undefined
        ? target.episode
        : Number(payload.episode);
    if (!showId) return { ok: false, error: '没指定是哪部动画' };
    if (!Number.isInteger(episode) || episode === null) {
      return { ok: false, error: '这个文件里认不出集数，手动填一个吧' };
    }

    scan.unmatched = (scan.unmatched || []).filter((f) => f.path !== target.path);
    scan.matched = scan.matched || [];

    const assigned = {
      ...target,
      showId,
      showTitle,
      episode,
      kind: 'main',
      score: 1,
      matchedBy: '手动',
    };
    const dup = scan.matched.findIndex((f) => f.path === assigned.path);
    if (dup >= 0) scan.matched[dup] = assigned;
    else scan.matched.push(assigned);
    scan.matched.sort((a, b) => (a.episode || 0) - (b.episode || 0) || a.path.localeCompare(b.path));

    // 记住文件夹名，下次自动认。
    // 但只有「文件在子文件夹里」时才值得记：根目录名（比如「10月动画」）是个大杂烩，
    // 记下来会把整个目录的所有文件都硬认成这一部
    const folderName = path.basename(target.dir || '');
    const isRootFile = scan.root && path.resolve(target.dir || '') === path.resolve(scan.root);
    const season = scan.season || catalog.currentSeason();
    if (folderName && !isRootFile) library.addAlias(userData, season, showId, folderName);

    scanner.saveScan(userData, scan);
    console.log(`[scan] 手动指派 ${assigned.name} → ${showTitle} 第 ${episode} 集`);
    return { ok: true, scan: slimScan(scan) };
  } catch (err) {
    console.error('[scan] 指派失败', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

/** 清空本季度的识别记忆（认错越来越多时的急救按钮） */
ipcMain.handle('scan:forget', () => {
  const userData = app.getPath('userData');
  const scan = scanner.loadScan(userData);
  const season = (scan && scan.season) || catalog.currentSeason();
  try {
    const removed = library.forgetAliases(userData, season);
    console.log(`[scan] 清空识别记忆 ${season}：${removed} 条`);
    return { ok: true, removed, season };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

/** 阶段 4：把某一集交给系统默认播放器（你机器上是 PotPlayer） */
ipcMain.handle('play:file', async (_event, payload = {}) => {
  const userData = app.getPath('userData');
  const scan = scanner.loadScan(userData);
  const verdict = player.checkPlayable(scan, payload.path);
  if (!verdict.ok) return verdict;

  // 调试/截图时不想真的弹播放器：设 ANIMELOCAL_DRY_PLAY=1 就只走校验
  if (process.env.ANIMELOCAL_DRY_PLAY === '1') {
    console.log(`[play] (dry) ${verdict.file}`);
    return { ...verdict, dry: true };
  }

  try {
    // openPath 用的就是系统默认关联，等价于资源管理器里双击
    const errText = await shell.openPath(verdict.file);
    if (errText) {
      console.error(`[play] 打不开 ${verdict.file}: ${errText}`);
      return { ok: false, error: errText };
    }
    console.log(`[play] ${verdict.showTitle || ''} 第 ${verdict.episode} 集 → ${verdict.name}`);
    return verdict;
  } catch (err) {
    console.error('[play] 失败', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
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

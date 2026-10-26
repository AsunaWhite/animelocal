'use strict';

/**
 * 启动器
 * ------------------------------------------------------------
 * 为什么不直接用 `electron .`？两个坑：
 *
 * 1. 本机环境里带着 ELECTRON_RUN_AS_NODE=1，Electron 会退化成一个普通 Node，
 *    ipcMain、BrowserWindow 全是 undefined。这里在 spawn 之前把它删掉。
 *
 * 2. Electron 的 stdout/stderr 一旦接进「管道」（比如被终端或工具捕获），
 *    浏览器进程会在启动阶段直接爆掉（退出码 0x80000003 / crashpad not connected）。
 *    所以这里把它的输出重定向到日志文件，而不是继承父进程的 stdio。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 在普通 Node 里 require('electron') 拿到的是 electron.exe 的绝对路径
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const root = path.join(__dirname, '..');
const devDir = path.join(root, '.dev');
fs.mkdirSync(devDir, { recursive: true });

const logPath = path.join(devDir, 'electron.log');
const logFd = fs.openSync(logPath, 'w');

const args = [root, ...process.argv.slice(2)];

console.log(`[launch] ${path.basename(electronPath)} ${args.join(' ')}`);
console.log(`[launch] log -> ${logPath}`);

const child = spawn(electronPath, args, {
  stdio: ['ignore', logFd, logFd], // 关键：绝不让它碰父进程的管道
  env,
});

child.on('close', (code, signal) => {
  try {
    fs.closeSync(logFd);
  } catch {
    /* ignore */
  }

  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim() : '';
  if (log) {
    console.log('[launch] --- electron log ---');
    console.log(log.split(/\r?\n/).slice(-20).join('\n'));
  }

  if (signal) {
    console.error(`[launch] killed by ${signal}`);
    process.exit(1);
  }
  console.log(`[launch] exited with ${code}`);
  process.exit(code ?? 0);
});

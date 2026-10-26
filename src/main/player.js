'use strict';

/**
 * 播放这一层的「纯逻辑」：校验一个路径到底能不能播。
 * 故意不 require electron —— 这样能拿普通 node 单测，
 * 真正调默认播放器的那一行留在 main.js 里。
 *
 * 校验的目的不只是「别崩」：渲染进程万一被注入，也不能拿到
 * 「随便传个 C:\Windows\System32\x.exe 就给你打开」的能力。
 * 所以只有**本次扫描结果里出现过**的视频文件才允许播。
 */

const fs = require('node:fs');
const path = require('node:path');

const { VIDEO_EXTS } = require('./scanner');

/** 把扫描结果里所有文件摊平，方便按路径查 */
function allFiles(scan) {
  if (!scan) return [];
  return [...(scan.matched || []), ...(scan.unmatched || []), ...(scan.extras || [])];
}

/** 路径是否在某个根目录里面（防 `..\..\` 逃逸） */
function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {object|null} scan  scanner.loadScan() 的结果
 * @param {unknown} filePath  渲染进程传来的路径
 * @returns {{ok:true, file:string, name:string, showTitle:string, episode:number|null, size:number}
 *          |{ok:false, error:string}}
 */
function checkPlayable(scan, filePath) {
  if (!scan || !scan.root) return { ok: false, error: '还没扫过资源目录' };
  if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, error: '没给文件路径' };
  if (filePath.includes('\u0000')) return { ok: false, error: '路径不合法' };

  const target = path.resolve(filePath);
  if (!isInside(scan.root, target)) return { ok: false, error: '这个文件不在你选的资源目录里' };

  const record = allFiles(scan).find((f) => path.resolve(f.path) === target);
  if (!record) return { ok: false, error: '这个文件不在上次扫描结果里，重新扫一下吧' };

  const ext = path.extname(target).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return { ok: false, error: `不是能播的视频格式：${ext || '无扩展名'}` };

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, error: '文件不在了，可能被移动或删除' };
  }
  if (!stat.isFile()) return { ok: false, error: '这不是一个文件' };
  if (stat.size === 0) return { ok: false, error: '这是个空文件' };

  return {
    ok: true,
    file: target,
    name: record.name,
    showId: record.showId || '',
    showTitle: record.showTitle || '',
    season: scan.season || '',
    episode: record.episode === undefined ? null : record.episode,
    size: stat.size,
  };
}

module.exports = { checkPlayable, isInside, allFiles };

'use strict';

/**
 * 扫本地资源目录，认出「哪个文件是哪部动画的第几集」
 * ------------------------------------------------------------
 * 三个阶段：
 *   1. walk()     递归找视频文件
 *   2. matchShow() 拿文件名/文件夹名去跟当季番剧表比对，认出是哪部
 *   3. parseEpisode() 从文件名里抠出集数
 *
 * 认不出来的不丢，标成 unmatched 交给界面「待确认」，让人手动指派。
 *
 * 这个文件不 require electron，可以用普通 node 直接测（scripts/test-scanner.js）。
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- 常量

const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
  '.m4v', '.ts', '.rmvb', '.rm', '.mpg', '.mpeg', '.m2ts',
]);

// 这些目录不进去：进去只会浪费时间，还可能扫到一堆系统垃圾
const SKIP_DIR_NAMES = new Set([
  'node_modules', '$recycle.bin', 'recycler', 'system volume information',
  'windows', 'program files', 'program files (x86)', 'appdata',
  '$windows.~bt', '$windows.~ws', 'recovery', 'perflogs', 'msocache',
]);

const MAX_FILES = 20000; // 上限，防止指到整个盘扫到天荒地老

// 文件名里出现这些词，说明不是正片（片头片尾、预告、花絮）
const EXTRA_RE = /\b(ncop?\d?|nced\d?|ova|oad|sp\d*|pv\d*|cm\d*|menu|preview|special|extra|creditless)\b/i;

// 干扰词：分辨率、编码、来源、音轨 —— 找集数前先删掉，免得「1080」被当成第 1080 集
const NOISE_RE = new RegExp(
  [
    '\\d{3,4}[pi]', '4k', '8k', 'uhd', 'hdr',
    'hevc', 'avc', 'x265', 'x264', 'h\\.?265', 'h\\.?264', '10bit', '8bit', '10-bit', '8-bit',
    'aac', 'flac', 'ac3', 'eac3', 'dts', 'opus', 'ma\\b',
    'web-?dl', 'web-?rip', 'bd-?rip', 'blu-?ray', 'baha', 'b-?global', 'cr\\b', 'hdtv', 'remux', 'dvdrip',
    '简繁', '简日', '繁日', '简繁日', '内封', '内嵌', '双语', '字幕',
  ].join('|'),
  'gi'
);

// ---------------------------------------------------------------- 文件名清洗

/**
 * 全角转半角、去空白、去标点、去重音符、罗马音归一 —— 用来比标题。
 * 最后那几步是为了「Tensei Goblin Dakedo Shitsumon Aru」和
 * 「Tensei Goblin dakedo Shitsumon Aru?」这种大小写/问号/长音差异能对上，
 * 顺带把训令式（situmon）和赫本式（shitsumon）抹平。
 */
function normalizeText(input) {
  return String(input || '')
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // ō → o
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(
      /[·・!！?？,，.。:：;；'"‘’“”()（）[\]【】{}<>《》_\-—~～|/\\+*&%#@=、…]/g,
      ''
    )
    .replace(/sha|sya/g, 'sa')
    .replace(/shu|syu/g, 'su')
    .replace(/sho|syo/g, 'so')
    .replace(/shi|si/g, 'si')
    .replace(/chi|ti/g, 'ti')
    .replace(/tsu|tu/g, 'tu')
    .replace(/fu|hu/g, 'hu')
    .replace(/ji|zi/g, 'zi')
    .replace(/ja|zya/g, 'za')
    .replace(/ju|zyu/g, 'zu')
    .replace(/jo|zyo/g, 'zo')
    .replace(/ou|oo/g, 'o');
}

/** 把「[Lilith-Raws] xxx - 03 (1080p) [ABCD1234].mkv」洗成「xxx」这样的名字 */
function cleanName(fileName) {
  let s = path.parse(String(fileName)).name;
  s = s.replace(/\[[^\]]*\]/g, ' '); // 方括号组：字幕组、校验码
  s = s.replace(/\([^)]*\)/g, ' '); // 圆括号组：年份、分辨率、CHS
  s = s.replace(/[_.]+/g, ' ');
  s = s.replace(NOISE_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---------------------------------------------------------------- 集数

/**
 * 从文件名里抠集数。
 * @returns {{episode: number|null, method: string, kind: string, range?: [number, number]}}
 */
function parseEpisode(fileName) {
  const base = path.parse(String(fileName)).name;

  // 先把「[01]」「[12v2]」这种纯数字方括号留个印象，因为下面要把所有方括号删掉
  const bracketHit = base.match(/\[(\d{1,4})(?:[vV]\d)?\]/);
  let bracketEp = bracketHit ? Number(bracketHit[1]) : null;
  if (bracketEp !== null && bracketEp >= 1900 && bracketEp <= 2100) bracketEp = null;

  let s = base.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');

  if (EXTRA_RE.test(s)) {
    return { episode: null, method: 'extra', kind: 'extra' };
  }

  s = s.replace(NOISE_RE, ' ');

  // 合集：01-12 / 01~12，一个文件里装好几集
  const range = s.match(/(?:^|[\s_\-.])(\d{1,4})\s*[-~－]\s*(\d{1,4})(?:[\s_\-.v]|$)/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (a >= 1 && b > a && b <= 2000 && b - a <= 200) {
      return { episode: a, method: 'range', kind: 'batch', range: [a, b] };
    }
  }

  const rules = [
    { re: /第\s*(\d{1,4})\s*[话話集]/i, method: '第N话' },
    { re: /[Ss]\d{1,2}[Ee](\d{1,4})/, method: 'SxxExx' },
    { re: /\b[Ee][Pp]?\.?\s*(\d{1,4})\b/, method: 'EPn' },
    { re: /(?:^|[\s_\-.])(\d{1,4})(?:[vV]\d)?(?:[\s_\-.]|$)/, method: '裸数字' },
  ];

  for (const { re, method } of rules) {
    const m = s.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    // 1900~2100 之间当作年份，不是集数
    if (method === '裸数字' && n >= 1900 && n <= 2100) continue;
    if (!Number.isInteger(n) || n < 0 || n > 2000) continue;
    return { episode: n, method, kind: 'main' };
  }

  // 上面都没命中，再看方括号里那个纯数字
  if (bracketEp !== null) {
    return { episode: bracketEp, method: '[n]', kind: 'main' };
  }

  return { episode: null, method: 'none', kind: 'unknown' };
}

// ---------------------------------------------------------------- 标题比对

/** 最长公共子序列长度 —— 中文字符串没法分词，这是最稳的相似度度量 */
function lcsLength(a, b) {
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  if (m * n > 40000) {
    // 太长了就别算，避免拖慢
    return a.length >= b.length ? (a.includes(b) ? b.length : 0) : b.includes(a) ? a.length : 0;
  }
  let prev = new Uint16Array(n + 1);
  let cur = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      cur[j] = ca === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return prev[n];
}

/**
 * 给「候选名」（文件夹名或文件名）和「番剧标题」打分。
 * 1.0 = 完全一样；0.9+ = 一方包含另一方；0.6~0.8 = 大部分字能对上；0 = 明显不是。
 */
function scoreTitle(candidate, title) {
  const a = normalizeText(candidate);
  const b = normalizeText(title);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) {
    // 包含关系，但短的一方太短（<4 字）容易误伤，扣一点
    const shorter = Math.min(a.length, b.length);
    return shorter >= 4 ? 0.92 : 0.8;
  }
  if (Math.min(a.length, b.length) < 4) return 0;
  const ratio = lcsLength(a, b) / Math.min(a.length, b.length);
  if (ratio >= 0.8) return 0.78;
  if (ratio >= 0.6) return 0.62;
  return 0;
}

/**
 * 从整张番剧表里挑最像的那一部。
 * 除了中文标题，还会比这些别名：
 *   - show.aliases：季度数据里的罗马音/英文/别名（AniList 给的）
 *   - aliasMap：用户手动指派时记下的文件夹名
 * @param {string} candidate 文件夹名或文件名
 * @param {Array<{id:string,title:string,aliases?:string[]}>} shows
 * @param {Map<string,string[]>} aliasMap showId -> 用户别名数组
 */
function matchShow(candidate, shows, aliasMap) {
  let best = { showId: null, title: '', score: 0 };
  for (const show of shows) {
    let score = scoreTitle(candidate, show.title);
    if (show.titleJp) score = Math.max(score, scoreTitle(candidate, show.titleJp));
    for (const alias of show.aliases || []) {
      if (score >= 1) break;
      score = Math.max(score, scoreTitle(candidate, alias));
    }
    const aliases = (aliasMap && aliasMap.get(show.id)) || [];
    for (const alias of aliases) {
      if (score >= 1) break;
      score = Math.max(score, scoreTitle(candidate, alias));
    }
    if (score > best.score) {
      best = { showId: show.id, title: show.title, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------- 扫目录

/** 递归列视频文件，异步、可中断 */
async function walk(root, { signal, onProgress, maxFiles = MAX_FILES } = {}) {
  const files = [];
  const errors = [];
  let dirs = 0;

  const stack = [root];
  while (stack.length) {
    if (signal && signal.aborted) break;
    const dir = stack.pop();
    dirs++;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({ dir, error: err.code || err.message });
      continue;
    }
    for (const entry of entries) {
      if (signal && signal.aborted) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const low = entry.name.toLowerCase();
        if (SKIP_DIR_NAMES.has(low) || entry.name.startsWith('.')) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;
      let size = 0;
      try {
        const st = await fs.promises.stat(full);
        size = st.size;
      } catch {
        /* 拿不到大小就算了，不影响识别 */
      }
      files.push({ path: full, name: entry.name, dir, ext, size });
      if (onProgress && files.length % 50 === 0) {
        onProgress({ found: files.length, dir });
      }
      if (files.length >= maxFiles) {
        errors.push({ dir: root, error: `文件数超过上限 ${maxFiles}，只扫了前 ${maxFiles} 个` });
        return { files, dirs, errors, truncated: true };
      }
    }
  }

  return { files, dirs, errors, truncated: false };
}

/**
 * 扫 + 匹配，产出可直接存盘的结构。
 * @param {object} opts
 * @param {string} opts.root          资源目录
 * @param {Array} opts.shows          当季番剧表（至少要有 id/title）
 * @param {Map<string,string[]>} opts.aliasMap
 */
async function scanDirectory({ root, shows, aliasMap, signal, onProgress }) {
  const started = Date.now();
  const { files, dirs, errors, truncated } = await walk(root, { signal, onProgress });

  // 同一个文件夹名只匹配一次：几百个文件往往只分布在几十个文件夹里
  const dirCache = new Map();
  const cacheMatch = (name) => {
    if (!dirCache.has(name)) dirCache.set(name, matchShow(name, shows, aliasMap));
    return dirCache.get(name);
  };

  const matched = [];
  const unmatched = [];
  const extras = [];

  for (const file of files) {
    if (signal && signal.aborted) break;
    const ep = parseEpisode(file.name);
    const dirName = path.basename(file.dir);
    const fileBase = path.parse(file.name).name;

    // 先看文件夹（动漫资源通常按作品分文件夹），再看文件名本身
    let hit = cacheMatch(dirName);
    let by = '文件夹名';
    if (!hit.showId || hit.score < 0.6) {
      const fileHit = matchShow(fileBase, shows, aliasMap);
      if (fileHit.score > (hit.score || 0)) {
        hit = fileHit;
        by = '文件名';
      }
    }

    const record = {
      path: file.path,
      name: file.name,
      dir: file.dir,
      size: file.size,
      ext: file.ext,
      episode: ep.episode,
      episodeMethod: ep.method,
      kind: ep.kind,
      range: ep.range || null,
      showId: hit.showId,
      showTitle: hit.title,
      score: Number(hit.score.toFixed(2)),
      matchedBy: by,
    };

    if (ep.kind === 'extra') {
      extras.push(record);
    } else if (record.showId && record.score >= 0.6) {
      // 认出了作品但没认出集数，也算「待确认」——不能当第 0 集播
      if (record.episode === null) unmatched.push(record);
      else matched.push(record);
    } else {
      unmatched.push(record);
    }
  }

  matched.sort((a, b) => (a.episode || 0) - (b.episode || 0) || a.path.localeCompare(b.path));

  return {
    root,
    shows: shows.length,
    files: files.length,
    dirs,
    matched,
    unmatched,
    extras,
    errors,
    truncated,
    scannedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------- 存盘

const SCAN_FILE = 'scan.json';

function scanPath(userData) {
  return path.join(userData, SCAN_FILE);
}

function saveScan(userData, result) {
  const file = scanPath(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function loadScan(userData) {
  try {
    return JSON.parse(fs.readFileSync(scanPath(userData), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  VIDEO_EXTS,
  SCAN_FILE,
  normalizeText,
  cleanName,
  parseEpisode,
  lcsLength,
  scoreTitle,
  matchShow,
  walk,
  scanDirectory,
  scanPath,
  saveScan,
  loadScan,
};

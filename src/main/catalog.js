'use strict';

/**
 * 季度番剧数据：抓取 yuc.wiki → 解析 → 缓存封面
 * ------------------------------------------------------------
 * 这一层故意不依赖 electron：可以在普通 Node 里跑（scripts/test-catalog.js），
 * 方便对着 fixture 做回归测试。路径由调用方注入。
 *
 * yuc.wiki 的结构（2026 秋实测）：
 *   div.post-body
 *     td.date2                 → 档期分节，如「周一 (月)」「网络放送 & 其他」
 *     div.div_date / div.div_date_
 *       p.imgtext4             → 放送时间 20:30~
 *       p.imgep                → 放送日期 10/5~
 *       img[data-src|src]      → 封面（i0.hdslb.com）
 *       父容器里的 table:
 *         tr[1] td[1]          → 标题（<br> 分隔的中日文名）
 *         tr.tr_area a         → 平台链接，里面 p.area 是平台名
 *         tr.tr_area_ex        → p.pmfs2 网络放送备注 / p.pmex 集数备注
 */

const cheerio = require('cheerio');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 抓 YouTube 之类会被 403：yuc.wiki 的封面绝不能带 Referer，只能带 UA */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 当前季度号：1/4/7/10 月各一档，yuc.wiki 的 URL 就是 /202610/ 这种 */
function currentSeason(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const month = m <= 3 ? 1 : m <= 6 ? 4 : m <= 9 ? 7 : 10;
  return `${y}${String(month).padStart(2, '0')}`;
}

function seasonLabel(season) {
  const y = season.slice(0, 4);
  const m = Number(season.slice(4, 6));
  const name = { 1: '冬季档', 4: '春季档', 7: '夏季档', 10: '秋季档' }[m] || '';
  return `${y} 年 ${m} 月新番 · ${name}`;
}

function seasonUrl(season) {
  return `https://yuc.wiki/${season}/`;
}

// ---------------------------------------------------------------- 解析

function squish(s) {
  return String(s || '')
    .replace(/[\u3000\s]+/g, ' ')
    .trim();
}

/** 取文本，但把 <br> 当空格（标题里中日文名靠 br 分隔） */
function textWithBreaks($, el) {
  let out = '';
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'text') {
      out += node.data;
    } else if (node.type === 'tag') {
      if (node.tagName === 'br') out += ' ';
      for (const child of node.children || []) walk(child);
    }
  };
  for (const child of el.children || []) walk(child);
  return squish(out);
}

function hasClass(el, name) {
  const cls = (el.attribs && el.attribs.class) || '';
  return cls.split(/\s+/).includes(name);
}

/** 稳定的 id：同一部番重抓也得到同一个 id，别用数组下标 */
function idOf(title) {
  return crypto.createHash('sha1').update(title, 'utf8').digest('hex').slice(0, 12);
}

/**
 * 解析季度页 HTML → 番剧条目数组。
 * 按文档顺序遍历，先记 section，再记条目，行为与旧版 yuc/build.py 对齐。
 */
function parseCatalog(html, season) {
  const $ = cheerio.load(html);
  const body = $('div.post-body').first();
  if (!body.length) throw new Error('页面里没有 div.post-body，yuc.wiki 结构可能变了');

  const entries = [];
  let section = '';

  const visit = (node) => {
    if (node.type === 'tag') {
      if (node.tagName === 'td' && hasClass(node, 'date2')) {
        section = squish($(node).text());
      }
      if (node.tagName === 'div' && (hasClass(node, 'div_date') || hasClass(node, 'div_date_'))) {
        const entry = readEntry($, node, section, season);
        if (entry) entries.push(entry);
      }
      for (const child of node.children || []) visit(child);
    }
  };
  visit(body.get(0));

  return entries;
}

function readEntry($, node, section, season) {
  const el = $(node);
  const wrap = el.parent();

  const img = el.find('img').first();
  const cover = img.length ? img.attr('data-src') || img.attr('src') || null : null;

  let time = '';
  let date = '';
  el.children('p').each((_, p) => {
    if (hasClass(p, 'imgtext4')) time = squish($(p).text());
    else if (hasClass(p, 'imgep')) date = squish($(p).text());
  });

  let title = '';
  const platforms = [];
  let net = '';
  let episodes = '';

  const table = wrap.children('div').find('table').first();
  if (table.length) {
    const firstCell = table.find('tr').first().children('td').first();
    if (firstCell.length) title = textWithBreaks($, firstCell.get(0));

    table.find('tr.tr_area a').each((_, a) => {
      const areaEl = $(a).find('p.area').first();
      platforms.push({ area: areaEl.length ? squish(areaEl.text()) : '', url: $(a).attr('href') || '' });
    });

    table.find('tr.tr_area_ex p').each((_, p) => {
      if (hasClass(p, 'pmfs2')) net = squish($(p).text());
      else if (hasClass(p, 'pmex')) episodes = squish($(p).text());
    });
  }

  if (!title) return null;

  return { id: idOf(title), season, section, time, date, title, cover, platforms, net, episodes };
}

// ---------------------------------------------------------------- 抓取

async function fetchText(url, timeoutMs = 30000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

async function fetchBinary(url, timeoutMs = 30000) {
  const res = await fetch(url, {
    // 关键：不设 Referer。i0.hdslb.com 看到 yuc.wiki 的 Referer 会 403
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/** 下载缺失的封面；已存在且不是空文件就跳过 */
async function cacheCovers(entries, coverDir, log = () => {}) {
  fs.mkdirSync(coverDir, { recursive: true });
  let downloaded = 0;
  let failed = 0;

  await mapLimit(entries, 6, async (entry) => {
    entry.coverFile = null;
    if (!entry.cover) return;
    const file = path.join(coverDir, `${entry.id}.jpg`);
    entry.coverFile = file;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 2000) return;
      const buf = await fetchBinary(entry.cover);
      if (buf.length < 1000) throw new Error('too small');
      fs.writeFileSync(file, buf);
      downloaded += 1;
    } catch (err) {
      failed += 1;
      entry.coverFile = null;
      log(`cover fail ${entry.title}: ${err.message}`);
    }
  });

  return { downloaded, failed };
}

// ---------------------------------------------------------------- 缓存

function pathsFor(userData, season) {
  const catalogDir = path.join(userData, 'catalog');
  return {
    catalogDir,
    htmlFile: path.join(catalogDir, `${season}.html`),
    jsonFile: path.join(catalogDir, `${season}.json`),
    coverDir: path.join(userData, 'covers', season),
  };
}

function readCache(p) {
  try {
    const raw = fs.readFileSync(p.jsonFile, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries)) return null;
    return data;
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再改名，断电也不会留下半个 json */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 拿一个季度的数据。有 24h 内的缓存就直接用，否则重新抓。
 * 抓失败但手里有旧缓存时，返回旧数据并标记 stale。
 */
async function loadSeason(userData, season = currentSeason(), { force = false, log = () => {} } = {}) {
  const p = pathsFor(userData, season);
  const cached = readCache(p);
  const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;

  if (!force && cached && age < CACHE_TTL_MS) {
    log(`cache hit ${season} (${cached.entries.length} 部)`);
    return { ...cached, stale: false, fromCache: true };
  }

  try {
    log(`fetch ${seasonUrl(season)}`);
    const html = await fetchText(seasonUrl(season));
    fs.mkdirSync(p.catalogDir, { recursive: true });
    fs.writeFileSync(p.htmlFile, html, 'utf8');

    const entries = parseCatalog(html, season);
    if (!entries.length) throw new Error('解析出 0 部动画');

    const { downloaded, failed } = await cacheCovers(entries, p.coverDir, log);
    const data = {
      season,
      label: seasonLabel(season),
      source: seasonUrl(season),
      fetchedAt: new Date().toISOString(),
      entries,
    };
    writeJsonAtomic(p.jsonFile, data);
    log(`parsed ${entries.length} 部，封面新下载 ${downloaded}，失败 ${failed}`);
    return { ...data, stale: false, fromCache: false };
  } catch (err) {
    if (cached) {
      log(`fetch failed, fallback to cache: ${err.message}`);
      return { ...cached, stale: true, fromCache: true, error: err.message };
    }
    throw err;
  }
}

module.exports = {
  UA,
  CACHE_TTL_MS,
  currentSeason,
  seasonLabel,
  seasonUrl,
  parseCatalog,
  loadSeason,
  pathsFor,
};

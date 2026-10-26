'use strict';

/**
 * 罗马音别名：AniList 查询层
 * ------------------------------------------------------------
 * 字幕组大多用罗马音命名（Tensei Goblin dakedo Shitsumon Aru - 03.mkv），
 * 但 yuc.wiki 给的是中文名。所以流程是：
 *   中文名 --(介绍区的 title_jp_*)-->  日文原名  --(AniList)-->  romaji / english / synonyms
 * 之后 scanner 把这些当成别名参与匹配。
 *
 * 这一层同样不依赖 electron，可以单独跑、可以注入假请求做离线测试。
 * 结果按季度存盘（userData/aliases/<season>.json），一个季度只查一次。
 */

const fs = require('node:fs');
const path = require('node:path');

const ANILIST_URL = 'https://graphql.anilist.co';
const BATCH = 8; // 一条 GraphQL 里塞 8 个别名查询，72 部只要 9 次请求
const ALIAS_FILE_VERSION = 1;

/** 归一化：只用来比对，不用于展示 */
function normalizeForMatch(input) {
  return String(input || '')
    .normalize('NFKC') // 全角 → 半角
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // 去掉 ō ū â 这类附加符号
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~、。・…—–ー「」『』【】〈〉《》·:;,.!?"'()\[\]{}～〜]/g, '');
}

function lcsRatio(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (m * n > 40000) return a.includes(b) || b.includes(a) ? 0.8 : 0;
  let prev = new Uint16Array(n + 1);
  let cur = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      cur[j] = ca === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return (2 * prev[n]) / (m + n);
}

/** 去掉「第2期 / 2nd Season / Part.2」这类续作尾巴，续作和本体互相认 */
function stripSequel(text) {
  return String(text || '')
    .replace(/第[一二三四五六七八九十\d]+[期季部クール]/g, '')
    .replace(/[ⅡⅢⅣⅤ]+/g, '')
    .replace(/part\.?\s*\d+/gi, '')
    .replace(/\bseason\s*\d+/gi, '')
    .replace(/\b\d+(?:st|nd|rd|th)\s*season\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 判断 AniList 返回的条目是不是我们问的那部 */
function isSameShow(jpTitle, media) {
  const target = normalizeForMatch(stripSequel(jpTitle));
  if (!target) return false;
  const t = media.title || {};
  const candidates = [t.native, t.romaji, t.english, ...(media.synonyms || [])].filter(Boolean);
  for (const c of candidates) {
    const n = normalizeForMatch(stripSequel(c));
    if (!n) continue;
    if (n === target) return true;
    if (target.length >= 5 && (n.includes(target) || target.includes(n))) return true;
    if (lcsRatio(n, target) >= 0.72) return true;
  }
  return false;
}

function aliasesOf(media) {
  const t = media.title || {};
  const list = [t.romaji, t.english, ...(media.synonyms || [])];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = normalizeForMatch(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(0, 12);
}

async function postGraphql(query, variables, { timeoutMs = 20000 } = {}) {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AniList HTTP ${res.status} ${text.slice(0, 80)}`);
  const json = JSON.parse(text);
  // AniList 有个坑：Media(search:) 搜不到时会整条请求 404，连带别的字段一起 null。
  // 所以一律用 Page(...){ media(search:…) } 包一层，搜不到只是空数组，不炸整批。
  if (json.errors && json.errors.length && !json.data) {
    throw new Error(`AniList: ${json.errors[0].message}`);
  }
  return json.data;
}

const MEDIA_FIELDS = 'title { romaji english native } synonyms';

/**
 * 批量查 romaji。items: [{ id, titleJp }]
 * 返回 Map(id → string[] 别名)；查不到的条目不会出现在 Map 里。
 */
async function lookupRomaji(items, { log = () => {}, request = postGraphql, delayMs = 700 } = {}) {
  const list = items.filter((it) => it && it.id && it.titleJp);
  const result = new Map();
  let matched = 0;

  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const params = chunk.map((_, idx) => `$q${idx}: String`).join(', ');
    const fields = chunk
      .map((_, idx) => `p${idx}: Page(perPage: 1) { media(search: $q${idx}, type: ANIME) { ${MEDIA_FIELDS} } }`)
      .join('\n  ');
    const variables = {};
    chunk.forEach((it, idx) => {
      variables[`q${idx}`] = it.titleJp;
    });

    let data = null;
    try {
      data = await request(`query (${params}) {\n  ${fields}\n}`, variables);
    } catch (err) {
      log(`romaji 查询失败（第 ${i / BATCH + 1} 批）：${err.message}`);
    }

    chunk.forEach((it, idx) => {
      const page = data && data[`p${idx}`];
      const media = page && page.media && page.media[0];
      if (!media) return;
      if (!isSameShow(it.titleJp, media)) {
        const t = media.title || {};
        log(`romaji 跳过 ${it.title || it.titleJp}：搜到的是 ${t.romaji || t.native || '别的条目'}`);
        return;
      }
      const aliases = aliasesOf(media);
      if (aliases.length) {
        result.set(it.id, aliases);
        matched += 1;
      }
    });

    if (i + BATCH < list.length && delayMs) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  log(`romaji 命中 ${matched}/${list.length}`);
  return result;
}

// ---------------------------------------------------------------- 存盘

function aliasesPath(userData, season) {
  return path.join(userData, 'aliases', `${season}.json`);
}

function readAliasStore(userData, season) {
  try {
    const raw = fs.readFileSync(aliasesPath(userData, season), 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.version !== ALIAS_FILE_VERSION || typeof data.byId !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

function writeAliasStore(userData, season, store) {
  const file = aliasesPath(userData, season);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 给 entries 挂上 aliases（原地修改）。
 * - 已有存盘：直接用，不发请求
 * - 没有存盘且 allowNetwork：查 AniList 并存盘
 * - 网络挂了也不抛，只是这季度没有罗马音别名
 */
async function attachAliases(entries, userData, season, { log = () => {}, allowNetwork = true, force = false, request } = {}) {
  const need = entries.filter((e) => e.titleJp);
  if (!need.length) return { fromStore: false, fetched: false, matched: 0 };

  const existing = force ? null : readAliasStore(userData, season);
  if (existing) {
    let matched = 0;
    for (const entry of entries) {
      const aliases = existing.byId[entry.id];
      if (Array.isArray(aliases) && aliases.length) {
        entry.aliases = aliases;
        matched += 1;
      }
    }
    log(`romaji 用存盘（${matched} 部有别名）`);
    return { fromStore: true, fetched: false, matched };
  }

  if (!allowNetwork) return { fromStore: false, fetched: false, matched: 0 };

  const found = await lookupRomaji(need, { log, request });
  const byId = {};
  for (const entry of entries) {
    const aliases = found.get(entry.id);
    if (aliases) {
      entry.aliases = aliases;
      byId[entry.id] = aliases;
    } else {
      delete entry.aliases;
    }
  }
  writeAliasStore(userData, season, {
    version: ALIAS_FILE_VERSION,
    season,
    fetchedAt: new Date().toISOString(),
    byId,
  });
  return { fromStore: false, fetched: true, matched: Object.keys(byId).length };
}

module.exports = {
  ANILIST_URL,
  BATCH,
  normalizeForMatch,
  lcsRatio,
  isSameShow,
  aliasesOf,
  lookupRomaji,
  attachAliases,
  aliasesPath,
  readAliasStore,
  writeAliasStore,
};

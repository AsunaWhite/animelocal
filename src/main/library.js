'use strict';

/**
 * 「这部我本地有」的勾选记录
 * ------------------------------------------------------------
 * 存一个 JSON：userData/library.json
 * {
 *   "version": 1,
 *   "seasons": {
 *     "202610": {
 *       "74b362aa1f66": { "owned": true, "updatedAt": 1759999999999 }
 *     }
 *   }
 * }
 *
 * 为什么不直接存数组：id 是标题的哈希，增删不会互相影响；
 * 按季度分桶，换季之后老季度的记录还留着，翻回去看得到。
 *
 * 这个文件不 require electron，可以用普通 node 直接测（scripts/test-library.js）。
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const FILE_NAME = 'library.json';

const SEASON_RE = /^\d{6}$/;
const ID_RE = /^[0-9a-f]{6,64}$/i;

function libraryPath(userData) {
  return path.join(userData, FILE_NAME);
}

function emptyLibrary() {
  return { version: VERSION, seasons: {} };
}

/** 把磁盘上读来的东西修成可信形状：坏字段丢掉，不让脏数据传染 */
function normalize(raw) {
  const out = emptyLibrary();
  if (!raw || typeof raw !== 'object' || !raw.seasons || typeof raw.seasons !== 'object') {
    return out;
  }
  for (const [season, items] of Object.entries(raw.seasons)) {
    if (!SEASON_RE.test(season) || !items || typeof items !== 'object') continue;
    const bucket = {};
    for (const [id, rec] of Object.entries(items)) {
      if (!ID_RE.test(id) || !rec || typeof rec !== 'object') continue;
      bucket[id] = {
        owned: Boolean(rec.owned),
        updatedAt: Number(rec.updatedAt) || 0,
      };
    }
    out.seasons[season] = bucket;
  }
  return out;
}

/**
 * 读整个库。文件不存在 / 坏了 / 读到一半断电了，都返回空库，不抛错。
 * 理由：勾选记录丢了是小事，因为读不到一个 json 就打不开软件是大事。
 */
function readLibrary(userData) {
  try {
    const raw = fs.readFileSync(libraryPath(userData), 'utf8');
    return normalize(JSON.parse(raw));
  } catch {
    return emptyLibrary();
  }
}

/** 原子写：先写临时文件再改名，中途挂掉最多留个 .tmp，不会把好数据写坏 */
function writeLibrary(userData, lib) {
  const file = libraryPath(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 某个季度里「我有的」id 集合 */
function ownedIds(userData, season) {
  assertSeason(season);
  const bucket = readLibrary(userData).seasons[season] || {};
  return Object.keys(bucket).filter((id) => bucket[id].owned);
}

function assertSeason(season) {
  if (!SEASON_RE.test(String(season))) {
    throw new Error(`季度号不合法：${season}`);
  }
}

function assertId(id) {
  if (!ID_RE.test(String(id))) {
    throw new Error(`动画 id 不合法：${id}`);
  }
}

/**
 * 勾上 / 取消勾上，立刻落盘，返回这个季度的最新计数。
 * @param {string} userData
 * @param {string} season 202610
 * @param {string} id     动画 id
 * @param {boolean} owned true = 我有
 */
function setOwned(userData, season, id, owned) {
  season = String(season);
  id = String(id);
  assertSeason(season);
  assertId(id);

  const lib = readLibrary(userData);
  if (!lib.seasons[season]) lib.seasons[season] = {};

  if (owned) {
    lib.seasons[season][id] = { owned: true, updatedAt: Date.now() };
  } else {
    // 取消勾选就把记录删掉，别留一堆 owned:false 的垃圾
    delete lib.seasons[season][id];
  }

  writeLibrary(userData, lib);

  return {
    season,
    id,
    owned: Boolean(owned),
    ownedCount: Object.keys(lib.seasons[season]).length,
  };
}

module.exports = {
  VERSION,
  FILE_NAME,
  libraryPath,
  emptyLibrary,
  normalize,
  readLibrary,
  writeLibrary,
  ownedIds,
  setOwned,
};

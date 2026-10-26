'use strict';

/**
 * 每集的吐槽记录
 * ------------------------------------------------------------
 * 存 userData/notes.json
 * {
 *   "version": 1,
 *   "notes": {
 *     "202610|74b362aa1f66|3": {
 *       "season": "202610", "showId": "74b362aa1f66", "showTitle": "…",
 *       "episode": 3, "text": "这集节奏有点闷", "rating": 4,
 *       "playedAt": 1759999999999, "createdAt": …, "updatedAt": …
 *     }
 *   }
 * }
 *
 * 为什么 key 用「季度|作品id|集数」而不是文件路径：
 * 你换个文件夹存片子、重命名、换字幕组重下，吐槽就跟着文件跑了。
 * 只有「认不出集数」的文件才退回用路径当 key。
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const FILE_NAME = 'notes.json';
const MAX_TEXT = 2000;
const MAX_RATING = 5;

const SEASON_RE = /^\d{6}$/;
const ID_RE = /^[0-9a-f]{6,64}$/i;
const KEY_RE = /^(\d{6})\|([0-9a-f]{6,64})\|(\d{0,4})$/i;

function notesPath(userData) {
  return path.join(userData, FILE_NAME);
}

function emptyNotes() {
  return { version: VERSION, notes: {} };
}

/** 这个文件/这一集的记录键 */
function noteKey({ season, showId, episode, filePath } = {}) {
  const seasonText = String(season || '');
  const idText = String(showId || '');
  // 注意：Number(null) === 0，不能用「能转成数字」当判据，否则没集数会被当成第 0 集
  const hasEpisode = episode !== undefined && episode !== null && episode !== '';
  const ep = Number(episode);
  if (
    SEASON_RE.test(seasonText) &&
    ID_RE.test(idText) &&
    hasEpisode &&
    Number.isInteger(ep) &&
    ep >= 0 &&
    ep <= 9999
  ) {
    return `${seasonText}|${idText}|${ep}`;
  }
  if (typeof filePath === 'string' && filePath.trim()) {
    return `path|${path.resolve(filePath)}`;
  }
  return null;
}

function isValidKey(key) {
  return KEY_RE.test(String(key)) || /^path\|.+/.test(String(key));
}

function clampRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_RATING, Math.round(n)));
}

function normalizeText(text) {
  return String(text == null ? '' : text).slice(0, MAX_TEXT).trim();
}

function normalize(raw) {
  const out = emptyNotes();
  if (!raw || typeof raw !== 'object' || !raw.notes || typeof raw.notes !== 'object') return out;

  for (const [key, rec] of Object.entries(raw.notes)) {
    if (!isValidKey(key) || !rec || typeof rec !== 'object') continue;
    const text = normalizeText(rec.text);
    const rating = clampRating(rec.rating);
    const playedAt = Number(rec.playedAt) || 0;
    // 什么都没有的记录不占地方
    if (!text.trim() && !rating && !playedAt) continue;
    out.notes[key] = {
      season: typeof rec.season === 'string' ? rec.season : '',
      showId: typeof rec.showId === 'string' ? rec.showId : '',
      showTitle: typeof rec.showTitle === 'string' ? rec.showTitle.slice(0, 200) : '',
      episode: rec.episode == null ? null : Number(rec.episode),
      text,
      rating,
      playedAt,
      createdAt: Number(rec.createdAt) || 0,
      updatedAt: Number(rec.updatedAt) || 0,
    };
  }
  return out;
}

function readNotes(userData) {
  try {
    return normalize(JSON.parse(fs.readFileSync(notesPath(userData), 'utf8')));
  } catch {
    return emptyNotes();
  }
}

function writeNotes(userData, db) {
  const file = notesPath(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function getNote(userData, key) {
  return readNotes(userData).notes[key] || null;
}

/**
 * @param {string} userData
 * @param {{season?:string, showId?:string, showTitle?:string, episode?:number, filePath?:string,
 *          text?:string, rating?:number, playedAt?:number}} patch
 * @returns {{ok:true, key:string, note:object|null, removed:boolean}}
 */
function saveNote(userData, patch = {}) {
  const key = noteKey(patch);
  if (!key) throw new Error('这一集没有 key，存不了吐槽');

  const db = readNotes(userData);
  const now = Date.now();
  const prev = db.notes[key] || { createdAt: now };

  const text = patch.text === undefined ? normalizeText(prev.text) : normalizeText(patch.text);
  const rating = patch.rating === undefined ? clampRating(prev.rating) : clampRating(patch.rating);
  const playedAt =
    patch.playedAt === undefined ? Number(prev.playedAt) || 0 : Math.max(Number(prev.playedAt) || 0, Number(patch.playedAt) || 0);

  // 字也删了、星也清零、也没看过 —— 整条记录不要了
  if (!text.trim() && !rating && !playedAt) {
    delete db.notes[key];
    writeNotes(userData, db);
    return { ok: true, key, note: null, removed: true };
  }

  const note = {
    season: patch.season !== undefined ? String(patch.season) : prev.season || '',
    showId: patch.showId !== undefined ? String(patch.showId) : prev.showId || '',
    showTitle: patch.showTitle !== undefined ? String(patch.showTitle).slice(0, 200) : prev.showTitle || '',
    episode:
      patch.episode !== undefined ? (patch.episode == null ? null : Number(patch.episode)) : prev.episode == null ? null : prev.episode,
    text,
    rating,
    playedAt,
    createdAt: Number(prev.createdAt) || now,
    updatedAt: now,
  };

  db.notes[key] = note;
  writeNotes(userData, db);
  return { ok: true, key, note, removed: false };
}

function deleteNote(userData, key) {
  const db = readNotes(userData);
  const existed = Boolean(db.notes[key]);
  if (existed) {
    delete db.notes[key];
    writeNotes(userData, db);
  }
  return existed;
}

/**
 * 列记录，默认按「最近动过」排。
 * @param {{season?:string, showId?:string, limit?:number}} opts
 */
function listNotes(userData, opts = {}) {
  const db = readNotes(userData);
  let items = Object.entries(db.notes).map(([key, note]) => ({ key, ...note }));
  if (opts.season) items = items.filter((n) => n.season === opts.season);
  if (opts.showId) items = items.filter((n) => n.showId === opts.showId);
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  if (Number(opts.limit) > 0) items = items.slice(0, Number(opts.limit));
  return items;
}

/** 各作品有几条吐槽：Map(showId -> n) */
function noteCounts(userData, season) {
  const counts = new Map();
  for (const n of listNotes(userData, { season })) {
    if (!n.showId) continue;
    counts.set(n.showId, (counts.get(n.showId) || 0) + 1);
  }
  return counts;
}

module.exports = {
  VERSION,
  FILE_NAME,
  MAX_TEXT,
  MAX_RATING,
  notesPath,
  emptyNotes,
  noteKey,
  isValidKey,
  normalize,
  readNotes,
  writeNotes,
  getNote,
  saveNote,
  deleteNote,
  listNotes,
  noteCounts,
};

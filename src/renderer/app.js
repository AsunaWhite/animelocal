'use strict';

/**
 * 渲染进程入口
 * ------------------------------------------------------------
 * 只干两件事：把数据画到页面上、把用户的操作通过 window.api 发出去。
 * 这里没有 Node，没有 fs，碰系统一律走 api。
 */

const $ = (sel) => document.querySelector(sel);

const state = {
  season: null,
  label: '',
  entries: [],
  keyword: '',
  filter: 'all', // all | owned | pending | notes
  ownedCount: 0,
  loading: false,
  scan: null, // 上次扫描结果：{root, matched, unmatched, extras, scannedAt}
  scanning: false,
  playing: null, // 正在打开的那一集（防连点）
  lastPlayed: null, // 最近播过的那一集路径
  noteList: [], // 本季所有吐槽（吐槽记录页用）
};

/** 当前季度：1/4/7/10 月各一档，跟 yuc.wiki 的季度号一致（如 202610） */
function currentSeason(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const month = m <= 3 ? 1 : m <= 6 ? 4 : m <= 9 ? 7 : 10;
  const label = { 1: '冬季档', 4: '春季档', 7: '夏季档', 10: '秋季档' }[month];
  return { year: y, month, key: `${y}${String(month).padStart(2, '0')}`, label };
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------- 骨架屏

function renderSkeleton(n = 12) {
  const box = $('#skeleton');
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const card = document.createElement('div');
    card.className = 'sk-card';
    card.innerHTML =
      '<div class="sk-cover"></div>' +
      '<div class="sk-body">' +
      '<div class="sk-line"></div><div class="sk-line"></div>' +
      '<div class="sk-line short"></div><div class="sk-line chip"></div>' +
      '</div>';
    frag.appendChild(card);
  }
  box.appendChild(frag);
  box.hidden = false;
}

function hideSkeleton() {
  $('#skeleton').hidden = true;
}

// ---------------------------------------------------------------- 状态条

function setIpcState(text, kind) {
  const el = $('#ipc-state');
  el.textContent = text;
  el.className = `tag tag-${kind}`;
}

function setStatus(text) {
  $('#status-text').textContent = text;
}

function showState({ emoji = '⚠', title, desc, retry = false }) {
  $('#state-emoji').textContent = emoji;
  $('#state-title').textContent = title;
  $('#state-desc').textContent = desc || '';
  $('#state-retry').hidden = !retry;
  $('#state').hidden = false;
}

function hideState() {
  $('#state').hidden = true;
}

/**
 * 右下角轻提示：操作反馈走这里。
 * kind: 'ok' | 'bad' | ''（默认中性）
 */
function toast(text, kind = '') {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast${kind ? ` is-${kind}` : ''}`;
  el.textContent = text;
  box.appendChild(el);
  // 最多留三条，多的自己先走
  while (box.childElementCount > 3) box.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 200);
  }, 2400);
}

// ---------------------------------------------------------------- 搜索

/**
 * 搜得到的字段：中文名、日文原名、罗马音/英文别名（来自 AniList）、周几。
 * 拼成一条小写串，命中判断和排序都够用。
 */
function entryHaystack(entry) {
  const bag = [entry.title, entry.titleJp, entry.section];
  if (Array.isArray(entry.aliases)) bag.push(...entry.aliases);
  return bag.filter(Boolean).join(' ').toLowerCase();
}

function matchesKeyword(entry, kw) {
  if (!kw) return true;
  return entryHaystack(entry).includes(kw);
}

/** 把命中关键词的片段包成 <mark>；没命中就原样输出 */
function fillHighlight(el, text, kw) {
  el.textContent = '';
  const q = String(kw || '').trim();
  const needle = q.toLowerCase();
  const lower = text.toLowerCase();
  if (!needle || !lower.includes(needle)) {
    el.textContent = text;
    return;
  }
  const frag = document.createDocumentFragment();
  let idx = 0;
  let hit = lower.indexOf(needle, idx);
  while (hit !== -1) {
    if (hit > idx) frag.appendChild(document.createTextNode(text.slice(idx, hit)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(hit, hit + needle.length);
    frag.appendChild(mark);
    idx = hit + needle.length;
    hit = lower.indexOf(needle, idx);
  }
  if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
  el.appendChild(frag);
}

// ---------------------------------------------------------------- 卡片

function buildCard(entry) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = entry.id;

  const coverBox = document.createElement('div');
  coverBox.className = 'card-cover';

  if (entry.coverUrl) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = entry.coverUrl;
    img.alt = entry.title;
    img.addEventListener('error', () => {
      coverBox.classList.add('is-missing');
      img.remove();
    });
    coverBox.appendChild(img);
  } else {
    coverBox.classList.add('is-missing');
  }

  if (entry.time) {
    const badge = document.createElement('span');
    badge.className = 'badge-time';
    badge.textContent = entry.time;
    coverBox.appendChild(badge);
  }

  // 右上角的勾选圈：标记「这部我本地有」
  const ownBtn = document.createElement('button');
  ownBtn.type = 'button';
  ownBtn.className = 'own-btn';
  ownBtn.dataset.id = entry.id;
  coverBox.appendChild(ownBtn);
  paintOwn(card, ownBtn, entry.owned);
  ownBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleOwned(entry, card, ownBtn);
  });

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.title = entry.title;
  fillHighlight(title, entry.title, state.keyword.trim());
  if (!state.keyword.trim() && entry.titleJp) title.title = `${entry.title}\n${entry.titleJp}`;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const bits = [entry.section, entry.date].filter(Boolean);
  meta.textContent = bits.join(' · ') || '—';

  body.append(title, meta);

  const chips = document.createElement('div');
  chips.className = 'chips';
  const areas = entry.platforms.map((p) => p.area).filter(Boolean);
  for (const area of areas.slice(0, 2)) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = area;
    chips.appendChild(chip);
  }
  if (areas.length > 2) {
    const more = document.createElement('span');
    more.className = 'chip chip-more';
    more.textContent = `+${areas.length - 2}`;
    more.title = areas.join(' / ');
    chips.appendChild(more);
  }
  if (!areas.length && entry.net) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-net';
    chip.textContent = entry.net;
    chips.appendChild(chip);
  }
  if (chips.childNodes.length) body.appendChild(chips);

  // 本地扫到几集，就在封面下直接排几个集数按钮 —— 点一下就用默认播放器播
  const eps = episodesOf(entry.id);
  if (eps.length) card.classList.add('has-files');
  body.appendChild(buildEpStrip(entry, eps));

  card.append(coverBox, body);
  if (entry.noteCount) paintNoteBadge(card, entry.noteCount);
  return card;
}

/**
 * 封面下那一排集数按钮。
 * 按集数升序排；播过的变绿；超过 MAX_CHIPS 收进抽屉（卡片不无限长）。
 */
function buildEpStrip(entry, eps) {
  const strip = document.createElement('div');
  strip.className = 'ep-strip';

  if (!eps.length) {
    const empty = document.createElement('span');
    empty.className = 'ep-empty';
    empty.textContent = '无本地文件';
    strip.appendChild(empty);
    return strip;
  }

  for (const f of eps.slice(0, MAX_CHIPS)) {
    strip.appendChild(buildEpChip(entry, f));
  }

  if (eps.length > MAX_CHIPS) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ep-chip ep-more';
    more.textContent = `+${eps.length - MAX_CHIPS}`;
    more.title = '还有这么多集，点开看全部';
    more.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openDrawer(entry);
    });
    strip.appendChild(more);
  }

  // 写吐槽 / 看文件名的入口（播放不用它，播放直接点集数）
  const noteEntry = document.createElement('button');
  noteEntry.type = 'button';
  noteEntry.className = 'ep-note-entry';
  noteEntry.textContent = '✎';
  noteEntry.title = `看这 ${eps.length} 集的详情、给单集写吐槽`;
  noteEntry.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openDrawer(entry);
  });
  strip.appendChild(noteEntry);

  return strip;
}

function buildEpChip(entry, file) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'ep-chip';
  chip.textContent = fmtEpisode(file);
  chip.title = `${file.name}\n${fmtSize(file.size)} · 点一下用默认播放器打开`;
  chip.dataset.path = file.path;
  if (file.note && file.note.playedAt) chip.classList.add('is-watched');
  if (state.lastPlayed === file.path) chip.classList.add('is-last');
  chip.addEventListener('click', (ev) => {
    ev.stopPropagation();
    playEpisode(file, chip);
  });
  return chip;
}

/** 把一张卡的「已标记」外观刷成 owned 的样子（建卡时和保存失败回滚时都用它） */
function paintOwn(card, btn, owned) {
  card.classList.toggle('is-owned', Boolean(owned));
  btn.textContent = owned ? '✓' : '';
  btn.title = owned ? '已标记：我本地有这部（再点取消）' : '标记：我本地有这部';
  btn.setAttribute('aria-pressed', String(Boolean(owned)));
}

/**
 * 点勾选圈的处理。
 * 先改界面再发 IPC —— 点下去要立刻有反应，不能等磁盘写完。
 * 万一主进程写盘失败，再把界面退回去，顺便在状态条说明原因。
 */
async function toggleOwned(entry, card, btn) {
  const next = !entry.owned;
  entry.owned = next;
  paintOwn(card, btn, next);
  updateCount();

  try {
    const res = await window.api.toggleOwned({
      season: state.season,
      id: entry.id,
      owned: next,
    });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : '主进程没应答');
    state.ownedCount = res.ownedCount;
    updateCount();
    setStatus(`已标记「${entry.title}」，本季一共 ${res.ownedCount} 部`);
    toast(next ? '已标记「我有这部」' : '已取消标记', next ? 'ok' : '');
    // 在「我有的」视图里取消勾选，这张卡就该从列表里消失
    if (state.filter === 'owned' && !next) renderCards();
  } catch (err) {
    entry.owned = !next;
    paintOwn(card, btn, !next);
    updateCount();
    setStatus(`保存失败：${err && err.message ? err.message : err}`);
    toast('标记没存上，再点一次试试', 'bad');
  }
}

// ---------------------------------------------------------------- 集数 / 抽屉

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(n)} ${units[i]}` : `${n.toFixed(1)} ${units[i]}`;
}

/** 某个动画 id 在本地扫到的集数，按集数从小到大排 */
function episodesOf(showId) {
  if (!state.scan || !Array.isArray(state.scan.matched)) return [];
  const list = state.scan.matched.filter((f) => f.showId === showId);
  return list.sort((a, b) => {
    const ea = a.episode === null || a.episode === undefined ? Number.MAX_SAFE_INTEGER : a.episode;
    const eb = b.episode === null || b.episode === undefined ? Number.MAX_SAFE_INTEGER : b.episode;
    if (ea !== eb) return ea - eb;
    return String(a.name).localeCompare(String(b.name), 'zh');
  });
}

/** 卡片上最多直接排多少个集数按钮，多出来的收进抽屉 */
const MAX_CHIPS = 14;

function fmtEpisode(f) {
  if (f.range) return `${f.range[0]}-${f.range[1]}`;
  if (f.episode === null || f.episode === undefined) return '?';
  return String(f.episode).padStart(2, '0');
}

function openDrawer(entry) {
  const eps = episodesOf(entry.id);
  if (!eps.length) return;
  $('#drawer-title').textContent = entry.title;
  const noted = eps.filter((f) => f.note && f.note.text).length;
  $('#drawer-sub').textContent = `${eps.length} 集${noted ? ` · 吐槽 ${noted} 条` : ''} · ${eps[0].dir}`;

  const body = $('#drawer-body');
  body.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'ep-list';
  for (const f of eps) {
    list.appendChild(buildEpisodeItem(f, entry));
  }
  body.appendChild(list);

  const tip = document.createElement('p');
  tip.className = 'drawer-tip';
  tip.textContent = '点某一集，就能给它打分、写吐槽；写过的会显示在这行下面。想播的话，点卡片封面下面对应那集的数字。';
  body.appendChild(tip);

  $('#drawer').hidden = false;
}

/** 一集 = 可点的行（点开就写吐槽）+ 可展开的吐槽区。播放只在卡片上做 */
function buildEpisodeItem(file, entry) {
  const item = document.createElement('div');
  item.className = 'ep-item';

  const row = document.createElement('div');
  row.className = 'ep-row';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.title = `${file.path}\n点一下写这一集的吐槽`;
  if (file.note && file.note.playedAt) row.classList.add('is-watched');

  const no = document.createElement('span');
  no.className = 'ep-no';
  no.textContent = fmtEpisode(file);

  const info = document.createElement('div');
  info.className = 'ep-info';
  const name = document.createElement('div');
  name.className = 'ep-name';
  name.textContent = file.name;
  const meta = document.createElement('div');
  meta.className = 'ep-meta';
  meta.textContent = `${fmtSize(file.size)} · 靠${file.matchedBy}认出`;
  info.append(name, meta);

  const preview = document.createElement('div');
  preview.className = 'ep-note-preview';
  info.appendChild(preview);

  const noteBtn = document.createElement('button');
  noteBtn.type = 'button';
  noteBtn.className = 'ep-note-btn';
  noteBtn.textContent = '✎';
  noteBtn.title = '给这一集写吐槽';

  row.append(no, info, noteBtn);
  row.dataset.key = file.path;

  const toggle = () => toggleNoteEditor(item, file, entry, noteBtn);
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      toggle();
    }
  });
  noteBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggle();
  });

  item.append(row);
  paintNotePreview(preview, file.note);
  return item;
}

/** 抽屉里那条斜体小字：已看过 / 吐槽摘要 */
function paintNotePreview(el, note) {
  if (!el) return;
  el.textContent = '';
  el.className = 'ep-note-preview';
  if (!note) return;
  if (note.text) {
    el.textContent = note.text.replace(/\s+/g, ' ').slice(0, 60);
    el.classList.add('has-text');
  } else if (note.playedAt) {
    el.textContent = '已看过';
  }
}

/** 展开 / 收起某一集的吐槽编辑器 */
function toggleNoteEditor(item, file, entry, noteBtn) {
  const exist = item.querySelector('.ep-note');
  if (exist) {
    exist.remove();
    noteBtn.classList.remove('is-active');
    return;
  }
  noteBtn.classList.add('is-active');
  item.appendChild(buildNoteEditor(file, entry, item, noteBtn));
}

function buildNoteEditor(file, entry, item, noteBtn) {
  const box = document.createElement('div');
  box.className = 'ep-note';

  let rating = file.note ? file.note.rating || 0 : 0;

  const stars = document.createElement('div');
  stars.className = 'ep-stars';
  const starBtns = [];
  for (let i = 1; i <= 5; i += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    star.textContent = '★';
    star.title = `${i} 星`;
    star.dataset.value = String(i);
    star.addEventListener('click', () => {
      rating = rating === i ? 0 : i;
      paintStars();
    });
    starBtns.push(star);
    stars.appendChild(star);
  }
  const starLabel = document.createElement('span');
  starLabel.className = 'ep-stars-label';
  stars.appendChild(starLabel);

  function paintStars() {
    for (const s of starBtns) s.classList.toggle('is-on', Number(s.dataset.value) <= rating);
    starLabel.textContent = rating ? `${rating} 星` : '没打分';
  }
  paintStars();

  const text = document.createElement('textarea');
  text.className = 'ep-note-text';
  text.rows = 3;
  text.maxLength = 2000;
  text.placeholder = '这一集怎么样？剧情、作画、演出、声优 —— 随便写。Ctrl+Enter 保存。';
  text.value = file.note ? file.note.text || '' : '';

  const foot = document.createElement('div');
  foot.className = 'ep-note-foot';

  const hint = document.createElement('span');
  hint.className = 'ep-note-hint';

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-ghost btn-small';
  del.textContent = '删除这条';
  del.disabled = !file.note;
  del.addEventListener('click', () => removeNote(file, entry, item, noteBtn));

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-primary btn-small';
  save.textContent = '保存';
  save.addEventListener('click', () => submitNote(file, entry, item, noteBtn, text, rating, save, hint));

  foot.append(hint, del, save);
  box.append(stars, text, foot);

  text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      submitNote(file, entry, item, noteBtn, text, rating, save, hint);
    }
  });

  setTimeout(() => text.focus(), 30);
  return box;
}

async function submitNote(file, entry, item, noteBtn, textEl, rating, saveBtn, hintEl) {
  saveBtn.disabled = true;
  try {
    const res = await window.api.saveNote({
      season: state.season,
      showId: file.showId || entry.id,
      showTitle: entry.title,
      episode: file.episode,
      filePath: file.path,
      text: textEl.value,
      rating,
    });
    if (!res || !res.ok) {
      hintEl.textContent = `存不了：${(res && res.error) || '未知错误'}`;
      hintEl.classList.add('is-bad');
      return;
    }
    file.note = res.note ? { ...res.note } : null;
    paintNotePreview(item.querySelector('.ep-note-preview'), file.note);
    noteBtn.classList.toggle('is-active', Boolean(file.note));
    setStatus(res.removed ? '这条吐槽清空了' : `吐槽已保存 · ${fmtEpisode(file)}`);
    toast(res.removed ? '这条吐槽清空了' : '吐槽已保存', 'ok');
    await refreshNotes();
    // 收起来，留出位置看下一次
    setTimeout(() => {
      const box = item.querySelector('.ep-note');
      if (box) {
        box.remove();
        noteBtn.classList.remove('is-active');
      }
    }, 260);
  } catch (err) {
    hintEl.textContent = `存不了：${err && err.message ? err.message : err}`;
    hintEl.classList.add('is-bad');
  } finally {
    saveBtn.disabled = false;
  }
}

async function removeNote(file, entry, item, noteBtn) {
  if (!file.note || !file.noteKey) return;
  const yes = window.confirm(`删掉 ${fmtEpisode(file)} 这集的吐槽？删了就找不回来了。`);
  if (!yes) return;
  try {
    const res = await window.api.deleteNote({ key: file.noteKey });
    if (!res || !res.ok) {
      setStatus(`删不掉：${(res && res.error) || '未知错误'}`);
      return;
    }
    file.note = null;
    paintNotePreview(item.querySelector('.ep-note-preview'), null);
    noteBtn.classList.remove('is-active');
    const box = item.querySelector('.ep-note');
    if (box) box.remove();
    setStatus(`已清空 ${fmtEpisode(file)} 的吐槽`);
    toast('吐槽已删除', 'ok');
    await refreshNotes();
  } catch (err) {
    setStatus(`删不掉：${err && err.message ? err.message : err}`);
  }
}

/** 点一集（卡片上的集数按钮，或抽屉里的行）→ 交给默认播放器 */
async function playEpisode(file, el) {
  if (state.playing === file.path) return;
  state.playing = file.path;
  el.classList.add('is-loading');
  try {
    const res = await window.api.playFile({ path: file.path });
    if (!res || !res.ok) {
      const msg = (res && res.error) || '未知错误';
      setStatus(`打不开这一集：${msg}`);
      toast(`打不开这一集：${msg}`, 'bad');
      el.classList.add('is-error');
      setTimeout(() => el.classList.remove('is-error'), 2400);
      return;
    }
    state.lastPlayed = file.path;
    for (const other of document.querySelectorAll('.is-last')) other.classList.remove('is-last');
    el.classList.add('is-last');
    if (!res.dry) {
      file.note = {
        ...(file.note || {}),
        playedAt: Date.now(),
        text: file.note ? file.note.text || '' : '',
        rating: file.note ? file.note.rating || 0 : 0,
      };
      // 同一集可能同时出现在卡片集数条和抽屉里，两处一起变绿
      for (const other of document.querySelectorAll('.ep-chip, .ep-row')) {
        if (other.dataset.path === file.path || other.dataset.key === file.path) {
          other.classList.add('is-watched');
        }
      }
      el.classList.add('is-watched');
      paintNotePreview(el.querySelector ? el.querySelector('.ep-note-preview') : null, file.note);
      await refreshNotes();
    }
    setStatus(`已交给默认播放器：${file.name}${res.dry ? '（试运行，没真打开）' : ''}`);
    const shortName = file.name.length > 30 ? `${file.name.slice(0, 30)}…` : file.name;
    toast(res.dry ? `试运行：本应打开 ${shortName}` : `已交给默认播放器：${shortName}`, 'ok');
  } catch (err) {
    setStatus(`打不开这一集：${err && err.message ? err.message : err}`);
    toast(`打不开这一集：${err && err.message ? err.message : err}`, 'bad');
  } finally {
    state.playing = null;
    el.classList.remove('is-loading');
  }
}

function closeDrawer() {
  $('#drawer').hidden = true;
}

// ---------------------------------------------------------------- 吐槽记录

/** 重新拉一遍本季吐槽，同时刷新卡片上的「吐槽 N」角标 */
async function refreshNotes() {
  try {
    const res = await window.api.listNotes({ season: state.season });
    state.noteList = res && res.ok ? res.notes : [];
  } catch {
    state.noteList = [];
  }
  const counts = new Map();
  for (const n of state.noteList) {
    if (!n.showId || !String(n.text || '').trim()) continue;
    counts.set(n.showId, (counts.get(n.showId) || 0) + 1);
  }
  state.noteCounts = counts;
  for (const entry of state.entries) entry.noteCount = counts.get(entry.id) || 0;
  for (const card of document.querySelectorAll('.card')) {
    const n = counts.get(card.dataset.id) || 0;
    const badge = card.querySelector('.note-badge');
    if (n && badge) badge.textContent = `✎ ${n}`;
    else if (n && !badge) paintNoteBadge(card, n);
    else if (!n && badge) badge.remove();
  }
  if (state.filter === 'notes') renderNotes();
}

/** 卡片上的吐槽角标（有吐槽才加） */
function paintNoteBadge(card, n) {
  const body = card.querySelector('.card-body');
  if (!body) return;
  const chip = document.createElement('span');
  chip.className = 'note-badge';
  chip.textContent = `✎ ${n}`;
  chip.title = `写了 ${n} 条吐槽`;
  body.appendChild(chip);
}

/** 「吐槽记录」页：本季写过的所有吐槽，按最近更新排 */
function renderNotes() {
  const grid = $('#grid');
  const pending = $('#pending');
  const notesView = $('#notes');
  grid.hidden = true;
  pending.hidden = true;
  notesView.hidden = false;
  notesView.innerHTML = '';
  $('#day-nav').hidden = true;
  $('#guide').hidden = true;

  const items = state.noteList.filter((n) => String(n.text || '').trim() || n.rating);
  updateCount();

  if (!items.length) {
    showState({
      emoji: '💬',
      title: '还没有吐槽',
      desc: '回「本季新番」，点卡片封面下那一排集数右边的 ✎，就能写这一集的想法。',
    });
    return;
  }
  hideState();

  const frag = document.createDocumentFragment();
  for (const note of items) {
    const row = document.createElement('article');
    row.className = 'note-row';

    const head = document.createElement('div');
    head.className = 'note-head';

    const ep = document.createElement('span');
    ep.className = 'note-ep';
    ep.textContent = note.episode == null ? '未分集' : `EP ${String(note.episode).padStart(2, '0')}`;

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'note-title';
    title.textContent = note.showTitle || '（未命名）';
    title.title = '打开这部动画的集数列表，改这一集的吐槽';
    title.addEventListener('click', () => {
      const entry = state.entries.find((e) => e.id === note.showId);
      if (entry && episodesOf(entry.id).length) openDrawer(entry);
      else setStatus('这一部本地还没有认出视频文件');
    });

    const stars = document.createElement('span');
    stars.className = 'note-stars';
    stars.textContent = note.rating ? '★'.repeat(note.rating) : '';

    const when = document.createElement('span');
    when.className = 'note-when';
    when.textContent = fmtTime(new Date(note.updatedAt || note.createdAt).toISOString());

    // 每条都能单独删掉（删了就是删了，问一句再动手）
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'note-del';
    del.textContent = '删除';
    del.title = '删掉这条吐槽';
    del.addEventListener('click', async () => {
      const label = `${note.showTitle || '这部'} ${note.episode == null ? '' : `第 ${note.episode} 集`}`.trim();
      if (!window.confirm(`删掉「${label}」的吐槽？删了就找不回来了。`)) return;
      del.disabled = true;
      try {
        const res = await window.api.deleteNote({ key: note.key });
        if (!res || !res.ok) {
          setStatus(`删不掉：${(res && res.error) || '未知错误'}`);
          del.disabled = false;
          return;
        }
        setStatus(`已删除「${label}」的吐槽`);
        toast('吐槽已删除', 'ok');
        await refreshNotes();
        renderNotes();
      } catch (err) {
        setStatus(`删不掉：${err && err.message ? err.message : err}`);
        del.disabled = false;
      }
    });

    head.append(ep, title, stars, when, del);

    const text = document.createElement('p');
    text.className = 'note-text';
    text.textContent = note.text || '（只打了分，没写字）';

    row.append(head, text);
    frag.appendChild(row);
  }
  notesView.appendChild(frag);
}

// ---------------------------------------------------------------- 扫目录

async function scanNow(root) {
  if (state.scanning) return;
  state.scanning = true;
  const btn = $('#btn-scan');
  const live = $('#scan-live');
  btn.disabled = true;
  btn.textContent = '扫描中…';
  live.textContent = '扫描中 · 已找到 0 个视频';
  live.hidden = false;
  setStatus(`正在扫 ${root} …`);

  try {
    const res = await window.api.runScan({ season: state.season, root });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : '主进程没应答');
    state.scan = res.scan;
    renderScanInfo();
    if (state.filter === 'pending') renderPending();
    else renderCards();
    markGuideDone();
    const s = res.scan;
    setStatus(
      `${s.files} 个视频 · 认出 ${s.matched.length} 集 · 待确认 ${s.unmatched.length} 个` +
        (s.truncated ? ' · ⚠ 文件太多只扫了一部分' : '') +
        ` · 耗时 ${(s.tookMs / 1000).toFixed(1)} 秒`
    );
    toast(
      `扫完啦：${s.files} 个视频，认出 ${s.matched.length} 集` +
        (s.unmatched.length ? `，${s.unmatched.length} 个待确认` : ''),
      'ok'
    );
  } catch (err) {
    setStatus(`扫描失败：${err && err.message ? err.message : err}`);
    toast(`扫描失败：${err && err.message ? err.message : err}`, 'bad');
  } finally {
    state.scanning = false;
    btn.disabled = false;
    btn.textContent = state.scan ? '重新扫描' : '选择资源目录';
    live.hidden = true;
  }
}

async function pickAndScan() {
  const res = await window.api.pickScanDir();
  if (!res || !res.ok || res.canceled || !res.dir) return;
  await scanNow(res.dir);
}

/** 清空识别记忆：之前手动指派记下的文件夹名全忘掉，然后重扫一遍 */
async function forgetAliases() {
  const ok = window.confirm('清空本季的识别记忆？\n\n只会忘掉「手动指派」时记住的文件夹名，不会动你的勾选记录和吐槽。');
  if (!ok) return;
  const res = await window.api.forgetAliases();
  if (!res || !res.ok) {
    setStatus(res && res.error ? `清空失败：${res.error}` : '清空失败');
    return;
  }
  setStatus(`已清空 ${res.removed} 条识别记忆`);
  toast(`已清空 ${res.removed} 条识别记忆`, 'ok');
  if (state.scan && state.scan.root) await scanNow(state.scan.root);
}

/** 把「扫到啥」的信息贴到界面上：路径、按钮文案、待确认数 */
function renderScanInfo() {
  const scan = state.scan;
  const pathEl = $('#scan-path');
  const btn = $('#btn-scan');
  if (scan && scan.root) {
    pathEl.textContent = scan.root;
    pathEl.title = scan.root;
    btn.textContent = '重新扫描';
  } else {
    pathEl.textContent = '还没选资源目录';
    pathEl.title = '';
    btn.textContent = '选择资源目录';
  }
  const pending = scan && Array.isArray(scan.unmatched) ? scan.unmatched.length : 0;
  $('#pending-count').textContent = String(pending);
}

async function loadScanState() {
  try {
    const res = await window.api.getScanState();
    state.scan = res && res.scan ? res.scan : null;
  } catch {
    state.scan = null;
  }
  renderScanInfo();
  if (state.entries.length) {
    if (state.filter === 'pending') renderPending();
    else renderCards();
  }
}

// ---------------------------------------------------------------- 待确认

function renderPending() {
  const grid = $('#grid');
  const box = $('#pending');
  grid.hidden = true;
  grid.innerHTML = '';
  $('#notes').hidden = true;
  $('#day-nav').hidden = true;
  $('#guide').hidden = true;

  const list = (state.scan && state.scan.unmatched) || [];
  box.innerHTML = '';

  if (!list.length) {
    box.hidden = true;
    if (state.scan) {
      showState({
        emoji: '🎉',
        title: '没有待确认的文件',
        desc: '本地扫到的视频都对上号了。以后加新文件，点「重新扫描」就行。',
      });
    } else {
      showState({
        emoji: '📂',
        title: '还没选资源目录',
        desc: '点右上角「选择资源目录」，把你放动画的文件夹告诉我，我来对照这季的番剧表认集数。',
      });
    }
    updateCount();
    return;
  }

  hideState();
  box.hidden = false;

  const title = document.createElement('div');
  title.className = 'pending-title';
  title.textContent = `这 ${list.length} 个文件没认出来是谁，你指一下路`;
  box.appendChild(title);

  for (const f of list.slice(0, 300)) {
    box.appendChild(buildPendingRow(f));
  }

  if (list.length > 300) {
    const more = document.createElement('p');
    more.className = 'pending-more';
    more.textContent = `还有 ${list.length - 300} 个没显示，先手动处理前面这些。`;
    box.appendChild(more);
  }

  updateCount();
}

function buildPendingRow(file) {
  const row = document.createElement('div');
  row.className = 'pend-row';

  const main = document.createElement('div');
  main.className = 'pend-main';
  const name = document.createElement('div');
  name.className = 'pend-name';
  name.textContent = file.name;
  name.title = file.path;
  const sub = document.createElement('div');
  sub.className = 'pend-sub';
  sub.textContent = `${fmtSize(file.size)} · ${file.dir}${file.showTitle ? ` · 像是「${file.showTitle}」` : ''}`;
  main.append(name, sub);

  const select = document.createElement('select');
  select.className = 'pend-show';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '选一部…';
  select.appendChild(placeholder);
  for (const entry of state.entries) {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = entry.title;
    if (file.showId === entry.id) opt.selected = true;
    select.appendChild(opt);
  }

  const epInput = document.createElement('input');
  epInput.className = 'pend-ep';
  epInput.type = 'number';
  epInput.min = '0';
  epInput.max = '2000';
  epInput.placeholder = '集数';
  if (file.episode !== null && file.episode !== undefined) epInput.value = String(file.episode);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-small';
  btn.textContent = '指派';
  btn.addEventListener('click', () => assignPending(file, select, epInput, btn));

  row.append(main, select, epInput, btn);
  return row;
}

async function assignPending(file, select, epInput, btn) {
  const showId = select.value;
  const entry = state.entries.find((e) => e.id === showId);
  if (!entry) {
    setStatus('先给它选一部动画');
    return;
  }
  const episodeText = epInput.value.trim();
  if (episodeText === '') {
    setStatus('再填个集数（不知道就填 1）');
    return;
  }

  btn.disabled = true;
  try {
    const res = await window.api.assignFile({
      season: state.season,
      path: file.path,
      showId,
      showTitle: entry.title,
      episode: Number(episodeText),
    });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : '主进程没应答');
    state.scan = res.scan;
    renderScanInfo();
    renderPending();
    setStatus(`把「${file.name}」记到了「${entry.title}」第 ${episodeText} 集，文件夹名也记住了`);
    toast('指派好了', 'ok');
  } catch (err) {
    btn.disabled = false;
    setStatus(`指派失败：${err && err.message ? err.message : err}`);
  }
}

/** 当前过滤条件下该显示的条目 */
function visibleEntries() {
  const kw = state.keyword.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (state.filter === 'owned' && !e.owned) return false;
    if (state.filter === 'local' && !episodesOf(e.id).length) return false;
    return matchesKeyword(e, kw);
  });
}

/** 周几的自然顺序；「网络放送 & 其他」这类排在最后 */
const DAY_ORDER = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function sectionRank(section) {
  const s = String(section || '');
  const i = DAY_ORDER.findIndex((d) => s.startsWith(d));
  return i === -1 ? 99 : i;
}

/** 今天周几，用来在对应分组上打「今天」的标记 */
function todaySection() {
  const i = new Date().getDay(); // 0 = 周日
  return DAY_ORDER[(i + 6) % 7];
}

// ---------------------------------------------------------------- 新手上路

const GUIDE_KEY = 'animelocal.guide.done';

function maybeShowGuide() {
  const guide = $('#guide');
  const hasScan = Boolean(state.scan && state.scan.root);
  if (hasScan || localStorage.getItem(GUIDE_KEY) === '1') {
    guide.hidden = true;
    return;
  }
  guide.hidden = state.filter === 'pending' || state.filter === 'notes';
}

function markGuideDone() {
  localStorage.setItem(GUIDE_KEY, '1');
  $('#guide').hidden = true;
}

// ---------------------------------------------------------------- 周几跳转条

/** 滚动到某个周几分组（留出吸顶跳转条的高度） */
function jumpToDay(section) {
  const target = [...document.querySelectorAll('.day-section')].find(
    (el) => el.dataset.section === section
  );
  if (!target) return;
  const scroller = $('.content');
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = scroller.scrollTop + (targetRect.top - scrollerRect.top) - 46;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  setActiveDay(section);
}

function setActiveDay(section) {
  for (const btn of document.querySelectorAll('.day-pill')) {
    btn.classList.toggle('is-active', btn.dataset.section === section);
  }
}

/** 滚到哪一组就高亮哪一个；没有分组时整个条藏起来 */
function syncActiveDay() {
  const sections = [...document.querySelectorAll('.day-section')];
  if (!sections.length) return;
  const line = $('.content').getBoundingClientRect().top + 60;
  let current = sections[0];
  for (const el of sections) {
    if (el.getBoundingClientRect().top <= line) current = el;
  }
  setActiveDay(current.dataset.section);
}

function renderDayNav(ordered) {
  const nav = $('#day-nav');
  nav.innerHTML = '';
  if (!ordered.length || state.filter === 'pending' || state.filter === 'notes') {
    nav.hidden = true;
    return;
  }
  const today = todaySection();
  for (const [section, items] of ordered) {
    const m = /^(周[一二三四五六日])/.exec(section);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-pill';
    btn.dataset.section = section;
    if (section.startsWith(today)) btn.classList.add('is-today');
    const label = document.createElement('span');
    label.textContent = m ? m[1] : '其他';
    const num = document.createElement('b');
    num.textContent = String(items.length);
    btn.append(label, num);
    btn.addEventListener('click', () => jumpToDay(section));
    nav.appendChild(btn);
  }
  nav.hidden = false;
  requestAnimationFrame(syncActiveDay);
}

function updateCount() {
  if (state.filter === 'pending') {
    const n = state.scan && Array.isArray(state.scan.unmatched) ? state.scan.unmatched.length : 0;
    $('#count').textContent = n ? `待确认 ${n} 个文件` : '没有待确认的文件';
    return;
  }
  if (state.filter === 'notes') {
    const written = state.noteList.filter((n) => String(n.text || '').trim() || n.rating).length;
    $('#count').textContent = written ? `吐槽 ${written} 条` : '还没有吐槽';
    return;
  }
  const total = state.entries.length;
  const owned = state.entries.filter((e) => e.owned).length;
  state.ownedCount = owned;
  const shown = visibleEntries().length;
  const kw = state.keyword.trim();
  const localCount = state.entries.filter((e) => episodesOf(e.id).length).length;

  let text;
  if (state.filter === 'owned') {
    text = owned ? `我有的 ${owned} 部` : '还没标记任何一部';
  } else if (state.filter === 'local') {
    text = localCount ? `本地有 ${localCount} 部` : '还没扫到任何一集';
  } else {
    text = `共 ${total} 部 · 本地有 ${localCount} 部 · 已标记 ${owned} 部`;
  }
  if (kw && state.filter !== 'owned' && state.filter !== 'local') text += ` · 搜出 ${shown} 部`;
  if (kw && state.filter !== 'all') text += ` · 搜出 ${shown} 部`;
  $('#count').textContent = text;
}

function renderCards() {
  if (state.filter === 'pending') {
    renderPending();
    return;
  }
  if (state.filter === 'notes') {
    renderNotes();
    return;
  }

  const kw = state.keyword.trim().toLowerCase();
  const list = visibleEntries();

  const grid = $('#grid');
  $('#pending').hidden = true;
  $('#notes').hidden = true;
  grid.innerHTML = '';

  // 按周几分组：周一到周日在前面，网络放送/其他排最后
  const groups = new Map();
  for (const entry of list) {
    const key = entry.section || '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const ordered = [...groups.entries()].sort((a, b) => sectionRank(a[0]) - sectionRank(b[0]));

  const today = todaySection();
  const frag = document.createDocumentFragment();
  for (const [section, items] of ordered) {
    const block = document.createElement('section');
    block.className = 'day-section';
    block.dataset.section = section;

    // 「周一 (月)」拆成「周一」+ 淡色的「(月)」
    const m = /^(周[一二三四五六日])\s*(.*)$/.exec(section);
    const head = document.createElement('h2');
    head.className = 'day-head';
    const main = document.createElement('span');
    main.textContent = m ? m[1] : section;
    head.appendChild(main);
    if (m && m[2]) {
      const cn = document.createElement('span');
      cn.className = 'day-cn';
      cn.textContent = m[2];
      head.appendChild(cn);
    }
    if (section.startsWith(today)) {
      const badge = document.createElement('span');
      badge.className = 'day-today';
      badge.textContent = '今天';
      head.appendChild(badge);
    }
    const count = document.createElement('span');
    count.className = 'day-count';
    count.textContent = `${items.length} 部`;
    head.appendChild(count);

    const dayGrid = document.createElement('div');
    dayGrid.className = 'day-grid';
    for (const entry of items) dayGrid.appendChild(buildCard(entry));

    block.append(head, dayGrid);
    frag.appendChild(block);
  }

  grid.appendChild(frag);
  grid.hidden = false;

  renderDayNav(ordered);
  updateCount();

  if (!list.length) {
    if (state.filter === 'owned' && !kw) {
      showState({
        emoji: '📚',
        title: '还没标记任何一部',
        desc: '回「全部」页面，点卡片封面右上角的圆圈，把本地真有资源的动画标出来。标记会立刻存盘。',
      });
    } else if (state.filter === 'local' && !kw) {
      showState({
        emoji: '📂',
        title: '本地还没扫到动画',
        desc: '点右上角「选择资源目录」，把放动画的文件夹告诉我；扫完之后，卡片封面下会直接出现可以点的集数。',
      });
    } else {
      showState({
        emoji: '🔍',
        title: '没有匹配的动画',
        desc: kw
          ? `「${state.keyword}」没搜到。中文名、日文原名、罗马音都能搜，比如 goblin / 転生`
          : '这部季度页好像是空的',
      });
    }
  } else {
    hideState();
  }
}

// ---------------------------------------------------------------- 数据

async function loadCatalog(force = false) {
  if (state.loading) return;
  state.loading = true;
  const btn = $('#refresh');
  btn.disabled = true;
  btn.textContent = '抓取中…';
  hideState();
  if (!state.entries.length) {
    renderSkeleton(12);
    $('#grid').hidden = true;
  }

  try {
    const data = await window.api.loadSeason({ season: state.season, force });
    state.entries = data.entries;
    state.label = data.label || '';
    state.ownedCount = data.ownedCount || 0;
    renderCards();
    const covers = data.entries.filter((e) => e.coverUrl).length;
    setStatus(
      `${data.entries.length} 部 · 封面 ${covers} 张 · 更新于 ${fmtTime(data.fetchedAt)}` +
        (data.fromCache ? '（缓存）' : '') +
        (data.stale ? ' ⚠ 联网失败，用的是旧数据' : '')
    );
    btn.textContent = '刷新数据';
  } catch (err) {
    $('#grid').hidden = true;
    hideSkeleton();
    showState({
      emoji: '📡',
      title: '拿不到这季的番剧表',
      desc: `${err && err.message ? err.message : err}｜检查一下网络，或者过会儿再试`,
      retry: true,
    });
    $('#count').textContent = '读取失败';
    setStatus('数据源 yuc.wiki 不可达');
    btn.textContent = '刷新数据';
  } finally {
    state.loading = false;
    btn.disabled = false;
    hideSkeleton();
    // 给截图模式一个「画完了」的信号
    document.body.dataset.ready = '1';
  }
}

async function wireAppInfo() {
  try {
    const info = await window.api.getAppInfo();
    setIpcState('IPC 已连通', 'ok');
    $('#foot-version').textContent = `v${info.appVersion}`;
    $('#legend').textContent = `Electron ${info.electron} · 数据来自 yuc.wiki · 缓存 24 小时`;
  } catch (err) {
    setIpcState('IPC 失败', 'bad');
    setStatus(`主进程没应答：${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------- 交互

function bindEvents() {
  $('#search').addEventListener('input', (ev) => {
    state.keyword = ev.target.value;
    renderCards();
  });

  $('#refresh').addEventListener('click', () => loadCatalog(true));
  $('#state-retry').addEventListener('click', () => loadCatalog(true));

  // 选目录 + 扫描
  $('#btn-scan').addEventListener('click', pickAndScan);
  $('#btn-forget').addEventListener('click', forgetAliases);

  // 集数抽屉
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-mask').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeDrawer();
  });

  // 扫目录时主进程会主动推进度过来
  window.api.onScanProgress(({ found, dir }) => {
    if (!state.scanning) return;
    $('#scan-live').textContent = `扫描中 · 已找到 ${found} 个视频`;
    setStatus(`正在扫… 已找到 ${found} 个视频（${dir}）`);
  });

  // 引导卡片：关掉就记住，别再弹
  $('#guide-close').addEventListener('click', markGuideDone);

  // 滚动时高亮当前周几
  let scrollTick = 0;
  $('.content').addEventListener(
    'scroll',
    () => {
      if (scrollTick) return;
      scrollTick = requestAnimationFrame(() => {
        scrollTick = 0;
        if (!$('#day-nav').hidden) syncActiveDay();
      });
    },
    { passive: true }
  );

  // 「全部 / 我有的」分段筛选
  for (const btn of document.querySelectorAll('.seg-btn')) {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  }

  // 左侧导航：本季新番 = 全部，我的收藏 = 只看我标记过的
  for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => {
      if (item.dataset.pending !== undefined) return; // 后面阶段的页面还没做
      for (const el of document.querySelectorAll('.nav-item')) el.classList.remove('is-active');
      item.classList.add('is-active');
      if (item.dataset.view) setFilter(item.dataset.view);
    });
  }
}

/** 切「全部 / 我有的 / 待确认 / 吐槽记录」，同时把侧栏和分段按钮的高亮对齐 */
function setFilter(filter) {
  state.filter = ['owned', 'local', 'pending', 'notes'].includes(filter) ? filter : 'all';
  // 「吐槽记录」是整季的列表，卡片那套筛选按钮在这儿没意义
  const seg = document.querySelector('.seg');
  if (seg) seg.hidden = state.filter === 'notes';
  for (const btn of document.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('is-active', btn.dataset.filter === state.filter);
  }
  for (const item of document.querySelectorAll('.nav-item')) {
    if (!item.dataset.view) continue;
    item.classList.toggle('is-active', item.dataset.view === state.filter);
  }
  if (state.entries.length) renderCards();
}

// ---------------------------------------------------------------- 启动

async function boot() {
  const s = currentSeason();
  state.season = s.key;
  $('#season-label').textContent = `${s.year} 年 ${s.month} 月新番 · ${s.label}`;
  renderSkeleton(12);
  bindEvents();
  await wireAppInfo();
  await loadCatalog(false);
  await refreshNotes();
  await loadScanState();
  maybeShowGuide();
}

boot();

// 调试 / 截图模式用：把内部状态和几个动作挂到 window 上，
// 这样 `node scripts/launch.js --shot "--eval=window.__app.scanNow('D:\\anime')"` 就能驱动界面。
window.__app = { state, renderCards, renderPending, renderScanInfo, setFilter, scanNow, openDrawer };

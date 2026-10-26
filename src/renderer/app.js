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
  filter: 'all', // all | owned | pending
  ownedCount: 0,
  loading: false,
  scan: null, // 上次扫描结果：{root, matched, unmatched, extras, scannedAt}
  scanning: false,
  playing: null, // 正在打开的那一集（防连点）
  lastPlayed: null, // 最近播过的那一集路径
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
    card.innerHTML = '<div class="sk-cover"></div><div class="sk-line"></div><div class="sk-line short"></div>';
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
  title.textContent = entry.title;
  title.title = entry.title;

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

  // 本地扫到几集？扫到了就给个「N 集」的入口
  const eps = episodesOf(entry.id);
  if (eps.length) {
    card.classList.add('has-files');
    const epBadge = document.createElement('button');
    epBadge.type = 'button';
    epBadge.className = 'ep-badge';
    epBadge.textContent = `${eps.length} 集`;
    epBadge.title = `本地认出 ${eps.length} 集，点开看是哪些文件`;
    epBadge.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openDrawer(entry);
    });
    body.appendChild(epBadge);
  }

  card.append(coverBox, body);
  return card;
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
    // 在「我有的」视图里取消勾选，这张卡就该从列表里消失
    if (state.filter === 'owned' && !next) renderCards();
  } catch (err) {
    entry.owned = !next;
    paintOwn(card, btn, !next);
    updateCount();
    setStatus(`保存失败：${err && err.message ? err.message : err}`);
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

/** 某个动画 id 在本地扫到的集数 */
function episodesOf(showId) {
  if (!state.scan || !Array.isArray(state.scan.matched)) return [];
  return state.scan.matched.filter((f) => f.showId === showId);
}

function fmtEpisode(f) {
  if (f.range) return `${f.range[0]}-${f.range[1]}`;
  if (f.episode === null || f.episode === undefined) return '?';
  return String(f.episode).padStart(2, '0');
}

function openDrawer(entry) {
  const eps = episodesOf(entry.id);
  if (!eps.length) return;
  $('#drawer-title').textContent = entry.title;
  $('#drawer-sub').textContent = `${eps.length} 集 · ${eps[0].dir}`;

  const body = $('#drawer-body');
  body.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'ep-list';
  for (const f of eps) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ep-row is-playable';
    row.title = `${f.path}\n点一下就交给默认播放器`;
    if (state.lastPlayed === f.path) row.classList.add('is-last');

    const no = document.createElement('span');
    no.className = 'ep-no';
    no.textContent = fmtEpisode(f);

    const info = document.createElement('div');
    info.className = 'ep-info';
    const name = document.createElement('div');
    name.className = 'ep-name';
    name.textContent = f.name;
    const meta = document.createElement('div');
    meta.className = 'ep-meta';
    meta.textContent = `${fmtSize(f.size)} · 靠${f.matchedBy}认出`;
    info.append(name, meta);

    const play = document.createElement('span');
    play.className = 'ep-play';
    play.textContent = '▶';

    row.append(no, info, play);
    row.addEventListener('click', () => playEpisode(f, row));
    list.appendChild(row);
  }
  body.appendChild(list);

  const tip = document.createElement('p');
  tip.className = 'drawer-tip';
  tip.textContent = '点任意一集，直接交给系统默认播放器打开 —— 就是双击视频文件时用的那个。';
  body.appendChild(tip);

  $('#drawer').hidden = false;
}

/** 点一集 → 交给默认播放器 */
async function playEpisode(file, row) {
  if (state.playing === file.path) return;
  state.playing = file.path;
  row.classList.add('is-loading');
  try {
    const res = await window.api.playFile({ path: file.path });
    if (!res || !res.ok) {
      const msg = (res && res.error) || '未知错误';
      setStatus(`打不开这一集：${msg}`);
      row.classList.add('is-error');
      setTimeout(() => row.classList.remove('is-error'), 2400);
      return;
    }
    state.lastPlayed = file.path;
    for (const el of document.querySelectorAll('.ep-row.is-last')) el.classList.remove('is-last');
    row.classList.add('is-last');
    setStatus(`已交给默认播放器：${file.name}${res.dry ? '（试运行，没真打开）' : ''}`);
  } catch (err) {
    setStatus(`打不开这一集：${err && err.message ? err.message : err}`);
  } finally {
    state.playing = null;
    row.classList.remove('is-loading');
  }
}

function closeDrawer() {
  $('#drawer').hidden = true;
}

// ---------------------------------------------------------------- 扫目录

async function scanNow(root) {
  if (state.scanning) return;
  state.scanning = true;
  const btn = $('#btn-scan');
  btn.disabled = true;
  btn.textContent = '扫描中…';
  setStatus(`正在扫 ${root} …`);

  try {
    const res = await window.api.runScan({ season: state.season, root });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : '主进程没应答');
    state.scan = res.scan;
    renderScanInfo();
    if (state.filter === 'pending') renderPending();
    else renderCards();
    const s = res.scan;
    setStatus(
      `${s.files} 个视频 · 认出 ${s.matched.length} 集 · 待确认 ${s.unmatched.length} 个` +
        (s.truncated ? ' · ⚠ 文件太多只扫了一部分' : '') +
        ` · 耗时 ${(s.tookMs / 1000).toFixed(1)} 秒`
    );
  } catch (err) {
    setStatus(`扫描失败：${err && err.message ? err.message : err}`);
  } finally {
    state.scanning = false;
    btn.disabled = false;
    btn.textContent = state.scan ? '重新扫描' : '选择资源目录';
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
  } catch (err) {
    btn.disabled = false;
    setStatus(`指派失败：${err && err.message ? err.message : err}`);
  }
}

/** 当前过滤条件下该显示的条目 */
function visibleEntries() {  const kw = state.keyword.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (state.filter === 'owned' && !e.owned) return false;
    if (!kw) return true;
    return (
      e.title.toLowerCase().includes(kw) || (e.section || '').toLowerCase().includes(kw)
    );
  });
}

function updateCount() {
  if (state.filter === 'pending') {
    const n = state.scan && Array.isArray(state.scan.unmatched) ? state.scan.unmatched.length : 0;
    $('#count').textContent = n ? `待确认 ${n} 个文件` : '没有待确认的文件';
    return;
  }
  const total = state.entries.length;
  const owned = state.entries.filter((e) => e.owned).length;
  state.ownedCount = owned;
  const shown = visibleEntries().length;
  const kw = state.keyword.trim();

  let text;
  if (state.filter === 'owned') {
    text = owned ? `我有的 ${owned} 部` : '还没标记任何一部';
    if (kw) text += ` · 搜出 ${shown} 部`;
  } else {
    text = `共 ${total} 部 · 已标记 ${owned} 部`;
    if (kw) text += ` · 搜出 ${shown} 部`;
  }
  $('#count').textContent = text;
}

function renderCards() {
  if (state.filter === 'pending') {
    renderPending();
    return;
  }

  const kw = state.keyword.trim().toLowerCase();
  const list = visibleEntries();

  const grid = $('#grid');
  $('#pending').hidden = true;
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const entry of list) frag.appendChild(buildCard(entry));
  grid.appendChild(frag);
  grid.hidden = false;

  updateCount();

  if (!list.length) {
    if (state.filter === 'owned' && !kw) {
      showState({
        emoji: '📚',
        title: '还没标记任何一部',
        desc: '回「全部」页面，点卡片封面右上角的圆圈，把本地真有资源的动画标出来。标记会立刻存盘。',
      });
    } else {
      showState({
        emoji: '🔍',
        title: '没有匹配的动画',
        desc: kw ? `「${state.keyword}」没搜到，换个词试试` : '这部季度页好像是空的',
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
    setStatus(`正在扫… 已找到 ${found} 个视频（${dir}）`);
  });

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

/** 切「全部 / 我有的 / 待确认」，同时把侧栏和分段按钮的高亮对齐 */
function setFilter(filter) {
  state.filter = ['owned', 'pending'].includes(filter) ? filter : 'all';
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
  await loadScanState();
}

boot();

// 调试 / 截图模式用：把内部状态和几个动作挂到 window 上，
// 这样 `node scripts/launch.js --shot "--eval=window.__app.scanNow('D:\\anime')"` 就能驱动界面。
window.__app = { state, renderCards, renderPending, renderScanInfo, setFilter, scanNow, openDrawer };

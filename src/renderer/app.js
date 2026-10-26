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
  filter: 'all', // all | owned
  ownedCount: 0,
  loading: false,
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

/** 当前过滤条件下该显示的条目 */
function visibleEntries() {
  const kw = state.keyword.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (state.filter === 'owned' && !e.owned) return false;
    if (!kw) return true;
    return (
      e.title.toLowerCase().includes(kw) || (e.section || '').toLowerCase().includes(kw)
    );
  });
}

function updateCount() {
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
  const kw = state.keyword.trim().toLowerCase();
  const list = visibleEntries();

  const grid = $('#grid');
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

/** 切「全部 / 我有的」，同时把侧栏和分段按钮的高亮对齐 */
function setFilter(filter) {
  state.filter = filter === 'owned' ? 'owned' : 'all';
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
}

boot();

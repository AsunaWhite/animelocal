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

function renderCards() {
  const kw = state.keyword.trim().toLowerCase();
  const list = kw
    ? state.entries.filter(
        (e) =>
          e.title.toLowerCase().includes(kw) ||
          (e.section || '').toLowerCase().includes(kw)
      )
    : state.entries;

  const grid = $('#grid');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const entry of list) frag.appendChild(buildCard(entry));
  grid.appendChild(frag);
  grid.hidden = false;

  $('#count').textContent = kw
    ? `筛出 ${list.length} 部（共 ${state.entries.length} 部）`
    : `共 ${state.entries.length} 部`;

  if (!list.length) {
    showState({
      emoji: '🔍',
      title: '没有匹配的动画',
      desc: kw ? `「${state.keyword}」没搜到，换个词试试` : '这部季度页好像是空的',
    });
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

  for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => {
      if (item.dataset.pending !== undefined) return; // 后面阶段的页面还没做
      for (const el of document.querySelectorAll('.nav-item')) el.classList.remove('is-active');
      item.classList.add('is-active');
    });
  }
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

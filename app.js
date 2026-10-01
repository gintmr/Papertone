/* Papertone · 播放器逻辑
   数据源：data/papers.json 与 data/<id>/episode.json
   用相对路径，本地服务和 GitHub Pages 子路径部署都能直接用 */

const DATA_BASE = 'data';
const PROGRESS_KEY = 'podcast-progress';
const THEME_KEY = 'podcast-theme';
const SERVICE_KEY = 'podcast-service';
const PLAYMODE_KEY = 'podcast-playmode';

/* 放完一集之后干什么。
   in-order 按列表顺序往下走（走到末尾回到第一集）；
   repeat-one 单集循环；shuffle 随机挑下一集；
   stop 是以前的行为，放完就停。 */
const PLAYMODE_LABEL = {
  'in-order': 'In order',
  'repeat-one': 'Repeat one',
  shuffle: 'Shuffle',
  stop: 'Stop at end',
};
const PLAYMODE_ICON = {
  'in-order': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.2h9.6M4 12h9.6M4 16.8h6"/><path d="M16.2 14.4v5.2l5.2-2.6z" fill="currentColor" stroke="none"/></svg>',
  'repeat-one': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.6 2.9 19.8 6l-3.2 3.1"/><path d="M4 11.4V9.6A3.6 3.6 0 0 1 7.6 6h12.2"/><path d="M7.4 21.1 4.2 18l3.2-3.1"/><path d="M20 12.6v1.8a3.6 3.6 0 0 1-3.6 3.6H4.2"/><path d="M11.1 13.9 12.9 12.7v4.9" stroke-width="1.9"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.4 3.2 19.8 6.4l-3.4 3.2"/><path d="M3.8 6.4h3.4c1.5 0 2.9.8 3.7 2.1l4 6.6c.8 1.3 2.2 2.1 3.7 2.1h1.2"/><path d="M16.4 14.2 19.8 17.4l-3.4 3.2"/><path d="M3.8 17.4h3.4c1.1 0 2.1-.4 2.9-1.1"/><path d="M13.9 8.5c.8-1.3 2.2-2.1 3.7-2.1h2.2"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5.4 6.6v10.8c0 .9 1.05 1.45 1.8.9l6.6-5.4a1.05 1.05 0 0 0 0-1.7L7.2 5.7c-.75-.55-1.8 0-1.8.9z" fill="currentColor" stroke="none"/><path d="M17.8 6.8v10.4"/></svg>',
};

/* ── 本机存储（IndexedDB）──────────────────────────────
   论文库可以存在访问者自己的浏览器里，而不是随站点发布：
     好处一：仓库不用塞音频，绕开 GitHub Pages 的 1GB 上限
     好处二：音频不对外分发，只留在每一台自己的设备上
   存两类东西：
     episodes  单集元数据 + 句级时间轴 + 中文稿
     blobs     音频与封面，键是 "<id>:audio" / "<id>:cover"
   ────────────────────────────────────────────────────── */
const DB_NAME = 'paper-podcasts';
const DB_VER = 1;
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('episodes')) d.createObjectStore('episodes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.onerror = () => reject(tx.error);
    if (req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } else {
      tx.oncomplete = () => resolve(null);
    }
  });
}

const idbPut = (store, value, key) => idb(store, 'readwrite', (s) => s.put(value, key));
const idbGet = (store, key) => idb(store, 'readonly', (s) => s.get(key));
const idbAll = (store) => idb(store, 'readonly', (s) => s.getAll());
const idbClearAll = async () => {
  await idb('episodes', 'readwrite', (s) => s.clear());
  await idb('blobs', 'readwrite', (s) => s.clear());
};

const $ = (sel) => document.querySelector(sel);
const audio = $('#audio');
const transcriptRegion = $('.transcript-region');
const bar = $('#progress');
const miniBar = $('#mini-progress');

/* 拖动进度条时，暂停由 timeupdate 回写数值，否则会和手指抢控制权 */
let scrubbing = null;

function setBar(el, pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  el.value = String(Math.round(clamped * 10));
  el.style.setProperty('--pct', `${clamped}%`);
}

function bindScrub(el) {
  const begin = () => { scrubbing = el; };
  const end = () => { if (scrubbing === el) scrubbing = null; };
  el.addEventListener('pointerdown', begin);
  el.addEventListener('touchstart', begin, { passive: true });
  el.addEventListener('input', () => {
    begin();
    const d = audio.duration || (episode && episode.duration) || 0;
    const pct = Number(el.value) / 10;
    audio.currentTime = (pct / 100) * d;
    setBar(el, pct);
    if (el === bar) { currentProgress = pct; scheduleWave(pct / 100); }
  });
  ['change', 'pointerup', 'pointercancel', 'touchend'].forEach((ev) =>
    el.addEventListener(ev, end));
}

const MODE_LABEL = { en: 'English', both: 'Bilingual', zh: 'Chinese', dictation: 'Dictation' };

/* 图标统一用粗线条/实心简笔画，和界面其它图标同一种视觉语言 */
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8.4 4.7 19.8 12 8.4 19.3z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24">'
  + '<rect x="6.6" y="4.6" width="4" height="14.8" rx="2"/>'
  + '<rect x="13.4" y="4.6" width="4" height="14.8" rx="2"/></svg>';
let lastPaused = null;

function syncPlayIcons() {
  const paused = audio.paused;
  if (paused === lastPaused) return;
  lastPaused = paused;
  const svg = paused ? ICON_PLAY : ICON_PAUSE;
  document.querySelectorAll('.tbtn.play, .mini-play').forEach((el) => { el.innerHTML = svg; });
}

let index = [];
let episode = null;
let lines = [];
let revealed = new Set();
let autoScrollUntil = 0;
let mode = 'en';
let currentIdx = -1;
let activeFilter = { type: 'all', value: '' };
let deviceLibrary = false;   // true = 论文库来自本机 IndexedDB
let currentProgress = 0;   // 0–100，波形重绘时用

/* 定时停止：以墙钟为准，靠 timeupdate 兜底检查，
   页面切到后台、定时器被节流时也不会漏停 */
let sleepDeadline = 0;
let sleepUntilEnd = false;
let sleepTick = null;
let fading = false;

/* ── 基础工具 ────────────────────────────────────────── */
const fmt = (t) => {
  if (!isFinite(t) || t < 0) t = 0;
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 由论文 id 稳定生成的柔和渐变，离线可用 */
function coverStyle(id) {
  const h = hash(id);
  const hue = 254 + (h % 48);
  const hue2 = hue + 14 + (h % 20);
  return `background:
    radial-gradient(120% 95% at 20% 8%, hsl(${hue2} 82% 84% / .92), transparent 60%),
    radial-gradient(120% 110% at 84% 92%, hsl(${hue} 55% 56% / .88), transparent 64%),
    linear-gradient(${105 + (h % 70)}deg, hsl(${hue} 52% 70%), hsl(${hue2} 46% 48%));`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); }
  catch (e) { return {}; }
}
function saveProgress(id, time) {
  const all = loadProgress();
  all[id] = { time: Math.round(time), at: Date.now() };
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)); } catch (e) {}
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

/* ── 菜单 ───────────────────────────────────────────── */
function closeMenus(except) {
  [['#mode-menu', '#mode-btn'], ['#playmode-menu', '#playmode-btn'],
   ['#sleep-menu', '#sleep-btn'], ['#more-menu', '#more-toggle']]
    .forEach(([menuSel, btnSel]) => {
      if (menuSel === except) return;
      $(menuSel).hidden = true;
      $(btnSel).setAttribute('aria-expanded', 'false');
    });
}

function wireMenu(btnSel, menuSel) {
  $(btnSel).addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $(menuSel);
    const willOpen = menu.hidden;
    closeMenus(menuSel);
    menu.hidden = !willOpen;
    $(btnSel).setAttribute('aria-expanded', String(willOpen));
  });
}

/* ── 列表视图 ────────────────────────────────────────── */
/** 优先读本机存储；没有再去网络取（两种部署方式都能用） */
async function loadIndex() {
  let list = null;
  try {
    const local = await idbAll('episodes');
    if (local && local.length) {
      deviceLibrary = true;
      list = local.map(({ segments, ...rest }) => rest);
    }
  } catch (e) { /* 隐私模式等场景下 IndexedDB 不可用，退回网络 */ }
  if (!list) {
    const res = await fetch(`${DATA_BASE}/papers.json`, { cache: 'no-cache' });
    list = (await res.json()).episodes || [];
  }
  // 列表默认新论文在前；缺日期的垫到最后，再按 arXiv id 兜底
  index = list.sort((a, b) => (publishedTs(b) || 0) - (publishedTs(a) || 0)
    || String(b.id).localeCompare(String(a.id)));
}

/** 封面：本机存储里有 Blob 就用 objectURL，否则用网络地址。
    保持同步——渲染卡片时是逐条调用的，异步会把渲染逻辑搅乱，
    所以改成载入库之后一次性把封面 URL 建好。 */
const coverUrls = new Map();
const audioUrls = new Map();
function coverUrl(e) {
  if (!e) return null;
  if (coverUrls.has(e.id)) return coverUrls.get(e.id);
  return e.cover ? `${DATA_BASE}/${e.id}/${e.cover}` : null;
}

async function primeCoverUrls() {
  if (!deviceLibrary) return;
  for (const e of index) {
    if (coverUrls.has(e.id)) continue;
    try {
      const blob = await idbGet('blobs', `${e.id}:cover`);
      if (blob) coverUrls.set(e.id, URL.createObjectURL(blob));
    } catch (err) { /* 忽略 */ }
  }
}

function coverUrl(e) {
  return e && e.cover ? `${DATA_BASE}/${e.id}/${e.cover}` : null;
}

/** 相对时间，用于收听历史 */
function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function statusOf(e, prog) {
  const p = prog[e.id];
  if (!p) return 'new';
  return e.duration && p.time / e.duration > 0.95 ? 'done' : 'doing';
}

/* ── 论文首次公开日期 ──────────────────────────────────
   数据来自 alphaXiv 的单篇元数据接口（firstPublicationDate，
   即论文第一次公开的时间，不是最后一次改版的时间）。
   ────────────────────────────────────────────────────── */
/** 取毫秒时间戳；没有日期或格式不对都返回 null */
function publishedTs(e) {
  const raw = e && e.published;
  if (!raw) return null;
  // 只写日期的按 UTC 零点解析，避免时区把日期推前一天
  const t = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(t) ? null : t;
}

/** 距今多少个自然日（按 UTC 零点算，边界稳定） */
function daysAgo(e) {
  const t = publishedTs(e);
  if (t === null) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - t) / 86400000);
}

/** 卡片/播放器上的日期：当年只写「Sep 17」，跨年才补年份 */
function fmtDate(e) {
  const t = publishedTs(e);
  if (t === null) return '';
  const d = new Date(t);
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

function allTags() {
  const count = new Map();
  for (const e of index) for (const t of (e.topics || [])) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

function renderFilters() {
  const box = $('#filters');
  const groups = [
    { type: 'all', value: '', label: 'All' },
    { type: 'status', value: 'doing', label: 'In progress' },
    { type: 'status', value: 'done', label: 'Finished' },
    { type: 'since', value: 7, label: 'Past week' },
    { type: 'since', value: 30, label: 'Past month' },
    { type: 'since', value: 'older', label: 'Older' },
  ];

  const addSep = () => {
    const sep = document.createElement('span');
    sep.className = 'chip sep';
    box.appendChild(sep);
  };

  box.innerHTML = '';

  const add = (type, value, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (activeFilter.type === type && activeFilter.value === value ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      activeFilter = { type, value };
      renderFilters();
      renderCards($('#search').value);
    });
    box.appendChild(b);
  };

  // 先状态、再时间，中间用细线分组；标签最多，放最后
  groups.slice(0, 3).forEach((g) => add(g.type, g.value, g.label));
  addSep();
  groups.slice(3).forEach((g) => add(g.type, g.value, g.label));

  const tags = allTags();
  if (tags.length) {
    addSep();
    tags.forEach((t) => add('tag', t, t));
  }
}

/** 顶部「继续收听」：取最近一条未听完的 */
function renderContinue() {
  const box = $('#continue');
  const prog = loadProgress();
  const cands = index
    .map((e) => ({ e, p: prog[e.id] }))
    .filter((x) => x.p && statusOf(x.e, prog) === 'doing')
    .sort((a, b) => (b.p.at || 0) - (a.p.at || 0));

  if (!cands.length) { box.hidden = true; box.innerHTML = ''; return; }

  const { e, p } = cands[0];
  const pct = e.duration ? Math.round((p.time / e.duration) * 100) : 0;
  const url = coverUrl(e);
  box.hidden = false;
  box.innerHTML = `
    <button class="continue-card" type="button">
      <span class="continue-art">${url ? `<img src="${url}" alt="">` : ''}</span>
      <span class="continue-body">
        <span class="continue-kicker">Continue listening</span>
        <span class="continue-title">${escapeHtml(e.title)}</span>
        <span class="continue-bar"><i style="width:${pct}%"></i></span>
        <span class="continue-meta">${fmt(p.time)} / ${fmt(e.duration)} · ${pct}% · ${ago(p.at)}</span>
      </span>
      <span class="continue-go" aria-hidden="true">▶</span>
    </button>`;
  box.querySelector('.continue-card')
    .addEventListener('click', () => { location.hash = `#/${e.id}`; });
}

/** 有预览图就用图，没有则退回按 id 生成的渐变 */
function paintCover(el, e) {
  const url = coverUrl(e);
  if (url) {
    el.removeAttribute('style');
    el.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
  } else {
    el.innerHTML = '';
    el.setAttribute('style', coverStyle(e.id));
  }
}

function renderCards(query) {
  const q = (query || '').trim().toLowerCase();
  const box = $('#cards');
  const progress = loadProgress();
  let rows = index.filter((e) => !q
    || e.title.toLowerCase().includes(q)
    || (e.authors || []).join(' ').toLowerCase().includes(q)
    || e.id.toLowerCase().includes(q));

  if (activeFilter.type === 'tag') {
    rows = rows.filter((e) => (e.topics || []).includes(activeFilter.value));
  } else if (activeFilter.type === 'status') {
    rows = rows.filter((e) => statusOf(e, progress) === activeFilter.value);
    // 历史视图按最近收听排序
    rows.sort((a, b) => (progress[b.id]?.at || 0) - (progress[a.id]?.at || 0));
  } else if (activeFilter.type === 'since') {
    // 「Past week / Past month」按论文首次公开日期算；Older = 超出 30 天
    const limit = activeFilter.value;
    rows = rows.filter((e) => {
      const age = daysAgo(e);
      if (age === null) return false;
      return limit === 'older' ? age > 30 : age <= limit;
    });
  }

  box.innerHTML = '';
  $('#empty').hidden = rows.length > 0;
  // 记住这一版的顺序：放完一集要接着走的就是屏幕上这一串
  playOrder = rows.map((e) => e.id);

  for (const e of rows) {
    const authors = e.authors || [];
    const shown = authors.slice(0, 3).join('、') + (authors.length > 3 ? ` +${authors.length - 3}` : '');
    const p = progress[e.id];
    const pct = p && e.duration ? Math.min(100, Math.round((p.time / e.duration) * 100)) : 0;
    const url = coverUrl(e);
    const status = statusOf(e, progress);
    const listening = status === 'done'
      ? `Finished · ${ago(p.at)}`
      : status === 'doing' ? `${pct}% · ${ago(p.at)}` : '';
    // 底栏左：日期打头，后面接收听记录；没听过就退回主标签
    const meta = [fmtDate(e), listening || (e.topics && e.topics[0]) || '']
      .filter(Boolean).join(' · ');

    // 卡片不能整体做成 <button>：右下角还要放一个指向 alphaXiv 的 <a>，
    // 而按钮里嵌链接是非法 HTML。所以拆成「按钮负责打开播放器 + 链接单独一个兄弟节点」。
    const card = document.createElement('div');
    card.className = 'card';

    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'card-hit';
    hit.setAttribute('aria-label', `Open episode: ${e.title}`);
    hit.innerHTML = `
      <span class="card-art">
        ${url
          ? `<img src="${url}" alt="" loading="lazy">`
          : `<span class="card-fallback" style="${coverStyle(e.id)}"></span>`}
        <span class="card-play" aria-hidden="true">▶</span>
        <span class="card-dur">${fmt(e.duration)}</span>
        ${pct ? `<span class="card-progress"><i style="width:${pct}%"></i></span>` : ''}
      </span>
      <span class="card-body">
        <span class="card-title">${escapeHtml(e.title)}</span>
        <span class="card-sub">${escapeHtml(shown)}</span>
      </span>`;
    hit.addEventListener('click', () => { location.hash = `#/${e.id}`; });

    // 底栏单独一行：左收听记录、右 alphaXiv 链接。
    // 链接不能塞进卡片按钮里（按钮嵌链接是非法 HTML），
    // 也不能绝对定位——那样会和最后一行文字压在同一行上。
    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const metaEl = document.createElement('span');
    metaEl.className = 'card-meta';
    metaEl.textContent = meta;

    const src = document.createElement('a');
    src.className = 'card-src';
    src.href = `https://www.alphaxiv.org/abs/${e.id}`;
    src.target = '_blank';
    src.rel = 'noopener';
    src.title = 'Open the paper on alphaXiv';
    src.setAttribute('aria-label', `Open ${e.id} on alphaXiv`);
    src.innerHTML = `alphaXiv <span aria-hidden="true">↗</span>`;

    foot.append(metaEl, src);
    card.append(hit, foot);
    box.appendChild(card);
  }
}

/* ── 播放视图 ────────────────────────────────────────── */
function buildBibtex(ep) {
  const first = (ep.authors || [])[0] || 'paper';
  const key = (first.split(' ').pop() || 'paper').toLowerCase() + ep.id.replace('.', '');
  return `@misc{${key},
  title        = {${ep.title}},
  author       = {${(ep.authors || []).join(' and ')}},
  eprint       = {${ep.id}},
  archivePrefix= {arXiv},
  url          = {https://arxiv.org/abs/${ep.id}}
}`;
}

/* ── 换集要「零等待」──────────────────────────────────
   锁屏下自动续播失败的原因在这里：一集放完到下一集出声之间，如果中间插了
   await（去网络取下一集的 episode.json）或者等了一次 hashchange 事件，
   iOS 会趁这个空档把音频会话关掉——现象就是进度条在走、但一点声音都没有，
   非要解锁回到前台才恢复。

   所以：提前把下一集的 JSON 拿到手，换集时同步换 src 并 play()，
   整条链路里一次 await 都不出现。
   ────────────────────────────────────────────────────── */
const episodeCache = new Map();
const EPISODE_CACHE_MAX = 6;
let currentAudioSrc = '';

/** 换音频源；同一个地址不重复赋值，否则浏览器会重新加载、重头播 */
function setAudioSource(url) {
  if (!url || url === currentAudioSrc) return false;
  currentAudioSrc = url;
  audio.src = url;
  return true;
}

function audioUrlFor(ep, id) {
  const ref = ep.audio || '';
  return /^https?:/i.test(ref) ? ref : `${DATA_BASE}/${id}/${ref || 'audio/podcast.mp3'}`;
}

/** 预取某集的 JSON，换来换集时不再等网络 */
async function preloadEpisode(id) {
  if (!id || episodeCache.has(id) || deviceLibrary) return;
  try {
    const res = await fetch(`${DATA_BASE}/${id}/episode.json`);
    if (!res.ok) return;
    episodeCache.set(id, await res.json());
    while (episodeCache.size > EPISODE_CACHE_MAX) {
      episodeCache.delete(episodeCache.keys().next().value);
    }
  } catch (e) { /* 预载失败不影响正常播放 */ }
}

async function openEpisode(id, preset) {
  // 预载过 / 预置过就直接用：这条路径上一路到底没有 await，
  // 换集能在一帧内完成（见上面「换集要零等待」的说明）。
  let data = preset || episodeCache.get(id) || null;
  if (!data && deviceLibrary) {
    try { data = await idbGet('episodes', id); } catch (e) { /* 退回网络 */ }
  }
  if (!data) {
    const res = await fetch(`${DATA_BASE}/${id}/episode.json`);
    if (!res.ok) { location.hash = '#/'; return; }
    data = await res.json();
  }
  episodeCache.set(id, data);
  episode = data;
  lines = episode.segments || [];
  revealed = new Set();
  currentIdx = -1;

  // 锁屏卡片与后台播放：换集就更新一次
  updateMediaSession(episode);

  // 先把声音接上再做界面：换集时这一步必须尽早、且不能有 await
  let switched;
  if (audioUrls.has(id)) {
    switched = setAudioSource(audioUrls.get(id));
  } else if (deviceLibrary) {
    const blob = await idbGet('blobs', `${id}:audio`).catch(() => null);
    if (blob) {
      const u = URL.createObjectURL(blob);
      audioUrls.set(id, u);
      switched = setAudioSource(u);
    } else {
      switched = setAudioSource(audioUrlFor(episode, id));
    }
  } else {
    switched = setAudioSource(audioUrlFor(episode, id));
  }
  audio.playbackRate = 1;

  $('#ep-title').textContent = episode.title;
  $('#ep-authors').textContent = (episode.authors || []).join(' · ');
  $('#ep-date').textContent = fmtDate(episode);
  paintCover($('#deck-cover'), episode);
  $('#link-alphaxiv').href = (episode.links && episode.links.alphaxiv)
    || `https://www.alphaxiv.org/abs/${episode.id}`;
  $('#ep-abstract').textContent = episode.abstract || '';
  $('#ep-citation').textContent = buildBibtex(episode);

  // 同一集重复打开时不会重载音频（否则会把正在听的这一段打断），
  // 这时进度条要直接对齐当前播放位置，不能归零
  const total = audio.duration || episode.duration || 0;
  currentProgress = switched || !total ? 0 : (audio.currentTime / total) * 100;
  $('#time-now').textContent = fmt(switched ? 0 : audio.currentTime);
  $('#time-total').textContent = fmt(total);
  setBar(bar, currentProgress);
  setBar(miniBar, currentProgress);
  scheduleWave(currentProgress / 100);

  renderRates();
  renderLines();

  // 迷你条给列表页用
  paintCover($('#mini-cover'), episode);
  $('#mini-title').textContent = episode.title;

  const saved = loadProgress()[id];
  const savedTotal = episode.duration || 0;
  // 上次已经听到结尾的不要再跳回去：否则一打开就立刻播完，
  // 紧接着触发自动续播跳到下一集，看起来像「点了没播就换集了」。
  if (saved && saved.time > 3 && (!savedTotal || saved.time / savedTotal < 0.95)) {
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = saved.time; }, { once: true });
  }
  updateMini();

  // 上一集放完自动切过来的：接着放
  if (pendingAutoplay) {
    pendingAutoplay = false;
    audio.play().catch(() => {});
  }

  // 现在就把下一集的数据取好，换集时才不用等网络
  setTimeout(() => { preloadEpisode(neighbourId(1)); }, 1000);
}

function renderLines() {
  const ol = $('#lines');
  ol.innerHTML = '';
  lines.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'line';
    li.dataset.i = String(i);
    const en = mode !== 'zh' ? `<div class="line-en">${escapeHtml(s.en)}</div>` : '';
    const zh = mode !== 'en' && s.zh ? `<div class="line-zh">${escapeHtml(s.zh)}</div>` : '';
    li.innerHTML = `<span class="line-meta">`
      + `<span class="line-time">${fmt(s.start)}</span>`
      + `<span class="line-speaker">${escapeHtml(s.speaker || '')}</span></span>`
      + `<span class="line-body">${en}${zh}</span>`;
    li.addEventListener('click', () => {
      if (mode === 'dictation' && !revealed.has(i)) {
        revealed.add(i);
        li.classList.remove('blank');
        return;
      }
      autoScrollUntil = 0;
      audio.currentTime = Math.max(0, s.start - 0.15);
    });
    ol.appendChild(li);
  });
  applyMode();
}

function applyMode() {
  document.querySelectorAll('.line').forEach((li, i) => {
    li.classList.toggle('blank', mode === 'dictation' && !revealed.has(i));
  });
}

function setMode(next) {
  mode = next;
  $('#mode-label').textContent = MODE_LABEL[next] || 'English';
  $('#mode-menu').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === next);
  });
  renderLines();
}

/* 二分查找当前句 */
function findLine(t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function highlight(i) {
  if (i === currentIdx) return;
  currentIdx = i;
  document.querySelectorAll('.line.now').forEach((el) => el.classList.remove('now'));
  const el = document.querySelector(`.line[data-i="${i}"]`);
  if (!el) return;
  el.classList.add('now');
  if (Date.now() > autoScrollUntil) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ── 播放控制 ────────────────────────────────────────── */
function toggle() {
  if (audio.paused) audio.play(); else audio.pause();
}

function skip(delta) {
  const total = audio.duration || (episode && episode.duration) || 0;
  // 已经在结尾了还往前推，就直接接下一集。
  // 否则会把 currentTime 钳在 duration 上原地不动——锁屏上把进度推到结束
  // 之后就再也走不动，而且这种「推到结尾」不一定触发 ended，不会自动续播。
  if (delta > 0 && total && audio.currentTime >= total - 0.3) {
    const next = neighbourId(1);
    if (next) { goToEpisode(next, true); return; }
  }
  audio.currentTime = Math.min(total || 1e9, Math.max(0, audio.currentTime + delta));
}

function stepLine(dir) {
  const t = audio.currentTime;
  const i = findLine(t);
  let target;
  if (dir > 0) {
    const next = lines.findIndex((s) => s.start > t + 0.25);
    target = next === -1 ? lines.length - 1 : next;
  } else if (i > 0 && t - lines[i].start < 1.2) {
    target = i - 1;
  } else {
    target = Math.max(0, i);
  }
  if (lines[target]) { autoScrollUntil = 0; audio.currentTime = Math.max(0, lines[target].start - 0.15); }
}

/* ── 播放模式与前后集 ──────────────────────────────────
   放完一集默认接着放下一集（以前是直接停住）。
   「下一集」的顺序取列表当前渲染出来的顺序，所以筛选或搜索之后，
   跟着往下走的就是屏幕上那一串。
   ────────────────────────────────────────────────────── */
let playMode = 'in-order';
let playOrder = [];           // 列表当前渲染出的 id 顺序
let pendingAutoplay = false;  // 换集之后是否自动开播

try { playMode = localStorage.getItem(PLAYMODE_KEY) || 'in-order'; } catch (e) { /* 忽略 */ }
if (!PLAYMODE_LABEL[playMode]) playMode = 'in-order';

function renderPlayMode() {
  $('#playmode-label').textContent = PLAYMODE_LABEL[playMode];
  $('#playmode-icon').innerHTML = PLAYMODE_ICON[playMode];
  $('#playmode-btn').classList.toggle('on', playMode !== 'in-order');
  $('#playmode-menu').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.playmode === playMode);
  });
}

function setPlayMode(next) {
  if (!PLAYMODE_LABEL[next]) return;
  playMode = next;
  try { localStorage.setItem(PLAYMODE_KEY, next); } catch (e) { /* 忽略 */ }
  renderPlayMode();
}

/** 相邻一集的 id；随机只在往后走时生效，往前仍是顺序，方便回退 */
function neighbourId(step) {
  const order = playOrder.length ? playOrder : index.map((e) => e.id);
  if (!episode || !order.length) return null;
  if (playMode === 'shuffle' && step > 0) {
    const others = order.filter((id) => id !== episode.id);
    return others.length ? others[Math.floor(Math.random() * others.length)] : null;
  }
  const i = order.indexOf(episode.id);
  if (i === -1) return order[0];
  const next = order[(i + step + order.length) % order.length];
  return next === episode.id ? null : next;
}

/** 切到某一集。手动切集沿用当前播放状态，不硬塞声音进来 */
function goToEpisode(id, autoplay) {
  if (!id || !episode || id === episode.id) return;
  pendingAutoplay = Boolean(autoplay);
  // 在列表页用迷你条听时换集：只换播放内容，不把用户拽进播放页
  if (document.body.dataset.view === 'list') {
    openEpisode(id);
    return;
  }
  const preset = episodeCache.get(id);
  if (preset) {
    // 同步换集：不走 location.hash——那条路要多等一次事件循环，
    // iOS 会在这个空档里把音频会话关掉。
    history.replaceState(null, '', `#/${id}`);
    openEpisode(id, preset);
    return;
  }
  location.hash = `#/${id}`;
}

/** 一集放完了 */
function handleEpisodeEnd() {
  if (sleepUntilEnd) { clearSleep(true); toast('Episode finished'); updateMini(); return; }
  if (playMode === 'repeat-one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (playMode === 'stop') { updateMini(); return; }
  const next = neighbourId(1);
  if (next) goToEpisode(next, true);
  else updateMini();
}

function renderRates() {
  const box = $('#rates');
  box.innerHTML = '';
  [0.75, 1, 1.25, 1.5].forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${r}×`;
    b.className = r === 1 ? 'on' : '';
    b.addEventListener('click', () => {
      audio.playbackRate = r;
      box.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
    box.appendChild(b);
  });
}

/* ── 迷你条（只在列表页出现）─────────────────────────── */
/* ── 波形进度条 ──────────────────────────────────────
   波形数据来自 ffmpeg 解码后的 RMS（见 scripts/add_episode.py），
   真实反映每段的响度起伏。canvas 只负责画，拖拽仍由上面的透明 range 接管。
   ────────────────────────────────────────────────────── */
const waveCanvas = $('#wave');
let waveQueued = false;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawWave(pct) {
  if (!waveCanvas) return;
  const w = waveCanvas.clientWidth;
  const h = waveCanvas.clientHeight;
  if (!w || !h) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (waveCanvas.width !== Math.round(w * dpr)) waveCanvas.width = Math.round(w * dpr);
  if (waveCanvas.height !== Math.round(h * dpr)) waveCanvas.height = Math.round(h * dpr);

  const ctx = waveCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const peaks = (episode && episode.peaks && episode.peaks.length) ? episode.peaks : null;
  const n = peaks ? peaks.length : 48;
  const gap = Math.max(1, Math.min(2, w / n / 3));
  const bw = Math.max(1.1, (w - gap * (n - 1)) / n);
  const radius = Math.min(bw / 2, 1.5);
  const on = cssVar('--wave-on') || '#a97fe8';
  const off = cssVar('--wave-off') || '#e7dcf6';

  for (let i = 0; i < n; i++) {
    const v = peaks ? peaks[i] : 0.55;
    const bh = Math.max(2.5, v * h);
    const x = i * (bw + gap);
    ctx.fillStyle = (i + 0.5) / n <= pct ? on : off;
    roundRectPath(ctx, x, (h - bh) / 2, bw, bh, radius);
    ctx.fill();
  }
}

/** 等一帧再画：切换视图时 canvas 刚显示出来，clientWidth 可能还是 0 */
function scheduleWave(pct) {
  const p = pct === undefined ? (currentProgress / 100) : pct;
  if (waveQueued) return;
  waveQueued = true;
  requestAnimationFrame(() => { waveQueued = false; drawWave(p); });
}

function updateMini() {
  if (!episode) return;
  const d = audio.duration || episode.duration || 0;
  if (scrubbing !== miniBar) setBar(miniBar, d ? (audio.currentTime / d) * 100 : 0);
  let sub = `${fmt(audio.currentTime)} / ${fmt(d)}`;
  if (sleepDeadline) sub += ` · ⏱${fmtSleep(sleepRemaining())}`;
  else if (sleepUntilEnd) sub += ' · ends';
  $('#mini-sub').textContent = sub;
  syncPlayIcons();
}

/* ── 后台播放与锁屏控制（Media Session）───────────────
   手机浏览器只有在「这是一个正在播放的媒体会话」时，才愿意在息屏／切到
   后台之后继续出声，并在锁屏上给一张正在播放的卡片。网页默认什么都不声明，
   系统就按普通网页处理——息屏即冻结，音频跟着停。
   这里做三件事：
     1. 把当前论文写进锁屏卡片（标题、作者、封面）
     2. 把锁屏／蓝牙耳机上的播放、暂停、上一集、下一集、快进快退接回播放器
     3. 持续上报播放位置，锁屏进度条才准
   没有 Media Session 的浏览器会直接跳过，不影响其它逻辑。
   ────────────────────────────────────────────────────── */
const hasMediaSession = 'mediaSession' in navigator;
let lastPositionPing = 0;

function episodeArtwork(ep) {
  const src = coverUrl(ep);
  if (!src) return [];
  try { return [{ src: /^(https?:|blob:)/.test(src) ? src : new URL(src, location.href).href }]; }
  catch { return []; }
}

function updateMediaSession(ep) {
  if (!hasMediaSession) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: (ep && ep.title) || 'Papertone',
      artist: (ep && ep.authors || []).slice(0, 3).join(', ') || 'Papertone',
      album: 'Papertone',
      artwork: episodeArtwork(ep),
    });
  } catch (e) { /* 部分浏览器对 artwork 挑剔，失败就当没有 */ }
}

/** 锁屏进度条；duration 不可用时不上报，免得显示成乱的值 */
function updateMediaPosition() {
  if (!hasMediaSession || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch (e) { /* 忽略 */ }
}

function setMediaPlaybackState(state) {
  if (!hasMediaSession) return;
  try { navigator.mediaSession.playbackState = state; } catch (e) { /* 忽略 */ }
}

function wireMediaSession() {
  if (!hasMediaSession) return;
  const handlers = {
    play: () => { audio.play().catch(() => {}); },
    pause: () => { audio.pause(); },
    stop: () => { audio.pause(); },
    previoustrack: () => goToEpisode(neighbourId(-1), true),
    nexttrack: () => goToEpisode(neighbourId(1), true),
    seekto: (d) => {
      if (d && Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime;
    },
  };
  for (const [name, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) { /* 不支持的动作跳过 */ }
  }
}

/* ── 定时停止 ────────────────────────────────────────── */
function sleepRemaining() {
  return sleepDeadline ? Math.max(0, (sleepDeadline - Date.now()) / 1000) : 0;
}

function clearSleep(silent) {
  sleepDeadline = 0;
  sleepUntilEnd = false;
  if (sleepTick) { clearInterval(sleepTick); sleepTick = null; }
  $('#sleep-btn').classList.remove('on');
  $('#sleep-label').textContent = 'Sleep';
  if (!silent) toast('Sleep timer cancelled');
}

function fmtSleep(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

function armSleep(label) {
  $('#sleep-btn').classList.add('on');
  $('#sleep-label').textContent = label;
  if (!sleepTick) sleepTick = setInterval(tickSleep, 500);
}

function setSleep(value) {
  closeMenus();
  if (value === 'off') { clearSleep(); return; }
  if (value === 'end') {
    sleepUntilEnd = true;
    sleepDeadline = 0;
    armSleep('End of episode');
    toast('Will stop when the episode ends');
    return;
  }
  sleepDeadline = Date.now() + Number(value) * 60000;
  sleepUntilEnd = false;
  armSleep(fmtSleep(sleepRemaining()));
  toast(`Sleep timer set for ${value} min`);
}

function tickSleep() {
  if (sleepUntilEnd || !sleepDeadline) return;
  $('#sleep-label').textContent = fmtSleep(sleepRemaining());
  if (Date.now() >= sleepDeadline) {
    if (audio.paused) { clearSleep(true); return; }   // 已经手动停了，定时作废
    fadeOutAndPause();
  }
}

/** 睡前场景：音量渐弱再暂停，比硬停更不打断入睡 */
async function fadeOutAndPause() {
  if (fading) return;
  fading = true;
  if (sleepTick) { clearInterval(sleepTick); sleepTick = null; }
  const from = audio.volume;
  for (let i = 1; i <= 22 && fading; i++) {
    audio.volume = Math.max(0, from * (1 - i / 22));
    await new Promise((r) => setTimeout(r, 110));
  }
  audio.pause();
  audio.volume = from;
  fading = false;
  clearSleep(true);
  toast('Stopped by sleep timer');
}

/* ── 事件绑定 ────────────────────────────────────────── */
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || (episode && episode.duration) || 0;
  const pct = d ? (audio.currentTime / d) * 100 : 0;
  currentProgress = pct;
  if (scrubbing !== bar) setBar(bar, pct);
  $('#time-now').textContent = fmt(audio.currentTime);
  $('#time-total').textContent = fmt(d);
  highlight(findLine(audio.currentTime));
  updateMini();
  scheduleWave(pct / 100);

  // 定时停止改由「媒体进度」驱动：息屏后台时 setInterval 会被节流到几十秒
  // 一次甚至停掉，而 timeupdate 跟着音频走，照样在跑。到点就在这里收尾。
  if (sleepDeadline && Date.now() >= sleepDeadline) tickSleep();
  // 锁屏进度条不用每秒都刷，5 秒一次足够
  if (Date.now() - lastPositionPing > 5000) {
    lastPositionPing = Date.now();
    updateMediaPosition();
  }
});

audio.addEventListener('loadedmetadata', () => {
  $('#time-total').textContent = fmt(audio.duration);
});

audio.addEventListener('pause', () => {
  if (episode) saveProgress(episode.id, audio.currentTime);
  setMediaPlaybackState('paused');
  updateMini();
});

audio.addEventListener('play', () => {
  setMediaPlaybackState('playing');
  // 会话真正激活后再登记一次：有些浏览器会忽略首次出声之前登记的跳过键，
  // 锁屏上就只剩播放/暂停，没有上一集/下一集。
  wireMediaSession();
  updateMini();
});
audio.addEventListener('volumechange', updateMini);

audio.addEventListener('ended', () => {
  handleEpisodeEnd();
});

// 息屏／切后台期间 setInterval 可能被冻结，回到前台立刻补一次判断
document.addEventListener('visibilitychange', () => {
  if (sleepDeadline) tickSleep();
  updateMediaPosition();
});

bindScrub(bar);
bindScrub(miniBar);

$('.transport').addEventListener('click', (e) => {
  const btn = e.target.closest('.tbtn');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'toggle') toggle();
  else if (act === 'prev-ep') goToEpisode(neighbourId(-1), !audio.paused);
  else if (act === 'next-ep') goToEpisode(neighbourId(1), !audio.paused);
  else skip(Number(act));
});

$('#mode-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  setMode(btn.dataset.mode);
  closeMenus();
});

$('#playmode-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-playmode]');
  if (!btn) return;
  setPlayMode(btn.dataset.playmode);
  closeMenus();
});

$('#sleep-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-min]');
  if (btn) setSleep(btn.dataset.min);
});

// 自定义分钟数。范围卡在 1–600 分钟，避免填进离谱的值。
$('#sleep-custom').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#sleep-custom-input');
  const minutes = Math.round(Number(input.value));
  if (!Number.isFinite(minutes) || minutes < 1) { input.focus(); return; }
  setSleep(Math.min(600, minutes));
  input.value = '';
});

$('#copy-cite').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#ep-citation').textContent);
    toast('BibTeX copied');
  } catch (e) {
    toast('Copy failed — select it manually');
    $('#ep-citation').hidden = false;
  }
  closeMenus();
});

wireMenu('#mode-btn', '#mode-menu');
wireMenu('#playmode-btn', '#playmode-menu');
wireMenu('#sleep-btn', '#sleep-menu');
wireMenu('#more-toggle', '#more-menu');
wireMediaSession();
renderPlayMode();

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap')) closeMenus();
});

$('#search').addEventListener('input', (e) => renderCards(e.target.value));
$('#back').addEventListener('click', () => { location.hash = '#/'; });

$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  // 波形颜色取自 CSS 变量，换主题后要重画
  scheduleWave();
});

window.addEventListener('resize', () => scheduleWave());

$('#mini').addEventListener('click', (e) => {
  // 拖进度条不算点击，否则一拖就跳走
  if (e.target.closest('.mini-progress')) return;
  const btn = e.target.closest('[data-act="toggle"]');
  if (btn) { toggle(); return; }
  const id = episode && episode.id;
  if (id) location.hash = `#/${id}`;
});

$('#sync-open').addEventListener('click', openSync);
$('#sync-close').addEventListener('click', closeSync);
$('#sync-panel').addEventListener('click', (e) => {
  if (e.target.id === 'sync-panel') closeSync();
});

/* ── 打开 / 关闭图库面板 ─────────────────────────────── */
function openSync() {
  $('#sync-panel').hidden = false;
  refreshDeviceStatus();
  try {
    $('#cloud-repo').value = localStorage.getItem(CLOUD_REPO_KEY) || '';
    $('#cloud-token').value = localStorage.getItem(CLOUD_TOKEN_KEY) || '';
    $('#sync-ids').value = localStorage.getItem(CLOUD_IDS_KEY) || '';
  } catch (e) { /* 隐私模式忽略 */ }
}

function closeSync() {
  $('#sync-panel').hidden = true;
}

/* ── 把论文库保存到本机（IndexedDB）─────────────────────
   存进去之后：仓库不用再放音频，音频也只留在你这一台设备上。
   ────────────────────────────────────────────────────── */
const fmtBytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB'
  : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB');

async function refreshDeviceStatus() {
  const el = $('#device-status');
  let count = 0;
  try { count = (await idbAll('episodes')).length; } catch (e) { count = -1; }
  let usage = '';
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      usage = ` · using ${fmtBytes(est.usage || 0)} of ${fmtBytes(est.quota || 0)}`;
    } catch (e) { /* 忽略 */ }
  }
  el.textContent = count > 0
    ? `${count} episodes stored on this device${usage}.`
    : count === 0
      ? 'Nothing stored on this device yet — the library is served from the site.'
      : 'Device storage unavailable (private browsing?).';
}

async function saveToDevice() {
  const btn = $('#device-save');
  const el = $('#device-status');
  btn.disabled = true;
  const base = serviceBase();
  try {
    const lib = await fetch(`${base}${DATA_BASE}/papers.json`).then((r) => r.json());
    const eps = lib.episodes || [];
    if (!eps.length) throw new Error('library is empty');
    let done = 0;
    for (const e of eps) {
      el.textContent = `Saving ${done + 1} / ${eps.length} · ${e.id}`;
      const dir = `${base}${DATA_BASE}/${e.id}/`;
      const ep = await fetch(dir + 'episode.json').then((r) => r.json());
      await idbPut('episodes', { ...e, ...ep, id: e.id, audio: null });
      // 音频在 CDN 上；老的本地路径作为兜底
      const ref = ep.audio || e.audio_url || '';
      const src = /^https?:/i.test(ref) ? ref : dir + (ref || 'audio/podcast.mp3');
      const blob = await fetch(src).then((r) => r.blob());
      await idbPut('blobs', blob, `${e.id}:audio`);
      if (e.cover) {
        try {
          const cb = await fetch(dir + e.cover).then((r) => r.blob());
          await idbPut('blobs', cb, `${e.id}:cover`);
        } catch (err) { /* 封面缺失不影响播放 */ }
      }
      done += 1;
    }
    deviceLibrary = true;
    await primeCoverUrls();
    await loadIndex();
    renderFilters();
    renderContinue();
    renderCards($('#search').value);
    await refreshDeviceStatus();
    toast(`Saved ${done} episodes to this device`);
  } catch (e) {
    el.textContent = `Could not save: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function clearDevice() {
  const btn = $('#device-clear');
  btn.disabled = true;
  try {
    await idbClearAll();
    coverUrls.forEach((u) => URL.revokeObjectURL(u));
    audioUrls.forEach((u) => URL.revokeObjectURL(u));
    coverUrls.clear();
    audioUrls.clear();
    deviceLibrary = false;
    await loadIndex();
    renderFilters();
    renderContinue();
    renderCards($('#search').value);
    await refreshDeviceStatus();
    toast('Device copy removed');
  } catch (e) {
    $('#device-status').textContent = `Could not clear: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

$('#device-save').addEventListener('click', saveToDevice);
$('#device-clear').addEventListener('click', clearDevice);

/* ── 云端同步：直接触发 GitHub Actions ────────────────────
   不需要本机开机。GitHub API 是 access-control-allow-origin: *，
   所以网页可以带着 token 直接 dispatch 工作流。
   ────────────────────────────────────────────────────── */
const CLOUD_REPO_KEY = 'podcast-cloud-repo';
const CLOUD_TOKEN_KEY = 'podcast-cloud-token';
const CLOUD_IDS_KEY = 'podcast-cloud-ids';

const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
});

/** token 不对时的常见情形，把判断依据直接摆出来 */
function tokenHint(token) {
  return `A GitHub token is <b>40</b> characters (classic, starts with <code>ghp_</code>) `
    + `or <b>93</b> characters (fine-grained, starts with <code>github_pat_</code>). `
    + `Yours is <b>${token.length}</b> — that looks like an LLM API key, which belongs `
    + `in the repo secret <code>TRANSLATE_API_KEY</code>, not here.`;
}

async function cloudSync() {
  const repo = $('#cloud-repo').value.trim();
  const token = $('#cloud-token').value.trim();
  const st = $('#cloud-status');
  if (!repo || !token) { st.textContent = 'Fill in the repository and a token first.'; return; }
  // 填了具体论文就让工作流跳过推荐流扫描，只抓这几篇
  const ids = ($('#sync-ids').value || '').trim();

  const btn = $('#cloud-run');
  btn.disabled = true;
  // 先验 token 再触发：直接触发的话，出错只有一句 Bad credentials，
  // 分不清是 token 过期、复制错了，还是仓库或权限不对。
  st.textContent = 'Checking the token…';
  try {
    const me = await fetch('https://api.github.com/user', { headers: ghHeaders(token) });
    if (me.status === 401) {
      st.innerHTML = `GitHub rejected this token (<b>401</b>).<br>${tokenHint(token)}`;
      return;
    }
    if (!me.ok) {
      st.textContent = `Could not reach the GitHub API (HTTP ${me.status}).`;
      return;
    }
    const login = (await me.json()).login;

    st.textContent = 'Dispatching the workflow…';
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/sync.yml/dispatches`,
      {
        method: 'POST',
        headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            days: $('#sync-days').value,
            pages: $('#sync-pages').value,
            limit: '20',
            translate: 'yes',
            ids,
          },
        }),
      });
    if (res.status === 204) {
      st.innerHTML = 'Started. Track it on GitHub → <b>Actions</b>. '
        + `Signed in as <b>${login}</b>. `
        + 'New episodes appear here once the run commits them.';
      try {
        localStorage.setItem(CLOUD_REPO_KEY, repo);
        localStorage.setItem(CLOUD_TOKEN_KEY, token);
        localStorage.setItem(CLOUD_IDS_KEY, ids);
      } catch (e) { /* 隐私模式忽略 */ }
    } else {
      // 到这里说明 token 是有效的，问题只可能出在权限或目标仓库上
      st.innerHTML = res.status === 403
        ? `The token is valid (signed in as <b>${login}</b>) but may not run workflows. `
          + `Give it <b>Actions: Read and write</b> on <code>${repo}</code>.`
        : res.status === 404
          ? `Workflow <code>sync.yml</code> or repo <code>${repo}</code> not found — `
            + 'check the spelling and that the token can see that repository.'
          : res.status === 422
            ? 'The workflow rejected these inputs (422).'
            : `Failed (${res.status}).`;
    }
  } catch (e) {
    st.textContent = `Failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

$('#cloud-run').addEventListener('click', cloudSync);

// 手动滚动后暂停自动滚动 5 秒，避免看后面台词时被拽回
transcriptRegion.addEventListener('wheel', () => { autoScrollUntil = Date.now() + 5000; }, { passive: true });
transcriptRegion.addEventListener('touchmove', () => { autoScrollUntil = Date.now() + 5000; }, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === ' ') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowLeft') skip(e.shiftKey ? -5 : -3);
  else if (e.key === 'ArrowRight') skip(e.shiftKey ? 5 : 3);
  else if (e.key === 'ArrowUp') { e.preventDefault(); stepLine(-1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); stepLine(1); }
  else if (e.key === 'Escape') closeMenus();
});

window.addEventListener('beforeunload', () => {
  if (episode) saveProgress(episode.id, audio.currentTime);
});

/* ── 增量抓取 ──────────────────────────────────────────
   抓取本身跑在本机服务里（scripts/serve.py），网页只负责点按钮、显示清单、上报进度。
   原因是 alphaXiv 的 feed 接口 CORS 只放行 alphaxiv 自己，浏览器跨域拿不到候选名单；
   ASR 对齐也需要 ffmpeg 与语音模型，浏览器做不了。
   ────────────────────────────────────────────────────── */
function serviceBase() {
  try { return (localStorage.getItem(SERVICE_KEY) || '').replace(/\/$/, ''); }
  catch (e) { return ''; }
}

/* ── 路由 ────────────────────────────────────────────── */
async function route() {
  const id = location.hash.replace(/^#\/?/, '');
  const onEpisode = Boolean(id) && index.some((x) => x.id === id);

  $('#view-list').hidden = onEpisode;
  $('#view-episode').hidden = !onEpisode;
  document.body.dataset.view = onEpisode ? 'episode' : 'list';

  if (onEpisode) {
    $('#mini').hidden = true;
    await openEpisode(id);
  } else {
    audio.pause();
    $('#mini').hidden = !episode;
    renderContinue();
    renderFilters();
    renderCards($('#search').value);
    updateMini();
  }
}

/* ── 访问统计（不蒜子）─────────────────────────────────
   数字来自 cdn.busuanzi.cc 的计数服务：
     · 站点级（Total visitors / Total views）按**域名**汇总，
       同一个域名下所有路径共用一份
     · 页面级（This page）按**完整 URL** 计
   那个脚本很小，做的事只有一件：POST 一次 {url, referrer} 到它自己的
   api.php，再把返回的 JSON 按键名写进同名 id 的元素里。
   它内部有 window.busuanziRequestSent 守卫，一个文档只请求一次，
   所以注入一次就够——本站是哈希路由，本来也不会重新加载文档。
   ────────────────────────────────────────────────────── */
const BZ_SCRIPT_ID = 'papertone-busuanzi-script';
const BZ_SCRIPT_URL = 'https://cdn.busuanzi.cc/busuanzi/3.6.9/busuanzi.min.js';
const BZ_CELLS = ['busuanzi_site_uv', 'busuanzi_site_pv', 'busuanzi_page_pv'];
const BZ_LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

function formatVisitorCount(value) {
  const number = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(number) ? number.toLocaleString('en-US') : String(value);
}

function loadVisitorCounter() {
  const footer = $('#visitor-footer');
  if (!footer) return;
  const cells = BZ_CELLS.map((id) => document.getElementById(id));
  if (cells.some((el) => !el)) return;

  // 脚本把原始数字写进这几个 dd 里。这里只做格式化与就绪标记：
  // 值没变就不回写，否则会自己触发自己形成死循环。
  // 观察者无条件装上——数字什么时候被写进来都能处理。
  const publish = () => {
    let ready = true;
    for (const el of cells) {
      const raw = el.textContent.trim();
      if (!/^\d[\d,]*$/.test(raw)) { ready = false; continue; }
      const pretty = formatVisitorCount(raw);
      if (pretty !== raw) el.textContent = pretty;
    }
    if (ready) footer.classList.add('is-loaded');
  };
  new MutationObserver(publish).observe(footer, {
    childList: true, characterData: true, subtree: true,
  });

  // 本地开发不上报：那是个公共计数服务，localhost 的访问没有意义
  if (BZ_LOCAL.has(location.hostname)) return;
  const script = document.createElement('script');
  script.id = BZ_SCRIPT_ID;
  script.src = BZ_SCRIPT_URL;
  script.defer = true;
  document.head.appendChild(script);
}

(async function boot() {
  const want = new URLSearchParams(location.search).get('mode');
  if (want && MODE_LABEL[want]) setMode(want); else setMode('en');

  // ?add=<id>[,<id>] —— 直接把这几篇填进同步面板并打开，省得手打
  const addIds = new URLSearchParams(location.search).get('add');
  if (addIds) {
    openSync();
    $('#sync-ids').value = addIds;
  }

  try {
    await loadIndex();
    await primeCoverUrls();
  } catch (err) {
    toast('Failed to load data — serve over http://');
  }

  renderFilters();
  renderContinue();
  loadVisitorCounter();
  window.addEventListener('hashchange', route);
  route();
})();

/* Papertone · 播放器逻辑
   数据源：data/papers.json 与 data/<id>/episode.json
   用相对路径，本地服务和 GitHub Pages 子路径部署都能直接用 */

const DATA_BASE = 'data';
const PROGRESS_KEY = 'podcast-progress';
const THEME_KEY = 'podcast-theme';
const SERVICE_KEY = 'podcast-service';

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
  [['#mode-menu', '#mode-btn'], ['#sleep-menu', '#sleep-btn'], ['#more-menu', '#more-toggle']]
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
  try {
    const local = await idbAll('episodes');
    if (local && local.length) {
      deviceLibrary = true;
      index = local.map(({ segments, ...rest }) => rest);
      return;
    }
  } catch (e) { /* 隐私模式等场景下 IndexedDB 不可用，退回网络 */ }
  const res = await fetch(`${DATA_BASE}/papers.json`, { cache: 'no-cache' });
  index = (await res.json()).episodes || [];
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
  ];
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

  groups.forEach((g) => add(g.type, g.value, g.label));

  const tags = allTags();
  if (tags.length) {
    const sep = document.createElement('span');
    sep.className = 'chip sep';
    box.appendChild(sep);
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
  }

  box.innerHTML = '';
  $('#empty').hidden = rows.length > 0;

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
    // 没听过时用主标签补位，底栏左边才不会空着
    const meta = listening || (e.topics && e.topics[0]) || '';

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

async function openEpisode(id) {
  // 本机存储优先；没有再去网络取
  let data = null;
  if (deviceLibrary) {
    try { data = await idbGet('episodes', id); } catch (e) { /* 退回网络 */ }
  }
  if (!data) {
    const res = await fetch(`${DATA_BASE}/${id}/episode.json`, { cache: 'no-cache' });
    if (!res.ok) { location.hash = '#/'; return; }
    data = await res.json();
  }
  episode = data;
  lines = episode.segments || [];
  revealed = new Set();
  currentIdx = -1;

  $('#ep-title').textContent = episode.title;
  $('#ep-authors').textContent = (episode.authors || []).join(' · ');
  paintCover($('#deck-cover'), episode);
  $('#link-alphaxiv').href = (episode.links && episode.links.alphaxiv)
    || `https://www.alphaxiv.org/abs/${episode.id}`;
  $('#ep-abstract').textContent = episode.abstract || '';
  $('#ep-citation').textContent = buildBibtex(episode);

  $('#time-now').textContent = '0:00';
  $('#time-total').textContent = fmt(episode.duration);
  setBar(bar, 0);
  setBar(miniBar, 0);
  currentProgress = 0;
  scheduleWave(0);

  // audio 可能是 CDN 绝对地址（现在都是），也可能是老的本地相对路径
  const ref = episode.audio || '';
  const asset = /^https?:/i.test(ref)
    ? ref
    : `${DATA_BASE}/${id}/${ref || 'audio/podcast.mp3'}`;
  if (audioUrls.has(id)) {
    audio.src = audioUrls.get(id);
  } else if (deviceLibrary) {
    const blob = await idbGet('blobs', `${id}:audio`).catch(() => null);
    if (blob) {
      const u = URL.createObjectURL(blob);
      audioUrls.set(id, u);
      audio.src = u;
    } else {
      audio.src = asset;
    }
  } else {
    audio.src = asset;
  }
  audio.playbackRate = 1;
  renderRates();
  renderLines();

  // 迷你条给列表页用
  paintCover($('#mini-cover'), episode);
  $('#mini-title').textContent = episode.title;

  const saved = loadProgress()[id];
  if (saved && saved.time > 3) {
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = saved.time; }, { once: true });
  }
  updateMini();
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
  audio.currentTime = Math.min(audio.duration || 1e9, Math.max(0, audio.currentTime + delta));
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
});

audio.addEventListener('loadedmetadata', () => {
  $('#time-total').textContent = fmt(audio.duration);
});

audio.addEventListener('pause', () => {
  if (episode) saveProgress(episode.id, audio.currentTime);
  updateMini();
});

audio.addEventListener('play', updateMini);
audio.addEventListener('volumechange', updateMini);

audio.addEventListener('ended', () => {
  if (sleepUntilEnd) { clearSleep(true); toast('Episode finished'); }
  updateMini();
});

bindScrub(bar);
bindScrub(miniBar);

$('.transport').addEventListener('click', (e) => {
  const btn = e.target.closest('.tbtn');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'toggle') toggle();
  else if (act === 'prev-line') stepLine(-1);
  else if (act === 'next-line') stepLine(1);
  else skip(Number(act));
});

$('#mode-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  setMode(btn.dataset.mode);
  closeMenus();
});

$('#sleep-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-min]');
  if (btn) setSleep(btn.dataset.min);
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
wireMenu('#sleep-btn', '#sleep-menu');
wireMenu('#more-toggle', '#more-menu');

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

async function cloudSync() {
  const repo = $('#cloud-repo').value.trim();
  const token = $('#cloud-token').value.trim();
  const st = $('#cloud-status');
  if (!repo || !token) { st.textContent = 'Fill in the repository and a token first.'; return; }

  const btn = $('#cloud-run');
  btn.disabled = true;
  st.textContent = 'Dispatching the workflow…';
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/sync.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            days: $('#sync-days').value,
            pages: $('#sync-pages').value,
            limit: '20',
            translate: 'yes',
          },
        }),
      });
    if (res.status === 204) {
      st.innerHTML = 'Started. Track it on GitHub → <b>Actions</b>. '
        + 'New episodes appear here once the run commits them.';
      try {
        localStorage.setItem(CLOUD_REPO_KEY, repo);
        localStorage.setItem(CLOUD_TOKEN_KEY, token);
      } catch (e) { /* 隐私模式忽略 */ }
    } else {
      const body = await res.text();
      st.textContent = `Failed (${res.status}): ${body.slice(0, 160)}`;
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
let syncResult = null;
let syncTimer = null;

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

(async function boot() {
  const want = new URLSearchParams(location.search).get('mode');
  if (want && MODE_LABEL[want]) setMode(want); else setMode('en');

  try {
    await loadIndex();
    await primeCoverUrls();
  } catch (err) {
    toast('Failed to load data — serve over http://');
  }

  renderFilters();
  renderContinue();
  window.addEventListener('hashchange', route);
  route();
})();

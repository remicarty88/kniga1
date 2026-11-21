/* =============================================================
   Полка — каталог аудиокниг (мобильное веб-приложение)
   Поток данных: список/жанры/поиск -> m-каталог, книга -> страница с плейлистом.
   Аудио играется напрямую с CDN источника (без промежуточных серверов).
   ============================================================= */

/* ---------- 1. Конфигурация ---------- */

const SRC = {
  list: 'https://m.knigavuhe.org', // каталог, жанры, поиск (серверный HTML)
  book: 'https://knigavuhe.org',   // страница книги (с плейлистом mp3)
};

// Второй источник — читабельные книги (текст). Идёт параллельно аудиокаталогу.
const SRC_READ = 'https://loveread.ec';

// Единственная точка подключения шлюза — наш сервер (server.js): он отдаёт
// статику и проксирует источники через /api?u=… (у них нет CORS-заголовков).
const GATE = url => '/api?u=' + encodeURIComponent(url);

const TTL = { list: 15 * 60e3, genres: 24 * 3600e3, search: 5 * 60e3, book: 30 * 60e3, lr: 20 * 60e3, lrbook: 60 * 60e3, lrpage: 7 * 24 * 3600e3 };

/* ---------- 2. Утилиты ---------- */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

function durationToSec(str) {                       // "3:58:37" -> секунды
  if (!str) return 0;
  const p = String(str).trim().split(':').map(Number).reverse();
  return (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
}

/* ---------- 3. Кэш ---------- */

const store = {
  get(key) {
    try {
      const raw = JSON.parse(localStorage.getItem('polka:' + key));
      if (!raw || Date.now() > raw.e) return null;
      return raw.d;
    } catch { return null; }
  },
  // Данные из кэша независимо от срока хранения — выручает, когда источник
  // недоступен (нет сети или источник нас ограничил).
  getStale(key) {
    try {
      const raw = JSON.parse(localStorage.getItem('polka:' + key));
      return raw ? raw.d : null;
    } catch { return null; }
  },
  set(key, data, ttl) {
    try { localStorage.setItem('polka:' + key, JSON.stringify({ e: Date.now() + ttl, d: data })); }
    catch {
      // переполнение хранилища — чистим кэш каталога
      Object.keys(localStorage).filter(k => k.startsWith('polka:list:')).forEach(k => localStorage.removeItem(k));
    }
  },
  drop(prefix) {
    Object.keys(localStorage).filter(k => k.startsWith('polka:' + prefix)).forEach(k => localStorage.removeItem(k));
  },
};

/* ---------- 3.5 Кэш офлайн-контента (Cache API) ---------- */
/* Скачанные аудиокниги лежат в polka-media, страницы читалки — в polka-data. */

const MEDIA_CACHE = 'polka-media';
const DATA_CACHE = 'polka-data';

/* Ключ страницы читалки в офлайн-кэше. Он обязан быть обычным URL-путём:
   строку вида «off:lrpage:1:1» браузер разбирает как URL со схемой «off»
   и отказывается её кэшировать. */
const offPageKey = (id, p) => new URL(`./off/lrpage/${id}/${p}`, location.href).href;
const offPagePrefix = id => new URL(`./off/lrpage/${id}/`, location.href).href;

async function cachePutText(name, key, text) {
  try {
    const c = await caches.open(name);
    await c.put(new Request(key), new Response(text, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    return true;
  } catch { return false; }
}

async function cacheGetText(name, key) {
  try {
    const c = await caches.open(name);
    const hit = await c.match(new Request(key));
    return hit ? await hit.text() : null;
  } catch { return null; }
}

/* Обложку тоже сохраняем на устройство — вместе с книгой, чтобы она
   показывалась в офлайне. Ключ — исходный адрес картинки: тогда те же
   <img src="…"> попадают в кэш по своим обычным URL. */
async function cacheCover(url) {
  if (!url) return false;
  try {
    const c = await caches.open(DATA_CACHE);
    if (await c.match(url)) return true;
    const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
    if (res && (res.type === 'opaque' || res.ok)) { await c.put(url, res); return true; }
  } catch {}
  return false;
}

/* ---------- 4. Сеть ---------- */

const inflight = new Map();

async function fetchText(url) {
  if (inflight.has(url)) return inflight.get(url);

  const job = (async () => {
    const target = GATE(url);
    let last = null;
    // До трёх попыток: источник иногда отвечает ошибкой / не успевает,
    // особенно когда параллельно идёт воспроизведение аудио.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(500 * attempt);
      try {
        // Основной запрос с заголовком формата; при сбое preflight — повтор без него.
        let r = await fetch(target, { headers: { 'X-Return-Format': 'html' } });
        if (!r.ok) r = await fetch(target);
        if (r.ok) return r.text();
        last = new Error(r.status === 429 ? 'limit' : 'net' + r.status);
        if (r.status === 429) break;   // превышен лимит — мгновенный повтор только навредит
      } catch { last = new Error('net'); }
    }
    throw last || new Error('net');
  })();

  inflight.set(url, job);
  try { return await job; }
  finally { inflight.delete(url); }
}

/* ---------- 5. Разбор страниц ---------- */

function toDoc(html) { return new DOMParser().parseFromString(html, 'text/html'); }

const slugFrom = path => String(path || '').split('/').filter(Boolean).pop() || '';

/* Обложки источника: /covers/{id}/{n}-1.jpg — маленькие (154px).
   Доступны варианты крупнее: -4.jpg (270px) и оригинал {n}.jpg (~1800px).
   kind: 'grid' — компактная для карточек, 'full' — оригинал для крупных экранов. */
function coverImg(src, kind = 'grid') {
  const s = String(src || '');
  const m = /^(.*\/covers\/\d+\/\d+)(?:-\d+)?\.jpg(\?.*)?$/i.exec(s);
  if (!m) return s;
  return kind === 'full' ? m[1] + '.jpg' : m[1] + '-4.jpg?v=1';
}

function parseListing(html) {
  const doc = toDoc(html);
  const items = [...doc.querySelectorAll('.bookkitemm')].map(el => {
    const link = el.querySelector('a.bookkitem_cover');
    const path = link?.getAttribute('href') || el.querySelector('a[href^="/book/"]')?.getAttribute('href') || '';
    const authorBlock = el.querySelector('.bookkitem_icon.-author')?.parentElement;
    const readerBlock = el.querySelector('.bookkitem_icon.-reader')?.parentElement;
    return {
      id: (el.id || '').replace('book', ''),
      slug: slugFrom(path),
      title: (el.querySelector('a.bookkitem_name') || el.querySelector('.bookkitem_name'))?.textContent.trim() || '',
      author: authorBlock?.querySelector('a')?.textContent.trim() || '',
      reader: (readerBlock?.querySelector('a.with_icon') || readerBlock?.querySelector('a'))?.textContent.trim() || '',
      genre: el.querySelector('.bookkitem_genre a')?.textContent.trim() || '',
      genreSlug: slugFrom(el.querySelector('.bookkitem_genre a')?.getAttribute('href') || ''),
      cover: el.querySelector('.bookkitem_cover_img')?.getAttribute('src') || '',
      time: el.querySelector('.bookkitem_meta_time')?.textContent.trim() || '',
    };
  });
  const totalRaw = doc.querySelector('.page_title b')?.textContent.replace(/\D/g, '');
  return { items, total: totalRaw ? Number(totalRaw) : null };
}

function parseGenres(html) {
  return [...toDoc(html).querySelectorAll('.genre_item')].map(a => ({
    slug: slugFrom(a.getAttribute('href') || ''),
    name: a.querySelector('.genre_item_name')?.textContent.trim() || '',
    count: a.querySelector('.genre_item_count')?.textContent.trim() || '',
  })).filter(g => g.slug && g.name);
}

function extractPlaylist(html) {                     // new BookPlayer(id, [ ... ])
  const at = html.indexOf('new BookPlayer(');
  if (at < 0) return null;
  const start = html.indexOf('[', at);
  if (start < 0) return null;
  let depth = 0, str = false, slash = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (str) {
      if (slash) slash = false;
      else if (c === '\\') slash = true;
      else if (c === '"') str = false;
    } else if (c === '"') str = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (!depth) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

function cleanText(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  return clone.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseBook(html, fallback = {}) {
  const doc = toDoc(html);
  const playlist = extractPlaylist(html) || [];
  const pd = (playlist[0] && playlist[0].player_data) || {};

  const times = [...doc.querySelectorAll('.book_playlist_item_time')].map(e => e.textContent.trim());
  const chapters = playlist.map((f, i) => ({
    id: f.id,
    title: (f.title || ('Глава ' + (i + 1))).trim(),
    url: f.url,
    duration: durationToSec(times[i] || ''),
  }));

  const authors = [...doc.querySelectorAll('[itemprop="author"] a')].map(a => a.textContent.trim()).filter(Boolean);
  const readers = [...doc.querySelectorAll('h1 .single_reader a.with_icon')].map(a => a.textContent.trim()).filter(Boolean);
  const durMatch = html.match(/Время звучания:<\/span>\s*([\d:]+)/);

  return {
    id: (html.match(/new BookPlayer\((\d+)/) || [, fallback.id])[1],
    slug: fallback.slug || '',
    title: doc.querySelector('.book_title_name')?.textContent.trim() || pd.title || fallback.title || '',
    authors: authors.length ? authors : (pd.authors ? [pd.authors] : (fallback.author ? [fallback.author] : [])),
    readers: readers.length ? readers : (pd.readers ? [pd.readers] : (fallback.reader ? [fallback.reader] : [])),
    genre: doc.querySelector('.book_genre_pretitle a')?.textContent.trim() || fallback.genre || '',
    cover: doc.querySelector('.book_cover img')?.getAttribute('src') || pd.cover || fallback.cover || '',
    duration: durMatch ? durMatch[1] : '',
    rating: doc.querySelector('meta[itemprop="ratingValue"]')?.getAttribute('content') || '',
    ratingCount: doc.querySelector('meta[itemprop="ratingCount"]')?.getAttribute('content') || '',
    description: cleanText(doc.querySelector('.book_description')),
    chapters,
  };
}

/* ---------- 6. Разбор LoveRead (читабельные книги) ---------- */

// Обложки источника отдаются относительным путём img/book_covers/... — достраиваем до абсолютного.
const lrCover = src => {
  const s = String(src || '');
  if (!s) return '';
  return /^https?:/i.test(s) ? s : SRC_READ + '/' + s.replace(/^\//, '');
};

// Значение поля в блоке характеристик: <span>Время чтения: </span>5 ч 24 мин<br>
function lrField(scope, label) {
  if (!scope) return '';
  const span = [...scope.querySelectorAll('span')]
    .find(s => s.textContent.trim().replace(/\s*:\s*$/, '') === label);
  if (!span) return '';
  let out = '', node = span.nextSibling, guard = 0;
  while (node && guard++ < 8) {
    if (node.nodeType === 3) out += node.textContent; else break;
    node = node.nextSibling;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function parseLrList(html) {
  const doc = toDoc(html);
  return [...doc.querySelectorAll('.blockBook')].map(el => {
    const about = el.querySelector('.blAboutBook');
    const link = el.querySelector('.blRead a') || el.querySelector('a[href*="book-comments.php"]') || el.querySelector('a[href*="read_book.php"]');
    const id = ((link?.getAttribute('href') || '').match(/[?&](?:book|id)=(\d+)/) || [])[1] || '';
    const genres = [...el.querySelectorAll('.blGenres a')].map(a => a.textContent.replace(/[«»]/g, '').trim()).filter(Boolean);
    return {
      id,
      title: el.querySelector('.blNameBook h3, .blNameBook h2')?.textContent.trim() || '',
      author: about?.querySelector('a[href*="biography-author"] strong, a[href*="biography-author"]')?.textContent.trim() || '',
      genre: genres[0] || '',
      cover: about?.querySelector('img.book-cover')?.getAttribute('src') || '',
      time: lrField(about, 'Время чтения'),
    };
  }).filter(b => b.id && b.title);
}

function parseLrGenres(html) {
  const menu = toDoc(html).querySelector('ul.leftMenu');
  if (!menu) return [];
  return [...menu.children].filter(li => li.tagName === 'LI').map(li => ({
    id: ((li.querySelector(':scope > a')?.getAttribute('href') || '').match(/genres=(\d+)/) || [])[1] || '',
    name: li.querySelector(':scope > a')?.textContent.trim() || '',
    subs: [...li.querySelectorAll(':scope > ul li a')].map(a => ({
      id: ((a.getAttribute('href') || '').match(/genre=(\d+)/) || [])[1] || '',
      name: a.textContent.trim(),
    })).filter(s => s.id && s.name),
  })).filter(g => g.name && g.subs.length);
}

function parseLrDetail(html) {
  const doc = toDoc(html);
  const el = doc.querySelector('.blockBook') || doc.body;
  const about = el.querySelector('.blAboutBook');
  const paras = [...el.querySelectorAll('.blTextBook p')]
    .map(p => p.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return {
    id: ((el.querySelector('a[href*="read_book.php"]')?.getAttribute('href') || '').match(/[?&]id=(\d+)/) || [])[1] || '',
    title: el.querySelector('.blNameBook h3, .blNameBook h2')?.textContent.trim() || '',
    author: about?.querySelector('a[href*="biography-author"] strong, a[href*="biography-author"]')?.textContent.trim() || '',
    cover: about?.querySelector('img.book-cover')?.getAttribute('src') || '',
    genres: [...el.querySelectorAll('.blGenres a')].map(a => a.textContent.replace(/[«»]/g, '').trim()).filter(Boolean),
    year: lrField(about, 'Год'),
    pages: lrField(about, 'Страниц'),
    readTime: lrField(about, 'Время чтения'),
    description: paras.join('\n\n'),
  };
}

function parseLrAuthor(html, name) {
  const doc = toDoc(html);
  const seen = new Set();
  return [...doc.querySelectorAll('.indoorUnit .openBook a[href*="book-comments.php"]')]
    .map(a => {
      const href = a.getAttribute('href') || '';
      const id = (href.match(/[?&]book=(\d+)/) || [])[1] || '';
      const title = String(a.getAttribute('title') || a.textContent || '')
        .replace(/^(?:Онлайн\s+)?Книга\s*[«"]?/i, '')
        .replace(/[»"]$/, '')
        .trim();
      const cover = a.closest('.bodyUnit')?.querySelector('.coverBook img')?.getAttribute('src') || '';
      if (!id || !title || seen.has(id)) return null;
      seen.add(id);
      return { id, title, author: name, cover, genre: '', time: '' };
    })
    .filter(Boolean);
}

function parseLrPage(html) {
  const doc = toDoc(html);
  const main = doc.querySelector('#readerContent');
  const blocks = [];
  if (main) {
    // Текущая разметка: <p class=MsoNormal>. Старая (book-paragraph/book-title) оставлена на случай отката.
    main.querySelectorAll('.book-title, .book-paragraph, .MsoNormal').forEach(el => {
      const text = (el.querySelector('.book-title-line') || el).textContent.replace(/\s+/g, ' ').trim();
      if (text) blocks.push({ t: el.classList.contains('book-title') ? 'h' : 'p', x: text });
    });
  }
  const page = Number((doc.querySelector('.number-page-book')?.textContent.match(/(\d+)/) || [])[1]) || 1;
  const nums = [...doc.querySelectorAll('.navigation a')]
    .map(a => Number(((a.getAttribute('href') || '').match(/[?&]p=(\d+)/) || [])[1])).filter(Boolean);
  const head = doc.querySelector('h1')?.textContent.trim() || '';
  return {
    page,
    total: Math.max(page, ...nums, 1),
    blocks,
    title: head.replace(/^Книга\s+/, '').replace(/,\s*страница\s+\d+\s*[–-].*$/i, '').trim(),
    author: (head.match(/страница\s+\d+\s*[–-]\s*(.+)$/i) || [])[1]?.trim() || '',
  };
}

/* ---------- 7. API ---------- */

/* Загрузка с кэшем: свежие данные не запрашиваем повторно, а если источник
   недоступен — отдаём то, что уже сохранили, вместо экрана ошибки. */
async function cached(key, ttl, loader, valid) {
  const hit = store.get(key);
  if (hit) return hit;
  const stale = store.getStale(key);
  try {
    const data = await loader();
    if (!valid || valid(data)) { store.set(key, data, ttl); return data; }
    // Ответ не похож на настоящую страницу (заглушка источника) — берём сохранённую копию.
    return stale || data;
  } catch (e) {
    if (stale) return stale;
    throw e;
  }
}

const apiList = (cat, page = 1) =>
  cached(
    `list:${cat}:${page}`, TTL.list,
    async () => parseListing(await fetchText(`${SRC.list}/${cat}/${page > 1 ? '?page=' + page : ''}`)),
    d => d.items.length
  );

const apiGenres = () =>
  cached(
    'genres', TTL.genres,
    async () => parseGenres(await fetchText(`${SRC.list}/genres/`)),
    d => d.length
  );

const apiGenre = (slug, page = 1) =>
  cached(
    `genre:${slug}:${page}`, TTL.list,
    async () => parseListing(await fetchText(`${SRC.list}/genre/${slug}/${page > 1 ? '?page=' + page : ''}`)),
    d => d.items.length
  );

const apiSearch = (query, page = 1) =>
  cached(
    `search:${query}:${page}`, TTL.search,
    async () => parseListing(await fetchText(`${SRC.list}/search/?q=${encodeURIComponent(query)}${page > 1 ? '&page=' + page : ''}`)),
    d => d.items.length
  );

async function apiBook(slug) {
  const key = 'book:' + slug;
  const hit = store.get(key);
  if (hit) return hit;
  const backup = () => store.getStale(key) || dl.offlineBook(slug);
  try {
    const data = parseBook(await fetchText(`${SRC.book}/book/${slug}/`), { slug });
    if (data.title && data.chapters.length) { store.set(key, data, TTL.book); return data; }
    return backup() || data;
  } catch (e) {
    // Источник недоступен — берём сохранённую копию или скачанную для офлайна книгу.
    const saved = backup();
    if (saved) return saved;
    throw e;
  }
}

const errorText = e => {
  if (navigator.onLine === false) return 'Нет подключения к интернету. Скачанные книги — во вкладке «Офлайн».';
  if (e && e.message === 'limit') return 'Источник ограничивает частоту запросов. Подождите минуту.';
  return 'Не удалось загрузить данные. Проверьте подключение.';
};

/* --- LoveRead: читабельные книги --- */

const apiLrList = (page = 1) => {
  // Свежие поступления отдаются только на главной loveread.ec; пагинации у списка нет.
  if (page > 1) return Promise.resolve([]);
  return cached('lr:list:1', TTL.lr, async () => parseLrList(await fetchText(SRC_READ + '/')), d => d.length);
};

const apiLrGenres = () =>
  cached('lr:genres', TTL.genres, async () => parseLrGenres(await fetchText(SRC_READ + '/')), d => d.length);

const apiLrGenre = (id, page = 1) =>
  cached(
    `lr:genre:${id}:${page}`, TTL.lr,
    async () => parseLrList(await fetchText(`${SRC_READ}/genre.php?genre=${id}${page > 1 ? '&page=' + page : ''}`)),
    d => d.length
  );

const apiLrDetail = (id) =>
  cached('lr:book:' + id, TTL.lrbook, async () => parseLrDetail(await fetchText(`${SRC_READ}/book-comments.php?book=${id}`)), d => d.title);

const apiLrAuthor = (id, name) =>
  cached(`lr:author:${id}`, TTL.lr, async () => parseLrAuthor(await fetchText(`${SRC_READ}/books.php?id_author=${encodeURIComponent(id)}`), name), d => d.length);

async function apiLrPage(id, page = 1) {
  const key = `lr:page:${id}:${page}`;
  const hit = store.get(key);
  if (hit) return hit;
  const off = await cacheGetText(DATA_CACHE, offPageKey(id, page));   // скачано для офлайна
  if (off) {
    const data = parseLrPage(off);
    if (data.blocks.length) { store.set(key, data, TTL.lrpage); return data; }
  }
  try {
    const data = parseLrPage(await fetchText(`${SRC_READ}/read_book.php?id=${id}&p=${page}`));
    if (data.blocks.length) store.set(key, data, TTL.lrpage);
    return data;
  } catch (e) {
    const stale = store.getStale(key);
    if (stale) return stale;
    throw e;
  }
}

/* ---------- 7½. Менеджер загрузок (офлайн) ---------- */

function fmtETA(sec) {
  if (!isFinite(sec) || sec <= 0) return '~1 мин';
  if (sec < 90) return '~1 мин';
  const m = Math.round(sec / 60);
  if (m < 60) return '~' + m + ' мин';
  return '~' + (m / 60).toFixed(1).replace('.0', '') + ' ч';
}

const dlIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11M12 14l-4.5-4.5M12 14l4.5-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16.5v2A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function dlLabel(meta) {
  if (!meta) return 'Скачать для офлайна';
  if (meta.status === 'done') return 'Скачано · удалить';
  if (meta.status === 'paused') return `Продолжить загрузку (${meta.done}/${meta.total})`;
  return 'Скачивается…';
}

const dl = {
  task: null,   // { id, title, kind, total, done, t0, cancel, fails }

  busy() { return !!this.task; },
  meta(id) { return store.get('dl:' + id) || null; },
  // Книга, сохранённая вместе с загрузкой — из неё собирается вкладка «Офлайн».
  offlineBook(id) { const m = store.getStale('dl:' + id); return (m && m.book) || null; },
  // Все скачанные аудиокниги (для вкладки «Офлайн»).
  offlineList() {
    return Object.keys(localStorage)
      .filter(k => k.startsWith('polka:dl:'))
      .map(k => {
        const id = k.slice('polka:dl:'.length);
        if (/^r\d+$/.test(id)) return null;                       // это читалка, не аудио
        const m = store.getStale('dl:' + id);
        if (!m || m.status !== 'done') return null;
        const b = m.book || store.getStale('book:' + id);
        if (!b || !b.title) return null;
        return {
          ...b,
          slug: b.slug || id,
          author: b.author || (b.authors && b.authors[0]) || '',
          reader: b.reader || (b.readers && b.readers[0]) || '',
        };
      })
      .filter(Boolean);
  },

  // Скачанные для чтения книги (для вкладок «Офлайн» и «Библиотека»).
  offlineReadList() {
    return Object.keys(localStorage)
      .filter(k => /^polka:dl:r\d+$/.test(k))
      .map(k => {
        const id = k.slice('polka:dl:r'.length);
        const m = store.getStale('dl:r' + id);
        if (!m || m.status !== 'done') return null;
        const b = m.book || {};
        if (!b.title) return null;
        return {
          id,
          title: b.title,
          author: b.author || '',
          cover: b.cover || '',
          genre: (b.genres && b.genres[0]) || '',
          time: b.readTime || '',
        };
      })
      .filter(Boolean);
  },

  async audio(book) {
    if (this.busy()) return toast('Уже идёт другая загрузка');
    const total = book.chapters.length;
    const prev = this.meta(book.slug) || {};
    if (prev.status === 'done') return;
    const t = this.task = { id: book.slug, title: book.title, kind: 'audio', total, done: prev.done || 0, t0: Date.now(), cancel: false, fails: 0 };
    this.paint();
    try {
      const c = await caches.open(MEDIA_CACHE);
      for (let i = t.done; i < total; i++) {
        if (t.cancel) break;
        try {
          const res = await fetch(book.chapters[i].url, { mode: 'no-cors' });
          await c.put(book.chapters[i].url, res);
          t.fails = 0;
        } catch { if (++t.fails > 3) throw new Error('quota'); }
        t.done = i + 1;
        this.paint();
      }
      await cacheCover(coverImg(book.cover));   // обложка — тоже на устройство
      const status = t.cancel ? 'paused' : 'done';
      store.set('dl:' + t.id, { status, total, done: t.done, title: t.title, book }, 365 * 24 * 3600e3);
      toast(status === 'done' ? 'Готово — можно слушать без сети' : 'Загрузка остановлена');
    } catch {
      store.set('dl:' + t.id, { status: 'paused', total, done: t.done, title: t.title, book }, 365 * 24 * 3600e3);
      toast('Загрузка не удалась — возможно, мало места');
    } finally { this.task = null; this.paint(); }
  },

  async reader(id, book) {
    if (this.busy()) return toast('Уже идёт другая загрузка');
    const title = (book && book.title) || '';
    const prev = this.meta('r' + id) || {};
    if (prev.status === 'done') return;
    const t = this.task = { id: 'r' + id, title, kind: 'read', total: prev.total || 1, done: prev.done || 0, t0: Date.now(), cancel: false };
    this.paint();
    const meta = status => ({
      status, total: t.total, done: t.done, title, kind: 'read',
      book: book ? { id, title: book.title, author: book.author, cover: book.cover, genres: book.genres, readTime: book.readTime } : (prev.book || null),
    });
    try {
      if (t.total <= 1 && !t.done) {
        const first = await fetchText(`${SRC_READ}/read_book.php?id=${id}&p=1`);
        if (!await cachePutText(DATA_CACHE, offPageKey(id, 1), first)) throw new Error('quota');
        t.total = parseLrPage(first).total || 1;
        t.done = 1;
        this.paint();
      }
      for (let p = t.done + 1; p <= t.total; p++) {
        if (t.cancel) break;
        const html = await fetchText(`${SRC_READ}/read_book.php?id=${id}&p=${p}`);
        if (!await cachePutText(DATA_CACHE, offPageKey(id, p), html)) throw new Error('quota');
        t.done = p;
        this.paint();
        await sleep(500);   // бережём лимиты шлюза
      }
      await cacheCover(lrCover(book && book.cover));   // обложка — тоже на устройство
      const status = t.cancel ? 'paused' : 'done';
      store.set('dl:' + t.id, meta(status), 365 * 24 * 3600e3);
      toast(status === 'done' ? 'Готово — можно читать без сети' : 'Загрузка остановлена');
    } catch {
      store.set('dl:' + t.id, meta('paused'), 365 * 24 * 3600e3);
      toast('Загрузка не удалась — проверьте связь и попробуйте ещё раз');
    } finally { this.task = null; this.paint(); }
  },

  async remove(id, urls) {
    try {
      const read = /^r\d+$/.test(id);
      const c = await caches.open(read ? DATA_CACHE : MEDIA_CACHE);
      if (read) {
        const keys = await c.keys();
        const prefix = offPagePrefix(id.replace(/^r/, ''));
        await Promise.all(keys.map(k => String(k.url).startsWith(prefix) && c.delete(k)));
      } else if (urls) {
        await Promise.all(urls.map(u => c.delete(u)));
      }
      // вместе с книгой убираем и её обложку
      const book = (store.getStale('dl:' + id) || {}).book || {};
      const cover = read ? lrCover(book.cover) : coverImg(book.cover);
      if (cover) { const dc = await caches.open(DATA_CACHE); await dc.delete(cover); }
    } catch {}
    localStorage.removeItem('polka:dl:' + id);
    toast('Загрузка удалена');
  },

  paint() {
    const card = $('#dl-card');
    if (!card) return;
    const t = this.task;
    if (!t) { card.classList.add('is-hidden'); return; }
    const pct = t.total ? Math.min(100, Math.round(t.done / t.total * 100)) : 0;
    let sub = `${t.done} из ${t.total} · ${pct}%`;
    const el = (Date.now() - t.t0) / 1000;
    const rate = t.done ? t.done / el : 0;
    if (rate > 0 && t.done < t.total) sub += ` · осталось ${fmtETA((t.total - t.done) / rate)}`;
    $('#dl-title').textContent = t.title;
    $('#dl-sub').textContent = sub;
    $('#dl-fill').style.width = pct + '%';
    card.classList.remove('is-hidden');
  },
};

/* ---------- 8. Состояние и роутер ---------- */

const view = $('#view');
const sentinel = $('#sentinel');

const state = {
  route: '',
  cat: 'new',
  back: 'cat/new',   // куда вернуться из поиска
  page: 1,
  items: [],
  loading: false,
  ended: false,
  query: '',
  scroll: {},
  book: null,
  author: null,
  seq: 0,            // токен актуальности рендера списка
};

let observer = null;
let lastLocationHash = null;
let lastRenderedHash = null;     // предыдущий экран — цель кнопок «Назад»

function cleanHash(hash = location.hash) {
  return String(hash || '').replace(/^#/, '').replace(/[?&]gsc\.[^&]*/g, '').replace(/[?&]$/, '');
}

function parseHash() {
  const raw = cleanHash() || '/cat/new';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}

function go(hash, { replace = false } = {}) {
  const url = location.pathname + location.search + '#' + hash;
  history[replace ? 'replaceState' : 'pushState']({ app: true }, '', url);
  lastLocationHash = cleanHash();
  route();
}

/* Кнопка «Назад»: сначала идём по истории браузера — тогда кнопка в приложении
   и системная кнопка ведут себя одинаково. Если истории нет (приложение
   открыли сразу на внутреннем экране) — возвращаемся на запомненный маршрут. */
function goBack(fallback = 'cat/new') {
  if (history.state && history.state.app) history.back();
  else go(state.back || fallback);
}

function saveScroll() {
  if (state.route) state.scroll[state.route] = window.scrollY;
}

function restoreScroll(route) {
  const y = state.scroll[route];
  if (y) requestAnimationFrame(() => window.scrollTo(0, y));
}

function route() {
  saveScroll();
  closeSheet();
  const { parts, q } = parseHash();
  const head = parts[0] || 'cat';
  state.route = head + '/' + (parts[1] || '');
  // Куда вернут кнопки «Назад»: экран, с которого пришли.
  const here = cleanHash();
  if (lastRenderedHash && lastRenderedHash !== here) state.back = lastRenderedHash;
  lastRenderedHash = here;
  window.scrollTo(0, 0);
  document.title = 'Bookify';
  disconnectObserver();

  const searching = head === 'search';
  const detail = head === 'book' || head === 'rbook' || head === 'rread';
  const reader = head === 'rread';
  const home = head === 'cat' && (parts[1] || 'new') === 'new';
  const offline = document.body.classList.contains('is-offline');
  const isCat = head === 'cat' || head === 'genres' || head === 'genre';
  // На профиле и полке режим каталога не влияет на содержимое страницы.
  if (!['my', 'lib', 'library'].includes(head)) applyMode(READ_HEADS.includes(head) || (head === 'author' && q.get('mode') === 'read') ? 'read' : 'listen');
  rdPage(reader);   // тема страницы — только в читалке
  // В читалке не должно быть ничего лишнего: только текст и кнопка настроек.
  document.body.classList.toggle('is-reader', reader);
  document.body.classList.toggle('is-home', home);
  $('#topbar').classList.toggle('is-hidden', reader);
  $('#headbar').classList.toggle('is-hidden', detail || reader || offline || home || !(isCat || searching));
  $('#tabbar').classList.toggle('is-hidden', detail || reader);
  $('#chips').classList.toggle('is-hidden', searching);
  $('#search-bar').classList.toggle('is-hidden', !searching);
  markTab(head, parts[1]);
  markTabbar(head, parts[1]);

  if (head === 'cat') return parts[1] === 'offline' ? renderOffline() : renderCatalog(parts[1] || 'new');
  if (head === 'genres') return renderGenres();
  if (head === 'genre') return renderGenre(parts[1], parts[2] || '');
  if (head === 'search') return openSearch(q.get('q') || '');
  if (head === 'author') return renderAuthor(decodeURIComponent(parts[1] || ''), q.get('mode') || 'audio', q.get('query') || '');
  if (head === 'book') return renderBook(parts[1]);
  if (head === 'my') return renderMy();
  if (head === 'lib') return renderShelf();
  if (head === 'library') return renderLibrary();
  if (head === 'read') return renderReadList();
  if (head === 'rgenres') return renderReadGenres();
  if (head === 'rgenre') return renderReadGenre(parts[1], decodeURIComponent(parts[2] || ''));
  if (head === 'rbook') return renderReadBook(parts[1]);
  if (head === 'rread') return renderReader(parts[1], Number(parts[2]) || 1);
  go('cat/new', { replace: true });
}

const READ_HEADS = ['read', 'rgenres', 'rgenre', 'rbook', 'rread'];

/* Режим библиотеки: 'listen' (аудио) или 'read' (книги для чтения) */
function applyMode(mode) {
  document.body.dataset.mode = mode;
  localStorage.setItem('polka:mode', mode);
}

function markTab(head, param) {
  const mode = document.body.dataset.mode || 'listen';
  $$('.chip-tab').forEach(t => {
    let on = false;
    if (t.dataset.m === mode) {
      const cat = t.dataset.cat;
      on = mode === 'listen'
        ? (cat === 'genres' && (head === 'genres' || head === 'genre'))
          || (head === 'cat' && cat === (param || 'new'))
        : (cat === 'new' && head === 'read')
          || (cat === 'genres' && (head === 'rgenres' || head === 'rgenre'));
    }
    t.classList.toggle('is-active', on);
  });
}

/* Активный пункт нижнего таб-бара. */
function markTabbar(head, param) {
  let key = 'cat';
  if (head === 'my') key = 'my';
  else if (head === 'lib') key = 'lib';
  else if (head === 'library' || head === 'author' || head === 'genres' || head === 'genre' || head === 'rgenres' || head === 'rgenre' || head === 'read' || (head === 'cat' && param === 'offline')) key = 'library';
  $$('.tabbar-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === key));
}

/* Офлайн-режим: без сети остаётся только «Офлайн» и приложение переходит туда. */
function netUpdate() {
  const off = !navigator.onLine;
  document.body.classList.toggle('is-offline', off);
  const { parts } = parseHash();
  const head = parts[0] || '';
  const main = ['', 'cat', 'genres', 'genre', 'search'].includes(head);
  if (off) {
    if (main) go('cat/offline', { replace: true });
    else route();                       // обновляем таб-бар, не срывая чтение книги
  } else if (head === 'cat' && parts[1] === 'offline') {
    go('cat/new');                      // сеть вернулась — уходим с офлайн-экрана
  } else {
    route();
  }
}

/* ---------- 9. Отрисовка ---------- */

const clockIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M9 7H11V12H16V14H9V7Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z" fill="currentColor"/></svg>';
const playIcon = '<svg viewBox="3 2 18 20" fill="none"><path d="M15 12.3301L9 16.6603L9 8L15 12.3301Z" fill="currentColor"/></svg>';

const authorHref = (name, mode) => `#/author/${encodeURIComponent(name)}?mode=${mode}`;

const cardHTML = (b, i) => `
  <a class="card" style="--i:${i}" data-slug="${esc(b.slug)}" href="#/book/${esc(b.slug)}">
    <div class="cover">
      ${b.cover ? `<img src="${esc(coverImg(b.cover))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
      <span class="spine"></span>
      <span class="shine"></span>
      ${b.genre ? `<span class="genre-pill">${esc(b.genre)}</span>` : ''}
      ${b.time ? `<span class="dur-pill">${clockIcon}${esc(b.time)}</span>` : ''}
      <span class="play-fab">${playIcon}</span>
      <span class="eq"><i></i><i></i><i></i></span>
    </div>
    <div class="card-title">${esc(b.title)}</div>
    <div class="card-sub">${esc(b.author || b.reader || '')}</div>
  </a>`;

/* Карточка читабельной книги (LoveRead): тот же вид, но без плеера и длительности. */
const bookIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 7.5v6.2M9 7.5l4.6 2.4L9 12.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const readerCardHTML = (b, i) => `
  <a class="card rcard" style="--i:${i}" data-id="${esc(b.id)}" href="#/rbook/${esc(b.id)}">
    <div class="cover">
      ${b.cover ? `<img src="${esc(lrCover(b.cover))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
      <span class="spine"></span>
      <span class="shine"></span>
      ${b.genre ? `<span class="genre-pill">${esc(b.genre)}</span>` : ''}
      ${b.time ? `<span class="dur-pill">${clockIcon}${esc(b.time)}</span>` : ''}
    </div>
    <div class="card-title">${esc(b.title)}</div>
    <div class="card-sub">${esc(b.author || '')}</div>
  </a>`;

/* Подсветка карточки текущей книги */
function syncPlaying() {
  const slug = (player.book && player.book.slug) || '';
  const on = document.body.classList.contains('playing');
  $$('.card').forEach(c => {
    c.classList.toggle('is-playing', !!on && !!slug && c.dataset.slug === slug);
  });
}

const skeletonHTML = (n = 8) => `
  <div class="grid">${Array.from({ length: n }, () => `
    <div class="card" style="--i:0">
      <div class="cover sk" style="animation:none"></div>
      <div class="sk" style="height:13px;width:88%"></div>
      <div class="sk" style="height:11px;width:56%"></div>
    </div>`).join('')}
  </div>`;

const stateHTML = (title, text, action) => `
  <div class="state"><b>${esc(title)}</b>${esc(text || '')}
    ${action ? `<button id="state-action">${esc(action.label)}</button>` : ''}
  </div>`;

function spinner() { $('#tail').innerHTML = '<div class="spinner"></div>'; }
function clearTail() { $('#tail').innerHTML = ''; }

/* Карточки «Продолжить»: последняя аудиокнига и книги, которые читали */
function continueListenHTML() {
  const last = store.get('last');
  if (!last || !last.chapters || !last.chapters.length) return '';
  const ch = last.chapters[Math.min(last.index || 0, last.chapters.length - 1)] || {};
  const total = Number(ch.duration) || 0;
  const pct = total ? Math.min(100, Math.round((Number(last.position) || 0) / total * 100)) : 0;
  return `<div class="section-title">Продолжить слушать</div>
    <button class="cont-card cont-listen" id="cont-listen">
      ${last.cover ? `<img src="${esc(coverImg(last.cover))}" alt="" referrerpolicy="no-referrer">` : ''}
      <span class="cont-meta"><span class="cont-title">${esc(last.title)}</span>
      <span class="cont-sub">${esc(ch.title || '')}</span></span>
      <span class="cont-bar"><i style="width:${pct}%"></i></span>
    </button>`;
}

function continueReadHTML(title = 'Продолжить чтение', limit = 4, exclude = null) {
  const items = startedReadItems(limit, exclude);
  if (!items.length) return '';
  return `<div class="section-title">${esc(title)}</div>
    <div class="cont-grid">${items.map(v => {
      const pct = v.t ? Math.min(100, Math.round(v.p / v.t * 100)) : 0;
      return `<button class="cont-card" data-id="${esc(v.id)}" data-p="${v.p}">
        <span class="cont-title">${esc(v.title)}</span>
        <span class="cont-sub">стр. ${v.p} из ${v.t || '—'} · ${pct}%</span>
        <span class="cont-bar"><i style="width:${pct}%"></i></span>
      </button>`;
    }).join('')}</div>`;
}

/* Начатые книги для чтения — свежие сверху. */
function startedReadItems(limit = 4, exclude = null) {
  return Object.keys(localStorage)
    .filter(k => k.startsWith('polka:lr:pos:'))
    .map(k => { try { const r = JSON.parse(localStorage.getItem(k)); return { id: k.slice('polka:lr:pos:'.length), e: r.e, ...r.d }; } catch { return null; } })
    .filter(v => v && v.title && v.p > 1 && !(exclude && exclude.has(v.id)))
    .sort((a, b) => b.e - a.e)
    .slice(0, limit);
}

function bindContinueRead() {
  $$('.cont-card[data-id]').forEach(el => el.onclick = () => {
    const id = el.dataset.id;
    const pos = store.get('lr:pos:' + id) || {};
    const p = Number(el.dataset.p) || 1;
    if (pos.c > 0 && pos.p === p) pendingSpot = { id, p, c: pos.c };
    go(`rread/${id}/${p}`);
  });
}

const homeCardHTML = (b, i) => `
  <a class="home-book" style="--i:${i}" href="#/book/${esc(b.slug)}" aria-label="${esc(b.title)}">
    <div class="home-book-cover">
      ${b.cover ? `<img src="${esc(coverImg(b.cover))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
      ${i < 2 ? `<span class="home-book-badge">${i === 0 ? 'Популярное' : 'Выбор читателей'}</span>` : ''}
      <span class="home-book-open">${playIcon}</span>
    </div>
    <span class="home-book-title">${esc(b.title)}</span>
    <span class="home-book-author">${esc(b.author || b.reader || '')}</span>
    ${b.time ? `<span class="home-book-time">${clockIcon}${esc(b.time)}</span>` : ''}
  </a>`;

const homeReadCardHTML = (b, i) => `
  <a class="home-book home-read-book" style="--i:${i}" href="#/rbook/${esc(b.id)}" aria-label="${esc(b.title)}">
    <div class="home-book-cover">
      ${b.cover ? `<img src="${esc(lrCover(b.cover))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
      <span class="home-book-badge">Читать</span>
      <span class="home-book-open">${bookIcon}</span>
    </div>
    <span class="home-book-title">${esc(b.title)}</span>
    <span class="home-book-author">${esc(b.author || '')}</span>
    ${b.time ? `<span class="home-book-time">${clockIcon}${esc(b.time)}</span>` : ''}
  </a>`;

function homeShellHTML() {
  return `
    <section class="home-hero">
      <div class="home-hero-image"></div>
      <div class="home-hero-copy">
        <span class="home-kicker">BOOKIFY · ТВОЯ БИБЛИОТЕКА</span>
        <h1>Твой мир<br>в книгах</h1>
        <p>Выбирай историю, которая<br>подходит именно тебе</p>
        <button class="home-cta" id="home-start">Открыть библиотеку <span>›</span></button>
      </div>
    </section>
    <section class="home-section">
      <div class="home-section-head"><h2><i>🔥</i> Популярное сегодня</h2><button data-home="popular">Все <span>→</span></button></div>
      <div class="home-books" id="home-books">${Array.from({ length: 4 }, () => '<div class="home-book-skeleton"><i></i><b></b><small></small></div>').join('')}</div>
    </section>
    <section class="home-section home-reading">
      <div class="home-section-head"><h2><i>📖</i> Книги для чтения</h2><button data-home="read">Все <span>→</span></button></div>
      <div class="home-books" id="home-read-books">${Array.from({ length: 4 }, () => '<div class="home-book-skeleton"><i></i><b></b><small></small></div>').join('')}</div>
    </section>
    <section class="home-section home-recommend">
      <div class="home-section-head"><h2><i>⭐</i> Жанры</h2><button data-home="genres">Все <span>→</span></button></div>
      <div class="home-genres">
        <button class="is-active" data-home="genres"><span>✦</span>Фантастика</button>
        <button data-home="genres"><span>⌕</span>Детектив</button>
        <button data-home="genres"><span>♡</span>Романтика</button>
        <button data-home="genres"><span>▤</span>Приключения</button>
        <button data-home="genres"><span>❋</span>История</button>
      </div>
    </section>
    <div class="home-extra">${continueListenHTML()}${continueReadHTML('Продолжить чтение', 2)}</div>`;
}

function bindHome() {
  $('#home-start')?.addEventListener('click', () => go('library'));
  $$('[data-home]').forEach(btn => btn.addEventListener('click', () => {
    const action = btn.dataset.home;
    if (action === 'popular') { applyMode('listen'); go('cat/popular'); }
    else if (action === 'read') { applyMode('read'); go('read'); }
    else if (action === 'genres') go('library');
    else go('cat/new');
  }));
  const cl = $('#cont-listen');
  if (cl) cl.onclick = () => {
    if (player.book) return openSheet();
    if (loadLast({ autoplay: true })) openSheet();
  };
  bindContinueRead();
}

async function renderHome(seq) {
  state.cat = 'new';
  state.back = 'cat/new';
  state.items = [];
  state.page = 1;
  state.ended = true;
  state.loading = false;
  view.innerHTML = homeShellHTML();
  clearTail();
  bindHome();
  try {
    const [popular, fresh, readable] = await Promise.all([
      apiList('popular', 1).catch(() => ({ items: [] })),
      apiList('new', 1).catch(() => ({ items: [] })),
      apiLrList(1).catch(() => []),
    ]);
    if (seq !== state.seq) return;
    const items = (popular.items.length ? popular.items : fresh.items).slice(0, 8);
    const books = $('#home-books');
    if (books) books.innerHTML = items.length
      ? items.map(homeCardHTML).join('')
      : '<div class="home-empty">Подборка появится, когда каталог будет доступен.</div>';
    const readBooks = $('#home-read-books');
    if (readBooks) readBooks.innerHTML = readable.length
      ? readable.slice(0, 8).map(homeReadCardHTML).join('')
      : '<div class="home-empty">Подборка книг для чтения появится, когда каталог будет доступен.</div>';
    state.items = items;
    restoreScroll(state.route);
  } catch {
    const books = $('#home-books');
    if (books) books.innerHTML = '<div class="home-empty">Не удалось загрузить подборку.</div>';
  }
}

/* ---------- 10. Каталог ---------- */

async function renderCatalog(cat) {
  const seq = ++state.seq;
  state.cat = cat;
  state.back = 'cat/' + cat;
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  if (cat === 'new') return renderHome(seq);
  view.innerHTML = skeletonHTML();
  clearTail();
  try {
    const { items } = await apiList(cat, 1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = stateHTML('Пусто', 'Каталог не вернул книг.'); return; }
    state.items = items;
    view.innerHTML = `${continueListenHTML()}<div class="grid">${items.map(cardHTML).join('')}</div>`;
    const cl = $('#cont-listen');
    if (cl) cl.onclick = () => {
      if (player.book) return openSheet();
      if (loadLast({ autoplay: true })) openSheet();   // плеер был закрыт — поднимаем книгу снова
    };
    syncPlaying();
    state.ended = items.length < 10;
    restoreScroll(state.route);
    if (!state.ended) observeMore(() => loadMore('list', cat));
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderCatalog(cat);
  }
}

/* ---------- 10.5 Слушать офлайн ---------- */
/* Показываем только книги, целиком скачанные для прослушивания без интернета. */

const trashIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 7h12M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7m-6 0 .8 12.1A1.9 1.9 0 0 0 10.7 21h2.6a1.9 1.9 0 0 0 1.9-1.9L16 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Сетка скачанных аудиокниг с кнопкой удаления на каждой. */
function offlineGridHTML(list) {
  return `<div class="grid">${list.map((b, i) => `
    <div class="ocard">
      ${cardHTML(b, i)}
      <button class="ocard-del" data-del="${esc(b.slug)}" aria-label="Удалить из офлайна" title="Удалить из офлайна">${trashIcon}</button>
    </div>`).join('')}</div>`;
}

function bindOfflineDel(list, refresh) {
  $$('.ocard-del[data-del]').forEach(btn => btn.onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    const slug = btn.dataset.del;
    const book = list.find(x => x.slug === slug);
    if (!confirm(`Удалить «${(book && book.title) || slug}» из офлайна?`)) return;
    const saved = dl.offlineBook(slug) || book;
    const urls = saved && saved.chapters ? saved.chapters.map(c => c.url) : null;
    if (player.book && player.book.slug === slug) player.close();
    await dl.remove(slug, urls);
    refresh();
  });
}

/* Сетка скачанных книг для чтения — те же карточки, что и в каталоге. */
function offlineReadGridHTML(list) {
  return `<div class="grid">${list.map((b, i) => `
    <div class="ocard">
      ${readerCardHTML(b, i)}
      <button class="ocard-del" data-rdel="${esc(b.id)}" aria-label="Удалить из офлайна" title="Удалить из офлайна">${trashIcon}</button>
    </div>`).join('')}</div>`;
}

function bindOfflineReadDel(list, refresh) {
  $$('.ocard-del[data-rdel]').forEach(btn => btn.onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    const id = btn.dataset.rdel;
    const book = list.find(x => x.id === id);
    if (!confirm(`Удалить «${(book && book.title) || id}» из офлайна?`)) return;
    await dl.remove('r' + id, null);
    refresh();
  });
}

function renderOffline() {
  ++state.seq;                 // отменяем незавершённые загрузки предыдущего экрана
  state.cat = 'offline';
  state.back = 'cat/offline';
  state.items = [];
  state.ended = true;          // вкладка без пагинации
  state.loading = false;
  clearTail();
  const audio = dl.offlineList();
  const books = dl.offlineReadList();
  if (!audio.length && !books.length) {
    view.innerHTML = stateHTML(
      'Пока пусто',
      'Откройте книгу и нажмите «Скачать для офлайна» — она появится здесь и будет доступна без интернета.'
    );
    return;
  }
  view.innerHTML =
    (audio.length ? `<div class="section-title">Слушать офлайн</div>${offlineGridHTML(audio)}` : '') +
    (books.length ? `<div class="section-title">Читать офлайн</div>${offlineReadGridHTML(books)}` : '');
  bindOfflineDel(audio, renderOffline);
  bindOfflineReadDel(books, renderOffline);
  syncPlaying();
}

/* ---------- 10.6 Мои книги и Библиотека ---------- */

function bindContinueListen() {
  const cl = $('#cont-listen');
  if (cl) cl.onclick = () => {
    if (player.book) return openSheet();
    if (loadLast({ autoplay: true })) openSheet();   // плеер был закрыт — поднимаем книгу снова
  };
}

/* Профиль: имя аккаунта и личная статистика. */
function renderMy() {
  renderProfile();
}

function profileProgressHTML() {
  const list = Object.values(shelf)
    .filter(e => e && e.id && Number(e.prog && e.prog.pct) > 0 && Number(e.prog.pct) < 100)
    .sort((a, b) => Number(b.prog.pct) - Number(a.prog.pct))
    .slice(0, 8);
  return list.length ? list.map(e => {
    const pct = Math.max(0, Math.min(100, Math.round(Number(e.prog.pct) || 0)));
    const href = e.kind === 'audio' ? `#/book/${esc(e.id)}` : `#/rbook/${esc(e.id)}`;
    return `<a class="profile-progress-row" href="${href}">
      <span class="profile-progress-type">${e.kind === 'audio' ? 'Аудио' : 'Чтение'}</span>
      <span class="profile-progress-main"><b>${esc(e.title || 'Без названия')}</b><span class="profile-progress-track"><i style="width:${pct}%"></i></span></span>
      <span class="profile-progress-pct">${pct}%</span>
    </a>`;
  }).join('') : '<div class="profile-no-progress">Прогресс появится здесь, когда вы начнёте читать или слушать книгу с полки.</div>';
}

function profileHTML() {
  const initial = ((acc.name || 'Ч').trim().charAt(0) || 'Ч').toUpperCase();
  return `<section class="profile-card">
    <div class="profile-identity">
      <div class="profile-avatar" id="profile-avatar">${esc(initial)}</div>
      <div class="profile-who">
        <label class="profile-label" for="profile-name">Ваш профиль</label>
        <input class="profile-name" id="profile-name" value="${esc(acc.name || '')}" placeholder="Ваше имя" maxlength="40" />
        <div class="profile-id">ID <b>${esc(acc.uid)}</b></div>
      </div>
    </div>
    <div class="profile-actions">
      <button class="profile-action" id="profile-creds">Данные для входа</button>
      <button class="profile-action" id="profile-copy">Скопировать ID</button>
      <button class="profile-action is-danger" id="profile-logout">Выйти</button>
    </div>
    <div class="profile-sync"><span class="profile-sync-dot"></span><span id="shelf-sync">${esc(syncText(syncState))}</span></div>
  </section>
  <section class="profile-stats" aria-label="Статистика чтения">
    <article class="profile-stat profile-stat-time"><span class="profile-stat-icon">◷</span><small>В приложении</small><b id="profile-hours">${esc(profileHours())}</b></article>
    <article class="profile-stat profile-stat-done"><span class="profile-stat-icon">✓</span><small>Завершено</small><b><span id="profile-completed">${profileCompletedCount()}</span> книг</b></article>
    <article class="profile-stat profile-stat-progress"><span class="profile-stat-icon">↗</span><small>В процессе</small><b><span id="profile-progress-count">${Object.values(shelf).filter(e => e && Number(e.prog && e.prog.pct) > 0 && Number(e.prog.pct) < 100).length}</span> книг</b></article>
  </section>
  <section class="profile-progress">
    <div class="profile-section-title"><div><span class="library-eyebrow">ТВОЁ ЧТЕНИЕ</span><h2>Прогресс книг</h2></div><a href="#/lib">Моя полка <span>→</span></a></div>
    <div id="profile-progress-list">${profileProgressHTML()}</div>
  </section>`;
}

function renderProfile() {
  ++state.seq;
  state.cat = 'profile';
  state.back = 'my';
  state.items = [];
  state.ended = true;
  state.loading = false;
  clearTail();
  if (!acc) {
    view.innerHTML = stateHTML('Нужен вход', 'Войдите в аккаунт, чтобы открыть профиль.');
    return;
  }
  view.innerHTML = profileHTML();
  bindProfile();
}

function bindProfile() {
  const name = $('#profile-name');
  name.addEventListener('change', () => {
    acc.name = name.value.trim().slice(0, 40) || ('Читатель ' + acc.uid.slice(-4));
    name.value = acc.name;
    const avatar = $('#profile-avatar');
    if (avatar) avatar.textContent = acc.name.charAt(0).toUpperCase();
    accSave();
    pushName();
  });
  $('#profile-creds').onclick = () => showCreds(acc.uid, null, acc.name);
  $('#profile-copy').onclick = async () => toast(await copyText(acc.uid) ? 'ID скопирован' : 'Не удалось скопировать');
  $('#profile-logout').onclick = () => { if (confirm('Выйти из аккаунта?')) logout(); };
}

/* «Моя полка» — сохранённые книги и прогресс (см. раздел 17.5). */

/* ---------- 11. Жанры ---------- */

const arrowIcon = '<svg class="arrow" viewBox="0 0 24 24" fill="none"><path d="M10.5858 6.34317L12 4.92896L19.0711 12L12 19.0711L10.5858 17.6569L16.2427 12L10.5858 6.34317Z" fill="currentColor"/></svg>';

function libraryHTML(kind) {
  const reading = kind === 'read';
  return `<section class="library-welcome">
    <span class="library-eyebrow">BOOKIFY · КАТАЛОГ</span>
    <h1>Библиотека</h1>
    <p>Выберите, как хотите провести время с книгой.</p>
  </section>
  <div class="library-switch" id="library-switch" role="tablist" aria-label="Формат книги">
    <button class="library-option ${reading ? '' : 'is-active'}" data-library-kind="audio" role="tab" aria-selected="${!reading}">Аудиокниги</button>
    <button class="library-option ${reading ? 'is-active' : ''}" data-library-kind="read" role="tab" aria-selected="${reading}">Читать</button>
  </div>
  <div class="library-shortcuts">
    ${reading
      ? `<a href="#/read"><span>✦</span><b>Новинки</b><small>Свежие книги</small></a>
         <a href="#/rgenres"><span>⌘</span><b>Все жанры</b><small>Найти свою историю</small></a>`
      : `<a href="#/cat/new"><span>✦</span><b>Новинки</b><small>Недавно добавлены</small></a>
         <a href="#/cat/popular"><span>↗</span><b>Популярное</b><small>Выбор читателей</small></a>
         <a href="#/cat/rating"><span>★</span><b>Рейтинг</b><small>Лучшие оценки</small></a>
         <a href="#/cat/offline"><span>↓</span><b>Офлайн</b><small>Скачанные книги</small></a>`}
  </div>
  <div class="library-genre-heading">
    <div><span class="library-eyebrow">ПОДБОРКИ</span><h2>${reading ? 'Жанры для чтения' : 'Жанры аудиокниг'}</h2></div>
  </div>
  <div id="library-genres" class="library-genres ${reading ? 'is-reading' : ''}">
    ${'<div class="library-genre-skeleton"></div>'.repeat(reading ? 4 : 6)}
  </div>`;
}

async function renderLibrary(kind = document.body.dataset.mode === 'read' ? 'read' : 'audio') {
  const seq = ++state.seq;
  const reading = kind === 'read';
  applyMode(reading ? 'read' : 'listen');
  state.cat = 'library';
  state.back = 'library';
  state.items = [];
  state.ended = true;
  state.loading = false;
  clearTail();
  view.innerHTML = libraryHTML(reading ? 'read' : 'audio');
  $('#library-switch').addEventListener('click', e => {
    const btn = e.target.closest('[data-library-kind]');
    if (btn) renderLibrary(btn.dataset.libraryKind);
  });
  try {
    if (reading) {
      const groups = await apiLrGenres();
      if (seq !== state.seq) return;
      $('#library-genres').innerHTML = groups.length
        ? groups.map((g, i) => `<details class="library-genre-group tone-${i % 6}">
            <summary>
              <span class="library-genre-icon">${['✦','⌕','♡','▤','❋','◈'][i % 6]}</span>
              <span class="library-genre-copy"><b>${esc(g.name)}</b><small>${(g.subs || []).length} жанров</small></span>
              <span class="library-group-arrow">⌄</span>
            </summary>
            <div class="library-genre-children">${(g.subs || []).map(s => `<a href="#/rgenre/${esc(s.id)}/${encodeURIComponent(s.name)}">${esc(s.name)}</a>`).join('')}</div>
          </details>`).join('')
        : '<div class="library-empty">Жанры пока недоступны.</div>';
    } else {
      const genres = await apiGenres();
      if (seq !== state.seq) return;
      $('#library-genres').innerHTML = genres.length
        ? genres.map((g, i) => `<a class="library-genre-card tone-${i % 6}" href="#/genre/${esc(g.slug)}">
            <span class="library-genre-icon">${['✦','⌕','♡','▤','❋','◈'][i % 6]}</span>
            <span class="library-genre-copy"><b>${esc(g.name)}</b><small>${esc(g.count)}</small></span>
            ${arrowIcon}
          </a>`).join('')
        : '<div class="library-empty">Жанры пока недоступны.</div>';
    }
  } catch (e) {
    if (seq !== state.seq) return;
    $('#library-genres').innerHTML = `<div class="library-empty">Не удалось загрузить жанры.<button id="library-retry">Повторить</button></div>`;
    $('#library-retry').onclick = () => renderLibrary(kind);
  }
}

async function renderGenres() {
  const seq = ++state.seq;
  view.innerHTML = `<div class="genre-grid">${'<div class="genre-row sk" style="height:52px;animation:none"></div>'.repeat(8)}</div>`;
  try {
    const genres = await apiGenres();
    if (seq !== state.seq) return;
    view.innerHTML = `<div class="genre-grid">${genres.map(g => `
      <a class="genre-row" href="#/genre/${esc(g.slug)}">
        <span class="genre-name">${esc(g.name)}</span>
        <span class="genre-count">${esc(g.count)}</span>
        ${arrowIcon}
      </a>`).join('')}</div>`;
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderGenres();
  }
}

async function renderGenre(slug, name) {
  if (!slug) return go('genres');
  const seq = ++state.seq;
  state.cat = 'genre';
  state.back = 'genres';
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  view.innerHTML = `<div class="back-btn" id="back">${backIcon}Жанры</div>
    <div class="section-title">${esc(name || slug)}</div>${skeletonHTML()}`;
  $('#back').onclick = () => go('genres');
  try {
    const { items } = await apiGenre(slug, 1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = stateHTML('Пусто', 'В этом жанре пока нет книг.'); return; }
    state.items = items;
    view.innerHTML = `<div class="back-btn" id="back">${backIcon}Жанры</div>
      <div class="section-title">${esc(name || slug)}</div>
      <div class="grid">${items.map(cardHTML).join('')}</div>`;
    $('#back').onclick = () => go('genres');
    syncPlaying();
    state.ended = items.length < 10;
    restoreScroll(state.route);
    if (!state.ended) observeMore(() => loadMore('genre', slug));
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderGenre(slug, name);
  }
}

/* ---------- 12. Поиск ---------- */

// Local SVGs from css.gg (MIT): https://github.com/astrit/css.gg
const backIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.3284 11.0001V13.0001L7.50011 13.0001L10.7426 16.2426L9.32842 17.6568L3.67157 12L9.32842 6.34314L10.7426 7.75735L7.49988 11.0001L20.3284 11.0001Z" fill="currentColor"/></svg>';

/* Кнопка очистки видна, только когда в поле есть текст */
function syncClear() {
  const inp = $('#search-input'), btn = $('#search-clear');
  if (inp && btn) btn.classList.toggle('is-hidden', !inp.value.trim());
}

/* Режим поиска: «audio» — аудиокниги, «read» — книги для чтения. */
let searchMode = localStorage.getItem('polka:smode') === 'read' ? 'read' : 'audio';

function paintSearchMode() {
  $$('#search-modes .search-mode').forEach(b => b.classList.toggle('is-active', b.dataset.sm === searchMode));
  const inp = $('#search-input');
  if (inp) inp.placeholder = searchMode === 'read' ? 'Книга или автор' : 'Книга, автор или чтец';
}

function setSearchMode(m) {
  if (m === searchMode) return;
  searchMode = m;
  try { localStorage.setItem('polka:smode', m); } catch {}
  paintSearchMode();
  if (m === 'read') loadCSE();               // прогреваем поиск книг для чтения заранее
  const input = $('#search-input');
  const q = ((input && input.value) || '').trim();
  if (q.length >= 2) runSearch(q);
  else view.innerHTML = stateHTML('Поиск', searchMode === 'read'
    ? 'Введите название книги или автора — будем искать книги для чтения.'
    : 'Введите название книги, автора или чтеца.');
}

function normalizeAuthorName(value) {
  return String(value || '').toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function authorMatchesQuery(author, query) {
  const name = normalizeAuthorName(author);
  const words = normalizeAuthorName(query).split(/\s+/).filter(Boolean);
  return words.length > 0 && (name.includes(words.join(' ')) || words.every(word => name.includes(word)));
}

function authorCandidates(items, query) {
  if (normalizeAuthorName(query).replace(/\s/g, '').length < 3) return [];
  const found = new Map();
  (items || []).forEach(book => {
    const author = String(book.author || (Array.isArray(book.authors) ? book.authors.join(', ') : book.authors) || '').trim();
    if (!author || !authorMatchesQuery(author, query)) return;
    const key = normalizeAuthorName(author);
    const current = found.get(key) || { name: author, count: 0 };
    current.count++;
    found.set(key, current);
  });
  return [...found.values()].sort((a, b) => b.count - a.count).slice(0, 3);
}

function authorSuggestionHTML(items, query, mode) {
  const candidates = authorCandidates(items, query);
  if (!candidates.length) return '';
  return `<section class="author-suggestions" aria-label="Авторы по запросу">
    <div class="author-suggestions-title">Авторы <span>по вашему запросу</span></div>
    <div class="author-suggestion-list">${candidates.map(a => `
      <a class="author-suggestion" href="#/author/${encodeURIComponent(a.name)}?mode=${mode}&query=${encodeURIComponent(query)}">
        <span class="author-avatar">${esc(a.name.charAt(0).toLocaleUpperCase('ru'))}</span>
        <span class="author-suggestion-copy"><b>${esc(a.name)}</b><small>Автор · ${a.count} ${a.count === 1 ? 'книга в выдаче' : 'книг в выдаче'}</small></span>
        <span class="author-suggestion-arrow">›</span>
      </a>`).join('')}</div>
  </section>`;
}

function showAuthorSuggestions(items, query, mode) {
  const old = view.querySelector('.author-suggestions');
  if (old) old.remove();
  const html = authorSuggestionHTML(items, query, mode);
  if (!html) return;
  const section = document.createElement('div');
  section.innerHTML = html;
  const target = view.querySelector('.section-title');
  view.insertBefore(section.firstElementChild, target || view.firstChild);
}

/* --- Поиск книг для чтения: встроенный Google CSE источника LoveRead --- */
/* Серверную выдачу источник не отдаёт, зато его же поиск (CSE) доступен
   прямо в браузере. Запускаем его в скрытом блоке и превращаем найденные
   ссылки в свои карточки. */

const CSE_CX = 'c549cf6a3e4cc48c6';
let csePromise = null;
let cseSearchDepth = 0;

function cseElement() {
  const api = window.google && google.search && google.search.cse && google.search.cse.element;
  if (!api) return null;
  if (api.getAllElements) {
    const all = api.getAllElements();
    for (const k in all) if (all[k]) return all[k];
  }
  return api.getElement('searchresults-only0') || null;
}

function loadCSE() {
  if (csePromise) return csePromise;
  csePromise = new Promise(resolve => {
    const host = $('#cse-hidden');
    if (!host) return resolve(null);
    if (!host.querySelector('.gcse-searchresults-only'))
      host.innerHTML = '<div class="gcse-searchresults-only" data-enableHistory="false"></div>';
    if (!document.getElementById('cse-js')) {
      const s = document.createElement('script');
      s.id = 'cse-js';
      s.async = true;
      s.src = 'https://cse.google.com/cse.js?cx=' + CSE_CX;
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    }
    // Виджет подключается не сразу — ждём появления элемента, а не момента загрузки скрипта.
    const t0 = Date.now();
    const tick = setInterval(() => {
      const el = cseElement();
      if (el) { clearInterval(tick); resolve(el); }
      else if (Date.now() - t0 > 20000) { clearInterval(tick); resolve(null); }
    }, 200);
  });
  return csePromise;
}

// Заголовок из выдачи — это заголовок веб-страницы, а не название книги:
// там попадаются «страница 25», «Оглавление книги», «биография и список книг»
// и название источника. Оставляем только похожее на название книги.
function cleanCseTitle(t) {
  let s = String(t || '');
  s = s.replace(/Love[-\s]?Read(\.ec|\.ru|\.net)?/gi, ' ');   // упоминания источника
  s = s.replace(/[|·–—-]\s*(биография и список книг|Онлайн книги автора|Книги автора|Все книги|Читать онлайн|Читать бесплатно)[^|]{0,40}$/i, ' ');
  s = s.replace(/^Оглавление\s+книги\s*[«"“]?\s*/i, '');
  s = s.replace(/[,;:.\-–—]\s*страница\s*\d+\s*$/i, '');
  s = s.replace(/[,;:.\-–—\s]*\bАвтор\s*[-–—:]?[^,|]{0,40}$/i, ' ');
  s = s.replace(/^Книга\s+/i, '');
  s = s.replace(/[«»"“”]/g, ' ');
  s = s.replace(/\s*[|·]\s*$/,'');
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/[-–—,.|:;\s]+$/, '').trim();
  return s;
}

// Достаём из выдачи ссылки на книги источника и превращаем их в список.
function cseScrape() {
  const host = $('#cse-hidden');
  const out = [], seen = new Set();
  if (!host) return out;
  host.querySelectorAll('a.gs-title, .gs-title a').forEach(a => {
    const href = a.getAttribute('href') || '';
    const m = href.match(/(?:read_book\.php\?id=|contents\.php\?id=|book-comments\.php\?book=)(\d+)/);
    if (!m) return;
    const id = m[1];
    if (seen.has(id)) return;
    seen.add(id);
    const block = a.closest('.gsc-webResult, .gsc-result, .gs-result') || a.parentElement;
    const snippet = ((block && block.querySelector('.gs-snippet')?.textContent) || '').replace(/\s+/g, ' ').trim();
    const title = cleanCseTitle(a.textContent);
    if (title) out.push({ id, title, snippet });
  });
  return out;
}

async function cseSearch(q) {
  const el = await loadCSE();
  const host = $('#cse-hidden');
  if (!el || !host) return null;
  const appHash = cleanHash();
  cseSearchDepth++;
  try {
    el.execute(q);
    await new Promise(resolve => {                 // ждём, пока виджет отрисует выдачу
      const t0 = Date.now();
      let last = -1, stable = 0;
      const tick = setInterval(() => {
        const n = host.querySelectorAll('a.gs-title, .gs-title a').length;
        if (n && n === last) stable++; else { stable = 0; last = n; }
        if ((n && stable >= 2) || Date.now() - t0 > 15000) { clearInterval(tick); resolve(); }
      }, 150);
    });
    return cseScrape();
  } catch {
    return null;
  } finally {
    cseSearchDepth--;
    if (!cseSearchDepth && lastLocationHash === appHash && cleanHash() !== appHash) {
      history.replaceState(history.state, '', location.pathname + location.search + '#' + appHash);
    }
    if (!cseSearchDepth) lastLocationHash = cleanHash();
  }
}

function cseAuthorId() {
  for (const link of $$('#cse-hidden a.gs-title, #cse-hidden .gs-title a')) {
    const id = ((link.href || '').match(/\/books\.php\?id_author=(\d+)/i) || [])[1];
    if (id) return id;
  }
  return '';
}

async function openSearch(q) {
  const input = $('#search-input');
  if (searchMode === 'read') loadCSE();      // прогреваем поиск книг для чтения заранее
  if (document.activeElement !== input) input.value = q || '';
  syncClear();
  if (q) {
    state.query = q;
    runSearch(q);
  } else if (document.activeElement !== input) {
    input.focus();
    view.innerHTML = stateHTML('Поиск', searchMode === 'read'
      ? 'Введите название книги или автора — будем искать книги для чтения.'
      : 'Введите название книги, автора или чтеца.');
  }
}

/* Поиск книг для чтения (режим «Читать») */
/* Уточняем найденные книги у источника: у поисковой выдачи нет ни обложек,
   ни авторов. Догружаем их в фоне (по несколько сразу) и по мере готовности
   подставляем в уже отрисованные карточки. */
async function enrichReadItems(raw, seq, query = '', showSuggestions = true) {
  const items = raw.slice(0, 24);
  const details = new Map();
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const b = items[idx++];
      if (seq !== state.seq) return;
      try {
        const d = await apiLrDetail(b.id);
        if (seq !== state.seq) return;
        if (d && d.title) {
          const enriched = {
          id: b.id,
          title: d.title,
          author: d.author || '',
          cover: d.cover || '',
          genre: (d.genres && d.genres[0]) || '',
          time: d.readTime || '',
          };
          details.set(b.id, enriched);
          patchReadCard(b.id, enriched);
        }
      } catch {}
      await sleep(120);
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
  if (showSuggestions && seq === state.seq) {
    showAuthorSuggestions(items.map(b => details.get(b.id) || b), query, 'read');
  }
  return items.map(b => details.get(b.id) || b);
}

/* Подставляем уточнённые данные в карточку, не перерисовывая сетку. */
function patchReadCard(id, b) {
  const card = view.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const cover = card.querySelector('.cover');
  if (cover && b.cover && !cover.querySelector('img')) {
    const img = document.createElement('img');
    img.src = lrCover(b.cover);
    img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    cover.insertBefore(img, cover.firstChild);
  }
  if (cover && b.genre && !cover.querySelector('.genre-pill')) {
    const p = document.createElement('span');
    p.className = 'genre-pill'; p.textContent = b.genre;
    cover.appendChild(p);
  }
  if (cover && b.time && !cover.querySelector('.dur-pill')) {
    const p = document.createElement('span');
    p.className = 'dur-pill'; p.innerHTML = clockIcon + esc(b.time);
    cover.appendChild(p);
  }
  if (b.title) {
    const t = card.querySelector('.card-title');
    if (t) t.textContent = b.title;
  }
  const sub = card.querySelector('.card-sub');
  if (sub && b.author) sub.textContent = b.author;
}

async function runReadSearch(q, seq) {
  try {
    const items = await cseSearch(q);
    if (seq !== state.seq) return;
    if (items === null) {
      view.innerHTML = stateHTML('Поиск недоступен', 'Не удалось подключиться к поиску книг для чтения. Проверьте интернет.');
      return;
    }
    if (!items.length) { view.innerHTML = stateHTML('Ничего не найдено', 'По запросу «' + q + '» книг для чтения нет.'); return; }
    state.items = items;
    state.ended = true;
    view.innerHTML = `<div class="section-title">Читать · найдено: ${items.length}</div>
      <div class="grid">${items.map((b, i) => readerCardHTML({ id: b.id, title: b.title }, i)).join('')}</div>`;
    enrichReadItems(items, seq, q);       // обложки, авторы и подсказки догружаются по ходу
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => runSearch(q);
  }
}

async function runSearch(q) {
  q = (q || '').trim();
  // Запрос запоминаем в адресе, чтобы кнопка «Назад» возвращала к той же выдаче.
  if (parseHash().parts[0] === 'search') {
    const want = q.length >= 2 ? 'search?q=' + encodeURIComponent(q) : 'search';
    if (cleanHash() !== want) {
      history.replaceState({ app: true }, '', location.pathname + location.search + '#' + want);
      lastLocationHash = want;
    }
  }
  const seq = ++state.seq;
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  clearTail();
  if (q.length < 2) {
    view.innerHTML = stateHTML('Поиск', searchMode === 'read'
      ? 'Введите хотя бы 2 символа названия книги или автора.'
      : 'Введите хотя бы 2 символа.');
    return;
  }
  view.innerHTML = skeletonHTML(6);
  if (searchMode === 'read') return runReadSearch(q, seq);
  try {
    const { items, total } = await apiSearch(q, 1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = stateHTML('Ничего не найдено', 'По запросу «' + q + '» книг нет.'); return; }
    state.items = items;
    view.innerHTML = `${authorSuggestionHTML(items, q, 'audio')}<div class="section-title">${total ? 'Найдено: ' + total : 'Результаты'}</div>
      <div class="grid">${items.map(cardHTML).join('')}</div>`;
    syncPlaying();
    state.ended = items.length < 10;
    if (!state.ended) observeMore(() => loadMore('search', q));
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => runSearch(q);
  }
}

function authorBookMatches(book, author) {
  const value = book && (book.author || book.authors);
  const authors = (Array.isArray(value) ? value.join(', ') : String(value || ''))
    .split(/[,;]|\s+и\s+/i)
    .map(normalizeAuthorName)
    .filter(Boolean);
  const wanted = normalizeAuthorName(author);
  return !!wanted && authors.includes(wanted);
}

function authorBookHeader(name, mode, count = 0) {
  return `<section class="author-page-head">
    <button class="back-btn" id="author-back">${backIcon}К поиску</button>
    <div class="author-page-identity">
      <span class="author-page-avatar">${esc(name.charAt(0).toLocaleUpperCase('ru'))}</span>
      <div><span class="library-eyebrow">АВТОР</span><h1>${esc(name)}</h1><p id="author-book-count">${count ? `${count} ${count === 1 ? 'книга' : 'книг'} в подборке` : 'Все книги автора'}</p></div>
    </div>
    <div class="author-format">${mode === 'read' ? 'Книги для чтения' : 'Аудиокниги'}</div>
  </section>`;
}

async function renderAuthor(name, mode = 'audio', returnQuery = '') {
  if (!name) return go('search');
  mode = mode === 'read' ? 'read' : 'audio';
  document.title = `${name} — Bookify`;
  const seq = ++state.seq;
  const safeReturn = returnQuery ? `search?q=${encodeURIComponent(returnQuery)}` : 'search';
  state.cat = 'author';
  state.back = safeReturn;
  state.items = [];
  state.page = 1;
  state.ended = mode === 'read';
  state.loading = false;
  state.author = { name, mode, returnQuery };
  view.innerHTML = authorBookHeader(name, mode) + skeletonHTML(6);
  $('#author-back').onclick = () => go(safeReturn);
  try {
    let items = [];
    if (mode === 'audio') {
      const result = await apiSearch(name, 1);
      items = result.items.filter(book => authorBookMatches(book, name));
      state.author.total = result.total;
      state.author.sourceCount = result.items.length;
      state.ended = result.items.length < 10 || (!!result.total && result.items.length >= result.total);
    } else {
      const result = await cseSearch(name + ' site:loveread.ec');
      if (result === null) throw new Error('search');
      const authorId = cseAuthorId();
      items = authorId ? await apiLrAuthor(authorId, name) : [];
      if (!items.length) {
        const enriched = await enrichReadItems(result, seq, '', false);
        items = enriched.filter(book => authorBookMatches(book, name));
      }
    }
    if (seq !== state.seq) return;
    state.items = items;
    const cards = mode === 'read' ? items.map(readerCardHTML).join('') : items.map(cardHTML).join('');
    view.innerHTML = authorBookHeader(name, mode, items.length) +
      (items.length ? `<div class="grid">${cards}</div>` : `<div class="author-empty">Пока не нашли книги этого автора.</div>`);
    $('#author-back').onclick = () => go(safeReturn);
    syncPlaying();
    if (mode === 'audio' && !state.ended) observeMore(loadMoreAuthor);
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = authorBookHeader(name, mode) + stateHTML('Не удалось открыть автора', errorText(e), { label: 'Повторить' });
    $('#author-back').onclick = () => go(safeReturn);
    $('#state-action').onclick = () => renderAuthor(name, mode, returnQuery);
  }
}

async function loadMoreAuthor() {
  if (state.loading || state.ended || !state.author || state.author.mode !== 'audio') return;
  const seq = state.seq;
  const { name } = state.author;
  state.loading = true;
  spinner();
  try {
    let page = state.page;
    let added = [];
    let exhausted = false;
    for (let attempt = 0; attempt < 4 && !added.length; attempt++) {
      const result = await apiSearch(name, ++page);
      added = result.items.filter(book => authorBookMatches(book, name));
      exhausted = result.items.length < 10 || (!!result.total && page * 10 >= result.total);
      if (!result.items.length || exhausted) break;
    }
    if (seq !== state.seq) return;
    state.page = page;
    state.ended = exhausted;
    const known = new Set(state.items.map(book => book.id));
    added = added.filter(book => !known.has(book.id));
    if (added.length) {
      state.items.push(...added);
      const grid = view.querySelector('.grid');
      if (grid) grid.insertAdjacentHTML('beforeend', added.map(cardHTML).join(''));
      const count = $('#author-book-count');
      if (count) count.textContent = `${state.items.length} книг в подборке`;
      syncPlaying();
    } else if (!exhausted) {
      observeMore(loadMoreAuthor);
    } else if (!state.items.length) {
      view.querySelector('.grid')?.remove();
    }
  } catch (e) {
    if (seq === state.seq) toast(errorText(e));
  } finally {
    if (seq === state.seq) { state.loading = false; clearTail(); }
  }
}

/* ---------- 13. Догрузка ---------- */

function disconnectObserver() {
  if (observer) { observer.disconnect(); observer = null; }
}

function observeMore(loader) {
  disconnectObserver();
  observer = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) loader();
  }, { rootMargin: '700px 0px' });
  observer.observe(sentinel);
}

async function loadMore(kind, arg) {
  if (state.loading || state.ended) return;
  const seq = state.seq;
  state.loading = true;
  spinner();
  try {
    const next = state.page + 1;
    const isLr = kind === 'lrlist' || kind === 'lrgenre';
    const items = kind === 'genre' ? (await apiGenre(arg, next)).items
      : kind === 'search' ? (await apiSearch(arg, next)).items
        : kind === 'lrlist' ? await apiLrList(next)
          : kind === 'lrgenre' ? await apiLrGenre(arg, next)
            : (await apiList(arg, next)).items;
    if (seq !== state.seq) return;          // маршрут сменился — результат неактуален
    state.page = next;
    const known = new Set(state.items.map(b => b.id));
    const fresh = items.filter(b => !known.has(b.id));
    if (!items.length || (!isLr && items.length < 10)) state.ended = true;
    if (!fresh.length) { state.ended = true; return; }   // защита от зацикливания догрузки

    state.items.push(...fresh);
    const card = isLr ? readerCardHTML : cardHTML;
    const grid = view.querySelector('.grid');
    if (grid) grid.insertAdjacentHTML('beforeend', fresh.map((b, i) => card(b, i)).join(''));
    syncPlaying();
  } catch (e) {
    if (seq === state.seq) toast(errorText(e));
  } finally {
    if (seq === state.seq) { state.loading = false; clearTail(); }
  }
}

/* ---------- 14. Страница книги ---------- */

const chapterRow = (c, i, current) => `
  <button class="chap ${current === i ? 'is-current' : ''}" data-i="${i}">
    <span class="chap-num">${i + 1}</span>
    <span class="chap-name">${esc(c.title)}</span>
    ${c.duration ? `<span class="chap-time">${fmtTime(c.duration)}</span>` : ''}
  </button>`;

async function renderBook(slug) {
  if (!slug) return go('cat/new');
  const seq = ++state.seq;
  state.loading = false;
  view.innerHTML = skeletonHTML(2);
  try {
    const b = await apiBook(slug);
    if (seq !== state.seq) return;
    state.book = b;
    const playing = player.book && player.book.slug === b.slug;
    view.innerHTML = `
      <div class="back-btn" id="back">${backIcon}Назад</div>
      <div class="book-head">
        <div class="cover">${b.cover ? `<img src="${esc(coverImg(b.cover, 'full'))}" alt="" decoding="async" referrerpolicy="no-referrer">` : ''}</div>
        <div class="book-head-info">
          <div class="book-h1">${esc(b.title)}</div>
          ${b.authors.length ? `<div class="book-line">Автор: <b>${b.authors.map(name => `<a class="author-name" href="${authorHref(name, 'audio')}">${esc(name)}</a>`).join(', ')}</b></div>` : ''}
          ${b.readers.length ? `<div class="book-line">Читает: <b>${esc(b.readers.join(', '))}</b></div>` : ''}
          <div class="chips">
            ${b.genre ? `<span class="chip">${esc(b.genre)}</span>` : ''}
            ${b.duration ? `<span class="chip">${esc(b.duration)}</span>` : ''}
            ${b.rating ? `<span class="chip chip-accent">${esc(b.rating)} ★${b.ratingCount ? ' · ' + esc(b.ratingCount) : ''}</span>` : ''}
            ${b.chapters.length ? `<span class="chip">Глав: ${b.chapters.length}</span>` : ''}
          </div>
        </div>
      </div>
      ${b.chapters.length ? `<button class="play-cta" id="play-cta">
        <svg viewBox="3 2 18 20" fill="none"><path d="M15 12.3301L9 16.6603L9 8L15 12.3301Z" fill="currentColor"/></svg>
        ${playing ? 'Продолжить' : 'Слушать'}</button>
      <div class="book-actions">
        <button class="dl-cta" id="dl-cta">${dlIcon}${dlLabel(dl.meta(b.slug))}</button>
        <button class="shelf-cta" id="shelf-cta" data-kind="audio" data-id="${esc(b.slug)}">${plusIcon}На полку</button>
      </div>` : ''}
      ${b.description ? `<div class="section-title">Описание</div><div class="book-desc">${esc(b.description)}</div>` : ''}
      ${b.chapters.length > 1 ? `<div class="section-title">Главы</div>
        <div class="sheet-chapters">${b.chapters.map((c, i) => chapterRow(c, i, playing ? player.index : -1)).join('')}</div>` : ''}`;

    $('#back').onclick = () => goBack('cat/new');
    const cta = $('#play-cta');
    if (cta) cta.onclick = () => {
      if (player.book && player.book.slug === b.slug) return audio.paused ? player.toggle() : openSheet();
      player.load(b, 0, true);
      openSheet();
    };
    const dlBtn = $('#dl-cta');
    if (dlBtn) dlBtn.onclick = async () => {
      const m = dl.meta(b.slug);
      if (m && m.status === 'done') {
        await dl.remove(b.slug, b.chapters.map(c => c.url));
        renderBook(b.slug);
      } else {
        dlBtn.disabled = true;
        await dl.audio(b);
        if (state.route === 'book/' + b.slug) renderBook(b.slug);
      }
    };
    const shelfBtn = $('#shelf-cta');
    if (shelfBtn) {
      paintShelfBtn(shelfBtn, 'audio', b.slug);
      shelfBtn.onclick = () => toggleShelfFromBook(shelfBtn, {
        kind: 'audio', id: b.slug, title: b.title,
        author: (b.authors || [])[0] || '', cover: b.cover || '',
      });
    }
    view.querySelectorAll('.chap').forEach(btn => {
      btn.onclick = () => {
        const i = Number(btn.dataset.i);
        if (player.book && player.book.slug === b.slug && i === player.index) return openSheet();
        player.load(b, i, true);
        openSheet();
      };
    });
  } catch (e) {
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderBook(slug);
  }
}

/* ---------- 15. Читабельные книги (LoveRead) ---------- */

async function renderReadList() {
  const seq = ++state.seq;
  state.cat = 'read';
  state.back = 'read';
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  const tools = `<div class="read-tools"><button class="ghost-btn" id="to-genres">Жанры</button>
    <span class="read-hint">Читать онлайн</span></div>`;
  const bind = () => { const g = $('#to-genres'); if (g) g.onclick = () => go('rgenres'); };
  view.innerHTML = tools + skeletonHTML();
  bind();
  try {
    const items = await apiLrList(1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = stateHTML('Пусто', 'Источник не вернул книг.'); return; }
    state.items = items;
    view.innerHTML = `<div class="read-tools"><button class="ghost-btn" id="to-genres">Жанры</button>
        <span class="read-hint">Свежие поступления</span></div>
      ${continueReadHTML()}
      <div class="grid">${items.map(readerCardHTML).join('')}</div>`;
    bind();
    bindContinueRead();
    state.ended = true;                  // у списка свежих поступлений нет пагинации
    restoreScroll(state.route);
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderReadList();
  }
}

async function renderReadGenres() {
  const seq = ++state.seq;
  const back = `<div class="back-btn" id="back">${backIcon}Читать</div>`;
  view.innerHTML = back + `<div class="section-title">Жанры</div>${'<div class="genre-row sk" style="height:52px;animation:none"></div>'.repeat(6)}`;
  $('#back').onclick = () => go('read');
  try {
    const groups = await apiLrGenres();
    if (seq !== state.seq) return;
    if (!groups.length) { view.innerHTML = back + stateHTML('Пусто', 'Не удалось получить жанры.'); $('#back').onclick = () => go('read'); return; }
    view.innerHTML = back + `<div class="section-title">Жанры</div>
      <div class="lr-groups">${groups.map(g => `
        <div class="lr-group">
          <div class="lr-group-name">${esc(g.name)}</div>
          <div class="lr-chips">${g.subs.map(s => `<a class="chip" href="#/rgenre/${esc(s.id)}/${encodeURIComponent(s.name)}">${esc(s.name)}</a>`).join('')}</div>
        </div>`).join('')}</div>`;
    $('#back').onclick = () => go('read');
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = back + stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#back').onclick = () => go('read');
    $('#state-action').onclick = () => renderReadGenres();
  }
}

async function renderReadGenre(id, name) {
  if (!id) return go('rgenres');
  const seq = ++state.seq;
  state.cat = 'rgenre';
  state.back = 'rgenres';
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  const head = `<div class="back-btn" id="back">${backIcon}Жанры</div><div class="section-title">${esc(name || 'Жанр')}</div>`;
  view.innerHTML = head + skeletonHTML();
  $('#back').onclick = () => go('rgenres');
  try {
    const items = await apiLrGenre(id, 1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = head + stateHTML('Пусто', 'В этом жанре нет книг.'); $('#back').onclick = () => go('rgenres'); return; }
    state.items = items;
    view.innerHTML = head + `<div class="grid">${items.map(readerCardHTML).join('')}</div>`;
    $('#back').onclick = () => go('rgenres');
    state.ended = !items.length;
    restoreScroll(state.route);
    if (!state.ended) observeMore(() => loadMore('lrgenre', id));
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = head + stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#back').onclick = () => go('rgenres');
    $('#state-action').onclick = () => renderReadGenre(id, name);
  }
}

async function renderReadBook(id) {
  if (!id) return go('read');
  const seq = ++state.seq;
  state.loading = false;
  view.innerHTML = skeletonHTML(2);
  const back = `<div class="back-btn" id="back">${backIcon}Назад</div>`;
  try {
    const b = await apiLrDetail(id);
    if (seq !== state.seq) return;
    if (!b.title) { view.innerHTML = stateHTML('Не найдено', 'Книга недоступна.'); return; }
    store.set('lr:meta:' + id, { title: b.title, author: b.author, cover: b.cover }, 365 * 24 * 3600e3);
    const pos = store.get('lr:pos:' + id);
    const page = pos && pos.p > 1 ? pos.p : 1;
    view.innerHTML = `${back}
      <div class="book-head">
        <div class="cover">${b.cover ? `<img src="${esc(lrCover(b.cover))}" alt="" decoding="async" referrerpolicy="no-referrer">` : ''}</div>
        <div class="book-head-info">
          <div class="book-h1">${esc(b.title)}</div>
          ${b.author ? `<div class="book-line">Автор: <b><a class="author-name" href="${authorHref(b.author, 'read')}">${esc(b.author)}</a></b></div>` : ''}
          <div class="chips">
            ${b.genres.slice(0, 2).map(g => `<span class="chip">${esc(g)}</span>`).join('')}
            ${b.year ? `<span class="chip">${esc(b.year)}</span>` : ''}
            ${b.pages ? `<span class="chip">${esc(b.pages)}</span>` : ''}
            ${b.readTime ? `<span class="chip chip-accent">${esc(b.readTime)}</span>` : ''}
          </div>
        </div>
      </div>
      <button class="play-cta" id="read-cta">${bookIcon}${page > 1 ? `Продолжить — стр. ${page}${pos && pos.t ? ' из ' + pos.t : ''}` : 'Читать онлайн'}</button>
      <div class="book-actions">
        <button class="dl-cta" id="dl-cta">${dlIcon}${dlLabel(dl.meta('r' + id))}</button>
        <button class="shelf-cta" id="shelf-cta" data-kind="read" data-id="${esc(id)}">${plusIcon}На полку</button>
      </div>
      ${b.description ? `<div class="section-title">Описание</div><div class="book-desc">${esc(b.description)}</div>` : ''}`;
    $('#back').onclick = () => goBack('read');
    $('#read-cta').onclick = () => {
      if (pos && pos.c > 0 && pos.p === page) pendingSpot = { id, p: page, c: pos.c };
      go(`rread/${id}/${page}`);
    };
    const dlBtn = $('#dl-cta');
    if (dlBtn) dlBtn.onclick = async () => {
      const m = dl.meta('r' + id);
      if (m && m.status === 'done') {
        await dl.remove('r' + id, null);
        renderReadBook(id);
      } else {
        dlBtn.disabled = true;
        await dl.reader(id, b);
        if (state.route === 'rbook/' + id) renderReadBook(id);
      }
    };
    const shelfBtn = $('#shelf-cta');
    if (shelfBtn) {
      paintShelfBtn(shelfBtn, 'read', id);
      shelfBtn.onclick = () => toggleShelfFromBook(shelfBtn, {
        kind: 'read', id, title: b.title,
        author: b.author || '', cover: b.cover || '',
      });
    }
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = back + stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#back').onclick = () => go('read');
    $('#state-action').onclick = () => renderReadBook(id);
  }
}

/* ---------- Настройки чтения (сохраняются) ---------- */

const RD_W = { narrow: 54, medium: 66, wide: 80 };
const RD_DEF = { scale: 1, lh: 1.7, width: 'medium', spacing: 'normal', font: 'serif', theme: 'dark', brightness: 1, orientation: 'portrait' };

const rdSet = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('polka:rd')) || {}; } catch {}
  const out = { ...RD_DEF, ...saved };
  const legacy = Number(localStorage.getItem('polka:rdscale'));   // переносим старый размер шрифта
  if (!saved.scale && legacy) out.scale = Math.min(1.6, Math.max(0.8, legacy));
  // интервал приводим к шагу ползунка (1.4 … 2.2 с шагом 0.05)
  out.lh = Math.min(2.2, Math.max(1.4, Math.round(Number(out.lh) / 0.05) * 0.05));
  return out;
})();

const rdSave = () => { try { localStorage.setItem('polka:rd', JSON.stringify(rdSet)); } catch {} };

function rdApply() {
  const st = document.documentElement.style;
  st.setProperty('--rd', rdSet.scale);
  st.setProperty('--rd-lh', rdSet.lh);
  st.setProperty('--rd-w', (RD_W[rdSet.width] || RD_W.medium) + 'ch');
  st.setProperty('--rd-brightness', rdSet.brightness || 1);
  $$('.reader').forEach(r => r.classList.toggle('rd-serif', rdSet.font === 'serif'));
}

/* Тема страницы включается только на экране чтения */
function rdPage(on) {
  if (on && rdSet.theme !== 'auto') document.body.dataset.rdPage = rdSet.theme;
  else delete document.body.dataset.rdPage;
}

/* Закладка/позиция: лист источника + номер экрана в нём. */
let pendingSpot = null;

/* Текст у верхней строки текущего экрана — короткая подпись для закладки. */
function readerExcerpt() {
  const stage = $('#rd-stage');
  if (!stage) return '';
  const r = stage.getBoundingClientRect();
  const x = r.left + 14, y = r.top + 22;
  const at = document.caretPositionFromPoint
    ? document.caretPositionFromPoint(x, y)
    : (document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y)?.startContainer && { offsetNode: document.caretRangeFromPoint(x, y).startContainer } : null);
  let node = at && at.offsetNode;
  if (!node) return '';
  if (node.nodeType === 3) node = node.parentElement;
  const p = node && node.closest && node.closest('.rd-p, .rd-chap');
  return p ? p.textContent.trim().slice(0, 90) : '';
}

const bmIcon = '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M19 20h-1.8283l-4.4645-4.4646a1 1 0 0 0-1.4143 0L6.8284 20H5V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v13ZM17 7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v10l2.8787-2.8788a3 3 0 0 1 4.2427 0L17 17V7Z" fill="currentColor"/></svg>';

// Закладки: { p — лист источника, c — экран внутри листа, excerpt, ts }.
// Старый формат { page, y } тоже читаем.
const bmAll = id => (store.get('bm:' + id) || []).map(b => ({
  p: b.p || b.page || 1,
  c: b.c || 0,
  excerpt: b.excerpt || '',
  ts: b.ts || 0,
}));
function bmSave(id, list) { store.set('bm:' + id, list, 365 * 24 * 3600e3); }

function renderBm(id, page, col) {
  const box = $('#bm-list');
  if (!box) return;
  const list = bmAll(id);
  $('#bm-count').textContent = list.length ? String(list.length) : '';
  $('#rd-bm').classList.toggle('is-on', list.some(bm => bm.p === page && bm.c === col));
  box.classList.toggle('is-empty', !list.length);
  box.innerHTML = list.map((bm, i) => `
    <button class="bm-item" data-i="${i}">
      <span class="bm-page">стр. ${bm.p}</span>
      <span class="bm-ex">${esc(bm.excerpt)}</span>
    </button>`).join('');
  box.querySelectorAll('.bm-item').forEach(btn => btn.onclick = () => {
    const bm = list[Number(btn.dataset.i)];
    if (bm.p === rdView.src) {              // тот же лист — просто листаем экраны
      rdView.si = Math.min(bm.c, rdView.cols - 1);
      rdPlaceInstant();
      openRdPanel(false);
    } else {
      pendingSpot = { id, p: bm.p, c: bm.c };
      go(`rread/${id}/${bm.p}`);
    }
  });
}

/* Заметки к страницам книги */
const nmAll = id => store.get('nm:' + id) || [];
function nmSave(id, list) { store.set('nm:' + id, list, 365 * 24 * 3600e3); }

function renderNm(id, page) {
  const box = $('#nm-list');
  if (!box) return;
  const list = nmAll(id);
  const cnt = $('#nm-count');
  if (cnt) cnt.textContent = list.length ? String(list.length) : '';
  const cur = list.find(n => n.page === page);
  const ta = $('#nm-text');
  if (ta && document.activeElement !== ta) ta.value = (cur && cur.text) || '';
  box.classList.toggle('is-empty', !list.length);
  box.innerHTML = list.map((n, i) => `
    <button class="bm-item nm-item${n.page === page ? ' is-cur' : ''}" data-i="${i}">
      <span class="bm-page">стр. ${n.page}</span>
      <span class="bm-ex">${esc(n.text)}</span>
    </button>`).join('');
  box.querySelectorAll('.nm-item').forEach(btn => btn.onclick = () => {
    const n = list[Number(btn.dataset.i)];
    if (n.page === page) { const t = $('#nm-text'); if (t) t.focus(); }
    else go(`rread/${id}/${n.page}`);
  });
}

/* Панель настроек чтения */
let rdPanelOpen = false;

const rdCloseIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';

function rdPanelHTML() {
  const seg = (name, items) => `<div class="rd-seg" data-seg="${name}">${
    items.map(([v, label]) => `<button data-v="${v}" class="${rdSet[name] === v ? 'on' : ''}">${label}</button>`).join('')
  }</div>`;
  const pct = Math.round(rdSet.scale * 100);
  return `<div class="rd-panel is-hidden" id="rd-panel">
    <div class="rd-panel-grab"></div>
    <div class="rd-panel-head">
      <span class="rd-panel-title">Настройки чтения</span>
      <span class="rd-count" id="rd-page"></span>
      <button class="rd-close" id="rd-panel-close" aria-label="Закрыть">${rdCloseIcon}</button>
    </div>
    <div class="rd-theme-swatches" data-seg="theme">
      ${[['dark','Aa'],['light','Aa'],['sepia','Aa'],['auto','Aa']].map(([v,t]) => `<button data-v="${v}" class="rd-theme-tile rd-theme-${v}${rdSet.theme === v ? ' on' : ''}" aria-label="${v === 'dark' ? 'Тёмная тема' : v === 'light' ? 'Светлая тема' : v === 'sepia' ? 'Сепия' : 'Тема устройства'}">${t}</button>`).join('')}
    </div>
    <div class="rd-setting-line">
      <span>Шрифт</span>
      ${seg('font', [['serif', 'Georgia'], ['sans', 'Системный']])}
      <button class="rd-size-button" id="rd-smaller" aria-label="Уменьшить шрифт">A−</button>
      <button class="rd-size-button" id="rd-larger" aria-label="Увеличить шрифт">A+</button>
    </div>
    <input class="rd-range-hidden" type="range" id="rd-scale" min="80" max="160" step="5" value="${pct}" aria-label="Размер текста">
    <span class="rd-val is-hidden" id="rd-scale-val">${pct}%</span>
    <div class="rd-setting-line rd-spacing-line">
      <span>Интервал</span>
      ${seg('spacing', [['compact', '≡'], ['normal', '≋'], ['relaxed', '☰']])}
    </div>
    <input class="rd-range-hidden" type="range" id="rd-lh" min="1.4" max="2.2" step="0.05" value="${rdSet.lh}" aria-label="Межстрочный интервал">
    <span class="rd-val is-hidden" id="rd-lh-val">${rdSet.lh.toFixed(2)}</span>
    <div class="rd-setting-line rd-spacing-line">
      <span>Поля</span>
      ${seg('width', [['narrow', '≡'], ['medium', '≋'], ['wide', '☰']])}
    </div>
    <div class="rd-reader-extra">
      <label class="rd-brightness">
        <span class="rd-sun">☼</span><span>Яркость</span>
        <input type="range" id="rd-brightness" min="60" max="120" step="5" value="${Math.round((rdSet.brightness || 1) * 100)}" aria-label="Яркость страницы">
        <b id="rd-brightness-val">${Math.round((rdSet.brightness || 1) * 100)}%</b>
      </label>
      <div class="rd-orientation">
        <span>Ориентация</span>
        ${seg('orientation', [['portrait', '▯'], ['landscape', '▭']])}
      </div>
    </div>
    <div class="rd-shortcuts">
      <button id="rd-shortcut-bm">${bmIcon}<span>Закладки</span></button>
      <button id="rd-shortcut-note"><span class="rd-note-icon">↗</span><span>Заметки</span></button>
      <button id="rd-shortcut-exit"><span class="rd-exit-icon">⌂</span><span>Закрыть</span></button>
    </div>
    <div class="rd-sec" id="rd-sec-bookmarks">
      <div class="rd-sec-head">
        <span class="rd-sec-name">Закладки</span>
        <button class="rd-mini" id="rd-bm">${bmIcon}<span>Добавить</span><span id="bm-count"></span></button>
      </div>
      <div class="bm-list is-empty" id="bm-list"></div>
    </div>
    <div class="rd-sec" id="rd-sec-notes">
      <div class="rd-sec-head">
        <span class="rd-sec-name">Заметки</span>
        <span class="rd-sec-num" id="nm-count"></span>
      </div>
      <textarea class="nm-text" id="nm-text" rows="3" placeholder="Заметка к этой странице"></textarea>
      <button class="rd-save" id="nm-save">Сохранить заметку</button>
      <div class="bm-list is-empty" id="nm-list"></div>
    </div>
    <button class="rd-exit" id="rd-exit">Закрыть книгу</button>
  </div>`;
}

function openRdPanel(on) {
  rdPanelOpen = on;
  const panel = $('#rd-panel');
  if (panel) panel.classList.toggle('is-hidden', !on);
  const btn = $('#rd-aa');
  if (btn) btn.classList.toggle('is-on', !!on);
  rdShowAa(on);                              // открытая панель держит кнопку на виду
}

function wireRdPanel(id) {
  $('#rd-aa').onclick = () => openRdPanel(!rdPanelOpen);
  $('#rd-panel-close').onclick = () => openRdPanel(false);
  $('#rd-smaller').onclick = () => {
    const input = $('#rd-scale');
    input.value = Math.max(Number(input.min), Number(input.value) - Number(input.step));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  $('#rd-larger').onclick = () => {
    const input = $('#rd-scale');
    input.value = Math.min(Number(input.max), Number(input.value) + Number(input.step));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  $('#rd-scale').oninput = e => {
    rdSet.scale = Number(e.target.value) / 100;
    $('#rd-scale-val').textContent = e.target.value + '%';
    rdApply();
    rdRelayout(true);
    rdSave();
  };
  $('#rd-lh').oninput = e => {
    rdSet.lh = Number(e.target.value);
    $('#rd-lh-val').textContent = rdSet.lh.toFixed(2);
    rdApply();
    rdRelayout(true);
    rdSave();
  };
  $$('#rd-panel [data-seg]').forEach(box => {
    box.querySelectorAll('button').forEach(btn => btn.onclick = () => {
      const key = box.dataset.seg;
      rdSet[key] = btn.dataset.v;
      if (key === 'spacing') {
        rdSet.lh = ({ compact: 1.5, normal: 1.7, relaxed: 1.95 })[btn.dataset.v];
        $('#rd-lh').value = rdSet.lh;
        $('#rd-lh-val').textContent = rdSet.lh.toFixed(2);
      }
      box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn));
      if (key === 'theme') rdPage(true);
      rdApply();
      rdRelayout(true);
      rdSave();
      if (key === 'orientation' && screen.orientation?.lock) {
        screen.orientation.lock(btn.dataset.v).catch(() => toast('Поворот зависит от настроек устройства'));
      }
    });
  });
  $('#rd-brightness').oninput = e => {
    rdSet.brightness = Number(e.target.value) / 100;
    $('#rd-brightness-val').textContent = e.target.value + '%';
    rdApply();
    rdSave();
  };
  $('#rd-shortcut-bm').onclick = () => $('#rd-sec-bookmarks').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#rd-shortcut-note').onclick = () => {
    $('#rd-sec-notes').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#nm-text').focus();
  };
  $('#rd-shortcut-exit').onclick = () => go('rbook/' + id);
  // Закладка на текущем экране
  $('#rd-bm').onclick = () => {
    const page = rdView.src, col = rdView.si;
    const list = bmAll(id);
    const at = list.findIndex(bm => bm.p === page && bm.c === col);
    if (at >= 0) { list.splice(at, 1); toast('Закладка удалена'); }
    else {
      list.push({ p: page, c: col, excerpt: readerExcerpt(), ts: Date.now() });
      list.sort((a, b) => a.p - b.p || a.c - b.c);
      toast('Закладка добавлена');
    }
    bmSave(id, list);
    renderBm(id, page, col);
  };
  // Заметка к текущей странице
  $('#nm-save').onclick = () => {
    const page = rdView.src;
    const text = ($('#nm-text').value || '').trim();
    const list = nmAll(id).filter(n => n.page !== page);
    if (text) { list.push({ page, text, ts: Date.now() }); list.sort((a, b) => a.page - b.page); toast('Заметка сохранена'); }
    else toast('Заметка удалена');
    nmSave(id, list);
    renderNm(id, page);
  };
  $('#rd-exit').onclick = () => goBack('rbook/' + id);
  $('#rd-back').onclick = () => goBack('rbook/' + id);
  openRdPanel(rdPanelOpen);
}

/* ---------- Листание читалки: ровно экран текста за раз ---------- */
/* Текст раскладывается в колонки высотой во весь экран: сколько влезло —
   столько и на странице, дальше листаем вбок. Колонки считает сам браузер. */

const RD_GAP = 48;                                  // px — совпадает с .rd-page{column-gap}

const rdView = { id: null, src: 1, total: 1, si: 0, cols: 1, title: '', busy: false, cache: new Map() };

let rdResizeTimer = 0;
window.addEventListener('resize', () => {
  if (!rdView.id || !rdStageEl()) return;
  clearTimeout(rdResizeTimer);
  rdResizeTimer = setTimeout(() => rdRelayout(true), 90);
}, { passive: true });

const rdKey = (id, p) => id + ':' + p;

async function rdLoad(id, page) {
  const k = rdKey(id, page);
  if (rdView.cache.has(k)) return rdView.cache.get(k);
  const d = await apiLrPage(id, page);
  rdView.cache.set(k, d);
  return d;
}

/* Соседние листы источника подтягиваем заранее — листание стартует мгновенно */
function rdPrefetch() {
  [1, -1].forEach(dir => {
    const p = rdView.src + dir;
    if (p >= 1 && p <= rdView.total) rdLoad(rdView.id, p).catch(() => {});
  });
}

const rdBodyHTML = d => d.blocks.map(b => b.t === 'h'
  ? `<h3 class="rd-chap">${esc(b.x)}</h3>`
  : `<p class="rd-p">${esc(b.x)}</p>`).join('') || '<p class="rd-p">Страница пуста.</p>';

const rdStageEl = () => $('#rd-stage');
const rdCurEl = () => $('#rd-cur');

/* Шаг должен совпадать с реальной шириной текстовой колонки, без полей stage. */
const rdStride = () => (rdCurEl() ? rdCurEl().clientWidth : 0) + RD_GAP;

/* Сдвигаем ленту к текущему экрану (плавность задана в CSS) */
function rdPlace() {
  const cur = rdCurEl();
  if (!cur) return;
  cur.style.transition = '';
  cur.style.transform = `translateX(${-rdView.si * rdStride()}px)`;
}

/* То же, но мгновенно — когда текст только что подменили */
function rdPlaceInstant() {
  const cur = rdCurEl();
  if (!cur) return;
  cur.style.transition = 'none';
  cur.style.transform = `translateX(${-rdView.si * rdStride()}px)`;
  void cur.offsetWidth;
  cur.style.transition = '';
}

/* Пересчёт колонок под текущий экран и настройки чтения.
   preserve — постараться остаться на том же месте текста. */
function rdRelayout(preserve) {
  const stage = rdStageEl(), cur = rdCurEl();
  if (!stage || !cur) return;
  const frac = preserve && rdView.cols > 1 ? (rdView.si + 1) / rdView.cols : null;
  const w = Math.max(1, Math.round(cur.clientWidth));
  stage.style.setProperty('--rd-colw', w + 'px');
  stage.style.setProperty('--rd-gap', RD_GAP + 'px');
  const stride = w + RD_GAP;
  rdView.cols = Math.max(1, Math.round((cur.scrollWidth + RD_GAP) / stride));
  if (frac != null) rdView.si = Math.min(rdView.cols - 1, Math.max(0, Math.round(frac * rdView.cols) - 1));
  else rdView.si = Math.min(rdView.si, rdView.cols - 1);
  rdPlaceInstant();
  rdSync();
}

/* Прогресс по книге целиком */
function rdProgress() {
  const { src, total, si, cols } = rdView;
  if (!total) return 0;
  return Math.min(100, Math.round((((src - 1) + (si + 1) / Math.max(1, cols)) / total) * 100));
}

/* Меняем всё, кроме текста: счётчик, прогресс, закладки, адрес */
function rdSync() {
  const { id, src, total, si } = rdView;
  if (!id) return;
  store.set('lr:pos:' + id, { p: src, t: total, c: si, title: rdView.title }, 365 * 24 * 3600e3);
  shelfProgress('read', id, { pct: rdProgress(), page: src, total, si });
  const cnt = $('#rd-page');
  if (cnt) cnt.textContent = src + ' / ' + total;
  const bar = $('#rd-pct');
  if (bar) bar.style.width = rdProgress() + '%';
  renderBm(id, src, si);
  renderNm(id, src);
  history.replaceState({}, '', location.pathname + location.search + `#/rread/${id}/${src}`);
}

/* Подменяем текст на соседнем листе источника */
function rdShowSrc(d) {
  const cur = rdCurEl();
  if (!cur) return;
  rdView.src = d.page;
  rdView.total = d.total;
  if (d.title) { rdView.title = d.title; document.title = d.title + ' — Bookify'; }
  const pageLabel = $('.rd-book-heading > span');
  if (pageLabel) pageLabel.textContent = 'СТРАНИЦА ' + d.page;
  cur.innerHTML = rdBodyHTML(d);
  rdRelayout(false);
  rdPrefetch();
}

/* Перелистнуть на один экран: вбок по колонкам, на краю — соседний лист */
async function rdFlip(dir) {
  if (!rdView.id || rdView.busy) return;
  const want = rdView.si + dir;
  if (want >= 0 && want < rdView.cols) { rdView.si = want; rdPlace(); rdSync(); return; }
  const next = rdView.src + dir;
  if (next < 1) return;
  if (next > rdView.total) {
    if (dir > 0) markBookCompleted('read', rdView.id, rdView.title);
    return;
  }
  rdView.busy = true;
  let d;
  try { d = await rdLoad(rdView.id, next); }
  catch { rdView.busy = false; toast('Страница не загрузилась'); return; }
  rdView.si = 0;
  rdShowSrc(d);
  if (dir < 0) { rdView.si = rdView.cols - 1; rdPlaceInstant(); rdSync(); }
  rdView.busy = false;
}

/* Кнопка «Aa»: появляется по тапу по экрану и снова прячется сама */
let aaTimer = 0;
function rdShowAa(on) {
  const b = $('#rd-aa');
  if (!b) return;
  b.classList.toggle('is-away', !on);
  clearTimeout(aaTimer);
  if (on) aaTimer = setTimeout(() => { const x = $('#rd-aa'); if (x) x.classList.add('is-away'); }, 4000);
}
function rdTap() {
  if (rdPanelOpen) { openRdPanel(false); return; }
  const b = $('#rd-aa');
  if (b) rdShowAa(b.classList.contains('is-away'));
}

/* Свайп: лента едет за пальцем, отпустили — доезжает до ближайшего экрана */
const sw = { on: false, drag: false, pid: 0, x0: 0, y0: 0, dx: 0 };

function bindRdSwipe() {
  const stage = rdStageEl();
  if (!stage) return;
  sw.on = false; sw.drag = false;

  stage.addEventListener('pointerdown', e => {
    if (rdView.busy) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sw.on = true; sw.drag = false; sw.pid = e.pointerId;
    sw.x0 = e.clientX; sw.y0 = e.clientY; sw.dx = 0;
  });

  stage.addEventListener('pointermove', e => {
    if (!sw.on || e.pointerId !== sw.pid) return;
    const dx = e.clientX - sw.x0, dy = e.clientY - sw.y0;
    if (!sw.drag) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx)) { sw.on = false; return; }   // жест вертикальный — не листаем
      sw.drag = true;
      const cur = rdCurEl();
      if (cur) cur.style.transition = 'none';
      try { stage.setPointerCapture(e.pointerId); } catch {}
    }
    e.preventDefault();
    let pull = e.clientX - sw.x0;
    const atStart = rdView.src === 1 && rdView.si === 0;
    const atEnd = rdView.src === rdView.total && rdView.si === rdView.cols - 1;
    if ((pull > 0 && atStart) || (pull < 0 && atEnd)) pull *= 0.35;   // за краем книги — с сопротивлением
    sw.dx = pull;
    const cur = rdCurEl();
    if (cur) cur.style.transform = `translateX(${-rdView.si * rdStride() + pull}px)`;
  });

  const end = e => {
    if (!sw.on || e.pointerId !== sw.pid) return;
    sw.on = false;
    const dragged = sw.drag;
    sw.drag = false;
    const cur = rdCurEl();
    if (cur) cur.style.transition = '';
    // короткий тап без движения — показать или спрятать кнопку настроек
    if (!dragged) {
      if (Math.abs(e.clientX - sw.x0) < 10 && Math.abs(e.clientY - sw.y0) < 10) rdTap();
      return;
    }
    if (Math.abs(sw.dx) > rdStride() * 0.25) rdFlip(sw.dx < 0 ? 1 : -1);
    else rdPlace();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

async function renderReader(id, page) {
  if (!id) return go('read');
  const seq = ++state.seq;
  state.loading = false;
  const back = `<div class="back-btn" id="back">${backIcon}Назад</div>`;
  view.innerHTML = back + skeletonHTML(1);
  $('#back').onclick = () => goBack('rbook/' + id);
  try {
    const d = await apiLrPage(id, page);
    if (seq !== state.seq) return;
    const meta = store.getStale('lr:meta:' + id) || {};
    const title = meta.title || d.title || 'Книга';
    // Начали читать — книга сразу на полке.
    if (meta.title) autoShelf('read', id, { title: meta.title, author: meta.author || '', cover: meta.cover || '' });
    // Книга и настройки остаются поверх страницы, перелистывание не меняется.
    view.innerHTML = `
      <div class="rd-reader-shell">
        <div class="rd-reader-art"></div>
        <div class="rd-topline"><i id="rd-pct" style="width:0%"></i></div>
        <header class="rd-toolbar">
          <button class="rd-toolbar-btn" id="rd-back" aria-label="Назад">${backIcon}</button>
          ${meta.cover ? `<img class="rd-toolbar-cover" src="${esc(lrCover(meta.cover))}" alt="" referrerpolicy="no-referrer">` : ''}
          <div class="rd-toolbar-book"><b>${esc(title)}</b><span>${esc(meta.author || '')}</span></div>
        </header>
        <div class="rd-book-heading">
          <span>СТРАНИЦА ${Number(d.page) || 1}</span>
          <i></i>
          <h1>${esc(title)}</h1>
        </div>
        <div class="rd-stage" id="rd-stage"><article class="reader rd-page" id="rd-cur">${rdBodyHTML(d)}</article></div>
        <button class="rd-fab is-away" id="rd-aa" aria-label="Настройки чтения" title="Настройки чтения">Aa</button>
      </div>
      ${rdPanelHTML()}`;
    if (title) document.title = title + ' — Bookify';
    rdApply();
    rdPage(true);
    if (rdView.id !== id) { rdView.cache.clear(); rdView.id = id; }
    rdView.src = d.page; rdView.total = d.total; rdView.title = d.title;
    rdView.si = 0; rdView.busy = false;
    renderBm(id, d.page, 0);
    renderNm(id, d.page);
    wireRdPanel(id);
    rdRelayout(false);
    bindRdSwipe();
    // вернуться на сохранённый экран (закладка или позиция чтения)
    const spot = pendingSpot && pendingSpot.id === id ? pendingSpot : null;
    pendingSpot = null;
    if (spot && spot.p === rdView.src && spot.c > 0) {
      rdView.si = Math.min(spot.c, rdView.cols - 1);
      rdPlaceInstant();
      rdSync();
    }
    rdPrefetch();
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = back + stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#back').onclick = () => goBack('rbook/' + id);
    $('#state-action').onclick = () => renderReader(id, page);
  }
}

/* ---------- 16. Плеер ---------- */

const audio = $('#audio');
let savedTick = 0;

const player = {
  book: null,
  index: 0,
  sheet: false,
  wantPlay: false,
  recovering: false,
  lastRecover: 0,

  get chapters() { return (this.book && this.book.chapters) || []; },
  get current() { return this.chapters[this.index] || null; },

  load(book, index = 0, autoplay = false) {
    this.book = book;
    this.index = Math.min(Math.max(0, index), Math.max(0, book.chapters.length - 1));
    const ch = this.current;
    if (!ch) return;
    audio.src = ch.url;
    audio.currentTime = 0;
    this.paint();
    if (autoplay) { this.wantPlay = true; audio.play().catch(() => toast('Нажмите ещё раз, чтобы начать воспроизведение')); }
  },

  play(i) {
    if (!this.book) return;
    if (typeof i === 'number' && i !== this.index) return this.load(this.book, i, true);
    this.wantPlay = true;
    const p = audio.play();
    if (p && p.catch) p.catch(err => this.recover(err));
  },

  pause() { if (this.book) { this.wantPlay = false; audio.pause(); } },

  toggle() {
    // Элемент мог «зависнуть»: формально играет, но звука нет и потока нет.
    const dead = audio.error || audio.networkState === audio.NETWORK_NO_SOURCE;
    if (audio.paused || dead) this.play(); else this.pause();
  },

  /* Воспроизведение не стартует — обычно ссылка на главу протухла, пока книга
     стояла на паузе, либо поток оборвался. Заново берём страницу книги и
     продолжаем с той же секунды. Раньше помогала только перезагрузка приложения. */
  async recover(err) {
    if (this.recovering || !this.book || !this.book.slug) return;
    if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
    const now = Date.now();
    if (now - this.lastRecover < 3000) return;      // не частим с перезапросами
    this.lastRecover = now;
    this.recovering = true;
    const at = audio.currentTime || 0;
    const index = this.index;
    try {
      store.drop('book:' + this.book.slug);
      const fresh = await apiBook(this.book.slug);
      if (!fresh.chapters.length) throw new Error('empty');
      this.book = fresh;
      this.index = Math.min(index, fresh.chapters.length - 1);
      audio.src = this.current.url;
      audio.load();
      if (at > 1) audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
      this.paint();
      await audio.play();
    } catch {
      toast('Не удалось включить — проверьте связь');
    } finally {
      this.recovering = false;
    }
  },

  next(auto = false) {
    if (this.index >= this.chapters.length - 1) {
      if (auto) {
        audio.pause();
        markBookCompleted('audio', this.book.slug, this.book.title);
      }
      return;
    }
    this.load(this.book, this.index + 1, true);
  },

  prev() {
    if (audio.currentTime > 4) { audio.currentTime = 0; return; }
    if (this.index > 0) this.load(this.book, this.index - 1, true);
  },

  seek(sec) { audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + sec)); },

  /* Закрыть аудиокнигу: останавливаем воспроизведение и убираем плеер.
     Позиция сохраняется — книгу можно продолжить с карточки «Продолжить слушать». */
  close() {
    if (!this.book) return;
    this.persist();
    const last = store.get('last');
    if (last) store.set('last', { ...last, closed: true }, 365 * 24 * 3600e3);
    // Книгу забываем до сброса src: иначе на пустой источник может прилететь
    // событие error, и плеер тут же поднимет книгу заново.
    this.book = null;
    this.index = 0;
    this.sheet = false;
    this.wantPlay = false;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    $('#sheet').classList.add('is-hidden');
    document.body.classList.remove('sheet-open', 'playing');
    $('#mini').classList.add('is-hidden');
    syncPlaying();
  },

  paint() {
    const b = this.book, ch = this.current;
    if (!b || !ch) return;
    const sub = ch.title;
    $('#mini-cover').src = coverImg(b.cover) || '';
    $('#mini-title').textContent = b.title;
    $('#mini-sub').textContent = sub;
    $('#sheet-cover').src = coverImg(b.cover, 'full') || '';
    $('#sheet-title').textContent = b.title;
    $('#sheet-sub').textContent = sub;
    $('#sheet-body').classList.toggle('has-chapters', b.chapters.length > 1);
    $('#sheet-amb').style.backgroundImage = b.cover ? `url("${coverImg(b.cover)}")` : 'none';
    $('#mini').classList.remove('is-hidden');

    const box = $('#sheet-chapters');
    if (b.chapters.length > 1) {
      box.innerHTML = b.chapters.map((c, i) => chapterRow(c, i, this.index)).join('');
      box.querySelectorAll('.chap').forEach(btn => {
        btn.onclick = () => this.load(b, Number(btn.dataset.i), true);
      });
      const cur = box.querySelector('.chap.is-current');
      if (cur) box.scrollTop = Math.max(0, cur.offsetTop - box.clientHeight / 2 + cur.clientHeight / 2);
    } else {
      box.innerHTML = '';
    }

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: ch.title,
          artist: b.readers.join(', ') || b.authors.join(', '),
          album: b.title,
          artwork: b.cover ? [{ src: coverImg(b.cover, 'full'), sizes: '512x512', type: 'image/jpeg' }] : [],
        });
      } catch {}
    }
    document.title = b.title + ' — Полка';
    this.persist();
    syncPlaying();
  },

  persist() {
    if (!this.book) return;
    store.set('last', {
      slug: this.book.slug,
      title: this.book.title,
      cover: this.book.cover,
      readers: this.book.readers,
      chapters: this.book.chapters,
      index: this.index,
      position: audio.currentTime || 0,
    }, 365 * 24 * 3600e3);
    // Прогресс книги, стоящей на полке, отправляем в облако.
    const chapters = this.book.chapters || [];
    let before = 0, total = 0;
    chapters.forEach((c, i) => { const d = Number(c.duration) || 0; total += d; if (i < this.index) before += d; });
    const pct = total ? Math.min(100, Math.round((before + (audio.currentTime || 0)) / total * 100)) : 0;
    shelfProgress('audio', this.book.slug, { pct, ch: this.index, pos: Math.round(audio.currentTime || 0) });
  },
};

/* Поднимаем последнюю книгу из сохранения. autoplay — для карточки «Продолжить слушать». */
function loadLast({ autoplay = false } = {}) {
  const last = store.get('last');
  if (!last || !last.chapters || !last.chapters.length) return false;
  player.book = { slug: last.slug, title: last.title, cover: last.cover, readers: last.readers || [], authors: [], chapters: last.chapters };
  player.index = Math.min(Math.max(0, last.index || 0), last.chapters.length - 1);
  audio.src = player.current.url;
  if (last.position > 5) audio.addEventListener('loadedmetadata', () => { audio.currentTime = last.position; }, { once: true });
  player.paint();
  document.body.classList.remove('playing');
  if (autoplay) audio.play().catch(() => {});
  return true;
}

function restoreLast() {
  const last = store.get('last');
  if (!last || last.closed) return;   // плеер закрыт вручную — не показываем
  loadLast();
}

/* --- события аудио --- */

audio.addEventListener('play', () => {
  document.body.classList.add('playing');
  // Начали слушать — книга сразу на полке.
  if (player.book) autoShelf('audio', player.book.slug, {
    title: player.book.title || '',
    cover: player.book.cover || '',
    author: (player.book.authors || [])[0] || '',
  });
  syncPlaying();
});
audio.addEventListener('pause', () => { document.body.classList.remove('playing'); syncPlaying(); });

audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0;
  const pct = d ? (audio.currentTime / d) * 100 : 0;
  $('#mini-bar').style.width = pct + '%';
  if (!sheetDragging) {
    $('#sheet-seek').value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
    $('#sheet-seek').style.setProperty('--p', pct + '%');
    $('#sheet-cur').textContent = fmtTime(audio.currentTime);
    $('#sheet-dur').textContent = fmtTime(d);
  }
  if (Date.now() - savedTick > 5000) { savedTick = Date.now(); player.persist(); }
});

audio.addEventListener('ended', () => player.next(true));

audio.addEventListener('error', () => { if (player.wantPlay) player.recover(); });

let sheetDragging = false;
$('#sheet-seek').addEventListener('input', () => {
  sheetDragging = true;
  const d = audio.duration || 0;
  const pct = Number($('#sheet-seek').value) / 10;
  $('#sheet-seek').style.setProperty('--p', pct + '%');
  $('#sheet-cur').textContent = fmtTime(d * $('#sheet-seek').value / 1000);
});
$('#sheet-seek').addEventListener('change', () => {
  const d = audio.duration || 0;
  if (d) audio.currentTime = d * $('#sheet-seek').value / 1000;
  sheetDragging = false;
});

/* --- управление --- */

$('#mini-play').onclick = e => { e.stopPropagation(); player.toggle(); };
$('#mini-close').onclick = e => { e.stopPropagation(); player.close(); };
$('#mini-open').onclick = () => openSheet();
$('#ctrl-play').onclick = () => player.toggle();
$('#ctrl-prev').onclick = () => player.prev();
$('#ctrl-next').onclick = () => player.next();
$('#ctrl-back').onclick = () => player.seek(-15);
$('#ctrl-fwd').onclick = () => player.seek(30);

function openSheet() {
  if (!player.book) return;
  player.sheet = true;
  $('#sheet').classList.remove('is-hidden');
  document.body.classList.add('sheet-open');
}
function closeSheet() {
  if (!player.sheet) return;
  player.sheet = false;
  $('#sheet').classList.add('is-hidden');
  document.body.classList.remove('sheet-open');
}
$('#sheet-grab').onclick = closeSheet;
$('#sheet-close').onclick = closeSheet;
$('#sheet-bg').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

if ('mediaSession' in navigator) {
  // именно play/pause, а не toggle: система присылает действие по своему
  // состоянию, и toggle от него работал наоборот — «пауза» больше не включалась
  navigator.mediaSession.setActionHandler('play', () => player.play());
  navigator.mediaSession.setActionHandler('pause', () => player.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => player.next());
  navigator.mediaSession.setActionHandler('previoustrack', () => player.prev());
  navigator.mediaSession.setActionHandler('seekbackward', () => player.seek(-15));
  navigator.mediaSession.setActionHandler('seekforward', () => player.seek(30));
}

/* ---------- 17. Тема ---------- */

function applyTheme(mode) {
  const theme = mode || localStorage.getItem('polka:theme')
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('polka:theme', theme);
  $('meta[name="theme-color"]').setAttribute('content', theme === 'light' ? '#f7f7f8' : '#000000');
}

/* ---------- 17.5 Аккаунт, Firebase и «Моя полка» ---------- */
/* Сервер данных — Realtime Database по REST: запись/чтение + поток событий
   (text/event-stream) для синхронизации в реальном времени между устройствами.
   Локально держим только сессию и кэш полки — приложение остаётся офлайн-первым. */

const FB = 'https://detective-8e070-default-rtdb.firebaseio.com';

async function fbReq(path, method = 'GET', data) {
  const opts = { method, cache: 'no-store' };
  if (data !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(data); }
  const r = await fetch(`${FB}/${path}.json`, opts);
  if (!r.ok) throw new Error('fb' + r.status);
  if (method === 'GET') return r.json();
  return r.json().catch(() => null);
}

/* --- Идентификаторы и пароли --- */

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // без похожих O/0/I/1

function randChars(n) {
  const buf = new Uint8Array(n);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < n; i++) out += ID_ALPHABET[buf[i] % ID_ALPHABET.length];
  return out;
}

const genUserId = () => 'BK' + randChars(6);

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function djb2hex(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/* Схема хэша записана в префиксе, поэтому вход работает и там, где WebCrypto
   недоступен (не-защищённый контекст): s1 — SHA-256, d1 — резервный. */
async function makeHash(uid, pass) {
  if (crypto.subtle) { try { return 's1:' + await sha256hex(uid + ':' + pass); } catch {} }
  return 'd1:' + djb2hex(uid + ':' + pass);
}

async function verifyHash(uid, pass, stored) {
  if (!stored) return false;
  if (String(stored).startsWith('d1:')) return 'd1:' + djb2hex(uid + ':' + pass) === stored;
  if (crypto.subtle) { try { return 's1:' + await sha256hex(uid + ':' + pass) === stored; } catch { return false; } }
  return false;
}

/* --- Локальное состояние --- */

let acc = null;              // { uid, name, pass, createdAt }
let shelf = {};             // { 'a:slug' | 'r:id': entry }
let profileStats = { activeSeconds: 0, completed: {} };
let fbStream = null;        // AbortController активного потока
let fbPoll = 0;             // таймер резервного опроса
let pushTimer = 0;
let nameTimer = 0;
let statsTimer = 0;
let activityTimer = 0;
let lastActivityAt = Date.now();
let lastStatsSyncAt = 0;
let syncState = 'idle';

const shelfKey = (kind, id) => (kind === 'audio' ? 'a:' : 'r:') + id;
const isShelfRoute = () => state.route === 'lib/';

function accLoad() { try { acc = JSON.parse(localStorage.getItem('polka:account')) || null; } catch { acc = null; } }
function accSave() { try { localStorage.setItem('polka:account', JSON.stringify(acc)); } catch {} vaultSave(); }
function shelfLoad() { try { shelf = JSON.parse(localStorage.getItem('polka:shelf')) || {}; } catch { shelf = {}; } }
/* Локальный «сейф» аккаунта: резерв для входа без сети и повторного входа
   на этом же устройстве, если сервер данных недоступен. */
function vaultSave() {
  if (!acc || !acc.uid) return;
  try { localStorage.setItem('polka:acc:' + acc.uid, JSON.stringify({ ...acc, shelf, stats: profileStats })); } catch {}
}
function vaultGet(uid) {
  try { const v = JSON.parse(localStorage.getItem('polka:acc:' + uid)); return v && v.pass ? v : null; } catch { return null; }
}
function shelfSave() { try { localStorage.setItem('polka:shelf', JSON.stringify(shelf)); } catch {} vaultSave(); }

function statsLoad(remote) {
  if (!acc || !acc.uid) {
    profileStats = { activeSeconds: 0, completed: {} };
    return;
  }
  let local = {};
  try { local = JSON.parse(localStorage.getItem('polka:stats:' + acc.uid)) || {}; } catch {}
  const cloud = remote && typeof remote === 'object' ? remote : {};
  profileStats = {
    activeSeconds: Math.max(Number(local.activeSeconds) || 0, Number(cloud.activeSeconds) || 0),
    completed: { ...(local.completed || {}), ...(cloud.completed || {}) },
  };
  statsSave(false);
}

function statsSave(sync = false) {
  if (!acc || !acc.uid) return;
  try { localStorage.setItem('polka:stats:' + acc.uid, JSON.stringify(profileStats)); } catch {}
  vaultSave();
  if (sync) pushStats();
  updateProfileStats();
}

function pushStats() {
  if (!acc) return;
  clearTimeout(statsTimer);
  setSync('sync');
  statsTimer = setTimeout(async () => {
    try {
      await fbReq('users/' + acc.uid + '/stats', 'PUT', profileStats);
      lastStatsSyncAt = Date.now();
      setSync('ok');
    } catch { lastStatsSyncAt = Date.now(); setSync('offline'); }
  }, 1800);
}

function applyRemoteStats(remote) {
  if (!remote || typeof remote !== 'object') return;
  const completed = { ...(profileStats.completed || {}), ...(remote.completed || {}) };
  const next = {
    activeSeconds: Math.max(Number(profileStats.activeSeconds) || 0, Number(remote.activeSeconds) || 0),
    completed,
  };
  if (JSON.stringify(next) === JSON.stringify(profileStats)) return;
  profileStats = next;
  statsSave(false);
}

function completedKey(kind, id) { return (kind === 'audio' ? 'a:' : 'r:') + id; }

function markBookCompleted(kind, id, title) {
  if (!acc || !id) return;
  const key = completedKey(kind, id);
  if (profileStats.completed[key]) return;
  profileStats.completed[key] = { title: String(title || '').slice(0, 180), completedAt: Date.now() };
  const entry = shelf[shelfKey(kind, id)];
  if (entry) {
    entry.prog = { ...(entry.prog || {}), pct: 100, complete: true };
    entry.updatedAt = Date.now();
    shelfSave();
    pushShelf();
  }
  statsSave(true);
  toast('Книга завершена');
}

function profileHours() {
  const seconds = Math.max(0, Math.floor(profileStats.activeSeconds || 0));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

function profileCompletedCount() {
  const completed = new Set(Object.keys(profileStats.completed || {}));
  Object.values(shelf).forEach(e => {
    if (e && e.id && ((e.prog && e.prog.complete) || Number(e.prog && e.prog.pct) >= 100))
      completed.add(completedKey(e.kind, e.id));
  });
  return completed.size;
}

function updateProfileStats() {
  const hours = $('#profile-hours'), done = $('#profile-completed'), progress = $('#profile-progress-count');
  if (hours) hours.textContent = profileHours();
  if (done) done.textContent = profileCompletedCount();
  if (progress) progress.textContent = Object.values(shelf).filter(e => e && Number(e.prog && e.prog.pct) > 0 && Number(e.prog.pct) < 100).length;
  const rows = $('#profile-progress-list');
  if (rows) rows.innerHTML = profileProgressHTML();
}

function startActivityTracking() {
  if (activityTimer) clearInterval(activityTimer);
  lastActivityAt = Date.now();
  document.addEventListener('visibilitychange', () => { lastActivityAt = Date.now(); });
  activityTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.min(30, Math.max(0, Math.floor((now - lastActivityAt) / 1000)));
    lastActivityAt = now;
    if (!acc || document.visibilityState !== 'visible' || !elapsed) return;
    profileStats.activeSeconds = (Number(profileStats.activeSeconds) || 0) + elapsed;
    const shouldSync = now - lastStatsSyncAt >= 60000;
    statsSave(shouldSync);
  }, 15000);
}

function syncText(s) {
  return s === 'sync' ? 'Синхронизация…'
    : s === 'offline' ? 'Нет связи — сохраним позже'
    : s === 'ok' ? 'Синхронизировано'
    : 'Готово';
}
function setSync(s) {
  syncState = s;
  const el = $('#shelf-sync');
  if (el) el.textContent = syncText(s);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  }
}

/* --- Операции с полкой --- */

function shelfHas(kind, id) { return !!shelf[shelfKey(kind, id)]; }

/* Книга сама встаёт на полку, как только её начали слушать или читать. */
function autoShelf(kind, id, info) {
  if (!acc || !id || shelfHas(kind, id)) return;
  shelfAdd({ kind, id, ...info });
  toast('Книга добавлена на полку');
}

function shelfAdd(entry) {
  if (!acc) { openGate('register'); return null; }
  const key = shelfKey(entry.kind, entry.id);
  const prev = shelf[key] || {};
  shelf[key] = { ...prev, ...entry, addedAt: prev.addedAt || Date.now(), updatedAt: Date.now() };
  shelfSave(); pushShelf(); refreshShelfButtons(); updateProfileStats();
  return shelf[key];
}

function shelfRemove(kind, id) {
  delete shelf[shelfKey(kind, id)];
  shelfSave(); pushShelf(); refreshShelfButtons(); updateProfileStats();
}

function shelfProgress(kind, id, prog) {
  const e = shelf[shelfKey(kind, id)];
  if (!e) return;
  e.prog = { ...(e.prog || {}), ...prog };
  e.updatedAt = Date.now();
  shelfSave(); pushShelf(); updateProfileStats();
}

function pushShelf() {
  if (!acc) return;
  clearTimeout(pushTimer);
  setSync('sync');
  pushTimer = setTimeout(async () => {
    try {
      await fbReq('users/' + acc.uid + '/shelf', 'PUT', shelf);
      await fbReq('users/' + acc.uid + '/updatedAt', 'PUT', Date.now());
      setSync('ok');
    } catch { setSync('offline'); }
  }, 1600);
}

function pushName() {
  if (!acc) return;
  clearTimeout(nameTimer);
  setSync('sync');
  nameTimer = setTimeout(async () => {
    try { await fbReq('users/' + acc.uid + '/name', 'PUT', acc.name || ''); setSync('ok'); }
    catch { setSync('offline'); }
  }, 1200);
}

async function pushAccount() {
  if (!acc) return;
  await fbReq('users/' + acc.uid, 'PUT', {
    name: acc.name || '', pass: acc.pass, createdAt: acc.createdAt || Date.now(),
    updatedAt: Date.now(), shelf, stats: profileStats,
  });
}

/* --- Синхронизация --- */

async function pullUser() {
  const node = await fbReq('users/' + acc.uid);
  if (node) applyRemoteNode(node);
}

function applyRemoteNode(n) {
  if (!n || typeof n !== 'object') return;
  if (n.shelf) applyRemoteShelf(n.shelf);
  if (n.stats) applyRemoteStats(n.stats);
  if (n.name && n.name !== acc.name) {
    acc.name = n.name; accSave();
    const inp = $('#profile-name'); if (inp) inp.value = n.name;
    const ava = $('#profile-avatar'); if (ava) ava.textContent = (n.name.trim().charAt(0) || 'Ч').toUpperCase();
  }
}

function applyRemoteShelf(remote) {
  const next = (remote && typeof remote === 'object') ? remote : {};
  if (JSON.stringify(next) === JSON.stringify(shelf)) return;
  shelf = next; shelfSave();
  refreshShelfButtons();
  if (isShelfRoute()) renderShelf();
  if (state.route === 'my/') renderProfile();
}

function stopRealtime() {
  if (fbStream) { try { fbStream.abort(); } catch {} fbStream = null; }
  if (fbPoll) { clearInterval(fbPoll); fbPoll = 0; }
}

/* Поток событий: сервер присылает put/patch по мере изменений. */
function startRealtime() {
  if (!acc) return;
  stopRealtime();
  const ctrl = new AbortController();
  fbStream = ctrl;
  fetch(`${FB}/users/${acc.uid}.json`, { headers: { Accept: 'text/event-stream' }, cache: 'no-store', signal: ctrl.signal })
    .then(async res => {
      if (!res.ok || !res.body) throw new Error('stream');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', evt = '', data = '';
      const flush = () => { if (data) applyStream(evt, data); evt = ''; data = ''; };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line === '') { flush(); continue; }
          if (line.startsWith('event:')) evt = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
      }
      throw new Error('closed');
    })
    .catch(() => { if (fbStream === ctrl) { fbStream = null; startPoll(); } });
}

function applyStream(evt, raw) {
  if (!acc) return;
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  const atRoot = msg.path === '/' || msg.path === '';
  if (evt === 'put') {
    if (atRoot || msg.path === '/shelf' || msg.path === '/name' || msg.path === '/stats') {
      if (atRoot) applyRemoteNode(msg.data);
      else if (msg.path === '/shelf') applyRemoteShelf(msg.data);
      else if (msg.path === '/stats') applyRemoteStats(msg.data);
      else if (msg.data !== acc.name) { acc.name = msg.data || ''; accSave(); const inp = $('#profile-name'); if (inp) inp.value = acc.name; }
    }
  } else if (evt === 'patch' && atRoot) {
    for (const k of Object.keys(msg.data || {})) {
      if (k === 'shelf') applyRemoteShelf(msg.data[k]);
      else if (k === 'stats') applyRemoteStats(msg.data[k]);
      else if (k === 'name' && msg.data[k] !== acc.name) {
        acc.name = msg.data[k] || ''; accSave();
        const inp = $('#profile-name'); if (inp) inp.value = acc.name;
      }
    }
  }
}

/* Резервный опрос — включается, если поток недоступен (правила/сеть/прокси). */
function startPoll() {
  if (fbPoll || !acc) return;
  setSync('sync');
  const tick = async () => {
    try { await pullUser(); setSync('ok'); }
    catch { setSync('offline'); }
  };
  tick();
  fbPoll = setInterval(tick, 12000);
}

/* --- Вход, регистрация, сессия --- */

async function uniqueUserId() {
  for (let i = 0; i < 6; i++) {
    const uid = genUserId();
    try { const ex = await fbReq('users/' + uid + '/createdAt'); if (!ex) return uid; }
    catch { return uid; }   // нет сети — создаём локально, синхронизируем позже
  }
  throw new Error('id');
}

async function createAccount(name, pass) {
  const uid = await uniqueUserId();
  const hash = await makeHash(uid, pass);
  acc = { uid, name: String(name || '').trim() || ('Читатель ' + uid.slice(-4)), pass: hash, createdAt: Date.now() };
  profileStats = { activeSeconds: 0, completed: {} };
  accSave(); shelf = {}; shelfSave();
  statsSave(false);
  try { await pushAccount(); setSync('ok'); }
  catch { setSync('offline'); toast('Аккаунт создан. Синхронизируем при появлении сети'); }
  afterAuth();
  return acc;
}

async function loginAccount(rawId, pass) {
  const uid = String(rawId || '').trim().toUpperCase();
  if (!uid) { const e = new Error('empty'); e.code = 'empty'; throw e; }
  let node = null, failed = false;
  try { node = await fbReq('users/' + uid); }
  catch { failed = true; }
  // Резерв: вход по локально сохранённым данным (офлайн или сервер недоступен).
  if (!node) {
    const local = vaultGet(uid);
    if (local && await verifyHash(uid, pass, local.pass)) {
      acc = { uid, name: local.name || '', pass: local.pass, createdAt: local.createdAt || Date.now() };
      accSave();
      shelf = (local.shelf && typeof local.shelf === 'object') ? local.shelf : {};
      statsLoad(local.stats);
      shelfSave();
      afterAuth();
      return acc;
    }
    const e = new Error(failed ? 'offline' : 'notfound');
    e.code = failed ? 'offline' : 'notfound';
    throw e;
  }
  if (!await verifyHash(uid, pass, node.pass)) { const e = new Error('badpass'); e.code = 'badpass'; throw e; }
  acc = { uid, name: node.name || '', pass: node.pass, createdAt: node.createdAt || Date.now() };
  accSave();
  shelf = (node.shelf && typeof node.shelf === 'object') ? node.shelf : {};
  statsLoad(node.stats);
  shelfSave();
  afterAuth();
  return acc;
}

function afterAuth() {
  closeGate();
  startRealtime();
  refreshShelfButtons();
  if (isShelfRoute()) renderShelf();
  if (state.route === 'my/') renderProfile();
  updateProfileStats();
}

function logout() {
  stopRealtime();
  clearTimeout(pushTimer); clearTimeout(nameTimer);
  clearTimeout(statsTimer);
  acc = null; shelf = {};
  profileStats = { activeSeconds: 0, completed: {} };
  try { localStorage.removeItem('polka:account'); localStorage.removeItem('polka:shelf'); } catch {}
  openGate('register');
}

/* --- Экран входа --- */

let gateMode = 'register';
let gateUid = '';

const refreshIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.9 4.5M20 5v6h-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const copyIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2" stroke="currentColor" stroke-width="1.7"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

function openGate(mode = 'register') {
  gateMode = mode;
  if (!gateUid) gateUid = genUserId();
  const g = $('#gate');
  g.classList.remove('is-hidden');
  g.innerHTML = gateHTML();
  bindGate();
  document.documentElement.classList.add('gated');
}

function closeGate() {
  const g = $('#gate');
  if (g) { g.classList.add('is-hidden'); g.innerHTML = ''; }
  document.documentElement.classList.remove('gated');
}

function gateHTML() {
  const reg = gateMode === 'register';
  return `
    <div class="gate-bg"></div>
    <div class="gate-card">
      <img class="gate-logo" src="assets/images/bookify-logo.jpg" alt="" />
      <h1 class="gate-title">${reg ? 'Добро пожаловать' : 'Вход в аккаунт'}</h1>
      <p class="gate-sub">${reg
        ? 'Профиль сохранит ваши книги и прогресс — они будут доступны на любом устройстве.'
        : 'Введите ID и пароль, чтобы вернуть свою полку и прогресс.'}</p>
      ${reg ? `
      <div class="gate-field">
        <label>Ваш ID</label>
        <div class="id-box">
          <b id="gate-uid">${esc(gateUid)}</b>
          <button type="button" class="copy-btn" id="gate-newid" title="Новый ID">${refreshIcon}</button>
          <button type="button" class="copy-btn" id="gate-copyid" title="Скопировать">${copyIcon}</button>
        </div>
      </div>
      <div class="gate-field">
        <label for="gate-name">Имя</label>
        <input id="gate-name" type="text" maxlength="40" autocomplete="nickname" placeholder="Как вас зовут" />
      </div>` : `
      <div class="gate-field">
        <label for="gate-idin">Ваш ID</label>
        <input id="gate-idin" type="text" maxlength="12" autocapitalize="characters" autocomplete="username" placeholder="BK000000" />
      </div>`}
      <div class="gate-field">
        <label for="gate-pass">Пароль</label>
        <input id="gate-pass" type="password" maxlength="64" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="Минимум 4 символа" />
      </div>
      <button class="gate-primary" id="gate-submit">${reg ? 'Создать аккаунт' : 'Войти'}</button>
      <button class="gate-switch" id="gate-switch">${reg ? 'Уже есть ID? Войти' : 'Создать новый аккаунт'}</button>
      <p class="gate-note">Данные нужны только для синхронизации вашей полки.</p>
    </div>`;
}

function bindGate() {
  if (gateMode === 'register') {
    $('#gate-newid').onclick = () => { gateUid = genUserId(); $('#gate-uid').textContent = gateUid; };
    $('#gate-copyid').onclick = async () => toast(await copyText(gateUid) ? 'ID скопирован' : 'Не удалось скопировать');
  }
  $('#gate-switch').onclick = () => openGate(gateMode === 'register' ? 'login' : 'register');
  const submit = $('#gate-submit');
  submit.onclick = () => submitGate(submit);
  $('#gate').querySelectorAll('input').forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitGate(submit); }
  }));
}

async function submitGate(btn) {
  const pass = ($('#gate-pass') || {}).value || '';
  if (pass.length < 4) { toast('Пароль — минимум 4 символа'); return; }
  if (gateMode === 'register') {
    const name = ($('#gate-name') || {}).value || '';
    const uid = gateUid;
    btn.disabled = true; btn.textContent = 'Создаём…';
    try {
      await createAccount(name, pass);
      showCreds(uid, pass, name);
    } catch {
      toast('Не удалось создать аккаунт');
      btn.disabled = false; btn.textContent = 'Создать аккаунт';
    }
  } else {
    const id = ($('#gate-idin') || {}).value || '';
    btn.disabled = true; btn.textContent = 'Входим…';
    try {
      await loginAccount(id, pass);
      toast('С возвращением!');
    } catch (e) {
      toast(e.code === 'notfound' ? 'Аккаунт с таким ID не найден'
        : e.code === 'badpass' ? 'Неверный пароль'
        : 'Нет сети — попробуйте позже');
      btn.disabled = false; btn.textContent = 'Войти';
    }
  }
}

/* Окно с данными доступа: кнопки «копировать» и просьба сделать скриншот. */
function showCreds(uid, pass, name) {
  const m = $('#accm');
  const masked = '••••••';
  m.classList.remove('is-hidden');
  m.innerHTML = `
    <div class="modal-bg"></div>
    <div class="modal-card">
      <div class="cred-badge">✓</div>
      <h2>${pass ? 'Аккаунт создан' : 'Данные для входа'}</h2>
      <p class="cred-note">${pass
        ? 'Сохраните данные доступа — по ним вы войдёте на другом устройстве. Сделайте скриншот этого экрана.'
        : 'Ваш ID для входа. Сделайте скриншот этого экрана.'}</p>
      <div class="cred-row">
        <span class="cred-k">ID</span>
        <b class="cred-v">${esc(uid)}</b>
        <button class="copy-btn" data-copy="${esc(uid)}">${copyIcon}Копировать</button>
      </div>
      ${pass ? `<div class="cred-row">
        <span class="cred-k">Пароль</span>
        <b class="cred-v" id="cred-pass" data-val="${esc(pass)}">${esc(masked)}</b>
        <button class="copy-btn" id="cred-eye">Показать</button>
      </div>` : ''}
      ${name ? `<div class="cred-row"><span class="cred-k">Имя</span><b class="cred-v">${esc(name)}</b></div>` : ''}
      <button class="modal-primary" id="cred-copy-all">Скопировать всё</button>
      <label class="cred-check"><input type="checkbox" id="cred-shot" /> Я сделал(а) скриншот и сохранил(а) данные</label>
      <button class="modal-primary" id="cred-go" disabled>Продолжить</button>
    </div>`;

  const all = pass ? `ID: ${uid}\nПароль: ${pass}` : `ID: ${uid}`;
  m.querySelectorAll('.copy-btn[data-copy]').forEach(b => b.onclick = async () => {
    toast(await copyText(b.dataset.copy) ? 'Скопировано' : 'Не удалось скопировать');
  });
  const eye = $('#cred-eye');
  if (eye) eye.onclick = () => {
    const v = $('#cred-pass');
    const shown = v.textContent !== masked;
    v.textContent = shown ? masked : v.dataset.val;
    eye.textContent = shown ? 'Показать' : 'Скрыть';
  };
  $('#cred-copy-all').onclick = async () => toast(await copyText(all) ? 'Данные скопированы' : 'Не удалось скопировать');
  const shot = $('#cred-shot'), go = $('#cred-go');
  shot.onchange = () => { go.disabled = !shot.checked; };
  go.onclick = () => {
    m.classList.add('is-hidden'); m.innerHTML = '';
    if (isShelfRoute()) renderShelf();
    if (pass) showOnboarding(uid);
  };
}

const onboardingSteps = [
  {
    icon: '◫', title: 'Выбирай свой формат',
    text: 'Во вкладке «Библиотека» можно переключаться между аудиокнигами и книгами для чтения. Жанры и подборки меняются вместе с форматом.',
  },
  {
    icon: '+', title: 'Сохраняй на свою полку',
    text: 'На странице любой книги нажми «На полку». Книга останется рядом, а прогресс чтения или прослушивания сохранится.',
  },
  {
    icon: '⌕', title: 'Ищи книги и авторов',
    text: 'Начни вводить имя автора: в подсказке можно открыть его страницу и посмотреть книги. Поиск по названию работает как обычно.',
  },
  {
    icon: '↗', title: 'Следи за прогрессом',
    text: 'В профиле собраны время в приложении, завершённые книги и текущий прогресс. Синхронизация доступна при подключении к сети.',
  },
];

function showOnboarding(uid, index = 0) {
  const key = 'polka:onboarded:' + uid;
  try { if (localStorage.getItem(key)) return; } catch {}
  const m = $('#accm');
  const step = onboardingSteps[index];
  if (!m || !step) return;
  m.classList.remove('is-hidden');
  m.innerHTML = `
    <div class="modal-bg"></div>
    <section class="modal-card onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div class="onboarding-progress" aria-label="Шаг ${index + 1} из ${onboardingSteps.length}">
        ${onboardingSteps.map((_, i) => `<i class="${i <= index ? 'is-active' : ''}"></i>`).join('')}
      </div>
      <div class="onboarding-icon">${step.icon}</div>
      <span class="library-eyebrow">БЫСТРОЕ ЗНАКОМСТВО · ${index + 1}/${onboardingSteps.length}</span>
      <h2 id="onboarding-title">${step.title}</h2>
      <p class="onboarding-copy">${step.text}</p>
      <button class="modal-primary" id="onboarding-next">${index === onboardingSteps.length - 1 ? 'Начать пользоваться' : 'Дальше'}</button>
      <button class="onboarding-skip" id="onboarding-skip">Пропустить знакомство</button>
    </section>`;
  const finish = () => {
    try { localStorage.setItem(key, '1'); } catch {}
    m.classList.add('is-hidden');
    m.innerHTML = '';
  };
  $('#onboarding-next').onclick = () => {
    if (index === onboardingSteps.length - 1) finish();
    else showOnboarding(uid, index + 1);
  };
  $('#onboarding-skip').onclick = finish;
}

/* --- Полка --- */

const plusIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
const checkIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function paintShelfBtn(btn, kind, id) {
  const on = shelfHas(kind, id);
  btn.classList.toggle('is-on', on);
  btn.innerHTML = (on ? checkIcon : plusIcon) + (on ? 'На полке' : 'На полку');
}

function refreshShelfButtons() {
  $$('.shelf-cta[data-kind]').forEach(btn => paintShelfBtn(btn, btn.dataset.kind, btn.dataset.id));
}

/* Кнопка «На полку» на странице книги: добавляет/убирает и отражает состояние. */
function toggleShelfFromBook(btn, info) {
  if (shelfHas(info.kind, info.id)) {
    shelfRemove(info.kind, info.id);
    toast('Убрано с полки');
  } else {
    if (!shelfAdd(info)) return;   // нет аккаунта — открыли экран входа
    toast('Добавлено на полку');
  }
  if (btn) paintShelfBtn(btn, info.kind, info.id);
}

function shelfCardHTML(e) {
  const key = shelfKey(e.kind, e.id);
  const pct = Math.max(0, Math.min(100, Math.round((e.prog && e.prog.pct) || 0)));
  const href = e.kind === 'audio' ? `#/book/${esc(e.id)}` : `#/rbook/${esc(e.id)}`;
  const img = e.cover ? (e.kind === 'audio' ? coverImg(e.cover) : lrCover(e.cover)) : '';
  return `<a class="shelf-card" href="${href}" data-key="${esc(key)}">
    <div class="shelf-cover">
      ${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<span class="shelf-ph"></span>'}
      <span class="shelf-kind">${e.kind === 'audio' ? 'Аудио' : 'Текст'}</span>
      ${pct > 0 ? `<span class="shelf-pct">${pct}%</span>` : ''}
      <span class="shelf-prog"><i style="width:${pct}%"></i></span>
      <button class="shelf-del" data-key="${esc(key)}" aria-label="Убрать с полки" title="Убрать с полки">✕</button>
    </div>
    <div class="shelf-title">${esc(e.title || 'Без названия')}</div>
    <div class="shelf-sub">${esc(e.author || '')}</div>
  </a>`;
}

function renderShelf() {
  ++state.seq;
  state.cat = 'lib'; state.back = 'lib'; state.items = []; state.ended = true; state.loading = false;
  clearTail();
  if (!acc) { view.innerHTML = stateHTML('Нужен вход', 'Войдите в аккаунт, чтобы открыть полку.'); return; }
  const list = Object.values(shelf).filter(e => e && e.id).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const audio = list.filter(e => e.kind === 'audio');
  const read = list.filter(e => e.kind === 'read');
  view.innerHTML = `<section class="shelf-page-head">
    <span class="library-eyebrow">ТВОЯ КОЛЛЕКЦИЯ</span>
    <h1>Моя полка</h1>
    <p>${list.length ? `${list.length} ${list.length === 1 ? 'книга' : 'книг'} сохранено` : 'Сохраняй книги, чтобы вернуться к ним позже.'}</p>
  </section>` + (list.length
    ? (audio.length ? `<div class="section-title">Аудиокниги · ${audio.length}</div><div class="shelf-grid">${audio.map(shelfCardHTML).join('')}</div>` : '') +
      (read.length ? `<div class="section-title">Книги для чтения · ${read.length}</div><div class="shelf-grid">${read.map(shelfCardHTML).join('')}</div>` : '')
    : `<div class="shelf-empty">
        <div class="shelf-empty-ico">${plusIcon}</div>
        <b>Полка пока пуста</b>
        <span>Откройте книгу или аудиокнигу и нажмите «На полку» — она появится здесь вместе с прогрессом.</span>
        <button class="gate-primary" id="shelf-goto">Открыть библиотеку</button>
      </div>`);
  bindShelf();
  syncPlaying();
}

function bindShelf() {
  const goto = $('#shelf-goto');
  if (goto) goto.onclick = () => go('library');
  $$('.shelf-del[data-key]').forEach(btn => btn.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    delete shelf[btn.dataset.key];
    shelfSave(); pushShelf();
    toast('Убрано с полки');
    renderShelf();
  });
}

function accountBoot() {
  accLoad(); shelfLoad();
  statsLoad();
  startActivityTracking();
  window.addEventListener('online', () => { if (acc) { pushShelf(); pushStats(); if (!fbStream && !fbPoll) startRealtime(); } });
  if (acc && acc.uid) afterAuth();
  else openGate('register');
}

/* ---------- 18. Инициализация ---------- */

function bindUI() {
  $('#btn-theme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  };
  $('#btn-search').onclick = () => {
    if (parseHash().parts[0] === 'search') return $('#search-input').focus();
    go('search');
  };
  const input = $('#search-input');
  const clearBtn = $('#search-clear');
  const runSearchDebounced = debounce(() => runSearch(input.value), 500);

  $('#search-cancel').onclick = () => {
    input.value = '';
    syncClear();
    input.blur();
    goBack('cat/new');
  };
  clearBtn.onclick = () => {
    input.value = '';
    syncClear();
    input.focus();
    runSearch('');
  };

  // Переключатель «Аудиокниги / Читать»
  $('#search-modes').addEventListener('click', e => {
    const btn = e.target.closest('.search-mode');
    if (btn) setSearchMode(btn.dataset.sm);
  });

  input.addEventListener('input', () => { syncClear(); runSearchDebounced(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      input.blur();
      const q = input.value.trim();
      if (q) go('search?q=' + encodeURIComponent(q));
    }
  });

  $('#chips').addEventListener('click', e => {
    const tab = e.target.closest('.chip-tab');
    if (!tab || tab.dataset.m !== (document.body.dataset.mode || 'listen')) return;
    const cat = tab.dataset.cat;
    if (tab.dataset.m === 'read') go(cat === 'genres' ? 'rgenres' : 'read');
    else go(cat === 'genres' ? 'genres' : 'cat/' + cat);
  });

  $('#tabbar').addEventListener('click', e => {
    const btn = e.target.closest('.tabbar-btn');
    if (!btn) return;
    const t = btn.dataset.tab;
    // Кнопка главной всегда ведёт на главную, в каком бы режиме ни была библиотека.
    const { parts: cur } = parseHash();
    const curHead = cur[0] || 'cat';
    const onThisTab = t === 'cat' ? (curHead === 'cat' && (cur[1] || 'new') === 'new') : curHead === t;
    if (onThisTab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (t === 'cat') go('cat/new');
    else if (t === 'library') go('library');
    else if (t === 'my') go('my');
    else if (t === 'lib') go('lib');
    else if (t === 'player') {
      if (player.book) return openSheet();
      if (loadLast({ autoplay: true })) openSheet();
      else toast('Выберите аудиокнигу для прослушивания');
    }
  });

  // Стрелки ←/→ — листание экранов в читалке
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && rdPanelOpen) { openRdPanel(false); return; }
    if (!rdView.id || e.altKey || e.metaKey || e.ctrlKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); rdFlip(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); rdFlip(-1); }
  });

  // Офлайн-режим реагирует на пропажу и возвращение сети
  window.addEventListener('online', netUpdate);
  window.addEventListener('offline', netUpdate);
  $('#dl-cancel').onclick = () => {
    if (dl.task) { dl.task.cancel = true; $('#dl-sub').textContent = 'Останавливаю…'; }
  };
  window.addEventListener('scroll', () => {
    saveScroll();
  }, { passive: true });
}

function routeFromLocation(event) {
  if (cseSearchDepth && event && event.type !== 'popstate') return;
  const hash = cleanHash();
  if (hash === lastLocationHash) return;
  lastLocationHash = hash;
  route();
}

function boot() {
  applyTheme();
  rdApply();
  paintSearchMode();
  // загрузки, прерванные закрытием страницы, помечаем как паузу — их можно продолжить
  Object.keys(localStorage).filter(k => k.startsWith('polka:dl:')).forEach(k => {
    try {
      const r = JSON.parse(localStorage.getItem(k));
      if (r.d && r.d.status === 'active') { r.d.status = 'paused'; localStorage.setItem(k, JSON.stringify(r)); }
    } catch {}
  });
  bindUI();
  restoreLast();
  lastLocationHash = cleanHash();
  window.addEventListener('hashchange', routeFromLocation);
  window.addEventListener('popstate', routeFromLocation);
  const startOffline = !navigator.onLine;
  document.body.classList.toggle('is-offline', startOffline);
  if (!location.hash) go(startOffline ? 'cat/offline' : (localStorage.getItem('polka:mode') === 'read' ? 'read' : 'cat/new'), { replace: true });
  else route();

  accountBoot();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();

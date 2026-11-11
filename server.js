import express from 'express';
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Konfig ─────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;       // News alle 30 Min
const WEATHER_INTERVAL_MS = 15 * 60 * 1000;       // Wetter alle 15 Min
const FETCH_TIMEOUT_MS = 12_000;

const GLADBECK_RSS = 'http://selfdb.gkd-re.de/selfdbinter140/feed140.rss?db=404&form=list&orderby=fieldDatum&desc=true&searchfieldBeginndatum.max=heute&searchfieldAblaufdatum.min=heute&feedname=Aktuelle%20News%20aus%20Gladbeck';
const GELSENKIRCHEN_RSS = 'https://www.gelsenkirchen.de/de/_funktionsnavigation/presse/pressemeldungen/newsfeed/bereich/4-presse';
const FLVW_RSS = 'https://flvw.de/feed/rss/de.rss';
const FUSSBALL_DE_URL = 'https://www.fussball.de/';
const FUSSBALL_DE_ALL_NEWS = 'https://www.fussball.de/news/-/include/all_news';
const NEWS_SOURCES = [
  { key: 'gladbeck', name: 'Stadt Gladbeck', url: 'https://www.gladbeck.de/', feedUrl: GLADBECK_RSS, limit: 6 },
  { key: 'gelsenkirchen', name: 'Stadt Gelsenkirchen', url: 'https://www.gelsenkirchen.de/', feedUrl: GELSENKIRCHEN_RSS, limit: 6 },
  { key: 'westfalen', name: 'FLVW · Westfalen', url: 'https://flvw.de/', feedUrl: FLVW_RSS, limit: 8, regional: true },
  { key: 'fussball', name: 'fussball.de', url: FUSSBALL_DE_URL, limit: 10 },
];

// Keywords für "Zweckel und Umgebung" — Region Gladbeck + Ruhrgebiet + Westfalen
const REGION_KEYWORDS = [
  'zweckel', 'gladbeck', 'westfalen', 'flvw', 'ruhrgebiet', 'revier',
  'bottrop', 'gelsenkirchen', 'bochum', 'essen', 'recklinghausen',
  'dorsten', 'marl', 'herten', 'datteln', 'oberhausen', 'wattenscheid',
  'kreisliga', 'bezirksliga', 'landesliga westfalen', 'oberliga westfalen',
];
const REGION_REGEX = new RegExp('\\b(' + REGION_KEYWORDS.join('|') + ')\\b', 'i');

// Gladbeck Koordinaten für Open-Meteo
const WEATHER_LAT = 51.5717;
const WEATHER_LON = 6.9852;

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { 'User-Agent': 'WorldfootballNewsBot/1.0 (+local)' },
  customFields: {
    item: [
      ['media:thumbnail', 'media:thumbnail', { keepArray: true }],
      ['media:content', 'media:content', { keepArray: true }],
    ],
  },
});

// ── Cache ──────────────────────────────────────────────────────────
const cache = {
  news: { items: [], updatedAt: null, errors: [], sources: [] },
  weather: { current: null, updatedAt: null, error: null },
};
const pendingRefreshes = { news: null, weather: null };
const lastSuccessfulNews = new Map();

function getFreshCache(key, maxAge, refresh) {
  if (pendingRefreshes[key]) return pendingRefreshes[key];

  const updatedAt = Date.parse(cache[key].updatedAt || '');
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt < maxAge) {
    return Promise.resolve(cache[key]);
  }

  // Bei kaltem oder abgelaufenem Cache teilen gleichzeitige Anfragen einen Abruf.
  // Die Aktualisierung läuft innerhalb der Anfrage, auch auf Serverless-Instanzen.
  pendingRefreshes[key] = Promise.resolve().then(refresh).finally(() => {
    pendingRefreshes[key] = null;
  });
  return pendingRefreshes[key];
}

const getNews = () => getFreshCache('news', REFRESH_INTERVAL_MS, refreshNews);
const getWeather = () => getFreshCache('weather', WEATHER_INTERVAL_MS, refreshWeather);

// ── Helper: HTML strip ────────────────────────────────────────────
function stripHtml(html = '') {
  // Manche Feeds kürzen mitten in einem Tag oder Entity und hängen "..." an.
  // Nur diesen markierten Rest entfernen; der fehlende Text wird nicht ergänzt.
  const cleaned = String(html)
    .replace(/<(?:\/?[a-z][^<>]*)?(?:\.{3}|…)\s*$/i, '…')
    .replace(/&(?:#(?:x[0-9a-f]*|\d*)|[a-z][a-z0-9]*)(?:\.{3}|…)\s*$/i, '…');
  const $ = cheerio.load(cleaned);
  $('script, style, noscript').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
}

function trim(s = '', n = 220) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function httpUrl(value, base, removeHash = false) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value.trim(), base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (removeHash) url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function publicationDate(...values) {
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return null;
}

function rssImage(item, base) {
  const candidates = [];
  for (const field of ['media:thumbnail', 'media:content']) {
    const entries = item[field] ? [].concat(item[field]) : [];
    for (const entry of entries) {
      const media = entry?.$ || entry;
      if (!media || typeof media !== 'object') continue;
      const isImage = field === 'media:thumbnail' || media.medium === 'image' ||
        String(media.type || '').startsWith('image/') ||
        (!media.medium && !media.type && /\.(avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(media.url || ''));
      if (isImage) candidates.push(media.url);
    }
  }
  const enclosure = item.enclosure;
  if (enclosure && (String(enclosure.type || '').startsWith('image/') ||
      (!enclosure.type && /\.(avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(enclosure.url || '')))) {
    candidates.push(enclosure.url);
  }
  for (const html of [item['content:encoded'], item.content, item.summary]) {
    if (!html) continue;
    const $ = cheerio.load(String(html));
    $('img').each((_, image) => {
      candidates.push($(image).attr('src'), $(image).attr('data-src'), $(image).attr('data-original'));
    });
  }
  return candidates.map(value => httpUrl(value, base)).find(Boolean) || null;
}

function normalizeArticles(items, source) {
  const unique = new Map();
  for (const item of items) {
    const url = httpUrl(item.url, source.url, true);
    const title = stripHtml(item.title || '');
    if (!url || !title || unique.has(url)) continue;
    unique.set(url, {
      ...item,
      source: source.name,
      sourceKey: source.key,
      title,
      url,
      pubDate: publicationDate(item.pubDate),
      summary: trim(stripHtml(item.summary || ''), 260),
      image: httpUrl(item.image, url),
      regional: !!item.regional,
    });
  }
  return [...unique.values()].slice(0, source.limit);
}

async function fetchWithTimeout(url, readResponse) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WorldfootballNewsBot/1.0)',
        'Accept-Language': 'de-DE,de;q=0.9',
      },
    });
    // Timeout umfasst auch das Lesen des Antwortkörpers.
    return await readResponse(response);
  } finally {
    clearTimeout(t);
  }
}

// ── RSS/Atom: Stadtportale und FLVW ────────────────────────────────
async function fetchRss(source) {
  const feed = await parser.parseURL(source.feedUrl);
  const base = httpUrl(feed.link, source.feedUrl) || source.url;
  const items = (feed.items || []).map((it) => {
    const url = httpUrl(it.link, base, true);
    return {
      title: it.title || '',
      url,
      pubDate: publicationDate(it.pubDate, it.isoDate, it.updated),
      summary: it.contentSnippet || it['content:encodedSnippet'] || it.summary || it.content || it['content:encoded'] || '',
      bodyHtml: it['content:encoded'] || it.content || it.summary || '',
      image: rssImage(it, url || base),
      regional: !!source.regional,
    };
  });
  return { items };
}

// ── Scraper: fussball.de — both Homepage + all_news ──────────────
function isRegional(text = '') {
  return REGION_REGEX.test(text);
}

async function scrapeFussballPage(url) {
  const html = await fetchWithTimeout(url, async (res) => {
    if (!res.ok) throw new Error(`fussball.de ${url} → status ${res.status}`);
    return res.text();
  });
  const $ = cheerio.load(html);
  const items = [];

  $('a[href*="/newsdetail/"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href');
    if (!href) return;
    const fullUrl = httpUrl(href, url, true);
    if (!fullUrl) return;
    const title =
      $a.attr('title')?.trim() ||
      $a.find('h2,h3,h4,.title,.headline').first().text().trim() ||
      $a.text().replace(/\s+/g, ' ').trim();
    if (!title || title.length < 12) return;
    if (/^(mehr anzeigen|alle news|weiterlesen)$/i.test(title)) return;
    if (items.some((x) => x.url === fullUrl)) return;
    const summary = $a.find('p,.teaser,.summary').first().text().replace(/\s+/g, ' ').trim();
    const $img = $a.find('img').first();
    const img = httpUrl($img.attr('src'), url) || httpUrl($img.attr('data-src'), url);
    const haystack = `${title} ${summary} ${href}`;
    const regional = isRegional(haystack);
    items.push({
      title: trim(title, 140),
      url: fullUrl,
      pubDate: publicationDate($a.find('time[datetime]').first().attr('datetime')),
      summary: trim(summary, 260),
      bodyHtml: '',
      image: img,
      regional,
    });
  });

  return items;
}

async function fetchFussballDe() {
  // Beide Quellen parallel: Homepage (Top-News) + all_news (vollständige Liste)
  const [homeRes, allRes] = await Promise.allSettled([
    scrapeFussballPage(FUSSBALL_DE_URL),
    scrapeFussballPage(FUSSBALL_DE_ALL_NEWS),
  ]);

  const merged = new Map(); // url → item, dedup
  const failures = [];
  for (const r of [homeRes, allRes]) {
    if (r.status === 'fulfilled') {
      for (const it of r.value) {
        // Bei Duplikaten: regionale Variante bevorzugen
        const existing = merged.get(it.url);
        if (!existing || (!existing.regional && it.regional)) merged.set(it.url, it);
      }
    } else {
      failures.push(String(r.reason?.message || r.reason));
    }
  }
  const all = [...merged.values()];
  // Regionale Items zuerst, dann Rest
  all.sort((a, b) => Number(b.regional) - Number(a.regional));
  if (!all.length && failures.length) throw new Error(failures.join('; '));
  return { items: all, error: failures.length ? failures.join('; ') : undefined };
}

// ── News-Aggregator ────────────────────────────────────────────────
async function refreshNews() {
  const results = await Promise.allSettled(NEWS_SOURCES.map((source) =>
    source.key === 'fussball' ? fetchFussballDe() : fetchRss(source)));
  const updatedAt = new Date().toISOString();
  const errors = [];
  const collected = results.map((r, idx) => {
    const src = NEWS_SOURCES[idx];
    const source = { key: src.key, name: src.name, url: src.url };
    if (r.status === 'fulfilled') {
      const items = normalizeArticles(r.value.items, src);
      lastSuccessfulNews.set(src.key, { items, updatedAt });
      if (r.value.error) errors.push({ source: src.key, error: r.value.error });
      console.log(`[news] ${src.key}: ${items.length} items${r.value.error ? ' (partial)' : ''}`);
      return {
        items,
        source: { ...source, status: r.value.error ? 'partial' : items.length ? 'ok' : 'empty',
          count: 0, updatedAt, ...(r.value.error ? { error: r.value.error } : {}) },
      };
    }
    const error = String(r.reason?.message || r.reason);
    const previous = lastSuccessfulNews.get(src.key);
    errors.push({ source: src.key, error });
    console.error(`[news] ${src.key} failed:`, error);
    return {
      items: previous?.items || [],
      source: { ...source, status: previous?.items.length ? 'stale' : 'error', count: 0,
        updatedAt: previous?.updatedAt || null, error },
    };
  });

  // Frische Artikel gewinnen bei Duplikaten gegen zurückgehaltene ältere Daten.
  const unique = new Map();
  for (const group of [...collected].sort((a, b) => Number(a.source.status === 'stale') - Number(b.source.status === 'stale'))) {
    for (const item of group.items) if (!unique.has(item.url)) unique.set(item.url, item);
  }
  const items = [...unique.values()];
  for (const group of collected) group.source.count = items.filter(item => item.sourceKey === group.source.key).length;
  // Nach Datum sortieren (neueste zuerst), Items ohne Datum hinten
  items.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  cache.news = { items, updatedAt, errors, sources: collected.map(group => group.source) };
  return cache.news;
}

// ── Wetter via Open-Meteo (kostenlos, kein Key, CORS-frei) ────────
async function refreshWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Europe%2FBerlin&forecast_days=4`;
  try {
    const data = await fetchWithTimeout(url, async (res) => {
      if (!res.ok) throw new Error(`Open-Meteo status ${res.status}`);
      return res.json();
    });
    cache.weather = {
      current: {
        temperature: data.current?.temperature_2m,
        feelsLike: data.current?.apparent_temperature,
        humidity: data.current?.relative_humidity_2m,
        wind: data.current?.wind_speed_10m,
        isDay: data.current?.is_day === 1,
        code: data.current?.weather_code,
        time: data.current?.time,
      },
      forecast: (data.daily?.time || []).map((date, i) => ({
        date,
        code: data.daily.weather_code[i],
        max: data.daily.temperature_2m_max[i],
        min: data.daily.temperature_2m_min[i],
        precipProb: data.daily.precipitation_probability_max[i],
      })),
      location: 'Gladbeck',
      updatedAt: new Date().toISOString(),
      error: null,
    };
    console.log(`[weather] ok: ${cache.weather.current.temperature}°C`);
  } catch (e) {
    cache.weather.error = String(e.message || e);
    cache.weather.updatedAt = new Date().toISOString();
    console.error('[weather] failed:', e.message || e);
  }
  return cache.weather;
}

// ── Routes ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/news', async (req, res, next) => {
  try {
    const news = await getNews();
    res.set('Cache-Control', 'public, max-age=60');
    res.json(news);
  } catch (error) {
    next(error);
  }
});

app.get('/api/weather', async (req, res, next) => {
  try {
    const weather = await getWeather();
    res.set('Cache-Control', 'public, max-age=120');
    res.json(weather);
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', async (req, res, next) => {
  try {
    const [news, weather] = await Promise.all([getNews(), getWeather()]);
    res.json({
      ok: true,
      newsCount: news.items.length,
      newsUpdatedAt: news.updatedAt,
      weatherUpdatedAt: weather.updatedAt,
      weatherOk: !!weather.current,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Boot ───────────────────────────────────────────────────────────
async function boot() {
  console.log('[boot] initial fetch …');
  await Promise.allSettled([getNews(), getWeather()]);
  app.listen(PORT, () => {
    console.log(`\n  Worldfootball News Page → http://localhost:${PORT}\n`);
  });
}

export default app;

// Vercel importiert die App; npm start und npm run dev starten den lokalen Server.
if (!process.env.VERCEL && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  boot();
}

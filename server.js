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
const GELSENKIRCHEN_RSS = 'https://www.gelsenkirchen.de/de/_meta/aktuelles/artikel/newsfeed/';
const FUSSBALL_DE_URL = 'https://www.fussball.de/';

// Gladbeck Koordinaten für Open-Meteo
const WEATHER_LAT = 51.5717;
const WEATHER_LON = 6.9852;

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { 'User-Agent': 'WorldfootballNewsBot/1.0 (+local)' },
});

// ── Cache ──────────────────────────────────────────────────────────
const cache = {
  news: { items: [], updatedAt: null, errors: [] },
  weather: { current: null, updatedAt: null, error: null },
};

// ── Helper: HTML strip ────────────────────────────────────────────
function stripHtml(html = '') {
  return cheerio.load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}

function trim(s = '', n = 220) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WorldfootballNewsBot/1.0)',
        'Accept-Language': 'de-DE,de;q=0.9',
        ...(opts.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

// ── Scraper: Gladbeck RSS ─────────────────────────────────────────
async function fetchGladbeck() {
  const feed = await parser.parseURL(GLADBECK_RSS);
  return (feed.items || []).slice(0, 6).map((it) => {
    const desc = stripHtml(it.contentSnippet || it.content || '');
    return {
      source: 'Stadt Gladbeck',
      sourceKey: 'gladbeck',
      title: (it.title || '').trim(),
      url: it.link,
      pubDate: it.pubDate || it.isoDate || null,
      summary: trim(desc, 260),
      bodyHtml: it.content || it['content:encoded'] || '',
    };
  });
}

// ── Scraper: Gelsenkirchen Atom ───────────────────────────────────
async function fetchGelsenkirchen() {
  const feed = await parser.parseURL(GELSENKIRCHEN_RSS);
  return (feed.items || []).slice(0, 6).map((it) => {
    const desc = stripHtml(it.contentSnippet || it.content || it.summary || '');
    return {
      source: 'Stadt Gelsenkirchen',
      sourceKey: 'gelsenkirchen',
      title: (it.title || '').trim(),
      url: it.link,
      pubDate: it.pubDate || it.isoDate || it.updated || null,
      summary: trim(desc, 260),
      bodyHtml: it.content || it['content:encoded'] || it.summary || '',
    };
  });
}

// ── Scraper: fussball.de (next.fussball.de redirects here) ────────
async function fetchFussballDe() {
  const res = await fetchWithTimeout(FUSSBALL_DE_URL);
  if (!res.ok) throw new Error(`fussball.de status ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const items = [];

  $('a[href*="/newsdetail/"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href');
    if (!href) return;
    const fullUrl = href.startsWith('http') ? href : new URL(href, FUSSBALL_DE_URL).toString();
    const title =
      $a.attr('title')?.trim() ||
      $a.find('h2,h3,h4,.title,.headline').first().text().trim() ||
      $a.text().replace(/\s+/g, ' ').trim();
    if (!title || title.length < 12) return;
    if (/^(mehr anzeigen|alle news|weiterlesen)$/i.test(title)) return;
    if (items.some((x) => x.url === fullUrl)) return;
    const summary = $a.find('p,.teaser,.summary').first().text().replace(/\s+/g, ' ').trim();
    const img = $a.find('img').first().attr('src') || $a.find('img').first().attr('data-src') || null;
    items.push({
      source: 'next.fussball.de',
      sourceKey: 'fussball',
      title: trim(title, 140),
      url: fullUrl,
      pubDate: null,
      summary: trim(summary, 260),
      bodyHtml: '',
      image: img,
    });
  });

  return items.slice(0, 6);
}

// ── News-Aggregator ────────────────────────────────────────────────
async function refreshNews() {
  const sources = [
    { key: 'gladbeck', fn: fetchGladbeck },
    { key: 'gelsenkirchen', fn: fetchGelsenkirchen },
    { key: 'fussball', fn: fetchFussballDe },
  ];

  const results = await Promise.allSettled(sources.map((s) => s.fn()));
  const items = [];
  const errors = [];

  results.forEach((r, idx) => {
    const src = sources[idx];
    if (r.status === 'fulfilled') {
      items.push(...r.value);
      console.log(`[news] ${src.key}: ${r.value.length} items`);
    } else {
      errors.push({ source: src.key, error: String(r.reason?.message || r.reason) });
      console.error(`[news] ${src.key} failed:`, r.reason?.message || r.reason);
    }
  });

  // Nach Datum sortieren (neueste zuerst), Items ohne Datum hinten
  items.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  cache.news = { items, updatedAt: new Date().toISOString(), errors };
  return cache.news;
}

// ── Wetter via Open-Meteo (kostenlos, kein Key, CORS-frei) ────────
async function refreshWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Europe%2FBerlin&forecast_days=4`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Open-Meteo status ${res.status}`);
    const data = await res.json();
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

app.get('/api/news', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(cache.news);
});

app.get('/api/weather', (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  res.json(cache.weather);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    newsCount: cache.news.items.length,
    newsUpdatedAt: cache.news.updatedAt,
    weatherUpdatedAt: cache.weather.updatedAt,
    weatherOk: !!cache.weather.current,
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Boot ───────────────────────────────────────────────────────────
async function boot() {
  console.log('[boot] initial fetch …');
  await Promise.allSettled([refreshNews(), refreshWeather()]);
  setInterval(() => refreshNews().catch((e) => console.error('[news] interval error', e)), REFRESH_INTERVAL_MS);
  setInterval(() => refreshWeather().catch((e) => console.error('[weather] interval error', e)), WEATHER_INTERVAL_MS);
  app.listen(PORT, () => {
    console.log(`\n  Worldfootball News Page → http://localhost:${PORT}\n`);
  });
}

boot();

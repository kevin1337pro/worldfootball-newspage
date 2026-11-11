import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import express from 'express';
import Parser from 'rss-parser';

const realFetch = globalThis.fetch;
const RealDate = Date;
const realParseURL = Parser.prototype.parseURL;
let now = RealDate.now(), instance = 0, fixtures, failures, football, weatherFailed, calls;
function reset() {
  fixtures = Object.fromEntries(['gladbeck', 'gelsenkirchen', 'westfalen'].map(key => [key, {
    link: 'https://' + key + '.example/',
    items: [{ title: 'Testnachricht ' + key, link: '/artikel/' + key,
      pubDate: '2026-11-11T12:00:00Z', content: '<p>Nachrichtentext</p>' }],
  }]));
  failures = new Set();
  const html = '<a href="/newsdetail/test"><h2>Fußball-Nachricht aus Gladbeck</h2><p>Test</p></a>';
  football = { home: html, all: html };
  weatherFailed = false;
  calls = { feeds: 0, football: 0, weather: 0 };
}
reset();
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
Parser.prototype.parseURL = async function (url) {
  calls.feeds += 1;
  await new Promise(resolve => setTimeout(resolve, 10));
  const key = url.includes('gkd-re') ? 'gladbeck' : url.includes('gelsenkirchen') ? 'gelsenkirchen' : 'westfalen';
  if (key === 'gelsenkirchen') {
    assert.equal(new URL(url).pathname, '/de/_funktionsnavigation/presse/pressemeldungen/newsfeed/bereich/4-presse',
      'Use the official city press feed; the general feed only contains old anniversary stories');
  }
  if (failures.has(key)) throw new Error('Mock ' + key + ' unavailable');
  return typeof fixtures[key] === 'string' ? this.parseString(fixtures[key]) : fixtures[key];
};
globalThis.fetch = async function (url) {
  const address = String(url);
  await new Promise(resolve => setTimeout(resolve, 10));
  if (address.startsWith('https://api.open-meteo.com/')) {
    calls.weather += 1;
    if (weatherFailed) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({
      current: { temperature_2m: 16, apparent_temperature: 15, relative_humidity_2m: 70,
        wind_speed_10m: 8, is_day: 1, weather_code: 2, time: new Date().toISOString() },
      daily: { time: ['2026-11-11'], weather_code: [2], temperature_2m_max: [17],
        temperature_2m_min: [9], precipitation_probability_max: [10] },
    }) };
  }
  if (address.startsWith('https://www.fussball.de/')) {
    calls.football += 1;
    const html = football[address.includes('all_news') ? 'all' : 'home'];
    if (html instanceof Error) throw html;
    return { ok: true, text: async () => html };
  }
  throw new Error('Unexpected outbound request: ' + address);
};
async function withApp(run) {
  const { default: app } = await import('../server.js?test=' + ++instance);
  assert.equal(typeof app, 'function');
  assert.deepEqual(calls, { feeds: 0, football: 0, weather: 0 }, 'Import must not fetch or boot');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  async function get(path = '/api/news') {
    const response = await realFetch('http://127.0.0.1:' + server.address().port + path);
    assert.equal(response.status, 200, path);
    return response.json();
  }
  try { await run(get); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
const source = (news, key) => news.sources.find(entry => entry.key === key);
const article = (news, key) => news.items.find(entry => entry.sourceKey === key);
const expire = () => { now += 31 * 60 * 1000; };

if (process.env.WORLDFOOTBALL_TEST_PRELOAD === '1') {
  express.application.listen = function (port, callback) {
    assert.equal(port, '0');
    assert.deepEqual(calls, { feeds: 3, football: 2, weather: 1 });
    console.log('LOCAL_BOOT_OK');
    callback();
    return {};
  };
} else {
  after(() => {
    globalThis.fetch = realFetch;
    globalThis.Date = RealDate;
    Parser.prototype.parseURL = realParseURL;
  });
  test('concurrent cold requests share refreshes; warm caches and separate TTLs work', async () => {
    reset();
    await withApp(async get => {
      const paths = Array.from({ length: 6 }, () => ['/api/news', '/api/weather', '/api/health']).flat();
      const responses = await Promise.all(paths.map(get));
      assert.deepEqual(calls, { feeds: 3, football: 2, weather: 1 });
      const news = responses[0];
      assert.deepEqual(Object.keys(news).sort(), ['errors', 'items', 'sources', 'updatedAt']);
      assert.equal(news.items.length, 4);
      assert.deepEqual(news.errors, []);
      assert.equal(news.sources.length, 4);
      assert.ok(news.sources.every(entry => entry.status === 'ok' && entry.count === 1));
      assert.equal(responses[1].current.temperature, 16);
      assert.equal(responses[2].newsCount, 4);
      assert.equal(responses[2].weatherOk, true);
      await Promise.all(paths.map(get));
      assert.deepEqual(calls, { feeds: 3, football: 2, weather: 1 });
      now += 16 * 60 * 1000;
      await Promise.all(paths.map(get));
      assert.deepEqual(calls, { feeds: 3, football: 2, weather: 2 });
      now += 15 * 60 * 1000;
      await Promise.all(paths.map(get));
      assert.deepEqual(calls, { feeds: 6, football: 4, weather: 3 });
    });
  });
  test('normalizes real article/image URLs and dates; deduplicates and rejects unsafe links', async () => {
    reset();
    fixtures.gladbeck = {
      link: 'https://www.gladbeck.de/aktuelles/',
      items: [
        { title: '<b>Rathaus &amp; Sport</b>', link: 'bericht#oben', pubDate: 'Wed, 11 Nov 2026 12:00:00 GMT',
          content: '<p>Ein <b>Bericht</b>.</p><script>alert(1)</script>',
          'media:thumbnail': [{ $: { url: '../bilder/bericht.jpg' } }] },
        { title: 'Duplikat', link: 'bericht#unten' },
        ...['javascript:alert(1)', 'data:text/html,bad', 'ftp://host/story', '', null, 'https://user:password@example.com/story']
          .map(link => ({ title: 'Ungültiger Link', link })),
        { title: ' ', link: '/ohne-titel' },
      ],
    };
    fixtures.gelsenkirchen.items = [
      { title: 'Quellenübergreifendes Duplikat', link: 'https://www.gladbeck.de/aktuelles/bericht#other' },
      { title: 'Stadtmeldung', link: '/stadtmeldung', pubDate: 'not-a-date',
        enclosure: { url: '//images.example/stadt.webp', type: 'image/webp' } },
    ];
    fixtures.westfalen = '<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">' +
      '<channel><title>FLVW</title><link>https://flvw.de/</link><description>Verband</description>' +
      '<item><title>Westfalen im Blick</title><link>https://flvw.de/news/beitrag</link>' +
      '<media:content url="/bilder/beitrag.webp" medium="image" type="image/webp" />' +
      '<description><![CDATA[<p>Sport &amp; Vereine</p>]]></description></item></channel></rss>';
    football.home = football.all = '<a href="/newsdetail/regional#top"><h2>Neue Fußball-Nachricht aus Gladbeck</h2>' +
      '<p>Fußball in der Region</p><img src="data:image/png,bad" data-src="/bilder/platz.jpg">' +
      '<time datetime="2026-11-10T10:15:00+01:00"></time></a>' +
      '<a href="javascript:alert(\'/newsdetail/bad\')"><h2>Dieser Artikel darf nicht erscheinen</h2></a>';
    await withApp(async get => {
      const news = await get();
      assert.equal(news.items.length, 4);
      assert.equal(new Set(news.items.map(item => item.url)).size, news.items.length);
      assert.equal(news.sources.reduce((sum, entry) => sum + entry.count, 0), news.items.length);
      const local = article(news, 'gladbeck');
      assert.equal(local.title, 'Rathaus & Sport');
      assert.equal(local.url, 'https://www.gladbeck.de/aktuelles/bericht');
      assert.equal(local.summary, 'Ein Bericht.');
      assert.equal(local.image, 'https://www.gladbeck.de/bilder/bericht.jpg');
      assert.equal(local.pubDate, '2026-11-11T12:00:00.000Z');
      assert.equal(article(news, 'gelsenkirchen').image, 'https://images.example/stadt.webp');
      assert.equal(article(news, 'gelsenkirchen').pubDate, null);
      assert.equal(article(news, 'westfalen').image, 'https://flvw.de/bilder/beitrag.webp');
      assert.equal(article(news, 'westfalen').summary, 'Sport & Vereine');
      assert.equal(article(news, 'westfalen').pubDate, null);
      assert.equal(article(news, 'fussball').regional, true);
      assert.equal(article(news, 'fussball').source, 'fussball.de');
      assert.equal(article(news, 'fussball').image, 'https://www.fussball.de/bilder/platz.jpg');
      assert.equal(article(news, 'fussball').pubDate, '2026-11-10T09:15:00.000Z');
      for (const item of news.items) assert.match(item.url, /^https?:\/\//);
    });
  });
  test('RSS summaries remove upstream truncated tags and entities without inventing missing text', async () => {
    reset();
    const samples = [
      ['<div><p>Die Arbeiten sollen bis Mittwoch laufen.</p><...', 'Die Arbeiten sollen bis Mittwoch laufen. …'],
      ['<p>Die persönliche Begrü&s...', 'Die persönliche Begrü…'],
      ['<ul><li>Faire Finanzierung für Städte</l...', 'Faire Finanzierung für Städte…'],
      ['<p>Sport &amp; Vereine: 3 &lt; 5, A &amp; B.</p>', 'Sport & Vereine: 3 < 5, A & B.'],
      ['<p>Ein positives Signal für d...', 'Ein positives Signal für d...'],
    ];
    fixtures.gladbeck = '<?xml version="1.0"?><rss version="2.0"><channel>' +
      '<title>Stadt</title><link>https://gladbeck.example/</link><description>News</description>' +
      samples.map(([html], index) => `<item><title>Meldung ${index}</title>` +
        `<link>https://gladbeck.example/${index}</link><description><![CDATA[${html}]]></description></item>`).join('') +
      '</channel></rss>';
    await withApp(async get => {
      const news = await get();
      for (const [index, [, expected]] of samples.entries()) {
        assert.equal(news.items.find(item => item.url === `https://gladbeck.example/${index}`).summary, expected);
      }
    });
  });
  test('RSS inline images resolve against article URL; invalid images and absent dates stay null', async () => {
    reset();
    fixtures.gladbeck.items[0] = { title: 'Bericht mit Bild', link: '/news/beitrag',
      content: '<p>Vereinsnachricht</p><img src="javascript:bad" data-src="../media/platz.webp">' };
    fixtures.gelsenkirchen.items[0].enclosure = { url: 'https://media.example/podcast.mp3', type: 'audio/mpeg' };
    fixtures.gelsenkirchen.items[0]['media:thumbnail'] = [{ $: { url: 'data:image/png,not-allowed' } }];
    await withApp(async get => {
      const news = await get();
      assert.equal(article(news, 'gladbeck').image, 'https://gladbeck.example/media/platz.webp');
      assert.equal(article(news, 'gladbeck').pubDate, null);
      assert.equal(article(news, 'gelsenkirchen').image, null);
      assert.equal(article(news, 'fussball').pubDate, null);
    });
  });
  test('successful empty sources differ from failed sources without history', async () => {
    reset();
    fixtures.gladbeck.items = [];
    fixtures.gelsenkirchen.items = [{ title: 'Kein gültiger Artikel', link: 'javascript:bad' }];
    failures.add('westfalen');
    football.home = new Error('Homepage unavailable');
    football.all = new Error('News list unavailable');
    await withApp(async get => {
      const news = await get();
      assert.equal(news.items.length, 0);
      assert.equal(source(news, 'gladbeck').status, 'empty');
      assert.equal(source(news, 'gelsenkirchen').status, 'empty');
      assert.ok(source(news, 'gladbeck').updatedAt);
      for (const key of ['westfalen', 'fussball']) {
        assert.equal(source(news, key).status, 'error');
        assert.equal(source(news, key).updatedAt, null);
      }
      assert.match(source(news, 'fussball').error, /Homepage unavailable.*News list unavailable/);
      assert.equal(news.errors.length, 2);
      assert.ok(news.sources.every(entry => entry.count === 0));
    });
  });
  test('outages retain source articles and successful timestamps, then recover', async () => {
    reset();
    await withApp(async get => {
      const before = await get();
      await get('/api/weather');
      failures.add('gladbeck');
      football.home = football.all = new Error('Football unavailable');
      weatherFailed = true;
      expire();
      const failed = await get();
      for (const key of ['gladbeck', 'fussball']) {
        assert.equal(source(failed, key).status, 'stale');
        assert.equal(source(failed, key).updatedAt, source(before, key).updatedAt);
        assert.deepEqual(article(failed, key), article(before, key));
      }
      assert.notEqual(failed.updatedAt, before.updatedAt);
      assert.notEqual(source(failed, 'westfalen').updatedAt, source(before, 'westfalen').updatedAt);
      assert.equal(failed.errors.length, 2);
      const weather = await get('/api/weather');
      assert.equal(weather.error, 'Open-Meteo status 503');
      assert.equal(weather.current.temperature, 16);
      expire();
      assert.equal(source(await get(), 'gladbeck').updatedAt, source(before, 'gladbeck').updatedAt);
      failures.clear();
      football.home = football.all = '<a href="/newsdetail/new"><h2>Neue aktuelle Fußball-Nachricht</h2></a>';
      weatherFailed = false;
      expire();
      const recovered = await get();
      assert.deepEqual(recovered.errors, []);
      assert.equal(source(recovered, 'gladbeck').status, 'ok');
      assert.equal(source(recovered, 'fussball').status, 'ok');
      assert.equal(article(recovered, 'fussball').url, 'https://www.fussball.de/newsdetail/new');
      assert.equal((await get('/api/weather')).error, null);
    });
  });
  test('football reports partial, error or empty according to both upstream results', async () => {
    reset();
    football.home = new Error('Homepage unavailable');
    await withApp(async get => {
      const news = await get();
      assert.equal(source(news, 'fussball').status, 'partial');
      assert.equal(source(news, 'fussball').count, 1);
      assert.equal(news.errors[0].source, 'fussball');
    });
    reset();
    football.home = '';
    football.all = new Error('News list unavailable');
    await withApp(async get => {
      const news = await get();
      assert.equal(source(news, 'fussball').status, 'error');
      assert.equal(source(news, 'fussball').count, 0);
    });
    reset();
    football.home = football.all = '';
    await withApp(async get => {
      const news = await get();
      assert.equal(source(news, 'fussball').status, 'empty');
      assert.deepEqual(news.errors, []);
    });
  });
  test('fresh syndicated articles win over stale copies from another source', async () => {
    reset();
    await withApp(async get => {
      const sharedUrl = article(await get(), 'gladbeck').url;
      failures.add('gladbeck');
      fixtures.gelsenkirchen.items = [{ title: 'Frischer syndizierter Artikel', link: sharedUrl }];
      expire();
      const news = await get();
      assert.equal(news.items.filter(item => item.url === sharedUrl).length, 1);
      assert.equal(news.items.find(item => item.url === sharedUrl).sourceKey, 'gelsenkirchen');
      assert.equal(source(news, 'gladbeck').count, 0);
      assert.equal(source(news, 'gelsenkirchen').count, 1);
    });
  });
  test('local direct start still boots without persistent timers', () => {
    const env = { ...process.env, PORT: '0', WORLDFOOTBALL_TEST_PRELOAD: '1' };
    delete env.VERCEL;
    const local = spawnSync(process.execPath, [
      '--import', fileURLToPath(import.meta.url), fileURLToPath(new URL('../server.js', import.meta.url)),
    ], { env, encoding: 'utf8', timeout: 5000 });
    assert.ifError(local.error);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /LOCAL_BOOT_OK/);
  });
}

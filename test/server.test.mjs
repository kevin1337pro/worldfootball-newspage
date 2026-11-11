import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express from 'express';
import Parser from 'rss-parser';

const realFetch = globalThis.fetch;
const RealDate = Date;
let now = RealDate.now();
let failSources = false;
const calls = { feeds: 0, football: 0, weather: 0 };

globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};

Parser.prototype.parseURL = async function (url) {
  calls.feeds += 1;
  await new Promise(resolve => setTimeout(resolve, 20));
  if (failSources && url.includes('gkd-re')) throw new Error('Mock RSS unavailable');
  return { items: [{
    title: 'Testnachricht aus Gladbeck', link: `${url}#article`,
    pubDate: new Date().toISOString(), content: '<p>Nachrichtentext</p>',
  }] };
};

globalThis.fetch = async function (url) {
  const address = String(url);
  await new Promise(resolve => setTimeout(resolve, 20));
  if (address.startsWith('https://api.open-meteo.com/')) {
    calls.weather += 1;
    if (failSources) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({
      current: { temperature_2m: 16, apparent_temperature: 15,
        relative_humidity_2m: 70, wind_speed_10m: 8, is_day: 1,
        weather_code: 2, time: new Date().toISOString() },
      daily: { time: ['2026-11-11'], weather_code: [2], temperature_2m_max: [17],
        temperature_2m_min: [9], precipitation_probability_max: [10] },
    }) };
  }
  if (address.startsWith('https://www.fussball.de/')) {
    calls.football += 1;
    return { ok: true, text: async () => '<a href="/newsdetail/test"><h2>Fußball-Testnachricht aus der Region</h2><p>Test</p></a>' };
  }
  throw new Error(`Unexpected outbound request: ${address}`);
};

if (process.env.WORLDFOOTBALL_TEST_PRELOAD === '1') {
  express.application.listen = function (port, callback) {
    assert.equal(port, '0');
    assert.deepEqual(calls, { feeds: 3, football: 2, weather: 1 });
    console.log('LOCAL_BOOT_OK');
    callback();
    return {};
  };
} else {
  test('Express export, cold concurrent requests, TTL expiry, failures and local boot', async () => {
    const { default: app } = await import('../server.js');
    assert.equal(typeof app, 'function');
    assert.deepEqual(calls, { feeds: 0, football: 0, weather: 0 }, 'Import must not fetch or boot');

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    async function get(path) {
      const response = await realFetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      return response.json();
    }
    try {
      const paths = Array.from({ length: 6 }, () => ['/api/news', '/api/weather', '/api/health']).flat();
      const responses = await Promise.all(paths.map(get));
      assert.deepEqual(calls, { feeds: 3, football: 2, weather: 1 }, 'Concurrent cold requests must deduplicate');
      const news = responses[0];
      assert.deepEqual(Object.keys(news).sort(), ['errors', 'items', 'updatedAt']);
      assert.equal(news.items.length, 4);
      assert.deepEqual(news.errors, []);
      assert.equal(responses[1].current.temperature, 16);
      assert.equal(responses[2].newsCount, 4);
      assert.equal(responses[2].weatherOk, true);

      await Promise.all(paths.map(get));
      assert.deepEqual(calls, { feeds: 3, football: 2, weather: 1 }, 'Warm cache must avoid upstream calls');

      now += 16 * 60 * 1000;
      await Promise.all(paths.map(get));
      assert.deepEqual(calls, { feeds: 3, football: 2, weather: 2 }, 'Only weather expires at 16 minutes');

      now += 15 * 60 * 1000;
      await Promise.all(paths.map(get));
      assert.deepEqual(calls, { feeds: 6, football: 4, weather: 3 }, 'Both expire by 31 minutes');

      failSources = true;
      now += 31 * 60 * 1000;
      const [failedNews, failedWeather] = await Promise.all([get('/api/news'), get('/api/weather')]);
      assert.equal(failedNews.errors[0].source, 'gladbeck');
      assert.equal(failedWeather.error, 'Open-Meteo status 503');
      assert.equal(failedWeather.current.temperature, 16, 'Preserve last successful weather on failure');

      failSources = false;
      now += 31 * 60 * 1000;
      const [recoveredNews, recoveredWeather] = await Promise.all([get('/api/news'), get('/api/weather')]);
      assert.deepEqual(recoveredNews.errors, []);
      assert.equal(recoveredWeather.error, null, 'Refresh promises must reset after errors');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      globalThis.fetch = realFetch;
      globalThis.Date = RealDate;
    }

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

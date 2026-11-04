'use strict';
/** Suche, Merkliste, Verlauf und Qualitätsstufen. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const fakeJf = require('./fixtures/fake-jellyfin');
const { score, variants, parseQuery, fold } = require('../lib/library');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Such-Bewertung', () => {
  assert.strictEqual(fold('Straße Überfall'), 'strasse uberfall');
  assert.ok(variants('Rueckkehr').includes('Rückkehr'));
  assert.ok(variants('herr der ringe').includes('ringe') || variants('herr der ringe').includes('herr'));
  assert.deepStrictEqual(parseQuery('matrix 1999'), { text: 'matrix', year: 1999 });
  const it = (name, year) => ({ name, year, type: 'Movie' });
  assert.ok(score(it('Matrix', 1999), 'matrix', null) > score(it('Matrix Reloaded', 2003), 'matrix', null), 'exakt vor Anfang');
  assert.ok(score(it('Matrix', 1999), 'matrix', 1999) > score(it('Matrix', 2021), 'matrix', 1999), 'Jahr zählt');
  assert.ok(score(it('Der Herr der Ringe', 2001), 'herr ringe', null) > 0, 'Wörter in beliebiger Reihenfolge');
  assert.ok(score(it('Interstellar', 2014), 'intersteller', null) > 0, 'Tippfehler');
  assert.strictEqual(score(it('Up', 2009), 'matrix', null), 0);
});

test('Suche, Merkliste, Verlauf, Qualität', { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lib-'));
  const jf = await fakeJf.start();
  const { I } = jf;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = 'l'.repeat(40);
  const procs = [
    spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: token, ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(tmp, 'd'), CACHE_DIR: path.join(tmp, 'c') }, stdio: 'ignore' }),
    spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.js')], { env: { ...process.env, RELAY_URL: `ws://127.0.0.1:${port}/agent`, AGENT_TOKEN: token, JELLYFIN_URL: `http://127.0.0.1:${jf.port}`, JELLYFIN_API_KEY: 'k', DATA_DIR: path.join(tmp, 'a'), ADMIN_PORT: '0' }, stdio: 'ignore' }),
  ];
  let ws;
  t.after(() => { try { ws && ws.close(); } catch { /* egal */ } for (const p of procs) p.kill(); jf.server.close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await (await fetch(`${base}/healthz`)).json()).agent) break; } catch { /* startet */ } await sleep(100); }
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  await req('POST', '/api/login', { username: 'chef', password: 'geheim123' });

  /* Suche */
  const s1 = (await req('GET', '/api/search?q=rueckkehr')).data;
  assert.deepStrictEqual(s1.movies.map((x) => x.name), ['Die Rückkehr der Ritter'], 'ue → ü');
  const s2 = (await req('GET', '/api/search?q=ritter')).data;
  assert.deepStrictEqual(s2.movies.map((x) => x.name), ['Ritter der Nacht', 'Die Rückkehr der Ritter'], 'Titelanfang vor Wort mittendrin');
  const s3 = (await req('GET', '/api/search?q=ritter 1999')).data;
  assert.strictEqual(s3.movies[0].name, 'Die Rückkehr der Ritter', 'Jahr in der Suche');
  const s4 = (await req('GET', '/api/search?q=testserie')).data;
  assert.strictEqual(s4.series[0].name, 'Testserie');
  const s5 = (await req('GET', '/api/search?q=2012')).data;
  assert.deepStrictEqual(s5.movies.map((x) => x.name), ['Ritter der Nacht'], 'nur Jahr');

  /* Qualitätsstufen aus der Quelle */
  const q4k = (await req('GET', `/api/item/${I.M_RUECK}`)).data;
  assert.strictEqual(q4k.qualities[0].label, 'Original · 4K HDR · 60 Mbit/s');
  assert.deepStrictEqual(q4k.qualities.map((q) => q.id), ['direct', '40000000', '20000000', '10000000', '6000000', '3000000', '1500000']);
  assert.match(q4k.qualities[1].label, /^4K · 40 Mbit\/s$/);
  const q720 = (await req('GET', `/api/item/${I.M_4K}`)).data;
  assert.deepStrictEqual(q720.qualities.map((q) => q.id), ['direct', '3000000', '1500000'], '720p mit 4 Mbit/s: nichts darüber');
  assert.strictEqual(q720.qualities[0].label, 'Original · HD · 4 Mbit/s');
  const q1080 = (await req('GET', `/api/item/${I.M_NEU}`)).data;
  assert.deepStrictEqual(q1080.qualities.map((q) => q.id), ['direct', '6000000', '3000000', '1500000'], '1080p mit 8 Mbit/s');

  /* Merkliste */
  assert.strictEqual((await req('POST', '/api/watchlist', { itemId: I.M_RUECK })).data.on, true);
  await req('POST', '/api/watchlist', { itemId: I.SERIES });
  const wl = (await req('GET', '/api/watchlist')).data.items.map((x) => x.name);
  assert.deepStrictEqual(wl, ['Testserie', 'Die Rückkehr der Ritter'], 'neueste zuerst');
  assert.strictEqual((await req('GET', `/api/item/${I.M_RUECK}`)).data.inWatchlist, true);
  assert.strictEqual((await req('POST', '/api/watchlist', { itemId: I.M_RUECK })).data.on, false, 'erneut = entfernen');

  /* Verlauf: wer schaut, bekommt den Titel unter „Zuletzt geschaut“ */
  const { code } = (await req('POST', '/api/rooms')).data;
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`, { headers: { Cookie: cookie } });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'load', itemId: I.M_NEU }));
  await sleep(300);
  ws.send(JSON.stringify({ t: 'control', action: 'play', position: 20 }));
  ws.send(JSON.stringify({ t: 'status', pos: 20, state: 'playing', drift: 0 }));
  let hist = [];
  for (let i = 0; i < 140 && !hist.length; i++) { await sleep(100); hist = (await req('GET', '/api/history')).data.items; }
  assert.strictEqual(hist[0].title, 'Neuer Film');
  assert.ok(hist[0].pos >= 20 && hist[0].progress > 30, `Fortschritt ${hist[0].progress} %`);
  assert.ok((await req('GET', `/api/item/${I.M_NEU}`)).data.resume >= 20);
  await req('DELETE', `/api/history/${I.M_NEU}`);
  assert.deepStrictEqual((await req('GET', '/api/history')).data.items, []);
});

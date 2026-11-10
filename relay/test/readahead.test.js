'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fakeJf = require('./fixtures/fake-jellyfin');
const { parsePlaylist } = require('../lib/readahead');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parsePlaylist findet HLS-Segmentfolgen (Jellyfin-hls1-Format)', () => {
  const body = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nhls1/abc/60000.ts\n#EXTINF:6.0,\nhls1/abc/120000.ts\n#EXT-X-ENDLIST\n';
  assert.deepEqual(parsePlaylist(body).map((s) => [s.sub, s.ticks]), [['hls1/abc/60000.ts', 60000], ['hls1/abc/120000.ts', 120000]]);
  assert.deepEqual(parsePlaylist('#EXTM3U\nmain.m3u8?x=1\n'), [], 'Kein Segment in Master-Playlist');
});

test('Idle-Readahead: Segment-Request löst Vorabrufe späterer Segmente aus (low-Priorität)', { timeout: 45000 }, async (t) => {
  const P = fakeJf.addPlaybackVersions();
  const jf = await fakeJf.start();
  const http = require('node:http');
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ra-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: 's'.repeat(40),
    ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(dir, 'relay'), CACHE_DIR: path.join(dir, 'cache'),
    AUTO_MAX_MBPS: '10', READAHEAD_SEGMENTS: '4', READAHEAD_AHEAD: '1', READAHEAD_MAX: '2' };
  const root = path.join(__dirname, '../..');
  const children = [spawn(process.execPath, [path.join(root, 'relay/server.js')], { env, stdio: 'ignore' }),
    spawn(process.execPath, [path.join(root, 'agent/agent.js')], { env: { ...env, DATA_DIR: path.join(dir, 'agent'),
      RELAY_URL: `ws://127.0.0.1:${port}/agent`, JELLYFIN_URL: `http://127.0.0.1:${jf.port}`, JELLYFIN_API_KEY: 'k', ADMIN_PORT: '0', MAX_UPLOAD_MBPS: '0' }, stdio: 'ignore' })];
  t.after(async () => {
    await Promise.all(children.map((child) => new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', r); child.kill(); })));
    await new Promise((r) => jf.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function req(endpoint) {
    const response = await fetch(base + endpoint, { headers: { Cookie: cookie } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.text() };
  }
  for (let i = 0; i < 150; i++) { try { if ((await (await fetch(base + '/healthz')).json()).agent) break; } catch { /* startup */ } await sleep(50); }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: 'geheim123' }) });
  assert.equal(login.status, 200);
  const sc = login.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];

  const ms = require('crypto').createHash('md5').update('source-HD').digest('hex');
  assert.equal((await req(`/stream/${P.HD}/master.m3u8?ms=${ms}&br=8000000`)).status, 200);
  const child = await req(`/stream/${P.HD}/main.m3u8?MediaSourceId=${ms}&PlaySessionId=${'ab'.repeat(16)}&MaxStreamingBitrate=8000000`);
  assert.equal(child.status, 200);
  assert.match(child.body, /hls1\/s4lt\/60000\.ts/, 'Relay gibt die Fake-Segmentliste durch');

  fakeJf.requests.length = 0; // ab hier zählen
  assert.equal((await req(`/stream/${P.HD}/hls1/s4lt/60000.ts?MediaSourceId=${ms}&PlaySessionId=${'ab'.repeat(16)}`)).status, 200);
  // ahead=1 → Vorabruf startet bei Index 2 (180000.ts). Kurze Zeit warten.
  let prefetched = false;
  for (let i = 0; i < 60 && !prefetched; i++) {
    prefetched = fakeJf.requests.some((r) => /hls1\/s4lt\/180000\.ts$/.test(r.path));
    if (!prefetched) await sleep(100);
  }
  assert.ok(prefetched, 'Agent wurde ohne Client-Bedarf nach 180000.ts gefragt');
  // Das übersprungene Segment (120000) holt der Relay erst bei echter Anfrage — genau einmal.
  assert.equal(fakeJf.requests.filter((r) => /hls1\/s4lt\/120000\.ts$/.test(r.path)).length, 0, 'ahead-Fenster lädt nicht am Player vorbei');
  assert.equal((await req(`/stream/${P.HD}/hls1/s4lt/120000.ts?MediaSourceId=${ms}&PlaySessionId=${'ab'.repeat(16)}`)).body.includes('SEG:120000'), true);
  assert.equal(fakeJf.requests.filter((r) => /hls1\/s4lt\/120000\.ts$/.test(r.path)).length, 1, 'Live-Holung, kein Doppelabruf');
  // Nach kurzer Zeit liegen die Fenster-Segmente im Cache: erneute Anfrage ohne neuen Jellyfin-Roundtrip.
  for (let i = 0; i < 60; i++) {
    const n = fakeJf.requests.filter((r) => /hls1\/s4lt\/300000\.ts$/.test(r.path)).length;
    if (n) break;
    await sleep(100);
  }
  const before = fakeJf.requests.length;
  assert.equal((await req(`/stream/${P.HD}/hls1/s4lt/300000.ts?MediaSourceId=${ms}&PlaySessionId=${'ab'.repeat(16)}`)).status, 200);
  assert.equal(fakeJf.requests.length, before, '300000.ts kam schon als Vorabruf → Cache-Treffer');
});

'use strict';
/** Twitch-Restream & YouTube: Link-Erkennung, Playlist-Umbau, ein Abruf pro Segment, Raum-Sync auf Zeitstempeln. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { parseChannel, parseMaster, parseMedia } = require('../lib/twitch');
const { parseYouTube } = require('../lib/youtube');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = 'Bedingung') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`Zeitüberschreitung: ${label}`);
}

test('Links erkennen', () => {
  assert.strictEqual(parseChannel('https://www.twitch.tv/Papaplatte'), 'papaplatte');
  assert.strictEqual(parseChannel('twitch.tv/some_one?referrer=raid'), 'some_one');
  assert.strictEqual(parseChannel('https://m.twitch.tv/abc123/'), 'abc123');
  assert.strictEqual(parseChannel('https://www.twitch.tv/videos/123456'), null);
  assert.strictEqual(parseChannel('https://youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.deepStrictEqual(parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'), { id: 'dQw4w9WgXcQ', start: 90 });
  assert.deepStrictEqual(parseYouTube('https://youtu.be/dQw4w9WgXcQ?t=42'), { id: 'dQw4w9WgXcQ', start: 42 });
  assert.deepStrictEqual(parseYouTube('youtube.com/shorts/abcdefghijk'), { id: 'abcdefghijk', start: 0 });
  assert.deepStrictEqual(parseYouTube('https://www.youtube.com/live/abcdefghijk?si=x'), { id: 'abcdefghijk', start: 0 });
  assert.strictEqual(parseYouTube('https://www.twitch.tv/xyz'), null);
});

test('Playlists lesen', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000',
    'https://video-weaver.example/v1/playlist/abc.m3u8',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000',
    'https://video-weaver.example/v1/playlist/def.m3u8',
  ].join('\n');
  const v = parseMaster(master, 'https://usher.example/x.m3u8');
  assert.deepStrictEqual(v.map((x) => [x.id, x.name, x.bandwidth]), [['chunked', '1080p60 (source)', 8000000], ['720p60', '720p60', 3000000]]);

  const media = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-01-01T00:00:02.000Z",DURATION=2',
    '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z', '#EXTINF:2.000,live', 'a.ts',
    '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:02.000Z', '#EXTINF:2.000,Amazon|123', 'ad.ts',
    '#EXT-X-TWITCH-PREFETCH:https://x/pre.ts',
    '#EXTINF:2.000,live', 'b.ts',
  ].join('\n');
  const m = parseMedia(media, 'https://cdn.example/p/list.m3u8');
  assert.deepStrictEqual(m.segments.map((s) => [s.useq, s.uri.split('/').pop()]), [[100, 'a.ts'], [101, 'ad.ts'], [102, 'b.ts']]);
  assert.strictEqual(m.segments[2].pdt, Date.parse('2026-01-01T00:00:04.000Z'), 'Zeitstempel fortgeschrieben');
  assert.strictEqual(m.ads.length, 1);
});

/* ---------- Nachgebautes Twitch: GQL, Usher, Playlist mit 1-s-Segmenten ---------- */
function fakeTwitch() {
  const t0 = Date.now() - 30000;
  const counts = {};
  let gqlCalls = 0;
  const segBody = (n) => Buffer.from(`SEGMENT-${n}-`.padEnd(2048, 'x'));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/gql') {
      gqlCalls++;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (j.operationName === 'PlaybackAccessToken') {
          // so fragt der Twitch-Player: gespeicherte Abfrage, Player-Typ „embed“
          assert.strictEqual(j.extensions.persistedQuery.sha256Hash, 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9');
          assert.strictEqual(j.variables.playerType, 'embed');
          assert.strictEqual(req.headers['client-id'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
          if (j.variables.login === 'offline') return res.end(JSON.stringify({ data: { streamPlaybackAccessToken: { value: '{"x":1}', signature: 'sig', authorization: { isForbidden: false } } } }));
          return res.end(JSON.stringify({ data: { streamPlaybackAccessToken: { value: '{"x":1}', signature: 'sig', authorization: { isForbidden: false } } } }));
        }
        res.end(JSON.stringify({ data: { user: { displayName: 'TestKanal', profileImageURL: null, broadcastSettings: { title: 'Wir testen' }, stream: { type: 'live', game: { displayName: 'Just Chatting' } } } } }));
      });
      return;
    }
    if (u.pathname.startsWith('/api/v2/channel/hls/')) {
      if (u.pathname.includes('offline')) { res.writeHead(404); return res.end('[]'); }
      assert.strictEqual(u.searchParams.get('sig'), 'sig');
      assert.strictEqual(u.searchParams.get('platform'), 'web');
      assert.strictEqual(u.searchParams.get('supported_codecs'), 'h264');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end([
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)"',
        '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked"',
        '/media/chunked.m3u8',
        '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="480p30",NAME="480p"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=852x480,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="480p30"',
        '/media/480p30.m3u8',
      ].join('\n'));
    }
    let m;
    if ((m = /^\/media\/(\w+)\.m3u8$/.exec(u.pathname))) {
      // Sliding Window: die letzten 6 Segmente à 1 s, Zeitstempel = t0 + n s
      const n = Math.floor((Date.now() - t0) / 1000);
      const first = n - 5;
      const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${first}`];
      for (let i = first; i <= n; i++) {
        out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(t0 + i * 1000).toISOString()}`, '#EXTINF:1.000,live', `/seg/${m[1]}/${i}.ts`);
      }
      out.push(`#EXT-X-TWITCH-PREFETCH:/seg/${m[1]}/${n + 1}.ts`);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(out.join('\n'));
    }
    if ((m = /^\/seg\/(\w+)\/(\d+)\.ts$/.exec(u.pathname))) {
      const k = `${m[1]}/${m[2]}`;
      counts[k] = (counts[k] || 0) + 1;
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      return res.end(segBody(`${m[1]}-${m[2]}`));
    }
    if (u.pathname === '/oembed') {
      const v = new URL(u.searchParams.get('url')).searchParams.get('v');
      if (v === 'nonembeddab') { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ title: 'Ein Testvideo', author_name: 'Testkanal' }));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, t0, counts, gql: () => gqlCalls })));
}

function client(base) {
  const c = { cookie: '', msgs: [] };
  c.req = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...(c.cookie ? { Cookie: c.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  c.join = (code) => new Promise((resolve) => {
    c.ws = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${code}`, { headers: { Cookie: c.cookie } });
    c.ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
    c.ws.on('open', resolve);
  });
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.wait = (fn, label, ms) => until(() => c.msgs.find(fn), ms || 8000, label);
  return c;
}

test('Twitch-Restream & YouTube im Raum', { timeout: 90000 }, async (t) => {
  const tw = await fakeTwitch();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tw-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const relay = spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: 't'.repeat(40), ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123',
      DATA_DIR: path.join(tmp, 'd'), CACHE_DIR: path.join(tmp, 'c'),
      TWITCH_GQL_URL: `http://127.0.0.1:${tw.port}/gql`, TWITCH_USHER_URL: `http://127.0.0.1:${tw.port}`, YOUTUBE_OEMBED_URL: `http://127.0.0.1:${tw.port}`,
      TWITCH_DELAY_SECONDS: '3', TWITCH_DVR_MINUTES: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const all = [];
  t.after(async () => {
    for (const c of all) try { c.ws && c.ws.close(); } catch { /* egal */ }
    await new Promise((r) => { if (relay.exitCode !== null) return r(); relay.once('exit', r); relay.kill(); });
    tw.server.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/healthz`); break; } catch { await sleep(100); } }

  const chef = client(base); all.push(chef);
  await chef.req('POST', '/api/login', { username: 'chef', password: 'geheim123' });
  await chef.req('POST', '/api/admin/users', { username: 'lea', password: 'passwort123' });
  await chef.req('POST', '/api/admin/users', { username: 'max', password: 'passwort123' });
  const lea = client(base); all.push(lea);
  const max = client(base); all.push(max);
  await lea.req('POST', '/api/login', { username: 'lea', password: 'passwort123' });
  await max.req('POST', '/api/login', { username: 'max', password: 'passwort123' });
  const { code } = (await chef.req('POST', '/api/rooms', {})).data;
  await chef.join(code); await lea.join(code); await max.join(code);

  // Ohne Anmeldung kein Stream
  assert.strictEqual((await fetch(`${base}/live/twitch/testkanal/chunked.m3u8`)).status, 401);

  /* ---------- Kanal starten ---------- */
  chef.send({ t: 'load-url', url: 'https://www.twitch.tv/TestKanal' });
  const pbMsg = await lea.wait((m) => m.t === 'playback' && m.playback.item && m.playback.item.source === 'twitch', 'Twitch geladen', 15000);
  const pb = pbMsg.playback;
  assert.strictEqual(pb.item.id, 'twitch:testkanal');
  assert.strictEqual(pb.item.title, 'TestKanal');
  assert.match(pb.item.subtitle, /Wir testen/);
  assert.strictEqual(pb.item.live, true);
  assert.strictEqual(pb.playing, true, 'Live läuft sofort');
  const edgeNow = (Date.now() - tw.t0) / 1000;
  // Position = Zeitstempel ein paar Sekunden hinter der Kante
  const behind = (tw.t0 / 1000 + edgeNow) - pb.position;
  assert.ok(behind > 2 && behind < 7, `Abstand zur Kante plausibel (${behind.toFixed(1)} s)`);

  const info = (await lea.req('GET', '/api/twitch/testkanal')).data;
  assert.deepStrictEqual(info.variants.map((v) => [v.id, v.name]), [['chunked', '1080p60 (Quelle)'], ['480p30', '480p']]);
  assert.strictEqual(info.defaultId, 'chunked');

  /* ---------- Gemeinsame Playlist & Segmente ---------- */
  await sleep(2500);
  const [p1, p2, p3] = await Promise.all([chef, lea, max].map((c) => c.req('GET', '/live/twitch/testkanal/chunked.m3u8')));
  assert.strictEqual(p1.status, 200);
  const pl = p1.data.toString();
  assert.match(pl, /#EXT-X-PROGRAM-DATE-TIME:/);
  assert.doesNotMatch(pl, /PREFETCH|127\.0\.0\.1/, 'keine Twitch-Adressen oder Prefetch-Tags');
  const segs = pl.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.ok(segs.length >= 5, `genug Segmente im Fenster (${segs.length})`);
  // Gleicher Zeitpunkt → bei allen dieselbe Playlist (ggf. eins weiter)
  for (const other of [p2, p3]) {
    const os2 = other.data.toString().split('\n').filter((l) => l && !l.startsWith('#'));
    assert.ok(os2.includes(segs[segs.length - 2]), 'alle sehen dieselben Segmente');
  }
  // Zeitstempel stimmen mit dem Original überein
  const pdts = pl.split('\n').filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).map((l) => Date.parse(l.slice(25)));
  assert.ok(pdts.every((x) => (x - tw.t0) % 1000 === 0), 'Zeitstempel aus dem Original übernommen');

  // Alle drei holen dieselben Segmente gleichzeitig → Twitch liefert jedes nur EINMAL
  const pick = segs.slice(-3);
  const bodies = await Promise.all(pick.flatMap((s) => [chef, lea, max].map((c) => c.req('GET', s))));
  assert.ok(bodies.every((b) => b.status === 200));
  assert.ok(bodies[0].data.toString().startsWith('SEGMENT-chunked-'));
  assert.ok(bodies[0].data.equals(bodies[1].data) && bodies[1].data.equals(bodies[2].data), 'bytegleich für alle');
  assert.ok(Object.values(tw.counts).every((n) => n === 1), `jedes Segment nur einmal von Twitch geholt: ${JSON.stringify(tw.counts)}`);
  assert.ok(!Object.keys(tw.counts).some((k) => k.startsWith('480p30')), 'andere Qualität erst bei Bedarf');

  // Andere Qualität: eigener Abruf, gleiche Zeitachse
  const low = (await max.req('GET', '/live/twitch/testkanal/480p30.m3u8')).data.toString();
  const lowPdts = low.split('\n').filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).map((l) => Date.parse(l.slice(25)));
  assert.ok(lowPdts.length && lowPdts.every((x) => (x - tw.t0) % 1000 === 0), 'gleiche Zeitstempel in jeder Qualität');
  assert.strictEqual((await max.req('GET', '/live/twitch/testkanal/nope.m3u8')).status, 404);

  /* ---------- Steuern auf der Zeitachse ---------- */
  chef.msgs.length = 0; lea.msgs.length = 0;
  const pausePos = pb.position + 0.25; // sicher im Fenster: weiter vorn würde ggf. auf live begrenzt
  lea.send({ t: 'control', action: 'pause', position: pausePos });
  let m = await chef.wait((x) => x.t === 'playback' && x.playback.playing === false, 'Pause');
  assert.ok(Math.abs(m.playback.position - pausePos) < 0.01, `Pause an genau dem Zeitstempel (${m.playback.position - pausePos}, Kante ${(Date.now() - tw.t0) / 1000 + tw.t0 / 1000 - pausePos})`);
  // Sprung weit in die Zukunft wird auf live begrenzt, weit zurück auf den Fensteranfang
  lea.send({ t: 'control', action: 'seek', position: pausePos + 3600 });
  m = await chef.wait((x) => x.t === 'playback' && x.action === 'seek', 'Seek vor');
  const liveNow = tw.t0 / 1000 + (Date.now() - tw.t0) / 1000;
  assert.ok(m.playback.position <= liveNow - 2, 'nicht über die Live-Kante hinaus');
  chef.msgs.length = 0;
  lea.send({ t: 'control', action: 'seek', position: 1000 });
  m = await chef.wait((x) => x.t === 'playback' && x.action === 'seek', 'Seek zurück');
  assert.ok(m.playback.position > tw.t0 / 1000, 'nicht vor das DVR-Fenster');
  chef.msgs.length = 0;
  lea.send({ t: 'control', action: 'live' });
  m = await chef.wait((x) => x.t === 'playback' && x.action === 'live', 'Live');
  assert.strictEqual(m.playback.playing, true);
  const b2 = (tw.t0 / 1000 + (Date.now() - tw.t0) / 1000) - m.playback.position;
  assert.ok(b2 > 2 && b2 < 7, `zurück an der Kante (${b2.toFixed(1)} s)`);
  assert.ok(chef.msgs.some((x) => x.t === 'chat' && /zurück zu live/.test(x.msg.text)));

  // Freundesliste zeigt den Stream
  const act = (await max.req('GET', '/api/activity')).data;
  assert.ok(act.friends.some((f) => f.item && f.item.id === 'twitch:testkanal'));

  /* ---------- Fehlerfälle ---------- */
  await sleep(3100); // Steuer-Bremse (6 Aktionen / 3 s) zurücksetzen
  lea.msgs.length = 0;
  lea.send({ t: 'load-url', url: 'https://example.com/foo' });
  await lea.wait((x) => x.t === 'error' && /kein YouTube- oder Twitch-Link/.test(x.text), 'kein Link');
  lea.send({ t: 'load-url', url: 'twitch.tv/offline' });
  await lea.wait((x) => x.t === 'error' && /nicht live/.test(x.text), 'offline');
  // Twitch-VODs gehen an den eingebetteten Player (ext.js), nicht an den Restream
  lea.send({ t: 'load-ext', url: 'https://www.twitch.tv/videos/12345' });
  m = await chef.wait((x) => x.t === 'playback' && x.playback.item && x.playback.item.ext && x.playback.item.ext.video === '12345', 'VOD eingebettet');
  assert.ok(!m.playback.item.source, 'kein Restream');

  /* ---------- YouTube ---------- */
  await sleep(3100);
  chef.msgs.length = 0;
  lea.send({ t: 'load-url', url: 'https://youtu.be/dQw4w9WgXcQ?t=42' });
  m = await chef.wait((x) => x.t === 'playback' && x.playback.item && x.playback.item.source === 'youtube', 'YouTube geladen');
  assert.strictEqual(m.playback.item.videoId, 'dQw4w9WgXcQ');
  assert.strictEqual(m.playback.item.title, 'Ein Testvideo');
  assert.strictEqual(m.playback.item.subtitle, 'YouTube · Testkanal');
  assert.strictEqual(m.playback.position, 42);
  assert.strictEqual(m.playback.playing, false, 'mit mehreren im Raum erst pausiert');
  // Länge kommt vom Player des ersten Clients
  chef.send({ t: 'status', pos: 42, state: 'paused', drift: 0, dur: 212.5 });
  chef.msgs.length = 0;
  chef.send({ t: 'control', action: 'seek', position: 9999 });
  m = await chef.wait((x) => x.t === 'playback' && x.action === 'seek', 'YT-Seek');
  assert.strictEqual(m.playback.position, 212.5, 'auf die Länge begrenzt');
  lea.msgs.length = 0;
  lea.send({ t: 'load-url', url: 'https://www.youtube.com/watch?v=nonembeddab' });
  await lea.wait((x) => x.t === 'error' && /eingebettet/.test(x.text), 'Einbetten verboten');

  // CSP erlaubt den YouTube-Player
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(csp, /frame-src[^;]*youtube-nocookie\.com/);
  assert.match(csp, /script-src[^;]*www\.youtube\.com/);
  // YouTube braucht den Referer (sonst Fehler 153), aber nur die Domain
  assert.strictEqual((await fetch(`${base}/`)).headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

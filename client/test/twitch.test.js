'use strict';
/**
 * Twitch & YouTube im Desktop-Client: echtes Relay + nachgebautes Twitch mit echten
 * TS-Segmenten (ffmpeg) + Client-Kern mit Fake-mpv. Der Fake verhält sich wie mpv mit
 * rebase-start-time=no: Zeit = roher PTS, nahe am 33-Bit-Überlauf negativ. Die
 * Segmente liegen absichtlich kurz vor dem Überlauf, der Test läuft darüber hinweg.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RelayClient } = require('../src/main/relay');
const { Settings } = require('../src/main/settings');
const { Installer } = require('../src/main/installer');
const { Framegen } = require('../src/main/framegen');
const { Session } = require('../src/main/session');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = 'Bedingung') {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(50); }
  throw new Error(`Zeitüberschreitung: ${label}`);
}
function hasFfmpeg() { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }

function fakeTwitch(dir) {
  const durs = fs.readFileSync(path.join(dir, 'list.m3u8'), 'utf8').split('\n').filter((l) => l.startsWith('#EXTINF:')).map((l) => parseFloat(l.slice(8)));
  const starts = [];
  let acc = 0;
  for (const d of durs) { starts.push(acc); acc += d; }
  const t0 = Date.now() - 12000;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/gql') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const j = JSON.parse(b);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(j.operationName ? { data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } } : { data: { user: { displayName: 'TestKanal', broadcastSettings: { title: 'Live' } } } }));
      });
      return;
    }
    if (u.pathname.startsWith('/api/v2/channel/hls/')) {
      res.writeHead(200);
      return res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="180p30 (source)"\n#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.42C00D,mp4a.40.2",VIDEO="chunked"\n/media.m3u8\n');
    }
    if (u.pathname === '/media.m3u8') {
      const el = (Date.now() - t0) / 1000;
      let n = starts.findIndex((s, i) => s + durs[i] > el);
      if (n < 0) n = durs.length;
      const first = Math.max(0, n - 6);
      const o = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${first}`];
      for (let i = first; i < n; i++) o.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(t0 + starts[i] * 1000).toISOString()}`, `#EXTINF:${durs[i].toFixed(3)},live`, `/s/${i}.ts`);
      res.writeHead(200);
      return res.end(o.join('\n'));
    }
    const m = /^\/s\/(\d+)\.ts$/.exec(u.pathname);
    if (m) { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(fs.readFileSync(path.join(dir, `s${m[1]}.ts`))); }
    if (u.pathname === '/oembed') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"title":"Ein Testvideo","author_name":"Kanal"}'); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

test('Desktop-Client: Twitch auf der Zeitstempel-Achse, YouTube über yt-dlp', { skip: !hasFfmpeg() && 'ffmpeg fehlt', timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tw-client-'));
  const segDir = path.join(tmp, 'segs');
  fs.mkdirSync(segDir);
  // 1-s-Segmente, Zeitstempel starten kurz vor dem 33-Bit-Überlauf (≈ 95443,7 s)
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-output_ts_offset', '95425',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_filename', path.join(segDir, 's%d.ts'), path.join(segDir, 'list.m3u8')]);
  const tw = await fakeTwitch(segDir);

  const port = 20000 + Math.floor(Math.random() * 20000);
  const relayProc = spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: 'x'.repeat(40), ADMIN_USER: 'alice', ADMIN_PASSWORD: 'geheim123',
      DATA_DIR: path.join(tmp, 'data'), CACHE_DIR: path.join(tmp, 'cache'),
      TWITCH_GQL_URL: `http://127.0.0.1:${tw.port}/gql`, TWITCH_USHER_URL: `http://127.0.0.1:${tw.port}`, YOUTUBE_OEMBED_URL: `http://127.0.0.1:${tw.port}`,
    },
    stdio: 'ignore',
  });
  const sessions = [];
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.leave();
    for (const s of sessions) await s.destroy().catch(() => {});
    await new Promise((r) => { if (relayProc.exitCode !== null) return r(); relayProc.once('exit', r); relayProc.kill(); });
    tw.server.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } }, 10000, 'Relay');

  const userData = path.join(tmp, 'client');
  const settings = new Settings(userData, null);
  const relay = new RelayClient();
  relay.setServer(base);
  await until(() => relay.login('alice', 'geheim123').then(() => true, () => false), 10000, 'Admin angelegt');
  const installer = new Installer(path.join(userData, 'components'), path.join(__dirname, '..', 'vpy'));
  installer.status = () => ({ supported: true, base: true, framegen: false, models: [], busy: false });
  const framegen = new Framegen(installer, path.join(__dirname, '..', 'vpy'), path.join(userData, 'engines.json'));
  const mpvLog = path.join(tmp, 'mpv.jsonl');
  process.env.FAKE_MPV_LOG = mpvLog;
  process.env.FAKE_MPV_RATE = '0.97'; // läuft 3 % zu langsam → Client muss nachregeln
  const session = new Session({ relay, settings, installer, framegen, configDir: path.join(userData, 'mpv-config'), logDir: path.join(userData, 'logs') });
  session.mpvBinary = () => path.join(__dirname, 'fixtures', 'fake-mpv.js');
  sessions.push(session);
  const uiEvents = [];
  session.on('ui', (ch, p) => uiEvents.push({ ch, p }));
  const mpvEvents = () => (fs.existsSync(mpvLog) ? fs.readFileSync(mpvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  const { code } = await relay.createRoom();
  session.join(code);
  await until(() => session.you, 5000, 'welcome');
  const other = new RelayClient();
  clients.push(other);
  other.setServer(base);
  await other.login('alice', 'geheim123');
  const seen = [];
  other.on('message', (m) => seen.push(m));
  other.join(code);
  await until(() => seen.find((m) => m.t === 'welcome'), 5000, 'welcome (Browser)');
  const roomPos = () => {
    const p = [...seen].reverse().find((m) => m.t === 'playback' || m.t === 'welcome').playback;
    return p.playing ? p.position + (other.serverNow() - p.updatedAt) / 1000 : p.position;
  };

  /* ---------- Twitch ---------- */
  other.send({ t: 'load-url', url: 'https://www.twitch.tv/testkanal' });
  const lf = await until(() => mpvEvents().find((e) => e.ev === 'loadfile'), 20000, 'loadfile Twitch');
  assert.match(lf.url, /\/live\/twitch\/testkanal\/chunked\.m3u8\?from=\d+$/);
  assert.strictEqual(lf.rebase, 'no', 'rohe Zeitstempel');
  assert.strictEqual(lf.lavf, 'live_start_index=0', 'Start am Anfang der Playlist');
  assert.match(lf.cookie, /^wp_sid=/);
  assert.ok(lf.pts < 0, `Zeit liegt vor dem Überlauf und ist wie bei libavformat negativ (${lf.pts})`);
  assert.ok(uiEvents.some((e) => e.ch === 'room:item' && e.p.source === 'twitch' && e.p.qualities.some((q) => q.id === 'chunked')));

  // Client folgt dem Raum auf der Zeitstempel-Achse (trotz 3 % zu langsamem Player)
  await until(() => { const l = session.localPos(); return Number.isFinite(l) && Math.abs(l - roomPos()) < 0.12; }, 15000, 'Twitch synchron');
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    const d = Math.abs(session.localPos() - roomPos());
    assert.ok(d < 0.3, `bleibt synchron (${d.toFixed(3)} s)`);
  }
  // Die mpv-Zeit läuft hier von negativ über 0 – im Relay springt der PTS dabei von ~95443 auf ~0 (Überlauf)
  const st = [...uiEvents].reverse().find((e) => e.ch === 'player:state' && e.p.live);
  assert.ok(st && st.p.live.behind >= 0 && st.p.duration > 3, 'Oberfläche bekommt DVR-Fenster und Abstand zur Kante');

  // Browser pausiert → Client steht an genau dem Zeitstempel
  const pausePos = roomPos();
  other.send({ t: 'control', action: 'pause', position: pausePos });
  await until(() => session.mpv.props.pause === true, 4000, 'Pause übernommen');
  await until(() => Math.abs(session.localPos() - pausePos) < 0.2, 4000, 'an der Pausenstelle');

  // Client pausiert/spielt selbst → Zeitstempel kommt beim Raum an
  await sleep(300);
  seen.length = 0;
  await session.mpv.command('fake-key', 'toggle');
  const playMsg = await until(() => seen.find((m) => m.t === 'playback' && m.action === 'play'), 4000, 'Play vom Client');
  assert.ok(Math.abs(playMsg.playback.position - pausePos) < 0.3, 'Play an der Pausenstelle (Zeitstempel, nicht mpv-Zeit)');

  // „Live“ vom Client
  seen.length = 0;
  await sleep(3100); // Steuer-Bremse
  session.control('live');
  const liveMsg = await until(() => seen.find((m) => m.t === 'playback' && m.action === 'live'), 4000, 'Live');
  assert.ok(liveMsg.playback.position > pausePos + 2, 'nach vorn an die Kante');
  await until(() => Math.abs(session.localPos() - roomPos()) < 0.15, 10000, 'nach Live wieder synchron');

  /* ---------- YouTube ---------- */
  await sleep(3100);
  const before = mpvEvents().length;
  other.send({ t: 'load-url', url: 'https://youtu.be/dQw4w9WgXcQ?t=30' });
  const ylf = await until(() => mpvEvents().slice(before).find((e) => e.ev === 'loadfile'), 10000, 'loadfile YouTube');
  assert.strictEqual(ylf.url, 'ytdl://dQw4w9WgXcQ');
  assert.strictEqual(ylf.rebase, 'yes', 'normale Zeitachse');
  assert.match(ylf.ytdlFormat, /^bv\*\+ba\/b/, 'beste Qualität');
  assert.strictEqual(ylf.start, '+30.000');
  other.send({ t: 'control', action: 'play', position: 30 });
  await until(() => Math.abs(session.localPos() - roomPos()) < 0.12 && session.mpv.props.pause === false, 8000, 'YouTube synchron');
  // Qualität wird getrennt von Jellyfin gemerkt
  await session.setPrefs({ quality: '720' });
  assert.strictEqual(settings.prefs.ytQuality, '720');
  assert.strictEqual(settings.prefs.quality, 'direct', 'Jellyfin-Qualität bleibt');
  const y720 = await until(() => mpvEvents().slice(before).filter((e) => e.ev === 'loadfile')[1], 5000, 'neu geladen mit 720p');
  assert.match(y720.ytdlFormat, /height<=720/);
});

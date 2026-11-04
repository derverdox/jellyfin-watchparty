'use strict';
/**
 * Ende-zu-Ende: echtes Relay + echter Agent + Fake-Jellyfin + Client-Kern mit Fake-mpv.
 * Ein zweiter Teilnehmer („Browser“) steuert über den WebSocket, der Client muss folgen,
 * und Aktionen im Player müssen bei ihm ankommen.
 *
 * Voraussetzungen: ffmpeg im PATH, Abhängigkeiten von relay/ und agent/ installiert
 * (oder NODE_PATH zeigt auf einen Ordner mit „ws“).
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fakeJf = require('./fixtures/fake-jellyfin');
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

test('Client folgt dem Raum und meldet eigene Aktionen', { skip: !hasFfmpeg() && 'ffmpeg fehlt', timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-e2e-'));
  const video = path.join(tmp, 'test.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24000/1001', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', video]);

  const jf = await fakeJf.start(video);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = 'x'.repeat(40);
  const procs = [];
  const run = (script, env) => {
    const p = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.out = () => out;
    procs.push(p);
    return p;
  };
  const relayProc = run(path.join(ROOT, 'relay', 'server.js'), {
    PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: token, ADMIN_USER: 'alice', ADMIN_PASSWORD: 'geheim123',
    DATA_DIR: path.join(tmp, 'data'), CACHE_DIR: path.join(tmp, 'cache'),
  });
  run(path.join(ROOT, 'agent', 'agent.js'), {
    RELAY_URL: `ws://127.0.0.1:${port}/agent`, AGENT_TOKEN: token, JELLYFIN_URL: `http://127.0.0.1:${jf.port}`, JELLYFIN_API_KEY: 'test',
  });

  const sessions = [];
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.leave();
    for (const s of sessions) await s.destroy().catch(() => {});
    for (const p of procs) p.kill();
    jf.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { const r = await fetch(`${base}/healthz`); return (await r.json()).agent; } catch { return false; } }, 15000, 'Relay + Agent online').catch((e) => {
    throw new Error(`${e.message}\n--- relay ---\n${relayProc.out()}`);
  });

  /* ---------- Client (wie im Hauptprozess verdrahtet) ---------- */
  const userData = path.join(tmp, 'client');
  const settings = new Settings(userData, null);
  const relay = new RelayClient();
  relay.setServer(base);
  await relay.login('alice', 'geheim123');
  assert.ok(relay.sid, 'Sitzungs-Cookie gesetzt');

  const installer = new Installer(path.join(userData, 'components'), path.join(__dirname, '..', 'vpy'));
  installer.status = () => ({ supported: true, base: true, framegen: true, models: ['v4_26'], busy: false });
  const framegen = new Framegen(installer, path.join(__dirname, '..', 'vpy'), path.join(userData, 'engines.json'));
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'engines.json'), JSON.stringify({ 'v4_26|640x384': { built: 'test' } }));

  const mpvLog = path.join(tmp, 'mpv.jsonl');
  process.env.FAKE_MPV_LOG = mpvLog;
  process.env.FAKE_MPV_RATE = '0.95'; // Player läuft 5 % zu langsam → Client muss ständig nachregeln
  const session = new Session({ relay, settings, installer, framegen, configDir: path.join(userData, 'mpv-config'), logDir: path.join(userData, 'logs') });
  session.mpvBinary = () => path.join(__dirname, 'fixtures', 'fake-mpv.js');
  sessions.push(session);
  const uiEvents = [];
  session.on('ui', (ch, p) => uiEvents.push({ ch, p }));
  const mpvEvents = () => (fs.existsSync(mpvLog) ? fs.readFileSync(mpvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  const { code } = await relay.createRoom();
  session.join(code);
  await until(() => session.you, 5000, 'welcome');

  /* ---------- „Browser“-Teilnehmer ---------- */
  const other = new RelayClient();
  clients.push(other);
  other.setServer(base);
  await other.login('alice', 'geheim123');
  const seen = [];
  other.on('message', (m) => seen.push(m));
  other.join(code);
  await until(() => seen.find((m) => m.t === 'welcome'), 5000, 'welcome (Browser)');
  const otherPos = () => {
    const pb = [...seen].reverse().find((m) => m.t === 'playback' || m.t === 'welcome');
    const p = pb.playback;
    return p.playing ? p.position + (other.serverNow() - p.updatedAt) / 1000 : p.position;
  };

  /* 1) Browser wählt den Film → Client lädt ihn in mpv (mit Cookie, Range 206) */
  other.send({ t: 'load', itemId: jf.ids.MOVIE });
  const lf = await until(() => mpvEvents().find((e) => e.ev === 'loadfile'), 10000, 'loadfile');
  assert.match(lf.url, new RegExp(`/stream/${jf.ids.MOVIE}/direct\\?ms=${jf.ids.MS}$`));
  assert.strictEqual(lf.status, 206, 'Direktstream liefert Range-Antwort');
  assert.strictEqual(lf.bytes, 65536);
  assert.match(lf.cookie, /^wp_sid=[a-f0-9]+$/);
  assert.strictEqual(lf.pause, true, 'pausiert geladen, weil der Raum pausiert ist');
  const sub = await until(() => mpvEvents().find((e) => e.ev === 'sub-add'), 5000, 'externer Untertitel');
  assert.strictEqual(sub.status, 200);
  assert.ok(sub.ok, 'Untertitel ist WebVTT');

  /* 2) Browser drückt Play → Client spielt und bleibt trotz zu langsamem Player synchron */
  await sleep(500);
  other.send({ t: 'control', action: 'play', position: 5 });
  await until(() => session.mpv && session.mpv.props.pause === false, 5000, 'mpv spielt');
  await sleep(9000);
  const drift1 = Math.abs(otherPos() - session.mpv.props['time-pos']);
  assert.ok(drift1 < 0.3, `nach 9 s synchron (Abweichung ${drift1.toFixed(3)} s)`);
  assert.ok(mpvEvents().some((e) => e.ev === 'set' && e.name === 'speed' && e.value > 1), 'Tempo wurde zum Aufholen erhöht');

  /* 3) Browser springt → Client springt mit */
  other.send({ t: 'control', action: 'seek', position: 40 });
  await until(() => Math.abs(session.mpv.props['time-pos'] - otherPos()) < 0.5 && session.mpv.props['time-pos'] > 39, 5000, 'Sprung übernommen');

  /* 4) Taste im Player (Leertaste) → Pause kommt beim Browser an */
  const nSeen = seen.length;
  await session.mpv.command('fake-key', 'toggle');
  const pauseMsg = await until(() => seen.slice(nSeen).find((m) => m.t === 'playback' && m.playback.playing === false), 5000, 'Pause beim Browser');
  assert.strictEqual(pauseMsg.action, 'pause');
  await until(() => session.mpv.props.pause === true, 3000, 'mpv pausiert');

  /* 5) Klick auf Play in der mpv-Leiste (nicht über unsere Tasten) → wird erkannt */
  const n2 = seen.length;
  await session.mpv.command('fake-osc-pause', false);
  await until(() => seen.slice(n2).find((m) => m.t === 'playback' && m.playback.playing === true), 5000, 'Play aus mpv-Leiste');

  /* 6) Ziehen in der mpv-Leiste → Sprung kommt beim Browser an */
  const n3 = seen.length;
  await session.mpv.command('fake-osc-seek', 70);
  const seekMsg = await until(() => seen.slice(n3).find((m) => m.t === 'playback' && m.action === 'seek'), 5000, 'Sprung aus mpv-Leiste');
  assert.ok(Math.abs(seekMsg.playback.position - 70) < 0.5, `Position ${seekMsg.playback.position}`);

  /* 7) Status-Meldungen: der Browser sieht den Client als „spielt“ mit kleiner Abweichung */
  await sleep(2500);
  const members = [...seen].reverse().find((m) => m.t === 'members');
  const me = members.members.find((m) => m.id === session.you.clientId);
  assert.strictEqual(me.status.state, 'playing');
  assert.ok(Math.abs(me.status.drift) < 0.5, `Drift laut Server ${me.status.drift}`);

  /* 8) Framegen einschalten → mpv bekommt die VapourSynth-Kette mit passenden Parametern */
  await session.setPrefs({ framegen: { enabled: true, model: 'v4_26', target: 'display' } });
  const vf = await until(() => mpvEvents().reverse().find((e) => e.ev === 'vf' && e.op === 'set' && String(e.value).includes('@wprife')), 3000, 'vf set');
  assert.match(vf.value, /^@wprife:vapoursynth=file=%\d+%.*rife\.vpy:buffered-frames=4:concurrent-frames=4:user-data=%\d+%/);
  const ud = /user-data=%\d+%(.+)$/.exec(vf.value)[1];
  const cfg = JSON.parse(Buffer.from(ud, 'base64').toString());
  assert.deepStrictEqual([cfg.num, cfg.den], [6, 1], '23,976 fps auf 144 Hz → 6×');
  assert.deepStrictEqual([cfg.src_num, cfg.src_den], [24000, 1001]);
  assert.strictEqual(cfg.matrix, '709');
  assert.ok(mpvEvents().some((e) => e.ev === 'set' && e.name === 'hwdec' && e.value === 'auto-copy'), 'hwdec auf Kopie für VapourSynth');
  const filt = [...uiEvents].reverse().find((e) => e.ch === 'player:filters');
  assert.strictEqual(filt.p.framegen.state, 'on');

  /* 9) Browser pausiert → Client steht still an derselben Stelle */
  other.send({ t: 'control', action: 'pause', position: 75 });
  await until(() => session.mpv.props.pause === true && Math.abs(session.mpv.props['time-pos'] - 75) < 0.2, 5000, 'Pause bei 75 s');

  /* 10) Chat erscheint im Bild */
  other.send({ t: 'chat', text: 'Popcorn!' });
  await until(() => mpvEvents().find((e) => e.ev === 'osd' && /Popcorn!/.test(e.text)), 3000, 'Chat im Bild');

  /* 11) Ansage aus der Verwaltung erscheint im Bild, Qualität kommt vom Server */
  await other.request('POST', `/api/admin/rooms/${code}/announce`, { text: 'Gleich Pause' });
  await until(() => mpvEvents().find((e) => e.ev === 'osd' && /📣.*Gleich Pause/.test(e.text)), 3000, 'Ansage im Bild');
  assert.strictEqual(session.activeQuality, 'direct');
  assert.ok(session.info.qualities.length >= 1 && session.info.qualities[0].original);

  other.leave();
});

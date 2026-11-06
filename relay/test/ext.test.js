'use strict';
/** YouTube/Twitch zusammen schauen: Link-Erkennung und Ablauf im Raum (ohne Heimserver). */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { parseExtUrl, parseTime, extKey } = require('../lib/ext');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Links erkennen', () => {
  assert.deepStrictEqual(parseExtUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'), { kind: 'youtube', id: 'dQw4w9WgXcQ', start: 90 });
  assert.deepStrictEqual(parseExtUrl('youtu.be/dQw4w9WgXcQ?t=42'), { kind: 'youtube', id: 'dQw4w9WgXcQ', start: 42 });
  assert.strictEqual(parseExtUrl('https://m.youtube.com/shorts/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');
  assert.strictEqual(parseExtUrl('https://www.youtube.com/live/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');
  assert.deepStrictEqual(parseExtUrl('https://www.twitch.tv/RiotGames'), { kind: 'twitch', live: true, channel: 'riotgames' });
  assert.deepStrictEqual(parseExtUrl('twitch.tv/videos/2290001234?t=1h2m3s'), { kind: 'twitch', video: '2290001234', start: 3723 });
  assert.deepStrictEqual(parseExtUrl('https://clips.twitch.tv/FunnyClipSlug-abc123'), { kind: 'twitch', clip: 'FunnyClipSlug-abc123' });
  assert.deepStrictEqual(parseExtUrl('https://www.twitch.tv/somebody/clip/OtherSlug_x'), { kind: 'twitch', clip: 'OtherSlug_x' });
  for (const bad of ['https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=kurz', 'https://www.twitch.tv/directory', 'https://www.twitch.tv/settings', 'javascript:alert(1)', '', 'x'.repeat(600)]) {
    assert.strictEqual(parseExtUrl(bad), null, bad.slice(0, 40));
  }
  assert.strictEqual(parseTime('1:02:03'), 3723);
  assert.strictEqual(extKey({ kind: 'twitch', live: true, channel: 'x' }), 'tw:live:x');
});

test('Twitch im Raum: alle bekommen den Stream, Verzögerung wird geteilt', { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ext-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: 'e'.repeat(40), ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(tmp, 'd'), CACHE_DIR: path.join(tmp, 'c') },
    stdio: 'ignore',
  });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) try { s.close(); } catch { /* egal */ }
    await new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill(); });
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/healthz`); break; } catch { await sleep(100); } }
  await sleep(500);
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let login;
  for (let i = 0; i < 10; i++) { login = await post('/api/login', { username: 'chef', password: 'geheim123' }); if (login.status === 200) break; await sleep(500); }
  const chef = { Cookie: /wp_sid=[a-f0-9]+/.exec(login.headers.get('set-cookie'))[0] };
  await post('/api/admin/users', { username: 'lea', password: 'Sonne-Mond-7' }, chef);
  const leaLogin = await post('/api/login', { username: 'lea', password: 'Sonne-Mond-7' });
  const lea = { Cookie: /wp_sid=[a-f0-9]+/.exec(leaLogin.headers.get('set-cookie'))[0] };

  // Header erlauben die Player von YouTube/Twitch
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(csp, /frame-src[^;]*https:\/\/www\.youtube\.com/);
  assert.match(csp, /frame-src[^;]*https:\/\/player\.twitch\.tv/);
  assert.match(csp, /script-src[^;]*https:\/\/player\.twitch\.tv/);

  const { code } = await (await post('/api/rooms', { solo: true }, chef)).json();
  const join = (cookie) => new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${code}`, { headers: cookie });
    const c = { ws, msgs: [] };
    ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve(c));
    sockets.push(ws);
  });
  const wait = async (c, fn, label) => { for (let i = 0; i < 80; i++) { const m = c.msgs.find(fn); if (m) return m; await sleep(100); } throw new Error(`Zeitüberschreitung: ${label}`); };
  const a = await join(chef);
  const b = await join(lea);
  await wait(b, (m) => m.t === 'welcome', 'welcome');

  a.ws.send(JSON.stringify({ t: 'load-ext', url: 'https://example.com/nix' }));
  await wait(a, (m) => m.t === 'error' && /kein YouTube/.test(m.text), 'Fehler für falschen Link');

  a.ws.send(JSON.stringify({ t: 'load-ext', url: 'https://www.twitch.tv/riotgames' }));
  const pb = await wait(b, (m) => m.t === 'playback' && m.playback.item && m.playback.item.ext, 'Twitch-Stream bei allen');
  assert.deepStrictEqual(pb.playback.item.ext, { kind: 'twitch', live: true, channel: 'riotgames' });
  assert.strictEqual(pb.playback.item.id, 'tw:live:riotgames');
  assert.strictEqual(pb.playback.playing, true, 'läuft sofort');
  assert.strictEqual(pb.playback.item.runtime, null);

  // Verzögerung hinter live wird an alle verteilt
  b.ws.send(JSON.stringify({ t: 'status', pos: 0, state: 'playing', drift: 0, lat: 7.25 }));
  a.ws.send(JSON.stringify({ t: 'status', pos: 0, state: 'playing', drift: 0, lat: 2.5 }));
  const mem = await wait(a, (m) => m.t === 'members' && m.members.some((x) => x.status && x.status.lat === 7.25) && m.members.some((x) => x.status && x.status.lat === 2.5), 'Verzögerung in der Mitgliederliste');
  assert.ok(mem);

  // Freundesliste zeigt, was läuft (ohne Jellyfin-Zugriffsprüfung)
  const act = await (await fetch(`${base}/api/activity`, { headers: lea })).json();
  const f = act.friends.find((x) => x.username === 'chef');
  assert.strictEqual(f.state, 'watching');
  assert.strictEqual(f.item.title, 'riotgames');
  assert.deepStrictEqual(f.item.ext, { kind: 'twitch', live: true, channel: 'riotgames' });

  // Pause/Play gelten auch hier für alle
  a.ws.send(JSON.stringify({ t: 'control', action: 'pause', position: 0 }));
  await wait(b, (m) => m.t === 'playback' && m.playback.item && m.playback.item.ext && m.playback.playing === false, 'Pause bei allen');
});

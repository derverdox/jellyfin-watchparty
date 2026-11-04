'use strict';
/** Sicherheit: Brute-Force-Bremse, IP-Sperre, CSRF, Sitzungs-Hashes, Passwortregeln, Header. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Sicherheit', { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-sec-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: 's'.repeat(40), ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(tmp, 'd'), CACHE_DIR: path.join(tmp, 'c') },
    stdio: 'ignore',
  });
  t.after(() => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/healthz`); break; } catch { await sleep(100); } }

  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  /* Header */
  const h = await fetch(`${base}/`);
  assert.match(h.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.strictEqual(h.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(h.headers.get('permissions-policy'));

  /* Login, Sitzung nur gehasht gespeichert */
  const ok = await post('/api/login', { username: 'chef', password: 'geheim123' });
  assert.strictEqual(ok.status, 200);
  const cookie = /wp_sid=([a-f0-9]+)/.exec(ok.headers.get('set-cookie'))[1];
  const auth = { Cookie: `wp_sid=${cookie}` };
  await sleep(100);
  const stored = fs.readFileSync(path.join(tmp, 'd', 'sessions.json'), 'utf8');
  assert.ok(!stored.includes(cookie), 'Cookie-Token steht nicht im Klartext auf der Platte');
  assert.strictEqual((await fetch(`${base}/api/me`, { headers: auth })).status, 200);

  /* CSRF: fremde Seite darf nichts ändern, Desktop-Client (ohne Origin) schon */
  assert.strictEqual((await post('/api/rooms', {}, { ...auth, Origin: 'https://boese.example' })).status, 403);
  assert.strictEqual((await post('/api/rooms', {}, { ...auth, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await post('/api/rooms', {}, { ...auth, Origin: base })).status, 200);
  assert.strictEqual((await post('/api/rooms', {}, auth)).status, 200);

  /* Passwortregeln */
  const weak = await post('/api/admin/users', { username: 'opfer', password: '12345678' }, auth);
  assert.match((await weak.json()).error, /bekannt/);
  const named = await post('/api/admin/users', { username: 'opfer', password: 'opfer2026!' }, auth);
  assert.match((await named.json()).error, /Benutzernamen/);
  assert.strictEqual((await post('/api/admin/users', { username: 'opfer', password: 'Sonne-Mond-7' }, auth)).status, 200);

  /* Brute Force: ab dem 6. Fehlversuch wird gebremst – auch das richtige Passwort muss warten */
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post('/api/login', { username: 'opfer', password: `falsch${i}xx` })).status);
  assert.deepStrictEqual(codes.slice(0, 6), [401, 401, 401, 401, 401, 401]);
  assert.strictEqual(codes[6], 429, 'siebter Versuch gebremst');
  const blocked = await post('/api/login', { username: 'opfer', password: 'Sonne-Mond-7' });
  assert.strictEqual(blocked.status, 429);
  assert.match((await blocked.json()).error, /warten/);

  /* Verwaltung sieht die Fehlversuche und kann sperren/entsperren */
  const sec = await (await fetch(`${base}/api/admin/security`, { headers: auth })).json();
  assert.ok(sec.watch.some((w) => w.ip === '127.0.0.1' && w.fails24h >= 6));
  assert.ok(sec.users.some((u) => u.name === 'opfer'));
  assert.strictEqual((await post('/api/admin/security/ban', { ip: '127.0.0.1', hours: 1 }, auth)).status, 400, 'eigene IP nicht sperrbar');
  assert.strictEqual((await post('/api/admin/security/ban', { ip: '203.0.113.9', hours: 2, reason: 'Test' }, auth)).status, 200);
  const sec2 = await (await fetch(`${base}/api/admin/security`, { headers: auth })).json();
  assert.ok(sec2.bans.some((b) => b.ip === '203.0.113.9' && b.reason === 'Test'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'd', 'bans.json'), 'utf8'))['203.0.113.9'], 'Sperre überlebt Neustart');
  await post('/api/admin/security/unban', { ip: '127.0.0.1' }, auth);
  assert.strictEqual((await post('/api/login', { username: 'opfer', password: 'Sonne-Mond-7' })).status, 200, 'nach Entsperren wieder möglich');

  /* Admin kommt trotz Bremse an seine Daten */
  assert.strictEqual((await fetch(`${base}/api/admin/overview`, { headers: auth })).status, 200);
});

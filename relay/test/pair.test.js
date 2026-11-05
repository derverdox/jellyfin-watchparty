'use strict';
/** Anmelden per QR-Code: Gerät holt Code, Handy bestätigt, nur das Gerät mit dem Token bekommt die Sitzung. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pairing, deviceLabel, normalizeCode } = require('../lib/pair');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Pairing-Logik', () => {
  let now = 1000;
  const p = new Pairing({ ttlMs: 60000, now: () => now });
  clearInterval(p.timer);
  const a = p.start({ ip: '1.2.3.4', ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) Chrome/94' });
  assert.match(a.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(p.get(a.code).device, 'Samsung-Fernseher (Browser)');
  assert.equal(p.get(`${a.code.slice(0, 4)}-${a.code.slice(4).toLowerCase()}`).code, a.code, 'Code tolerant eingeben');
  assert.equal(p.get(`https://x.example/pair/${a.code}`).code, a.code, 'ganzer Link geht auch');
  assert.equal(p.poll('falsch'.repeat(5)), null, 'falsches Token findet nichts');
  assert.equal(p.poll(a.token).state, 'pending');
  p.approve(p.get(a.code), 'lisa');
  assert.throws(() => p.approve(p.get(a.code), 'mallory'), /schon benutzt/);
  const pr = p.poll(a.token);
  assert.equal(pr.state, 'approved');
  assert.equal(pr.username, 'lisa');
  p.consume(pr);
  assert.equal(p.poll(a.token), null, 'nur einmal abholbar');

  const b = p.start({ ip: null, ua: '' });
  now += 61000;
  assert.equal(p.poll(b.token).state, 'expired');
  assert.throws(() => p.approve(p.get(b.code), 'lisa'), /abgelaufen/);

  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 9; AFTKA) WatchpartyTV/1.0.3'), 'Fire TV (Watchparty-App)');
  assert.equal(deviceLabel('Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/87'), 'LG-Fernseher (Browser)');
  assert.equal(normalizeCode(' abcd 2345 '), 'ABCD2345');
});

test('Anmelden per QR-Code über die API', { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-pair-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: 'p'.repeat(40), ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(tmp, 'd'), CACHE_DIR: path.join(tmp, 'c') },
    stdio: 'ignore',
  });
  t.after(async () => { await new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill(); }); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/healthz`); break; } catch { await sleep(100); } }
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // Handy ist angemeldet
  const login = await post('/api/login', { username: 'chef', password: 'geheim123' });
  const phone = { Cookie: `wp_sid=${/wp_sid=([a-f0-9]+)/.exec(login.headers.get('set-cookie'))[1]}` };

  // Fernseher holt Code
  const tvUa = { 'User-Agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 Chrome/94' };
  const start = await (await post('/api/pair/start', {}, tvUa)).json();
  assert.match(start.code, /^[A-Z2-9]{8}$/);
  assert.equal(start.path, `/pair/${start.code}`);
  assert.equal((await fetch(`${base}/pair/${start.code}`)).status, 200, 'Bestätigungsseite wird ausgeliefert');
  assert.equal((await (await post('/api/pair/poll', { token: start.token })).json()).state, 'pending');

  // Ohne Anmeldung kann niemand bestätigen
  assert.equal((await post(`/api/pair/${start.code}`, { approve: true })).status, 401);
  // CSRF: fremde Seite darf nicht bestätigen
  assert.equal((await post(`/api/pair/${start.code}`, { approve: true }, { ...phone, Origin: 'https://boese.example' })).status, 403);

  // Handy sieht, welches Gerät fragt
  const info = await (await fetch(`${base}/api/pair/${start.code.toLowerCase()}`, { headers: phone })).json();
  assert.equal(info.device, 'Samsung-Fernseher (Browser)');
  assert.equal(info.state, 'pending');
  assert.equal(info.sameNetwork, true);

  // Bestätigen → Fernseher bekommt beim nächsten Nachfragen eine eigene Sitzung
  assert.equal((await post(`/api/pair/${start.code}`, { approve: true }, phone)).status, 200);
  const done = await post('/api/pair/poll', { token: start.token });
  const body = await done.json();
  assert.equal(body.state, 'ok');
  assert.equal(body.me.username, 'chef');
  const tvCookie = /wp_sid=([a-f0-9]+)/.exec(done.headers.get('set-cookie'))[1];
  assert.notEqual(`wp_sid=${tvCookie}`, phone.Cookie, 'eigene Sitzung für den Fernseher');
  assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: `wp_sid=${tvCookie}` } })).status, 200);

  // Verbraucht: weder nochmal abholen noch nochmal bestätigen
  assert.equal((await (await post('/api/pair/poll', { token: start.token })).json()).state, 'expired');
  assert.equal((await post(`/api/pair/${start.code}`, { approve: true }, phone)).status, 404);

  // Ablehnen
  const s2 = await (await post('/api/pair/start', {})).json();
  await post(`/api/pair/${s2.code}`, { approve: false }, phone);
  assert.equal((await (await post('/api/pair/poll', { token: s2.token })).json()).state, 'denied');
  assert.equal((await post(`/api/pair/${s2.code}`, { approve: true }, phone)).status, 409);

  // Unbekannter Code
  assert.equal((await fetch(`${base}/api/pair/ZZZZ2222`, { headers: phone })).status, 404);

  // Protokoll
  await sleep(200);
  const audit = fs.readFileSync(path.join(tmp, 'd', 'audit.jsonl'), 'utf8');
  assert.match(audit, /pair-approve/);
  assert.match(audit, /pair-login/);
});

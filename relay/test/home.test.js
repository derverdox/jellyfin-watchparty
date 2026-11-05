'use strict';
/** Alleine schauen (Solo-Raum) und Freundesliste (/api/activity). */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Solo-Raum und Freundesliste', { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: 'h'.repeat(40), ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(tmp, 'd'), CACHE_DIR: path.join(tmp, 'c') },
    stdio: 'ignore',
  });
  t.after(async () => { await new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill(); }); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/healthz`); break; } catch { await sleep(100); } }
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const cookieOf = (r) => ({ Cookie: /wp_sid=[a-f0-9]+/.exec(r.headers.get('set-cookie'))[0] });

  // Das Admin-Konto wird beim Start angelegt; kurz warten, bis der Login klappt
  let first;
  for (let i = 0; i < 50; i++) { first = await post('/api/login', { username: 'chef', password: 'geheim123' }); if (first.status === 200) break; await sleep(100); }
  const chef = cookieOf(first);
  assert.equal((await post('/api/admin/users', { username: 'bob', password: 'Sonne-Mond-7' }, chef)).status, 200);
  const bob = cookieOf(await post('/api/login', { username: 'bob', password: 'Sonne-Mond-7' }));

  // Solo-Raum wird wiederverwendet, normale Räume sind eigene
  const s1 = await (await post('/api/rooms', { solo: true }, bob)).json();
  const s2 = await (await post('/api/rooms', { solo: true }, bob)).json();
  assert.equal(s1.code, s2.code);
  assert.equal(s1.solo, true);
  const other = await (await post('/api/rooms', { solo: true }, chef)).json();
  assert.notEqual(other.code, s1.code, 'jeder hat seinen eigenen Solo-Raum');

  // Freundesliste: bob ist online (gerade angemeldet), man selbst steht nicht drin
  const act = await (await fetch(`${base}/api/activity`, { headers: chef })).json();
  assert.ok(Array.isArray(act.friends));
  assert.ok(act.friends.some((f) => f.username === 'bob' && f.state === 'online'));
  assert.ok(!act.friends.some((f) => f.username === 'chef'));
  assert.deepEqual(act.rooms, [], 'leere Räume tauchen nicht auf');
  assert.equal((await fetch(`${base}/api/activity`)).status, 401);
});

'use strict';
/**
 * Warteliste (Bewerbungen) + Förder-Heft (Laufzeiten auf Zeit).
 * Start: node --test test/waitlist.test.js   (im Ordner relay/)
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fakeJf = require('./fixtures/fake-jellyfin');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, label = 'Bedingung') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`Zeitüberschreitung: ${label}`);
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, p, body) {
    const r = await fetch(this.base + p, {
      method, headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
    });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = /wp_sid=([^;]*)/.exec(sc); if (m) this.cookie = m[1] ? `wp_sid=${m[1]}` : ''; }
    const type = r.headers.get('content-type') || '';
    const data = type.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
  login(u, pw) { return this.post('/api/login', { username: u, password: pw }); }
}

test('Warteliste, Einladungen mit Laufzeit und Förder-Heft', { timeout: 90000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-waitlist-'));
  const jf = await fakeJf.start();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = 'y'.repeat(40);
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
  const relay = run(path.join(ROOT, 'relay', 'server.js'), {
    PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: token, ADMIN_USER: 'alice', ADMIN_PASSWORD: 'geheim123',
    DATA_DIR: path.join(tmp, 'data'), CACHE_DIR: path.join(tmp, 'cache'),
  });
  t.after(async () => {
    await Promise.all(procs.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); p.kill(); })));
    jf.server.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await (await fetch(`${base}/healthz`)).ok); } catch { return false; } }, 15000, 'Relay hoch')
    .catch((e) => { throw new Error(`${e.message}\n${relay.out()}`); });
  const mk = () => new Client(base);

  /* ----------anon bewerben ---------- */
  const anon = mk();
  const r1 = await anon.post('/api/waitlist', { name: 'Bewerber Bert', contact: 'bert@example.com', message: 'Schaut bei mir und Lukas schon seit Jahren zusammen, würd gern mitgucken.' });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.data));
  assert.strictEqual(r1.data.position, 1);

  const dup = await anon.post('/api/waitlist', { name: 'bewerber bert', contact: 'anderes@example.com', message: 'Nochmal von einer anderen Adresse.' });
  assert.strictEqual(dup.status, 400, 'gleicher Name doppelt → abgelehnt');

  const kur = await anon.post('/api/waitlist', { name: 'Kurz', message: 'hi' });
  assert.strictEqual(kur.status, 400, 'Nachricht zu kurz → abgelehnt');

  const r2 = await anon.post('/api/waitlist', { name: 'Cindy', contact: '@cindy', message: 'Freundin von Max aus der WG, hat mir euren Link geschickt.' });
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.data));

  /* ---------- Admin sieht Warteliste ---------- */
  const alice = mk();
  assert.strictEqual((await alice.login('alice', 'geheim123')).status, 200);
  const wl = await alice.get('/api/admin/waitlist');
  assert.strictEqual(wl.status, 200);
  assert.strictEqual(wl.data.pending, 2);
  const bert = wl.data.entries.find((e) => e.name === 'Bewerber Bert');
  assert.ok(bert && bert.status === 'pending');
  const cindy = wl.data.entries.find((e) => e.name === 'Cindy');
  const ov = await alice.get('/api/admin/overview');
  assert.strictEqual(ov.data.counts.waitlist, 2, 'Badge-Zähler in der Übersicht');

  /* ---------- Annehmen → Einladungslink mit Laufzeit ---------- */
  const acc = await alice.post(`/api/admin/waitlist/${bert.id}/accept`, { username: 'bert', days: 30, note: 'Kenn Lukas' });
  assert.strictEqual(acc.status, 200, JSON.stringify(acc.data));
  assert.ok(acc.data.path.startsWith('/invite/'));
  const code = acc.data.code;
  assert.strictEqual((await alice.get('/api/admin/invites')).data.invites.find((i) => i.code === code).expiresDays, 30);
  // doppeltes Annehmen mit noch gültigem Link → Fehler
  assert.strictEqual((await alice.post(`/api/admin/waitlist/${bert.id}/accept`, { days: 7 })).status, 400);

  const reg = await anon.post(`/api/invite/${code}`, { username: 'bert', password: 'sicheres_pw_1' });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.data));
  const users = (await alice.get('/api/admin/users')).data.users;
  const bertU = users.find((u) => u.username === 'bert');
  assert.ok(bertU.expires && bertU.expires > Date.now() + 29 * 86400000 && bertU.expires < Date.now() + 31 * 86400000, `Laufzeit gesetzt: ${bertU.expires}`);
  assert.match(bertU.createdBy, /Einladung von alice/);

  /* ---------- Förder-Heft: Laufzeit verlängern + Notiz ---------- */
  const before = bertU.expires;
  const g = await alice.post('/api/admin/users/bert/grant', { days: 90, method: 'PayPal (Freunde)', amount: '15 €', ref: 'TX-4711', note: 'Beitrag fürs halbe Jahr' });
  assert.strictEqual(g.status, 200, JSON.stringify(g.data));
  assert.strictEqual(g.data.grant.to, before + 90 * 86400000, 'Tage werden auf alte Laufzeit gerechnet');
  const gl = await alice.get('/api/admin/grants?user=bert');
  assert.strictEqual(gl.data.grants.length, 1);
  assert.strictEqual(gl.data.grants[0].method, 'PayPal (Freunde)');
  assert.strictEqual((await alice.post('/api/admin/users/alice/grant', { days: 30 })).status, 400, 'Haupt-Admin läuft nicht ab');

  /* ---------- Ablauf blockiert Login ---------- */
  assert.strictEqual((await alice.patch('/api/admin/users/bert', { expires: Date.now() - 1000 })).status, 200);
  const blocked = await mk().login('bert', 'sicheres_pw_1');
  assert.strictEqual(blocked.status, 403);
  assert.match(blocked.data.error, /abgelaufen/);

  /* ---------- Ablehnen + Löschen ---------- */
  assert.strictEqual((await alice.post(`/api/admin/waitlist/${cindy.id}/reject`, { note: 'kennen wir nicht' })).status, 200);
  assert.strictEqual((await alice.del(`/api/admin/waitlist/${cindy.id}`)).status, 200);
  assert.strictEqual((await alice.get('/api/admin/waitlist')).data.entries.filter((e) => e.name === 'Cindy').length, 0);

  /* ---------- abschaltbar ---------- */
  assert.strictEqual((await alice.patch('/api/admin/settings', { waitlistEnabled: false })).status, 200);
  assert.strictEqual((await mk().post('/api/waitlist', { name: 'Spaeter', message: 'Hallo, ich würde auch gern rein.' })).status, 403);
});

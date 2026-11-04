'use strict';
/**
 * Relay + Agent + Test-Jellyfin: Konten, Gruppen, Rechte, Inhaltszugriff,
 * Einladungen, Live-Eingriffe und Telemetrie.
 * Start: node --test test/   (im Ordner relay/, nach npm install in relay/ und agent/)
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const fakeJf = require('./fixtures/fake-jellyfin');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = 'Bedingung') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`Zeitüberschreitung: ${label}`);
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.msgs = []; }
  async req(method, p, body) {
    const r = await fetch(this.base + p, {
      method, headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
    });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = /wp_sid=([^;]*)/.exec(sc); if (m) this.cookie = m[1] ? `wp_sid=${m[1]}` : ''; }
    const type = r.headers.get('content-type') || '';
    const data = type.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
  async login(u, pw) { const r = await this.post('/api/login', { username: u, password: pw }); return r; }
  join(code) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws?room=${code}`, { headers: { Cookie: this.cookie } });
      this.ws.on('message', (d) => this.msgs.push(JSON.parse(d)));
      this.ws.on('close', (c) => { this.closed = c; });
      this.ws.on('open', resolve);
      this.ws.on('unexpected-response', (_q, res) => reject(new Error(`WS ${res.statusCode}`)));
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(fn, label) { return until(() => this.msgs.find(fn), 6000, label); }
}

test('Konten, Gruppen, Rechte und Telemetrie', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-admin-'));
  const jf = await fakeJf.start();
  const { I } = jf;
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
  run(path.join(ROOT, 'agent', 'agent.js'), {
    RELAY_URL: `ws://127.0.0.1:${port}/agent`, AGENT_TOKEN: token, JELLYFIN_URL: `http://127.0.0.1:${jf.port}`,
    JELLYFIN_API_KEY: 'k', DATA_DIR: path.join(tmp, 'agent'), ADMIN_PORT: '0',
  });
  const clients = [];
  t.after(() => { for (const c of clients) try { c.ws && c.ws.close(); } catch { /* egal */ } for (const p of procs) p.kill(); jf.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await (await fetch(`${base}/healthz`)).json()).agent; } catch { return false; } }, 15000, 'online')
    .catch((e) => { throw new Error(`${e.message}\n${relay.out()}`); });
  const mk = () => { const c = new Client(base); clients.push(c); return c; };

  /* ---------- Haupt-Admin ---------- */
  const alice = mk();
  assert.strictEqual((await alice.login('alice', 'geheim123')).status, 200);
  const me = (await alice.get('/api/me')).data;
  assert.ok(me.admin && me.owner, 'alice ist Haupt-Admin');
  assert.strictEqual((await alice.get('/admin')).status, 200, 'Admin-Seite wird ausgeliefert');

  /* ---------- Gruppen anlegen ---------- */
  const g = (await alice.get('/api/admin/groups')).data;
  assert.ok(g.groups.find((x) => x.id === 'standard'));
  assert.ok(g.permissions.length >= 7);
  const kinder = (await alice.post('/api/admin/groups', { name: 'Kinder', perms: { createRoom: true, control: true, load: true, chat: true, suggest: true }, maxBitrate: 20000000, access: { mode: 'only', ids: [I.LIB_K] } })).data.group;
  const ohne = (await alice.post('/api/admin/groups', { name: 'Ohne Klassiker', perms: { createRoom: true, chat: true, direct: true }, access: { mode: 'except', ids: [I.F_KLASSIK] } })).data.group;
  const nurK = (await alice.post('/api/admin/groups', { name: 'Nur Klassiker', perms: { chat: true }, access: { mode: 'only', ids: [I.F_KLASSIK] } })).data.group;

  /* ---------- Konten anlegen ---------- */
  const created = (await alice.post('/api/admin/users', { username: 'bob' })).data;
  assert.match(created.password, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{1,4})+$/, 'Zufallspasswort zurückgegeben');
  const bobPw = created.password;
  for (const [name, grp] of [['kid', kinder.id], ['nk', ohne.id], ['klass', nurK.id], ['gast', 'gaeste']]) {
    const r = await alice.post('/api/admin/users', { username: name, password: 'passwort123', groups: [grp] });
    assert.strictEqual(r.status, 200, `${name}: ${JSON.stringify(r.data)}`);
  }
  const bob = mk(); assert.strictEqual((await bob.login('bob', bobPw)).status, 200);
  const kid = mk(); await kid.login('kid', 'passwort123');
  const nk = mk(); await nk.login('nk', 'passwort123');
  const klass = mk(); await klass.login('klass', 'passwort123');
  const gast = mk(); await gast.login('gast', 'passwort123');

  assert.strictEqual((await bob.get('/api/admin/overview')).status, 403, 'kein Admin-Zugriff für normale Konten');

  /* ---------- Inhaltszugriff ---------- */
  const libs = async (c) => (await c.get('/api/libraries')).data.items.map((x) => x.name).sort();
  assert.deepStrictEqual(await libs(bob), ['Filme', 'Kinder', 'Serien']);
  assert.deepStrictEqual(await libs(kid), ['Kinder'], '„nur Kinder“');
  assert.deepStrictEqual(await libs(nk), ['Filme', 'Kinder', 'Serien'], '„außer Klassiker“ zeigt alle Bibliotheken');
  assert.deepStrictEqual(await libs(klass), ['Klassiker'], 'freigegebener Ordner erscheint als Einstieg');

  assert.strictEqual((await kid.get(`/api/items?parentId=${I.LIB_M}`)).status, 403);
  assert.strictEqual((await kid.get(`/api/item/${I.M_METRO}`)).status, 403);
  assert.strictEqual((await kid.get(`/img/${I.M_METRO}`)).status, 403);
  assert.strictEqual((await kid.get(`/stream/${I.M_METRO}/direct?ms=${jf.MS}`)).status, 403);
  assert.strictEqual((await kid.get(`/api/item/${I.M_KIDS}`)).status, 200);

  const nkItems = (await nk.get(`/api/items?parentId=${I.LIB_M}`)).data.items.map((x) => x.name);
  assert.ok(nkItems.includes('Neuer Film') && !nkItems.includes('Klassiker'), `Ordner „Klassiker“ ausgeblendet: ${nkItems}`);
  assert.deepStrictEqual((await nk.get('/api/search?q=metropolis')).data.movies, [], 'neue Suche filtert auch');
  assert.deepStrictEqual((await nk.get('/api/items?search=metro')).data.items, [], 'auch nicht über die Suche');
  assert.strictEqual((await nk.get(`/api/item/${I.M_METRO}`)).status, 403);
  assert.strictEqual((await nk.get(`/api/item/${I.EP1}`)).status, 200, 'Serien-Folge erlaubt');
  const range = await nk.req('GET', `/stream/${I.M_NEU}/direct?ms=${jf.MS}`);
  assert.strictEqual(range.status, 200, 'Originalqualität für „Ohne Klassiker“ erlaubt');

  assert.deepStrictEqual((await klass.get(`/api/items?parentId=${I.F_KLASSIK}`)).data.items.map((x) => x.name), ['Metropolis']);
  assert.strictEqual((await klass.get(`/api/item/${I.M_NEU}`)).status, 403);

  /* ---------- Rechte ---------- */
  assert.strictEqual((await gast.post('/api/rooms')).status, 403, 'Gäste dürfen keine Räume erstellen');
  assert.strictEqual((await gast.get(`/stream/${I.M_NEU}/direct?ms=${jf.MS}`)).status, 403, 'Gäste: keine Originalqualität');
  const gi = (await gast.get(`/api/item/${I.M_NEU}`)).data;
  assert.strictEqual(gi.directPlayable, false);
  assert.strictEqual(gi.maxBitrate, 10000000);
  const pl = await gast.get(`/stream/${I.M_NEU}/master.m3u8?ms=${jf.MS}&br=40000000`);
  assert.match(String(pl.data), /BANDWIDTH=10000000/, 'Bitrate auf 10 Mbit/s gedeckelt');
  assert.strictEqual((await gast.post('/api/invites')).status, 403, 'Gäste dürfen nicht einladen');
  assert.strictEqual((await gast.get('/api/me')).data.perms.load, false);

  /* ---------- Raum: Zugriff & Rechte live ---------- */
  const { code } = (await bob.post('/api/rooms')).data;
  await bob.join(code); await kid.join(code); await gast.join(code);
  await bob.wait((m) => m.t === 'welcome', 'welcome');
  gast.send({ t: 'load', itemId: I.M_NEU });
  await gast.wait((m) => m.t === 'error' && /nichts auswählen/.test(m.text), 'Gast darf nichts laden');
  bob.send({ t: 'load', itemId: I.M_METRO });
  await kid.wait((m) => m.t === 'noaccess' && m.item.id === I.M_METRO, 'kid bekommt noaccess');
  await bob.wait((m) => m.t === 'chat' && /Kein Zugriff.*kid/.test(m.msg.text), 'Host erfährt es');
  assert.ok(!gast.msgs.some((m) => m.t === 'noaccess'), 'Gast hat Zugriff');
  gast.send({ t: 'chat', text: 'hallo' });
  await bob.wait((m) => m.t === 'chat' && m.msg.text === 'hallo', 'Gast darf chatten');
  bob.send({ t: 'control', action: 'play', position: 0 });
  for (const c of [bob, gast]) c.send({ t: 'status', pos: 1, state: 'playing', drift: 0 });

  /* ---------- Schutz des Haupt-Admins ---------- */
  assert.strictEqual((await alice.del('/api/admin/users/alice')).status, 403);
  assert.strictEqual((await alice.patch('/api/admin/users/alice', { disabled: true })).status, 400);
  const carolPw = (await alice.post('/api/admin/users', { username: 'carol', admin: true })).data.password;
  const carol = mk(); await carol.login('carol', carolPw);
  assert.strictEqual((await carol.del('/api/admin/users/alice')).status, 403, 'Haupt-Admin unlöschbar');
  assert.strictEqual((await carol.patch('/api/admin/users/alice', { note: 'x' })).status, 403, 'andere Admins nur durch Haupt-Admin');
  assert.strictEqual((await carol.post('/api/admin/users', { username: 'dave', admin: true })).status, 403, 'nur Haupt-Admin vergibt Admin');
  assert.strictEqual((await carol.del('/api/admin/users/carol')).status, 400, 'nicht selbst löschen');
  assert.strictEqual((await carol.patch('/api/admin/users/nk', { note: 'testet Filter' })).status, 200, 'normale Konten darf jeder Admin');
  assert.strictEqual((await alice.patch('/api/admin/users/carol', { admin: false })).status, 200);
  assert.strictEqual((await carol.get('/api/admin/overview')).status, 403, 'carol ist kein Admin mehr');

  /* ---------- Sperren wirft sofort raus ---------- */
  assert.strictEqual((await alice.patch('/api/admin/users/gast', { disabled: true })).status, 200);
  await gast.wait((m) => m.t === 'kicked' && /gesperrt/.test(m.text), 'Gast rausgeworfen');
  assert.strictEqual((await gast.get('/api/me')).status, 401);
  assert.match((await gast.login('gast', 'passwort123')).data.error, /gesperrt/);
  await alice.patch('/api/admin/users/gast', { disabled: false });
  assert.strictEqual((await gast.login('gast', 'passwort123')).status, 200);

  /* ---------- Einladungen mit Gruppe und Nutzungen ---------- */
  const inv = (await alice.post('/api/admin/invites', { group: kinder.id, uses: 2, hours: 24, note: 'Kids' })).data;
  for (const n of ['kid2', 'kid3']) {
    const c = mk();
    assert.strictEqual((await c.post(`/api/invite/${inv.code}`, { username: n, password: 'passwort123' })).status, 200);
    assert.deepStrictEqual(await libs(c), ['Kinder'], `${n} landet in Gruppe Kinder`);
  }
  assert.strictEqual((await mk().post(`/api/invite/${inv.code}`, { username: 'kid4', password: 'passwort123' })).status, 400, 'Einladung verbraucht');
  const invs = (await alice.get('/api/admin/invites')).data.invites;
  assert.deepStrictEqual(invs.find((x) => x.code === inv.code).usedBy, ['kid2', 'kid3']);
  const inv2 = (await alice.post('/api/admin/invites', {})).data;
  await alice.del(`/api/admin/invites/${inv2.code}`);
  assert.strictEqual((await mk().get(`/api/invite/${inv2.code}`)).data.valid, false, 'widerrufen');

  /* ---------- Telemetrie & Live-Räume ---------- */
  await bob.get(`/img/${I.M_NEU}`); await bob.get(`/img/${I.M_NEU}`); // Cache-Treffer
  const ov = (await alice.get('/api/admin/overview')).data;
  const room = ov.rooms.find((r) => r.code === code);
  assert.ok(room, 'Raum in der Übersicht');
  assert.strictEqual(room.item.title, 'Metropolis');
  assert.ok(room.members.length >= 2);
  assert.ok(room.members.every((x) => x.kind === 'web'));
  assert.ok(ov.counts.viewers >= 2 && ov.counts.accounts >= 8);
  assert.ok(ov.agent.online && ov.agent.info.serverName === 'Testserver');
  assert.ok(ov.traffic.sessionOut > 0 && ov.traffic.sessionFromCache > 0, 'Traffic + Cache-Ersparnis gezählt');
  assert.ok(ov.health.rss > 0 && ov.health.uptime >= 0);
  assert.ok(ov.feed.some((e) => e.type === 'play'));
  const users = (await alice.get('/api/admin/users')).data.users;
  const bobRow = users.find((u) => u.username === 'bob');
  assert.ok(bobRow.sessions.length >= 1 && bobRow.online.length === 1);
  assert.strictEqual(users[0].username, 'alice', 'Haupt-Admin steht oben');
  const audit = (await alice.get('/api/admin/audit')).data.entries;
  for (const type of ['user-create', 'group-create', 'user-update', 'login', 'login-blocked', 'invite-create']) {
    assert.ok(audit.some((e) => e.type === type), `Protokoll enthält ${type}`);
  }

  /* ---------- Ansage, Rauswurf, Raum schließen ---------- */
  await alice.post(`/api/admin/rooms/${code}/announce`, { text: 'Gleich Pause!' });
  await kid.wait((m) => m.t === 'announce' && m.text === 'Gleich Pause!', 'Ansage');
  const kidMember = room.members.find((x) => x.username === 'kid');
  await alice.post(`/api/admin/rooms/${code}/kick`, { clientId: kidMember.id });
  await kid.wait((m) => m.t === 'kicked', 'kid entfernt');
  await alice.post(`/api/admin/rooms/${code}/close`);
  await bob.wait((m) => m.t === 'kicked' && /geschlossen/.test(m.text), 'Raum geschlossen');

  /* ---------- Wartungsmodus ---------- */
  await alice.patch('/api/admin/settings', { maintenance: true, motd: 'Viel Spaß!' });
  assert.strictEqual((await mk().login('bob', bobPw)).status, 503);
  assert.strictEqual((await bob.get('/api/me')).status, 401, 'bestehende Sitzung pausiert');
  assert.strictEqual((await alice.get('/api/me')).status, 200, 'Admins kommen rein');
  await alice.patch('/api/admin/settings', { maintenance: false });
  assert.strictEqual((await bob.get('/api/me')).data.motd, 'Viel Spaß!');

  /* ---------- Löschen ---------- */
  assert.strictEqual((await alice.del('/api/admin/users/nk')).status, 200);
  assert.strictEqual((await nk.get('/api/me')).status, 401);
  assert.strictEqual((await alice.del(`/api/admin/groups/standard`)).status, 400, 'Standardgruppe bleibt');
  assert.strictEqual((await alice.del(`/api/admin/groups/${ohne.id}`)).status, 200);
});

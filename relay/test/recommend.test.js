'use strict';
/** Empfehlungs-Algorithmus (rein, ohne Server). */
const test = require('node:test');
const assert = require('node:assert');
const { recommend, normalize, franchiseKey, ageOf, tasteFrom, sameWork } = require('../lib/recommend');

let n = 0;
const mk = (name, o = {}) => normalize({
  Id: o.id || String(++n).padStart(32, '0'), Name: name, Type: o.type || 'Movie', ProductionYear: o.year || 2010,
  Genres: o.genres || [], Studios: (o.studios || []).map((s) => ({ Name: s })), Tags: o.tags || [],
  People: o.people || [], CommunityRating: o.rating ?? 7, OfficialRating: o.age || null, ProviderIds: o.prov || {},
});
const dir = (id, name) => ({ Id: id, Name: name, Type: 'Director' });
const act = (id, name) => ({ Id: id, Name: name, Type: 'Actor' });

test('Reihen-Schlüssel aus dem Titel', () => {
  assert.strictEqual(franchiseKey('Der Herr der Ringe: Die Gefährten'), 'herr der ringe');
  assert.strictEqual(franchiseKey('Der Herr der Ringe - Die zwei Türme'), 'herr der ringe');
  assert.strictEqual(franchiseKey('Toy Story 3'), 'toy story');
  assert.strictEqual(franchiseKey('Rocky IV'), 'rocky');
  assert.strictEqual(franchiseKey('Harry Potter und der Stein der Weisen'), 'harry potter und der stein der weisen');
  assert.strictEqual(franchiseKey('Teil 2'), null, 'nichts Brauchbares übrig');
  assert.strictEqual(franchiseKey('Up'), null, 'zu kurz');
});

test('Freigabealter', () => {
  assert.strictEqual(ageOf('FSK 12'), 12);
  assert.strictEqual(ageOf('de/16'), 16);
  assert.strictEqual(ageOf('PG-13'), 13);
  assert.strictEqual(ageOf('R'), 17);
  assert.strictEqual(ageOf(''), null);
});

test('Gleiches Werk in anderer Fassung wird nicht empfohlen', () => {
  const a = mk('Versionsfilm - 1080p', { year: 2001, prov: { Tmdb: '1' } });
  const b = mk('Versionsfilm - 2160p', { year: 2001, prov: { Tmdb: '1' } });
  const c = mk('Versionsfilm - 576p', { year: 2001 });
  assert.ok(sameWork(a, b));
  assert.ok(sameWork(a, c), 'gleicher Titel + Jahr ohne Anbieter-ID');
  assert.ok(!sameWork(a, mk('Anderer Film', { year: 2001 })));
});

test('Ähnlichkeit: Reihe, Regie, Genres schlagen Zufall', () => {
  const nolan = dir('d1', 'Christopher Nolan');
  const seed = mk('Batman Begins', { year: 2005, genres: ['Action', 'Krimi', 'Drama'], studios: ['Warner Bros.'], people: [nolan, act('a1', 'Christian Bale'), act('a2', 'Michael Caine')], tags: ['superheld', 'gotham'] });
  // „Batman Begins“ hat keinen Doppelpunkt – Reihe greift über Titelanfang nicht; Nachfolger teilt aber Personen/Tags
  const darkKnight = mk('The Dark Knight', { year: 2008, genres: ['Action', 'Krimi', 'Drama'], studios: ['Warner Bros.'], tags: ['superheld', 'gotham'] });
  const prestige = mk('The Prestige', { year: 2006, genres: ['Drama', 'Mystery'] });
  const romcom = mk('Notting Hill', { year: 1999, genres: ['Komödie', 'Romantik'] });
  const action = mk('Fast & Furious', { year: 2009, genres: ['Action'] });
  const kids = mk('Bambi', { year: 1942, genres: ['Animation', 'Familie'] });
  const filler = Array.from({ length: 30 }, (_, i) => mk(`Füller ${i}`, { genres: [['Drama', 'Komödie', 'Action', 'Horror'][i % 4]] }));
  const catalog = [darkKnight, prestige, romcom, action, kids, ...filler];
  const sharedPeople = new Map([[darkKnight.id, new Set(['d1', 'a1', 'a2'])], [prestige.id, new Set(['d1', 'a1', 'a2'])]]);
  const personCounts = new Map([['d1', 3], ['a1', 3], ['a2', 6]]);
  const recs = recommend(seed, catalog, { sharedPeople, personCounts, limit: 5 });
  assert.strictEqual(recs[0].id, darkKnight.id, 'Nachfolger mit gleicher Regie, Darstellern, Tags vorn');
  assert.strictEqual(recs[1].id, prestige.id, 'gleiche Regie + Darsteller vor bloßem Genre');
  assert.ok(!recs.some((r) => r.id === kids.id || r.id === romcom.id), 'nichts Unpassendes');
  assert.ok(recs[0].reasons.some((x) => x.startsWith('Regie: Christopher Nolan')), `Begründung: ${recs[0].reasons}`);
  assert.ok(recs[1].reasons.some((x) => x.includes('Christian Bale')));
});

test('Reihe: Fortsetzung ganz vorn, schon Gesehenes nach hinten', () => {
  const g = ['Fantasy', 'Abenteuer'];
  const seed = mk('Der Herr der Ringe: Die Gefährten', { year: 2001, genres: g });
  const p2 = mk('Der Herr der Ringe: Die zwei Türme', { year: 2002, genres: g });
  const p3 = mk('Der Herr der Ringe: Die Rückkehr des Königs', { year: 2003, genres: g });
  const hobbit = mk('Der Hobbit', { year: 2012, genres: g });
  const filler = Array.from({ length: 25 }, (_, i) => mk(`Fantasyfilm ${i}`, { genres: i % 2 ? g : ['Drama'] }));
  const all = [p3, hobbit, p2, ...filler];
  let recs = recommend(seed, all, { limit: 4 });
  assert.strictEqual(recs[0].id, p2.id, 'nächster Teil zuerst');
  assert.ok(recs.slice(0, 3).some((r) => r.id === p3.id));
  assert.strictEqual(recs[0].reasons[0], 'Fortsetzung der Reihe');

  // Teil 2 kennen schon alle drei im Raum → nicht mehr ganz vorn
  recs = recommend(seed, all, { limit: 4, viewers: 3, watchedBy: (id) => (id === p2.id ? 3 : 0) });
  assert.notStrictEqual(recs[0].id, p2.id);
  assert.strictEqual(recs.find((r) => r.id === p2.id)?.watchedBy ?? 3, 3);
});

test('Freigabe, Qualität, Geschmack und Vielfalt', () => {
  const seed = mk('Familienabenteuer', { genres: ['Abenteuer', 'Familie'], age: 'FSK 6' });
  const harsh = mk('Brutaler Abenteuerfilm', { genres: ['Abenteuer', 'Familie'], age: 'FSK 18', rating: 7 });
  const soft = mk('Sanfter Abenteuerfilm', { genres: ['Abenteuer', 'Familie'], age: 'FSK 6', rating: 7 });
  const bad = mk('Mieser Abenteuerfilm', { genres: ['Abenteuer', 'Familie'], age: 'FSK 6', rating: 3 });
  const filler = Array.from({ length: 20 }, (_, i) => mk(`Anderes ${i}`, { genres: ['Doku'] }));
  const recs = recommend(seed, [harsh, soft, bad, ...filler], { limit: 3 });
  const pos = (it) => recs.findIndex((r) => r.id === it.id);
  assert.ok(pos(soft) < pos(harsh), 'FSK 18 nach einem FSK-6-Film nach hinten');
  assert.ok(pos(soft) < pos(bad), 'Bewertung zählt');

  // Eure Sterne heben einen schwach bewerteten Titel an
  const ours = (id) => (id === bad.id ? { avg: 10, count: 6 } : null);
  const recs2 = recommend(seed, [soft, bad, ...filler], { limit: 2, ours });
  assert.strictEqual(recs2[0].id, bad.id, 'bei uns geliebt schlägt Jellyfin-Wertung');

  // Geschmack: Leute im Raum lieben Komödien
  const byId = new Map();
  const loved = mk('Lieblingskomödie', { genres: ['Komödie'] });
  byId.set(loved.id, loved);
  const taste = tasteFrom([{ id: loved.id, score: 10 }, { id: loved.id, score: 9 }], byId);
  assert.ok(taste.get('komodie') > 0);
  const s2 = mk('Abenteuer', { genres: ['Abenteuer'] });
  const comedyAdv = mk('Lustiges Abenteuer', { genres: ['Abenteuer', 'Komödie'] });
  const dramaAdv = mk('Ernstes Abenteuer', { genres: ['Abenteuer', 'Drama'] });
  const f2 = Array.from({ length: 20 }, (_, i) => mk(`X ${i}`, { genres: [i % 2 ? 'Komödie' : 'Drama'] }));
  const r3 = recommend(s2, [dramaAdv, comedyAdv, ...f2], { limit: 2, tasteGenres: taste });
  assert.strictEqual(r3[0].id, comedyAdv.id, 'Geschmack des Raums entscheidet bei Gleichstand');
});

test('Leerer oder unpassender Katalog', () => {
  const seed = mk('Allein', { genres: ['Western'] });
  assert.deepStrictEqual(recommend(seed, []), []);
  assert.deepStrictEqual(recommend(seed, [mk('Anderes', { genres: ['Horror'] })]), []);
});

/* ---------------- Mit Relay, Agent und Test-Jellyfin ---------------- */

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
function client(base) {
  const c = { cookie: '', msgs: [] };
  c.req = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...(c.cookie ? { Cookie: c.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
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

test('Empfehlungen im Raum am Filmende', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-reco-'));
  const jf = await fakeJf.start();
  const { I } = jf;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = 'r'.repeat(40);
  const procs = [
    spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: token, ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(tmp, 'd'), CACHE_DIR: path.join(tmp, 'c'), ROUND_SECONDS: '5' }, stdio: 'ignore' }),
    spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.js')], { env: { ...process.env, RELAY_URL: `ws://127.0.0.1:${port}/agent`, AGENT_TOKEN: token, JELLYFIN_URL: `http://127.0.0.1:${jf.port}`, JELLYFIN_API_KEY: 'k', DATA_DIR: path.join(tmp, 'a'), ADMIN_PORT: '0' }, stdio: 'ignore' }),
  ];
  const all = [];
  t.after(async () => {
    for (const c of all) try { c.ws && c.ws.close(); } catch { /* egal */ }
    await Promise.all(procs.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); p.kill(); })));
    jf.server.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await (await fetch(`${base}/healthz`)).json()).agent) break; } catch { /* startet */ } await sleep(100); }

  const chef = client(base); all.push(chef);
  await chef.req('POST', '/api/login', { username: 'chef', password: 'geheim123' });

  /* HTTP: ähnliche Titel für mich */
  const r1 = (await chef.req('GET', `/api/recommend/${I.M_RUECK}`)).data.items;
  assert.ok(r1.length >= 1, 'überhaupt Empfehlungen');
  assert.strictEqual(r1[0].name, 'Ritter der Nacht', `gleiche Regie, Studio, Tags vorn: ${r1.map((x) => x.name)}`);
  assert.ok(r1[0].reasons.includes('Regie: Greta Regie'), `Begründung: ${r1[0].reasons}`);
  assert.ok(!r1.some((x) => x.id === I.M_RUECK), 'nicht der Film selbst');
  assert.ok(r1.every((x) => x.type === 'Movie' || x.type === 'Series'));
  assert.strictEqual((await chef.req('GET', '/api/recommend/xyz')).status, 404, 'Unsinn-ID passt nicht auf die Route');

  /* Eingeschränktes Konto: „Ritter der Nacht“ ist für Eva gesperrt */
  const grp = (await chef.req('POST', '/api/admin/groups', { name: 'Ohne Nacht', perms: { createRoom: true, control: true, load: true, chat: true, suggest: true }, access: { mode: 'except', ids: [I.M_4K] } })).data.group;
  assert.strictEqual((await chef.req('POST', '/api/admin/users', { username: 'eva', password: 'passwort123', groups: [grp.id] })).status, 200);
  const eva = client(base); all.push(eva);
  await eva.req('POST', '/api/login', { username: 'eva', password: 'passwort123' });
  const r2 = (await eva.req('GET', `/api/recommend/${I.M_RUECK}`)).data.items;
  assert.ok(!r2.some((x) => x.id === I.M_4K), 'gesperrte Titel tauchen nicht auf');

  /* Raum: am Ende kommen die Empfehlungen von selbst */
  const { code } = (await chef.req('POST', '/api/rooms')).data;
  await chef.join(code);
  await chef.wait((m) => m.t === 'welcome', 'welcome');
  chef.send({ t: 'load', itemId: I.M_RUECK });
  await chef.wait((m) => m.t === 'playback' && m.action === 'load', 'geladen');
  chef.send({ t: 'control', action: 'seek', position: 57 });
  chef.send({ t: 'control', action: 'play', position: 57 });
  const recs = await chef.wait((m) => m.t === 'recs' && m.recs, 'Empfehlungen am Ende', 15000);
  assert.strictEqual(recs.recs.item.id, I.M_RUECK);
  assert.strictEqual(recs.recs.items[0].id, I.M_4K, 'alleine im Raum: Ritter der Nacht vorn');

  // Wer später dazukommt, bekommt sie mit dem welcome
  await eva.join(code);
  const w = await eva.wait((m) => m.t === 'welcome', 'welcome Eva');
  assert.ok(w.recs && w.recs.items.length, 'Empfehlungen auch im welcome');

  // Zurückspulen blendet sie aus …
  chef.msgs.length = 0;
  chef.send({ t: 'control', action: 'seek', position: 10 });
  await chef.wait((m) => m.t === 'recs' && m.recs === null, 'ausgeblendet');
  // … und am Ende kommen sie wieder (jetzt mit Eva → ohne den für sie gesperrten Titel)
  chef.send({ t: 'load', itemId: I.M_RUECK });
  await chef.wait((m) => m.t === 'playback' && m.action === 'load', 'neu geladen');
  chef.msgs.length = 0;
  chef.send({ t: 'control', action: 'seek', position: 57 });
  chef.send({ t: 'control', action: 'play', position: 57 });
  const again = await chef.wait((m) => m.t === 'recs' && m.recs, 'wieder da', 15000);
  assert.ok(!again.recs.items.some((x) => x.id === I.M_4K), 'für alle im Raum freigegeben');

  // Mit Warteschlange keine Empfehlungen, dort geht es ja weiter
  chef.send({ t: 'load', itemId: I.M_RUECK });
  await sleep(300);
  chef.send({ t: 'queue-add', itemId: I.M_NEU });
  await chef.wait((m) => m.t === 'queue' && m.queue.length === 1, 'eingereiht');
  chef.msgs.length = 0;
  chef.send({ t: 'control', action: 'seek', position: 58 });
  chef.send({ t: 'control', action: 'play', position: 58 });
  await chef.wait((m) => m.t === 'advancing', 'Warteschlange schaltet weiter', 15000);
  assert.ok(!chef.msgs.some((m) => m.t === 'recs' && m.recs), 'keine Empfehlungen bei voller Warteschlange');
});

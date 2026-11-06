'use strict';
/** Serienansicht, Gesehen, Bewertungen, schwarzes Brett, Warteschlange, Abstimmung, Zufall, Intro-Marker, Profil. */
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
  c.wait = (fn, label, ms) => until(() => c.msgs.find(fn), ms || 6000, label);
  return c;
}

test('Neue Funktionen', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-feat-'));
  const jf = await fakeJf.start();
  const { I } = jf;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = 'f'.repeat(40);
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
  await chef.req('POST', '/api/admin/users', { username: 'lea', password: 'passwort123' });
  const lea = client(base); all.push(lea);
  await lea.req('POST', '/api/login', { username: 'lea', password: 'passwort123' });

  /* ---------- Serienansicht & Gesehen ---------- */
  let show = (await lea.req('GET', `/api/show/${I.SERIES}`)).data;
  assert.deepStrictEqual(show.seasons.map((s) => s.name), ['Staffel 1', 'Staffel 2']);
  assert.deepStrictEqual(show.seasons[0].episodes.map((e) => e.name), ['Folge 1', 'Folge 2', 'Folge 3']);
  assert.strictEqual(show.next.label, 'S1E1', 'ohne Fortschritt: erste Folge');
  await lea.req('POST', '/api/watched', { ids: [I.EP1, I.EP2] });
  show = (await lea.req('GET', `/api/show/${I.SERIES}`)).data;
  assert.strictEqual(show.next.label, 'S1E3', 'nach zwei gesehenen: dritte');
  assert.strictEqual(show.watchedCount, 2);
  assert.ok(show.seasons[0].episodes[0].watched && !show.seasons[0].episodes[2].watched);
  await lea.req('POST', '/api/watched', { ids: [I.EP2], on: false });
  assert.strictEqual((await lea.req('GET', `/api/show/${I.SERIES}`)).data.watchedCount, 1);
  const det = (await lea.req('GET', `/api/details/${I.M_RUECK}`)).data;
  assert.deepStrictEqual(det.genres, ['Abenteuer', 'Drama']);
  assert.strictEqual(det.rating, 7.4);
  assert.strictEqual(det.watched, false);

  /* ---------- Intro-Marker ---------- */
  const ep = (await lea.req('GET', `/api/item/${I.EP1}`)).data;
  assert.deepStrictEqual(ep.segments.map((x) => [x.type, x.start, x.end]), [['intro', 5, 35], ['outro', 50, 60]]);

  /* ---------- Bewertungen (anonym) ---------- */
  assert.deepStrictEqual((await lea.req('POST', '/api/rate', { itemId: I.M_RUECK, score: 9 })).data, { avg: 9, count: 1, mine: 9 });
  assert.deepStrictEqual((await chef.req('POST', '/api/rate', { itemId: I.M_RUECK, score: 6 })).data, { avg: 7.5, count: 2, mine: 6 });
  const ours = (await lea.req('GET', `/api/details/${I.M_RUECK}`)).data.ours;
  assert.deepStrictEqual(ours, { avg: 7.5, count: 2, mine: 9 }, 'nur Schnitt, Anzahl und eigene Bewertung');
  assert.ok(!JSON.stringify(ours).includes('chef'), 'keine Namen');
  assert.strictEqual((await lea.req('POST', '/api/rate', { itemId: I.M_RUECK, score: 11 })).status, 400);
  await chef.req('POST', '/api/rate', { itemId: I.M_4K, score: 10 });
  const top = (await lea.req('GET', '/api/top-rated')).data.items;
  assert.deepStrictEqual(top.map((x) => x.name), ['Ritter der Nacht', 'Die Rückkehr der Ritter']);

  /* ---------- Schwarzes Brett ---------- */
  const w1 = (await lea.req('POST', '/api/wishes', { title: 'Blade Runner', year: 1982, type: 'movie', note: 'Final Cut bitte', tags: ['Sci-Fi'] })).data.wish;
  assert.strictEqual(w1.votes, 1);
  assert.ok(w1.voted);
  const dup = await chef.req('POST', '/api/wishes', { title: 'blade runner', year: 1982 });
  assert.strictEqual(dup.status, 400, 'Duplikat');
  assert.strictEqual((await chef.req('POST', `/api/wishes/${w1.id}/vote`)).data.wish.votes, 2);
  const tagged = (await chef.req('POST', `/api/wishes/${w1.id}/tag`, { tag: 'sci-fi' })).data.wish;
  assert.deepStrictEqual(tagged.tags, [{ tag: 'sci-fi', votes: 2, voted: true }]);
  await chef.req('POST', `/api/wishes/${w1.id}/tag`, { tag: 'Filmabend' });
  const board = (await lea.req('GET', '/api/wishes')).data;
  assert.strictEqual(board.wishes[0].title, 'Blade Runner');
  assert.ok(board.tags.find((x) => x.tag === 'sci-fi'));
  // TMDb-Vorschlaege: ohne Zugang im Test abgeschaltet, aber der Endpunkt existiert
  const ts = (await lea.req('GET', '/api/wishes/titles?q=blade')).data;
  assert.deepStrictEqual(ts.titles, []);
  assert.strictEqual(ts.enabled, false, 'ohne Zugang aus');
  // Uebernommener Vorschlag: TMDB-ID + Poster am Wunsch, Dup-Erkennung ueber die ID
  const w3 = (await chef.req('POST', '/api/wishes', { title: 'Dune', year: 2021, type: 'movie', tmdbId: 693111, imdbId: 'tt1145584', poster: 'https://image.tmdb.org/w154/xyz.jpg' })).data.wish;
  assert.strictEqual(w3.poster, 'https://image.tmdb.org/w154/xyz.jpg');
  assert.strictEqual(w3.imdbId, 'tt1145584');
  assert.strictEqual((await lea.req('POST', '/api/wishes', { title: 'DUNE – Teil 2', tmdbId: 693111 })).status, 400, 'Duplikat ueber TMDB-ID, auch bei anderem Titel');
  const bogus = (await chef.req('POST', '/api/wishes', { title: 'Poster-Fake', poster: 'https://evil.example/x.jpg' })).data.wish;
  assert.strictEqual(bogus.poster, null, 'Poster nur von TMDb');
  const chk = (await lea.req('GET', '/api/wishes/check?q=ritter')).data;
  assert.ok(chk.library.some((x) => x.name === 'Ritter der Nacht'), 'zeigt, was schon da ist');
  assert.strictEqual((await lea.req('PATCH', `/api/wishes/${w1.id}`, { status: 'done' })).status, 400, 'Status nur für Admins');
  // Wunsch, den es schon gibt → wird automatisch erkannt
  const w2 = (await lea.req('POST', '/api/wishes', { title: 'Ritter der Nacht', year: 2012 })).data.wish;
  const done = await until(async () => { const b = (await lea.req('GET', '/api/wishes')).data; const x = b.wishes.find((y) => y.id === w2.id); return x.status === 'done' && x; }, 5000, 'automatisch erfüllt');
  assert.strictEqual(done.libraryItemId, I.M_4K);
  assert.deepStrictEqual((await lea.req('GET', '/api/me')).data.wishNews.map((x) => x.title), ['Ritter der Nacht'], 'Hinweis in der Lobby');
  await lea.req('POST', '/api/wishes/seen');
  assert.deepStrictEqual((await lea.req('GET', '/api/me')).data.wishNews, []);
  await chef.req('PATCH', `/api/wishes/${w1.id}`, { status: 'progress', statusNote: 'wird besorgt' });
  assert.strictEqual((await lea.req('GET', '/api/wishes')).data.wishes.find((x) => x.id === w1.id).statusNote, 'wird besorgt');

  /* ---------- Zufall ---------- */
  const rnd = (await lea.req('GET', `/api/random?parentId=${I.LIB_M}&maxMinutes=5`)).data;
  assert.ok(['Metropolis', 'Neuer Film', 'Die Rückkehr der Ritter', 'Ritter der Nacht'].includes(rnd.pick.name));
  await lea.req('POST', '/api/watched', { ids: [I.M_METRO, I.M_NEU, I.M_RUECK] });
  assert.strictEqual((await lea.req('GET', `/api/random?parentId=${I.LIB_M}&unwatched=1`)).data.pick.name, 'Ritter der Nacht', 'nur Ungesehenes');

  /* ---------- Raum: Warteschlange, Abstimmung, Bewertungsrunde ---------- */
  const { code } = (await chef.req('POST', '/api/rooms')).data;
  await chef.join(code); await lea.join(code);
  await lea.wait((m) => m.t === 'welcome', 'welcome');
  // Gesehen-Status der anderen in der Serienansicht
  const roomShow = (await lea.req('GET', `/api/show/${I.SERIES}?room=${code}`)).data;
  assert.deepStrictEqual(roomShow.roomMembers, ['chef']);
  await chef.req('POST', '/api/watched', { ids: [I.EP3] });
  const rs2 = (await lea.req('GET', `/api/show/${I.SERIES}?room=${code}`)).data;
  assert.deepStrictEqual(rs2.seasons[0].episodes[2].roomWatched, ['chef']);

  lea.send({ t: 'queue-add', itemId: I.EP2 });
  lea.send({ t: 'queue-add', itemIds: [I.EP3, I.S2E1] });
  const q = await lea.wait((m) => m.t === 'queue' && m.queue.length === 3, 'Warteschlange');
  assert.deepStrictEqual(q.queue.map((x) => x.title), ['Testserie', 'Testserie', 'Testserie']);
  chef.send({ t: 'queue-move', index: 2, to: 0 });
  await chef.wait((m) => m.t === 'queue' && m.queue[0].id === I.S2E1, 'verschoben');
  chef.send({ t: 'queue-remove', index: 0 });
  await chef.wait((m) => m.t === 'queue' && m.queue.length === 2 && m.queue[0].id === I.EP2, 'entfernt');

  // Abstimmung
  chef.send({ t: 'poll-start', itemIds: [I.M_RUECK, I.M_4K] });
  const poll = await lea.wait((m) => m.t === 'poll' && m.poll, 'Abstimmung');
  assert.strictEqual(poll.poll.options.length, 2);
  lea.send({ t: 'poll-vote', itemId: I.M_4K });
  chef.send({ t: 'poll-vote', itemId: I.M_4K });
  await chef.wait((m) => m.t === 'poll' && m.poll && m.poll.options.find((o) => o.id === I.M_4K).votes === 2, 'zwei Stimmen');
  chef.send({ t: 'poll-end' });
  const win = await lea.wait((m) => m.t === 'poll' && !m.poll && m.winner, 'Gewinner');
  assert.strictEqual(win.winner.id, I.M_4K);
  await lea.wait((m) => m.t === 'playback' && m.playback.item && m.playback.item.id === I.M_4K, 'Gewinner geladen');

  // Kurz vor Schluss → Bewertungsrunde, danach Ergebnis im Chat
  chef.send({ t: 'control', action: 'seek', position: 57.5 });
  chef.send({ t: 'control', action: 'play', position: 57.5 });
  const prompt = await lea.wait((m) => m.t === 'rate-prompt', 'Bewertungsfrage', 8000);
  assert.strictEqual(prompt.item.id, I.M_4K);
  await lea.req('POST', '/api/rate', { itemId: I.M_4K, score: 8 });
  await chef.req('POST', '/api/rate', { itemId: I.M_4K, score: 9 });
  const end = await lea.wait((m) => m.t === 'round-end', 'Rundenergebnis', 12000);
  assert.deepStrictEqual([end.avg, end.count], [8.5, 2]);
  await lea.wait((m) => m.t === 'chat' && /Eure Runde.*8,5\/10/.test(m.msg.text), 'Ergebnis im Chat');

  // Ende → Warteschlange geht automatisch weiter
  const adv = await lea.wait((m) => m.t === 'advancing', 'gleich geht es weiter', 8000);
  assert.strictEqual(adv.next.id, I.EP2);
  await lea.wait((m) => m.t === 'playback' && m.playback.item && m.playback.item.id === I.EP2 && m.playback.playing, 'nächster Titel läuft', 14000);

  /* ---------- Profil ---------- */
  lea.send({ t: 'status', pos: 3, state: 'playing', drift: 0 });
  await sleep(10500);
  const prof = (await lea.req('GET', '/api/profile')).data;
  assert.ok(prof.secondsAll >= 10, `Zeit gezählt (${prof.secondsAll} s)`);
  assert.strictEqual(prof.topSeries[0].title, 'Testserie');
  assert.ok(prof.watchedCount >= 4);
  assert.strictEqual(prof.ratings.count, 2);
  assert.strictEqual(prof.wishes, 2);
});

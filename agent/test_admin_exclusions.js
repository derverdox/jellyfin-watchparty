'use strict';
/*
 * E2E-Test für den Watchparty-Agenten: Mock-Jellyfin (HTTP) + Mock-Relay (WS),
 * echter agent.js als Kindprozess. Prüft Whitelist unangetastet + neue
 * Bibliotheks-Ausschlüsse (Views/Items-Filter, Direktzugriff 404, Admin-API,
 * Persistenz).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));

const UID  = 'aaaaaaaa000000000000000000000001';
const LIB1 = 'bbbbbbbb000000000000000000000011'; // Filme
const LIB2 = 'bbbbbbbb000000000000000000000022'; // Anime
const MOV1 = 'cccccccc000000000000000000000001';
const ANI1 = 'cccccccc000000000000000000000002';
const ADMIN_TOKEN = 'admin-TEST-token-123456';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-agent-test-'));

// ---------- Mock Jellyfin ----------
const ITEMS = {
  [LIB1]: { Id: LIB1, Name: 'Filme',  Type: 'CollectionFolder', ParentId: null },
  [LIB2]: { Id: LIB2, Name: 'Anime',  Type: 'CollectionFolder', ParentId: null },
  [MOV1]: { Id: MOV1, Name: 'Film1',  Type: 'Movie', ParentId: LIB1, LibraryId: LIB1 },
  [ANI1]: { Id: ANI1, Name: 'Anime1', Type: 'Movie', ParentId: LIB2, LibraryId: LIB2 },
};
const jf = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://jf');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/System/Info') return res.end(JSON.stringify({ ServerName: 'MockJF', Version: '10.9.0' }));
  if (u.pathname === '/Users') return res.end(JSON.stringify([{ Id: UID, Name: 'admin', Policy: { IsAdministrator: true } }]));
  if (u.pathname === `/Users/${UID}/Views`)
    return res.end(JSON.stringify({ Items: [ITEMS[LIB1], ITEMS[LIB2]], TotalRecordCount: 2 }));
  if (u.pathname === `/Users/${UID}/Items`)
    return res.end(JSON.stringify({ Items: [ITEMS[MOV1], ITEMS[ANI1]], TotalRecordCount: 2 }));
  const m = u.pathname.match(new RegExp(`^/Users/${UID}/Items/([a-f0-9]{32})$`));
  if (m && ITEMS[m[1]]) return res.end(JSON.stringify(ITEMS[m[1]]));
  if (u.pathname === `/Videos/${MOV1}/stream`) { res.setHeader('content-type', 'video/mp4'); return res.end('MOV-DATA'); }
  if (u.pathname === `/Videos/${ANI1}/stream`) { res.setHeader('content-type', 'video/mp4'); return res.end('ANI-DATA'); }
  res.statusCode = 404; res.end('{}');
});

// ---------- Mock Relay ----------
let relaySock = null;
const pending = new Map(); // id -> {chunks, resolve}
let nextId = 1;
const relay = new WebSocket.Server({ port: 18010 });
relay.on('connection', (sock, _req) => {
  relaySock = sock;
  sock.on('message', (buf, isBinary) => {
    if (isBinary) { pending.get(buf.readUInt32BE(0))?.chunks.push(buf.subarray(4)); return; }
    const m = JSON.parse(buf.toString());
    if (m.t === 'hello') { helloSeen(m); return; }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.t === 'res') p.meta = m;
    if (m.t === 'err') { p.meta = m; finish(); }
    if (m.t === 'end') finish();
    function finish() {
      pending.delete(m.id);
      p.resolve({ meta: p.meta || {}, body: Buffer.concat(p.chunks || []).toString('utf8') });
    }
  });
});
function relayReq(method, p) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { chunks: [], resolve });
    relaySock.send(JSON.stringify({ t: 'req', id, method, path: p }));
  });
}
let helloSeen;
const helloPromise = new Promise((r) => { helloSeen = r; });

function adminApi(method, p, body, token = ADMIN_TOKEN) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 18098, path: p + (p.includes('?') ? '&' : '?') + 'token=' + token, method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(d); } catch { return d; } })() }));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  await new Promise((r) => jf.listen(18096, r));
  const agent = spawn(process.execPath, ['agent.js'], {
    cwd: __dirname,
    env: { ...process.env, RELAY_URL: 'ws://127.0.0.1:18010/agent', AGENT_TOKEN: 'test'.repeat(12), JELLYFIN_URL: 'http://127.0.0.1:18096', JELLYFIN_API_KEY: 'k', ADMIN_PORT: '18098', ADMIN_TOKEN, DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const agentLog = [];
  agent.stdout.on('data', (c) => agentLog.push(String(c)));
  agent.stderr.on('data', (c) => agentLog.push(String(c)));

  const results = [];
  const check = (name, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : extra]);

  const hello = await Promise.race([helloPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('hello timeout')), 8000))]);
  check('hello an Relay (userId korrekt)', hello.userId === UID, JSON.stringify(hello));

  // Vorher: alles sichtbar
  let r = await relayReq('GET', `/Users/${UID}/Views`);
  check('Views: 2 Bibliotheken (ohne Ausschluss)', JSON.parse(r.body).Items.length === 2, r.body);
  r = await relayReq('GET', `/Users/${UID}/Items?Recursive=true`);
  check('Items: 2 Filme (ohne Ausschluss)', JSON.parse(r.body).Items.length === 2, r.body);

  // Admin-UI: Auth
  let a = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: 18098, path: '/api/libraries' }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  check('Admin-API ohne Token → 401', a === 401, String(a));
  a = await adminApi('GET', '/api/libraries');
  check('Admin-API listet Bibliotheken', a.status === 200 && a.json.libraries.length === 2, JSON.stringify(a));

  // Ausschluss Anime aktivieren
  a = await adminApi('POST', '/api/toggle', { id: LIB2, excluded: true });
  check('Toggle Anime→aus ok', a.status === 200 && a.json.excluded.includes(LIB2), JSON.stringify(a));

  // Danach: gefiltert
  r = await relayReq('GET', `/Users/${UID}/Views`);
  check('Views: nur noch Filme', JSON.parse(r.body).Items.map(i => i.Name).join() === 'Filme', r.body);
  r = await relayReq('GET', `/Users/${UID}/Items?Recursive=true`);
  check('Items: nur noch Film1', JSON.parse(r.body).Items.map(i => i.Name).join() === 'Film1', r.body);
  r = await relayReq('GET', `/Videos/${ANI1}/stream`);
  check('Anime-Stream → 404', r.meta.status === 404, JSON.stringify(r.meta));
  r = await relayReq('GET', `/Users/${UID}/Items/${ANI1}`);
  check('Anime-Metadaten → 404', r.meta.status === 404, JSON.stringify(r.meta));
  r = await relayReq('GET', `/Videos/${MOV1}/stream`);
  check('Film-Stream OK (4 MB-Pfad unverändert)', r.meta.status === 200 && r.body === 'MOV-DATA', JSON.stringify(r.meta) + r.body);

  // Whitelist unverändert: fremder Pfad bleibt 403
  r = await relayReq('GET', '/system/info');
  check('Fremder Pfad weiterhin 403', r.meta.status === 403, JSON.stringify(r.meta));

  // Persistenz
  await new Promise((res) => setTimeout(res, 300));
  const persisted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'exclusions.json'), 'utf8'));
  check('exclusions.json persistiert', persisted.includes(LIB2), JSON.stringify(persisted));

  agent.kill();
  relay.close(); jf.close();
  for (const [s, n, x] of results) console.log(`${s}  ${n}${x ? '  → ' + x : ''}`);
  const failed = results.filter(([s]) => s === 'FAIL').length;
  console.log(failed === 0 ? `\nALLE ${results.length} TESTS BESTANDEN` : `\n${failed}/${results.length} Fehlgeschlagen`);
  if (failed) { console.log('--- Agent-Log ---\n' + agentLog.join('')); process.exit(1); }
})().catch((e) => { console.error('Test-Fehler:', e.message); process.exit(2); });

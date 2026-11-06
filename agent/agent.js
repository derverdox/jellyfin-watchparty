'use strict';
/*
 * Watchparty-Agent – läuft im Heimnetz neben Jellyfin.
 * Verbindet sich AUSGEHEND zum Relay (keine Portfreigabe nötig), nimmt dort
 * Anfragen entgegen, holt sie von Jellyfin und streamt die Antwort zurück.
 * Der Jellyfin-API-Key bleibt hier; das Relay kennt ihn nie. Zusätzlich
 * werden nur ausdrücklich erlaubte Jellyfin-Pfade bedient.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');
const WebSocket = require('ws');
const { DuplicateScanner } = require('./lib/duplicates');

// Im pkg-Executable (watchparty-agent.exe) zeigt __dirname ins Bündel hinein —
// die .env muss neben der EXE-Datei liegen dürfen.
const selfDir = process.pkg ? path.dirname(process.execPath) : __dirname;
loadEnvFile(path.join(selfDir, '.env'));

const VERSION = '2.4.0';
const CFG = {
  relayUrl: process.env.RELAY_URL || '',
  token: process.env.AGENT_TOKEN || '',
  jellyfinUrl: (process.env.JELLYFIN_URL || 'http://localhost:8096').replace(/\/+$/, ''),
  apiKey: process.env.JELLYFIN_API_KEY || '',
  jellyfinUser: process.env.JELLYFIN_USER || '',
  maxConcurrent: toInt(process.env.MAX_CONCURRENT, 24),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  adminPort: toInt(process.env.ADMIN_PORT, 8098),
  // Ohne ADMIN_TOKEN ist die Admin-UI nur lokal erreichbar (127.0.0.1).
  adminBind: process.env.ADMIN_BIND || (process.env.ADMIN_TOKEN ? '0.0.0.0' : '127.0.0.1'),
  adminToken: process.env.ADMIN_TOKEN || '',
  maxUploadMbps: toFloat(process.env.MAX_UPLOAD_MBPS, 0), // 0 = ungedrosselt
};
if (!CFG.relayUrl) fatal('RELAY_URL fehlt, z. B. wss://example.com/agent');
if (!/^wss?:\/\//.test(CFG.relayUrl)) fatal('RELAY_URL muss mit wss:// (oder ws:// zum Testen) beginnen');
if (CFG.token.length < 24) fatal('AGENT_TOKEN fehlt oder ist zu kurz (mind. 24 Zeichen, muss exakt wie auf dem Relay sein)');
if (!CFG.apiKey) fatal('JELLYFIN_API_KEY fehlt (Jellyfin → Dashboard → API-Schlüssel)');

const HIGH_WATER = 8 * 1024 * 1024; // so viel darf maximal im Socket-Puffer warten
const LOW_WATER = 2 * 1024 * 1024;

/* ---------- Upload-Drossel (Token-Eimer, global über alle Streams) ---------- */
const RATE_BPS = CFG.maxUploadMbps > 0 ? Math.round(CFG.maxUploadMbps * 1e6 / 8) : 0;
const BURST = Math.max(256 * 1024, Math.round(RATE_BPS * 0.25)); // kurze Bursts erlauben
let bucket = BURST;
if (RATE_BPS) console.log(`[agent] Upload zum Relay gedrosselt auf ${CFG.maxUploadMbps} Mbit/s`);

function jfAuth() {
  return `MediaBrowser Client="Watchparty", Device="Watchparty Agent", DeviceId="watchparty-agent", Version="${VERSION}", Token="${CFG.apiKey}"`;
}

async function jfJson(p, signal) {
  const r = await fetch(CFG.jellyfinUrl + p, { headers: { Authorization: jfAuth(), Accept: 'application/json' }, signal });
  if (!r.ok) throw new Error(`Jellyfin ${p} → ${r.status}`);
  return r.json();
}

let jellyfin = null; // { userId, userName, serverName, version }
async function probeJellyfin() {
  const info = await jfJson('/System/Info');
  const users = await jfJson('/Users');
  const wanted = CFG.jellyfinUser.toLowerCase();
  const user =
    (wanted && users.find((u) => u.Name.toLowerCase() === wanted)) ||
    users.find((u) => u.Policy && u.Policy.IsAdministrator) ||
    users[0];
  if (!user) throw new Error('Kein Jellyfin-Benutzer gefunden');
  if (wanted && user.Name.toLowerCase() !== wanted) console.warn(`[agent] ⚠ Benutzer "${CFG.jellyfinUser}" nicht gefunden, nehme "${user.Name}"`);
  return { userId: user.Id, userName: user.Name, serverName: info.ServerName, version: info.Version };
}

/* ---------- Whitelist: nur diese Jellyfin-Endpunkte darf das Relay nutzen ---------- */
const ID = '[a-f0-9]{32}|[a-f0-9-]{36}';
function allowed(method, p) {
  const [pathname] = p.split('?');
  if (pathname.includes('..') || pathname.includes('//')) return false;
  const uid = jellyfin && jellyfin.userId;
  const U = uid ? uid.replace(/[^a-f0-9-]/gi, '') : '__none__';
  if (method === 'DELETE') return pathname === '/Videos/ActiveEncodings';
  if (method !== 'GET' && method !== 'HEAD') return false;
  const rules = [
    new RegExp(`^/Users/${U}/Views$`, 'i'),
    new RegExp(`^/Users/${U}/Items$`, 'i'),
    new RegExp(`^/Users/${U}/Items/(${ID})$`, 'i'),
    new RegExp(`^/Shows/(${ID})/Episodes$`, 'i'),
    new RegExp(`^/Items/(${ID})/Images/(Primary|Backdrop|Thumb)$`, 'i'),
    new RegExp(`^/Videos/(${ID})/(master|main|[A-Za-z0-9_]+)\\.m3u8$`, 'i'),
    new RegExp(`^/Videos/(${ID})/hls1/[A-Za-z0-9_]+/-?\\d+\\.(ts|mp4|m4s|aac|vtt)$`, 'i'),
    new RegExp(`^/Videos/(${ID})/stream$`, 'i'),
    new RegExp(`^/Videos/(${ID})/(${ID})/Subtitles/\\d{1,3}/Stream\\.vtt$`, 'i'),
    // Intro/Abspann-Marker (Jellyfin Media Segments bzw. Intro-Skipper-Plugin), nur lesend
    new RegExp(`^/MediaSegments/(${ID})$`, 'i'),
    new RegExp(`^/Episode/(${ID})/IntroTimestamps(/v1)?$`, 'i'),
  ];
  return rules.some((r) => r.test(pathname));
}

function stripKeys(p) {
  const i = p.indexOf('?');
  if (i < 0) return p;
  const q = new URLSearchParams(p.slice(i + 1));
  q.delete('api_key'); q.delete('ApiKey'); q.delete('X-Emby-Token');
  const s = q.toString();
  return p.slice(0, i) + (s ? '?' + s : '');
}

/* ---------- Bibliotheks-Ausschlüsse ---------- */
const excludeFile = path.join(CFG.dataDir, 'exclusions.json');
const excluded = loadExcluded();
function loadExcluded() {
  try { return new Set(JSON.parse(fs.readFileSync(excludeFile, 'utf8'))); } catch { return new Set(); }
}
function saveExcluded() {
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  const tmp = excludeFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...excluded], null, 2));
  fs.renameSync(tmp, excludeFile);
}

const LIB_TTL = 10 * 60 * 1000;
const libCache = new Map(); // itemId -> { lib, ts }
let viewsCache = { ts: 0, ids: new Set(), items: [] };

function cachePut(id, lib) {
  if (libCache.size > 5000) libCache.clear();
  libCache.set(id, { lib, ts: Date.now() });
}

async function getViews(force) {
  if (!force && Date.now() - viewsCache.ts < LIB_TTL) return viewsCache;
  const data = await jfJson('/Users/' + jellyfin.userId + '/Views');
  const items = Array.isArray(data.Items) ? data.Items : [];
  viewsCache = { ts: Date.now(), ids: new Set(items.map((i) => i.Id)), items };
  return viewsCache;
}

/* Ermittelt die Bibliothek (CollectionFolder) eines Items; wandert Parent-Kette hoch. */
async function libraryOf(dto, depth = 0) {
  if (!dto || depth > 8) return null;
  if (dto.Type === 'CollectionFolder') return dto.Id;
  if (dto.LibraryId && viewsCache.ids.has(dto.LibraryId)) return dto.LibraryId;
  let cur = dto.ParentId;
  for (; cur && depth <= 8; depth++) {
    if (viewsCache.ids.has(cur)) return cur;
    const hit = libCache.get(cur);
    if (hit && Date.now() - hit.ts < LIB_TTL) { if (hit.lib) return hit.lib; break; }
    let parent;
    try {
      parent = await jfJson('/Users/' + jellyfin.userId + '/Items/' + cur + '?Fields=ParentId,LibraryId,Type');
    } catch { return null; }
    const lib = await libraryOf(parent, depth + 1);
    cachePut(cur, lib);
    if (lib) return lib;
    cur = parent.ParentId;
  }
  return null;
}

async function itemExcluded(itemId) {
  try {
    await getViews(false);
    const it = await jfJson('/Users/' + jellyfin.userId + '/Items/' + itemId + '?Fields=ParentId,LibraryId,Type');
    const lib = await libraryOf(it);
    return !!(lib && excluded.has(lib));
  } catch { return false; }
}

function filterMode(method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const U = '(?:' + ID + ')';
  if (new RegExp('^/Users/' + U + '/Views$', 'i').test(pathname)) return 'views';
  if (new RegExp('^/Users/' + U + '/Items$', 'i').test(pathname)) return 'list';
  if (new RegExp('^/Shows/' + U + '/Episodes$', 'i').test(pathname)) return 'list';
  return null;
}

function singleItemId(method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  let m;
  if ((m = pathname.match(new RegExp('^/Users/(?:' + ID + ')/Items/(' + ID + ')$', 'i')))) return m[1];
  if ((m = pathname.match(new RegExp('^/Videos/(' + ID + ')/', 'i')))) return m[1];
  if ((m = pathname.match(new RegExp('^/Items/(' + ID + ')/Images/', 'i')))) return m[1];
  return null;
}

/* Listen-Antworten: JSON komplett puffern, filtern und neu ausliefern. */
async function filterJson(id, res, mode) {
  streams.delete(id);
  let data = null;
  try { data = JSON.parse(await res.text()); } catch { /* unten */ }
  if (!data || !Array.isArray(data.Items)) {
    return send({ t: 'err', id, status: 502, message: 'Unerwartete Jellyfin-Antwort' });
  }
  try { await getViews(false); } catch { /* egal */ }
  const kept = [];
  for (const it of data.Items) {
    if (mode === 'views') {
      if (!excluded.has(it.Id)) kept.push(it);
    } else {
      const lib = (it.LibraryId && viewsCache.ids.has(it.LibraryId)) ? it.LibraryId : await libraryOf(it);
      if (!(lib && excluded.has(lib))) kept.push(it);
    }
  }
  const removed = data.Items.length - kept.length;
  data.Items = kept;
  // Gesamtzahl der ganzen Liste (nicht nur dieser Seite) – sonst glaubt das Relay, nach einer Seite sei Schluss
  if (typeof data.TotalRecordCount === 'number') data.TotalRecordCount = Math.max(kept.length, data.TotalRecordCount - removed);
  const buf = Buffer.from(JSON.stringify(data));
  send({ t: 'res', id, status: res.status, headers: { 'content-type': 'application/json', 'content-length': String(buf.length) } });
  if (buf.length && ws && ws.readyState === WebSocket.OPEN) ws.send(frame(id, buf));
  send({ t: 'end', id });
}

/* ---------- Verbindung zum Relay ---------- */
let ws = null;
let retry = 0;
const streams = new Map(); // id -> { ac, body, relayPaused, wsPaused, throttled, paused }

function frame(id, chunk) {
  const h = Buffer.allocUnsafe(4);
  h.writeUInt32BE(id, 0);
  return Buffer.concat([h, chunk]);
}

function connect() {
  console.log(`[agent] verbinde zu ${CFG.relayUrl} …`);
  const sock = new WebSocket(CFG.relayUrl, {
    headers: { Authorization: `Bearer ${CFG.token}`, 'User-Agent': `watchparty-agent/${VERSION}` },
    perMessageDeflate: false,
    handshakeTimeout: 15000,
  });
  ws = sock;
  let deadTimer;
  const bump = () => { clearTimeout(deadTimer); deadTimer = setTimeout(() => sock.terminate(), 70000); };

  sock.on('open', async () => {
    retry = 0;
    bump();
    console.log('[agent] ✔ mit Relay verbunden');
    await announce(sock);
  });
  sock.on('ping', bump);
  sock.on('message', (data, isBinary) => {
    bump();
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    onMessage(m);
  });
  sock.on('unexpected-response', (_, res) => {
    if (res.statusCode === 401) console.error('[agent] ✖ Relay lehnt den AGENT_TOKEN ab. Stimmt er auf beiden Seiten überein?');
    else console.error(`[agent] ✖ Relay antwortet mit HTTP ${res.statusCode}`);
  });
  sock.on('error', (e) => { if (e.message && !/Unexpected server response/.test(e.message)) console.error('[agent] Fehler:', e.message); });
  sock.on('close', (code) => {
    clearTimeout(deadTimer);
    for (const st of streams.values()) { st.ac.abort(); if (st.body) st.body.destroy(); }
    streams.clear();
    if (ws !== sock) return;
    ws = null;
    if (code === 4000) console.warn('[agent] ⚠ Ein anderer Agent hat sich mit demselben Token verbunden.');
    const delay = Math.min(1000 * 2 ** retry++, 30000);
    console.log(`[agent] Verbindung weg – neuer Versuch in ${Math.round(delay / 1000)} s`);
    setTimeout(connect, delay);
  });
}

async function announce(sock) {
  // Erst melden, wenn Jellyfin wirklich erreichbar ist
  while (sock.readyState === WebSocket.OPEN) {
    try {
      jellyfin = await probeJellyfin();
      await getViews(true).catch(() => {});
      sock.send(JSON.stringify({ t: 'hello', version: VERSION, userId: jellyfin.userId, userName: jellyfin.userName, serverName: jellyfin.serverName, jfVersion: jellyfin.version, maxUploadMbps: CFG.maxUploadMbps }));
      console.log(`[agent] ✔ Jellyfin "${jellyfin.serverName}" (${jellyfin.version}) bereit, lese als "${jellyfin.userName}"`);
      return;
    } catch (e) {
      console.error(`[agent] ✖ Jellyfin unter ${CFG.jellyfinUrl} nicht erreichbar: ${e.message} – neuer Versuch in 10 s`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

function send(m) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); }

function onMessage(m) {
  const id = m.id >>> 0;
  switch (m.t) {
    case 'req': return handleRequest(id, m);
    case 'cancel': {
      const st = streams.get(id);
      if (st) { st.ac.abort(); if (st.body) st.body.destroy(); streams.delete(id); }
      return;
    }
    case 'pause': {
      const st = streams.get(id);
      if (st) { st.relayPaused = true; syncPaused(st); }
      return;
    }
    case 'resume': {
      const st = streams.get(id);
      if (st) { st.relayPaused = false; syncPaused(st); }
      return;
    }
  }
}

async function handleRequest(id, m) {
  const method = String(m.method || 'GET').toUpperCase();
  const p = stripKeys(String(m.path || ''));
  if (!p.startsWith('/') || !allowed(method, p)) {
    console.warn(`[agent] ⛔ abgelehnt: ${method} ${p.split('?')[0]}`);
    return send({ t: 'err', id, status: 403, message: 'Pfad nicht erlaubt' });
  }
  if (streams.size >= CFG.maxConcurrent) return send({ t: 'err', id, status: 503, message: 'Heimserver ausgelastet' });

  // Ausgeschlossene Bibliotheken: Einzelzugriff direkt verweigern
  if (excluded.size && jellyfin) {
    const sid = singleItemId(method, p.split('?')[0]);
    if (sid && await itemExcluded(sid)) {
      return send({ t: 'err', id, status: 404, message: 'Diese Bibliothek ist nicht Teil der Watchparty' });
    }
  }

  const st = { ac: new AbortController(), body: null, relayPaused: false, wsPaused: false, throttled: false, paused: false };
  streams.set(id, st);
  const headers = { Authorization: jfAuth(), 'Accept-Encoding': 'identity' };
  const h = m.headers || {};
  if (typeof h.Range === 'string' && /^bytes=\d*-\d*$/.test(h.Range)) headers.Range = h.Range;
  if (typeof h.Accept === 'string') headers.Accept = h.Accept.slice(0, 200);

  let res;
  try {
    res = await fetch(CFG.jellyfinUrl + p, { method, headers, signal: st.ac.signal });
  } catch (e) {
    streams.delete(id);
    if (!st.ac.signal.aborted) send({ t: 'err', id, status: 502, message: 'Jellyfin nicht erreichbar' });
    return;
  }
  if (!streams.has(id)) { try { res.body && res.body.cancel(); } catch { /* egal */ } return; }

  // Listen-Antworten filtern (nur wenn überhaupt etwas ausgeschlossen ist)
  if (excluded.size && res.ok && jellyfin) {
    const mode = filterMode(method, p.split('?')[0]);
    if (mode && (res.headers.get('content-type') || '').includes('json')) {
      return filterJson(id, res, mode);
    }
  }

  const out = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = res.headers.get(k);
    if (v) out[k] = v;
  }
  send({ t: 'res', id, status: res.status, headers: out });
  if (!res.body || method === 'HEAD') { streams.delete(id); return send({ t: 'end', id }); }

  const body = Readable.fromWeb(res.body);
  st.body = body;
  syncPaused(st);
  body.on('data', (chunk) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return body.destroy();
    ws.send(frame(id, chunk));
    if (ws.bufferedAmount > HIGH_WATER) st.wsPaused = true;
    if (RATE_BPS) {
      bucket -= chunk.length;
      if (bucket <= 0) st.throttled = true; // Eimer leer → nächster Chunk wartet
    }
    syncPaused(st);
  });
  body.on('end', () => { if (streams.get(id) === st) { streams.delete(id); send({ t: 'end', id }); } });
  body.on('error', (e) => {
    if (streams.get(id) === st) { streams.delete(id); send({ t: 'err', id, status: 502, message: e.message }); }
  });
}

/* Stream pausieren/weiterlaufen lassen, je nachdem ob Relay, Socket-Puffer
   oder Upload-Drossel gerade bremsen. */
function syncPaused(st) {
  if (!st.body) return;
  const wantPause = st.relayPaused || st.wsPaused || st.throttled;
  if (wantPause && !st.paused) { st.paused = true; st.body.pause(); }
  else if (!wantPause && st.paused) { st.paused = false; st.body.resume(); }
}

// Timer: Token-Eimer nachfüllen, Socket-Puffer und Drossel prüfen → Streams freilassen
setInterval(() => {
  if (!ws) return;
  if (RATE_BPS) bucket = Math.min(BURST, bucket + RATE_BPS * 0.025);
  const canDrain = ws.bufferedAmount <= LOW_WATER;
  for (const st of streams.values()) {
    if (st.wsPaused && canDrain) st.wsPaused = false;
    if (st.throttled && bucket > 0) st.throttled = false;
    syncPaused(st);
  }
}, 25);

/* ---------- Lokale Admin-UI: Bibliotheken ein-/ausschlie\dfen (nur LAN) ---------- */
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function adminAuthed(req, url) {
  if (!CFG.adminToken) return true; // ohne Token nur auf 127.0.0.1 gebunden
  const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return timingSafeEq(h, CFG.adminToken) || timingSafeEq(url.searchParams.get('token') || '', CFG.adminToken);
}

const duplicateScanner = new DuplicateScanner({
  getLibraries: async () => (await jfJson(`/Users/${jellyfin.userId}/Views`, AbortSignal.timeout(30000))).Items || [],
  fetchPage: (libId, offset, fields) => {
    const q = new URLSearchParams({ ParentId: libId, Recursive: 'true', IncludeItemTypes: 'Movie,Series,Episode',
      Fields: fields, StartIndex: String(offset), Limit: '500', SortBy: 'SortName' });
    return jfJson(`/Users/${jellyfin.userId}/Items?${q}`, AbortSignal.timeout(30000));
  },
  isExcluded: (id) => excluded.has(id),
});

const adminFails = new Map(); // ip → { n, until }

function startAdmin() {
  if (CFG.adminToken && CFG.adminToken.length < 16) console.warn('[agent] ⚠ ADMIN_TOKEN ist kurz – mindestens 16 Zeichen empfohlen (openssl rand -hex 16)');
  const srv = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://admin'); } catch { res.writeHead(400); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/') {
      // Die Seite selbst ist öffentlich (nur LAN!), das Token holt sich die Seite
      // über das Login-Feld; alle Daten-Endpunkte unten sind token-geschützt.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(ADMIN_HTML);
    }
    const rip = String(req.socket.remoteAddress || '?');
    const lock = adminFails.get(rip);
    if (lock && lock.until > Date.now()) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(Math.ceil((lock.until - Date.now()) / 1000)) });
      return res.end('Zu viele Fehlversuche – bitte später nochmal.');
    }
    if (!adminAuthed(req, url)) {
      // Durchprobieren des Tokens bremsen: 10 Fehlversuche → 10 Minuten Pause
      const f = adminFails.get(rip) || { n: 0, until: 0 };
      f.n++;
      if (f.n >= 10) { f.until = Date.now() + 10 * 60 * 1000; f.n = 0; console.warn('[agent] Admin-UI: zu viele Fehlversuche von ' + rip); }
      adminFails.set(rip, f);
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Token fehlt/falsch — ?token=… oder Authorization: Bearer …');
    }
    if (url.pathname === '/api/duplicates' && ['GET', 'POST'].includes(req.method)) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      if (req.method === 'POST') {
        if (!jellyfin) { res.writeHead(503); return res.end(JSON.stringify({ error: 'Warte auf Jellyfin-Verbindung' })); }
        duplicateScanner.start();
        res.writeHead(202);
      }
      const start = Math.max(0, toInt(url.searchParams.get('start'), 0));
      const limit = Math.max(1, Math.min(100, toInt(url.searchParams.get('limit'), 50)));
      return res.end(JSON.stringify(duplicateScanner.snapshot(start, limit)));
    }
    if (req.method === 'GET' && url.pathname === '/api/libraries') {
      if (!jellyfin) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"Warte auf Jellyfin-Verbindung"}'); }
      try {
        const v = await getViews(true);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          server: jellyfin.serverName,
          libraries: v.items.map((i) => ({ id: i.Id, name: i.Name, type: i.CollectionType || 'unknown', excluded: excluded.has(i.Id) })),
        }));
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/toggle') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 10000) req.destroy(); });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { res.writeHead(400); return res.end('bad json'); }
        const id = String(body.id || '').toLowerCase();
        if (!/^[a-f0-9]{32}$|^[a-f0-9-]{36}$/.test(id)) { res.writeHead(400); return res.end('bad id'); }
        if (body.excluded) excluded.add(id); else excluded.delete(id);
        saveExcluded();
        libCache.clear();
        viewsCache = { ts: 0, ids: new Set(), items: [] };
        console.log('[agent] Ausschluss ' + (body.excluded ? 'aktiviert' : 'aufgehoben') + ': ' + id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, excluded: [...excluded] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  srv.listen(CFG.adminPort, CFG.adminBind, () => {
    const shown = CFG.adminBind === '0.0.0.0' ? '<LAN-IP>' : CFG.adminBind;
    console.log('[agent] Admin-UI: http://' + shown + ':' + CFG.adminPort + (CFG.adminToken ? ' (Token-geschuetzt)' : ' (nur lokal — ADMIN_TOKEN setzen fuer LAN-Zugriff)'));
  });
  srv.on('error', (e) => console.error('[agent] ✖ Admin-UI startet nicht: ' + e.message));
}

const ADMIN_HTML = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watchparty-Agent – Bibliotheken</title>
<style>
:root{color-scheme:dark}body{font:15px/1.5 system-ui;background:#15151b;color:#e8e8ee;margin:0;padding:24px;max-width:640px}
h1{font-size:19px;margin:0 0 4px}.sub{color:#9a9aa8;margin-bottom:18px;font-size:13px}
.card{background:#1d1d25;border:1px solid #2c2c38;border-radius:10px;padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
.card .name{flex:1;font-weight:600}.card .type{color:#9a9aa8;font-size:12px}
.switch{position:relative;width:44px;height:24px;flex:none}.switch input{opacity:0;position:absolute}
.slider{position:absolute;inset:0;background:#3a3a46;border-radius:12px;transition:.15s;cursor:pointer}
.slider:before{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#e8e8ee;transition:.15s}
input:checked+.slider{background:#c0392b}input:checked+.slider:before{transform:translateX(20px)}
.excluded .name{color:#9a9aa8;text-decoration:line-through}
#login{display:flex;gap:8px;margin-bottom:16px}input[type=password]{background:#1d1d25;border:1px solid #2c2c38;color:#e8e8ee;border-radius:8px;padding:8px 10px;width:220px}
button{background:#5b5bd6;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer}
.duplicate{margin:12px 0;padding:10px;background:#1d1d25;border-radius:8px}.source{padding:10px 0;border-top:1px solid #3a3a46;overflow-wrap:anywhere}.type{color:#9a9aa8;font-size:12px}summary{cursor:pointer}h2{font-size:18px}button:disabled{opacity:.5;cursor:wait}
.err{color:#e06c75}.ok{color:#7ec699}
</style></head><body>
<h1>Watchparty-Agent</h1><div class="sub">Bibliotheken, die hier auf <b>aus</b> stehen, sind fuer alle Watchparty-Zuschauer unsichtbar und nicht abspielbar. Wirkt sofort, ohne Neustart.</div>
<div id="login"><input id="tok" type="password" placeholder="Admin-Token"><button onclick="login()">Los</button></div>
<div id="out"></div>
<section id="duplicates" hidden><h2>Duplikate analysieren</h2>
<p class="sub">Vergleicht Jellyfin-Metadaten für Filme und Episoden in allen Bibliotheken, auch ausgeschlossenen. Keine Dateien werden verändert. Gefundene Varianten sind nicht auf Synchronität geprüft.</p>
<button id="scan" onclick="startScan()">Analyse starten</button>
<p id="scan-status" role="status"></p><div id="scan-results"></div>
<button id="scan-prev" hidden onclick="showPage(-1)">Zurück</button>
<button id="scan-next" hidden onclick="showPage(1)">Weitere Ergebnisse</button></section>
<script>
let T=localStorage.getItem('wp_tok')||'';if(T)document.getElementById('tok').value=T;
async function api(p,opt){const r=await fetch(p+(p.includes('?')?'&':'?')+'token='+encodeURIComponent(T),opt);
 if(r.status===401)throw new Error('Token falsch');if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
function login(){T=document.getElementById('tok').value;localStorage.setItem('wp_tok',T);load();}
async function load(){const o=document.getElementById('out');
 try{const d=await api('/api/libraries');
  let h='';if(d.server)h+='<p class="ok">Verbunden mit Jellyfin: '+esc(d.server)+'</p>';
  h+=(d.libraries||[]).map(l=>'<div class="card '+(l.excluded?'excluded':'')+'">'+
   '<label class="switch"><input type="checkbox" '+(l.excluded?'checked':'')+' data-id="'+l.id+'" onchange="toggle(this.dataset.id,this.checked)"><span class="slider"></span></label>'+
   '<span class="name">'+esc(l.name)+'</span><span class="type">'+esc(l.type)+'</span></div>').join('');
  o.innerHTML=h||'<p class="err">Keine Bibliotheken gefunden.</p>';
  document.getElementById('duplicates').hidden=false;scanStatus();
 }catch(e){o.innerHTML='<p class="err">'+e.message+'</p>';}}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function toggle(id,on){try{await api('/api/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,excluded:on})});load();}catch(e){alert(e.message);}}
let scanTimer=null,scanOffset=0;
async function startScan(){
 clearTimeout(scanTimer);scanOffset=0;
 try{await api('/api/duplicates',{method:'POST'});await scanStatus();}
 catch(e){document.getElementById('scan-status').textContent=e.message;}
}
async function scanStatus(){
 clearTimeout(scanTimer);
 const status=document.getElementById('scan-status'),results=document.getElementById('scan-results');
 try{const d=await api('/api/duplicates?start='+scanOffset+'&limit=50');
  document.getElementById('scan').disabled=d.status==='running';
  document.getElementById('scan-prev').hidden=true;document.getElementById('scan-next').hidden=true;
  if(d.status==='running'){
   const p=d.progress;status.textContent='Analysiere '+(p.library||'Bibliotheken')+' … '+p.scanned+' Einträge, '+p.librariesDone+'/'+p.libraries+' Bibliotheken.';
   results.replaceChildren();scanTimer=setTimeout(scanStatus,1500);return;
  }
  if(d.status==='error'){status.textContent='Analyse fehlgeschlagen: '+d.error;results.replaceChildren();return;}
  if(!d.report){status.textContent='Noch keine Analyse gestartet.';return;}
  const r=d.report;status.textContent=r.scannedItems+' Einträge geprüft: '+r.movieGroups+' Filme und '+r.episodeGroups+' Episoden mit mehreren Versionen ('+r.versions+' Quellen).';
  results.innerHTML=r.groups.map(g=>'<details class="duplicate"><summary>'+esc(g.type==='Episode'?(g.seriesName||'Unbekannte Serie')+' · S'+g.season+'E'+g.episode+(g.episodeEnd!==g.episode?'–'+g.episodeEnd:'')+' · '+g.name:g.name+(g.year?' ('+g.year+')':''))+' <span class="type">'+esc(g.availableQualities.join(' / ')||'Qualität unbekannt')+' · '+g.versions.length+' Quellen</span></summary>'+g.versions.map(v=>'<div class="source"><b>'+esc(v.name)+'</b> · '+esc(v.qualities.join(' / ')||'Qualität unbekannt')+' · '+(v.runtime?Math.round(v.runtime/60)+' Min.':'Laufzeit unbekannt')+'<br>'+esc(v.libraryName)+(v.excluded?' (ausgeschlossen)':'')+'<br><code>'+esc(v.path||'Dateipfad nicht verfügbar')+'</code><br>Audio: '+esc(v.audio.map(s=>s.label).join(', ')||'keine Angaben')+'<br>Untertitel: '+esc(v.subtitles.map(s=>s.label+(s.forced?' (Forced)':'')).join(', ')||'keine Angaben')+'</div>').join('')+'</details>').join('');
  document.getElementById('scan-prev').hidden=scanOffset===0;
  document.getElementById('scan-next').hidden=scanOffset+r.groups.length>=r.duplicateGroups;
 }catch(e){status.textContent=e.message;document.getElementById('scan').disabled=false;}
}
function showPage(delta){scanOffset=Math.max(0,scanOffset+delta*50);scanStatus();}
if(T)load();
</script></body></html>`;

/* ---------- Helpers ---------- */
function toInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function toFloat(v, d) { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : d; }
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
function fatal(msg) { console.error(`\n✖ ${msg}\n  Siehe .env.example\n`); process.exit(1); }

startAdmin();
connect();

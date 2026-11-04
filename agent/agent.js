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
const { Readable } = require('stream');
const WebSocket = require('ws');

loadEnvFile(path.join(__dirname, '.env'));

const VERSION = '2.0.0';
const CFG = {
  relayUrl: process.env.RELAY_URL || '',
  token: process.env.AGENT_TOKEN || '',
  jellyfinUrl: (process.env.JELLYFIN_URL || 'http://localhost:8096').replace(/\/+$/, ''),
  apiKey: process.env.JELLYFIN_API_KEY || '',
  jellyfinUser: process.env.JELLYFIN_USER || '',
  maxConcurrent: toInt(process.env.MAX_CONCURRENT, 24),
};
if (!CFG.relayUrl) fatal('RELAY_URL fehlt, z. B. wss://example.com/agent');
if (!/^wss?:\/\//.test(CFG.relayUrl)) fatal('RELAY_URL muss mit wss:// (oder ws:// zum Testen) beginnen');
if (CFG.token.length < 24) fatal('AGENT_TOKEN fehlt oder ist zu kurz (mind. 24 Zeichen, muss exakt wie auf dem Relay sein)');
if (!CFG.apiKey) fatal('JELLYFIN_API_KEY fehlt (Jellyfin → Dashboard → API-Schlüssel)');

const HIGH_WATER = 8 * 1024 * 1024; // so viel darf maximal im Socket-Puffer warten
const LOW_WATER = 2 * 1024 * 1024;

function jfAuth() {
  return `MediaBrowser Client="Watchparty", Device="Watchparty Agent", DeviceId="watchparty-agent", Version="${VERSION}", Token="${CFG.apiKey}"`;
}

async function jfJson(p) {
  const r = await fetch(CFG.jellyfinUrl + p, { headers: { Authorization: jfAuth(), Accept: 'application/json' } });
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

/* ---------- Verbindung zum Relay ---------- */
let ws = null;
let retry = 0;
const streams = new Map(); // id -> { ac, body, relayPaused, wsPaused }

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
      sock.send(JSON.stringify({ t: 'hello', version: VERSION, userId: jellyfin.userId, userName: jellyfin.userName, serverName: jellyfin.serverName, jfVersion: jellyfin.version }));
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
      if (st) { st.relayPaused = true; if (st.body) st.body.pause(); }
      return;
    }
    case 'resume': {
      const st = streams.get(id);
      if (st) { st.relayPaused = false; if (st.body && !st.wsPaused) st.body.resume(); }
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

  const st = { ac: new AbortController(), body: null, relayPaused: false, wsPaused: false };
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

  const out = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = res.headers.get(k);
    if (v) out[k] = v;
  }
  send({ t: 'res', id, status: res.status, headers: out });
  if (!res.body || method === 'HEAD') { streams.delete(id); return send({ t: 'end', id }); }

  const body = Readable.fromWeb(res.body);
  st.body = body;
  if (st.relayPaused) body.pause();
  body.on('data', (chunk) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return body.destroy();
    ws.send(frame(id, chunk));
    if (ws.bufferedAmount > HIGH_WATER && !st.wsPaused) { st.wsPaused = true; body.pause(); }
  });
  body.on('end', () => { if (streams.get(id) === st) { streams.delete(id); send({ t: 'end', id }); } });
  body.on('error', (e) => {
    if (streams.get(id) === st) { streams.delete(id); send({ t: 'err', id, status: 502, message: e.message }); }
  });
}

// Socket-Puffer geleert → pausierte Streams weiterlaufen lassen
setInterval(() => {
  if (!ws || ws.bufferedAmount > LOW_WATER) return;
  for (const st of streams.values()) {
    if (st.wsPaused) { st.wsPaused = false; if (!st.relayPaused && st.body) st.body.resume(); }
  }
}, 25);

/* ---------- Helpers ---------- */
function toInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
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

connect();

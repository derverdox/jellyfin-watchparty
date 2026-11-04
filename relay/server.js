'use strict';
/*
 * Jellyfin Watchparty – Relay
 * Läuft öffentlich (z. B. auf einem Hetzner-Server): Web-Oberfläche, Konten,
 * Räume, Chat und Sync. Videos kommen über einen Tunnel vom Heimserver-Agent
 * und werden hier zwischengespeichert, damit der Heim-Upload jedes Stück nur
 * einmal liefern muss – egal wie viele zuschauen.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Tunnel, TunnelError } = require('./lib/tunnel');
const { DiskCache, TtlCache } = require('./lib/cache');
const { UserStore, SessionStore } = require('./lib/users');
const { GroupStore, allowedByChain, allowedRoots, norm } = require('./lib/access');
const { Telemetry, TICK_MS } = require('./lib/telemetry');
const { handleAdmin } = require('./lib/admin');
const { Guard } = require('./lib/guard');
const { LibraryStore, variants, parseQuery, score } = require('./lib/library');

loadEnvFile(path.join(__dirname, '.env'));

const CONFIG = {
  port: toInt(process.env.PORT, 8097),
  host: process.env.HOST || '0.0.0.0',
  agentToken: process.env.AGENT_TOKEN || '',
  dataDir: path.resolve(__dirname, process.env.DATA_DIR || './data'),
  cacheDir: path.resolve(__dirname, process.env.CACHE_DIR || './cache'),
  cacheBytes: Math.max(0.5, Number(process.env.CACHE_MAX_GB || 10)) * 1024 ** 3,
  trustProxy: process.env.TRUST_PROXY === 'true',
  secureCookies: process.env.SECURE_COOKIES === 'true',
};

const users = new UserStore(CONFIG.dataDir);

/* ---------- Kommandozeile: Benutzer verwalten ---------- */
if (process.argv[2] === 'user' || process.argv[2] === 'invite') {
  runCli(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error('✖', e.message); process.exit(1); });
  return;
}

if (CONFIG.agentToken.length < 24) fatal('AGENT_TOKEN fehlt oder ist zu kurz (mind. 24 Zeichen). Erzeugen z. B. mit: openssl rand -hex 32');

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const sessions = new SessionStore(CONFIG.dataDir, SESSION_TTL);
const tunnel = new Tunnel();
const cache = new DiskCache(CONFIG.cacheDir, CONFIG.cacheBytes);
const groups = new GroupStore(CONFIG.dataDir);
const telemetry = new Telemetry(CONFIG.dataDir);
const library = new LibraryStore(CONFIG.dataDir);
const guard = new Guard(CONFIG.dataDir, (ip, b) => {
  telemetry.audit({ type: 'ip-ban', ip, reason: b.reason, by: b.by === 'auto' ? undefined : b.by });
  telemetry.event('security', `IP ${ip} gesperrt: ${b.reason}`, { level: 'warn' });
  console.warn(`[guard] IP ${ip} gesperrt (${b.reason})`);
});
// Bytes vom Heimserver mitzählen
{
  const onData = tunnel.onData.bind(tunnel);
  tunnel.onData = (buf) => { telemetry.in(buf.length); return onData(buf); };
}
const jsonCache = new TtlCache(60 * 1000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const REACTIONS = ['😂', '😮', '❤️', '👍', '🔥', '😱', '👏', '💀'];
const ID_RE = /^[a-f0-9]{32}$|^[a-f0-9-]{36}$/i;
const CHUNK = 4 * 1024 * 1024;

// Erstes Admin-Konto aus der Umgebung anlegen, falls noch keins existiert
(async () => {
  if (users.count() === 0 && process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
    try {
      await users.create(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD, { admin: true });
      console.log(`[users] Admin "${process.env.ADMIN_USER}" angelegt`);
    } catch (e) { console.error('[users] Admin anlegen fehlgeschlagen:', e.message); }
  } else if (users.count() === 0) {
    console.warn('[users] ⚠ Noch kein Konto! ADMIN_USER/ADMIN_PASSWORD setzen oder: node server.js user add <name> --admin');
  }
})();

/* ------------------------------------------------------------------ */
/* Jellyfin (über den Tunnel)                                          */
/* ------------------------------------------------------------------ */

function uid() {
  if (!tunnel.online) throw new HttpError(503, 'Der Heimserver ist gerade offline');
  return tunnel.info.userId;
}

async function jf(p) {
  try { return await tunnel.json(p); }
  catch (e) { throw new HttpError(e.status || 502, e.message); }
}

const FOLDER_TYPES = new Set(['CollectionFolder', 'Folder', 'Series', 'Season', 'BoxSet', 'UserView', 'Playlist']);
const PLAYABLE_TYPES = new Set(['Movie', 'Episode', 'Video', 'MusicVideo']);

function displayTitle(it) {
  if (it.Type === 'Episode') {
    const s = it.ParentIndexNumber != null ? `S${String(it.ParentIndexNumber).padStart(2, '0')}` : '';
    const e = it.IndexNumber != null ? `E${String(it.IndexNumber).padStart(2, '0')}` : '';
    return { title: it.SeriesName || it.Name, subtitle: `${s}${e}${s || e ? ' · ' : ''}${it.Name}` };
  }
  return { title: it.Name, subtitle: it.ProductionYear ? String(it.ProductionYear) : '' };
}

function mapItem(it) {
  return {
    id: it.Id,
    name: it.Name,
    type: it.Type,
    collectionType: it.CollectionType || null,
    year: it.ProductionYear || null,
    seriesName: it.SeriesName || null,
    index: it.IndexNumber ?? null,
    parentIndex: it.ParentIndexNumber ?? null,
    runtime: it.RunTimeTicks ? it.RunTimeTicks / 1e7 : null,
    aspect: it.PrimaryImageAspectRatio || null,
    hasImage: !!(it.ImageTags && it.ImageTags.Primary),
    isFolder: FOLDER_TYPES.has(it.Type) || (!!it.IsFolder && !PLAYABLE_TYPES.has(it.Type)),
    playable: PLAYABLE_TYPES.has(it.Type),
    played: !!(it.UserData && it.UserData.Played),
    overview: it.Overview ? it.Overview.slice(0, 400) : '',
    originalTitle: it.OriginalTitle && it.OriginalTitle !== it.Name ? it.OriginalTitle : null,
    rating: it.CommunityRating ? Math.round(it.CommunityRating * 10) / 10 : null,
  };
}

const ITEM_FIELDS = 'PrimaryImageAspectRatio,ProductionYear,Overview,OriginalTitle';

function getItemDetails(id) {
  return jsonCache.get(`item|${id}`, async () => {
    const u = uid();
    const it = await jf(`/Users/${u}/Items/${id}`);
    const ms = (it.MediaSources || [])[0];
    if (!ms) throw new HttpError(400, 'Dieses Element hat keine abspielbare Datei');
    const streams = ms.MediaStreams || [];
    const video = streams.find((s) => s.Type === 'Video');
    const audio = streams.filter((s) => s.Type === 'Audio').map((s) => ({
      index: s.Index,
      label: s.DisplayTitle || s.Language || `Spur ${s.Index}`,
      lang: (s.Language || '').toLowerCase(),
      codec: (s.Codec || '').toLowerCase(),
      isDefault: !!s.IsDefault,
    }));
    const subs = streams.filter((s) => s.Type === 'Subtitle').map((s) => ({
      index: s.Index,
      label: s.DisplayTitle || s.Language || `Untertitel ${s.Index}`,
      lang: (s.Language || '').toLowerCase(),
      isDefault: !!s.IsDefault,
      isForced: !!s.IsForced,
      isText: !!s.IsTextSubtitleStream,
    }));
    const containers = (ms.Container || '').toLowerCase().split(',');
    const defAudio = audio.find((a) => a.index === ms.DefaultAudioStreamIndex) || audio[0];
    const directPlayable =
      containers.some((c) => ['mp4', 'm4v', 'mov', 'webm'].includes(c)) &&
      ['h264', 'vp8', 'vp9', 'av1'].includes(((video && video.Codec) || '').toLowerCase()) &&
      (!defAudio || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(defAudio.codec));

    let nextEpisodeId = null;
    if (it.Type === 'Episode' && it.SeriesId) {
      try {
        const eps = await jf(`/Shows/${it.SeriesId}/Episodes?UserId=${u}&Fields=`);
        const list = (eps && eps.Items) || [];
        const i = list.findIndex((e) => e.Id === it.Id);
        if (i >= 0 && list[i + 1]) nextEpisodeId = list[i + 1].Id;
      } catch { /* optional */ }
    }
    return {
      ...mapItem(it),
      ...displayTitle(it),
      mediaSourceId: ms.Id,
      defaultAudioIndex: ms.DefaultAudioStreamIndex ?? (defAudio ? defAudio.index : null),
      defaultSubIndex: ms.DefaultSubtitleStreamIndex ?? -1,
      audio,
      subs,
      directPlayable,
      width: video ? video.Width : null,
      height: video ? video.Height : null,
      bitrate: ms.Bitrate || (video && video.BitRate) || null,
      hdr: !!(video && video.VideoRange && video.VideoRange !== 'SDR'),
      videoCodec: video ? (video.Codec || '').toLowerCase() : null,
      container: ms.Container || null,
      nextEpisodeId,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Sessions & login                                                    */
/* ------------------------------------------------------------------ */


function clientIp(req) {
  if (CONFIG.trustProxy && req.headers['x-forwarded-for']) {
    // Der LETZTE Eintrag stammt vom eigenen Proxy (Caddy); alles davor kann der Client selbst gesetzt haben.
    const parts = String(req.headers['x-forwarded-for']).split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].replace(/^::ffff:/, '');
  }
  return String(req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req) {
  const s = sessions.get(parseCookies(req).wp_sid);
  if (!s) return null;
  const u = users.find(s.username);
  if (!u) { sessions.delete(s.id); return null; } // Konto gelöscht
  if (!users.usable(u)) return null;              // gesperrt oder abgelaufen
  s.admin = !!u.admin;
  s.owner = !!u.owner;
  if (groups.settings.maintenance && !s.admin) return null;
  return s;
}

/** Effektive Rechte eines Kontos (immer frisch, Änderungen im Admin wirken sofort). */
function accessOf(session) {
  return groups.resolve(users.find(session.username));
}

/* ---------- Inhaltszugriff ---------- */
let accessVersion = 0;
const ancestorCache = new TtlCache(10 * 60 * 1000, 20000);
const decisionCache = new TtlCache(5 * 60 * 1000, 20000);
function bumpAccess() { accessVersion++; decisionCache.clear(); }

/** Kette [Element, Eltern, …, Bibliothek] über ParentId. */
function ancestors(id) {
  return ancestorCache.get(norm(id), async () => {
    const it = await jf(`/Users/${uid()}/Items/${id}?Fields=ParentId`);
    const chain = [norm(it.Id || id)];
    if (it.SeriesId) chain.push(norm(it.SeriesId));
    if (it.SeasonId) chain.push(norm(it.SeasonId));
    if (it.ParentId && it.Type !== 'CollectionFolder' && it.Type !== 'AggregateFolder' && it.Type !== 'UserRootFolder') {
      try { chain.push(...(await ancestors(it.ParentId))); } catch { /* Wurzel erreicht */ }
    }
    return [...new Set(chain)];
  });
}

async function canAccess(session, itemId, resolved) {
  const r = resolved || accessOf(session);
  if (!r.rules) return true;
  return decisionCache.get(`${accessVersion}|${session.username.toLowerCase()}|${norm(itemId)}`, async () => {
    try { return allowedByChain(r, await ancestors(itemId)); } catch { return false; }
  });
}

async function assertAccess(session, itemId) {
  if (!(await canAccess(session, itemId))) throw new HttpError(403, 'Darauf hast du keinen Zugriff');
}

/** Liste filtern (parallel, aber gedeckelt). */
async function filterAllowed(session, items) {
  const r = accessOf(session);
  if (!r.rules) return items;
  const keep = new Array(items.length).fill(false);
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < items.length) { const k = i++; keep[k] = await canAccess(session, items[k].Id, r); }
  }));
  return items.filter((_, k) => keep[k]);
}

function isSecure(req) {
  return CONFIG.secureCookies || !!req.socket.encrypted ||
    (CONFIG.trustProxy && String(req.headers['x-forwarded-proto'] || '').startsWith('https'));
}

function sessionCookie(req, sid, maxAge = SESSION_TTL / 1000) {
  return `wp_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
}

function me(s) {
  const a = accessOf(s);
  const st = groups.settings;
  return {
    name: s.name, username: s.username, admin: !!s.admin, owner: !!s.owner, perms: a.perms, maxBitrate: a.maxBitrate,
    restricted: !!a.rules, agentOnline: tunnel.online, server: tunnel.online ? tunnel.info.serverName : null,
    motd: st.motd || '', invitesEnabled: !!st.invitesEnabled, maintenance: !!st.maintenance,
  };
}

/** Alle Verbindungen eines Kontos (oder einer Sitzung) trennen. */
function disconnectUser(username, text, sessionId) {
  const n = String(username).toLowerCase();
  for (const room of rooms.values()) {
    for (const c of [...room.clients.values()]) {
      if (c.session.username.toLowerCase() !== n || (sessionId && c.session.id !== sessionId)) continue;
      try { c.ws.send(JSON.stringify({ t: 'kicked', text })); c.kicked = true; c.ws.close(4001, 'kicked'); } catch { /* egal */ }
    }
  }
}

function closeRoom(code, text) {
  const room = rooms.get(code);
  if (!room) throw new HttpError(404, 'Raum nicht gefunden');
  for (const c of [...room.clients.values()]) {
    try { c.ws.send(JSON.stringify({ t: 'kicked', text })); c.kicked = true; c.ws.close(4001, 'closed'); } catch { /* egal */ }
  }
  rooms.delete(code);
}

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

const rooms = new Map();

function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code, hostSid, createdBy) {
    this.code = code;
    this.hostSid = hostSid;
    this.createdBy = createdBy || null;
    this.createdAt = Date.now();
    this.allowAllControl = true;
    this.clients = new Map(); // clientId -> client
    this.chat = [];
    this.item = null;
    this.playing = false;
    this.position = 0;
    this.updatedAt = Date.now();
    this.seq = 0;
    this.emptySince = Date.now();
    this.hostTimer = null;
    this.membersDirty = false;
  }

  positionAt(now = Date.now()) {
    let p = this.playing ? this.position + (now - this.updatedAt) / 1000 : this.position;
    if (this.item && this.item.runtime && p > this.item.runtime) p = this.item.runtime;
    return Math.max(0, p);
  }

  normalize() {
    // Am Ende angekommen → als pausiert speichern
    if (this.playing && this.item && this.item.runtime && this.positionAt() >= this.item.runtime) {
      this.position = this.item.runtime;
      this.playing = false;
      this.updatedAt = Date.now();
      this.seq++;
    }
  }

  playback() {
    this.normalize();
    return {
      item: this.item,
      playing: this.playing,
      position: this.position,
      updatedAt: this.updatedAt,
      seq: this.seq,
    };
  }

  canControl(sid) {
    return this.allowAllControl || sid === this.hostSid;
  }

  members() {
    const seen = [];
    for (const c of this.clients.values()) {
      seen.push({
        id: c.id,
        name: c.session.name,
        isHost: c.session.id === this.hostSid,
        status: c.status,
        joinedAt: c.joinedAt,
      });
    }
    return seen;
  }

  info() {
    return { code: this.code, hostSid: this.hostSid, allowAllControl: this.allowAllControl };
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c !== except && c.ws.readyState === 1) c.ws.send(data);
    }
  }

  addChat(entry) {
    const msg = { id: crypto.randomBytes(6).toString('hex'), ts: Date.now(), ...entry };
    this.chat.push(msg);
    if (this.chat.length > 200) this.chat.shift();
    this.broadcast({ t: 'chat', msg });
    return msg;
  }

  system(text) {
    return this.addChat({ kind: 'system', text });
  }
}

function roomHasSid(room, sid) {
  for (const c of room.clients.values()) if (c.session.id === sid) return true;
  return false;
}

// Aufräumen: leere Räume nach 30 Minuten löschen, Member-Status regelmäßig verteilen
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && room.emptySince && now - room.emptySince > 30 * 60 * 1000) {
      rooms.delete(code);
      continue;
    }
    if (room.membersDirty) {
      room.membersDirty = false;
      room.broadcast({ t: 'members', members: room.members() });
    }
  }
}, 2000).unref();


/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'Ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function serveFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Eigener Host (für den Origin-Check). */
function ownHosts(req) {
  const fwd = CONFIG.trustProxy && req.headers['x-forwarded-host'];
  return [req.headers.host, fwd].filter(Boolean).map((h) => String(h).split(',')[0].trim().toLowerCase());
}

/** Schutz gegen Cross-Site-Anfragen (CSRF) bei allem, was etwas ändert. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    try { return ownHosts(req).includes(new URL(origin).host.toLowerCase()); } catch { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  return true; // keine Browser-Herkunft (z. B. Desktop-Client, curl)
}

function stripKeys(text) {
  return text.replace(/([?&])(api_key|ApiKey)=[^&\s"]*&?/gi, '$1').replace(/[?&](\r?\n)/g, '$1');
}

function tunnelErr(e) {
  return e instanceof HttpError ? e : new HttpError(e.status && e.status !== 499 ? e.status : 502, e.message);
}

/** Zwischengespeichertes Objekt (Segment, Bild, Untertitel) ausliefern. */
async function serveCached(res, key, upstreamPath, { maxAge = 0, playlist = false } = {}) {
  let r;
  try {
    r = await cache.get(key, async () => {
      const x = await tunnel.buffer(upstreamPath, { timeout: 120000 });
      return { buf: x.buf, meta: { status: x.status, type: x.headers['content-type'] || 'application/octet-stream' }, cacheable: x.status === 200 && !playlist };
    });
  } catch (e) { throw tunnelErr(e); }
  let buf = r.buf;
  if (playlist && r.meta.status === 200) buf = Buffer.from(stripKeys(buf.toString('utf8')));
  telemetry.out(buf.length, !!r.hit);
  res.writeHead(r.meta.status, {
    'Content-Type': playlist ? 'application/vnd.apple.mpegurl' : r.meta.type,
    'Content-Length': buf.length,
    'Cache-Control': maxAge ? `private, max-age=${maxAge}` : 'no-cache',
  });
  res.end(buf);
}

/* ---------- Direktwiedergabe: Datei in 4-MB-Stücken, geteilt & gecacht ---------- */
const fileMeta = new Map(); // item|ms -> { total, type }
const RELAY_DEV = 'watchparty-relay';

function getChunk(itemId, ms, idx) {
  return cache.get(`direct|${itemId}|${ms}|${idx}`, async () => {
    const start = idx * CHUNK;
    const known = fileMeta.get(`${itemId}|${ms}`);
    const end = known ? Math.min(start + CHUNK, known.total) - 1 : start + CHUNK - 1;
    const x = await tunnel.buffer(`/Videos/${itemId}/stream?static=true&MediaSourceId=${ms}&DeviceId=${RELAY_DEV}`, {
      headers: { Range: `bytes=${start}-${end}` }, limit: CHUNK + 65536, timeout: 120000,
    });
    if (x.status !== 206 && x.status !== 200) throw new HttpError(502, `Jellyfin antwortet mit ${x.status}`);
    const m = /\/(\d+)\s*$/.exec(x.headers['content-range'] || '');
    const total = m ? Number(m[1]) : x.buf.length;
    return { buf: x.buf, meta: { total, type: x.headers['content-type'] || 'video/mp4' }, cacheable: true };
  });
}

async function serveDirect(req, res, itemId, ms) {
  const fkey = `${itemId}|${ms}`;
  const rh = req.headers.range;
  const m = rh && /^bytes=(\d*)-(\d*)$/.exec(rh);
  let start = 0, end = null, suffix = null;
  if (m) {
    if (m[1] === '' && m[2] !== '') suffix = Number(m[2]);
    else { start = Number(m[1]) || 0; if (m[2] !== '') end = Number(m[2]); }
  }
  let meta = fileMeta.get(fkey);
  try {
    if (!meta) {
      meta = (await getChunk(itemId, ms, suffix != null ? 0 : Math.floor(start / CHUNK))).meta;
      fileMeta.set(fkey, meta);
    }
  } catch (e) { throw tunnelErr(e); }
  const total = meta.total;
  if (suffix != null) start = Math.max(0, total - suffix);
  if (end == null || end >= total) end = total - 1;
  if (start >= total || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  res.writeHead(rh ? 206 : 200, {
    'Content-Type': meta.type,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-transform',
    ...(rh ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  let closed = false;
  res.on('close', () => { closed = true; });
  const first = Math.floor(start / CHUNK), last = Math.floor(end / CHUNK);
  try {
    for (let i = first; i <= last && !closed; i++) {
      // vorausladen, damit der nächste Teil schon da ist
      for (let k = 1; k <= 2; k++) if (i + k <= last) getChunk(itemId, ms, i + k).catch(() => {});
      const c = await getChunk(itemId, ms, i);
      const base = i * CHUNK;
      const a = Math.max(start, base) - base;
      const b = Math.min(end, base + c.buf.length - 1) - base;
      if (b < a) break;
      telemetry.out(b + 1 - a, !!c.hit);
      if (!res.write(c.buf.subarray(a, b + 1))) {
        await new Promise((r) => { res.once('drain', r); res.once('close', r); });
      }
    }
    res.end();
  } catch {
    res.destroy();
  }
}

const BITRATES = new Set([1500000, 3000000, 6000000, 10000000, 20000000, 40000000]);

/** Transcode-Stufen: Bitrate → Auflösung und Name. */
const TIERS = [
  { br: 40000000, height: 2160, name: '4K' },
  { br: 20000000, height: 1080, name: 'Full HD' },
  { br: 10000000, height: 1080, name: 'Full HD', note: 'sparsam' },
  { br: 6000000, height: 720, name: 'HD' },
  { br: 3000000, height: 480, name: 'SD' },
  { br: 1500000, height: 360, name: 'Mobil' },
];
const TIER_HEIGHT = Object.fromEntries(TIERS.map((t) => [t.br, t.height]));

function resName(h) {
  if (!h) return '';
  if (h >= 1900) return '4K';
  if (h >= 1300) return 'QHD';
  if (h >= 1000) return 'Full HD';
  if (h >= 700) return 'HD';
  return 'SD';
}
function mbitLabel(br) { return `${(br / 1e6).toFixed(br < 10e6 ? 1 : 0).replace('.', ',').replace(',0', '')} Mbit/s`; }

/**
 * Wählbare Qualitäten für eine Datei: nie mehr als das Original hergibt
 * (Bitrate und Auflösung) und nie mehr als die Gruppe darf.
 */
function qualityOptions(d, acc) {
  const out = [];
  const srcH = d.height || 0;
  const srcBr = d.bitrate || 0;
  if (acc.perms.direct) {
    out.push({ id: 'direct', label: `Original · ${[resName(srcH), d.hdr ? 'HDR' : ''].filter(Boolean).join(' ')}${srcBr ? ` · ${mbitLabel(srcBr)}` : ''}`, height: srcH, br: srcBr || null, original: true });
  }
  for (const t of TIERS) {
    if (t.br > acc.maxBitrate) continue;
    if (srcH && t.height > srcH * 1.05) continue;       // nicht hochskalieren
    if (srcBr && t.br >= srcBr * 0.95) continue;         // nicht mehr als das Original
    out.push({ id: String(t.br), label: `${t.name}${t.note ? ` (${t.note})` : ''} · ${mbitLabel(t.br)}`, height: t.height, br: t.br });
  }
  // Ganz ohne Stufe (z. B. sehr kleine Datei, keine Originalqualität erlaubt): kleinste erlaubte nehmen
  if (!out.length) {
    const t = [...TIERS].reverse().find((x) => x.br <= acc.maxBitrate) || TIERS[TIERS.length - 1];
    out.push({ id: String(t.br), label: `${t.name} · ${mbitLabel(t.br)}`, height: t.height, br: t.br });
  }
  return out;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const ip = clientIp(req);
  if (p.startsWith('/api/') || p.startsWith('/stream/') || p.startsWith('/img/') || p.startsWith('/subs/')) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) throw new HttpError(403, 'Anfrage von fremder Seite abgelehnt');
    const ban = guard.banned(ip);
    if (ban) {
      const s = getSession(req);
      if (!(s && s.admin)) throw new HttpError(403, `Deine IP ist gesperrt${ban.until ? ` bis ${new Date(ban.until).toLocaleString('de-DE')}` : ''}.`);
    }
    if (!guard.limit(`req|${ip}`, 1200, 60000)) throw new HttpError(429, 'Zu viele Anfragen – kurz durchatmen.');
  }

  // --- statische Dateien ---
  if (req.method === 'GET' && (p === '/' || /^\/(r|invite)\/[A-Za-z0-9_-]{4,40}\/?$/.test(p))) {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) {
    return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
  }
  if (req.method === 'GET' && p === '/vendor/hls.min.js') {
    const local = path.join(__dirname, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
    if (fs.existsSync(local)) return serveFile(res, local, 'public, max-age=86400');
    res.writeHead(302, { Location: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js' });
    return res.end();
  }
  if (req.method === 'GET' && /^\/[a-z0-9_-]+\.(js|css|svg|png|ico|webmanifest)$/i.test(p)) {
    return serveFile(res, path.join(PUBLIC_DIR, p.slice(1)));
  }
  if (p === '/healthz') return sendJson(res, 200, { ok: true, agent: tunnel.online });

  // --- Login / Registrierung ---
  if (p === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    const username = String(body.username || '').trim().slice(0, 40);
    const chk = guard.checkLogin(ip, username);
    if (!chk.ok) {
      const sec = chk.wait ? Math.ceil(chk.wait / 1000) : null;
      throw new HttpError(429, chk.reason === 'ban' ? 'Zu viele Fehlversuche – deine IP ist vorübergehend gesperrt.'
        : `Zu viele Versuche – bitte ${sec > 90 ? `${Math.ceil(sec / 60)} Minuten` : `${sec} Sekunden`} warten.`);
    }
    const user = await users.verify(username, String(body.password || '').slice(0, 200));
    if (!user) { guard.fail(ip, username); telemetry.login(username, false, ip); throw new HttpError(401, 'Benutzername oder Passwort falsch'); }
    guard.success(ip, username);
    if (!users.usable(user)) {
      telemetry.audit({ type: 'login-blocked', user: user.username, ip });
      throw new HttpError(403, user.disabled ? 'Dieses Konto ist gesperrt.' : 'Dieses Konto ist abgelaufen.');
    }
    if (groups.settings.maintenance && !user.admin) throw new HttpError(503, 'Gerade Wartungsarbeiten – bitte später nochmal versuchen.');
    users.touchLogin(user.username);
    telemetry.login(user.username, true, ip);
    const s = sessions.create(user, { ua: req.headers['user-agent'], ip });
    s.admin = !!user.admin;
    return sendJson(res, 200, me(s), { 'Set-Cookie': sessionCookie(req, s.token) });
  }

  let m;
  if ((m = p.match(/^\/api\/invite\/([A-Za-z0-9_-]{8,40})$/))) {
    if (!guard.limit(`inv|${ip}`, 20, 15 * 60 * 1000)) { guard.fail(ip, '(einladung)'); throw new HttpError(429, 'Zu viele Versuche'); }
    if (req.method === 'GET') return sendJson(res, 200, { valid: users.checkInvite(m[1]) });
    if (req.method === 'POST') {
      const body = await readJson(req);
      let user;
      if (!groups.settings.invitesEnabled) throw new HttpError(403, 'Registrierung ist gerade abgeschaltet');
      try { user = await users.redeemInvite(m[1], String(body.username || '').trim(), body.password || '', [groups.settings.defaultGroup]); }
      catch (e) { throw new HttpError(400, e.message); }
      telemetry.audit({ type: 'register', user: user.username, ip: clientIp(req), via: m[1].slice(0, 6) });
      telemetry.event('register', `${user.username} hat sich per Einladung registriert`, { user: user.username });
      const s = sessions.create(user, { ua: req.headers['user-agent'], ip: clientIp(req) });
      console.log(`[users] "${user.username}" hat sich per Einladung registriert`);
      return sendJson(res, 200, me(s), { 'Set-Cookie': sessionCookie(req, s.token) });
    }
  }

  const session = getSession(req);
  if (p === '/api/me') {
    if (!session) return sendJson(res, 401, { error: 'Nicht angemeldet' });
    return sendJson(res, 200, me(session));
  }
  if (p === '/api/logout' && req.method === 'POST') {
    if (session) sessions.delete(session.id);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // Ab hier nur mit Anmeldung
  if (!session) throw new HttpError(401, 'Nicht angemeldet');

  if (p === '/api/name' && req.method === 'POST') {
    const body = await readJson(req);
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, 'Ungültiger Name');
    session.name = name;
    sessions.dirty = true;
    return sendJson(res, 200, me(session));
  }

  if (p === '/api/password' && req.method === 'POST') {
    const body = await readJson(req);
    if (!(await users.verify(session.username, body.old || ''))) throw new HttpError(400, 'Altes Passwort stimmt nicht');
    try { await users.setPassword(session.username, body.password || ''); }
    catch (e) { throw new HttpError(400, e.message); }
    sessions.deleteForUser(session.username, session.id);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/invites' && req.method === 'POST') {
    if (!session.admin && !accessOf(session).perms.invite) throw new HttpError(403, 'Du darfst keine Einladungen erstellen');
    if (!session.admin && !groups.settings.invitesEnabled) throw new HttpError(403, 'Einladungen sind gerade abgeschaltet');
    const code = users.createInvite(session.username, { hours: 72 });
    telemetry.audit({ type: 'invite-create', by: session.username, code: code.slice(0, 6) });
    return sendJson(res, 200, { code, path: `/invite/${code}`, hours: 72 });
  }

  if (p === '/api/rooms' && req.method === 'POST') {
    if (!accessOf(session).perms.createRoom) throw new HttpError(403, 'Du darfst keine Räume erstellen. Lass dir einen Raum-Link schicken.');
    const max = groups.settings.maxRoomsPerUser;
    if (!session.admin && max) {
      const mine = [...rooms.values()].filter((r) => r.createdBy && r.createdBy.toLowerCase() === session.username.toLowerCase()).length;
      if (mine >= max) throw new HttpError(429, `Du hast schon ${mine} offene Räume (Maximum ${max}).`);
    }
    const code = newRoomCode();
    rooms.set(code, new Room(code, session.id, session.username));
    telemetry.roomCreated(code, session.name);
    return sendJson(res, 200, { code });
  }

  if (p.startsWith('/api/admin/')) {
    if (!session.admin) throw new HttpError(403, 'Nur für Admins');
    return handleAdmin(adminCtx, req, res, url, session);
  }
  if ((m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})$/)) && req.method === 'GET') {
    if (!guard.limit(`room|${session.username.toLowerCase()}`, 30, 60000)) throw new HttpError(429, 'Zu viele Versuche');
    const room = rooms.get(m[1].toUpperCase());
    if (!room) throw new HttpError(404, 'Raum nicht gefunden');
    return sendJson(res, 200, { code: room.code, members: room.clients.size });
  }

  if (p === '/api/stats') {
    if (!session.admin) throw new HttpError(403, 'Nur für Admins');
    return sendJson(res, 200, { agent: tunnel.online ? tunnel.info : null, cache: cache.stats(), rooms: rooms.size });
  }

  // --- Bibliothek ---
  if (p === '/api/libraries') {
    const data = await jsonCache.get('views', () => jf(`/Users/${uid()}/Views`));
    const r = accessOf(session);
    let views = (data.Items || [])
      .filter((v) => !['music', 'books', 'photos', 'livetv', 'playlists'].includes((v.CollectionType || '').toLowerCase()));
    if (r.rules) {
      views = views.filter((v) => allowedByChain(r, [v.Id]));
      // „nur …“-Freigaben unterhalb einer Bibliothek direkt als Einstieg zeigen
      const have = new Set(views.map((v) => norm(v.Id)));
      for (const id of allowedRoots(r) || []) {
        if (have.has(id)) continue;
        try {
          const it = await jsonCache.get(`root|${id}`, () => jf(`/Users/${uid()}/Items/${id}?Fields=${ITEM_FIELDS}`));
          if (await canAccess(session, it.Id, r)) views.push(it);
        } catch { /* gelöscht */ }
      }
    }
    return sendJson(res, 200, { items: views.map(mapItem) });
  }

  if (p === '/api/items') {
    const q = new URLSearchParams();
    q.set('Fields', ITEM_FIELDS);
    q.set('EnableImageTypes', 'Primary');
    q.set('ImageTypeLimit', '1');
    q.set('Limit', String(Math.min(toInt(url.searchParams.get('limit'), 60), 200)));
    q.set('StartIndex', String(Math.max(toInt(url.searchParams.get('start'), 0), 0)));
    const search = (url.searchParams.get('search') || '').trim().slice(0, 100);
    const parentId = url.searchParams.get('parentId');
    if (search) {
      q.set('SearchTerm', search);
      q.set('Recursive', 'true');
      q.set('IncludeItemTypes', 'Movie,Series,Episode,Video');
      q.set('SortBy', 'SortName');
    } else {
      if (!parentId || !ID_RE.test(parentId)) throw new HttpError(400, 'parentId fehlt');
      q.set('ParentId', parentId);
      const sort = url.searchParams.get('sort');
      if (sort === 'index') q.set('SortBy', 'ParentIndexNumber,IndexNumber,SortName');
      else if (sort === 'added') { q.set('SortBy', 'DateCreated,SortName'); q.set('SortOrder', 'Descending,Ascending'); }
      else if (sort === 'year') { q.set('SortBy', 'ProductionYear,SortName'); q.set('SortOrder', 'Descending,Ascending'); }
      else if (sort === 'rating') { q.set('SortBy', 'CommunityRating,SortName'); q.set('SortOrder', 'Descending,Ascending'); }
      else q.set('SortBy', 'SortName');
      const ct = url.searchParams.get('collectionType');
      if (ct === 'movies') { q.set('Recursive', 'true'); q.set('IncludeItemTypes', 'Movie'); }
      if (ct === 'tvshows') { q.set('Recursive', 'true'); q.set('IncludeItemTypes', 'Series'); }
    }
    if (parentId && !search) await assertAccess(session, parentId);
    const data = await jsonCache.get(`items|${q}`, () => jf(`/Users/${uid()}/Items?${q}`));
    const all = data.Items || [];
    const kept = await filterAllowed(session, all);
    return sendJson(res, 200, { items: kept.map(mapItem), total: Math.max(0, (data.TotalRecordCount || 0) - (all.length - kept.length)) });
  }

  // --- Suche: gruppiert, nach Relevanz, tolerant bei Umlauten/ß, mit Jahr ---
  if (p === '/api/search') {
    const raw = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    if (raw.length < 2) return sendJson(res, 200, { movies: [], series: [], episodes: [], query: raw });
    const { text, year } = parseQuery(raw);
    const onlyYear = year && text === String(year);
    const base = { Recursive: 'true', IncludeItemTypes: 'Movie,Series,Episode,BoxSet,Video', Limit: '60', Fields: ITEM_FIELDS, EnableImageTypes: 'Primary', ImageTypeLimit: '1' };
    const queries = onlyYear
      ? [new URLSearchParams({ ...base, IncludeItemTypes: 'Movie,Series', Years: String(year), SortBy: 'CommunityRating,SortName', SortOrder: 'Descending,Ascending' })]
      : variants(text).map((v) => new URLSearchParams({ ...base, SearchTerm: v, ...(year ? { Years: String(year) } : {}) }));
    const results = await Promise.all(queries.map((q) => jsonCache.get(`search|${q}`, () => jf(`/Users/${uid()}/Items?${q}`)).catch(() => ({ Items: [] }))));
    const byId = new Map();
    for (const r of results) for (const it of r.Items || []) if (!byId.has(it.Id)) byId.set(it.Id, it);
    const allowed = await filterAllowed(session, [...byId.values()]);
    const scored = allowed.map((it) => { const mi = mapItem(it); return { ...mi, score: onlyYear ? 50 : score(mi, text, year) }; })
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (b.year || 0) - (a.year || 0));
    const pick = (types, n) => scored.filter((x) => types.includes(x.type)).slice(0, n);
    return sendJson(res, 200, {
      query: raw, year,
      movies: pick(['Movie', 'Video'], 30), series: pick(['Series', 'BoxSet'], 24), episodes: pick(['Episode'], 30),
    });
  }

  // --- Merkliste & Verlauf ---
  if (p === '/api/watchlist' && req.method === 'GET') {
    const out = [];
    for (const e of library.list(session.username).slice(0, 200)) {
      try {
        const it = await jsonCache.get(`li|${e.id}`, () => jf(`/Users/${uid()}/Items/${e.id}?Fields=${ITEM_FIELDS}`));
        if (await canAccess(session, e.id)) out.push({ ...mapItem(it), added: e.added });
      } catch { /* gelöscht oder offline */ }
    }
    return sendJson(res, 200, { items: out });
  }
  if (p === '/api/watchlist' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.itemId || '');
    if (!ID_RE.test(id)) throw new HttpError(400, 'Ungültige ID');
    await assertAccess(session, id);
    const on = body.on !== undefined ? !!body.on : !library.has(session.username, id);
    if (on) library.add(session.username, id); else library.remove(session.username, id);
    return sendJson(res, 200, { on });
  }
  if (p === '/api/history' && req.method === 'GET') {
    const out = [];
    for (const h of library.history(session.username).slice(0, 30)) {
      if (!(await canAccess(session, h.id).catch(() => false))) continue;
      const done = h.runtime ? h.pos / h.runtime : 0;
      out.push({ ...h, progress: Math.round(done * 1000) / 10, finished: done > 0.92 });
    }
    return sendJson(res, 200, { items: out });
  }
  if ((m = p.match(/^\/api\/history(?:\/([a-f0-9-]+))?$/i)) && req.method === 'DELETE') {
    library.clearHistory(session.username, m[1] || null);
    return sendJson(res, 200, { ok: true });
  }

  if ((m = p.match(/^\/api\/item\/([a-f0-9-]+)$/i))) {
    if (!ID_RE.test(m[1])) throw new HttpError(400, 'Ungültige ID');
    await assertAccess(session, m[1]);
    const d = await getItemDetails(m[1]);
    const a = accessOf(session);
    return sendJson(res, 200, {
      ...d, directPlayable: d.directPlayable && a.perms.direct, maxBitrate: a.maxBitrate, allowDirect: a.perms.direct,
      qualities: qualityOptions(d, a), resolution: [resName(d.height), d.hdr ? 'HDR' : ''].filter(Boolean).join(' '),
      inWatchlist: library.has(session.username, d.id),
      resume: (library.history(session.username).find((h) => h.id === d.id) || {}).pos || 0,
    });
  }

  // --- Bilder ---
  if ((m = p.match(/^\/img\/([a-f0-9-]+)$/i))) {
    if (!ID_RE.test(m[1])) throw new HttpError(400, 'Ungültige ID');
    await assertAccess(session, m[1]);
    const type = ['Primary', 'Backdrop', 'Thumb'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'Primary';
    const w = Math.min(Math.max(Math.round(toInt(url.searchParams.get('w'), 300) / 80) * 80, 80), 1920);
    return serveCached(res, `img|${m[1]}|${type}|${w}`, `/Items/${m[1]}/Images/${type}?maxWidth=${w}&quality=85`, { maxAge: 86400 });
  }

  // --- Untertitel als WebVTT ---
  if ((m = p.match(/^\/subs\/([a-f0-9-]+)\/([a-f0-9-]+)\/(\d{1,3})\.vtt$/i))) {
    if (!ID_RE.test(m[1]) || !ID_RE.test(m[2])) throw new HttpError(400, 'Ungültige ID');
    await assertAccess(session, m[1]);
    return serveCached(res, `sub|${m[1]}|${m[2]}|${m[3]}`, `/Videos/${m[1]}/${m[2]}/Subtitles/${m[3]}/Stream.vtt`, { maxAge: 3600 });
  }

  // --- Video-Streams ---
  if ((m = p.match(/^\/stream\/([a-f0-9-]+)\/(.+)$/i))) {
    const [, itemId, sub] = m;
    if (!ID_RE.test(itemId)) throw new HttpError(400, 'Ungültige ID');
    await assertAccess(session, itemId);
    const acc = accessOf(session);
    const sp = url.searchParams;

    if (sub === 'master.m3u8') {
      const ms = sp.get('ms');
      if (!ID_RE.test(ms || '')) throw new HttpError(400, 'Parameter fehlen');
      const br = Math.min(BITRATES.has(toInt(sp.get('br'), 0)) ? toInt(sp.get('br'), 0) : 10000000, acc.maxBitrate);
      const maxH = TIER_HEIGHT[br] || 1080;
      const audio = /^\d{1,3}$/.test(sp.get('audio') || '') ? sp.get('audio') : '';
      const subIdx = /^\d{1,3}$/.test(sp.get('sub') || '') ? sp.get('sub') : '';
      // Alle Zuschauer mit gleichen Einstellungen teilen sich EINEN Transcode
      const variant = crypto.createHash('sha256').update([itemId, ms, br, audio, subIdx].join('|')).digest('hex');
      const q = new URLSearchParams({
        MediaSourceId: ms,
        DeviceId: `wp-${variant.slice(0, 16)}`,
        PlaySessionId: variant.slice(0, 32),
        VideoCodec: 'h264',
        AudioCodec: 'aac,mp3',
        MaxStreamingBitrate: String(br),
        MaxHeight: String(maxH),
        VideoBitrate: String(Math.max(br - 320000, 500000)),
        AudioBitrate: '192000',
        TranscodingMaxAudioChannels: '2',
        SegmentContainer: 'ts',
        MinSegments: '1',
        BreakOnNonKeyFrames: 'True',
        EnableAutoStreamCopy: 'true',
        AllowVideoStreamCopy: 'true',
        AllowAudioStreamCopy: 'true',
      });
      if (audio) q.set('AudioStreamIndex', audio);
      if (subIdx) { q.set('SubtitleStreamIndex', subIdx); q.set('SubtitleMethod', 'Encode'); }
      return serveCached(res, `pl|${variant}|master`, `/Videos/${itemId}/master.m3u8?${q}`, { playlist: true });
    }

    if (sub === 'direct') {
      if (!acc.perms.direct) throw new HttpError(403, 'Originalqualität ist für dich nicht freigeschaltet');
      const ms = sp.get('ms');
      if (!ID_RE.test(ms || '')) throw new HttpError(400, 'Parameter fehlen');
      return serveDirect(req, res, itemId, ms);
    }

    const ps = String(sp.get('PlaySessionId') || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
    const q = new URLSearchParams(sp);
    q.delete('api_key'); q.delete('ApiKey');
    if (/^[A-Za-z0-9_]+\.m3u8$/.test(sub)) {
      return serveCached(res, `pl|${ps}|${sub}|${q}`, `/Videos/${itemId}/${sub}?${q}`, { playlist: true });
    }
    if (/^hls1\/[A-Za-z0-9_]+\/-?\d+\.(ts|mp4|m4s|aac|vtt)$/.test(sub)) {
      // Segment-Schlüssel ohne wechselnde Parameter → geteilter Cache
      return serveCached(res, `seg|${itemId}|${ps}|${sub}`, `/Videos/${itemId}/${sub}?${q}`, { maxAge: 3600 });
    }
    throw new HttpError(404, 'Nicht gefunden');
  }

  if (p === '/api/stop') return sendJson(res, 200, { ok: true }); // Transcodes sind geteilt → Jellyfin räumt selbst auf

  throw new HttpError(404, 'Nicht gefunden');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError || err instanceof TunnelError ? err.status : 500;
    if (status === 500) console.error('[http]', req.method, req.url, err);
    if (!res.headersSent) sendJson(res, status === 499 ? 502 : status, { error: err.message || 'Fehler' });
    else res.destroy();
  });
});

/* ------------------------------------------------------------------ */
/* WebSocket: Sync & Chat                                              */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const reject = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); socket.destroy(); };
  if (url.pathname === '/agent') {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const ha = crypto.createHash('sha256').update(token).digest();
    const hb = crypto.createHash('sha256').update(CONFIG.agentToken).digest();
    if (!token || !crypto.timingSafeEqual(ha, hb)) {
      console.warn(`[tunnel] ⛔ Agent mit falschem Token abgelehnt (${clientIp(req)})`);
      return reject(401, 'Unauthorized');
    }
    return agentWss.handleUpgrade(req, socket, head, (ws) => tunnel.attach(ws, clientIp(req)));
  }
  if (url.pathname !== '/ws') return reject(404, 'Not Found');

  // Schutz gegen Cross-Site-WebSocket-Hijacking
  const origin = req.headers.origin;
  if (origin) {
    try {
      const fwdHost = CONFIG.trustProxy && req.headers['x-forwarded-host'];
      const hosts = [req.headers.host, fwdHost].filter(Boolean).map((h) => String(h).split(',')[0].trim());
      if (!hosts.includes(new URL(origin).host)) return reject(403, 'Forbidden');
    } catch { return reject(403, 'Forbidden'); }
  }

  const session = getSession(req);
  if (!session) return reject(401, 'Unauthorized');
  if (guard.banned(clientIp(req)) && !session.admin) return reject(403, 'Forbidden');
  let open = 0;
  for (const r of rooms.values()) for (const c of r.clients.values()) if (c.session.id === session.id) open++;
  if (open >= 8) return reject(429, 'Too Many Connections');
  if (!guard.limit(`ws|${session.id}`, 30, 60000)) return reject(429, 'Too Many Requests');
  const code = String(url.searchParams.get('room') || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return reject(404, 'Room Not Found');

  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, session, room, req));
});

function onConnection(ws, session, room, req) {
  const ua = String((req && req.headers['user-agent']) || '');
  const client = {
    id: crypto.randomBytes(6).toString('hex'),
    ws,
    session,
    kind: /watchparty-desktop/i.test(ua) ? 'desktop' : /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'web',
    ua: ua.slice(0, 200),
    ip: req ? clientIp(req) : null,
    joinedAt: Date.now(),
    status: { pos: 0, state: 'idle' },
    chatTimes: [],
    statusTimes: [],
    ctrlTimes: [],
    alive: true,
  };
  ws.wpClient = client;

  const firstForSession = !roomHasSid(room, session.id);
  room.clients.set(client.id, client);
  room.emptySince = null;
  if (room.hostSid === session.id && room.hostTimer) { clearTimeout(room.hostTimer); room.hostTimer = null; }
  if (!roomHasSid(room, room.hostSid) && !room.hostTimer) {
    // Host ist weg (z. B. Server-Neustart des Raums) → erster Anwesender übernimmt
    room.hostSid = session.id;
  }

  const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  send({
    t: 'welcome',
    you: { clientId: client.id, sid: session.id.slice(0, 12), name: session.name },
    room: publicRoom(room),
    playback: room.playback(),
    members: room.members(),
    chat: room.chat.slice(-100),
    reactions: REACTIONS,
    agentOnline: tunnel.online,
    server: tunnel.online ? tunnel.info.serverName : null,
    serverNow: Date.now(),
  });
  if (firstForSession) room.system(`${session.name} ist beigetreten`);
  room.broadcast({ t: 'members', members: room.members() });

  ws.on('pong', () => { client.alive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    try {
      switch (msg.t) {
        case 'ping':
          send({ t: 'pong', c: msg.c, s: Date.now() });
          break;

        case 'status': {
          if (!rateOk(client.statusTimes, 20, 10000)) break;
          const pos = Number(msg.pos);
          client.status = {
            pos: Number.isFinite(pos) ? Math.max(0, pos) : 0,
            state: ['playing', 'paused', 'buffering', 'idle', 'blocked', 'error'].includes(msg.state) ? msg.state : 'idle',
            drift: Number.isFinite(Number(msg.drift)) ? Math.round(Number(msg.drift) * 10) / 10 : 0,
          };
          room.membersDirty = true;
          break;
        }

        case 'chat': {
          if (!accessOf(session).perms.chat) { send({ t: 'error', text: 'Chatten ist für dich gerade nicht freigeschaltet.' }); break; }
          const text = String(msg.text || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 500);
          if (!text) break;
          if (!rateOk(client.chatTimes, 6, 4000)) { send({ t: 'error', text: 'Langsam – du schreibst zu schnell.' }); break; }
          room.addChat({ kind: 'user', from: session.name, sid: session.id.slice(0, 12), text });
          break;
        }

        case 'react': {
          if (!REACTIONS.includes(msg.emoji)) break;
          if (!accessOf(session).perms.chat) break;
          if (!rateOk(client.chatTimes, 10, 4000)) break;
          room.broadcast({ t: 'react', emoji: msg.emoji, from: session.name });
          break;
        }

        case 'control': {
          if (!mayControl(room, session)) { send({ t: 'error', text: 'Nur der Host darf gerade steuern.' }); send({ t: 'playback', playback: room.playback() }); break; }
          if (!room.item) break;
          if (!rateOk(client.ctrlTimes, 12, 3000)) break;
          let pos = Number(msg.position);
          if (!Number.isFinite(pos)) pos = room.positionAt();
          pos = Math.max(0, room.item.runtime ? Math.min(pos, room.item.runtime) : pos);
          const was = room.playing;
          if (msg.action === 'play') room.playing = true;
          else if (msg.action === 'pause') room.playing = false;
          else if (msg.action !== 'seek') break;
          room.position = pos;
          room.updatedAt = Date.now();
          room.seq++;
          room.broadcast({ t: 'playback', playback: room.playback(), by: session.name, action: msg.action });
          if (msg.action === 'seek') room.system(`${session.name} ist zu ${fmtTime(pos)} gesprungen`);
          else if (msg.action === 'pause' && was) room.system(`${session.name} hat bei ${fmtTime(pos)} pausiert`);
          else if (msg.action === 'play' && !was) room.system(`${session.name} hat auf Play gedrückt`);
          break;
        }

        case 'load': {
          const isHost = session.id === room.hostSid;
          if (!mayControl(room, session) || (!isHost && !accessOf(session).perms.load)) { send({ t: 'error', text: 'Du darfst gerade nichts auswählen – schlag es lieber vor.' }); break; }
          if (!ID_RE.test(String(msg.itemId || ''))) break;
          if (!rateOk(client.ctrlTimes, 12, 3000)) break;
          if (!(await canAccess(session, msg.itemId))) { send({ t: 'error', text: 'Darauf hast du keinen Zugriff.' }); break; }
          const d = await getItemDetails(msg.itemId);
          if (!d.playable) { send({ t: 'error', text: 'Das kann man nicht abspielen.' }); break; }
          room.item = { id: d.id, title: d.title, subtitle: d.subtitle, type: d.type, runtime: d.runtime, nextEpisodeId: d.nextEpisodeId };
          room.playing = false;
          room.position = 0;
          room.updatedAt = Date.now();
          room.seq++;
          room.broadcast({ t: 'playback', playback: room.playback(), by: session.name, action: 'load' });
          room.system(`${session.name} hat „${d.title}${d.subtitle && d.type === 'Episode' ? ' – ' + d.subtitle : ''}“ ausgewählt`);
          telemetry.itemStarted(room.item, session.name);
          notifyNoAccess(room, d);
          break;
        }

        case 'suggest': {
          if (!ID_RE.test(String(msg.itemId || ''))) break;
          if (!accessOf(session).perms.suggest) { send({ t: 'error', text: 'Vorschläge sind für dich nicht freigeschaltet.' }); break; }
          if (!rateOk(client.chatTimes, 6, 4000)) break;
          if (!(await canAccess(session, msg.itemId))) break;
          const d = await getItemDetails(msg.itemId);
          room.addChat({
            kind: 'suggest', from: session.name, sid: session.id.slice(0, 12),
            text: `${d.title}${d.type === 'Episode' ? ' – ' + d.subtitle : ''}`, itemId: d.id,
          });
          break;
        }

        case 'settings': {
          if (session.id !== room.hostSid) break;
          if (typeof msg.allowAllControl === 'boolean' && msg.allowAllControl !== room.allowAllControl) {
            room.allowAllControl = msg.allowAllControl;
            room.system(msg.allowAllControl ? 'Jetzt dürfen alle steuern' : 'Jetzt steuert nur noch der Host');
          }
          room.broadcast({ t: 'room', room: publicRoom(room), members: room.members() });
          break;
        }

        case 'makeHost': {
          if (session.id !== room.hostSid) break;
          const target = room.clients.get(String(msg.clientId || ''));
          if (!target || target.session.id === room.hostSid) break;
          room.hostSid = target.session.id;
          room.system(`${target.session.name} ist jetzt Host`);
          room.broadcast({ t: 'room', room: publicRoom(room), members: room.members() });
          break;
        }

        case 'kick': {
          if (session.id !== room.hostSid) break;
          const target = room.clients.get(String(msg.clientId || ''));
          if (!target || target.session.id === room.hostSid) break;
          for (const c of [...room.clients.values()]) {
            if (c.session.id === target.session.id) {
              c.ws.send(JSON.stringify({ t: 'kicked' }));
              c.kicked = true;
              c.ws.close(4001, 'kicked');
            }
          }
          room.system(`${target.session.name} wurde entfernt`);
          break;
        }

        case 'rename': {
          const name = cleanName(msg.name);
          if (!name || name === session.name) break;
          const old = session.name;
          session.name = name;
          sessions.dirty = true;
          room.system(`${old} heißt jetzt ${name}`);
          room.broadcast({ t: 'members', members: room.members() });
          break;
        }
      }
    } catch (err) {
      send({ t: 'error', text: err.message || 'Fehler' });
    }
  });

  ws.on('close', () => {
    room.clients.delete(client.id);
    if (!roomHasSid(room, session.id)) {
      room.system(`${session.name} hat den Raum verlassen`);
      if (session.id === room.hostSid && room.clients.size > 0) {
        // kurze Gnadenfrist für Reloads, dann Host weitergeben
        room.hostTimer = setTimeout(() => {
          room.hostTimer = null;
          if (roomHasSid(room, room.hostSid) || room.clients.size === 0) return;
          const next = [...room.clients.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
          room.hostSid = next.session.id;
          room.system(`${next.session.name} ist jetzt Host`);
          room.broadcast({ t: 'room', room: publicRoom(room), members: room.members() });
        }, 20000);
      }
    }
    if (room.clients.size === 0) {
      room.emptySince = Date.now();
      // Niemand schaut mehr → anhalten, damit beim Wiederkommen nichts weitergelaufen ist
      if (room.playing) { room.position = room.positionAt(); room.playing = false; room.updatedAt = Date.now(); room.seq++; }
    }
    room.broadcast({ t: 'members', members: room.members() });
  });
}

/** Steuern: Host immer, sonst nur wenn der Host es erlaubt UND die Gruppe es darf. */
function mayControl(room, session) {
  if (session.id === room.hostSid) return true;
  return room.allowAllControl && accessOf(session).perms.control;
}

/** Wer im Raum den gewählten Film nicht sehen darf, bekommt Bescheid (der Host auch). */
async function notifyNoAccess(room, item) {
  const blocked = new Set();
  for (const c of room.clients.values()) {
    if (await canAccess(c.session, item.id)) continue;
    blocked.add(c.session.name);
    try { c.ws.send(JSON.stringify({ t: 'noaccess', item: { id: item.id, title: item.title } })); } catch { /* egal */ }
  }
  if (blocked.size) room.system(`Kein Zugriff auf diesen Titel: ${[...blocked].join(', ')}`);
}

function publicRoom(room) {
  return { code: room.code, host: room.hostSid.slice(0, 12), allowAllControl: room.allowAllControl };
}

setInterval(() => {
  telemetry.tick(rooms, cache.stats());
  // Fortschritt für „Zuletzt geschaut“
  for (const room of rooms.values()) {
    if (!room.item || !room.playing) continue;
    const pos = room.positionAt();
    for (const c of room.clients.values()) if (c.status && c.status.state === 'playing') library.progress(c.session.username, room.item, pos);
  }
}, TICK_MS).unref();
function shutdown() { telemetry.dirty = true; telemetry.save(); library.flush(true); sessions.flush(true); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const adminCtx = {
  users, sessions, groups, telemetry, rooms, tunnel, cache, jf, uid, readJson, sendJson, HttpError, guard,
  disconnectUser, closeRoom, bumpAccess, mapItem, getItemDetails, publicRoom, fmtTime, ID_RE, ITEM_FIELDS, clientIp,
};

// Tote Verbindungen erkennen
setInterval(() => {
  for (const ws of wss.clients) {
    const client = ws.wpClient;
    if (client) {
      if (!client.alive) { ws.terminate(); continue; }
      client.alive = false;
    }
    try { ws.ping(); } catch { /* egal */ }
  }
}, 25000).unref();

function rateOk(times, max, windowMs) {
  const now = Date.now();
  while (times.length && now - times[0] > windowMs) times.shift();
  if (times.length >= max) return false;
  times.push(now);
  return true;
}


// Status des Heimservers an alle Räume melden
tunnel.on('change', (online) => {
  jsonCache.clear();
  for (const room of rooms.values()) room.broadcast({ t: 'agent', online, server: online ? tunnel.info.serverName : null });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

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

function fatal(msg) {
  console.error(`\n✖ ${msg}\n  Siehe .env.example bzw. README.md\n`);
  process.exit(1);
}

async function ask(question, hidden = false) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else if (!s.includes('\n')) rl.output.write('*'); else rl.output.write('\n'); };
  }
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer;
}

async function askPassword() {
  if (process.env.NEW_PASSWORD) return process.env.NEW_PASSWORD;
  const a = await ask('Passwort: ', true);
  const b = await ask('Nochmal: ', true);
  if (a !== b) throw new Error('Passwörter stimmen nicht überein');
  return a;
}

async function runCli(args) {
  const [cmd, sub, name, ...rest] = args;
  if (cmd === 'invite') {
    const code = users.createInvite('cli', toInt(sub, 72));
    const base = process.env.PUBLIC_URL || (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : 'https://deine-domain');
    console.log(`Einladungslink (gültig ${toInt(sub, 72)} h, einmalig):\n  ${base}/invite/${code}`);
    return;
  }
  switch (sub) {
    case 'add':
      if (!name) throw new Error('Name fehlt: user add <name> [--admin]');
      await users.create(name, await askPassword(), { admin: rest.includes('--admin') });
      console.log(`✔ Benutzer "${name}" angelegt${rest.includes('--admin') ? ' (Admin)' : ''}`);
      return;
    case 'passwd':
      await users.setPassword(name, await askPassword());
      console.log(`✔ Passwort für "${name}" geändert`);
      return;
    case 'del':
      users.remove(name);
      console.log(`✔ Benutzer "${name}" gelöscht`);
      return;
    case 'admin':
      users.setAdmin(name, rest[0] !== 'off');
      console.log(`✔ "${name}" ist ${rest[0] !== 'off' ? 'jetzt' : 'kein'} Admin`);
      return;
    case 'list':
      for (const u of users.list()) console.log(`${u.admin ? '👑' : '  '} ${u.username}  (seit ${new Date(u.created).toLocaleDateString('de-DE')})`);
      if (!users.count()) console.log('(noch keine Benutzer)');
      return;
    default:
      console.log(`Benutzung:
  node server.js user add <name> [--admin]   Benutzer anlegen
  node server.js user passwd <name>          Passwort ändern
  node server.js user del <name>             Benutzer löschen
  node server.js user admin <name> [off]     Admin-Rechte geben/nehmen
  node server.js user list                   Alle Benutzer
  node server.js invite [stunden]            Einladungslink erzeugen`);
  }
}

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`\n🎬 Watchparty-Relay läuft auf Port ${CONFIG.port}`);
  console.log(`   Cache: ${CONFIG.cacheDir} (max. ${(CONFIG.cacheBytes / 1024 ** 3).toFixed(1)} GB)`);
  console.log('   Warte auf den Heimserver-Agent …');
});

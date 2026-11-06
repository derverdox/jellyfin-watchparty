'use strict';
/*
 * Twitch-Restream für Räume.
 *
 * Das Relay holt einen Twitch-Kanal genau EINMAL (mit einem einzigen Zugang,
 * optional dem eigenen Konto per TWITCH_OAUTH) und verteilt dieselben Segmente
 * an alle Zuschauer im Raum. Dazu baut es eine eigene HLS-Playlist mit einem
 * DVR-Fenster (Standard 15 min), in der nur Segmente stehen, die schon komplett
 * auf dem Relay liegen. Dadurch haben alle Zuschauer exakt dieselben Daten zur
 * selben Zeit.
 *
 * Gemeinsame Zeitachse: Jedes Segment trägt #EXT-X-PROGRAM-DATE-TIME (Twitch
 * liefert das mit). Die Position eines Raums ist bei Twitch deshalb ein
 * Zeitstempel in Sekunden (Unix-Zeit des Bildes). Jeder Client rechnet seine
 * lokale Videozeit über diese Zeitstempel um. So gibt es auch bei einem
 * Livestream eine feste Timeline, auf die sich alle synchronisieren.
 */
const crypto = require('crypto');

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // öffentliche Client-ID des Twitch-Webplayers
const LOGIN_RE = /^[a-z0-9_]{2,25}$/;
const RESERVED = new Set(['videos', 'directory', 'p', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'search', 'downloads', 'jobs', 'turbo', 'friends', 'messages', 'payments', 'prime', 'store', 'clips']);

const ACCESS_TOKEN_QUERY = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {'
  + '  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {'
  + '    value    signature   authorization { isForbidden forbiddenReasonCode }   __typename  }'
  + '  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {'
  + '    value    signature   __typename  }}';

class TwitchError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Kanalname aus Link oder Text („twitch.tv/xyz“, „https://www.twitch.tv/xyz?…“, „xyz“). */
function parseChannel(input) {
  const s = String(input || '').trim();
  let login = null;
  const m = /^(?:https?:\/\/)?(?:www\.|m\.|go\.)?twitch\.tv\/([A-Za-z0-9_]+)(?:[/?#]|$)/i.exec(s);
  if (m) login = m[1];
  else if (/^twitch:/i.test(s)) login = s.slice(7);
  if (!login) return null;
  login = login.toLowerCase();
  if (!LOGIN_RE.test(login) || RESERVED.has(login)) return null;
  return login;
}

/* ---------------------------------------------------------------- */
/* M3U8                                                              */
/* ---------------------------------------------------------------- */

function attrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

/** Master-Playlist → Varianten [{ id, name, bandwidth, resolution, fps, codecs, url }]. */
function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const names = {};
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(l.slice(13));
      if (a['GROUP-ID']) names[a['GROUP-ID']] = a.NAME || a['GROUP-ID'];
    } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
      if (j >= lines.length) break;
      const url = new URL(lines[j].trim(), baseUrl).toString();
      const id = a.VIDEO || `v${out.length}`;
      out.push({
        id,
        name: names[id] || a.RESOLUTION || id,
        bandwidth: Number(a.BANDWIDTH) || 0,
        resolution: a.RESOLUTION || null,
        fps: Number(a['FRAME-RATE']) || null,
        codecs: a.CODECS || null,
        url,
      });
      i = j;
    }
  }
  return out;
}

/** Media-Playlist → { targetDuration, mediaSequence, ended, segments: [{ useq, dur, title, pdt, uri, disc, map }] }. */
function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const res = { targetDuration: 2, mediaSequence: 0, ended: false, segments: [], ads: [] };
  let cur = {};
  let map = null;
  let seq = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      if (l.startsWith('#EXT-X-TARGETDURATION:')) res.targetDuration = Number(l.slice(22)) || 2;
      else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { res.mediaSequence = Number(l.slice(22)) || 0; seq = res.mediaSequence; }
      else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { const t = Date.parse(l.slice(25)); if (Number.isFinite(t)) cur.pdt = t; }
      else if (l.startsWith('#EXTINF:')) {
        const body = l.slice(8);
        const k = body.indexOf(',');
        cur.dur = Number(k >= 0 ? body.slice(0, k) : body) || 0;
        cur.title = k >= 0 ? body.slice(k + 1).trim() : '';
      } else if (l === '#EXT-X-DISCONTINUITY') cur.disc = true;
      else if (l.startsWith('#EXT-X-MAP:')) { const a = attrs(l.slice(11)); if (a.URI) map = new URL(a.URI, baseUrl).toString(); }
      else if (l.startsWith('#EXT-X-DATERANGE:')) {
        const a = attrs(l.slice(17));
        const isAd = /stitched-ad|twitch-ad|amazon/i.test(`${a.CLASS || ''} ${a.ID || ''}`);
        const start = Date.parse(a['START-DATE'] || '');
        if (isAd && Number.isFinite(start)) res.ads.push({ start, end: start + (Number(a.DURATION) || Number(a['PLANNED-DURATION']) || 0) * 1000 });
      } else if (l === '#EXT-X-ENDLIST') res.ended = true;
      // #EXT-X-TWITCH-PREFETCH und Co. ignorieren wir bewusst
      continue;
    }
    if (seq === null) seq = 0;
    res.segments.push({ useq: seq, dur: cur.dur || res.targetDuration, title: cur.title || '', pdt: cur.pdt, uri: new URL(l, baseUrl).toString(), disc: !!cur.disc, map });
    seq++;
    cur = {};
  }
  // Fehlende Zeitstempel aus dem Vorgänger ableiten
  for (let i = 1; i < res.segments.length; i++) {
    const s = res.segments[i], p = res.segments[i - 1];
    if (!Number.isFinite(s.pdt) && Number.isFinite(p.pdt)) s.pdt = p.pdt + p.dur * 1000;
  }
  return res;
}

function isAd(seg, ads) {
  if (/amazon|stitched/i.test(seg.title)) return true;
  if (!Number.isFinite(seg.pdt)) return false;
  return ads.some((a) => seg.pdt >= a.start - 50 && seg.pdt < a.end - 50);
}

/* ---------------------------------------------------------------- */
/* Variante: pollt Twitch, holt jedes Segment einmal, baut die Playlist */
/* ---------------------------------------------------------------- */

class Variant {
  constructor(channel, meta) {
    this.channel = channel;
    this.relay = channel.relay;
    this.id = meta.id;
    this.meta = meta;
    this.upstream = meta.url;
    this.gen = crypto.randomBytes(3).toString('hex');
    this.segs = [];            // [{ seq, dur, pdt, disc, key, ext, mapId, state }]
    this.bySeq = new Map();
    this.nextSeq = 1;
    this.lastUseq = -1;
    this.maps = new Map();     // mapId → { key, url }
    this.mapByUrl = new Map();
    this.headDisc = 0;         // weggefallene Diskontinuitäten (für EXT-X-DISCONTINUITY-SEQUENCE)
    this.targetDuration = 2;
    this.pendingDisc = false;
    this.lastUse = Date.now();
    this.errors = 0;
    this.offline = false;
    this.stopped = false;
    this.active = 0;
    this.queue = [];
    this.waiters = [];
    this.timer = null;
    this.poll();
  }

  touch() { this.lastUse = Date.now(); }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const s of this.segs) this.relay.cache.drop(s.key);
    for (const m of this.maps.values()) this.relay.cache.drop(m.key);
    this.segs = [];
    this.bySeq.clear();
    for (const w of this.waiters.splice(0)) w();
  }

  schedule(ms) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), ms);
    if (this.timer.unref) this.timer.unref();
  }

  async poll() {
    if (this.stopped) return;
    if (Date.now() - this.lastUse > this.relay.idleMs) { this.channel.dropVariant(this.id); return; }
    let pl;
    try {
      const r = await this.relay.fetch(this.upstream, { headers: this.relay.headers(false) }, 8000);
      if (r.status === 403 || r.status === 404 || r.status === 410) {
        // Token abgelaufen oder Stream neu gestartet → Master neu holen
        this.errors++;
        const fresh = await this.channel.refreshVariantUrl(this.id).catch(() => null);
        if (fresh) this.upstream = fresh;
        else if (this.errors >= 3) this.offline = true;
        return this.schedule(Math.min(10000, 1000 * this.errors));
      }
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      pl = parseMedia(await r.text(), this.upstream);
    } catch (e) {
      this.errors++;
      if (this.errors >= 15) this.offline = true;
      return this.schedule(Math.min(5000, 500 * this.errors));
    }
    this.errors = 0;
    this.offline = !!pl.ended;
    this.targetDuration = pl.targetDuration;
    this.ingest(pl);
    // Twitch-Playlists ändern sich etwa alle 2 s → etwas öfter nachsehen
    this.schedule(pl.ended ? 5000 : Math.max(500, Math.min(2000, pl.targetDuration * 500)));
  }

  ingest(pl) {
    const segs = pl.segments;
    if (!segs.length) return;
    // Stream neu gestartet (Sequenznummern fangen von vorn an)?
    if (this.lastUseq >= 0 && segs[segs.length - 1].useq < this.lastUseq - 5) { this.lastUseq = -1; this.pendingDisc = true; }
    const fresh = segs.filter((s) => s.useq > this.lastUseq);
    // Beim allerersten Abruf nur die letzten paar Segmente nehmen (sonst fängt das Fenster weit in der Vergangenheit an)
    const take = this.lastUseq < 0 && !this.segs.length ? fresh.slice(-Math.max(3, Math.ceil(this.relay.startWindow / Math.max(1, pl.targetDuration)))) : fresh;
    for (const s of fresh) this.lastUseq = Math.max(this.lastUseq, s.useq);
    for (const s of take) {
      if (isAd(s, pl.ads)) { this.pendingDisc = true; continue; }
      let pdt = s.pdt;
      const prev = this.segs[this.segs.length - 1];
      if (!Number.isFinite(pdt)) pdt = prev ? prev.pdt + prev.dur * 1000 : Date.now() - s.dur * 1000;
      if (prev && pdt < prev.pdt + 1) { this.pendingDisc = true; } // Zeit läuft rückwärts → nicht verwenden
      let mapId = null;
      if (s.map) {
        mapId = this.mapByUrl.get(s.map);
        if (!mapId) {
          mapId = `m${this.maps.size + 1}`;
          this.mapByUrl.set(s.map, mapId);
          const m = { key: `tw|${this.gen}|${this.id}|${mapId}`, url: s.map, ready: null };
          m.ready = this.download(m.key, s.map).catch(() => { m.failed = true; });
          this.maps.set(mapId, m);
        }
      }
      const seq = this.nextSeq++;
      const ext = s.map ? (/\.mp4(\?|$)/i.test(s.uri) ? 'mp4' : 'm4s') : (/\.aac(\?|$)/i.test(s.uri) ? 'aac' : 'ts');
      const seg = { seq, dur: s.dur, pdt, disc: s.disc || this.pendingDisc, key: `tw|${this.gen}|${this.id}|${seq}`, ext, mapId, state: 'pending', uri: s.uri, tries: 0 };
      this.pendingDisc = false;
      this.segs.push(seg);
      this.bySeq.set(seq, seg);
      this.enqueue(seg);
    }
    this.trim();
  }

  enqueue(seg) {
    this.queue.push(seg);
    this.pump();
  }

  pump() {
    while (this.active < 4 && this.queue.length) {
      const seg = this.queue.shift();
      if (seg.state !== 'pending' || this.stopped) continue;
      this.active++;
      this.fetchSeg(seg).finally(() => { this.active--; this.pump(); });
    }
  }

  async fetchSeg(seg) {
    try {
      if (seg.mapId) { const m = this.maps.get(seg.mapId); if (m && m.ready) await m.ready; }
      await this.download(seg.key, seg.uri);
      seg.state = 'ready';
    } catch {
      seg.tries++;
      if (seg.tries < 3 && !this.stopped) { await new Promise((r) => setTimeout(r, 400 * seg.tries)); return this.fetchSeg(seg); }
      seg.state = 'failed';
    }
    for (const w of this.waiters.splice(0)) w();
  }

  async download(key, uri) {
    const r = await this.relay.fetch(uri, { headers: this.relay.headers(false) }, 15000);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    this.relay.bytesIn += buf.length;
    await this.relay.cache.write(key, buf, { type: r.headers.get('content-type') || 'video/mp2t' });
    if (!this.relay.cache.index.has(key)) this.relay.mem.set(key, buf); // zu groß für den Cache → im Speicher halten
  }

  trim() {
    const newest = this.segs.length ? this.segs[this.segs.length - 1] : null;
    if (!newest) return;
    const minPdt = newest.pdt - this.relay.dvrMs;
    while (this.segs.length > 3 && this.segs[0].pdt < minPdt) {
      const s = this.segs.shift();
      this.bySeq.delete(s.seq);
      if (s.disc) this.headDisc++;
      this.relay.cache.drop(s.key);
      this.relay.mem.delete(s.key);
    }
  }

  /** Nur fertige Segmente, lückenlos vom Anfang bis zum ersten noch fehlenden. Fehlgeschlagene werden übersprungen. */
  readySegments() {
    const out = [];
    let disc = false;
    for (const s of this.segs) {
      if (s.state === 'pending') break;
      if (s.state === 'failed') { disc = true; continue; }
      out.push(disc ? { ...s, disc: true } : s);
      disc = false;
    }
    return out;
  }

  /** Zeitfenster der fertigen Segmente in ms: { start, end } oder null. */
  window() {
    const r = this.readySegments();
    if (!r.length) return null;
    const last = r[r.length - 1];
    return { start: r[0].pdt, end: last.pdt + last.dur * 1000 };
  }

  playlist(base) {
    const r = this.readySegments();
    const out = ['#EXTM3U', `#EXT-X-VERSION:${this.maps.size ? 6 : 3}`, `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(this.targetDuration, ...r.map((s) => s.dur))))}`];
    out.push(`#EXT-X-MEDIA-SEQUENCE:${r.length ? r[0].seq : this.nextSeq}`);
    out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${this.headDisc}`);
    let curMap = null;
    for (let i = 0; i < r.length; i++) {
      const s = r[i];
      if (s.disc && i > 0) out.push('#EXT-X-DISCONTINUITY');
      if (s.mapId && s.mapId !== curMap) { out.push(`#EXT-X-MAP:URI="${base}/init-${s.mapId}.mp4"`); curMap = s.mapId; }
      out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.pdt).toISOString()}`);
      out.push(`#EXTINF:${s.dur.toFixed(3)},`);
      out.push(`${base}/${s.seq}.${s.ext}`);
    }
    if (this.offline && r.length && r.length === this.segs.length) out.push('#EXT-X-ENDLIST');
    return `${out.join('\n')}\n`;
  }

  async segment(seq) {
    const s = this.bySeq.get(seq);
    if (!s) return null;
    if (s.state === 'pending') await this.waitFor(() => s.state !== 'pending', 15000);
    if (s.state !== 'ready') return null;
    return this.relay.read(s.key);
  }

  async init(mapId) {
    const m = this.maps.get(mapId);
    if (!m) return null;
    await m.ready;
    return m.failed ? null : this.relay.read(m.key);
  }

  waitFor(cond, ms) {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      let done = false;
      let timer = null;
      const check = () => {
        if (done) return;
        if (cond() || this.stopped || Date.now() > end) { done = true; clearTimeout(timer); return resolve(); }
        this.waiters.push(check);
        clearTimeout(timer);
        timer = setTimeout(check, Math.min(250, Math.max(1, end - Date.now())));
      };
      check();
    });
  }
}

/* ---------------------------------------------------------------- */
/* Kanal: Zugangstoken + Master-Playlist, Varianten bei Bedarf        */
/* ---------------------------------------------------------------- */

class Channel {
  constructor(relay, login) {
    this.relay = relay;
    this.login = login;
    this.variants = [];      // aus der Master-Playlist
    this.active = new Map(); // id → Variant
    this.masterAt = 0;
    this.masterPromise = null;
    this.lastUse = Date.now();
  }

  touch() { this.lastUse = Date.now(); }

  async master(force = false) {
    if (!force && this.variants.length && Date.now() - this.masterAt < 5 * 60 * 1000) return this.variants;
    if (!this.masterPromise) {
      this.masterPromise = this.relay.fetchMaster(this.login)
        .then((v) => { this.variants = v; this.masterAt = Date.now(); return v; })
        .finally(() => { this.masterPromise = null; });
    }
    return this.masterPromise;
  }

  async refreshVariantUrl(id) {
    const v = await this.master(true);
    const m = v.find((x) => x.id === id);
    return m ? m.url : null;
  }

  /** Beste Variante, die Browser abspielen können (H.264). */
  defaultId() {
    const usable = this.variants.filter((v) => v.id !== 'audio_only' && !/hev|hvc|av01/i.test(v.codecs || ''));
    const src = usable.find((v) => v.id === 'chunked') || usable.sort((a, b) => b.bandwidth - a.bandwidth)[0] || this.variants[0];
    return src ? src.id : null;
  }

  async variant(id) {
    this.touch();
    if (this.active.has(id)) { const v = this.active.get(id); v.touch(); return v; }
    const list = await this.master();
    const meta = list.find((x) => x.id === id);
    if (!meta) return null;
    if (this.active.has(id)) return this.active.get(id);
    const v = new Variant(this, meta);
    this.active.set(id, v);
    return v;
  }

  dropVariant(id) {
    const v = this.active.get(id);
    if (v) { v.stop(); this.active.delete(id); }
    if (!this.active.size && Date.now() - this.lastUse > this.relay.idleMs) this.relay.channels.delete(this.login);
  }

  /** Gemeinsames Zeitfenster über alle aktiven Varianten (Zeitstempel sind bei Twitch für alle gleich). */
  window() {
    let best = null;
    for (const v of this.active.values()) {
      const w = v.window();
      if (w && (!best || w.end > best.end)) best = w;
    }
    return best;
  }

  get offline() {
    const vs = [...this.active.values()];
    return vs.length > 0 && vs.every((v) => v.offline);
  }
}

class TwitchRelay {
  /**
   * @param {object} o
   * @param {DiskCache} o.cache
   * @param {string} [o.oauth]  OAuth-Token eines Twitch-Kontos (ohne „OAuth “) – optional, z. B. für Turbo/Abo ohne Werbung
   */
  constructor({ cache, oauth = '', dvrSeconds = 900, delaySeconds = 4, idleSeconds = 90, gqlUrl, usherUrl, fetchImpl } = {}) {
    this.cache = cache;
    this.oauth = String(oauth || '').replace(/^oauth[: ]+/i, '').trim();
    this.dvrMs = dvrSeconds * 1000;
    this.delay = delaySeconds;
    this.idleMs = idleSeconds * 1000;
    this.startWindow = 12; // Sekunden, die beim Start sofort zur Verfügung stehen
    this.gqlUrl = gqlUrl || 'https://gql.twitch.tv/gql';
    this.usherUrl = usherUrl || 'https://usher.ttvnw.net';
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.channels = new Map();
    this.mem = new Map();
    this.bytesIn = 0;
    this.infoCache = new Map();
  }

  headers(gql) {
    const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
    if (gql) {
      h['Client-ID'] = CLIENT_ID;
      h['Content-Type'] = 'text/plain;charset=UTF-8';
      if (this.oauth) h.Authorization = `OAuth ${this.oauth}`;
    }
    return h;
  }

  async fetch(url, opts = {}, timeout = 10000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try { return await this.fetchImpl(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
  }

  async gql(body) {
    const r = await this.fetch(this.gqlUrl, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) }, 10000);
    if (r.status === 401) throw new TwitchError(502, 'TWITCH_OAUTH ist ungültig oder abgelaufen');
    if (r.status !== 200) throw new TwitchError(502, `Twitch antwortet mit ${r.status}`);
    return r.json();
  }

  async accessToken(login) {
    const j = await this.gql({ operationName: 'PlaybackAccessToken_Template', query: ACCESS_TOKEN_QUERY, variables: { isLive: true, login, isVod: false, vodID: '', playerType: 'site' } });
    const t = j && j.data && j.data.streamPlaybackAccessToken;
    if (!t || !t.value) throw new TwitchError(404, 'Kanal nicht gefunden');
    if (t.authorization && t.authorization.isForbidden) throw new TwitchError(403, `Twitch verweigert den Stream (${t.authorization.forbiddenReasonCode || 'gesperrt'})`);
    return t;
  }

  async fetchMaster(login) {
    const t = await this.accessToken(login);
    const q = new URLSearchParams({
      player: 'twitchweb', p: String(Math.floor(Math.random() * 1e7)), type: 'any',
      allow_source: 'true', allow_audio_only: 'true', allow_spectre: 'false', fast_bread: 'true',
      playlist_include_framerate: 'true', supported_codecs: 'avc1', sig: t.signature, token: t.value,
    });
    const url = `${this.usherUrl}/api/channel/hls/${login}.m3u8?${q}`;
    const r = await this.fetch(url, { headers: this.headers(false) }, 10000);
    if (r.status === 404) throw new TwitchError(404, 'Der Kanal ist gerade nicht live');
    if (r.status === 403) throw new TwitchError(403, 'Twitch verweigert den Stream (Region/Altersfreigabe?)');
    if (r.status !== 200) throw new TwitchError(502, `Twitch antwortet mit ${r.status}`);
    const v = parseMaster(await r.text(), url);
    if (!v.length) throw new TwitchError(502, 'Twitch hat keine Qualitäten geliefert');
    return v;
  }

  /** Titel & Co. (best effort – klappt das nicht, reicht der Kanalname). */
  async info(login) {
    const c = this.infoCache.get(login);
    if (c && Date.now() - c.t < 60000) return c.v;
    let v = { login, displayName: login, title: '', game: '', avatar: null };
    try {
      const q = `query { user(login: ${JSON.stringify(login)}) { displayName profileImageURL(width: 70) broadcastSettings { title } stream { type game { displayName } } } }`;
      const j = await this.gql({ query: q });
      const u = j && j.data && j.data.user;
      if (u) v = { login, displayName: u.displayName || login, title: (u.broadcastSettings && u.broadcastSettings.title) || '', game: (u.stream && u.stream.game && u.stream.game.displayName) || '', avatar: u.profileImageURL || null, live: !!u.stream };
    } catch { /* egal */ }
    this.infoCache.set(login, { t: Date.now(), v });
    return v;
  }

  channel(login) {
    if (!this.channels.has(login)) this.channels.set(login, new Channel(this, login));
    const c = this.channels.get(login);
    c.touch();
    return c;
  }

  /**
   * Kanal für einen Raum öffnen: Master holen, Standardvariante starten und warten,
   * bis die ersten Segmente da sind. → { variants, defaultId, window }
   */
  async open(login, waitMs = 12000) {
    const ch = this.channel(login);
    await ch.master();
    const id = ch.defaultId();
    const v = await ch.variant(id);
    await v.waitFor(() => v.readySegments().length >= 2 || v.offline, waitMs);
    if (!v.readySegments().length) throw new TwitchError(504, v.offline ? 'Der Kanal ist gerade nicht live' : 'Twitch liefert gerade keine Daten');
    return { variants: ch.variants, defaultId: id, window: ch.window() };
  }

  /** Raum-Position, die gerade „live“ ist (etwas hinter der Kante, damit alle puffern können). */
  liveTarget(login) {
    const ch = this.channels.get(login);
    const w = ch && ch.window();
    if (!w) return null;
    return Math.max(w.start, w.end - this.delay * 1000) / 1000;
  }

  window(login) {
    const ch = this.channels.get(login);
    return ch ? ch.window() : null;
  }

  keepAlive(login) {
    const ch = this.channels.get(login);
    if (!ch) return;
    ch.touch();
    for (const v of ch.active.values()) v.touch();
  }

  async read(key) {
    if (this.mem.has(key)) return { buf: this.mem.get(key), meta: { type: 'video/mp2t' } };
    return this.cache.read(key);
  }

  stats() {
    let segs = 0;
    for (const c of this.channels.values()) for (const v of c.active.values()) segs += v.segs.length;
    return { channels: this.channels.size, segments: segs, bytesIn: this.bytesIn };
  }
}

module.exports = { TwitchRelay, TwitchError, parseChannel, parseMaster, parseMedia, CLIENT_ID };

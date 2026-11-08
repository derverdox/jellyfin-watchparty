'use strict';
/*
 * Idle-Readahead: Fragt ein Zuschauer ein HLS-Segment an, holt das Relay die
 * darauf folgenden Segmente schon einmal in den eigenen Cache — markiert als
 * Vorabruf (low), damit der Agent im Heimnetz die Wiedergabe immer vorlässt.
 * So liegt die Leitung selten brach, Seeks laufen häufiger aus dem Cache,
 * und neue Zuschauer starten schneller.
 *
 * Der Relay lernt die Segmentfolge aus der HLS-Medien-Playlist des laufenden
 * Transcodes. Die Sprungzahl im Dateinamen (Ticks) ist monoton steigend und
 * identifiziert die Position; ein Seek verankert das Fenster am neuen Punkt.
 * Bei einem Agenten ohne Prioritäts-Unterstützung (< 2.5.0) bleibt der
 * Vorabruf abgeschaltet — ungesteuertes Nachladen würde sonst die Wiedergabe
 * verdrängen.
 */
const SEG_PATH = /^hls1\/[A-Za-z0-9_]+\/-?\d+\.(?:ts|mp4|m4s|aac)$/;

function parsePlaylist(body) {
  const segs = [];
  for (const line of String(body).split(/\r?\n/)) {
    const uri = line.trim();
    if (!SEG_PATH.test(uri)) continue;
    const m = /\/(-?\d+)\.(?:ts|mp4|m4s|aac)$/.exec(uri);
    if (m) segs.push({ sub: uri, ticks: Number(m[1]) });
  }
  return segs;
}

class Readahead {
  constructor(cache, tunnel, { segments = 8, ahead = 2, max = 3, ttlMs = 5 * 60000 } = {}) {
    this.cache = cache;
    this.tunnel = tunnel;
    this.segments = Math.max(0, segments);
    this.ahead = Math.max(0, ahead);
    this.max = Math.max(1, max);
    this.ttl = ttlMs;
    this.playlists = new Map(); // itemId|ps|sub -> { segs, at }
    this.active = new Set(); // Segment-Cache-Keys laufender Vorabrufe
    this.stats = { sessions: 0, queued: 0, done: 0, failed: 0, bytes: 0 };
    setInterval(() => this.gc(), 60000).unref();
  }

  /** Dasselbe Format wie die Relay-Route: Version >= 2.5 kennt das low-Flag. */
  agentReady(info) {
    const v = String((info && info.agentVersion) || '').split('.');
    const maj = Number(v[0]) || 0;
    const min = Number(v[1]) || 0;
    return maj > 2 || (maj === 2 && min >= 5);
  }

  /** Medien-Playlist merken, damit die Segmentfolge bekannt ist. */
  notePlaylist(itemId, ps, sub, body) {
    if (!this.segments) return;
    const segs = parsePlaylist(body);
    if (segs.length < 2) return;
    const key = `${itemId}|${ps}|${sub}`;
    let e = this.playlists.get(key);
    if (e && e.segs.length === segs.length && e.segs[0].sub === segs[0].sub) {
      e.at = Date.now(); // identische Playlist (Cache-Treffer) — nur Frist verlängern
      return;
    }
    if (e) { // neue Transcode-Variante unter gleichem ps: alte Fenster laufen aus (TTL-räumt)
      this.playlists.delete(key);
    }
    this.playlists.set(key, { segs, at: Date.now() });
    this.stats.sessions = this.playlists.size;
  }

  /** Läuft ein Segment-Request für (itemId, ps): Vorabrufe am Segment neu aufhängen. */
  touch(itemId, ps, sub, query) {
    if (!this.segments) return;
    const key = `${itemId}|${ps}|${sub}`;
    let e = this.playlists.get(key);
    if (!e) {
      // Playlist-Sub konnte sich unterscheiden (z. B. andere Parameterreihenfolge) —
      // erster Treffer zur selben Datei reicht als Segmentfolge.
      for (const k of this.playlists.keys()) if (k.startsWith(`${itemId}|${ps}|`)) { e = this.playlists.get(k); break; }
    }
    if (!e) return;
    const m = /\/(-?\d+)\.(?:ts|mp4|m4s|aac)$/.exec(sub);
    if (!m) return;
    const ticks = Number(m[1]);
    const idx = e.segs.findIndex((s) => s.ticks === ticks);
    if (idx < 0) return;
    e.at = Date.now();
    e.ctx = { idx, itemId, ps, query };
    // Der Player holt sein Segment selbst (oder hängt sich an einen laufenden
    // Vorabruf desselben Segments — teilen statt verdoppeln, bewusst so gewollt).
    this.pump(e, idx, itemId, ps, query);
  }

  pump(e, idx, itemId, ps, query) {
    const from = idx + 1 + this.ahead;
    const to = Math.min(e.segs.length, from + this.segments);
    for (let i = from; i < to && this.active.size < this.max; i++) {
      const segSub = e.segs[i].sub;
      const cacheKey = `seg|${itemId}|${ps}|${segSub}`;
      if (this.active.has(cacheKey) || this.cache.index.has(cacheKey) || this.cache.inflight.has(cacheKey)) continue;
      this.active.add(cacheKey);
      this.stats.queued++;
      this.fetchSegment(itemId, ps, segSub, query)
        .then((n) => { this.stats.done++; this.stats.bytes += n; })
        .catch(() => { this.stats.failed++; })
        .finally(() => {
          this.active.delete(cacheKey);
          // Fenster nachschieben, bis es voll ist (max-begrenzt parallel)
          if (e.ctx) this.pump(e, e.ctx.idx, e.ctx.itemId, e.ctx.ps, e.ctx.query);
        });
    }
  }

  async fetchSegment(itemId, ps, segSub, query) {
    const cacheKey = `seg|${itemId}|${ps}|${segSub}`;
    const r = await this.cache.get(cacheKey, async () => {
      const x = await this.tunnel.buffer(`/Videos/${itemId}/${segSub}${query ? `?${query}` : ''}`, {
        low: true, limit: 32 * 1024 * 1024, timeout: 120000,
      });
      if (x.status !== 200) throw new Error(`Jellyfin antwortet mit ${x.status}`);
      return { buf: x.buf, meta: { status: x.status, type: x.headers['content-type'] || 'application/octet-stream' }, cacheable: true };
    });
    return r.buf.length;
  }

  snapshot() {
    return { enabled: this.segments > 0, sessions: this.playlists.size, active: this.active.size, ...this.stats };
  }

  gc() {
    const now = Date.now();
    for (const [k, e] of this.playlists) if (now - e.at > this.ttl) this.playlists.delete(k);
    this.stats.sessions = this.playlists.size;
  }
}

module.exports = { Readahead, parsePlaylist };

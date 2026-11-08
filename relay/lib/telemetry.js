'use strict';
/*
 * Telemetrie für das Admin-Dashboard:
 *  - Traffic (zu den Zuschauern / vom Heimserver), Cache-Ersparnis
 *  - Zeitreihen: letzte Stunde (10-s-Raster) und letzte 7 Tage (5-min-Raster)
 *  - Watchtime pro Konto und pro Film, Tageswerte (60 Tage), Rekorde
 *  - Server-Gesundheit (CPU, RAM, Event-Loop-Verzögerung)
 *  - Aktivitäts-Feed und Protokoll (Datei audit.jsonl)
 * Persistente Werte liegen in stats.json und überleben Neustarts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const TICK_MS = 10000;
const HOUR_POINTS = 360;       // 1 h in 10-s-Schritten
const WEEK_STEP = 5 * 60000;   // 5 min
const WEEK_POINTS = 7 * 24 * 12;
const DAYS_KEPT = 60;

function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class Telemetry {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'stats.json');
    this.auditFile = path.join(dir, 'audit.jsonl');
    this.started = Date.now();
    this.bytesOut = 0;        // an Zuschauer ausgeliefert
    this.bytesIn = 0;         // vom Heimserver gekommen
    this.bytesFromCache = 0;  // aus dem Cache ausgeliefert (= gesparter Heim-Upload)
    this.requests = 0;
    this.errors = 0;
    this.last = { t: Date.now(), out: 0, in: 0 };
    this.rate = { out: 0, in: 0 };
    this.hour = [];
    this.week = [];
    this.feed = [];
    // Live-Auslieferung pro Client-Verbindung (sid -> { name, kind, stream, bytes, at })
    this.clientBytes = new Map();
    this.clientsNow = [];
    this.loopRes = 10;
    this.loop = monitorEventLoopDelay({ resolution: this.loopRes });
    this.loop.enable();
    this.cpu = { usage: process.cpuUsage(), t: process.hrtime.bigint(), pct: 0 };
    this.persist = this.load();
    this.dirty = false;
    this.lastWeekPush = 0;
    setInterval(() => this.save(), 60000).unref();
  }

  load() {
    const def = { users: {}, items: {}, days: {}, peak: { viewers: 0, at: null }, totals: { bytesOut: 0, bytesFromCache: 0, watchSeconds: 0 }, week: [] };
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const out = { ...def, ...d, totals: { ...def.totals, ...(d.totals || {}) } };
      this.week = Array.isArray(d.week) ? d.week.slice(-WEEK_POINTS) : [];
      return out;
    } catch { return def; }
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    const keep = Object.keys(this.persist.days).sort().slice(-DAYS_KEPT);
    this.persist.days = Object.fromEntries(keep.map((k) => [k, this.persist.days[k]]));
    const items = Object.entries(this.persist.items);
    if (items.length > 2000) this.persist.items = Object.fromEntries(items.sort((a, b) => b[1].lastPlayed - a[1].lastPlayed).slice(0, 2000));
    const data = { ...this.persist, week: this.week };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[stats] nicht gespeichert:', e.message); }
  }

  day() {
    const k = dayKey();
    let d = this.persist.days[k];
    if (!d) d = this.persist.days[k] = { watchSeconds: 0, peakViewers: 0, logins: 0, failedLogins: 0, users: [], rooms: 0, starts: 0, bytesOut: 0 };
    return d;
  }

  /* ---------- Zähler ---------- */

  out(n, fromCache) {
    this.bytesOut += n;
    this.persist.totals.bytesOut += n;
    this.day().bytesOut += n;
    if (fromCache) { this.bytesFromCache += n; this.persist.totals.bytesFromCache += n; }
    this.dirty = true;
  }
  in(n) { this.bytesIn += n; }

  /**
   * Auslieferung einer konkreten Client-Verbindung (für die Live-Tabelle im
   * Dashboard). session = Relay-Session (wp_sid), stream = Kurzlabel der Art
   * ('HLS-Segment', 'Direkt', 'Twitch', 'Bilder' …).
   */
  clientOut(n, session, stream) {
    if (!session || !session.id || !(n > 0)) return;
    let e = this.clientBytes.get(session.id);
    if (!e) {
      const ua = String(session.ua || '');
      const kind = /watchparty-desktop/i.test(ua) ? 'desktop' : /WatchpartyTV|okhttp/i.test(ua) ? 'tv' : /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'web';
      e = { name: session.name || session.username, kind, stream: '', bytes: 0, rate: 0, at: 0 };
      this.clientBytes.set(session.id, e);
    }
    e.bytes += n;
    if (stream) e.stream = stream;
    e.at = Date.now();
  }

  /** Aktuelle Auslieferungsraten (10-s-Fenster), sortiert — fürs Admin-Dashboard. */
  clients() { return this.clientsNow; }

  login(username, ok, ip) {
    const d = this.day();
    if (ok) {
      d.logins++;
      if (!d.users.includes(username)) d.users.push(username);
      const u = this.user(username);
      u.logins = (u.logins || 0) + 1;
      this.event('login', `${username} hat sich angemeldet`, { user: username });
    } else {
      d.failedLogins++;
      this.event('login-failed', `Fehlgeschlagene Anmeldung als „${username}“`, { user: username, ip, level: 'warn' });
    }
    this.audit({ type: ok ? 'login' : 'login-failed', user: username, ip });
    this.dirty = true;
  }

  user(name) {
    const k = String(name).toLowerCase();
    if (!this.persist.users[k]) this.persist.users[k] = { name, watchSeconds: 0, lastWatched: null, lastItem: null, logins: 0 };
    return this.persist.users[k];
  }

  itemStarted(item, by) {
    const it = this.item(item);
    it.starts++;
    it.lastPlayed = Date.now();
    this.day().starts++;
    this.event('play', `${by} startet „${item.title}${item.subtitle && item.type === 'Episode' ? ` – ${item.subtitle}` : ''}“`, { user: by });
    this.dirty = true;
  }

  item(item) {
    if (!this.persist.items[item.id]) this.persist.items[item.id] = { title: item.title, subtitle: item.subtitle || '', type: item.type, seconds: 0, starts: 0, viewers: [], lastPlayed: Date.now() };
    const it = this.persist.items[item.id];
    it.title = item.title;
    return it;
  }

  roomCreated(code, by) {
    this.day().rooms++;
    this.event('room', `${by} hat Raum ${code} erstellt`, { user: by });
    this.dirty = true;
  }

  /** Feed (nur im Speicher) – Ereignisse fürs Dashboard */
  event(type, text, extra = {}) {
    this.feed.push({ t: Date.now(), type, text, ...extra });
    if (this.feed.length > 300) this.feed.shift();
  }

  /** Protokoll (Datei) – Logins und Admin-Aktionen */
  audit(entry) {
    const line = JSON.stringify({ t: Date.now(), ...entry });
    fs.appendFile(this.auditFile, `${line}\n`, () => {});
    this.trimAudit();
  }

  trimAudit() {
    if (++this.auditWrites % 200 !== 0) return;
    fs.readFile(this.auditFile, 'utf8', (err, txt) => {
      if (err) return;
      const lines = txt.trim().split('\n');
      if (lines.length > 5000) fs.writeFile(this.auditFile, `${lines.slice(-4000).join('\n')}\n`, () => {});
    });
  }

  readAudit(limit = 300, filter = '') {
    let lines = [];
    try { lines = fs.readFileSync(this.auditFile, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
    const out = [];
    const f = String(filter || '').toLowerCase();
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (f && !lines[i].toLowerCase().includes(f)) continue;
      try { out.push(JSON.parse(lines[i])); } catch { /* egal */ }
    }
    return out;
  }

  /* ---------- Takt: Watchtime, Zeitreihen ---------- */

  /**
   * rooms: Map der Räume. Wird alle 10 s aufgerufen.
   */
  tick(rooms, cacheStats) {
    const now = Date.now();
    const dt = (now - this.last.t) / 1000;
    this.rate.out = Math.max(0, (this.bytesOut - this.last.out) / dt);
    this.rate.in = Math.max(0, (this.bytesIn - this.last.in) / dt);
    this.last = { t: now, out: this.bytesOut, in: this.bytesIn };

    // Auslieferungsraten pro Client (10-s-Fenster), Einträge ohne Verkehr laufen aus
    const rates = [];
    for (const [sid, e] of this.clientBytes) {
      e.rate = e.bytes > 0 ? e.bytes / dt : 0;
      e.bytes = 0;
      if (now - e.at > 30000 && e.rate <= 0) { this.clientBytes.delete(sid); continue; }
      rates.push({ sid: sid.slice(0, 12), name: e.name, kind: e.kind, stream: e.stream, bps: Math.round(e.rate * 8) });
    }
    rates.sort((a, b) => b.bps - a.bps);
    this.clientsNow = rates.slice(0, 40);

    let viewers = 0, playing = 0;
    const users = new Set();
    let active = 0;
    for (const room of rooms.values()) {
      if (room.clients.size) active++;
      for (const c of room.clients.values()) {
        viewers++;
        users.add(c.session.username.toLowerCase());
        if (room.playing && room.item && c.status && c.status.state === 'playing') {
          playing++;
          const sec = Math.min(dt, 30);
          const u = this.user(c.session.username);
          u.watchSeconds += sec;
          u.lastWatched = now;
          u.lastItem = room.item.title;
          const it = this.item(room.item);
          it.seconds += sec;
          if (!it.viewers.includes(u.name)) { it.viewers.push(u.name); if (it.viewers.length > 50) it.viewers.shift(); }
          this.day().watchSeconds += sec;
          this.persist.totals.watchSeconds += sec;
          this.dirty = true;
        }
      }
    }
    const d = this.day();
    if (viewers > d.peakViewers) { d.peakViewers = viewers; this.dirty = true; }
    if (viewers > this.persist.peak.viewers) { this.persist.peak = { viewers, at: now }; this.dirty = true; }

    const hit = cacheStats ? cacheStats.hits / Math.max(1, cacheStats.hits + cacheStats.misses) : 0;
    const point = { t: now, viewers, users: users.size, playing, rooms: active, out: Math.round(this.rate.out), in: Math.round(this.rate.in), hit: Math.round(hit * 1000) / 10 };
    this.hour.push(point);
    if (this.hour.length > HOUR_POINTS) this.hour.shift();
    if (now - this.lastWeekPush >= WEEK_STEP) {
      // Mittelwerte der letzten 5 min
      const recent = this.hour.filter((p) => p.t > now - WEEK_STEP);
      const avg = (k) => Math.round(recent.reduce((s, p) => s + p[k], 0) / Math.max(1, recent.length));
      const max = (k) => recent.reduce((m, p) => Math.max(m, p[k]), 0);
      this.week.push({ t: now, viewers: max('viewers'), users: max('users'), playing: max('playing'), rooms: max('rooms'), out: avg('out'), in: avg('in') });
      if (this.week.length > WEEK_POINTS) this.week.shift();
      this.lastWeekPush = now;
      this.dirty = true;
    }
    this.sampleCpu();
    return point;
  }

  sampleCpu() {
    const usage = process.cpuUsage(this.cpu.usage);
    const t = process.hrtime.bigint();
    const elapsedUs = Number(t - this.cpu.t) / 1000;
    this.cpu = { usage: process.cpuUsage(), t, pct: elapsedUs ? ((usage.user + usage.system) / elapsedUs) * 100 : 0 };
  }

  health() {
    const mem = process.memoryUsage();
    // Das Histogramm enthält das Messintervall selbst – nur die Verspätung zählt
    const late = (ns) => Math.max(0, ns / 1e6 - this.loopRes);
    const lag = { mean: late(this.loop.mean), p99: late(this.loop.percentile(99)), max: late(this.loop.max) };
    this.loop.reset();
    return {
      uptime: Math.round((Date.now() - this.started) / 1000),
      node: process.version,
      platform: `${os.type()} ${os.release()}`,
      cpu: Math.round(this.cpu.pct * 10) / 10,
      cores: os.cpus().length,
      load: os.loadavg().map((x) => Math.round(x * 100) / 100),
      rss: mem.rss, heap: mem.heapUsed, heapTotal: mem.heapTotal,
      sysFree: os.freemem(), sysTotal: os.totalmem(),
      lagMs: { mean: round1(lag.mean), p99: round1(lag.p99), max: round1(lag.max) },
    };
  }

  traffic() {
    return {
      rateOut: Math.round(this.rate.out), rateIn: Math.round(this.rate.in),
      sessionOut: this.bytesOut, sessionIn: this.bytesIn, sessionFromCache: this.bytesFromCache,
      totalOut: this.persist.totals.bytesOut, totalFromCache: this.persist.totals.bytesFromCache,
      saved: this.bytesOut ? Math.round((this.bytesFromCache / this.bytesOut) * 1000) / 10 : 0,
    };
  }

  summary() {
    const days = Object.entries(this.persist.days).sort((a, b) => a[0].localeCompare(b[0])).slice(-30)
      .map(([date, d]) => ({ date, watchHours: round1(d.watchSeconds / 3600), peakViewers: d.peakViewers, logins: d.logins, failedLogins: d.failedLogins || 0, users: d.users.length, rooms: d.rooms, starts: d.starts, bytesOut: d.bytesOut || 0 }));
    const topItems = Object.entries(this.persist.items).map(([id, it]) => ({ id, ...it, hours: round1(it.seconds / 3600), viewers: it.viewers.length }))
      .sort((a, b) => b.seconds - a.seconds).slice(0, 15);
    const topUsers = Object.values(this.persist.users).map((u) => ({ ...u, hours: round1(u.watchSeconds / 3600) }))
      .sort((a, b) => b.watchSeconds - a.watchSeconds).slice(0, 15);
    return { days, topItems, topUsers, peak: this.persist.peak, totals: { ...this.persist.totals, watchHours: round1(this.persist.totals.watchSeconds / 3600) } };
  }

  userStats(name) {
    const u = this.persist.users[String(name).toLowerCase()];
    return u ? { watchHours: round1(u.watchSeconds / 3600), lastWatched: u.lastWatched, lastItem: u.lastItem, logins: u.logins || 0 } : { watchHours: 0, lastWatched: null, lastItem: null, logins: 0 };
  }
}
Telemetry.prototype.auditWrites = 0;

function round1(x) { return Math.round(x * 10) / 10; }

module.exports = { Telemetry, TICK_MS };

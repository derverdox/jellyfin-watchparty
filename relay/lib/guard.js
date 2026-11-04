'use strict';
/*
 * Schutz gegen Durchprobieren und Überflutung.
 *
 * Anmeldung:
 *  - pro IP: nach 5 Fehlversuchen wächst die Wartezeit (2 s, 4 s, 8 s … bis 15 min)
 *  - pro Konto (über alle IPs): ab 20 Fehlversuchen in 15 min nur noch ein Versuch alle 30 s.
 *    Bewusst keine harte Sperre, sonst könnte jeder fremde Konten aussperren.
 *  - automatische IP-Sperre: 30 Fehlversuche in 1 h → 1 h, 100 → 24 h
 * Sperren überleben Neustarts (bans.json) und sind in der Verwaltung einsehbar.
 */
const fs = require('fs');
const path = require('path');

const MIN = 60000;
const HOUR = 60 * MIN;

class Guard {
  constructor(dir, onBan) {
    this.file = path.join(dir, 'bans.json');
    this.onBan = onBan || (() => {});
    this.ip = new Map();      // ip → { fails: [t…], next: t }
    this.user = new Map();    // name → { fails: [t…], next: t }
    this.buckets = new Map(); // generische Rate-Limits
    this.bans = {};
    try { this.bans = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { /* keine */ }
    this.recent = [];         // letzte Fehlversuche fürs Dashboard
    setInterval(() => this.cleanup(), 5 * MIN).unref();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.bans, null, 2), { mode: 0o600 });
    } catch (e) { console.error('[guard] Sperren nicht gespeichert:', e.message); }
  }

  banned(ip) {
    const b = this.bans[ip];
    if (!b) return null;
    if (b.until && Date.now() > b.until) { delete this.bans[ip]; this.save(); return null; }
    return b;
  }

  /** Darf jetzt ein Anmeldeversuch passieren? → { ok, wait (ms), reason } */
  checkLogin(ip, username) {
    const now = Date.now();
    const b = this.banned(ip);
    if (b) return { ok: false, wait: b.until ? b.until - now : null, reason: 'ban' };
    const i = this.ip.get(ip);
    if (i && i.next > now) return { ok: false, wait: i.next - now, reason: 'ip' };
    const u = this.user.get(String(username).toLowerCase());
    if (u && u.next > now) return { ok: false, wait: u.next - now, reason: 'user' };
    return { ok: true };
  }

  fail(ip, username) {
    const now = Date.now();
    const i = this.ip.get(ip) || { fails: [], next: 0 };
    i.fails = i.fails.filter((t) => now - t < 24 * HOUR);
    i.fails.push(now);
    const recent15 = i.fails.filter((t) => now - t < 15 * MIN).length;
    if (recent15 > 5) i.next = now + Math.min(15 * MIN, 1000 * 2 ** (recent15 - 5));
    this.ip.set(ip, i);

    const key = String(username).toLowerCase().slice(0, 40);
    const u = this.user.get(key) || { fails: [], next: 0 };
    u.fails = u.fails.filter((t) => now - t < 15 * MIN);
    u.fails.push(now);
    if (u.fails.length >= 20) u.next = now + 30000;
    this.user.set(key, u);

    this.recent.push({ t: now, ip, user: key });
    if (this.recent.length > 200) this.recent.shift();

    const lastHour = i.fails.filter((t) => now - t < HOUR).length;
    if (!this.banned(ip)) {
      if (i.fails.length >= 100) this.ban(ip, 24, `${i.fails.length} Fehlversuche in 24 h`, 'auto');
      else if (lastHour >= 30) this.ban(ip, 1, `${lastHour} Fehlversuche in 1 h`, 'auto');
    }
  }

  success(ip, username) {
    this.ip.delete(ip);
    const u = this.user.get(String(username).toLowerCase());
    if (u) u.next = 0; // Zähler bleibt, damit ein Angriff von woanders gebremst bleibt
  }

  ban(ip, hours, reason, by) {
    const h = Number(hours);
    this.bans[ip] = { since: Date.now(), until: h > 0 ? Date.now() + h * HOUR : null, reason: String(reason || '').slice(0, 200), by: by || 'admin' };
    this.save();
    this.onBan(ip, this.bans[ip]);
  }

  unban(ip) {
    delete this.bans[ip];
    this.ip.delete(ip);
    this.save();
  }

  /** Einfaches Rate-Limit: höchstens max Ereignisse pro windowMs für key. */
  limit(key, max, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; this.buckets.set(key, b); }
    b.n++;
    return b.n <= max;
  }

  cleanup() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now > b.reset) this.buckets.delete(k);
    for (const [k, i] of this.ip) if (!i.fails.some((t) => now - t < 24 * HOUR)) this.ip.delete(k);
    for (const [k, u] of this.user) if (!u.fails.some((t) => now - t < 15 * MIN)) this.user.delete(k);
    let changed = false;
    for (const [ip, b] of Object.entries(this.bans)) if (b.until && now > b.until) { delete this.bans[ip]; changed = true; }
    if (changed) this.save();
  }

  overview() {
    const now = Date.now();
    const watch = [...this.ip.entries()]
      .map(([ip, i]) => ({ ip, fails1h: i.fails.filter((t) => now - t < HOUR).length, fails24h: i.fails.length, waitUntil: i.next > now ? i.next : null, last: i.fails[i.fails.length - 1] }))
      .filter((x) => x.fails24h).sort((a, b) => b.fails1h - a.fails1h || b.last - a.last).slice(0, 50);
    const users = [...this.user.entries()].map(([name, u]) => ({ name, fails15m: u.fails.length, slowed: u.next > now })).filter((x) => x.fails15m).sort((a, b) => b.fails15m - a.fails15m).slice(0, 30);
    const bans = Object.entries(this.bans).map(([ip, b]) => ({ ip, ...b })).sort((a, b) => b.since - a.since);
    return { bans, watch, users, recent: this.recent.slice(-50).reverse(), failures24h: [...this.ip.values()].reduce((s, i) => s + i.fails.length, 0) };
  }
}

/** Häufige Passwörter, die wir nicht zulassen (Auszug der üblichen Verdächtigen). */
const COMMON = new Set(('12345678 123456789 1234567890 password passwort passwort1 password1 qwertz123 qwertzuiop qwerty123 qwertyuiop ' +
  'iloveyou 11111111 00000000 abcdefgh abc12345 hallo123 hallo1234 schalke04 dortmund09 fussball letmein1 welcome1 sommer2026 ' +
  'winter2026 admin123 administrator 87654321 asdfghjk asdf1234 1q2w3e4r passw0rd watchparty jellyfin').split(' '));

function checkPassword(pw, username) {
  const p = String(pw || '');
  if (p.length < 8) return 'Passwort muss mindestens 8 Zeichen haben';
  if (p.length > 200) return 'Passwort ist zu lang';
  if (COMMON.has(p.toLowerCase())) return 'Dieses Passwort ist zu bekannt – nimm ein anderes';
  if (/^(.)\1+$/.test(p)) return 'Bitte nicht nur ein Zeichen wiederholen';
  const u = String(username || '').toLowerCase();
  if (u.length >= 3 && p.toLowerCase().includes(u)) return 'Das Passwort darf den Benutzernamen nicht enthalten';
  return null;
}

module.exports = { Guard, checkPassword };

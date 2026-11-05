'use strict';
/**
 * Anmelden per QR-Code (wie bei Streaming-Apps):
 *  1. Das Gerät ohne Konto (Fernseher) holt sich einen Code + ein geheimes Abhol-Token.
 *  2. Es zeigt einen QR-Code mit https://domain/pair/CODE.
 *  3. Ein angemeldetes Handy öffnet den Link und bestätigt.
 *  4. Das Gerät fragt mit seinem Token nach und bekommt eine eigene Sitzung.
 *
 * Nur wer das Token hat (das Gerät selbst), kann die Sitzung abholen. Der Code allein reicht nicht.
 * Alles liegt nur im Speicher und verfällt nach wenigen Minuten.
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O, 1/I – leichter abzutippen
const CODE_LEN = 8;
const MAX_PENDING = 1000;

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** Gerät grob aus dem User-Agent benennen (nur zur Anzeige beim Bestätigen). */
function deviceLabel(ua) {
  const u = String(ua || '');
  if (/WatchpartyTV/.test(u)) return /AFT|Amazon/i.test(u) ? 'Fire TV (Watchparty-App)' : 'Fernseher (Watchparty-App)';
  if (/WatchpartyApp/.test(u)) return 'Android (Watchparty-App)';
  if (/watchparty-desktop/i.test(u)) return 'Desktop-Client';
  if (/Tizen/i.test(u)) return 'Samsung-Fernseher (Browser)';
  if (/Web0S|webOS|NetCast/i.test(u)) return 'LG-Fernseher (Browser)';
  if (/AFT[A-Z]/.test(u)) return 'Fire TV (Browser)';
  if (/SMART-TV|SmartTV|HbbTV|BRAVIA|Android TV|GoogleTV/i.test(u)) return 'Fernseher (Browser)';
  if (/iPhone/.test(u)) return 'iPhone';
  if (/iPad/.test(u)) return 'iPad';
  if (/Android/.test(u)) return 'Android-Gerät';
  if (/Windows/.test(u)) return 'Windows-PC (Browser)';
  if (/Macintosh/.test(u)) return 'Mac (Browser)';
  if (/Linux/.test(u)) return 'Linux-PC (Browser)';
  return 'Unbekanntes Gerät';
}

/** Eingabe vom Handy: Code mit Leerzeichen/Bindestrich oder ganzer Link → CODE. */
function normalizeCode(input) {
  const s = String(input || '');
  const m = s.match(/\/pair\/([A-Za-z0-9-]+)/);
  return (m ? m[1] : s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}

class Pairing {
  constructor({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttl = ttlMs;
    this.now = now;
    this.byCode = new Map();
    this.byToken = new Map();
    this.timer = setInterval(() => this.sweep(), 30000);
    this.timer.unref();
  }

  newCode() {
    let c;
    do {
      c = '';
      for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    } while (this.byCode.has(c));
    return c;
  }

  sweep() {
    const t = this.now();
    for (const p of this.byCode.values()) if (p.expires < t - 60000) this.remove(p);
  }

  remove(p) { this.byCode.delete(p.code); this.byToken.delete(p.tokenHash); }

  start({ ip, ua }) {
    this.sweep();
    if (this.byCode.size >= MAX_PENDING) throw new Error('Gerade zu viele offene Anmeldungen – gleich nochmal versuchen.');
    const token = crypto.randomBytes(24).toString('hex');
    const p = {
      code: this.newCode(), tokenHash: hash(token), ip: ip || null, ua: String(ua || '').slice(0, 300),
      device: deviceLabel(ua), created: this.now(), expires: this.now() + this.ttl, state: 'pending', username: null,
    };
    this.byCode.set(p.code, p);
    this.byToken.set(p.tokenHash, p);
    return { code: p.code, token, expiresIn: Math.round(this.ttl / 1000) };
  }

  expired(p) { return this.now() > p.expires; }

  /** Für das Gerät: Zustand per Token abfragen. */
  poll(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const p = this.byToken.get(hash(token));
    if (!p) return null;
    if (p.state === 'pending' && this.expired(p)) { p.state = 'expired'; }
    return p;
  }

  /** Für das Handy: Anfrage per Code finden. */
  get(code) {
    const p = this.byCode.get(normalizeCode(code));
    if (!p) return null;
    if (p.state === 'pending' && this.expired(p)) p.state = 'expired';
    return p;
  }

  approve(p, username) {
    if (p.state !== 'pending') throw new Error(p.state === 'expired' ? 'Der Code ist abgelaufen. Am Fernseher kommt gleich ein neuer.' : 'Dieser Code wurde schon benutzt.');
    p.state = 'approved';
    p.username = username;
    p.approvedAt = this.now();
  }

  deny(p) { if (p.state === 'pending') p.state = 'denied'; }

  /** Sitzung wurde ausgegeben → Code ist verbraucht. */
  consume(p) { p.state = 'done'; this.remove(p); }
}

module.exports = { Pairing, deviceLabel, normalizeCode, ALPHABET, CODE_LEN };

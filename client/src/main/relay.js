'use strict';
/**
 * Verbindung zum Watchparty-Relay: HTTP-API (Login, Bibliothek, Räume) und
 * der Sync-WebSocket. Spricht exakt dasselbe Protokoll wie die Web-Oberfläche.
 */
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const UA = 'watchparty-desktop/1.0';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Bitte die Adresse des Servers angeben');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}`;
}

class RelayClient extends EventEmitter {
  constructor() {
    super();
    this.base = null;
    this.sid = null;         // Wert des wp_sid-Cookies
    this.ws = null;
    this.code = null;
    this.offset = 0;         // Serverzeit minus lokale Zeit (ms)
    this.rtt = null;
    this.samples = [];
    this.retry = 0;
    this.leaving = false;
    this.pingTimer = null;
  }

  setServer(url) { this.base = normalizeServer(url); }
  setSession(sid) { this.sid = sid || null; }
  get cookieHeader() { return this.sid ? `wp_sid=${this.sid}` : ''; }

  url(p) { return this.base + p; }

  async request(method, p, body, { raw = false, timeout = 20000 } = {}) {
    if (!this.base) throw new Error('Kein Server eingestellt');
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (this.sid) headers.Cookie = this.cookieHeader;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.url(p), {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual', signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const cause = e.cause && (e.cause.code || e.cause.message);
      throw new HttpError(0, `Server nicht erreichbar${cause ? ` (${cause})` : ''}`);
    }
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of setCookies) {
      const m = /^wp_sid=([^;]*)/.exec(c);
      if (m) { this.sid = m[1] || null; this.emit('session', this.sid); }
    }
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
    if (!res.ok) throw new HttpError(res.status, (data && data.error) || `Fehler ${res.status}`);
    return data;
  }

  login(username, password) { return this.request('POST', '/api/login', { username, password }); }
  me() { return this.request('GET', '/api/me'); }
  async logout() { try { await this.request('POST', '/api/logout', {}); } finally { this.sid = null; } }
  createRoom() { return this.request('POST', '/api/rooms', {}); }
  roomInfo(code) { return this.request('GET', `/api/rooms/${encodeURIComponent(code)}`); }
  libraries() { return this.request('GET', '/api/libraries'); }
  items(params) { return this.request('GET', `/api/items?${new URLSearchParams(params)}`); }
  item(id) { return this.request('GET', `/api/item/${encodeURIComponent(id)}`); }
  createInvite() { return this.request('POST', '/api/invites', {}); }
  inviteValid(code) { return this.request('GET', `/api/invite/${encodeURIComponent(code)}`); }
  register(code, username, password) { return this.request('POST', `/api/invite/${encodeURIComponent(code)}`, { username, password }); }
  setName(name) { return this.request('POST', '/api/name', { name }); }
  changePassword(old, password) { return this.request('POST', '/api/password', { old, password }); }
  search(q) { return this.request('GET', `/api/search?q=${encodeURIComponent(q)}`); }
  watchlist() { return this.request('GET', '/api/watchlist'); }
  toggleWatch(itemId, on) { return this.request('POST', '/api/watchlist', { itemId, ...(on !== undefined ? { on } : {}) }); }
  history() { return this.request('GET', '/api/history'); }
  clearHistory(id) { return this.request('DELETE', `/api/history${id ? `/${encodeURIComponent(id)}` : ''}`); }

  /* ---------------- WebSocket ---------------- */

  serverNow() { return Date.now() + this.offset; }

  join(code) {
    this.leave();
    this.code = String(code).toUpperCase();
    this.leaving = false;
    this.retry = 0;
    this._connect();
  }

  leave() {
    this.leaving = true;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) { try { this.ws.close(1000); } catch { /* egal */ } }
    this.ws = null;
  }

  _connect() {
    const wsUrl = `${this.base.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(this.code)}`;
    // Kein Origin-Header: das Relay prüft ihn nur, wenn ein Browser ihn schickt.
    const ws = new WebSocket(wsUrl, { headers: { Cookie: this.cookieHeader, 'User-Agent': UA }, handshakeTimeout: 15000 });
    this.ws = ws;
    let opened = false;

    ws.on('open', () => {
      opened = true;
      this.retry = 0;
      this.samples = [];
      this.emit('conn', { state: 'open' });
      for (let i = 0; i < 5; i++) setTimeout(() => this._ping(), i * 250);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this._ping(), 5000);
    });

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode;
      ws.terminate();
      if (this.ws !== ws) return;
      if (status === 401) { this.leaving = true; this.emit('fatal', { status, text: 'Deine Anmeldung ist abgelaufen.' }); }
      else if (status === 404) { this.leaving = true; this.emit('fatal', { status, text: 'Diesen Raum gibt es nicht (mehr).' }); }
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.t === 'pong') return this._onPong(msg);
      if (msg.t === 'welcome' && Number.isFinite(msg.serverNow) && !this.samples.length) this.offset = msg.serverNow - Date.now();
      this.emit('message', msg);
    });

    ws.on('error', () => { /* close folgt */ });

    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      if (this.leaving) return;
      if (code === 4001) { this.leaving = true; return; } // gekickt, Nachricht kam schon
      this.emit('conn', { state: 'reconnecting', wasOpen: opened });
      const delay = Math.min(1000 * 2 ** this.retry++, 10000);
      setTimeout(() => { if (!this.leaving && this.ws === ws) this._connect(); }, delay);
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(msg)); return true; }
    return false;
  }

  _ping() { this.send({ t: 'ping', c: Date.now() }); }

  _onPong(msg) {
    const now = Date.now();
    const rtt = now - msg.c;
    if (!(rtt >= 0 && rtt < 10000)) return;
    this.samples.push({ rtt, off: msg.s + rtt / 2 - now });
    if (this.samples.length > 12) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    this.offset = best.reduce((s, x) => s + x.off, 0) / best.length;
    this.rtt = best[0].rtt;
  }
}

module.exports = { RelayClient, HttpError, normalizeServer };

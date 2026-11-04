'use strict';
/*
 * Tunnel zum Heimserver-Agent.
 * Eine einzige WebSocket-Verbindung, über die beliebig viele HTTP-Anfragen
 * gleichzeitig laufen (Multiplexing). Steuer-Nachrichten sind JSON-Text,
 * Nutzdaten sind Binär-Frames: [4 Byte Stream-ID][Daten].
 * Backpressure: Kommt der Browser nicht hinterher, wird der Agent für genau
 * diesen Stream pausiert.
 */
const { Readable } = require('stream');
const { EventEmitter } = require('events');

class TunnelError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.info = null;
    this.streams = new Map();
    this.nextId = 1;
    setInterval(() => this.heartbeat(), 20000).unref();
  }

  get online() { return !!(this.ws && this.ws.readyState === 1 && this.info); }

  attach(ws, remote) {
    if (this.ws) {
      try { this.ws.close(4000, 'replaced'); } catch { /* egal */ }
      this.failAll('Heimserver hat neu verbunden');
    }
    this.ws = ws;
    this.info = null;
    this.alive = true;
    console.log(`[tunnel] Agent verbunden von ${remote}`);
    ws.on('message', (data, isBinary) => (isBinary ? this.onData(data) : this.onText(data)));
    ws.on('pong', () => { this.alive = true; });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.info = null;
      this.failAll('Verbindung zum Heimserver getrennt');
      console.log('[tunnel] Agent getrennt');
      this.emit('change', false);
    });
  }

  heartbeat() {
    if (!this.ws) return;
    if (!this.alive) { this.ws.terminate(); return; }
    this.alive = false;
    try { this.ws.ping(); } catch { /* egal */ }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  onText(raw) {
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (m.t === 'hello') {
      if (!m.userId) return;
      this.info = { userId: m.userId, userName: m.userName, serverName: m.serverName, version: m.jfVersion, agentVersion: m.version };
      console.log(`[tunnel] Jellyfin "${m.serverName}" (${m.jfVersion}) online, Benutzer "${m.userName}"`);
      this.emit('change', true);
      return;
    }
    const entry = this.streams.get(m.id);
    if (!entry) return;
    if (m.t === 'res') {
      entry.resolve({ status: m.status, headers: m.headers || {} });
    } else if (m.t === 'end') {
      entry.ended = true;
      this.streams.delete(m.id);
      if (!entry.resolved) entry.resolve({ status: 502, headers: {} });
      entry.body.push(null);
    } else if (m.t === 'err') {
      entry.ended = true;
      this.streams.delete(m.id);
      const err = new TunnelError(m.status || 502, m.message || 'Fehler beim Heimserver');
      if (!entry.resolved) entry.reject(err);
      else entry.body.destroy(err);
    }
  }

  onData(buf) {
    if (buf.length < 4) return;
    const id = buf.readUInt32BE(0);
    const entry = this.streams.get(id);
    if (!entry || !entry.resolved) return;
    const ok = entry.body.push(buf.subarray(4));
    if (!ok && !entry.paused) {
      entry.paused = true;
      this.send({ t: 'pause', id });
    }
  }

  failAll(message) {
    for (const entry of this.streams.values()) {
      entry.ended = true;
      const err = new TunnelError(503, message);
      if (!entry.resolved) entry.reject(err);
      else entry.body.destroy(err);
    }
    this.streams.clear();
  }

  /**
   * Schickt eine Anfrage an Jellyfin (über den Agent).
   * Liefert { status, headers, body: Readable }.
   */
  request({ method = 'GET', path, headers = {} }, { signal, timeout = 90000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.online) return reject(new TunnelError(503, 'Der Heimserver ist gerade offline'));
      const id = this.nextId++;
      if (this.nextId > 0x7fffffff) this.nextId = 1;
      const entry = { id, resolved: false, ended: false, paused: false };
      const body = new Readable({
        highWaterMark: 1024 * 1024,
        read: () => {
          if (entry.paused) { entry.paused = false; this.send({ t: 'resume', id }); }
        },
      });
      body.on('close', () => {
        if (!entry.ended) { entry.ended = true; this.streams.delete(id); this.send({ t: 'cancel', id }); }
      });
      body.on('error', () => { /* wird vom Konsumenten behandelt */ });
      entry.body = body;
      const timer = setTimeout(() => {
        if (entry.resolved) return;
        this.send({ t: 'cancel', id });
        entry.ended = true;
        this.streams.delete(id);
        reject(new TunnelError(504, 'Der Heimserver antwortet nicht'));
      }, timeout);
      entry.resolve = (r) => { entry.resolved = true; clearTimeout(timer); resolve({ ...r, body }); };
      entry.reject = (e) => { clearTimeout(timer); reject(e); };
      if (signal) {
        const onAbort = () => {
          if (!entry.resolved) {
            entry.ended = true;
            this.streams.delete(id);
            this.send({ t: 'cancel', id });
            entry.reject(new TunnelError(499, 'abgebrochen'));
          } else body.destroy();
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.streams.set(id, entry);
      this.send({ t: 'req', id, method, path, headers });
    });
  }

  /** Anfrage komplett in einen Buffer lesen. */
  async buffer(path, { headers, limit = 64 * 1024 * 1024, method, timeout } = {}) {
    const r = await this.request({ method, path, headers }, { timeout });
    const chunks = [];
    let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > limit) { r.body.destroy(); throw new TunnelError(502, 'Antwort zu groß'); }
      chunks.push(c);
    }
    return { status: r.status, headers: r.headers, buf: Buffer.concat(chunks) };
  }

  async json(path, opts = {}) {
    const r = await this.buffer(path, { ...opts, limit: 32 * 1024 * 1024 });
    if (r.status < 200 || r.status >= 300) {
      throw new TunnelError(r.status === 404 ? 404 : 502, `Jellyfin antwortet mit ${r.status}`);
    }
    if (!r.buf.length) return null;
    return JSON.parse(r.buf.toString('utf8'));
  }
}

module.exports = { Tunnel, TunnelError };

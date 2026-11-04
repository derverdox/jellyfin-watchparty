'use strict';
/*
 * Festplatten-Cache mit LRU-Verdrängung und Anfrage-Bündelung:
 * Fragen 5 Zuschauer gleichzeitig dasselbe Stück an, wird es nur EINMAL
 * vom Heimserver geholt.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

class DiskCache {
  constructor(dir, maxBytes) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.index = new Map(); // key -> { file, size, atime, meta }
    this.total = 0;
    this.inflight = new Map();
    this.hits = 0;
    this.misses = 0;
    // Metadaten liegen nur im Speicher → alter Cache ist nach Neustart wertlos
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(key) {
    return path.join(this.dir, crypto.createHash('sha256').update(key).digest('hex'));
  }

  async read(key) {
    const e = this.index.get(key);
    if (!e) return null;
    try {
      const buf = await fsp.readFile(e.file);
      e.atime = Date.now();
      return { buf, meta: e.meta };
    } catch {
      this.drop(key);
      return null;
    }
  }

  async write(key, buf, meta) {
    if (buf.length > this.maxBytes / 4) return;
    const file = this.fileFor(key);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, file);
    } catch (e) {
      fsp.unlink(tmp).catch(() => {});
      return;
    }
    if (this.index.has(key)) this.drop(key, false);
    this.index.set(key, { file, size: buf.length, atime: Date.now(), meta });
    this.total += buf.length;
    this.evict();
  }

  drop(key, unlink = true) {
    const e = this.index.get(key);
    if (!e) return;
    this.index.delete(key);
    this.total -= e.size;
    if (unlink) fsp.unlink(e.file).catch(() => {});
  }

  evict() {
    if (this.total <= this.maxBytes) return;
    const target = this.maxBytes * 0.9;
    const entries = [...this.index.entries()].sort((a, b) => a[1].atime - b[1].atime);
    for (const [key] of entries) {
      if (this.total <= target) break;
      this.drop(key);
    }
  }

  /**
   * Holt key aus dem Cache oder über fetcher(); gleichzeitige Anfragen teilen
   * sich einen einzigen Abruf. fetcher liefert { buf, meta, cacheable }.
   */
  async get(key, fetcher) {
    if (this.index.has(key)) {
      const hit = await this.read(key);
      if (hit) { this.hits++; return { ...hit, hit: true }; }
    }
    const running = this.inflight.get(key);
    if (running) { this.hits++; return { ...(await running), hit: true }; }
    this.misses++;
    const p = (async () => {
      const r = await fetcher();
      if (r.cacheable) await this.write(key, r.buf, r.meta);
      return { buf: r.buf, meta: r.meta };
    })();
    this.inflight.set(key, p);
    try { return { ...(await p), hit: false }; } finally { this.inflight.delete(key); }
  }

  stats() {
    return { entries: this.index.size, bytes: this.total, maxBytes: this.maxBytes, hits: this.hits, misses: this.misses };
  }
}

/** Kleiner Speicher-Cache mit Ablaufzeit (für JSON-Antworten). */
class TtlCache {
  constructor(ttlMs, max = 500) { this.ttl = ttlMs; this.max = max; this.map = new Map(); }
  async get(key, fn) {
    const e = this.map.get(key);
    if (e && Date.now() - e.t < this.ttl) return e.v;
    const v = await fn();
    this.map.set(key, { v, t: Date.now() });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return v;
  }
  clear() { this.map.clear(); }
}

module.exports = { DiskCache, TtlCache };

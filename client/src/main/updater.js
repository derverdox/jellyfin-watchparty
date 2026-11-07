'use strict';
/**
 * Automatische Updates über die GitHub-Releases (Tags „client-vX.Y.Z“, die das CI baut).
 *
 * - prüft beim Start und dann alle 6 Stunden
 * - lädt den neuen Installer still im Hintergrund (mit Prüfsumme, falls GitHub eine liefert)
 * - installiert beim Beenden oder sofort per „Jetzt neu starten“ (NSIS: /S --updated, danach startet
 *   die App mit --force-run von selbst neu)
 *
 * Bewusst ohne electron-updater: ein Request an die GitHub-API, ein Download, kein latest.yml nötig.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const REPO = process.env.WATCHPARTY_UPDATE_REPO || 'derverdox/jellyfin-watchparty';
const TAG_RE = /^client-v(\d+)\.(\d+)\.(\d+)$/;
const CHECK_EVERY = 6 * 3600 * 1000;

/** „1.10.0“ > „1.9.3“ */
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** Neuestes Client-Release mit Windows-Installer aus der GitHub-Liste. */
function pickRelease(list, current) {
  let best = null;
  for (const r of list || []) {
    if (r.draft || r.prerelease) continue;
    const m = TAG_RE.exec(r.tag_name || '');
    if (!m) continue;
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    const asset = (r.assets || []).find((a) => /^Watchparty-Setup-.*\.exe$/i.test(a.name));
    if (!asset || !newer(version, current)) continue;
    if (!best || newer(version, best.version)) {
      best = {
        version,
        notes: String(r.body || '').slice(0, 2000),
        url: asset.browser_download_url,
        name: asset.name,
        size: asset.size || 0,
        sha256: /^sha256:([a-f0-9]{64})$/i.test(asset.digest || '') ? asset.digest.slice(7).toLowerCase() : null,
        page: r.html_url,
      };
    }
  }
  return best;
}

class Updater extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.current   aktuelle Version (app.getVersion())
   * @param {string} o.dir       Ordner für den Download
   * @param {boolean} o.enabled  nur in der installierten Windows-App sinnvoll
   */
  constructor({ current, dir, enabled = true, api = 'https://api.github.com', fetchImpl = globalThis.fetch, spawnImpl = spawn }) {
    super();
    this.current = current;
    this.dir = dir;
    this.enabled = enabled;
    this.api = api;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.state = { state: enabled ? 'idle' : 'off', current, version: null, progress: null, error: null };
    this.ready = null;      // { version, file }
    this.busy = false;
    this.installing = false;
    this.timer = null;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  start() {
    if (!this.enabled) return;
    // Alte Downloads vom letzten Mal aufräumen (außer es wird gerade installiert)
    fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {}).finally(() => {
      setTimeout(() => this.check().catch(() => {}), 8000);
    });
    this.timer = setInterval(() => this.check().catch(() => {}), CHECK_EVERY);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { clearInterval(this.timer); }

  async check({ manual = false } = {}) {
    if (!this.enabled || this.busy || this.ready) return this.state;
    this.busy = true;
    try {
      this.set({ state: 'checking', error: null });
      const r = await this.fetch(`${this.api}/repos/${REPO}/releases?per_page=30`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `watchparty-desktop/${this.current}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`GitHub antwortet mit ${r.status}`);
      const rel = pickRelease(await r.json(), this.current);
      if (!rel) { this.set({ state: 'latest', version: null }); return this.state; }
      this.set({ state: 'downloading', version: rel.version, notes: rel.notes, page: rel.page, progress: 0 });
      const file = await this.download(rel);
      this.ready = { version: rel.version, file };
      this.set({ state: 'ready', progress: 100 });
    } catch (e) {
      this.set({ state: 'error', error: e.message });
      if (manual) throw e;
    } finally {
      this.busy = false;
    }
    return this.state;
  }

  async download(rel) {
    await fsp.mkdir(this.dir, { recursive: true });
    const dest = path.join(this.dir, rel.name.replace(/[^\w.-]/g, '_'));
    const part = `${dest}.part`;
    const res = await this.fetch(rel.url, { headers: { 'User-Agent': `watchparty-desktop/${this.current}` }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || rel.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let done = 0, last = 0;
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        done += chunk.length;
        if (total && Date.now() - last > 500) { last = Date.now(); this.set({ progress: Math.round((done / total) * 100) }); }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (rel.size && done !== rel.size) throw new Error('Download unvollständig');
    if (rel.sha256 && hash.digest('hex') !== rel.sha256) throw new Error('Prüfsumme stimmt nicht – Update verworfen');
    await fsp.rename(part, dest);
    return dest;
  }

  /**
   * Installer starten. relaunch=true: App danach wieder öffnen (Knopf „Jetzt neu starten“),
   * false: still beim Beenden.
   * @returns {boolean} ob ein Installer gestartet wurde
   */
  install(relaunch) {
    if (!this.ready || this.installing || !fs.existsSync(this.ready.file)) return false;
    this.installing = true;
    const args = ['/S', '--updated'];
    if (relaunch) args.push('--force-run');
    const p = this.spawn(this.ready.file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    if (p && p.unref) p.unref();
    return true;
  }
}

module.exports = { Updater, pickRelease, newer };

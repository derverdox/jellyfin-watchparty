'use strict';
/*
 * Benutzerkonten (scrypt-Hashes), Einladungslinks und Sitzungen.
 * Alles in JSON-Dateien im Datenordner. Änderungen von außen (z. B. per
 * CLI-Befehl während der Server läuft) werden automatisch neu eingelesen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const NAME_RE = /^[A-Za-z0-9_.\-äöüÄÖÜß]{2,24}$/;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

class JsonFile {
  constructor(file, def) { this.file = file; this.def = def; this.mtime = 0; this.data = null; this.load(); }
  load() {
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs === this.mtime && this.data) return this.data;
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.mtime = st.mtimeMs;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[data] ${this.file} unlesbar:`, e.message);
      if (!this.data) this.data = structuredClone(this.def);
    }
    return this.data;
  }
  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
  }
}

class UserStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new JsonFile(path.join(dir, 'users.json'), { users: [], invites: [] });
    this.dummySalt = crypto.randomBytes(16);
  }

  get data() { return this.db.load(); }

  list() { return this.data.users.map((u) => ({ username: u.username, admin: !!u.admin, created: u.created })); }
  count() { return this.data.users.length; }
  find(username) {
    const n = String(username || '').toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === n) || null;
  }

  validName(name) { return NAME_RE.test(String(name || '')); }

  async create(username, password, { admin = false } = {}) {
    if (!this.validName(username)) throw new Error('Benutzername: 2–24 Zeichen, Buchstaben/Zahlen/._-');
    if (String(password || '').length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben');
    if (this.find(username)) throw new Error('Benutzername ist schon vergeben');
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt);
    const d = this.data;
    d.users.push({ username, admin: !!admin, salt: salt.toString('hex'), hash: hash.toString('hex'), created: Date.now() });
    this.db.save();
    return this.find(username);
  }

  async setPassword(username, password) {
    const u = this.find(username);
    if (!u) throw new Error('Benutzer nicht gefunden');
    if (String(password || '').length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben');
    const salt = crypto.randomBytes(16);
    u.salt = salt.toString('hex');
    u.hash = (await scrypt(password, salt)).toString('hex');
    u.pwChanged = Date.now();
    this.db.save();
  }

  setAdmin(username, admin) {
    const u = this.find(username);
    if (!u) throw new Error('Benutzer nicht gefunden');
    u.admin = !!admin;
    this.db.save();
  }

  remove(username) {
    const d = this.data;
    const before = d.users.length;
    d.users = d.users.filter((u) => u.username.toLowerCase() !== String(username).toLowerCase());
    if (d.users.length === before) throw new Error('Benutzer nicht gefunden');
    this.db.save();
  }

  async verify(username, password) {
    const u = this.find(username);
    // auch bei unbekanntem Namen rechnen → keine Rückschlüsse über die Antwortzeit
    const salt = u ? Buffer.from(u.salt, 'hex') : this.dummySalt;
    const hash = await scrypt(password, salt);
    if (!u) return null;
    return crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex')) ? u : null;
  }

  createInvite(by, hours = 72) {
    const d = this.data;
    const now = Date.now();
    d.invites = (d.invites || []).filter((i) => !i.usedBy && i.expires > now);
    const code = crypto.randomBytes(12).toString('base64url');
    d.invites.push({ code, by, created: now, expires: now + hours * 3600 * 1000 });
    this.db.save();
    return code;
  }

  checkInvite(code) {
    const i = (this.data.invites || []).find((x) => x.code === code);
    return !!(i && !i.usedBy && i.expires > Date.now());
  }

  async redeemInvite(code, username, password) {
    if (!this.checkInvite(code)) throw new Error('Einladung ungültig oder abgelaufen');
    const u = await this.create(username, password);
    const i = this.data.invites.find((x) => x.code === code);
    i.usedBy = u.username;
    i.usedAt = Date.now();
    this.db.save();
    return u;
  }
}

class SessionStore {
  constructor(dir, ttlMs) {
    this.ttl = ttlMs;
    this.db = new JsonFile(path.join(dir, 'sessions.json'), {});
    this.dirty = false;
    setInterval(() => this.flush(), 30000).unref();
  }
  get map() { return this.db.data; }
  create(user) {
    const id = crypto.randomBytes(24).toString('hex');
    this.map[id] = { id, username: user.username, name: user.username, created: Date.now(), lastSeen: Date.now() };
    this.flush(true);
    return this.map[id];
  }
  get(id) {
    const s = id && Object.prototype.hasOwnProperty.call(this.map, id) ? this.map[id] : null;
    if (!s) return null;
    if (Date.now() - s.lastSeen > this.ttl) { this.delete(id); return null; }
    if (Date.now() - s.lastSeen > 60000) { s.lastSeen = Date.now(); this.dirty = true; }
    return s;
  }
  delete(id) { delete this.map[id]; this.flush(true); }
  deleteForUser(username, exceptId) {
    for (const [id, s] of Object.entries(this.map)) {
      if (s.username.toLowerCase() === String(username).toLowerCase() && id !== exceptId) delete this.map[id];
    }
    this.flush(true);
  }
  flush(force) {
    if (!force && !this.dirty) return;
    const now = Date.now();
    for (const [id, s] of Object.entries(this.map)) if (now - s.lastSeen > this.ttl) delete this.map[id];
    this.dirty = false;
    try { this.db.save(); } catch (e) { console.error('[data] Sitzungen nicht gespeichert:', e.message); }
  }
}

module.exports = { UserStore, SessionStore };

'use strict';
/*
 * Benutzerkonten (scrypt-Hashes), Einladungslinks und Sitzungen.
 * Alles in JSON-Dateien im Datenordner. Änderungen von außen (z. B. per
 * CLI-Befehl während der Server läuft) werden automatisch neu eingelesen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checkPassword } = require('./guard');

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
    this.ensureOwner();
  }

  get data() { return this.db.load(); }

  /** Öffentliche Sicht auf ein Konto (ohne Hash/Salt). */
  view(u) {
    return {
      username: u.username, admin: !!u.admin, owner: !!u.owner, created: u.created,
      groups: Array.isArray(u.groups) ? u.groups : [], disabled: !!u.disabled, expires: u.expires || null,
      note: u.note || '', lastLogin: u.lastLogin || null, createdBy: u.createdBy || null, pwChanged: u.pwChanged || null,
    };
  }

  list() { return this.data.users.map((u) => this.view(u)); }
  count() { return this.data.users.length; }
  find(username) {
    const n = String(username || '').toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === n) || null;
  }

  validName(name) { return NAME_RE.test(String(name || '')); }

  /** Der älteste Admin ist der Haupt-Admin: nicht löschbar, nicht sperrbar, nicht herabstufbar. */
  ensureOwner() {
    const d = this.data;
    if (!d.users.length || d.users.some((u) => u.owner)) return;
    const first = [...d.users].filter((u) => u.admin).sort((a, b) => (a.created || 0) - (b.created || 0))[0];
    if (first) { first.owner = true; this.db.save(); }
  }

  /** Konto gerade nutzbar? (nicht gesperrt, nicht abgelaufen) */
  usable(u) {
    if (!u) return false;
    if (u.owner) return true;
    if (u.disabled) return false;
    if (u.expires && Date.now() > u.expires) return false;
    return true;
  }

  async create(username, password, { admin = false, groups, createdBy, note, expires } = {}) {
    if (!this.validName(username)) throw new Error('Benutzername: 2–24 Zeichen, Buchstaben/Zahlen/._-');
    const bad = checkPassword(password, username);
    if (bad) throw new Error(bad);
    if (this.find(username)) throw new Error('Benutzername ist schon vergeben');
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt);
    const d = this.data;
    const owner = admin && !d.users.some((u) => u.owner);
    d.users.push({
      username, admin: !!admin, owner, salt: salt.toString('hex'), hash: hash.toString('hex'), created: Date.now(),
      groups: Array.isArray(groups) ? groups : [], createdBy: createdBy || null, note: note || '', expires: expires || null,
    });
    this.db.save();
    return this.find(username);
  }

  update(username, patch) {
    const u = this.find(username);
    if (!u) throw new Error('Benutzer nicht gefunden');
    if ('groups' in patch) u.groups = [...new Set((patch.groups || []).map(String))];
    if ('note' in patch) u.note = String(patch.note || '').slice(0, 500);
    if ('disabled' in patch) {
      if (u.owner && patch.disabled) throw new Error('Der Haupt-Admin kann nicht gesperrt werden');
      u.disabled = !!patch.disabled;
    }
    if ('expires' in patch) {
      if (u.owner && patch.expires) throw new Error('Der Haupt-Admin kann nicht ablaufen');
      const e = patch.expires ? Number(patch.expires) : null;
      if (e != null && !Number.isFinite(e)) throw new Error('Ungültiges Ablaufdatum');
      u.expires = e;
    }
    if ('admin' in patch) {
      if (u.owner && !patch.admin) throw new Error('Der Haupt-Admin bleibt Admin');
      u.admin = !!patch.admin;
    }
    this.db.save();
    return u;
  }

  touchLogin(username) {
    const u = this.find(username);
    if (!u) return;
    u.lastLogin = Date.now();
    this.db.save();
  }

  async setPassword(username, password) {
    const u = this.find(username);
    if (!u) throw new Error('Benutzer nicht gefunden');
    const bad = checkPassword(password, u.username);
    if (bad) throw new Error(bad);
    const salt = crypto.randomBytes(16);
    u.salt = salt.toString('hex');
    u.hash = (await scrypt(password, salt)).toString('hex');
    u.pwChanged = Date.now();
    this.db.save();
  }

  setAdmin(username, admin) { this.update(username, { admin }); }

  remove(username) {
    const u = this.find(username);
    if (!u) throw new Error('Benutzer nicht gefunden');
    if (u.owner) throw new Error('Der Haupt-Admin kann nicht gelöscht werden');
    const d = this.data;
    d.users = d.users.filter((x) => x !== u);
    this.db.save();
  }

  /** Gruppe aus allen Konten entfernen (beim Löschen der Gruppe). */
  dropGroup(id) {
    let changed = false;
    for (const u of this.data.users) {
      if (Array.isArray(u.groups) && u.groups.includes(id)) { u.groups = u.groups.filter((g) => g !== id); changed = true; }
    }
    if (changed) this.db.save();
  }

  async verify(username, password) {
    const u = this.find(username);
    // auch bei unbekanntem Namen rechnen → keine Rückschlüsse über die Antwortzeit
    const salt = u ? Buffer.from(u.salt, 'hex') : this.dummySalt;
    const hash = await scrypt(password, salt);
    if (!u) return null;
    return crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex')) ? u : null;
  }

  /* ---------- Einladungen ---------- */

  inviteUses(i) {
    if (Array.isArray(i.usedBy)) return i.usedBy;
    return i.usedBy ? [i.usedBy] : [];
  }

  inviteValid(i) {
    return !!(i && !i.revoked && i.expires > Date.now() && this.inviteUses(i).length < (i.maxUses || 1));
  }

  createInvite(by, hoursOrOpts = 72) {
    const opts = typeof hoursOrOpts === 'object' ? hoursOrOpts : { hours: hoursOrOpts };
    const hours = Math.min(Math.max(Number(opts.hours) || 72, 1), 24 * 90);
    const d = this.data;
    const now = Date.now();
    // abgelaufene/verbrauchte nach 30 Tagen wegräumen
    d.invites = (d.invites || []).filter((i) => this.inviteValid(i) || now - (i.expires || 0) < 30 * 86400000);
    const code = crypto.randomBytes(12).toString('base64url');
    const days = Math.min(Math.max(Number(opts.expiresDays) || 0, 0), 3650);
    d.invites.push({
      code, by, created: now, expires: now + hours * 3600 * 1000,
      maxUses: Math.min(Math.max(Number(opts.uses) || 1, 1), 100),
      group: opts.group || null, note: String(opts.note || '').slice(0, 200), usedBy: [],
      expiresDays: days || null,
    });
    this.db.save();
    return code;
  }

  listInvites() {
    return (this.data.invites || []).map((i) => ({
      code: i.code, by: i.by, created: i.created, expires: i.expires, maxUses: i.maxUses || 1,
      usedBy: this.inviteUses(i), group: i.group || null, note: i.note || '', revoked: !!i.revoked, valid: this.inviteValid(i),
      expiresDays: i.expiresDays || null,
    })).sort((a, b) => b.created - a.created);
  }

  revokeInvite(code) {
    const i = (this.data.invites || []).find((x) => x.code === code);
    if (!i) throw new Error('Einladung nicht gefunden');
    i.revoked = true;
    this.db.save();
  }

  checkInvite(code) {
    return this.inviteValid((this.data.invites || []).find((x) => x.code === code));
  }

  async redeemInvite(code, username, password, defaultGroups = []) {
    if (!this.checkInvite(code)) throw new Error('Einladung ungültig oder abgelaufen');
    const inv = this.data.invites.find((x) => x.code === code);
    const expires = inv.expiresDays ? Date.now() + inv.expiresDays * 86400000 : null;
    const u = await this.create(username, password, {
      groups: inv.group ? [inv.group] : defaultGroups, createdBy: `Einladung von ${inv.by}`, expires,
    });
    const i = this.data.invites.find((x) => x.code === code);
    i.usedBy = [...this.inviteUses(i), u.username];
    i.usedAt = Date.now();
    this.db.save();
    return u;
  }
}

/** Sitzungs-Token werden nur als SHA-256 gespeichert – ein geleakter Datenordner verrät keine gültigen Cookies. */
function tokenHash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

class SessionStore {
  constructor(dir, ttlMs) {
    this.ttl = ttlMs;
    this.db = new JsonFile(path.join(dir, 'sessions.json'), {});
    this.dirty = false;
    this.migrate();
    setInterval(() => this.flush(), 30000).unref();
  }
  get map() { return this.db.data; }
  /** Alte Sitzungen (Klartext-Schlüssel) auf Hashes umstellen, ohne dass jemand rausfliegt. */
  migrate() {
    let changed = false;
    for (const [k, s] of Object.entries(this.map)) {
      if (s.hashed) continue;
      const h = tokenHash(k);
      delete this.map[k];
      this.map[h] = { ...s, id: h, hashed: true };
      changed = true;
    }
    if (changed) this.flush(true);
  }
  /** Neue Sitzung. Das Cookie-Token steht nur in session.token (wird nicht gespeichert). */
  create(user, meta = {}) {
    const token = crypto.randomBytes(24).toString('hex');
    const id = tokenHash(token);
    this.map[id] = { id, hashed: true, username: user.username, name: user.username, created: Date.now(), lastSeen: Date.now(), ua: String(meta.ua || '').slice(0, 200), ip: meta.ip || null };
    this.flush(true);
    const s = this.map[id];
    Object.defineProperty(s, 'token', { value: token, enumerable: false, configurable: true });
    return s;
  }
  get(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const id = tokenHash(token);
    const s = Object.prototype.hasOwnProperty.call(this.map, id) ? this.map[id] : null;
    if (!s) return null;
    if (Date.now() - s.lastSeen > this.ttl) { this.delete(id); return null; }
    if (Date.now() - s.lastSeen > 60000) { s.lastSeen = Date.now(); this.dirty = true; }
    return s;
  }
  delete(id) { delete this.map[id]; this.flush(true); }
  forUser(username) {
    const n = String(username).toLowerCase();
    return Object.values(this.map).filter((s) => s.username.toLowerCase() === n);
  }
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

module.exports = { UserStore, SessionStore, JsonFile };

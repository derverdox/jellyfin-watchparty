'use strict';
/** Einstellungen und gespeicherte Anmeldung (Sitzungs-Cookie verschlüsselt). */
const fs = require('fs');
const path = require('path');

const DEFAULT_PREFS = {
  quality: 'auto',
  audioLang: '',
  subLang: 'off', // '' (alte Einstellungen) zählt ebenfalls als aus
  volume: 100,
  fullscreen: true,
  embed: true, // mpv als Kindfenster ins Hauptfenster einbetten (nur Windows)
  screen: 'auto',
  osdChat: true,
  framegen: { enabled: false, model: 'v4_26', target: 'display', scene: 0.12 },
  vsr: { enabled: false, hdr: false },
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

class Settings {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'settings.json');
    this.safe = safeStorage;
    this.data = { server: '', username: '', session: null, prefs: DEFAULT_PREFS, setupDone: false };
    try { this.data = merge(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* erster Start */ }
    this.data.prefs = merge(DEFAULT_PREFS, this.data.prefs);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get prefs() { return this.data.prefs; }
  setPrefs(patch) { this.data.prefs = merge(this.data.prefs, patch); this.save(); return this.data.prefs; }

  getSession() {
    const s = this.data.session;
    if (!s) return null;
    try {
      if (s.enc && this.safe && this.safe.isEncryptionAvailable()) return this.safe.decryptString(Buffer.from(s.enc, 'base64'));
      if (s.plain) return s.plain;
    } catch { /* kaputt → neu anmelden */ }
    return null;
  }

  setSession(sid) {
    if (!sid) this.data.session = null;
    else if (this.safe && this.safe.isEncryptionAvailable()) this.data.session = { enc: this.safe.encryptString(sid).toString('base64') };
    else this.data.session = { plain: sid };
    this.save();
  }
}

module.exports = { Settings, DEFAULT_PREFS, merge };

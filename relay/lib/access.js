'use strict';
/*
 * Gruppen, Rechte und Inhaltszugriff.
 *
 * Jede Gruppe hat Rechte (was darf man im Raum tun) und eine Inhaltsregel:
 *   all   – alles
 *   only  – nur die gewählten Bibliotheken/Ordner/Serien (inkl. allem darunter)
 *   except – alles außer den gewählten
 * Ein Konto kann in mehreren Gruppen sein: es reicht, wenn EINE Gruppe etwas
 * erlaubt. Admins dürfen immer alles. Konten ohne Gruppe bekommen die
 * Standardgruppe aus den Einstellungen.
 */
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./users');

const PERMISSIONS = [
  { key: 'createRoom', label: 'Räume erstellen', desc: 'Eigene Räume aufmachen' },
  { key: 'control', label: 'Steuern', desc: 'Play, Pause und Spulen, wenn der Host es allen erlaubt' },
  { key: 'load', label: 'Filme auswählen', desc: 'Etwas für den ganzen Raum starten' },
  { key: 'suggest', label: 'Vorschlagen', desc: 'Filme im Chat vorschlagen' },
  { key: 'chat', label: 'Chatten', desc: 'Nachrichten und Reaktionen' },
  { key: 'invite', label: 'Freunde einladen', desc: 'Einladungslinks für neue Konten erstellen' },
  { key: 'direct', label: 'Originalqualität', desc: 'Datei unverändert abspielen (braucht am meisten Upload)' },
  { key: 'wish', label: 'Wünsche', desc: 'Auf dem schwarzen Brett Titel wünschen, abstimmen und taggen' },
];
// Rechte, die neu dazugekommen sind: in alten Gruppen gelten sie als erlaubt
const NEW_DEFAULT_ON = new Set(['wish']);
const PERM_KEYS = PERMISSIONS.map((p) => p.key);
const BITRATES = [1500000, 3000000, 6000000, 10000000, 20000000, 40000000];
const ID_RE = /^[a-f0-9]{32}$|^[a-f0-9-]{36}$/i;

function allPerms(v) { return Object.fromEntries(PERM_KEYS.map((k) => [k, v])); }

const DEFAULT_DATA = {
  groups: [
    {
      id: 'standard', name: 'Standard', color: '#f2b544', builtin: true,
      description: 'Normale Zuschauer', perms: { ...allPerms(true), invite: false },
      maxBitrate: 40000000, access: { mode: 'all', ids: [] },
    },
    {
      id: 'gaeste', name: 'Gäste', color: '#7aa7ff', builtin: false,
      description: 'Dürfen mitschauen und chatten, aber nichts auswählen', perms: { ...allPerms(false), chat: true, suggest: true },
      maxBitrate: 10000000, access: { mode: 'all', ids: [] },
    },
  ],
  settings: { defaultGroup: 'standard', maintenance: false, motd: '', invitesEnabled: true, maxRoomsPerUser: 3 },
};

function cleanGroup(input, existing = {}) {
  const g = { ...existing };
  if ('name' in input) {
    const name = String(input.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    if (!name) throw new Error('Name fehlt');
    g.name = name;
  }
  if ('description' in input) g.description = String(input.description || '').slice(0, 200);
  if ('color' in input) g.color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#9a9aab';
  if ('perms' in input) {
    g.perms = { ...(g.perms || allPerms(false)) };
    for (const k of PERM_KEYS) if (k in (input.perms || {})) g.perms[k] = !!input.perms[k];
  }
  if ('maxBitrate' in input) {
    const b = Number(input.maxBitrate);
    g.maxBitrate = BITRATES.includes(b) ? b : 40000000;
  }
  if ('access' in input) {
    const a = input.access || {};
    const mode = ['all', 'only', 'except'].includes(a.mode) ? a.mode : 'all';
    const ids = [...new Set((a.ids || []).map(String).filter((x) => ID_RE.test(x)).map((x) => x.toLowerCase().replace(/-/g, '')))].slice(0, 500);
    const labels = {};
    for (const id of ids) if (a.labels && a.labels[id]) labels[id] = String(a.labels[id]).slice(0, 120);
    g.access = { mode, ids, labels };
  }
  return g;
}

class GroupStore {
  constructor(dir) {
    this.db = new JsonFile(path.join(dir, 'groups.json'), DEFAULT_DATA);
    const d = this.data;
    if (!d.settings) d.settings = { ...DEFAULT_DATA.settings };
    d.settings = { ...DEFAULT_DATA.settings, ...d.settings };
    if (!Array.isArray(d.groups) || !d.groups.length) d.groups = structuredClone(DEFAULT_DATA.groups);
    if (!require('fs').existsSync(this.db.file)) this.db.save();
  }

  get data() { return this.db.load(); }
  get settings() { return this.data.settings; }
  list() { return this.data.groups; }
  get(id) { return this.data.groups.find((g) => g.id === id) || null; }

  create(input) {
    const g = cleanGroup({ perms: {}, maxBitrate: 40000000, access: { mode: 'all', ids: [] }, color: '#9a9aab', description: '', ...input });
    g.id = crypto.randomBytes(5).toString('hex');
    g.builtin = false;
    this.data.groups.push(g);
    this.db.save();
    return g;
  }

  update(id, input) {
    const d = this.data;
    const i = d.groups.findIndex((g) => g.id === id);
    if (i < 0) throw new Error('Gruppe nicht gefunden');
    d.groups[i] = cleanGroup(input, d.groups[i]);
    this.db.save();
    return d.groups[i];
  }

  remove(id) {
    const g = this.get(id);
    if (!g) throw new Error('Gruppe nicht gefunden');
    if (g.builtin) throw new Error('Die Standardgruppe kann nicht gelöscht werden');
    if (this.settings.defaultGroup === id) throw new Error('Das ist die Standardgruppe für neue Konten – erst eine andere festlegen');
    this.data.groups = this.data.groups.filter((x) => x.id !== id);
    this.db.save();
  }

  setSettings(patch) {
    const s = this.data.settings;
    if ('defaultGroup' in patch) {
      if (!this.get(patch.defaultGroup)) throw new Error('Gruppe nicht gefunden');
      s.defaultGroup = patch.defaultGroup;
    }
    if ('maintenance' in patch) s.maintenance = !!patch.maintenance;
    if ('invitesEnabled' in patch) s.invitesEnabled = !!patch.invitesEnabled;
    if ('motd' in patch) s.motd = String(patch.motd || '').slice(0, 500);
    if ('maxRoomsPerUser' in patch) s.maxRoomsPerUser = Math.min(Math.max(parseInt(patch.maxRoomsPerUser, 10) || 0, 0), 50);
    this.db.save();
    return s;
  }

  /** Gruppen eines Kontos (ohne Gruppe → Standardgruppe). */
  groupsOf(user) {
    const ids = (user && Array.isArray(user.groups) && user.groups.length) ? user.groups : [this.settings.defaultGroup];
    const out = ids.map((id) => this.get(id)).filter(Boolean);
    return out.length ? out : [this.get(this.settings.defaultGroup) || this.list()[0]].filter(Boolean);
  }

  /** Effektive Rechte & Inhaltsregeln eines Kontos. */
  resolve(user) {
    if (user && user.admin) {
      return { admin: true, perms: allPerms(true), maxBitrate: 40000000, rules: null, groups: this.groupsOf(user).map((g) => g.id) };
    }
    const groups = this.groupsOf(user);
    const perms = allPerms(false);
    let maxBitrate = 0;
    for (const g of groups) {
      for (const k of PERM_KEYS) if (g.perms && (g.perms[k] ?? NEW_DEFAULT_ON.has(k))) perms[k] = true;
      maxBitrate = Math.max(maxBitrate, g.maxBitrate || 0);
    }
    const rules = groups.map((g) => ({ mode: (g.access && g.access.mode) || 'all', ids: new Set(((g.access && g.access.ids) || []).map(norm)) }));
    const unrestricted = rules.some((r) => r.mode === 'all' || (r.mode === 'except' && !r.ids.size));
    return { admin: false, perms, maxBitrate: maxBitrate || 1500000, rules: unrestricted ? null : rules, groups: groups.map((g) => g.id) };
  }
}

function norm(id) { return String(id || '').toLowerCase().replace(/-/g, ''); }

/**
 * Prüft Zugriff anhand der Vorfahren-Kette eines Elements (inkl. sich selbst).
 * chain: Array von IDs vom Element bis zur Bibliothek.
 */
function allowedByChain(resolved, chain) {
  if (!resolved.rules) return true;
  const ids = chain.map(norm);
  return resolved.rules.some((r) => {
    const hit = ids.some((id) => r.ids.has(id));
    if (r.mode === 'only') return hit;
    if (r.mode === 'except') return !hit;
    return true;
  });
}

/** Freigegebene Wurzeln (für die Startseite der Bibliothek bei „nur …“-Gruppen). */
function allowedRoots(resolved) {
  if (!resolved.rules) return null;
  const roots = new Set();
  for (const r of resolved.rules) if (r.mode === 'only') for (const id of r.ids) roots.add(id);
  return roots;
}

module.exports = { GroupStore, PERMISSIONS, PERM_KEYS, BITRATES, allowedByChain, allowedRoots, norm };

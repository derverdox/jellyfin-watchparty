'use strict';
/*
 * Persönliche Merkliste und Verlauf („Zuletzt geschaut“) pro Konto,
 * plus die Bewertung für die Bibliothekssuche.
 */
const path = require('path');
const { JsonFile } = require('./users');

const MAX_LIST = 500;
const MAX_HISTORY = 60;

class LibraryStore {
  constructor(dir) {
    this.db = new JsonFile(path.join(dir, 'library.json'), { users: {} });
    this.dirty = false;
    setInterval(() => this.flush(), 30000).unref();
  }

  get data() { return this.db.load(); }
  entry(username) {
    const k = String(username).toLowerCase();
    const d = this.data;
    if (!d.users[k]) d.users[k] = { list: [], history: [] };
    return d.users[k];
  }
  flush(force) {
    if (!force && !this.dirty) return;
    this.dirty = false;
    try { this.db.save(); } catch (e) { console.error('[library] nicht gespeichert:', e.message); }
  }

  list(username) { return this.entry(username).list; }
  has(username, id) { return this.entry(username).list.some((x) => x.id === id); }

  add(username, id) {
    const e = this.entry(username);
    if (e.list.some((x) => x.id === id)) return false;
    e.list.unshift({ id, added: Date.now() });
    if (e.list.length > MAX_LIST) e.list.length = MAX_LIST;
    this.flush(true);
    return true;
  }

  remove(username, id) {
    const e = this.entry(username);
    const before = e.list.length;
    e.list = e.list.filter((x) => x.id !== id);
    if (e.list.length !== before) this.flush(true);
    return e.list.length !== before;
  }

  /** Fortschritt merken (wird alle paar Sekunden für alle Zuschauenden aufgerufen). */
  progress(username, item, pos) {
    const e = this.entry(username);
    let h = e.history.find((x) => x.id === item.id);
    if (!h) { h = { id: item.id }; e.history.unshift(h); }
    else { e.history = [h, ...e.history.filter((x) => x !== h)]; }
    Object.assign(h, { mediaSourceId: item.mediaSourceId || null, title: item.title, subtitle: item.subtitle || '', type: item.type, runtime: item.runtime || null, pos: Math.round(pos), at: Date.now() });
    if (item.runtime && pos / item.runtime >= 0.9 && !this.isWatched(username, item.id)) this.watchedMap(username)[item.id] = Date.now();
    if (e.history.length > MAX_HISTORY) e.history.length = MAX_HISTORY;
    this.dirty = true;
  }

  history(username) { return this.entry(username).history; }

  /* ---------- Gesehen ---------- */

  watchedMap(username) {
    const e = this.entry(username);
    if (!e.watched) e.watched = {};
    return e.watched;
  }
  isWatched(username, id) { return !!this.watchedMap(username)[id]; }
  setWatched(username, ids, on) {
    const w = this.watchedMap(username);
    for (const id of ids) { if (on) w[id] = w[id] || Date.now(); else delete w[id]; }
    this.flush(true);
  }

  /** Zeit pro Titel bzw. Serie und aktive Tage (fürs Profil). */
  addTime(username, item, seconds) {
    const e = this.entry(username);
    if (!e.time) e.time = {};
    const key = item.seriesId || item.id;
    const t = e.time[key] || (e.time[key] = { title: item.seriesName || item.title, type: item.seriesId ? 'Series' : item.type, seconds: 0 });
    t.seconds += seconds;
    if (!e.days) e.days = {};
    const d = new Date();
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    e.days[k] = (e.days[k] || 0) + seconds;
    this.dirty = true;
  }
  profileData(username) {
    const e = this.entry(username);
    return { time: e.time || {}, days: e.days || {}, watched: e.watched || {} };
  }

  /* ---------- Bewertungen (anonym: nur Schnitt + Anzahl nach außen) ---------- */

  ratingsDb() {
    const d = this.data;
    if (!d.ratings) d.ratings = {};
    return d.ratings;
  }
  rate(username, id, score) {
    const r = this.ratingsDb();
    const k = String(username).toLowerCase();
    if (!r[id]) r[id] = {};
    if (score == null) delete r[id][k];
    else r[id][k] = Math.min(10, Math.max(1, Math.round(Number(score))));
    if (!Object.keys(r[id]).length) delete r[id];
    this.flush(true);
    return this.rating(username, id);
  }
  rating(username, id) {
    const r = this.ratingsDb()[id] || {};
    const vals = Object.values(r);
    const k = String(username || '').toLowerCase();
    return { avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null, count: vals.length, mine: r[k] || null };
  }
  topRated(limit = 60) {
    return Object.entries(this.ratingsDb()).map(([id, r]) => {
      const v = Object.values(r);
      return { id, avg: v.reduce((a, b) => a + b, 0) / v.length, count: v.length };
    }).sort((a, b) => b.avg - a.avg || b.count - a.count).slice(0, limit);
  }

  clearHistory(username, id) {
    const e = this.entry(username);
    e.history = id ? e.history.filter((x) => x.id !== id) : [];
    this.flush(true);
  }
}

/* ---------------- Suche ---------------- */

/** Für den Vergleich: klein, ohne Akzente, ß→ss, Satzzeichen weg. */
function fold(s) {
  return String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Varianten der Eingabe, damit Jellyfin auch „Rueckkehr“ ↔ „Rückkehr“, „Strasse“ ↔ „Straße“ findet. */
function variants(q) {
  const base = String(q || '').trim();
  const out = new Set([base]);
  out.add(base.replace(/ae/gi, 'ä').replace(/oe/gi, 'ö').replace(/ue/gi, 'ü'));
  out.add(base.replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue'));
  out.add(base.replace(/ss/g, 'ß'));
  out.add(base.replace(/ß/g, 'ss'));
  out.add(base.normalize('NFD').replace(/[̀-ͯ]/g, ''));
  // Längstes Wort allein (Jellyfin sucht nur am Stück): „herr ringe“ findet so „Der Herr der Ringe“
  const words = base.split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
  if (words.length > 1) out.add(words[0]);
  return [...out].filter((x) => x && x.length >= 2).slice(0, 6);
}

/** Jahr aus der Eingabe ziehen: „matrix 1999“ → { text: 'matrix', year: 1999 } */
function parseQuery(q) {
  const m = /\b(19[2-9]\d|20[0-4]\d)\b/.exec(q);
  const year = m ? Number(m[1]) : null;
  const text = (m ? q.replace(m[0], ' ') : q).replace(/\s+/g, ' ').trim();
  return { text: text || (year ? String(year) : ''), year };
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Relevanz eines Treffers (höher = besser, 0 = kein Treffer). */
function score(item, text, year) {
  const q = fold(text);
  if (!q) return year && item.year === year ? 50 : 0;
  const names = [item.name, item.seriesName, item.originalTitle].filter(Boolean).map(fold);
  let best = 0;
  const qw = q.split(' ');
  for (const n of names) {
    let s = 0;
    if (n === q) s = 100;
    else if (n.startsWith(q)) s = 85;
    else if (n.split(' ').some((w) => w.startsWith(q))) s = 70;
    else if (n.includes(q)) s = 55;
    else {
      const nw = n.split(' ');
      const all = qw.every((w) => nw.some((x) => x.startsWith(w) || (w.length >= 5 && lev(w, x) <= 1)));
      if (all) s = 45;
      else if (qw.some((w) => w.length >= 4 && nw.some((x) => lev(w, x) <= 1))) s = 25;
    }
    if (n !== fold(item.name)) s -= 8; // Treffer nur im Seriennamen etwas tiefer
    best = Math.max(best, s);
  }
  if (!best) return 0;
  if (year) best += item.year === year ? 20 : -30;
  if (item.type === 'Movie' || item.type === 'Series') best += 4;
  return best;
}

module.exports = { LibraryStore, fold, variants, parseQuery, score };

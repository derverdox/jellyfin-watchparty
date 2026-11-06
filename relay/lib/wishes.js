'use strict';
/*
 * Schwarzes Brett: Wünsche für neue Filme/Serien, mit Stimmen und Tags.
 * Status: open → progress → done (verfügbar) | rejected.
 */
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./users');
const { fold } = require('./library');

const STATUSES = ['open', 'progress', 'done', 'rejected'];

function cleanTag(t) {
  return String(t || '').replace(/[\u0000-\u001f<>#,]/g, '').trim().toLowerCase().slice(0, 24);
}

class WishStore {
  constructor(dir) {
    this.db = new JsonFile(path.join(dir, 'wishes.json'), { wishes: [] });
  }
  get list() { return this.db.load().wishes; }
  save() { this.db.save(); }
  get(id) { return this.list.find((w) => w.id === id) || null; }

  create(username, input) {
    const title = String(input.title || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120);
    if (title.length < 2) throw new Error('Titel fehlt');
    const year = input.year ? parseInt(input.year, 10) : null;
    if (year != null && !(year >= 1900 && year <= 2100)) throw new Error('Ungültiges Jahr');
    const type = ['movie', 'series'].includes(input.type) ? input.type : 'movie';
    // Aus Vorschlägen übernommene Felder (TMDb) – validieren, dann mitführen
    const tmdbId = Number(input.tmdbId) > 0 ? Number(input.tmdbId) : null;
    const imdbId = /^tt\d{7,10}$/.test(String(input.imdbId || '')) ? String(input.imdbId) : null;
    const poster = /^https:\/\/image\.tmdb\.org\/[a-z0-9_/.-]{1,120}$/.test(String(input.poster || '')) ? String(input.poster) : null;
    const dup = tmdbId
      ? this.list.find((w) => w.status !== 'rejected' && w.tmdbId === tmdbId)
      : this.list.find((w) => w.status !== 'rejected' && fold(w.title) === fold(title) && (!year || !w.year || w.year === year));
    if (dup) { const e = new Error('Das wünscht sich schon jemand – gib dort deine Stimme ab'); e.wish = dup.id; throw e; }
    const mine = this.list.filter((w) => w.by === username && w.status === 'open').length;
    if (mine >= 30) throw new Error('Du hast schon 30 offene Wünsche');
    const w = {
      id: crypto.randomBytes(5).toString('hex'), title, year, type, tmdbId, imdbId, poster,
      note: String(input.note || '').slice(0, 500), by: username, created: Date.now(),
      votes: [username], tags: {}, status: 'open', statusNote: '', libraryItemId: null, doneAt: null, seenBy: [],
    };
    for (const t of (input.tags || []).slice(0, 5)) { const c = cleanTag(t); if (c) w.tags[c] = [username]; }
    this.list.push(w);
    this.save();
    return w;
  }

  vote(username, id) {
    const w = this.get(id);
    if (!w) throw new Error('Wunsch nicht gefunden');
    const i = w.votes.indexOf(username);
    if (i >= 0) w.votes.splice(i, 1); else w.votes.push(username);
    this.save();
    return w;
  }

  tag(username, id, tag) {
    const w = this.get(id);
    if (!w) throw new Error('Wunsch nicht gefunden');
    const t = cleanTag(tag);
    if (!t) throw new Error('Tag fehlt');
    if (!w.tags[t]) {
      if (Object.keys(w.tags).length >= 12) throw new Error('Zu viele Tags');
      w.tags[t] = [];
    }
    const i = w.tags[t].indexOf(username);
    if (i >= 0) w.tags[t].splice(i, 1); else w.tags[t].push(username);
    if (!w.tags[t].length) delete w.tags[t];
    this.save();
    return w;
  }

  update(id, patch, { admin, username }) {
    const w = this.get(id);
    if (!w) throw new Error('Wunsch nicht gefunden');
    const own = w.by === username;
    if ('status' in patch) {
      if (!admin) throw new Error('Nur Admins ändern den Status');
      if (!STATUSES.includes(patch.status)) throw new Error('Ungültiger Status');
      w.status = patch.status;
      w.statusNote = String(patch.statusNote || '').slice(0, 300);
      if (patch.status === 'done') w.doneAt = w.doneAt || Date.now();
      if (patch.libraryItemId !== undefined) w.libraryItemId = patch.libraryItemId || null;
    }
    if ('note' in patch) {
      if (!admin && !own) throw new Error('Nur der Ersteller kann die Notiz ändern');
      w.note = String(patch.note || '').slice(0, 500);
    }
    this.save();
    return w;
  }

  remove(id, { admin, username }) {
    const w = this.get(id);
    if (!w) throw new Error('Wunsch nicht gefunden');
    if (!admin && !(w.by === username && w.votes.filter((v) => v !== username).length === 0)) throw new Error('Nur Admins (oder du, solange niemand anderes abgestimmt hat) können löschen');
    this.db.load().wishes = this.list.filter((x) => x !== w);
    this.save();
  }

  /** Öffentliche Sicht: wer gewünscht hat, ist sichtbar; Stimmen nur als Zahl + „ich“. */
  view(w, username) {
    return {
      id: w.id, title: w.title, year: w.year, type: w.type, note: w.note, by: w.by, created: w.created,
      poster: w.poster || null, imdbId: w.imdbId || null,
      votes: w.votes.length, voted: w.votes.includes(username),
      tags: Object.entries(w.tags).map(([tag, us]) => ({ tag, votes: us.length, voted: us.includes(username) })).sort((a, b) => b.votes - a.votes),
      status: w.status, statusNote: w.statusNote, libraryItemId: w.libraryItemId, doneAt: w.doneAt,
    };
  }

  /** Erfüllte Wünsche, für die jemand gestimmt hat und die er noch nicht gesehen hat. */
  news(username) {
    return this.list.filter((w) => w.status === 'done' && w.votes.includes(username) && !w.seenBy.includes(username));
  }
  markSeen(username) {
    let changed = false;
    for (const w of this.news(username)) { w.seenBy.push(username); changed = true; }
    if (changed) this.save();
  }
}

module.exports = { WishStore, STATUSES, cleanTag };

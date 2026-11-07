'use strict';
/*
 * Warteliste ("Bewerbungen") + Förder-Heft (inoffizielle Beitrags-Bookkeeping).
 *
 * Warteliste: Leute ohne Konto können sich auf der Login-Seite bewerben.
 * Ein Admin sieht die Bewerbungen im Verwaltungspanel und kann eine annehmen –
 * dabei entsteht ein normaler Einladungslink (mit optionaler Laufzeit), den der
 * Admin dem Bewerber privat zuschickt. Eine öffentliche Registrierung gibt es
 * weiterhin nicht.
 *
 * Das Förder-Heft ist reine Buchhaltung: Einzahlungen laufen komplett extern
 * (Überweisung, PayPal an Freunde, bar …). Hier wird nur notiert, wer wann
 * wie viel beigesteuert hat und welche Laufzeit das Konto dadurch bekommt.
 * Es wird NICHTS automatisiert abgebucht und keine Zahlungs-API angebunden.
 */
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./users');

const DAY = 86400000;

function clean(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

class WaitlistStore {
  constructor(dir) {
    this.db = new JsonFile(path.join(dir, 'waitlist.json'), { entries: [] });
  }

  get data() { return this.db.load(); }

  list() {
    return [...this.data.entries].sort((a, b) => b.created - a.created);
  }

  pendingCount() { return this.data.entries.filter((e) => e.status === 'pending').length; }

  get(id) { return this.data.entries.find((e) => e.id === id) || null; }

  /** Neue Bewerbung (von der Login-Seite, ohne Konto). */
  add({ name, contact, message }) {
    const n = clean(name, 40);
    if (n.length < 2) throw new Error('Sag bitte, wie du heißt.');
    const c = clean(contact, 120);
    const msg = clean(message, 1000);
    if (msg.length < 5) throw new Error('Ein paar Sätze, warum du reinschauen willst, schon.');
    const open = this.data.entries.filter((e) => e.status === 'pending');
    const key = n.toLowerCase();
    if (open.some((e) => e.name.toLowerCase() === key)) throw new Error('Für diesen Namen ist gerade schon eine Bewerbung offen.');
    if (c && open.some((e) => e.contact && e.contact.toLowerCase() === c.toLowerCase())) throw new Error('Unter diesem Kontakt ist gerade schon eine Bewerbung offen.');
    const entry = {
      id: crypto.randomBytes(6).toString('base64url'),
      name: n, contact: c, message: msg,
      created: Date.now(), status: 'pending',
      reviewedBy: null, reviewedAt: null, reviewNote: '', inviteCode: null, suggestedUser: null,
    };
    this.data.entries.push(entry);
    this.db.save();
    return entry;
  }

  /** Bewerbung annehmen → es gehört genau ein Einladungslink dazu (vom Admin erzeugt). */
  accept(id, { by, inviteCode, suggestedUser, days, note }) {
    const e = this.get(id);
    if (!e) throw new Error('Bewerbung nicht gefunden');
    e.status = 'accepted';
    e.reviewedBy = by;
    e.reviewedAt = Date.now();
    e.reviewNote = clean(note, 300);
    e.inviteCode = inviteCode;
    e.suggestedUser = clean(suggestedUser, 24) || e.name;
    e.grantedDays = Math.max(0, Math.min(Number(days) || 0, 3650));
    this.db.save();
    return e;
  }

  reject(id, { by, note }) {
    const e = this.get(id);
    if (!e) throw new Error('Bewerbung nicht gefunden');
    e.status = 'rejected';
    e.reviewedBy = by;
    e.reviewedAt = Date.now();
    e.reviewNote = clean(note, 300);
    this.db.save();
    return e;
  }

  remove(id) {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    const removed = before !== this.data.entries.length;
    if (removed) this.db.save();
    return removed;
  }
}

class GrantStore {
  constructor(dir) {
    this.db = new JsonFile(path.join(dir, 'grants.json'), { grants: [] });
  }

  get data() { return this.db.load(); }

  /** Laufzeit (Tagen) eines Kontos ausgehend von jetzt bzw. bestehender Laufzeit verlängern. */
  extend(user, days) {
    const d = Math.max(1, Math.min(Math.round(Number(days) || 0), 3650));
    const base = Math.max(Date.now(), user.expires || 0);
    return { days: d, from: user.expires || null, to: base + d * DAY };
  }

  /** Buchungseintrag: Geld floss extern, hier steht nur die Notiz + die Laufzeit. */
  add({ user, by, days, from, to, method, amount, ref, note }) {
    const g = {
      id: crypto.randomBytes(6).toString('base64url'),
      user: String(user || ''), by: String(by || ''), at: Date.now(),
      days: Math.max(0, Math.round(Number(days) || 0)),
      from: from || null, to: to || null,
      method: clean(method, 40) || 'sonstiges',
      amount: clean(amount, 40), ref: clean(ref, 120), note: clean(note, 300),
    };
    this.data.grants.push(g);
    // grobe Obergrenze gegen endloses Wachsen
    if (this.data.grants.length > 5000) this.data.grants = this.data.grants.slice(-5000);
    this.db.save();
    return g;
  }

  list(userFilter) {
    const list = userFilter ? this.data.grants.filter((g) => g.user.toLowerCase() === String(userFilter).toLowerCase()) : this.data.grants;
    return [...list].sort((a, b) => b.at - a.at);
  }
}

module.exports = { WaitlistStore, GrantStore };

'use strict';
/*
 * Titelvorschläge fürs Schwarze Brett (TMDb).
 *
 * Der Nutzer tippt einen Titel, wir fragen TMDb (Film + Serie) und anbieten:
 * Titel, Jahr, Typ und Poster – der Wunsch bekommt damit eine stabile
 * TMDB-ID, was saubere Duplikat-Erkennung und Poster auf dem Brett erlaubt.
 *
 * Der API-Zugang kommt aus der .env (Name: tmdb_api_key; Bewusst klein, ohne
 * Präfix – so wie er auch in der .env steht). Ohne Zugang liefert search()
 * einfach leer, das Brett funktioniert dann wie bisher.
 *
 * TMDb akzeptiert zwei Zugangsarten:
 *  - v3-API-Schlüssel (32 Hex-Zeichen)  → als Parameter api_key
 *  - v4-Lese-Token (JWT, beginnt mit „ey“) → als Header Authorization: Bearer
 * Beides gleich behandelt, damit jeder nehmen kann, was er im Portal sieht.
 */

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/w154';

class WishSearch {
  /**
   * @param {object} o
   * @param {string} [o.apiKey]   Zugang aus der .env (v3-Schlüssel oder v4-Token)
   * @param {string} [o.lang]     Sprache für Treffer (Standard: de)
   * @param {typeof fetch} [o.fetchImpl] für Tests austauschbar
   * @param {number} [o.ttlMs]    Cache-Dauer pro Abfrage
   */
  constructor({ apiKey = '', lang = 'de', fetchImpl, ttlMs = 10 * 60 * 1000, base = BASE } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.lang = lang;
    this.base = base;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.ttlMs = ttlMs;
    this.cache = new Map();   // query → { t, out }
    this.pending = new Map(); // query → Promise (doppelte Abfragen zusammenlegen)
  }

  get enabled() { return this.apiKey.length >= 20; }

  _headers() {
    const h = { Accept: 'application/json' };
    // v4-Lese-Token (JWT) wird per Header geschickt, der kurze v3-Schlüssel per URL
    if (/^ey[A-Za-z0-9_-]+\./.test(this.apiKey)) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  _params() {
    const p = { language: this.lang, include_adult: 'false' };
    if (!/^ey[A-Za-z0-9_-]+\./.test(this.apiKey)) p.api_key = this.apiKey;
    return p;
  }

  async _searchEp(path, q) {
    const p = new URLSearchParams({ ...this._params(), query: q });
    const r = await this.fetchImpl(`${this.base}${path}?${p}`, { headers: this._headers(), signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined });
    if (!r.ok) throw new Error(`TMDb: HTTP ${r.status}`);
    const j = await r.json();
    return (j.results || []).filter((x) => x && (x.title || x.name));
  }

  /** Ein TMDb-Treffer → unser Vorschlagsobjekt. tmdbType: 'movie' | 'tv' */
  static mapResult(x, tmdbType) {
    const tv = tmdbType === 'tv';
    const date = tv ? x.first_air_date : x.release_date;
    const year = date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
    return {
      title: x.title || x.name || '',
      year,
      type: tv ? 'series' : 'movie',
      tmdbId: x.id,
      imdbId: x.imdb_id || null, // in Suchoptionen manchmal vorhanden – mitnehmen wenn da
      poster: x.poster_path ? `${IMG}${x.poster_path}` : null,
    };
  }

  /**
   * @param {string} q     Nutzereingabe
   * @param {string} [type] 'movie' | 'series' | '' (beides)
   * @returns {Promise<Array<{title,year,type,tmdbId,imdbId,poster}>>}
   */
  async search(q, type = '') {
    if (!this.enabled) return [];
    const clean = String(q || '').trim().replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').slice(0, 100);
    if (clean.length < 2) return [];
    const key = `${type}|${clean.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.t < this.ttlMs) return hit.out;
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      try {
        const eps = type === 'movie' ? [['/search/movie', 'movie']]
          : type === 'series' ? [['/search/tv', 'tv']]
          : [['/search/movie', 'movie'], ['/search/tv', 'tv']];
        const parts = await Promise.all(eps.map(([ep, t]) => this._searchEp(ep, clean).then((xs) => xs.map((x) => WishSearch.mapResult(x, t)))));
        let out = parts.flat()
          .filter((x) => x.title)
          .slice(0, 8);
        // Jahr voranstellen bei gleichem Titel (Dup-Logik im Store unterscheidet nach Jahr)
        out.sort((a, b) => (b.year || 0) - (a.year || 0));
        this.cache.set(key, { t: Date.now(), out });
        if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
        return out;
      } catch {
        return []; // Vorschläge sind nur ein Bonus – nie das Brett daran scheitern lassen
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    return p;
  }
}

module.exports = { WishSearch, IMG };

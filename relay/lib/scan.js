'use strict';
/*
 * ISBN/EAN-Scan: Barcode → Produkt (extern) → Abgleich mit der Jellyfin-Bibliothek.
 *
 * Produktquellen – gezielte EAN-/ISBN-Datenbanken, keine Websuche:
 *   1. ean-search.org        – EAN/GS1-Datenbank, gute deutsche Medien-Abdeckung (API nötig)
 *   2. Open Library          – ISBN-Datenbank, gratis & ohne Key (nur 978er-Codes)
 *   3. Google Books          – reine ISBN-Datenbank, gratis mit eigenem API-Schlüssel (nur 978er)
 *   4. Discogs             – Barcode-Suche in der Tonträger-Datenbank (Fallback)
 * Bestätigte Barcodes werden lokal gemerkt (barcodes.json) und brauchen nie
 * wieder eine externe Abfrage.
 *
 * Format-Vergleich: Jellyfin pflegt kein Format-Feld, aber die Videohöhe ist
 * eindeutig: ≤576 = DVD (PAL; NTSC 480), ≥1080 = Blu-ray, ≥2160 = 4K-UHD.
 */
const fs = require('fs');
const path = require('path');
const { JsonFile } = require('./users');

const FETCH_TIMEOUT = 6000;
const UA = 'WatchpartyRelay/2 +https://github.com/PlatzZuDemHalter/jellyfin-watchparty';

/* ---------- Barcode-Normalisierung ---------- */

/** EAN-8 / EAN-13 / UPC-12 → kanonische 13-stellige Zahl; sonst null. */
function normalizeCode(raw) {
  let c = String(raw || '').replace(/[\s-]/g, '');
  if (/^\d{12}$/.test(c)) c = '0' + c; // UPC-A → EAN-13
  if (!/^\d{8}$|^\d{13}$/.test(c)) return null;
  return c;
}

/* ---------- Produkt-Erkennung aus dem Titel ---------- */

const SERIES_RE = /\b(staffel|season\w*|complete\w*|komplett\w*|collection|box ?set|boxset|gesamt|saga)\b/i;
const COMPLETE_RE = /\b(complete\w*|komplett\w*|gesamt(?:box|serie|folge)?)\b/i;
const FORMAT_WORDS = [
  ['uhd', /\b(4k|uhd|ultra\s?hd)\b/i],
  ['bluray', /\b(blu-?ray|bd)\b/i],
  ['dvd', /\bdvd\b/i],
];

/**
 * Text (Produkttitel + Quellen-Hints) → { kind, formats, seasons, complete }.
 * kind: 'series' (Staffel/Box) oder 'movie'.
 */
function classifyProduct(text) {
  const out = { kind: 'movie', formats: [], seasons: [], complete: false };
  if (SERIES_RE.test(text)) out.kind = 'series';
  if (COMPLETE_RE.test(text)) out.complete = true;
  for (const [f, re] of FORMAT_WORDS) if (re.test(text)) out.formats.push(f);
  if (out.formats.includes('uhd')) out.formats = out.formats.filter((f) => f !== 'bluray'); // „4K Ultra HD Blu-ray“ = UHD, kein normaler Blu-ray
  out.formats = [...new Set(out.formats)];
  // "Staffel 1-7", "Season 1 bis 4", "Staffel 3"
  const re = /\b(?:staffel|season)\w*\s*(\d{1,2})(?:\s*(?:-|–|—|bis|to)\s*(\d{1,2}))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    for (let s = Math.min(a, b); s <= Math.min(Math.max(a, b), 30); s++) out.seasons.push(s);
  }
  out.seasons = [...new Set(out.seasons)].sort((x, y) => x - y);
  return out;
}

/** Jellyfin-Videohöhe → Format (Lukas' Regel: DVD=576p, Blu-ray=1080p, UHD=4K). */
function formatOfHeight(h) {
  if (!h) return null;
  if (h >= 2160) return 'uhd';
  if (h >= 1080) return 'bluray';
  if (h <= 576) return 'dvd';
  return null; // 720p o. Ä.: Rip unbekannter Herkunft
}

/** Alle Formate eines Items aus MediaSources (Höhe + Namens-Hinweise). */
function formatsOfItem(item) {
  const set = new Set();
  for (const ms of item.MediaSources || []) {
    const v = (ms.MediaStreams || []).find((s) => s.Type === 'Video');
    const f = formatOfHeight(v && v.Height);
    if (f) set.add(f);
    const name = `${ms.Path || ''} ${ms.Name || ''}`;
    if (/\b4k|uhd|2160p\b/i.test(name)) set.add('uhd');
    else if (/\b1080p\b|bluray|blu-ray\b/i.test(name)) set.add('bluray');
    else if (/\b576p\b|dvd\b|video_ts/i.test(name)) set.add('dvd');
  }
  return [...set];
}

/* ---------- Produktquellen ---------- */

async function httpJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...(headers || {}) } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** ean-search.org Product API v1. */
async function queryEanSearch(code, cfg) {
  const d = await httpJson(`${cfg.eanSearchUrl}/api/v1/products-get?apikey=${encodeURIComponent(cfg.eanSearch)}&no-of-products=3&barcodes[]=${code}`);
  const list = (d && d.products) || [];
  return list.filter((x) => x && (x['product-name'] || x.productName)).map((x) => ({
    title: x['product-name'] || x.productName,
    brand: x['brand-name'] || x.brandName || '',
    year: null, formats: [], source: 'ean-search',
  }));
}

/** Open Library: ISBN-Datenbank, gratis ohne Key. Nur bei 978er-Codes sinnvoll. */
async function queryOpenLibrary(code, cfg) {
  const d = await httpJson(`${cfg.openLibraryUrl}/api/books?bibkeys=${encodeURIComponent('ISBN:' + code)}&format=json&jscmd=data`);
  const entry = d && d['ISBN:' + code];
  if (!entry || !entry.title) return [];
  return [{
    title: entry.title,
    brand: ((entry.publishers || [])[0] || {}).name || '',
    year: entry.publish_date ? ((/(19|20)\d{2}/.exec(entry.publish_date) || [])[0] || null) : null,
    formats: [], source: 'openlibrary',
    text: `${entry.title} ${entry.publishers ? entry.publishers.map((p) => p.name).join(' ') : ''}`,
  }];
}

/** Google Books (reine ISBN-Datenbank, kein Websuchen; nur mit eigenem Schlüssel). */
async function queryGoogleBooks(code, cfg) {
  const d = await httpJson(`${cfg.booksUrl}/books/v1/volumes?q=${encodeURIComponent('isbn:' + code)}&maxResults=3&key=${encodeURIComponent(cfg.books)}`);
  return ((d && d.items) || []).map((v) => {
    const vi = v.volumeInfo || {};
    return {
      title: vi.title || '',
      brand: (vi.authors || [])[0] || (vi.publisher || ''),
      year: vi.publishedDate ? ((/(19|20)\d{2}/.exec(vi.publishedDate) || [])[0] || null) : null,
      formats: [], source: 'google-books',
      text: `${vi.title || ''} ${(vi.description || '').slice(0, 200)}`,
    };
  }).filter((x) => x.title.length > 2);
}

/** Discogs: barcode-Suche (Tonträger/Ostings, manchmal auch Film-Physicals). */
async function queryDiscogs(code, cfg) {
  const q = cfg.discogs ? `&token=${encodeURIComponent(cfg.discogs)}` : '';
  const d = await httpJson(`${cfg.discogsUrl}/database/search?barcode=${code}&type=release&per_page=3${q}`);
  return ((d && d.results) || []).map((r) => ({
    title: (r.title || '').replace(/^Various\s*-\s*/i, ''),
    brand: (r.label || [])[0] || '',
    year: r.year ? String(r.year) : null,
    formats: (r.format || []).map((f) => String(f).toLowerCase()),
    source: 'discogs',
    text: `${r.title} ${(r.format || []).join(' ')}`,
  }));
}

/**
 * Alle konfigurierten Quellen der Reihe nach abfragen.
 * Liefert das erste Produkt mit brauchbarem Titel, mit Klassifikation.
 */
async function lookupProduct(code, cfg) {
  const isbn = /^(978|979)/.test(code);
  const enabled = [];
  if (cfg.eanSearch) enabled.push((c) => queryEanSearch(c, cfg));
  if (isbn) enabled.push((c) => queryOpenLibrary(c, cfg));
  if (isbn && cfg.books) enabled.push((c) => queryGoogleBooks(c, cfg));
  enabled.push((c) => queryDiscogs(c, cfg));
  for (const q of enabled) {
    const hits = await q(code);
    for (const h of hits) {
      const text = h.text || `${h.title} ${h.formats.join(' ')}`;
      if (!text.trim()) continue;
      const cls = classifyProduct(text);
      return {
        code, title: h.title.slice(0, 200), year: h.year ? +h.year : null, brand: h.brand,
        source: h.source, kind: cls.kind, formats: cls.formats, seasons: cls.seasons, complete: cls.complete,
      };
    }
  }
  return null;
}

/* ---------- Lokaler Barcode-Speicher ---------- */

class ScanStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new JsonFile(path.join(dir, 'barcodes.json'), { codes: {} });
  }
  get data() { return this.db.load(); }
  get(code) { return this.data.codes[code] || null; }

  /** Produkt aus externer Quelle mit bisher Bestätigtem zusammenführen. */
  remember(code, product) {
    const d = this.data;
    const old = d.codes[code] || { code, firstSeen: Date.now(), itemId: null, itemKind: null, confirmed: false };
    d.codes[code] = {
      ...old,
      hits: (old.hits || 0) + 1,
      lastSeen: Date.now(),
      product: product || old.product || null,
    };
    this.db.save();
    return d.codes[code];
  }

  /** Barcode fest mit einem Jellyfin-Item verknüpfen (Bestätigung/Korrektur). */
  bind(code, itemId, kind) {
    const d = this.data;
    const old = d.codes[code] || { code, firstSeen: Date.now(), hits: 0 };
    d.codes[code] = { ...old, itemId, itemKind: kind || null, confirmed: true, lastSeen: Date.now() };
    this.db.save();
    return d.codes[code];
  }
}

module.exports = { ScanStore, normalizeCode, classifyProduct, formatOfHeight, formatsOfItem, lookupProduct };

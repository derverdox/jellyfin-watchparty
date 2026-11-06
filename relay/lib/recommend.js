'use strict';
/*
 * Empfehlungen am Ende eines Films: „Das könnte euch auch gefallen“.
 *
 * Inhaltsbasiert (kein Cloud-Dienst, keine Fremddaten), damit es mit jeder
 * Jellyfin-Bibliothek funktioniert, auch wenn erst wenige bei euch bewertet haben:
 *
 *  1. Jeder Titel wird zu einem Merkmalsvektor: Genres, Regie, Drehbuch,
 *     Hauptdarsteller (nach Besetzungsreihenfolge gewichtet), Studios, Tags/
 *     Schlagwörter und die Filmreihe (aus dem Titel abgeleitet).
 *  2. Seltene Merkmale zählen mehr als häufige (TF-IDF): dieselbe Regisseurin
 *     sagt mehr aus als „Drama“.
 *  3. Ähnlichkeit = Kosinus der beiden Vektoren, dazu kleine Anteile für
 *     Erscheinungsjahr, Qualität (Jellyfin-Wertung + eure eigenen Sterne) und
 *     den Geschmack der Leute im Raum (Genres ihrer gut bewerteten Titel).
 *  4. Was schon alle im Raum gesehen haben, rutscht nach hinten; ein deutlich
 *     höheres Freigabealter als beim gerade Geschauten ebenso.
 *  5. Zum Schluss wird mit MMR (Maximal Marginal Relevance) ausgewählt, damit
 *     nicht acht fast gleiche Titel derselben Reihe kommen.
 *
 * Das Modul ist rein (keine Netzwerkzugriffe) und damit direkt testbar.
 * Personen der Kandidaten kennt der Aufrufer nur, soweit sie mit dem
 * Ausgangstitel geteilt werden (Jellyfin-Abfrage „PersonIds“) – für die
 * Kosinus-Ähnlichkeit reicht genau das.
 */

const WEIGHTS = {
  genre: 1.0,
  director: 2.4,
  writer: 1.3,
  actor: 1.1,
  studio: 0.6,
  tag: 0.8,
  franchise: 3.2,
};

const MIX = { sim: 0.70, year: 0.07, quality: 0.13, taste: 0.10 };
const MAX_TAGS = 25;
const MAX_ACTORS = 8;

/** Für Vergleiche: klein, ohne Akzente, ß→ss, nur Buchstaben/Ziffern. */
function fold(s) {
  return String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, ' ').trim();
}

const ROMAN = /^(?:i{1,3}|iv|v|vi{1,3}|ix|x)$/;
const SEQUEL_WORDS = new Set(['teil', 'part', 'chapter', 'kapitel', 'episode', 'vol', 'volume', 'folge']);
const ARTICLES = new Set(['der', 'die', 'das', 'the', 'a', 'an', 'le', 'la', 'les', 'el', 'il']);

/**
 * Reihen-Schlüssel aus dem Titel: „Der Herr der Ringe: Die Gefährten“ → „herr der ringe“,
 * „Toy Story 3“ → „toy story“, „Rocky IV“ → „rocky“. Null, wenn nichts Brauchbares bleibt.
 */
function franchiseKey(name) {
  let s = String(name || '');
  // Untertitel nach Doppelpunkt/Gedankenstrich weg
  s = s.split(/\s*[:–—]\s+|\s+-\s+/)[0];
  const words = fold(s).split(' ').filter(Boolean);
  while (words.length > 1) {
    const last = words[words.length - 1];
    const prev = words[words.length - 2];
    if (/^\d{1,2}$/.test(last) || ROMAN.test(last)) { words.pop(); if (SEQUEL_WORDS.has(words[words.length - 1])) words.pop(); continue; }
    if (SEQUEL_WORDS.has(prev) && (/^\d+$/.test(last) || ROMAN.test(last))) { words.splice(-2); continue; }
    break;
  }
  while (words.length > 1 && ARTICLES.has(words[0])) words.shift();
  const key = words.join(' ');
  if (key.replace(/ /g, '').length < 4) return null;
  return key;
}

/** Freigabealter aus FSK/MPAA & Co. (grob, nur zum Vergleichen). */
function ageOf(officialRating) {
  const r = String(officialRating || '').toUpperCase().trim();
  if (!r) return null;
  const n = /(\d{1,2})/.exec(r);
  if (n) return Number(n[1]);
  const map = { G: 0, 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, PG: 8, 'TV-PG': 8, 'PG-13': 13, 'TV-14': 14, R: 17, 'TV-MA': 17, 'NC-17': 18, UNRATED: null, NR: null };
  return r in map ? map[r] : null;
}

function addTok(map, key, w) {
  if (!key || !(w > 0)) return;
  map.set(key, Math.max(map.get(key) || 0, w));
}

/**
 * Merkmale eines Titels (vor IDF). Erwartet die normalisierte Form aus normalize().
 * people: [{ id, role: 'Director'|'Writer'|'Actor'|…, order }]
 */
function features(it) {
  const f = new Map();
  for (const g of it.genres || []) addTok(f, `g:${fold(g)}`, WEIGHTS.genre);
  for (const s of (it.studios || []).slice(0, 3)) addTok(f, `s:${fold(s)}`, WEIGHTS.studio);
  for (const t of (it.tags || []).slice(0, MAX_TAGS)) addTok(f, `t:${fold(t)}`, WEIGHTS.tag);
  for (const p of it.people || []) {
    if (!p || !p.id) continue;
    const role = String(p.role || '').toLowerCase();
    if (role === 'director') addTok(f, `p:${p.id}`, WEIGHTS.director);
    else if (role === 'writer') addTok(f, `p:${p.id}`, WEIGHTS.writer);
    else if (role === 'actor' || role === 'gueststar') {
      const o = Number.isFinite(p.order) ? p.order : 99;
      if (o >= MAX_ACTORS) continue;
      addTok(f, `p:${p.id}`, WEIGHTS.actor * (o < 3 ? 1 : 0.6));
    }
  }
  const fk = franchiseKey(it.name);
  if (fk) addTok(f, `f:${fk}`, WEIGHTS.franchise);
  return f;
}

/** Jellyfin-Objekt → schlanke Form für den Algorithmus. */
function normalize(dto) {
  const people = [];
  let actor = 0;
  for (const p of dto.People || []) {
    if (!p || !p.Id) continue;
    const role = p.Type || '';
    people.push({ id: String(p.Id).toLowerCase(), name: p.Name || '', role, order: role === 'Actor' ? actor++ : 0 });
  }
  const prov = {};
  for (const [k, v] of Object.entries(dto.ProviderIds || {})) if (/^(imdb|tmdb|tvdb)$/i.test(k) && v) prov[k.toLowerCase()] = String(v).toLowerCase();
  return {
    id: dto.Id,
    name: dto.Name || '',
    type: dto.Type,
    year: dto.ProductionYear || null,
    genres: dto.Genres || [],
    studios: (dto.Studios || []).map((s) => (typeof s === 'string' ? s : s && s.Name)).filter(Boolean),
    tags: dto.Tags || [],
    people,
    officialRating: dto.OfficialRating || null,
    rating: Number.isFinite(dto.CommunityRating) ? dto.CommunityRating : null,
    providers: prov,
    seriesId: dto.SeriesId || null,
  };
}

/**
 * Index über den ganzen Katalog: Dokumenthäufigkeit je Merkmal (für IDF).
 * personCounts: Map personId → Anzahl Titel mit dieser Person (aus den PersonIds-Abfragen).
 */
function buildIndex(catalog, personCounts = new Map()) {
  const df = new Map();
  const feats = new Map();
  for (const it of catalog) {
    const f = features(it);
    feats.set(it.id, f);
    for (const k of f.keys()) if (!k.startsWith('p:')) df.set(k, (df.get(k) || 0) + 1);
  }
  for (const [pid, n] of personCounts) df.set(`p:${pid}`, n);
  return { df, feats, n: Math.max(1, catalog.length) };
}

function idf(index, key) {
  const d = index.df.get(key) || 1;
  return Math.log(1 + index.n / d);
}

/** Merkmale mit IDF gewichtet, plus Vektorlänge. */
function weighted(index, f) {
  const v = new Map();
  let norm = 0;
  for (const [k, w] of f) {
    // Merkmale, die nur ein Titel hat, verbinden nichts (außer Personen: die zählen wir über PersonIds)
    if (!k.startsWith('p:') && (index.df.get(k) || 0) < 2) continue;
    const x = w * idf(index, k);
    v.set(k, x);
    norm += x * x;
  }
  return { v, norm: Math.sqrt(norm) };
}

function cosine(a, b) {
  if (!a.norm || !b.norm) return { sim: 0, shared: [] };
  let dot = 0;
  const shared = [];
  const [small, big] = a.v.size <= b.v.size ? [a.v, b.v] : [b.v, a.v];
  for (const [k, x] of small) {
    const y = big.get(k);
    if (y) { dot += x * y; shared.push([k, x * y]); }
  }
  return { sim: dot / (a.norm * b.norm), shared };
}

/** Bayes-geglättete Qualität 0–1 aus Jellyfin-Wertung und euren Sternen. */
function quality(cand, ours) {
  const prior = 6.5;
  let q = cand.rating != null ? cand.rating : prior;
  if (ours && ours.count) q = (q * 2 + ours.avg * ours.count) / (2 + ours.count);
  return Math.max(0, Math.min(1, (q - 4) / 5));
}

/** Gleicher Film in anderer Fassung/Qualität? */
function sameWork(a, b) {
  for (const k of Object.keys(a.providers || {})) if (b.providers && b.providers[k] && b.providers[k] === a.providers[k]) return true;
  if (a.year && a.year === b.year && fold(a.name.replace(/\s*[-–(\[]?\s*(576|720|1080|2160)p.*$/i, '')) === fold(b.name.replace(/\s*[-–(\[]?\s*(576|720|1080|2160)p.*$/i, ''))) return true;
  return false;
}

/** Lesbare Begründung aus den geteilten Merkmalen. */
function reasonsFor(shared, seed, cand, peopleNames) {
  const by = (pfx) => shared.filter(([k]) => k.startsWith(pfx)).sort((a, b) => b[1] - a[1]).map(([k]) => k.slice(pfx.length));
  const out = [];
  const fr = by('f:');
  if (fr.length) out.push(cand.year && seed.year && cand.year > seed.year ? 'Fortsetzung der Reihe' : 'Aus derselben Reihe');
  const ppl = by('p:');
  const dirs = ppl.filter((id) => (peopleNames.get(id) || {}).role === 'Director');
  const writers = ppl.filter((id) => (peopleNames.get(id) || {}).role === 'Writer' && !dirs.includes(id));
  const actors = ppl.filter((id) => (peopleNames.get(id) || {}).role === 'Actor');
  if (dirs.length) out.push(`Regie: ${dirs.slice(0, 2).map((id) => peopleNames.get(id).name).join(', ')}`);
  if (actors.length) out.push(`Mit ${actors.slice(0, 2).map((id) => peopleNames.get(id).name).join(', ')}`);
  if (writers.length && out.length < 2) out.push(`Drehbuch: ${peopleNames.get(writers[0]).name}`);
  const genres = new Set(by('g:'));
  const g = (cand.genres || []).filter((x) => genres.has(fold(x))).slice(0, 3);
  if (g.length && out.length < 3) out.push(g.join(', '));
  const tags = new Set(by('t:'));
  const t = (cand.tags || []).filter((x) => tags.has(fold(x))).slice(0, 2);
  if (t.length && out.length < 3) out.push(t.join(', '));
  return out.slice(0, 3);
}

/**
 * Hauptfunktion.
 * @param {object} seed     normalisierter Ausgangstitel (mit people)
 * @param {object[]} catalog normalisierte Kandidaten (ohne people)
 * @param {object} ctx
 *   sharedPeople: Map candId → Set(personId)   – aus PersonIds-Abfragen
 *   personCounts: Map personId → Anzahl Titel  – für IDF
 *   ours:         (id) → { avg, count } | null – eure Sterne
 *   watchedBy:    (id) → Anzahl Leute im Raum, die es gesehen haben
 *   viewers:      Anzahl Leute im Raum (≥ 1)
 *   tasteGenres:  Map fold(genre) → Gewicht (−1…1) aus den Bewertungen der Leute im Raum
 *   limit, lambda
 * @returns {{ id, score, sim, reasons, watchedBy }[]}
 */
function recommend(seed, catalog, ctx = {}) {
  const limit = Math.max(1, Math.min(40, ctx.limit || 10));
  const lambda = ctx.lambda ?? 0.75;
  const viewers = Math.max(1, ctx.viewers || 1);
  const sharedPeople = ctx.sharedPeople || new Map();
  const peopleById = new Map((seed.people || []).map((p) => [p.id, p]));

  const pool = catalog.filter((c) => c.id !== seed.id && !sameWork(seed, c) && c.id !== seed.seriesId);
  const index = buildIndex([seed, ...pool], ctx.personCounts);
  const seedVec = weighted(index, index.feats.get(seed.id));
  const seedAge = ageOf(seed.officialRating);
  const taste = ctx.tasteGenres || new Map();

  const scored = [];
  for (const c of pool) {
    // Kandidat bekommt nur die mit dem Ausgangstitel geteilten Personen (mehr wissen wir nicht)
    const f = new Map(index.feats.get(c.id));
    const sp = sharedPeople.get(c.id);
    if (sp) for (const pid of sp) { const p = peopleById.get(pid); if (p) { const sf = features({ people: [p] }); for (const [k, w] of sf) addTok(f, k, w); } }
    const vec = weighted(index, f);
    const { sim, shared } = cosine(seedVec, vec);
    if (sim <= 0.015) continue;

    const year = seed.year && c.year ? Math.exp(-Math.abs(seed.year - c.year) / 12) : 0.4;
    const q = quality(c, ctx.ours ? ctx.ours(c.id) : null);
    let tasteScore = 0;
    if (taste.size && c.genres && c.genres.length) {
      for (const g of c.genres) tasteScore += taste.get(fold(g)) || 0;
      tasteScore = Math.max(-1, Math.min(1, tasteScore / c.genres.length)) * 0.5 + 0.5;
    } else tasteScore = 0.5;

    let score = MIX.sim * Math.min(1, sim * 1.15) + MIX.year * year + MIX.quality * q + MIX.taste * tasteScore;
    // Fortsetzung gleich nach dem Teil davor: ganz nach vorn
    if (shared.some(([k]) => k.startsWith('f:')) && c.year && seed.year && c.year >= seed.year) score += 0.08 / (1 + Math.max(0, c.year - seed.year) / 4);

    const seen = ctx.watchedBy ? ctx.watchedBy(c.id) : 0;
    score *= 1 - 0.55 * Math.min(1, seen / viewers);
    const age = ageOf(c.officialRating);
    if (seedAge != null && age != null && age > seedAge + 4) score *= 0.75;
    if (seed.type === 'Movie' && c.type === 'Series') score *= 0.85;

    scored.push({ c, vec, score, sim, shared, seen });
  }
  scored.sort((a, b) => b.score - a.score);

  // MMR: Relevanz gegen Ähnlichkeit zu schon Ausgewähltem abwägen
  const head = scored.slice(0, Math.max(limit * 5, 40));
  const picked = [];
  while (picked.length < limit && head.length) {
    let best = -Infinity;
    let bi = 0;
    for (let i = 0; i < head.length; i++) {
      let red = 0;
      for (const p of picked) red = Math.max(red, cosine(head[i].vec, p.vec).sim);
      const mmr = lambda * head[i].score - (1 - lambda) * red * 0.6;
      if (mmr > best) { best = mmr; bi = i; }
    }
    picked.push(head.splice(bi, 1)[0]);
  }

  return picked.map((x) => ({
    id: x.c.id,
    score: Math.round(x.score * 1000) / 1000,
    sim: Math.round(x.sim * 1000) / 1000,
    reasons: reasonsFor(x.shared, seed, x.c, peopleById),
    watchedBy: x.seen,
  }));
}

/**
 * Geschmack der Leute im Raum: Genres ihrer bewerteten Titel, zentriert um 5,5 Sterne.
 * ratings: [{ id, score }] (alle Bewertungen aller Anwesenden), byId: Map id → normalisierter Titel
 */
function tasteFrom(ratings, byId) {
  const sum = new Map();
  const cnt = new Map();
  for (const r of ratings) {
    const it = byId.get(r.id);
    if (!it) continue;
    const w = (r.score - 5.5) / 4.5;
    for (const g of it.genres || []) {
      const k = fold(g);
      sum.set(k, (sum.get(k) || 0) + w);
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
  }
  const out = new Map();
  for (const [k, s] of sum) out.set(k, s / (cnt.get(k) + 2)); // geglättet: wenige Bewertungen zählen wenig
  return out;
}

module.exports = { recommend, normalize, features, franchiseKey, ageOf, tasteFrom, sameWork, fold, WEIGHTS };

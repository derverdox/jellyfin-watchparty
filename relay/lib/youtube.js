'use strict';
/*
 * YouTube im Raum: Jeder Client spielt das Video im offiziellen YouTube-Player
 * (IFrame-API). Ein YouTube-Video hat eine feste Timeline, deshalb reicht der
 * normale Raum-Sync (Position + Serverzeit) – das Relay muss nichts streamen.
 */
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Video-ID und Startzeit aus einem Link: watch?v=, youtu.be/, /shorts/, /live/, /embed/ oder nur die ID. */
function parseYouTube(input) {
  const s = String(input || '').trim();
  if (ID_RE.test(s)) return { id: s, start: 0 };
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
  }
  if (!id || !ID_RE.test(id)) return null;
  return { id, start: parseStart(u.searchParams.get('t') || u.searchParams.get('start')) };
}

/** „90“, „90s“, „1m30s“, „1h2m3s“ → Sekunden */
function parseStart(t) {
  if (!t) return 0;
  if (/^\d+s?$/.test(t)) return Number(t.replace('s', ''));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

const cache = new Map();

/** Titel und Kanal über oEmbed (ohne API-Key). Schlägt das fehl, gibt's einen Platzhalter. */
async function youtubeInfo(id, fetchImpl = globalThis.fetch, base = 'https://www.youtube.com') {
  const c = cache.get(id);
  if (c && Date.now() - c.t < 3600 * 1000) return c.v;
  let v = { id, title: 'YouTube-Video', author: '', embeddable: true };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    const r = await fetchImpl(`${base}/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { signal: ac.signal });
    clearTimeout(timer);
    if (r.status === 200) {
      const j = await r.json();
      v = { id, title: String(j.title || v.title).slice(0, 200), author: String(j.author_name || '').slice(0, 100), embeddable: true };
    } else if (r.status === 401 || r.status === 403) v.embeddable = false; // Einbetten verboten
    else if (r.status === 404 || r.status === 400) v = null;
  } catch { /* offline → Platzhalter */ }
  if (v) {
    cache.set(id, { t: Date.now(), v });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return v;
}

module.exports = { parseYouTube, parseStart, youtubeInfo };

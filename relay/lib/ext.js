'use strict';
/**
 * YouTube- und Twitch-Links für „zusammen schauen“.
 * Das Video selbst kommt bei jedem direkt von YouTube/Twitch (eingebetteter Player mit dem
 * eigenen Konto). Hier wird nur der Link erkannt und ein Titel besorgt.
 */

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const TW_NAME = /^[A-Za-z0-9_]{2,25}$/;
const TW_RESERVED = new Set(['videos', 'directory', 'downloads', 'jobs', 'p', 'settings', 'search', 'subscriptions', 'inventory', 'wallet', 'drops', 'turbo', 'prime', 'store', 'friends', 'messages', 'login', 'signup', 'clip', 'clips']);

/** „1h2m3s“, „90“, „1:02:03“ → Sekunden */
function parseTime(t) {
  if (!t) return 0;
  const s = String(t).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(s);
  if (hms && (hms[1] || hms[2] || hms[3])) return Number(hms[1] || 0) * 3600 + Number(hms[2] || 0) * 60 + Number(hms[3] || 0);
  const col = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  if (col) return Number(col[1] || 0) * 3600 + Number(col[2]) * 60 + Number(col[3]);
  return 0;
}

/**
 * Link → { kind: 'youtube', id, start } | { kind: 'twitch', live: true, channel } |
 *        { kind: 'twitch', video, start } | { kind: 'twitch', clip } | null
 */
function parseExtUrl(input) {
  let s = String(input || '').trim();
  if (!s || s.length > 500) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const start = parseTime(u.searchParams.get('t') || u.searchParams.get('start') || (u.hash.match(/t=([^&]+)/) || [])[1]);

  if (host === 'youtu.be') {
    const id = parts[0];
    return YT_ID.test(id || '') ? { kind: 'youtube', id, start } : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = null;
    if (parts[0] === 'watch') id = u.searchParams.get('v');
    else if (['shorts', 'live', 'embed', 'v', 'e'].includes(parts[0])) id = parts[1];
    return YT_ID.test(id || '') ? { kind: 'youtube', id, start } : null;
  }
  if (host === 'clips.twitch.tv') {
    const slug = parts[0];
    return slug && /^[A-Za-z0-9_-]{3,100}$/.test(slug) ? { kind: 'twitch', clip: slug } : null;
  }
  if (host === 'twitch.tv') {
    if (parts[0] === 'videos' && /^\d{3,15}$/.test(parts[1] || '')) return { kind: 'twitch', video: parts[1], start };
    if (parts[1] === 'clip' && /^[A-Za-z0-9_-]{3,100}$/.test(parts[2] || '')) return { kind: 'twitch', clip: parts[2] };
    const ch = parts[0];
    if (ch && TW_NAME.test(ch) && !TW_RESERVED.has(ch.toLowerCase()) && parts.length === 1) return { kind: 'twitch', live: true, channel: ch.toLowerCase() };
  }
  return null;
}

/** Eindeutiger Schlüssel (für Raum-Status, Freundesliste) */
function extKey(e) {
  if (e.kind === 'youtube') return `yt:${e.id}`;
  if (e.live) return `tw:live:${e.channel}`;
  if (e.video) return `tw:v:${e.video}`;
  return `tw:clip:${e.clip}`;
}

/** Titel besorgen: YouTube per oEmbed, Twitch aus dem Link. Nie länger als ein paar Sekunden. */
async function extInfo(e, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  if (e.kind === 'youtube') {
    try {
      const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${e.id}`)}`;
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) {
        const j = await r.json();
        return { title: String(j.title || 'YouTube-Video').slice(0, 200), subtitle: j.author_name ? `YouTube · ${String(j.author_name).slice(0, 80)}` : 'YouTube' };
      }
    } catch { /* kein Internet o. Ä.: Ersatztitel */ }
    return { title: 'YouTube-Video', subtitle: 'YouTube' };
  }
  if (e.live) return { title: e.channel, subtitle: 'Twitch · live' };
  if (e.video) return { title: `Twitch-Video ${e.video}`, subtitle: 'Twitch · Video' };
  return { title: 'Twitch-Clip', subtitle: 'Twitch · Clip' };
}

module.exports = { parseExtUrl, parseTime, extKey, extInfo };

'use strict';

// Only strip a final quality marker, never edition names or numbers in the title.
function movieTitle(name) {
  return String(name || '').replace(/\s*(?:[-–—·]\s*)?(?:\[|\()?\s*(?:576p|1080p|2160p)\s*(?:\]|\))?\s*$/i, '').trim();
}
function quality(name, streams = []) {
  const suffix = /(?:^|[\s[(-])(576|1080|2160)p\s*[\])]?$/.exec(String(name || '').toLowerCase());
  if (suffix) return { 576: 'SD', 1080: 'Full HD', 2160: '4K' }[suffix[1]];
  const video = streams.find((s) => s.Type === 'Video');
  if (!video) return null;
  // Width also handles films with black bars cropped from the encoded image.
  const w = Number(video.Width) || 0, h = Number(video.Height) || 0;
  return w > 1920 || h > 1080 ? '4K' : w > 1280 || h > 720 ? 'Full HD' : w > 1024 || h > 576 ? 'HD' : w || h ? 'SD' : null;
}
function qualities(it) {
  const sources = it.MediaSources || [];
  const labels = new Set([quality(it.Name, it.MediaStreams), ...sources.map((s) => quality(s.Name, s.MediaStreams))].filter(Boolean));
  return ['SD', 'HD', 'Full HD', '4K'].filter((q) => labels.has(q));
}
function providers(it) {
  return Object.fromEntries(Object.entries(it.ProviderIds || {})
    .filter(([k, v]) => /^(imdb|tmdb|tvdb)$/i.test(k) && v)
    .map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
}
function titleKey(it) {
  // Missing year: no automatic title-only match.
  return it.ProductionYear ? `${movieTitle(it.Name).normalize('NFC').toLowerCase()}|${it.ProductionYear}` : null;
}

/** Group only already access-filtered items. Keep actual Jellyfin IDs for playback. */
function groupMovies(items, mapItem) {
  const groups = [], byProvider = new Map(), byTitle = new Map();
  for (const it of items) {
    if (it.Type !== 'Movie') { groups.push({ items: [it] }); continue; }
    const ids = providers(it), key = titleKey(it);
    const candidates = new Set(Object.entries(ids).flatMap(([k, v]) => byProvider.get(`${k}:${v}`) || []));
    for (const g of byTitle.get(key) || []) candidates.add(g);
    let group = [...candidates].find((g) => {
      const conflict = Object.keys(ids).some((k) => g.providers[k] && g.providers[k] !== ids[k]);
      if (conflict) return false;
      const shared = Object.keys(ids).some((k) => g.providers[k] === ids[k]);
      return shared || (key && key === g.key && (!Object.keys(ids).length || !Object.keys(g.providers).length));
    });
    if (!group) {
      group = { items: [], providers: {}, key };
      groups.push(group);
      if (key) byTitle.set(key, [...(byTitle.get(key) || []), group]);
    }
    group.items.push(it);
    Object.assign(group.providers, ids);
    for (const [k, v] of Object.entries(ids)) {
      const p = `${k}:${v}`;
      if (!(byProvider.get(p) || []).includes(group)) byProvider.set(p, [...(byProvider.get(p) || []), group]);
    }
  }
  return groups.map((g) => {
    if (g.items[0].Type !== 'Movie') return mapItem(g.items[0]);
    const versions = [...g.items].sort((a, b) => a.Id.localeCompare(b.Id));
    const representative = versions[0];
    const labels = new Set(versions.flatMap(qualities));
    return { ...mapItem(representative), name: movieTitle(representative.Name) || representative.Name,
      availableQualities: ['SD', 'HD', 'Full HD', '4K'].filter((q) => labels.has(q)),
      versions: versions.map((v) => ({ id: v.Id, name: v.Name, qualities: qualities(v), runtime: v.RunTimeTicks ? v.RunTimeTicks / 1e7 : null })),
    };
  });
}
module.exports = { movieTitle, qualities, groupMovies };

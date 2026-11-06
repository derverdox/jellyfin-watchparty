'use strict';
const { movieTitle, qualities, groupMovies } = require('./movie-versions');

const QUALITY_ORDER = ['SD', 'HD', 'Full HD', '4K'];
const FIELDS = 'ProviderIds,ProductionYear,MediaSources,MediaStreams,Path,RunTimeTicks,SeriesId,SeriesName,ParentIndexNumber,IndexNumber,IndexNumberEnd';

function sourceVersions(it) {
  const sources = it.MediaSources && it.MediaSources.length ? it.MediaSources : [null];
  // Some servers can repeat a source; this is not an additional copy.
  const seen = new Set();
  return sources.filter((s) => {
    const key = s && (s.Id || s.Path);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((s) => {
    const streams = (s && s.MediaStreams) || it.MediaStreams || [];
    const ticks = (s && s.RunTimeTicks) || it.RunTimeTicks;
    return {
      itemId: it.Id, sourceId: s ? s.Id || null : null,
      name: (s && s.Name) || it.Name,
      path: (s && s.Path) || it.Path || null,
      libraryId: it.analysisLibrary.id, libraryName: it.analysisLibrary.name,
      excluded: it.analysisLibrary.excluded,
      qualities: s ? qualities({ Name: s.Name || it.Name, MediaStreams: streams }) : qualities(it),
      runtime: ticks ? ticks / 1e7 : null,
      audio: streams.filter((x) => x.Type === 'Audio').map(streamInfo),
      subtitles: streams.filter((x) => x.Type === 'Subtitle').map(streamInfo),
    };
  });
}
function streamInfo(s) {
  return { index: s.Index, language: s.Language || null, label: s.DisplayTitle || s.Language || s.Codec || 'Unbekannt',
    codec: s.Codec || null, forced: !!s.IsForced, external: !!s.IsExternal };
}

function analyzeDuplicates(items) {
  const byId = new Map(items.map((it) => [it.Id, it]));
  const map = (it) => ({ id: it.Id, type: it.Type, year: it.ProductionYear || null });
  const movieGroups = groupMovies(items.filter((it) => it.Type === 'Movie'), map);
  // Provider IDs here are SERIES IDs; never confuse episode IDs with series IDs.
  const seriesGroups = groupMovies(items.filter((it) => it.Type === 'Series').map((it) => ({ ...it, Type: 'Movie' })), map);
  const seriesById = new Map();
  for (const group of seriesGroups) for (const v of group.versions) seriesById.set(v.id, group);
  const episodes = new Map();
  for (const it of items.filter((x) => x.Type === 'Episode')) {
    const series = seriesById.get(it.SeriesId);
    const valid = it.SeriesId && Number.isInteger(it.ParentIndexNumber) && Number.isInteger(it.IndexNumber);
    const key = valid ? `${series ? series.id : it.SeriesId}|${it.ParentIndexNumber}|${it.IndexNumber}|${it.IndexNumberEnd ?? it.IndexNumber}` : `unknown:${it.Id}`;
    if (!episodes.has(key)) episodes.set(key, { id: it.Id, type: 'Episode',
      name: movieTitle(it.Name), seriesName: series ? series.name : it.SeriesName || null,
      season: it.ParentIndexNumber ?? null, episode: it.IndexNumber ?? null,
      episodeEnd: it.IndexNumberEnd ?? it.IndexNumber ?? null, versions: [] });
    episodes.get(key).versions.push({ id: it.Id });
  }
  const groups = [...movieGroups, ...episodes.values()].map((group) => {
    const versions = group.versions.flatMap((v) => sourceVersions(byId.get(v.id)));
    const found = new Set(versions.flatMap((v) => v.qualities));
    return { ...group, availableQualities: QUALITY_ORDER.filter((q) => found.has(q)),
      versions: versions.sort((a, b) => a.itemId.localeCompare(b.itemId) || String(a.sourceId).localeCompare(String(b.sourceId))),
      syncStatus: 'unverified' };
  }).filter((group) => group.versions.length > 1);
  groups.sort((a, b) => (a.seriesName || a.name).localeCompare(b.seriesName || b.name, 'de', { numeric: true }) || (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
  return { scannedItems: items.length, duplicateGroups: groups.length,
    movieGroups: groups.filter((g) => g.type === 'Movie').length,
    episodeGroups: groups.filter((g) => g.type === 'Episode').length,
    versions: groups.reduce((n, g) => n + g.versions.length, 0), groups };
}

class DuplicateScanner {
  constructor({ getLibraries, fetchPage, isExcluded }) {
    this.getLibraries = getLibraries;
    this.fetchPage = fetchPage;
    this.isExcluded = isExcluded;
    this.job = { status: 'idle' };
  }
  snapshot(start = 0, limit = 50) {
    const { report, ...state } = this.job;
    if (!report) return { ...state };
    return { ...state, report: { ...report, groups: report.groups.slice(start, start + limit), start, limit } };
  }
  start() {
    if (this.job.status === 'running') return;
    this.job = { status: 'running', startedAt: Date.now(), progress: { scanned: 0, librariesDone: 0, libraries: 0 } };
    this.pending = this.run().catch((e) => {
      this.job = { ...this.job, status: 'error', finishedAt: Date.now(), error: e.message };
    });
  }
  async run() {
    const libraries = await this.getLibraries();
    this.job.progress.libraries = libraries.length;
    const items = new Map();
    let records = 0;
    for (const lib of libraries) {
      this.job.progress.library = lib.Name;
      const seen = new Set();
      for (let offset = 0; ; ) {
        const page = await this.fetchPage(lib.Id, offset, FIELDS);
        const rows = page.Items || [];
        if (!rows.length) break;
        let fresh = 0;
        for (const row of rows) {
          if (!row.Id) throw new Error('Jellyfin liefert einen Eintrag ohne ID');
          if (!seen.has(row.Id)) { seen.add(row.Id); fresh++; }
          items.set(row.Id, { ...row, analysisLibrary: { id: lib.Id, name: lib.Name, excluded: this.isExcluded(lib.Id) } });
        }
        if (!fresh) throw new Error('Jellyfin wiederholt dieselbe Seite; Analyse abgebrochen');
        records += rows.length;
        if (records > 100000) throw new Error('Analyse überschreitet 100.000 Einträge');
        offset += rows.length;
        this.job.progress.scanned = items.size;
      }
      this.job.progress.librariesDone++;
    }
    const report = analyzeDuplicates([...items.values()]);
    this.job = { ...this.job, status: 'complete', finishedAt: Date.now(), report };
  }
}
module.exports = { analyzeDuplicates, DuplicateScanner };

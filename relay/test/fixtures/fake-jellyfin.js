'use strict';
/**
 * Test-Jellyfin mit Ordnerstruktur:
 *   Filme   → Klassiker (Ordner) → Metropolis
 *           → Neuer Film
 *   Serien  → Testserie → Staffel 1 → Folge 1
 *   Kinder  → Trickfilm
 */
const http = require('http');
const crypto = require('crypto');

const id = (n) => crypto.createHash('md5').update(n).digest('hex');
const USER = id('user');
const I = {
  LIB_M: id('lib-filme'), LIB_S: id('lib-serien'), LIB_K: id('lib-kinder'), ROOT: id('root'),
  F_KLASSIK: id('klassiker'), M_METRO: id('metropolis'), M_NEU: id('neu'),
  SERIES: id('serie'), SEASON: id('staffel'), EP1: id('folge1'), M_KIDS: id('trick'),
};
const MS = id('mediasource');

function movie(Id, Name, ParentId) {
  return { Id, Name, Type: 'Movie', ParentId, ProductionYear: 2026, RunTimeTicks: 60 * 1e7, ImageTags: { Primary: 'x' },
    MediaSources: [{ Id: MS, Container: 'mp4', DefaultAudioStreamIndex: 1, MediaStreams: [
      { Index: 0, Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
      { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'deu', IsDefault: true }] }] };
}
const ITEMS = {
  [I.ROOT]: { Id: I.ROOT, Name: 'Root', Type: 'UserRootFolder', IsFolder: true },
  [I.LIB_M]: { Id: I.LIB_M, Name: 'Filme', Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true, ParentId: I.ROOT },
  [I.LIB_S]: { Id: I.LIB_S, Name: 'Serien', Type: 'CollectionFolder', CollectionType: 'tvshows', IsFolder: true, ParentId: I.ROOT },
  [I.LIB_K]: { Id: I.LIB_K, Name: 'Kinder', Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true, ParentId: I.ROOT },
  [I.F_KLASSIK]: { Id: I.F_KLASSIK, Name: 'Klassiker', Type: 'Folder', IsFolder: true, ParentId: I.LIB_M },
  [I.M_METRO]: movie(I.M_METRO, 'Metropolis', I.F_KLASSIK),
  [I.M_NEU]: movie(I.M_NEU, 'Neuer Film', I.LIB_M),
  [I.SERIES]: { Id: I.SERIES, Name: 'Testserie', Type: 'Series', IsFolder: true, ParentId: I.LIB_S },
  [I.SEASON]: { Id: I.SEASON, Name: 'Staffel 1', Type: 'Season', IsFolder: true, ParentId: I.SERIES, SeriesId: I.SERIES, IndexNumber: 1 },
  [I.EP1]: { ...movie(I.EP1, 'Folge 1', I.SEASON), Type: 'Episode', SeriesId: I.SERIES, SeasonId: I.SEASON, SeriesName: 'Testserie', IndexNumber: 1, ParentIndexNumber: 1 },
  [I.M_KIDS]: movie(I.M_KIDS, 'Trickfilm', I.LIB_K),
};
const VIDEO = crypto.randomBytes(3 * 1024 * 1024);

function descendants(pid) {
  const out = [];
  for (const it of Object.values(ITEMS)) if (it.ParentId === pid) { out.push(it); out.push(...descendants(it.Id)); }
  return out;
}

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const q = url.searchParams;
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    let m;
    if (p === '/System/Info') return json({ ServerName: 'Testserver', Version: '10.11.0' });
    if (p === '/Users') return json([{ Id: USER, Name: 'test', Policy: { IsAdministrator: true } }]);
    if (p === `/Users/${USER}/Views`) return json({ Items: [ITEMS[I.LIB_M], ITEMS[I.LIB_S], ITEMS[I.LIB_K]] });
    if (p === `/Users/${USER}/Items`) {
      let list;
      if (q.get('SearchTerm')) list = Object.values(ITEMS).filter((x) => !x.IsFolder || x.Type === 'Series').filter((x) => x.Name.toLowerCase().includes(q.get('SearchTerm').toLowerCase()));
      else if (q.get('Recursive') === 'true') {
        const types = (q.get('IncludeItemTypes') || '').split(',');
        list = descendants(q.get('ParentId')).filter((x) => !types[0] || types.includes(x.Type));
      } else list = Object.values(ITEMS).filter((x) => x.ParentId === q.get('ParentId'));
      return json({ Items: list, TotalRecordCount: list.length });
    }
    if ((m = p.match(new RegExp(`^/Users/${USER}/Items/([a-f0-9]{32})$`)))) {
      const it = ITEMS[m[1]];
      if (!it) { res.writeHead(404); return res.end(); }
      return json(it);
    }
    if ((m = p.match(/^\/Shows\/([a-f0-9]{32})\/Episodes$/))) return json({ Items: Object.values(ITEMS).filter((x) => x.SeriesId === m[1] && x.Type === 'Episode') });
    if ((m = p.match(/^\/Items\/([a-f0-9]{32})\/Images\//))) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.from('JPEG' + m[1])); }
    if ((m = p.match(/^\/Videos\/([a-f0-9]{32})\/stream$/))) {
      const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const s = r ? Number(r[1]) : 0;
      const e = r && r[2] ? Math.min(Number(r[2]), VIDEO.length - 1) : VIDEO.length - 1;
      res.writeHead(r ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': e - s + 1, ...(r ? { 'Content-Range': `bytes ${s}-${e}/${VIDEO.length}` } : {}) });
      return res.end(VIDEO.subarray(s, e + 1));
    }
    if ((m = p.match(/^\/Videos\/([a-f0-9]{32})\/master\.m3u8$/))) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${q.get('MaxStreamingBitrate')}\nmain.m3u8?br=${q.get('MaxStreamingBitrate')}\n`);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, I, MS, USER })));
}

module.exports = { start };

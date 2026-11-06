'use strict';
/** Minimaler Jellyfin-Ersatz für Tests: eine Bibliothek, ein Film, ein externer Untertitel. */
const http = require('http');
const fs = require('fs');

const USER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LIB = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
const MOVIE = '0123456789abcdef0123456789abcdef';
const MS = 'fedcba9876543210fedcba9876543210';

function start(videoFile, port = 0) {
  const size = fs.statSync(videoFile).size;
  const movie = {
    Id: MOVIE, Name: 'Testfilm', Type: 'Movie', ProductionYear: 2026, RunTimeTicks: 90 * 1e7,
    ImageTags: {}, Overview: 'Ein Testbild mit Ton.',
    MediaSources: [{
      Id: MS, Container: 'mp4', Bitrate: Math.round(size * 8 / 90), DefaultAudioStreamIndex: 1,
      MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264', Width: 640, Height: 360 },
        { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'deu', DisplayTitle: 'Deutsch AAC', IsDefault: true },
        { Index: 2, Type: 'Subtitle', Codec: 'srt', Language: 'eng', DisplayTitle: 'English (extern)', IsExternal: true, IsTextSubtitleStream: true },
      ],
    }],
  };
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    requests.push(p);
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (p === '/System/Info') return json({ ServerName: 'Testserver', Version: '10.11.0' });
    if (p === '/Users') return json([{ Id: USER, Name: 'test', Policy: { IsAdministrator: true } }]);
    if (p === `/Users/${USER}/Views`) return json({ Items: [{ Id: LIB, Name: 'Filme', Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true }] });
    if (p === `/Users/${USER}/Items`) return json({ Items: Number(url.searchParams.get('StartIndex') || 0) > 0 ? [] : [movie], TotalRecordCount: 1 });
    if (p === `/Users/${USER}/Items/${MOVIE}`) return json(movie);
    if (p === `/Videos/${MOVIE}/${MS}/Subtitles/2/Stream.vtt`) {
      res.writeHead(200, { 'Content-Type': 'text/vtt' });
      return res.end('WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nHallo Welt\n');
    }
    if (p === `/Videos/${MOVIE}/stream`) {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const s = m ? Number(m[1]) : 0;
      const e = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(m ? 206 : 200, {
        'Content-Type': 'video/mp4', 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes',
        ...(m ? { 'Content-Range': `bytes ${s}-${e}/${size}` } : {}),
      });
      return fs.createReadStream(videoFile, { start: s, end: e }).pipe(res);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, ids: { USER, LIB, MOVIE, MS } })));
}

module.exports = { start };

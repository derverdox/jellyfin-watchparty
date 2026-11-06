'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeDuplicates, DuplicateScanner } = require('../lib/duplicates');
const library = { id: 'lib', name: 'Filme', excluded: false };
const movie = (Id, Name, extra = {}) => ({ Id, Name, Type: 'Movie', ProductionYear: 1999, analysisLibrary: library, ...extra });
const series = (Id, Name, extra = {}) => movie(Id, Name, { Type: 'Series', ...extra });
const episode = (Id, SeriesId, extra = {}) => movie(Id, 'Pilot', { Type: 'Episode', SeriesId, ParentIndexNumber: 1, IndexNumber: 1, ...extra });
const source = (Id, height, extra = {}) => ({ Id, Name: `${height}p`, Path: `/media/${Id}.mkv`, RunTimeTicks: 7200e7,
  MediaStreams: [{ Type: 'Video', Height: height }, { Type: 'Audio', Index: 1, Language: 'deu' }, { Type: 'Subtitle', Index: 2, Language: 'eng', IsForced: true }], ...extra });

test('Agent and relay use identical movie identities and quality rules', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../lib/movie-versions.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../../relay/lib/movie-versions.js'), 'utf8'));
});

test('Movie duplicates include repeated quality and native Jellyfin MediaSources with their own tracks', () => {
  const report = analyzeDuplicates([
    movie('a', 'Matrix - 1080p', { MediaSources: [source('de', 1080), source('en', 1080, { MediaStreams: [{ Type: 'Video', Height: 1080 }, { Type: 'Audio', Index: 4, Language: 'eng' }] })] }),
    movie('b', 'Matrix - 2160p', { MediaSources: [source('uhd', 2160)], analysisLibrary: { ...library, id: 'hidden', excluded: true } }),
    movie('c', 'Single', { MediaSources: [source('only', 576)] }),
  ]);
  assert.equal(report.movieGroups, 1);
  assert.equal(report.versions, 3);
  const group = report.groups[0];
  assert.equal(group.syncStatus, 'unverified');
  assert.deepEqual(group.availableQualities, ['Full HD', '4K']);
  assert.equal(group.versions[0].audio[0].language, 'deu');
  assert.equal(group.versions[0].subtitles[0].forced, true);
  assert.equal(group.versions[1].audio[0].index, 4);
  assert.equal(group.versions[2].excluded, true);
  assert.equal(group.versions[0].path, '/media/de.mkv');
});

test('Already grouped sources count as duplicates; repeated source IDs do not', () => {
  const report = analyzeDuplicates([movie('a', 'Native', { MediaSources: [source('one', 576), source('one', 576), source('two', 2160)] })]);
  assert.equal(report.movieGroups, 1);
  assert.equal(report.versions, 2);
});

test('Episodes match by series identity, season and episode range, never episode title', () => {
  const report = analyzeDuplicates([
    series('s1', 'Serie - 576p', { ProviderIds: { Tvdb: '42' } }),
    series('s2', 'Serie - 1080p', { ProviderIds: { Tvdb: '42' } }),
    series('other', 'Andere Serie'),
    episode('e1', 's1', { MediaSources: [source('dvd', 576)] }),
    episode('e2', 's2', { MediaSources: [source('bluray', 1080)] }),
    episode('e3', 'other'), episode('e4', 's1', { ParentIndexNumber: 2 }),
    episode('e5', 's2', { IndexNumberEnd: 2 }),
    episode('e6', 's1', { IndexNumber: null }), episode('e7', 's1', { IndexNumber: null }),
    episode('e8', 's1', { ParentIndexNumber: 0 }), episode('e9', 's2', { ParentIndexNumber: 0 }),
  ]);
  assert.equal(report.episodeGroups, 2);
  assert.equal(report.movieGroups, 0);
  const regular = report.groups.find((x) => x.season === 1);
  assert.equal(regular.seriesName, 'Serie');
  assert.equal(regular.versions.length, 2);
  assert.deepEqual(regular.availableQualities, ['SD', 'Full HD']);
});

test('Different remakes and incomplete metadata stay separate', () => {
  assert.equal(analyzeDuplicates([movie('a', 'Name - 576p'), movie('b', 'Name - 1080p', { ProductionYear: 2001 }),
    movie('c', 'Name', { ProductionYear: null }), movie('d', 'Name', { ProductionYear: null })]).duplicateGroups, 0);
});

test('Scanner paginates all libraries, includes excluded ones, reports progress and deduplicates concurrent starts', async () => {
  let release;
  const ready = new Promise((r) => { release = r; });
  const calls = [];
  const scanner = new DuplicateScanner({
    getLibraries: async () => { await ready; return [{ Id: 'l1', Name: 'DVD' }, { Id: 'l2', Name: 'UHD' }]; },
    isExcluded: (id) => id === 'l2',
    fetchPage: async (lib, offset) => {
      calls.push([lib, offset]);
      return { Items: offset ? [] : [movie(lib, `Film - ${lib === 'l1' ? '576p' : '2160p'}`)] };
    },
  });
  assert.equal(scanner.snapshot().status, 'idle');
  scanner.start(); const pending = scanner.pending; scanner.start();
  assert.equal(scanner.pending, pending);
  assert.equal(scanner.snapshot().status, 'running');
  release(); await pending;
  const state = scanner.snapshot(0, 1);
  assert.equal(state.status, 'complete');
  assert.equal(state.progress.scanned, 2);
  assert.equal(state.progress.librariesDone, 2);
  assert.equal(state.report.duplicateGroups, 1);
  assert.equal(state.report.groups[0].versions[1].excluded, true);
  assert.deepEqual(calls, [['l1', 0], ['l1', 1], ['l2', 0], ['l2', 1]]);
  assert.equal(scanner.snapshot(1, 1).report.groups.length, 0);
});

test('Failed scan and broken Jellyfin pagination do not present partial results as complete', async () => {
  const scanner = new DuplicateScanner({ getLibraries: async () => [{ Id: 'lib', Name: 'Lib' }], isExcluded: () => false,
    fetchPage: async () => ({ Items: [movie('a', 'Movie')] }) });
  scanner.start(); await scanner.pending;
  assert.equal(scanner.snapshot().status, 'error');
  assert.match(scanner.snapshot().error, /dieselbe Seite/);
  assert.equal(scanner.snapshot().report, undefined);
  scanner.getLibraries = async () => { throw new Error('Offline'); };
  scanner.start(); await scanner.pending;
  assert.equal(scanner.snapshot().error, 'Offline');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { movieTitle, qualities, groupMovies } = require('../lib/movie-versions');
const movie = (Id, Name, extra = {}) => ({ Id, Name, Type: 'Movie', ProductionYear: 1999, ...extra });
const map = (it) => ({ id: it.Id, name: it.Name, type: it.Type });

test('Qualitätssuffixe und echte Videomaße, auch bei beschnittenem Bild', () => {
  for (const suffix of [' - 576p', ' [1080p]', ' (2160p)', ' 2160p']) assert.equal(movieTitle(`Matrix${suffix}`), 'Matrix');
  assert.equal(movieTitle('Matrix Extended - 1080p'), 'Matrix Extended');
  assert.equal(movieTitle('Film 1080p Bonus'), 'Film 1080p Bonus');
  assert.deepEqual(qualities(movie('a', 'Matrix - 576p')), ['SD']);
  assert.deepEqual(qualities(movie('a', 'Matrix', { MediaSources: [
    { Name: 'Blu-ray', MediaStreams: [{ Type: 'Video', Width: 1920, Height: 800 }] },
    { Name: 'UHD', MediaStreams: [{ Type: 'Video', Width: 3840, Height: 1600 }] },
  ] })), ['Full HD', '4K']);
  assert.deepEqual(qualities(movie('a', 'Matrix')), []);
});

test('Gleicher Film, alle Qualitäten, stabile ID und getrennte Versionen gleicher Qualität', () => {
  const items = [movie('c', 'Matrix - 2160p'), movie('a', 'Matrix - 576p'), movie('b', 'Matrix - 1080p'), movie('d', 'Matrix - 1080p')];
  const [result] = groupMovies(items, map);
  assert.equal(result.id, 'a');
  assert.equal(result.name, 'Matrix');
  assert.deepEqual(result.availableQualities, ['SD', 'Full HD', '4K']);
  assert.equal(result.versions.length, 4);
  assert.deepEqual(groupMovies([...items].reverse(), map), [result]);
});

test('Provider-IDs verbinden alternative Titel und Schnitte, Widersprüche bleiben getrennt', () => {
  const items = [
    movie('a', 'Matrix - 1080p', { ProviderIds: { Tmdb: '1' } }),
    movie('b', 'Matrix Extended - 2160p', { ProviderIds: { Tmdb: '1' } }),
    movie('c', 'Matrix - 576p', { ProviderIds: { Tmdb: '2' } }),
  ];
  const groups = groupMovies(items, map);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].versions.length, 2);
});

test('Remakes, unbekannte Jahre, Folgen und unbekannte Schnitte nicht über Titel zusammenlegen', () => {
  const items = [movie('a', 'Matrix - 1080p'), movie('b', 'Matrix - 2160p', { ProductionYear: 2021 }),
    movie('c', 'Matrix Extended - 1080p'), movie('d', 'Matrix', { ProductionYear: null }),
    movie('e', 'Matrix', { ProductionYear: null }), { Id: 'f', Name: 'Matrix', Type: 'Episode' }];
  assert.equal(groupMovies(items, map).length, items.length);
});

'use strict';
/** Titelvorschläge (TMDb): Mapping, Cache, Zugangsprüfung, Header-Varianten. */
const test = require('node:test');
const assert = require('node:assert');
const { WishSearch, IMG } = require('../lib/wishsearch');

function fakeTmdb(calls, seen) {
  return async (url, opts) => {
    calls.push(String(url));
    if (seen) seen.opts = opts;
    const u = new URL(url);
    if (u.pathname.endsWith('/search/movie')) {
      return { ok: true, status: 200, json: async () => ({ results: [
        { id: 1, title: 'Blade Runner', release_date: '1982-06-25', poster_path: '/a.jpg' },
        { id: 2, title: 'Blade Runner 2049', release_date: '2017-10-04', imdb_id: 'tt1856101', poster_path: null },
      ] }) };
    }
    if (u.pathname.endsWith('/search/tv')) {
      return { ok: true, status: 200, json: async () => ({ results: [
        { id: 3, name: 'Blade Runner – Die Serie (Fan)', first_air_date: '1990-01-01' },
      ] }) };
    }
    return { ok: false, status: 401, json: async () => ({}) };
  };
}

test('Vorschläge: Film + Serie gemappt, nach Jahr sortiert, Poster-URL', async () => {
  const calls = [];
  const ws = new WishSearch({ apiKey: 'x'.repeat(32), fetchImpl: fakeTmdb(calls) });
  const out = await ws.search('blade runner');
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((x) => x.year), [2017, 1990, 1982], 'neuestes Jahr oben');
  assert.deepStrictEqual(out.map((x) => x.type), ['movie', 'series', 'movie']);
  assert.strictEqual(out[0].imdbId, 'tt1856101');
  assert.strictEqual(out[1].title, 'Blade Runner – Die Serie (Fan)');
  assert.strictEqual(out[2].poster, `${IMG}/a.jpg`);
  assert.strictEqual(calls.length, 2, 'movie- und tv-Suche je einmal');
  assert.ok(calls[0].includes('api_key='), 'v3-Schlüssel kommt als Parameter');
});

test('Cache und Parallel-Schutz: gleiche Frage geht nur einmal raus', async () => {
  const calls = [];
  const ws = new WishSearch({ apiKey: 'x'.repeat(32), fetchImpl: fakeTmdb(calls) });
  const [a, b] = await Promise.all([ws.search('Blade Runner'), ws.search('blade   RUNNER')]);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(calls.length, 2, 'In-Flight zusammengelegt');
  await ws.search('blade runner');
  assert.strictEqual(calls.length, 2, 'aus dem Cache');
  await ws.search('blade runner', 'movie');
  assert.strictEqual(calls.length, 3, 'Typ-Filter ist eigener Cache-Schlüssel');
});

test('v4-Lese-Token kommt als Bearer-Header, nicht als Parameter', async () => {
  const calls = [];
  const seen = {};
  const jwt = 'eyJ' + 'a'.repeat(40) + '.sig';
  const ws = new WishSearch({ apiKey: jwt, fetchImpl: fakeTmdb(calls, seen) });
  await ws.search('blade', 'movie');
  assert.strictEqual(seen.opts.headers.Authorization, `Bearer ${jwt}`);
  assert.ok(!calls[0].includes('api_key='), 'kein Schlüssel in der URL');
});

test('Ohne/zu kurzen Zugang gar keine Anfrage – Brett läuft wie bisher', async () => {
  const calls = [];
  const ws = new WishSearch({ apiKey: '', fetchImpl: fakeTmdb(calls) });
  assert.strictEqual(ws.enabled, false);
  assert.deepStrictEqual(await ws.search('blade runner'), []);
  assert.strictEqual(calls.length, 0);
});

test('TMDb-Störung schlägt nicht durch: leere Vorschläge', async () => {
  const ws = new WishSearch({ apiKey: 'x'.repeat(32), fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepStrictEqual(await ws.search('blade runner'), []);
});

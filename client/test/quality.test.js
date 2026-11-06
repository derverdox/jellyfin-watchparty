'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Session } = require('../src/main/session');
const Auto = require('../src/renderer/auto-quality');
function session(info, quality = 'auto') {
  return Object.assign(Object.create(Session.prototype), { info: { id: 'item', mediaSourceId: 'high-source', defaultAudioIndex: 7,
    audio: [{ index: 7, lang: 'eng' }], bitrate: 8000000, autoQuality: 'direct', autoTranscodeQuality: '10000000', autoMaxBitrate: 10000000,
    qualities: [{ id: 'direct' }, { id: '10000000' }, { id: '6000000' }, { id: '3000000' }], ...info },
  autoQuality: null, settings: { prefs: { quality, audioLang: 'eng' } }, relay: { base: 'https://relay.test' } });
}
test('Browser and desktop share adaptive quality rules', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../src/renderer/auto-quality.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../../relay/public/auto-quality.js'), 'utf8'));
});
test('Auto lowers delivery bitrate without changing item, media source or audio stream', () => {
  const s = session();
  assert.equal(s.sourceUrl().direct, true);
  s.autoQuality = Auto.lower(s.info, 'direct');
  const src = s.sourceUrl();
  assert.equal(src.direct, false);
  const url = new URL(src.url);
  assert.equal(url.pathname, '/stream/item/master.m3u8');
  assert.equal(url.searchParams.get('ms'), 'high-source');
  assert.equal(url.searchParams.get('audio'), '7');
  assert.equal(url.searchParams.get('br'), '6000000');
});
test('Nonstandard constrained budgets remain HLS; explicit quality is preserved', () => {
  const s = session({ autoQuality: '800000', qualities: [{ id: '800000' }] });
  assert.equal(s.sourceUrl().direct, false);
  assert.equal(new URL(s.sourceUrl().url).searchParams.get('br'), '800000');
  const manual = session({}, '3000000');
  assert.equal(manual.chooseQuality(), '3000000');
  const key = manual.sourceUrl().key;
  manual.info.mediaSourceId = 'another-source';
  assert.notEqual(manual.sourceUrl().key, key, 'different media sources must reload even under the same item ID');
});

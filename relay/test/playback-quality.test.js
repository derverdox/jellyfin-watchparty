'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bestSource, compareItems, deliveryPolicy } = require('../lib/playback-quality');
const { recommended, lower, StallGuard } = require('../public/auto-quality');
const access = { maxBitrate: 40000000, perms: { direct: true } };
const source = (Id, width, height, Bitrate) => ({ Id, Bitrate, MediaStreams: [{ Type: 'Video', Width: width, Height: height }] });

test('Choose highest real resolution rather than source order or alphabetic ID, including cropped encodes', () => {
  const sd = source('a', 1024, 576, 3000000), hd = source('z', 1920, 800, 8000000), uhd = source('q', 3840, 1600, 60000000);
  assert.equal(bestSource({ MediaSources: [sd, hd] }).Id, 'z');
  assert.equal(bestSource({ MediaSources: [hd, uhd, sd] }).Id, 'q');
  assert.equal(bestSource({ MediaSources: [source('other', 1920, 1080, 20000000), hd] }).Id, 'z'); // height 1080 vs cropped 800 both effective 1080, lower bitrate wins
  const items = [{ Id: 'a', MediaSources: [sd] }, { Id: 'z', MediaSources: [hd] }];
  assert.equal(items.sort(compareItems)[0].Id, 'z');
});

test('Compressed or cropped Full HD offers Full HD, not only SD/HD', () => {
  for (const bitrate of [4000000, 8000000, 30000000]) {
    const all = deliveryPolicy({ width: 1920, height: 1080, bitrate }, access);
    assert.ok(all.qualities.some((q) => q.id === '10000000' && q.height === 1080));
  }
  const d = { width: 1920, height: 800, bitrate: 4000000 };
  const policy = deliveryPolicy(d, access);
  assert.ok(policy.qualities.some((q) => q.id === '10000000' && q.height === 1080));
  assert.equal(policy.autoQuality, 'direct');
  assert.equal(policy.autoTranscodeQuality, '10000000');
  assert.equal(policy.qualities.some((q) => q.height > 1080), false);
  assert.equal(recommended({ ...d, ...policy }, policy.qualities.filter((q) => q.id !== 'direct')), '10000000', 'unsupported direct falls back within auto budget');
});

test('Delivery caps combine group, server and agent upload with headroom', () => {
  const d = { width: 3840, height: 2160, bitrate: 60000000 };
  let policy = deliveryPolicy(d, access, { maxMbps: 20, uploadMbps: 15, autoMbps: 10 });
  assert.equal(policy.maxBitrate, 12000000);
  assert.equal(policy.autoMaxBitrate, 10000000);
  assert.equal(policy.autoQuality, '10000000');
  assert.equal(policy.allowDirect, false);
  assert.ok(policy.qualities.every((q) => q.br <= 12000000));
  policy = deliveryPolicy(d, { ...access, maxBitrate: 3000000 }, { maxMbps: 20, uploadMbps: 15 });
  assert.ok(policy.qualities.every((q) => q.br <= 3000000));
  assert.equal(policy.autoQuality, '3000000');
  policy = deliveryPolicy(d, access, { uploadMbps: 1 });
  assert.equal(policy.autoQuality, '800000');
  assert.ok(policy.qualities.every((q) => q.br <= 800000));
  assert.equal(deliveryPolicy(d, access, { uploadMbps: 0.3 }).autoQuality, null);
  assert.equal(deliveryPolicy(d, access, { autoMbps: 0.8 }).autoQuality, '800000');
});

test('Direct remains permission and bitrate limited; unknown source bitrate uses capped HLS', () => {
  const d = { width: 1920, height: 1080, bitrate: 8000000 };
  assert.equal(deliveryPolicy(d, { ...access, perms: { direct: false } }).autoQuality, '10000000');
  assert.equal(deliveryPolicy({ ...d, bitrate: null }, access).allowDirect, false);
});

test('Auto only lowers delivery bitrate, skips manual seeks and pauses, and has a cooldown', () => {
  const info = { bitrate: 8000000, autoMaxBitrate: 10000000, qualities: [{ id: 'direct' }, { id: '10000000' }, { id: '6000000' }, { id: '3000000' }] };
  assert.equal(lower(info, 'direct'), '6000000');
  assert.equal(lower(info, '6000000'), '3000000');
  assert.equal(lower(info, '3000000'), null);
  const guard = new StallGuard(); const stalled = { playing: true, buffering: true };
  assert.equal(guard.check(stalled, 0), false);
  assert.equal(guard.check(stalled, 12000), true);
  assert.equal(guard.check(stalled, 25000), false);
  assert.equal(guard.check(stalled, 42000), true);
  assert.equal(guard.check({ ...stalled, playing: false }, 50000), false);
  assert.equal(guard.check(stalled, 70000), false);
  assert.equal(guard.check({ ...stalled, seeking: true }, 85000), false);
  assert.equal(guard.check(stalled, 99000), false);
});

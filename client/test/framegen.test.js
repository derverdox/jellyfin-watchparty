'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chooseMulti, toFraction, matrixName } = require('../src/main/framegen');
const { q } = require('../src/main/mpv');
const { normalizeServer } = require('../src/main/relay');

test('Bildraten als Bruch', () => {
  assert.deepStrictEqual(toFraction(23.976023976), [24000, 1001]);
  assert.deepStrictEqual(toFraction(24), [24, 1]);
  assert.deepStrictEqual(toFraction(29.97), [30000, 1001]);
  assert.deepStrictEqual(toFraction(59.94005994), [60000, 1001]);
  assert.strictEqual(toFraction(0), null);
});

test('Faktor passend zum Monitor', () => {
  assert.deepStrictEqual(chooseMulti(23.976, 143.86, 'display'), [6, 1]);   // 144-Hz-Monitor
  assert.deepStrictEqual(chooseMulti(23.976, 119.88, 'display'), [5, 1]);   // 120 Hz
  assert.deepStrictEqual(chooseMulti(24, 165, 'display'), [55, 8]);         // 165 Hz → 6,875×
  assert.deepStrictEqual(chooseMulti(24, 360, 'display'), [8, 1]);          // gedeckelt
  assert.deepStrictEqual(chooseMulti(50, 60, 'display'), [2, 1]);           // Monitor zu langsam → 2×
  assert.deepStrictEqual(chooseMulti(24, 144, 'x2'), [2, 1]);
  assert.deepStrictEqual(chooseMulti(24, null, 'display'), [2, 1]);
});

test('Farbmatrix', () => {
  assert.strictEqual(matrixName({ colormatrix: 'bt.2020-ncl', h: 2160 }), '2020ncl');
  assert.strictEqual(matrixName({ colormatrix: 'bt.709', h: 1080 }), '709');
  assert.strictEqual(matrixName({ colormatrix: 'bt.601', h: 480 }), '170m');
  assert.strictEqual(matrixName({ h: 480 }), '170m');
});

test('mpv-Optionswerte sicher quoten', () => {
  assert.strictEqual(q('C:\\Users\\Max\\rife.vpy'), '%21%C:\\Users\\Max\\rife.vpy');
  assert.strictEqual(q('ä'), '%2%ä'); // Bytes, nicht Zeichen
});

test('Serveradresse normalisieren', () => {
  assert.strictEqual(normalizeServer('example.com'), 'https://example.com');
  assert.strictEqual(normalizeServer('https://example.com/r/ABC'), 'https://example.com');
  assert.strictEqual(normalizeServer('http://127.0.0.1:8097/'), 'http://127.0.0.1:8097');
});

test('home.js ist im Web und im Client identisch', () => {
  const fs = require('fs');
  const path = require('path');
  const a = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'home.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', '..', 'relay', 'public', 'home.js'), 'utf8');
  assert.strictEqual(a, b, 'relay/public/home.js nach client/src/renderer/ kopieren');
});

test('extras.js ist im Web und im Client identisch', () => {
  const fs = require('fs');
  const path = require('path');
  const a = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'extras.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', '..', 'relay', 'public', 'extras.js'), 'utf8');
  assert.strictEqual(a, b, 'relay/public/extras.js nach client/src/renderer/ kopieren');
});

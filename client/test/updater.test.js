'use strict';
/** Automatische Updates: neuestes Release finden, laden, prüfen, Installer richtig starten. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Updater, pickRelease, newer } = require('../src/main/updater');

const setup = (v, extra = {}) => ({
  tag_name: `client-v${v}`, draft: false, prerelease: false, body: `Neu in ${v}`, html_url: `https://github.com/x/y/releases/tag/client-v${v}`,
  assets: [
    { name: `Watchparty-${v}-win-x64.zip`, browser_download_url: `https://dl/${v}.zip`, size: 5 },
    { name: `Watchparty-Setup-${v}.exe`, browser_download_url: `https://dl/Watchparty-Setup-${v}.exe`, size: 11, ...extra },
  ],
});

test('Versionen vergleichen und passendes Release wählen', () => {
  assert.ok(newer('1.10.0', '1.9.9'));
  assert.ok(newer('2.0.0', '1.99.99'));
  assert.ok(!newer('1.3.0', '1.3.0'));
  assert.ok(!newer('1.2.9', '1.3.0'));
  const list = [
    setup('1.3.0'),
    setup('1.5.0'),
    { ...setup('1.6.0'), prerelease: true },
    { ...setup('1.7.0'), draft: true },
    { tag_name: 'android-latest', assets: [{ name: 'watchparty.apk' }] },
    { tag_name: 'client-v1.4.0', assets: [{ name: 'Watchparty-1.4.0-win-x64.zip' }] }, // ohne Installer
  ];
  const r = pickRelease(list, '1.3.0');
  assert.strictEqual(r.version, '1.5.0');
  assert.strictEqual(r.name, 'Watchparty-Setup-1.5.0.exe');
  assert.strictEqual(pickRelease(list, '1.5.0'), null, 'schon aktuell');
});

test('Update laden, Prüfsumme prüfen, still installieren', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-upd-'));
  const body = Buffer.from('EXE-INHALT!');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  let releases = [setup('1.3.0'), setup('1.4.0', { digest: `sha256:${sha}` })];
  const fetchImpl = async (url) => {
    if (url.includes('/releases?')) return new Response(JSON.stringify(releases), { status: 200 });
    if (url.endsWith('.exe')) return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    return new Response('', { status: 404 });
  };
  const spawned = [];
  const spawnImpl = (file, args) => { spawned.push({ file, args }); return { unref() {} }; };
  const u = new Updater({ current: '1.3.0', dir, fetchImpl, spawnImpl, api: 'https://api.test' });
  const states = [];
  u.on('state', (s) => states.push(s.state));

  const st = await u.check();
  assert.strictEqual(st.state, 'ready');
  assert.strictEqual(st.version, '1.4.0');
  assert.deepStrictEqual([...new Set(states)], ['checking', 'downloading', 'ready']);
  assert.ok(fs.readFileSync(u.ready.file).equals(body));

  // „Jetzt neu starten“: still, als Update, danach wieder starten
  assert.ok(u.install(true));
  assert.deepStrictEqual(spawned[0].args, ['/S', '--updated', '--force-run']);
  assert.ok(!u.install(false), 'nur einmal');

  // Falsche Prüfsumme → verworfen
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-upd-'));
  releases = [setup('1.4.0', { digest: `sha256:${'0'.repeat(64)}` })];
  const u2 = new Updater({ current: '1.3.0', dir: dir2, fetchImpl, spawnImpl, api: 'https://api.test' });
  const st2 = await u2.check();
  assert.strictEqual(st2.state, 'error');
  assert.match(st2.error, /Prüfsumme/);
  assert.ok(!u2.install(false), 'nichts zu installieren');

  // Aktuell → nichts zu tun
  const u3 = new Updater({ current: '1.4.0', dir: dir2, fetchImpl, spawnImpl, api: 'https://api.test' });
  assert.strictEqual((await u3.check()).state, 'latest');

  // Beim Entwickeln aus
  const off = new Updater({ current: '1.0.0', dir: dir2, enabled: false, fetchImpl, spawnImpl });
  assert.strictEqual((await off.check()).state, 'off');
  for (const d of [dir, dir2]) fs.rmSync(d, { recursive: true, force: true });
});

'use strict';
// Join laufender Varianten: zweiter Zuschauer landet auf demselben Transcode,
// Bruchbitraten snapen auf die harte Strickleiter, Original zaehlt als aktive Variante.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fakeJf = require('./fixtures/fake-jellyfin');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Room converges on running variants; ladder snapping reaches Jellyfin', { timeout: 45000 }, async (t) => {
  const P = fakeJf.addPlaybackVersions();
  const jf = await fakeJf.start();
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-join-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: 's'.repeat(40),
    ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(dir, 'relay'), CACHE_DIR: path.join(dir, 'cache'),
    STREAM_MAX_MBPS: '20', AUTO_MAX_MBPS: '10' };
  const root = path.join(__dirname, '../..');
  const children = [spawn(process.execPath, [path.join(root, 'relay/server.js')], { env, stdio: 'ignore' }),
    spawn(process.execPath, [path.join(root, 'agent/agent.js')], { env: { ...env, DATA_DIR: path.join(dir, 'agent'),
      RELAY_URL: `ws://127.0.0.1:${port}/agent`, JELLYFIN_URL: `http://127.0.0.1:${jf.port}`, JELLYFIN_API_KEY: 'k', ADMIN_PORT: '0', MAX_UPLOAD_MBPS: '15' }, stdio: 'ignore' })];
  t.after(async () => {
    await Promise.all(children.map((child) => new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', r); child.kill(); })));
    await new Promise((r) => jf.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  function client() {
    let cookie = '';
    return { async req(method, endpoint, body) {
      const response = await fetch(base + endpoint, { method, headers: { Cookie: cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data };
    } };
  }
  for (let i = 0; i < 150; i++) { try { if ((await (await fetch(base + '/healthz')).json()).agent) break; } catch { /* startup */ } await sleep(50); }
  const chef = client();
  assert.equal((await chef.req('POST', '/api/login', { username: 'chef', password: 'geheim123' })).status, 200);

  // Harte Strickleiter im Menü: 12-Mbit-Deckel (15M Upload minus 20%) bietet keine 12M-Stufe
  const info = (await chef.req('GET', `/api/item/${P.NATIVE}`)).data;
  assert.equal(info.maxBitrate, 12000000);
  assert.ok(!info.qualities.some((q) => String(q.br) === '12000000'), 'kein Geister-Transcode zwischen den Stufen');
  assert.ok(info.qualities.some((q) => q.id === '10000000'));

  // Seher 1 startet 10M
  assert.equal((await chef.req('GET', `/stream/${P.NATIVE}/master.m3u8?ms=${info.mediaSourceId}&br=10000000`)).status, 200);
  const jfReq = fakeJf.requests.filter((r) => r.path === `/Videos/${P.NATIVE}/master.m3u8`).at(-1);
  assert.equal(jfReq.query.MaxStreamingBitrate, '10000000');

  // Seher 2 oeffnet denselben Titel: 10M ist aktiv, Auto wuerde joinen
  const info2 = (await chef.req('GET', `/api/item/${P.NATIVE}`)).data;
  assert.equal(info2.joinBitrate, '10000000', 'laufende Variante wird empfohlen');
  assert.ok(info2.qualities.find((q) => q.id === '10000000').active, 'Badge "laeuft bereits"');
  assert.equal(info2.directActive, false);

  // Bruchbitrate aus altem Menu/Deckel snap nach unten und trifft die bestaete Variante
  assert.equal((await chef.req('GET', `/stream/${P.NATIVE}/master.m3u8?ms=${info.mediaSourceId}&br=8000000`)).status, 200);
  const snapReq = fakeJf.requests.filter((r) => r.path === `/Videos/${P.NATIVE}/master.m3u8`).at(-1);
  assert.equal(snapReq.query.MaxStreamingBitrate, '6000000', '8M snap auf 6M-Stufe');
  const info3 = (await chef.req('GET', `/api/item/${P.NATIVE}`)).data;
  assert.ok(info3.qualities.find((q) => q.id === '6000000').active, '6M jetzt zweite aktive Variante');
  assert.equal(info3.joinBitrate, '10000000', 'empfohlen bleibt die hoechste laufende Stufe');

  // Original-Strom zaehlt als aktive Variante (Block-Cache teilt ihn bereits)
  assert.equal((await chef.req('GET', `/stream/${P.NATIVE}/direct?ms=${info.mediaSourceId}`)).status, 200);
  const info4 = (await chef.req('GET', `/api/item/${P.NATIVE}`)).data;
  assert.equal(info4.directActive, true, 'Original laeuft bereits');
  assert.ok(info4.qualities.find((q) => q.id === 'direct').active);

  // Ueberbuchung: 10M+6M+Original uebersteigen 12M-Budget -> Warner, aber freie Auswahl
  assert.equal(info4.overbook, true);
  assert.ok(info4.qualities.length >= 3);

  // Anderer Titel bleibt unberuehrt
  const other = (await chef.req('GET', `/api/item/${P.UHD}`)).data;
  assert.equal(other.joinBitrate, null, 'kein Join fuer einen Titel ohne laufende Variante');
  assert.equal(other.overbook, false);
});

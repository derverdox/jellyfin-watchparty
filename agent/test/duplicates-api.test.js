'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const fakeJellyfin = require('../../relay/test/fixtures/fake-jellyfin');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Authenticated admin can scan, poll and page duplicates including excluded libraries', { timeout: 30000 }, async (t) => {
  fakeJellyfin.addMovieVersions(510);
  const jf = await fakeJellyfin.start();
  const relayHttp = http.createServer();
  const relay = new WebSocketServer({ server: relayHttp });
  await new Promise((r) => relayHttp.listen(0, '127.0.0.1', r));
  const reservation = http.createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const adminPort = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-duplicates-'));
  const adminToken = 'duplicate-admin-token-for-test';
  const child = spawn(process.execPath, [path.join(__dirname, '../agent.js')], {
    env: { ...process.env, RELAY_URL: `ws://127.0.0.1:${relayHttp.address().port}/agent`, AGENT_TOKEN: 'x'.repeat(40),
      JELLYFIN_URL: `http://127.0.0.1:${jf.port}`, JELLYFIN_API_KEY: 'test', ADMIN_TOKEN: adminToken,
      ADMIN_BIND: '127.0.0.1', ADMIN_PORT: String(adminPort), DATA_DIR: dir }, stdio: 'ignore',
  });
  t.after(async () => {
    const stopped = new Promise((r) => { if (child.exitCode !== null || child.signalCode) r(); else child.once('exit', r); });
    child.kill(); await stopped;
    for (const ws of relay.clients) ws.terminate();
    await Promise.all([new Promise((r) => relayHttp.close(r)), new Promise((r) => jf.server.close(r))]);
    relay.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${adminPort}`;
  const api = (p, method = 'GET') => fetch(base + p, { method, headers: { Authorization: `Bearer ${adminToken}` } });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await api('/api/libraries'); if (r.ok) { ready = true; break; } } catch { /* startup */ }
    await sleep(50);
  }
  assert.ok(ready, 'agent connects to mock Jellyfin');
  assert.equal((await fetch(base + '/api/duplicates')).status, 401);
  assert.equal((await fetch(base + '/api/duplicates', { method: 'POST' })).status, 401);
  const page = await (await fetch(base + '/')).text();
  assert.ok(page.includes('Analyse starten'));
  new vm.Script(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.equal((await (await api('/api/duplicates')).json()).status, 'idle');
  const toggle = await fetch(base + '/api/toggle', { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: jf.I.LIB_K, excluded: true }) });
  assert.ok(toggle.ok);
  const started = await api('/api/duplicates', 'POST');
  assert.equal(started.status, 202);
  assert.equal((await started.json()).status, 'running');
  let result;
  for (let i = 0; i < 100; i++) {
    const response = await api('/api/duplicates?limit=1');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    result = await response.json();
    if (result.status !== 'running') break;
    await sleep(30);
  }
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.report.movieGroups, 1);
  assert.equal(result.report.groups[0].versions.length, 3);
  assert.ok(result.report.groups[0].versions.some((v) => v.excluded));
  assert.deepEqual(result.report.groups[0].availableQualities, ['SD', 'Full HD', '4K']);
  const next = await (await api('/api/duplicates?start=1&limit=1')).json();
  assert.equal(next.report.groups.length, 0);
  assert.equal(next.report.duplicateGroups, 1);
  const restarted = await api('/api/duplicates', 'POST');
  assert.equal(restarted.status, 202);
});

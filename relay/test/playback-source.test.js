'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const fakeJf = require('./fixtures/fake-jellyfin');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Whole room selects best accessible source; all clients pin it and bandwidth caps reach Jellyfin', { timeout: 45000 }, async (t) => {
  const P = fakeJf.addPlaybackVersions();
  const jf = await fakeJf.start();
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-source-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: 's'.repeat(40),
    ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(dir, 'relay'), CACHE_DIR: path.join(dir, 'cache'),
    STREAM_MAX_MBPS: '20', AUTO_MAX_MBPS: '10' };
  const root = path.join(__dirname, '../..');
  const children = [spawn(process.execPath, [path.join(root, 'relay/server.js')], { env, stdio: 'ignore' }),
    spawn(process.execPath, [path.join(root, 'agent/agent.js')], { env: { ...env, DATA_DIR: path.join(dir, 'agent'),
      RELAY_URL: `ws://127.0.0.1:${port}/agent`, JELLYFIN_URL: `http://127.0.0.1:${jf.port}`, JELLYFIN_API_KEY: 'k', ADMIN_PORT: '0', MAX_UPLOAD_MBPS: '15' }, stdio: 'ignore' })];
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await Promise.all(children.map((child) => new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', r); child.kill(); })));
    await new Promise((r) => jf.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  function client() {
    let cookie = '';
    return { get cookie() { return cookie; }, async req(method, endpoint, body) {
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
  const native = (await chef.req('GET', `/api/item/${P.NATIVE}`)).data;
  assert.equal(native.mediaSourceId, P.HIGH_SOURCE);
  assert.equal(native.height, 1080);
  assert.equal(native.defaultAudioIndex, 7);
  assert.equal(native.audio[0].lang, 'eng');
  assert.equal(native.runtime, 65);
  assert.equal(native.maxBitrate, 12000000, '15 Mbit/s agent upload minus 20% headroom');
  assert.equal(native.autoQuality, 'direct');
  assert.ok(native.qualities.some((q) => q.height === 1080 && !q.original));
  const pinned = (await chef.req('GET', `/api/item/${P.NATIVE}?ms=${P.LOW_SOURCE}`)).data;
  assert.equal(pinned.mediaSourceId, P.LOW_SOURCE);
  assert.equal(pinned.height, 576);
  assert.equal((await chef.req('GET', `/api/item/${P.NATIVE}?ms=${jf.MS}`)).status, 400);
  assert.equal((await chef.req('GET', `/stream/${P.NATIVE}/direct?ms=${jf.MS}`)).status, 400);
  assert.equal((await chef.req('GET', `/subs/${P.NATIVE}/${jf.MS}/2.vtt`)).status, 400);
  const uhdInfo = (await chef.req('GET', `/api/item/${P.UHD}`)).data;
  assert.equal(uhdInfo.allowDirect, false);
  assert.equal((await chef.req('GET', `/stream/${P.UHD}/direct?ms=${uhdInfo.mediaSourceId}`)).status, 403);
  const hlsPath = `/stream/${P.UHD}/master.m3u8?ms=${uhdInfo.mediaSourceId}&br=40000000`;
  assert.equal((await chef.req('GET', hlsPath)).status, 200);
  let request = fakeJf.requests.filter((r) => r.path === `/Videos/${P.UHD}/master.m3u8`).at(-1);
  assert.equal(request.query.MaxStreamingBitrate, '12000000');
  assert.equal(request.query.AllowVideoStreamCopy, 'false');
  assert.equal(request.query.AllowAudioStreamCopy, 'false');
  assert.equal(request.query.MaxHeight, '1080');
  assert.equal(request.query.MediaSourceId, uhdInfo.mediaSourceId);
  const childPath = `/stream/${P.UHD}/main.m3u8?mediasourceid=${uhdInfo.mediaSourceId}&videobitrate=60000000&AllowVideoStreamCopy=true&MaxHeight=2160`;
  assert.equal((await chef.req('GET', childPath)).status, 200);
  request = fakeJf.requests.filter((r) => r.path === `/Videos/${P.UHD}/main.m3u8`).at(-1);
  assert.equal(request.query.MaxStreamingBitrate, '12000000');
  assert.equal(request.query.AllowVideoStreamCopy, 'false');
  assert.equal(request.query.AllowAudioStreamCopy, 'false');
  assert.equal(request.query.MaxHeight, '1080');
  assert.equal((await chef.req('GET', `/stream/${P.UHD}/master.m3u8?ms=${uhdInfo.mediaSourceId}&br=500000`)).status, 200);
  request = fakeJf.requests.filter((r) => r.path === `/Videos/${P.UHD}/master.m3u8`).at(-1);
  assert.ok(Number(request.query.VideoBitrate) + Number(request.query.AudioBitrate) <= 500000, 'audio and video jointly stay within a small budget');
  // Access applies to every candidate and every viewer, even when an admin starts the movie.
  const group = (await chef.req('POST', '/api/admin/groups', { name: 'Nur Filme', perms: { direct: true, createRoom: true, load: true, control: true }, maxBitrate: 10000000,
    access: { mode: 'only', ids: [jf.I.LIB_M] } })).data.group;
  assert.ok(group && group.id);
  assert.equal((await chef.req('POST', '/api/admin/users', { username: 'gast', password: 'passwort123', groups: [group.id] })).status, 200);
  const gast = client();
  assert.equal((await gast.req('POST', '/api/login', { username: 'gast', password: 'passwort123' })).status, 200);
  const code = (await chef.req('POST', '/api/rooms')).data.code;
  async function join(viewer) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`, { headers: { Cookie: viewer.cookie } });
    sockets.push(ws); const messages = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw)));
    await new Promise((r) => ws.once('open', r));
    return { ws, messages };
  }
  const c = await join(chef), g = await join(gast);
  async function load(id, position = 0) {
    c.messages.length = 0; g.messages.length = 0;
    c.ws.send(JSON.stringify({ t: 'load', itemId: id, position }));
    for (let i = 0; i < 200; i++) {
      const result = c.messages.find((m) => m.t === 'playback' && m.action === 'load');
      if (result) return result.playback;
      await sleep(30);
    }
    assert.fail('Timed out waiting for movie selection: ' + JSON.stringify(c.messages));
  }
  let playback = await load(P.SD);
  assert.equal(playback.item.id, P.HD, 'Full HD selected rather than restricted UHD, SD or another cut');
  assert.ok(playback.item.mediaSourceId);
  for (let i = 0; i < 30 && !g.messages.some((m) => m.t === 'playback' && m.action === 'load'); i++) await sleep(20);
  const guestPlayback = g.messages.find((m) => m.t === 'playback' && m.action === 'load').playback;
  assert.equal(guestPlayback.item.mediaSourceId, playback.item.mediaSourceId);
  const guestInfo = (await gast.req('GET', `/api/item/${playback.item.id}?ms=${playback.item.mediaSourceId}`)).data;
  assert.equal(guestInfo.height, 1080);
  playback = await load(P.SD, 20);
  assert.equal(playback.item.id, P.SD, 'resume never transfers a timestamp into another file');
  playback = await load(P.NATIVE);
  assert.equal(playback.item.mediaSourceId, P.HIGH_SOURCE);
  playback = await load(P.NATIVE, 20);
  assert.equal(playback.item.mediaSourceId, P.LOW_SOURCE, 'legacy resume without source information retains the former first source');
});

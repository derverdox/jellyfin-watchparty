#!/usr/bin/env node
'use strict';
/**
 * Tut so, als wäre es mpv: JSON-IPC, Eigenschaften, Ereignisse und eine
 * simulierte Abspieluhr. Lädt Streams wirklich vom Relay (mit den gesetzten
 * HTTP-Headern), damit Cookie-Auth und Range-Anfragen mitgetestet werden.
 *
 * Zusätzliche Test-Befehle über IPC:
 *   ["fake-key", "toggle"]     → wie Tastendruck (script-message wp toggle)
 *   ["fake-osc-pause", true]   → wie Klick auf Pause in der mpv-Leiste
 *   ["fake-osc-seek", 42]      → wie Ziehen in der mpv-Leiste
 */
const net = require('net');
const fs = require('fs');

const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const ipcPath = arg('input-ipc-server');
const LOG = process.env.FAKE_MPV_LOG;
const RATE = Number(process.env.FAKE_MPV_RATE || 1); // < 1: Player läuft zu langsam
const SEEK_MS = Number(process.env.FAKE_MPV_SEEK_MS || 250);

function log(o) { if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), ...o })}\n`); }

const props = {
  'time-pos': null, pause: false, 'paused-for-cache': false, seeking: false, duration: null, 'eof-reached': false,
  'video-params': null, 'track-list': [], speed: 1, 'display-fps': 144, 'display-width': 3840, 'display-height': 2160,
  'estimated-vf-fps': null, 'container-fps': null, fullscreen: false, volume: Number(arg('volume') || 100), mute: false,
  'idle-active': true, vf: [], 'hwdec-current': 'no', 'demuxer-cache-time': 0,
  'http-header-fields': [], start: 'none', 'force-media-title': '', hwdec: 'auto', aid: 1, sid: 'no',
  'rebase-start-time': 'yes', 'demuxer-lavf-o': '', 'ytdl-format': '', 'demuxer-cache-state': { 'seekable-ranges': [] },
};
const W = 2 ** 33 / 90000;
let live = false;
const observers = new Map(); // name -> [ {sock, id} ]
const clients = new Set();
let loaded = false;

function sendTo(sock, obj) { try { sock.write(`${JSON.stringify(obj)}\n`); } catch { /* egal */ } }
function broadcast(obj) { for (const c of clients) sendTo(c, obj); }
function setProp(name, value) {
  const changed = JSON.stringify(props[name]) !== JSON.stringify(value);
  props[name] = value;
  if (changed) for (const o of observers.get(name) || []) sendTo(o.sock, { event: 'property-change', id: o.id, name, data: value });
}
function event(name, extra = {}) { broadcast({ event: name, ...extra }); }

function doSeek(pos, fromUser) {
  setProp('seeking', true);
  event('seek');
  log({ ev: 'seek', pos, fromUser: !!fromUser });
  setTimeout(() => {
    setProp('time-pos', live ? pos : Math.max(0, Math.min(pos, props.duration || pos)));
    setProp('seeking', false);
    event('playback-restart');
  }, SEEK_MS);
}

/**
 * Twitch wie echtes mpv mit rebase-start-time=no + live_start_index=0: Playlist holen,
 * erstes Segment laden, Zeit = roher PTS (wie libavformat: nahe am 33-Bit-Überlauf negativ).
 */
async function loadLive(url, headers) {
  const { firstPts } = require('../../../relay/lib/twitch');
  const pl = await (await fetch(url, { headers })).text();
  const segUrl = new URL(pl.split('\n').find((l) => l && !l.startsWith('#')), url).toString();
  const r = await fetch(segUrl, { headers });
  const buf = Buffer.from(await r.arrayBuffer());
  let pts = firstPts(buf);
  if (pts > W / 2) pts -= W;
  log({ ev: 'loadfile', url, status: r.status, bytes: buf.length, cookie: headers.Cookie || null, pause: props.pause, rebase: props['rebase-start-time'], lavf: props['demuxer-lavf-o'], firstSeg: segUrl.split('/').pop(), pts });
  live = true;
  setProp('duration', null);
  setProp('video-params', { w: 320, h: 180, pixelformat: 'yuv420p', colormatrix: 'bt.709', colorlevels: 'limited' });
  setProp('track-list', [{ id: 1, type: 'video', codec: 'h264', selected: true, 'ff-index': 0 }]);
  setProp('time-pos', pts);
  setProp('demuxer-cache-state', { 'seekable-ranges': [{ start: pts, end: pts + 120 }] });
  loaded = true;
  event('file-loaded');
  setTimeout(() => event('playback-restart'), 100);
}

async function loadfile(url) {
  loaded = false;
  live = false;
  setProp('idle-active', false);
  setProp('eof-reached', false);
  if (url.startsWith('ytdl://')) {
    // YouTube über yt-dlp: normale Zeitachse ab 0
    log({ ev: 'loadfile', url, ytdlFormat: props['ytdl-format'], start: props.start, pause: props.pause, rebase: props['rebase-start-time'] });
    setProp('duration', 212.5);
    setProp('video-params', { w: 1920, h: 1080, pixelformat: 'yuv420p', colormatrix: 'bt.709', colorlevels: 'limited' });
    setProp('track-list', [{ id: 1, type: 'video', codec: 'vp9', selected: true, 'ff-index': 0 }]);
    const st = String(props.start);
    setProp('time-pos', st === 'none' ? 0 : Number(st.replace('+', '')) || 0);
    loaded = true;
    event('file-loaded');
    setTimeout(() => event('playback-restart'), 100);
    return;
  }
  const headers = {};
  for (const h of props['http-header-fields'] || []) { const i = h.indexOf(':'); headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
  if (props['rebase-start-time'] === 'no' && /\.m3u8/.test(url)) { try { await loadLive(url, headers); } catch (e) { log({ ev: 'loadfile', url, error: e.message }); event('end-file', { reason: 'error' }); } return; }
  headers.Range = 'bytes=0-65535';
  let status = 0, bytes = 0, type = '';
  try {
    const r = await fetch(url, { headers });
    status = r.status; type = r.headers.get('content-type') || '';
    bytes = (await r.arrayBuffer()).byteLength;
  } catch (e) { status = -1; type = e.message; }
  log({ ev: 'loadfile', url, status, bytes, type, cookie: headers.Cookie || null, start: props.start, pause: props.pause });
  if (status !== 206 && status !== 200) { event('end-file', { reason: 'error' }); return; }
  setProp('duration', 90);
  setProp('container-fps', 23.976023976023978);
  setProp('video-params', { w: 640, h: 360, pixelformat: 'yuv420p', colormatrix: 'bt.709', colorlevels: 'limited' });
  setProp('track-list', [
    { id: 1, type: 'video', codec: 'h264', selected: true, 'ff-index': 0 },
    { id: 1, type: 'audio', codec: 'aac', lang: 'deu', title: 'Deutsch', selected: true, 'ff-index': 1 },
  ]);
  const s = String(props.start);
  const start = s === 'none' ? 0 : Number(s.replace('+', '')) || 0;
  setProp('time-pos', start);
  loaded = true;
  event('file-loaded');
  setTimeout(() => event('playback-restart'), 100);
}

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;
  if (!loaded || props.pause || props.seeking || props['paused-for-cache']) return;
  let p = props['time-pos'] + dt * props.speed * RATE;
  if (props.duration && p >= props.duration) { p = props.duration; setProp('eof-reached', true); setProp('pause', true); }
  setProp('time-pos', p);
}, 40);

async function handle(sock, msg) {
  const [cmd, ...a] = msg.command || [];
  const reply = (data, error = 'success') => sendTo(sock, { request_id: msg.request_id, error, data });
  switch (cmd) {
    case 'observe_property': {
      const list = observers.get(a[1]) || [];
      list.push({ sock, id: a[0] });
      observers.set(a[1], list);
      reply(null);
      sendTo(sock, { event: 'property-change', id: a[0], name: a[1], data: props[a[1]] ?? null });
      return;
    }
    case 'get_property': return a[0] in props ? reply(props[a[0]]) : reply(null, 'property not found');
    case 'set_property':
      if (a[0] === 'pause' || a[0] === 'speed' || a[0] === 'vf' || a[0] === 'hwdec') log({ ev: 'set', name: a[0], value: a[1] });
      setProp(a[0], a[1]);
      return reply(null);
    case 'loadfile': reply(null); return loadfile(a[0]);
    case 'seek': reply(null); return doSeek(Number(a[0]), false);
    case 'vf': log({ ev: 'vf', op: a[0], value: a[1] }); setProp('vf', a[0] === 'clr' ? [] : String(a[1] || '').split(',').filter(Boolean)); return reply(null);
    case 'show-text': log({ ev: 'osd', text: a[0] }); return reply(null);
    case 'sub-add': {
      const headers = {};
      for (const h of props['http-header-fields'] || []) { const i = h.indexOf(':'); headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
      let status = 0, body = '';
      try { const r = await fetch(a[0], { headers }); status = r.status; body = await r.text(); } catch (e) { status = -1; body = e.message; }
      log({ ev: 'sub-add', url: a[0], status, ok: body.startsWith('WEBVTT') });
      const tl = props['track-list'].slice();
      tl.push({ id: 1, type: 'sub', external: true, lang: a[3] || '', title: a[2] || '', selected: false });
      setProp('track-list', tl);
      return reply(null);
    }
    case 'stop': loaded = false; setProp('idle-active', true); return reply(null);
    case 'cycle': setProp(a[0], !props[a[0]]); return reply(null);
    case 'quit': reply(null); setTimeout(() => process.exit(0), 20); return;
    case 'fake-key': reply(null); return event('client-message', { args: ['wp', ...a.map(String)] });
    case 'fake-osc-pause': reply(null); return setProp('pause', !!a[0]);
    case 'fake-osc-seek': reply(null); return doSeek(Number(a[0]), true);
    default: return reply(null);
  }
}

if (process.platform !== 'win32') { try { fs.unlinkSync(ipcPath); } catch { /* egal */ } }
const server = net.createServer((sock) => {
  clients.add(sock);
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) { try { handle(sock, JSON.parse(line)); } catch { /* egal */ } }
    }
  });
  sock.on('close', () => { clients.delete(sock); for (const l of observers.values()) for (let k = l.length - 1; k >= 0; k--) if (l[k].sock === sock) l.splice(k, 1); });
  sock.on('error', () => {});
});
server.listen(ipcPath, () => log({ ev: 'started', args: process.argv.slice(2) }));
process.on('SIGTERM', () => process.exit(0));

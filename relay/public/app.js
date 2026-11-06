'use strict';
/* Jellyfin Watchparty – Client */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const video = $('#video');
const player = $('#player');
// Heiße Pfade (updateControls, seek) laufen mehrfach pro Sekunde → Knoten cachen
const D = {
  btnPlay: $('#btn-play'), btnBack: $('#btn-back'), btnFwd: $('#btn-fwd'), btnNext: $('#btn-next'), btnLive: $('#btn-live'),
  tCur: $('#t-cur'), tDur: $('#t-dur'),
  seek: $('#seek'), seekFill: $('#seek-fill'), seekBuffer: $('#seek-buffer'), seekTip: $('#seek-tip'),
};

/** Qualitäten kommen pro Datei vom Server (nie mehr als das Original hergibt). */
function qualityList(info) {
  const list = (info && info.qualities) || [];
  // Original nur anbieten, wenn der Browser die Datei direkt abspielen kann
  return list.filter((q) => q.id !== 'direct' || info.directPlayable);
}
/** Beste Transcode-Stufe (für „Automatisch“ und als Ausweg) */
function bestTranscode(info) {
  const t = qualityList(info).find((q) => q.id !== 'direct');
  return t ? t.id : '10000000';
}

const S = {
  me: null,             // { name, id }
  you: null,            // vom Server: { clientId, sid, name }
  code: null,
  room: null,           // { code, host, allowAllControl }
  members: [],
  playback: null,       // { item, playing, position, updatedAt, seq }
  info: null,           // Details zum geladenen Item (Tonspuren, Untertitel …)
  loadedId: null,
  loadedKey: null,
  hls: null,
  playSession: null,
  ws: null,
  wsRetry: 0,
  offset: 0,            // Serverzeit - lokale Zeit
  bestRtt: Infinity,
  rttSamples: [],
  lastHardSeek: 0,
  blocked: false,
  seeking: false,
  leaving: false,
  correcting: false,
  prefs: loadPrefs(),
  sel: { quality: null, audio: null, sub: -1 },
  mode: 'video',        // 'video' (Jellyfin), 'twitch' (Relay-Restream) oder 'yt' (YouTube-Player) – siehe media.js
  lib: { stack: [], search: '' },
};

/* ------------------------------------------------------------------ */
/* Utils                                                               */
/* ------------------------------------------------------------------ */

function loadPrefs() {
  try { return { quality: 'auto', audioLang: '', subLang: 'off', volume: 1, muted: false, ...JSON.parse(localStorage.getItem('wp_prefs') || '{}') }; }
  catch { return { quality: 'auto', audioLang: '', subLang: 'off', volume: 1, muted: false }; }
}
function savePrefs() { try { localStorage.setItem('wp_prefs', JSON.stringify(S.prefs)); } catch { /* egal */ } }

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function hue(str) { let h = 0; for (const ch of str) h = (h * 31 + ch.codePointAt(0)) % 360; return h; }
function colorFor(name) { return `hsl(${hue(name)} 75% 68%)`; }
function randHex(n = 16) { return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Fehler ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function showView(id) {
  for (const v of $$('.view')) v.hidden = v.id !== id;
  // Mit Admin-Konto angemeldet → rotes Design
  document.body.classList.toggle('is-admin', !!(S.me && S.me.admin));
}

function serverNow() { return Date.now() + S.offset; }

function canControl() {
  return !!(S.room && S.you && (S.room.allowAllControl || S.room.host === S.you.sid));
}
function isHost() { return !!(S.room && S.you && S.room.host === S.you.sid); }
function perm(k) { return !!(S.me && (S.me.admin || (S.me.perms && S.me.perms[k]))); }
/** Etwas für alle starten: steuern dürfen UND (Host oder Recht „Filme auswählen“). */
function canLoad() { return canControl() && (isHost() || perm('load')); }

/* ------------------------------------------------------------------ */
/* Start / Routing                                                     */
/* ------------------------------------------------------------------ */

function codeFromUrl() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,12})/);
  return m ? m[1].toUpperCase() : null;
}

async function init() {
  window.addEventListener('popstate', () => location.reload());
  try { S.me = await api('/api/me'); } catch { S.me = null; }
  route();
}

function pairFromUrl() {
  const m = location.pathname.match(/^\/pair\/([A-Za-z0-9-]{4,20})\/?$/);
  return m ? m[1].toUpperCase() : null;
}

function inviteFromUrl() {
  const m = location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{8,40})/);
  return m ? m[1] : null;
}

/** „Zusammen schauen“: Räume erstellen/beitreten, Konto, Verwaltung (früher die Startseite). */
function showLobby() { S.showLobby = true; route(); }

async function route() {
  const invite = inviteFromUrl();
  if (invite && !S.me) {
    let valid = false;
    try { valid = (await api(`/api/invite/${invite}`)).valid; } catch { /* egal */ }
    if (valid) { showView('view-register'); $('#register-form').username.focus(); return; }
    history.replaceState(null, '', '/');
    toast('Diese Einladung ist ungültig oder schon benutzt.');
  } else if (invite) {
    history.replaceState(null, '', '/');
  }
  const code = codeFromUrl();
  const pair = pairFromUrl();
  if (pair && !S.me) {
    showLogin(null);
    $('#login-hint').textContent = 'Melde dich an, um das andere Gerät freizugeben.';
    return;
  }
  if (pair && window.WPPair) return WPPair.confirm(pair);
  if (!S.me) return showLogin(code);
  if (code) {
    $('#join-code').textContent = code;
    $('#join-name').textContent = S.me.name;
    return showView('view-join');
  }
  if (!S.showLobby && window.WPHome) { renderAgentStatus(S.me.agentOnline, S.me.server); return WPHome.show(); }
  S.showLobby = false;
  $('#lobby-name').textContent = S.me.name;
  renderAgentStatus(S.me.agentOnline, S.me.server);
  $('#admin-box').hidden = !(S.me.admin || (perm('invite') && S.me.invitesEnabled));
  $('#btn-admin').hidden = !S.me.admin;
  $('#admin-flag').hidden = !S.me.admin;
  $('#btn-create').hidden = !perm('createRoom');
  $('#no-create').hidden = perm('createRoom');
  $('#lobby-or').hidden = !perm('createRoom');
  $('#lobby-hint').textContent = perm('createRoom') ? 'Mach einen Raum auf und schick deinem Kumpel den Link.' : 'Gib den Raum-Code ein, den du bekommen hast.';
  const motd = $('#motd');
  motd.hidden = !S.me.motd;
  motd.textContent = S.me.motd || '';
  showView('view-lobby');
  if (window.WP && WP.lobby) WP.lobby();
  if (window.WPHome) WPHome.lobbyRooms();
}

function renderAgentStatus(online, server) {
  const box = $('#lobby-agent');
  box.classList.toggle('on', !!online);
  box.textContent = online ? `Heimserver online${server ? ` (${server})` : ''}` : 'Heimserver offline – Filme sind gerade nicht verfügbar';
  // Twitch/YouTube brauchen den Heimserver nicht
  const external = !!(S.playback && S.playback.item && S.playback.item.source);
  $('#agent-banner').hidden = !!online || external || $('#view-room').hidden;
}

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#register-error');
  err.hidden = true;
  if (f.password.value !== f.password2.value) { err.textContent = 'Die Passwörter stimmen nicht überein.'; err.hidden = false; return; }
  try {
    S.me = await api(`/api/invite/${inviteFromUrl()}`, { method: 'POST', body: { username: f.username.value.trim(), password: f.password.value } });
    try { localStorage.setItem('wp_name', S.me.username); } catch { /* egal */ }
    history.replaceState(null, '', '/');
    toast(`Willkommen, ${S.me.name}!`);
    route();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

$('#btn-invite-user').addEventListener('click', async () => {
  try {
    const r = await api('/api/invites', { method: 'POST' });
    const link = location.origin + r.path;
    const out = $('#invite-out');
    out.hidden = false;
    out.textContent = '';
    out.append(el('div', {}, `Einmal-Link, ${r.hours} Stunden gültig:`), el('strong', {}, link));
    try { await navigator.clipboard.writeText(link); toast('Link kopiert – schick ihn rüber!'); } catch { /* egal */ }
  } catch (ex) { toast(ex.message); }
});

$('#btn-pw').addEventListener('click', () => { $('#pw-form').hidden = !$('#pw-form').hidden; });
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/password', { method: 'POST', body: { old: f.old.value, password: f.password.value } });
    f.reset(); f.hidden = true;
    toast('Passwort geändert. Andere Geräte wurden abgemeldet.');
  } catch (ex) { toast(ex.message); }
});

function showLogin(code) {
  $('#login-hint').textContent = code ? `Du wurdest in Raum ${code} eingeladen.` : 'Zusammen schauen, egal wo ihr seid.';
  const f = $('#login-form');
  try { f.username.value = localStorage.getItem('wp_name') || ''; } catch { /* egal */ }
  showView('view-login');
  (f.username.value ? f.password : f.username).focus();
  if (window.WPPair) WPPair.loginShown();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#login-error');
  err.hidden = true;
  try {
    S.me = await api('/api/login', { method: 'POST', body: { username: f.username.value.trim(), password: f.password.value } });
    try { localStorage.setItem('wp_name', S.me.username); } catch { /* egal */ }
    f.password.value = '';
    const code = codeFromUrl();
    if (code) enterRoom(code); // Klick zählt als Interaktion → Autoplay erlaubt
    else route();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#btn-create').addEventListener('click', async () => {
  try {
    const { code } = await api('/api/rooms', { method: 'POST' });
    history.pushState(null, '', `/r/${code}`);
    enterRoom(code);
  } catch (ex) { showErr('#lobby-error', ex); }
});

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = e.target.code.value.trim().toUpperCase();
  try {
    await api(`/api/rooms/${encodeURIComponent(code)}`);
    history.pushState(null, '', `/r/${code}`);
    enterRoom(code);
  } catch (ex) { showErr('#lobby-error', ex.status === 404 ? new Error('Diesen Raum gibt es nicht (mehr).') : ex); }
});

$('#btn-join').addEventListener('click', async () => {
  const code = codeFromUrl();
  try {
    await api(`/api/rooms/${encodeURIComponent(code)}`);
    enterRoom(code);
  } catch (ex) {
    if (ex.status === 401) return showLogin(code);
    showErr('#join-error', ex.status === 404 ? new Error('Diesen Raum gibt es nicht (mehr). Frag nach einem neuen Link.') : ex);
  }
});
$('#btn-join-rename').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  S.me = null;
  showLogin(codeFromUrl());
});
$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  S.me = null;
  route();
});

function showErr(sel, ex) {
  const e = $(sel);
  e.textContent = ex.message;
  e.hidden = false;
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

function enterRoom(code) {
  S.code = code;
  S.leaving = false;
  $('#room-code').textContent = code;
  document.title = `Watchparty · ${code}`;
  showView('view-room');
  applyVolumePrefs();
  connect();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(S.code)}`);
  S.ws = ws;
  let opened = false;

  ws.onopen = () => {
    opened = true;
    S.wsRetry = 0;
    $('#conn-banner').hidden = true;
    S.rttSamples = [];
    S.bestRtt = Infinity;
    for (let i = 0; i < 5; i++) setTimeout(ping, i * 250);
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  };

  ws.onclose = async (ev) => {
    if (S.ws !== ws || S.leaving) return;
    if (ev.code === 4001) return;
    if (!opened) {
      // Raum weg oder Session abgelaufen?
      try { await api(`/api/rooms/${S.code}`); }
      catch (ex) {
        if (ex.status === 401) { S.me = null; return showLogin(S.code); }
        if (ex.status === 404) { teardownPlayer(); toast('Der Raum existiert nicht mehr.'); history.replaceState(null, '', '/'); return route(); }
      }
    }
    $('#conn-banner').hidden = false;
    const delay = Math.min(1000 * 2 ** S.wsRetry++, 10000);
    setTimeout(() => { if (!S.leaving) connect(); }, delay);
  };
}

function send(msg) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
}

function ping() { send({ t: 'ping', c: Date.now() }); }
setInterval(() => { if (S.ws && S.ws.readyState === 1) ping(); }, 5000);

function onPong(msg) {
  const now = Date.now();
  const rtt = now - msg.c;
  if (rtt < 0 || rtt > 10000) return;
  S.rttSamples.push({ rtt, off: msg.s + rtt / 2 - now });
  if (S.rttSamples.length > 12) S.rttSamples.shift();
  // Offset aus den Samples mit der kleinsten Laufzeit (genauer)
  const best = [...S.rttSamples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
  S.offset = best.reduce((s, x) => s + x.off, 0) / best.length;
  S.bestRtt = best[0].rtt;
}

function onMessage(msg) {
  if (window.WP && WP.onMessage) WP.onMessage(msg); // Zusatzfunktionen (extras.js)
  switch (msg.t) {
    case 'welcome':
      S.you = msg.you;
      S.room = msg.room;
      S.members = msg.members;
      S.offset = msg.serverNow - Date.now();
      renderReactBar(msg.reactions);
      $('#chat').innerHTML = '';
      for (const m of msg.chat) addChat(m, true);
      scrollChat(true);
      renderMembers();
      renderControlState();
      if (S.me) { S.me.agentOnline = msg.agentOnline; S.me.server = msg.server; }
      renderAgentStatus(msg.agentOnline, msg.server);
      setPlayback(msg.playback);
      if (S.pendingPlay) {
        const pp = S.pendingPlay;
        S.pendingPlay = null;
        const same = msg.playback && msg.playback.item && msg.playback.item.id === pp.itemId;
        if (!same && canLoad()) send({ t: 'load', itemId: pp.itemId, position: pp.position || 0, play: true });
        else if (same && canControl() && !msg.playback.playing) send({ t: 'control', action: 'play', position: msg.playback.position });
      }
      break;
    case 'agent':
      if (S.me) { S.me.agentOnline = msg.online; S.me.server = msg.server; }
      renderAgentStatus(msg.online, msg.server);
      if (msg.online && S.playback && S.playback.item && S.info == null) { S.loadedId = null; setPlayback(S.playback); }
      else if (msg.online && S.loadedKey && video.error) { S.loadedKey = null; buildSource(); }
      break;
    case 'pong': onPong(msg); break;
    case 'playback': setPlayback(msg.playback); break;
    case 'members': S.members = msg.members; renderMembers(); break;
    case 'room':
      S.room = msg.room;
      if (msg.members) S.members = msg.members;
      renderMembers();
      renderControlState();
      break;
    case 'chat': addChat(msg.msg); break;
    case 'react': floatEmoji(msg.emoji, msg.from); break;
    case 'error': toast(msg.text); break;
    case 'load-url': onLoadUrl(msg); break;
    case 'announce':
      toast(`📣 ${msg.from}: ${msg.text}`);
      break;
    case 'noaccess':
      teardownPlayer();
      S.loadedId = msg.item.id; // nicht ständig neu versuchen
      $('#overlay-empty').hidden = true;
      $('#overlay-noaccess').hidden = false;
      $('#noaccess-title').textContent = msg.item.title;
      break;
    case 'kicked':
      S.leaving = true;
      teardownPlayer();
      toast(msg.text || 'Du wurdest aus dem Raum entfernt.');
      history.replaceState(null, '', '/');
      route();
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Playback & Sync                                                     */
/* ------------------------------------------------------------------ */

function expectedPos() {
  const pb = S.playback;
  if (!pb) return 0;
  let p = pb.playing ? pb.position + (serverNow() - pb.updatedAt) / 1000 : pb.position;
  const dur = (pb.item && pb.item.runtime) || mediaDuration();
  if (!(pb.item && pb.item.live) && Number.isFinite(dur) && dur > 0) p = Math.min(p, dur);
  return Math.max(0, p);
}

function setPlayback(pb) {
  if (S.playback && pb.seq < S.playback.seq && pb.item && S.playback.item && pb.item.id === S.playback.item.id) return;
  S.playback = pb;
  renderNowPlaying();
  if (S.me) renderAgentStatus(S.me.agentOnline, S.me.server);
  if (!pb.item) {
    teardownPlayer();
    $('#overlay-noaccess').hidden = true;
    $('#overlay-empty').hidden = false;
    return;
  }
  $('#overlay-empty').hidden = true;
  if (pb.item.id !== S.loadedId) {
    $('#overlay-noaccess').hidden = true;
    if (pb.item.source) loadExternal(pb.item); // Twitch / YouTube (media.js)
    else loadItem(pb.item.id);
  } else {
    syncTick(true);
  }
  updateControls();
}

async function loadItem(id) {
  if (S.mode !== 'video') teardownPlayer(); // von Twitch/YouTube zurück auf Jellyfin
  S.loadedId = id;
  S.info = null;
  $('#overlay-loading').hidden = false;
  try {
    const info = await api(`/api/item/${id}`);
    if (S.loadedId !== id) return;
    S.info = info;
    chooseTracks();
    fillSettings();
    buildSource();
  } catch (ex) {
    toast(`Konnte das Video nicht laden: ${ex.message}`);
    $('#overlay-loading').hidden = true;
  }
}

function chooseTracks() {
  const info = S.info;
  // Qualität
  const q = S.prefs.quality;
  const avail = qualityList(info);
  if (q === 'auto' || avail.some((x) => x.id === q)) S.sel.quality = q;
  else if (q === 'direct') S.sel.quality = bestTranscode(info);
  else {
    // gespeicherte Stufe gibt es bei dieser Datei nicht → nächstkleinere nehmen
    const lower = avail.filter((x) => x.id !== 'direct' && Number(x.id) <= Number(q));
    S.sel.quality = lower.length ? lower[0].id : 'auto';
  }
  // Tonspur: bevorzugte Sprache, sonst Standard
  const al = S.prefs.audioLang;
  const a = (al && info.audio.find((x) => x.lang === al)) || info.audio.find((x) => x.index === info.defaultAudioIndex) || info.audio[0];
  S.sel.audio = a ? a.index : null;
  // Untertitel
  const sl = S.prefs.subLang;
  let s = -1;
  // Ohne eigene Wahl bleiben Untertitel aus, auch wenn die Datei eine Spur als Standard markiert
  if (!sl || sl === 'off') s = -1;
  else {
    const cand = info.subs.filter((x) => x.lang === sl);
    const pick = cand.find((x) => !x.isForced && x.isText) || cand.find((x) => !x.isForced) || cand[0];
    if (pick) s = pick.index;
  }
  S.sel.sub = s;
}

function fillSettings() {
  const info = S.info;
  const qs = $('#sel-quality');
  qs.innerHTML = '';
  qs.append(el('option', { value: 'auto', selected: S.sel.quality === 'auto' }, `Automatisch${info.resolution ? ` (bis ${info.resolution})` : ''}`));
  for (const q of qualityList(info)) qs.append(el('option', { value: q.id, selected: q.id === S.sel.quality }, q.label));
  const as = $('#sel-audio');
  as.innerHTML = '';
  for (const a of info.audio) as.append(el('option', { value: a.index, selected: a.index === S.sel.audio }, a.label));
  if (!info.audio.length) as.append(el('option', {}, '—'));
  const ss = $('#sel-subs');
  ss.innerHTML = '';
  ss.append(el('option', { value: -1, selected: S.sel.sub === -1 }, 'Aus'));
  for (const s of info.subs) {
    ss.append(el('option', { value: s.index, selected: s.index === S.sel.sub }, s.label + (s.isText ? '' : ' (eingebrannt)')));
  }
}

function currentSub() { return S.info && S.info.subs.find((s) => s.index === S.sel.sub); }

function buildSource() {
  const info = S.info;
  if (!info) return;
  if (S.mode !== 'video') return buildExternal();
  const sub = currentSub();
  const burn = sub && !sub.isText;
  // Direktwiedergabe geht nur ohne Spurwechsel / eingebrannte Untertitel
  const audioIsDefault = S.sel.audio == null || S.sel.audio === info.defaultAudioIndex;
  const direct = (S.sel.quality === 'direct' || S.sel.quality === 'auto') && info.directPlayable && audioIsDefault && !burn;
  const key = [info.id, direct ? 'direct' : S.sel.quality, S.sel.audio, burn ? sub.index : ''].join('|');

  if (key !== S.loadedKey) {
    S.loadedKey = key;
    destroyHls();
    stopTranscode();
    const start = expectedPos();
    let url;
    if (direct) {
      url = `/stream/${info.id}/direct?ms=${info.mediaSourceId}`;
    } else {
      S.playSession = randHex(16);
      const q = new URLSearchParams({ ms: info.mediaSourceId, ps: S.playSession, br: S.sel.quality === 'direct' || S.sel.quality === 'auto' ? bestTranscode(info) : S.sel.quality });
      if (S.sel.audio != null) q.set('audio', S.sel.audio);
      if (burn) q.set('sub', sub.index);
      url = `/stream/${info.id}/master.m3u8?${q}`;
    }
    $('#overlay-loading').hidden = false;
    if (!direct && window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        startPosition: start,
        maxBufferLength: 40,
        backBufferLength: 60,
        fragLoadPolicy: { default: { maxTimeToFirstByteMs: 60000, maxLoadTimeMs: 120000, timeoutRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 4000 }, errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 } } },
        manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 30000, maxLoadTimeMs: 60000, timeoutRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 4000 }, errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 4000 } } },
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { toast('Wiedergabefehler – versuche eine niedrigere Qualität.'); reportStatus('error'); }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      S.hls = hls;
    } else {
      video.src = url; // Safari kann HLS nativ; Direktstream überall
      video.addEventListener('loadedmetadata', () => { try { seekLocal(expectedPos()); } catch { /* egal */ } }, { once: true });
    }
  }
  applyTextTrack();
}

function applyTextTrack() {
  for (const t of $$('track', video)) t.remove();
  const sub = currentSub();
  if (!sub || !sub.isText || !S.info) return;
  const tr = el('track', { kind: 'subtitles', label: sub.label, srclang: sub.lang || 'und', src: `/subs/${S.info.id}/${S.info.mediaSourceId}/${sub.index}.vtt`, default: true });
  video.append(tr);
  tr.addEventListener('load', () => { tr.track.mode = 'showing'; });
  setTimeout(() => { if (tr.track) tr.track.mode = 'showing'; }, 50);
}

function destroyHls() {
  if (S.hls) { S.hls.destroy(); S.hls = null; }
  video.removeAttribute('src');
  try { video.load(); } catch { /* egal */ }
}

function stopTranscode() {
  if (!S.playSession) return;
  const ps = S.playSession;
  S.playSession = null;
  const body = JSON.stringify({ ps });
  if (navigator.sendBeacon) navigator.sendBeacon('/api/stop', new Blob([body], { type: 'application/json' }));
  else fetch('/api/stop', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
}

function teardownPlayer() {
  destroyHls();
  stopTranscode();
  teardownExternal();
  S.loadedId = null;
  S.loadedKey = null;
  S.info = null;
  for (const t of $$('track', video)) t.remove();
  $('#overlay-loading').hidden = true;
  $('#overlay-blocked').hidden = true;
  $('#btn-next').hidden = true;
}

async function tryPlay() {
  if (S.blocked) return;
  if (S.mode === 'yt') { ytPlay(); return; }
  try {
    await video.play();
  } catch (ex) {
    if (ex && ex.name === 'NotAllowedError') {
      S.blocked = true;
      $('#overlay-blocked').hidden = false;
      reportStatus('blocked');
    }
  }
}

$('#btn-unblock').addEventListener('click', () => {
  S.blocked = false;
  $('#overlay-blocked').hidden = true;
  syncTick(true);
  tryPlay();
});

/**
 * Hält das lokale Video am gemeinsamen Zeitpunkt.
 * Kleine Abweichungen werden weich über die Abspielgeschwindigkeit ausgeglichen,
 * große durch einen Sprung.
 */
function syncTick(force = false) {
  const pb = S.playback;
  // Während der Nutzer am Balken zieht, nicht hinter ihm ins Video springen
  if (!pb || !pb.item || !S.loadedKey || S.seeking) return;
  if (S.mode === 'yt') return ytSync(force);
  if (video.readyState < 1) return;
  const exp = expectedPos();
  const cur = curPos();
  if (!Number.isFinite(cur)) return; // Twitch: Zeitstempel noch unbekannt

  if (!pb.playing) {
    if (!video.paused) video.pause();
    video.playbackRate = 1;
    if (!video.seeking && Math.abs(cur - exp) > 0.08) seekLocal(exp);
    return;
  }

  if (S.mode === 'video' && video.ended && exp >= (video.duration || Infinity) - 1) return;
  if (video.paused && !S.blocked) tryPlay();
  if (video.seeking) return;

  const diff = exp - cur; // >0: ich hänge hinterher
  const ad = Math.abs(diff);
  const now = performance.now();
  if (ad > 1.5 && (force || now - S.lastHardSeek > 3000 || ad > 8)) {
    S.lastHardSeek = now;
    video.playbackRate = 1;
    // etwas vorausspringen, damit nach dem Laden nicht gleich wieder Rückstand ist
    seekLocal(exp + (diff > 0 && video.readyState < 3 ? 0.5 : 0));
    S.correcting = false;
    return;
  }
  if (video.readyState < 3) return;
  if (ad > 0.35) S.correcting = true;
  if (S.correcting && ad < 0.08) S.correcting = false;
  video.playbackRate = S.correcting ? 1 + Math.max(-0.08, Math.min(0.08, diff * 0.12)) : 1;
}
setInterval(() => syncTick(false), 300);

function reportStatus(forceState) {
  if (!S.playback || !S.playback.item) return send({ t: 'status', pos: 0, state: 'idle' });
  let state = forceState;
  if (!state) {
    if (S.blocked) state = 'blocked';
    else if (S.mode === 'yt') state = ytState();
    else if (!S.loadedKey || video.readyState < 3 || video.seeking) state = S.playback.playing ? 'buffering' : (video.readyState < 1 ? 'buffering' : 'paused');
    else state = video.paused ? 'paused' : 'playing';
  }
  const cur = curPos();
  const pos = Number.isFinite(cur) ? cur : expectedPos();
  const msg = { t: 'status', pos, state, drift: Number.isFinite(cur) ? expectedPos() - cur : 0 };
  if (S.mode === 'yt' && mediaDuration()) msg.dur = mediaDuration();
  send(msg);
}
setInterval(() => reportStatus(), 2000);

video.addEventListener('waiting', () => { $('#overlay-loading').hidden = false; });
video.addEventListener('playing', () => { $('#overlay-loading').hidden = true; });
video.addEventListener('canplay', () => { $('#overlay-loading').hidden = true; syncTick(true); });
video.addEventListener('seeked', () => { if (video.readyState >= 3) $('#overlay-loading').hidden = true; });
video.addEventListener('loadedmetadata', () => { syncTick(true); updateControls(); });
video.addEventListener('timeupdate', updateControls);
video.addEventListener('progress', updateControls);
video.addEventListener('ended', () => updateControls());
video.addEventListener('error', () => {
  if (!S.loadedKey) return;
  $('#overlay-loading').hidden = true;
  if (S.loadedKey.includes('|direct|')) {
    toast('Direktwiedergabe klappt hier nicht – wechsle auf Transcoding.');
    S.sel.quality = bestTranscode(S.info);
    fillSettings();
    buildSource();
  } else toast('Video konnte nicht abgespielt werden.');
});

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

function duration() {
  if (isLive()) { const w = liveWindow(); return w ? w.end - w.start : 0; }
  const d = (S.playback && S.playback.item && S.playback.item.runtime) || mediaDuration();
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function updateControls() {
  const pb = S.playback;
  if (isLive()) return updateLiveControls();
  D.btnLive.hidden = true;
  const dur = duration();
  const local = S.loadedKey ? curPos() : NaN;
  const cur = S.seeking ? Number(D.seek.value) / 1000 * dur : (Number.isFinite(local) ? local : expectedPos());
  D.tCur.textContent = fmt(cur);
  D.tDur.textContent = fmt(dur);
  D.btnPlay.textContent = pb && pb.playing ? '❚❚' : '▶';
  if (!S.seeking) {
    D.seek.value = dur ? Math.round((cur / dur) * 1000) : 0;
    D.seekFill.style.width = dur ? `${(cur / dur) * 100}%` : '0';
  }
  let buf = 0;
  if (S.mode === 'yt') buf = ytBuffered();
  else for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 1) buf = Math.max(buf, video.buffered.end(i));
  }
  D.seekBuffer.style.width = dur ? `${Math.min(100, (buf / dur) * 100)}%` : '0';
  const next = pb && pb.item && pb.item.nextEpisodeId;
  const hideNext = !(next && canLoad() && dur && cur > dur - 180);
  if (D.btnNext.hidden !== hideNext) D.btnNext.hidden = hideNext;
}

function renderControlState() {
  const ok = canControl();
  for (const id of ['#btn-play', '#btn-back', '#btn-fwd', '#seek', '#btn-live']) $(id).disabled = !ok;
  $('#lock-hint').hidden = ok;
  $('#host-panel').hidden = !isHost();
  $('#chk-all-control').checked = !!(S.room && S.room.allowAllControl);
  $('#chk-private').checked = !!(S.room && S.room.private);
  updateControls();
  renderChatActions();
}

function control(action, position) {
  if (!canControl() || !S.playback || !S.playback.item) return;
  if (action === 'live') { send({ t: 'control', action }); return; }
  // Sofort lokal anwenden (fühlt sich direkter an), Server bestätigt
  const pb = { ...S.playback, position, updatedAt: serverNow(), playing: action === 'play' ? true : action === 'pause' ? false : S.playback.playing };
  S.playback = pb;
  syncTick(true);
  updateControls();
  send({ t: 'control', action, position });
}

function togglePlay() {
  if (!S.playback || !S.playback.item) return;
  if (S.blocked) { $('#btn-unblock').click(); return; }
  const cur = S.loadedKey ? curPos() : NaN;
  const pos = Number.isFinite(cur) ? cur : expectedPos();
  control(S.playback.playing ? 'pause' : 'play', pos);
}
function seekBy(d) {
  if (!S.playback || !S.playback.item) return;
  if (isLive()) { control('seek', expectedPos() + d); return; } // Server hält es im DVR-Fenster
  const dur = duration();
  control('seek', Math.max(0, Math.min(dur || Infinity, expectedPos() + d)));
}

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-back').addEventListener('click', () => seekBy(-10));
$('#btn-fwd').addEventListener('click', () => seekBy(10));
video.addEventListener('click', () => {
  // Wenn die Leiste gerade versteckt ist (v. a. am Handy), erst nur einblenden
  if (player.classList.contains('idle')) return wake();
  if (canControl()) togglePlay();
});
video.addEventListener('dblclick', toggleFs);

const seek = $('#seek');
seek.addEventListener('input', () => {
  S.seeking = true;
  const t = (Number(seek.value) / 1000) * duration();
  D.seekFill.style.width = `${seek.value / 10}%`;
  D.tCur.textContent = fmt(t);
});
seek.addEventListener('change', () => {
  const t = (Number(seek.value) / 1000) * duration();
  S.seeking = false;
  const w = isLive() && liveWindow();
  control('seek', w ? w.start + t : t);
});
// Tooltip: Rect cachen (getBoundingClientRect pro Maus-Event erzwingt Reflow) und
// DOM-Schreibarbeiten auf ein rAF pro Frame bündeln.
let seekRect = null, tipRaf = 0, tipPos = 0;
seek.addEventListener('mouseenter', () => { seekRect = seek.getBoundingClientRect(); });
window.addEventListener('resize', () => { seekRect = null; });
document.addEventListener('fullscreenchange', () => { seekRect = null; });
seek.addEventListener('mousemove', (e) => {
  const r = seekRect || (seekRect = seek.getBoundingClientRect());
  tipPos = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  if (!tipRaf) tipRaf = requestAnimationFrame(() => {
    tipRaf = 0;
    const dur = duration();
    D.seekTip.hidden = !dur;
    D.seekTip.textContent = isLive() ? `−${fmt(dur - tipPos * dur)}` : fmt(tipPos * dur);
    D.seekTip.style.left = `${tipPos * 100}%`;
  });
});
seek.addEventListener('mouseleave', () => { D.seekTip.hidden = true; });

$('#btn-next').addEventListener('click', () => {
  const next = S.playback && S.playback.item && S.playback.item.nextEpisodeId;
  if (next) send({ t: 'load', itemId: next });
});

// Lautstärke (lokal)
function applyVolumePrefs() {
  video.volume = S.prefs.volume;
  video.muted = S.prefs.muted;
  ytVolume();
  $('#volume').value = S.prefs.volume;
  $('#btn-mute').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
}
$('#volume').addEventListener('input', (e) => {
  S.prefs.volume = Number(e.target.value);
  S.prefs.muted = S.prefs.volume === 0;
  applyVolumePrefs();
  savePrefs();
});
$('#btn-mute').addEventListener('click', () => {
  S.prefs.muted = !video.muted;
  if (!S.prefs.muted && S.prefs.volume === 0) S.prefs.volume = 0.8;
  applyVolumePrefs();
  savePrefs();
});

// Einstellungen (lokal)
$('#btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#settings-menu').hidden = !$('#settings-menu').hidden;
});
$('#settings-menu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { $('#settings-menu').hidden = true; });

$('#sel-quality').addEventListener('change', (e) => {
  if (S.mode === 'twitch') { setTwitchVariant(e.target.value); return; }
  S.sel.quality = e.target.value;
  S.prefs.quality = e.target.value;
  savePrefs();
  buildSource();
});
$('#sel-audio').addEventListener('change', (e) => {
  S.sel.audio = Number(e.target.value);
  const a = S.info && S.info.audio.find((x) => x.index === S.sel.audio);
  S.prefs.audioLang = a ? a.lang : '';
  savePrefs();
  buildSource();
});
$('#sel-subs').addEventListener('change', (e) => {
  S.sel.sub = Number(e.target.value);
  const s = currentSub();
  S.prefs.subLang = s ? s.lang : 'off';
  savePrefs();
  buildSource();
});

// Vollbild
function toggleFs() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (player.requestFullscreen) player.requestFullscreen().catch(() => {});
  else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
}
$('#btn-fs').addEventListener('click', toggleFs);
document.addEventListener('fullscreenchange', () => player.classList.toggle('fs', !!document.fullscreenElement));
document.addEventListener('webkitfullscreenchange', () => player.classList.toggle('fs', !!document.webkitFullscreenElement));

$('#btn-chat-toggle').addEventListener('click', () => document.body.classList.toggle('chat-hidden'));

// Steuerleiste automatisch ausblenden
let idleTimer, lastWakeAt = 0;
function wake() {
  player.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (S.playback && S.playback.playing && $('#settings-menu').hidden) player.classList.add('idle');
  }, 3000);
}
player.addEventListener('mousemove', () => {
  // Maus liefert 60–125 Events/s: Timer nur neu stellen, wenn es wirklich zählt
  const now = performance.now();
  if (now - lastWakeAt < 250 && !player.classList.contains('idle')) return;
  lastWakeAt = now;
  wake();
});
player.addEventListener('touchstart', wake, { passive: true });
player.addEventListener('mouseleave', () => { if (S.playback && S.playback.playing) player.classList.add('idle'); });

// Tastatur
document.addEventListener('keydown', (e) => {
  if ($('#view-room').hidden || !$('#library').hidden) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-10); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(10); }
  else if (e.key === 'f') toggleFs();
  else if (e.key === 'm') $('#btn-mute').click();
  else if (e.key === 'c') $('#btn-chat-toggle').click();
  else if (e.key === 'Enter') { e.preventDefault(); $('#chat-input').focus(); }
  wake();
});

function renderNowPlaying() {
  const box = $('#now-playing');
  box.innerHTML = '';
  const item = S.playback && S.playback.item;
  if (!item) { box.append(el('span', { class: 'muted' }, 'Noch nichts ausgewählt')); return; }
  if (item.source) box.append(el('span', { class: `src-badge ${item.source}` }, item.source === 'twitch' ? '● LIVE' : '▶ YouTube'));
  box.append(el('strong', {}, item.title));
  if (item.subtitle) box.append(el('span', { class: 'muted' }, ` · ${item.subtitle}`));
}

/* ------------------------------------------------------------------ */
/* Chat, Reaktionen, Leute                                             */
/* ------------------------------------------------------------------ */

function scrollChat(force) {
  const c = $('#chat');
  if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 120) c.scrollTop = c.scrollHeight;
}

function addChat(m, silent) {
  const time = new Date(m.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  let li;
  if (m.kind === 'system') {
    li = el('li', { class: 'sys' }, m.text);
  } else if (m.kind === 'announce') {
    li = el('li', { class: 'announce' }, el('b', {}, `📣 ${m.from}`), el('span', {}, m.text));
  } else if (m.kind === 'suggest') {
    li = el('li', { class: 'suggest', 'data-item': m.itemId },
      el('div', {}, el('span', { class: 'who', style: `color:${colorFor(m.from)}` }, m.from), ' schlägt vor:'),
      el('strong', {}, m.text),
      el('button', { class: 'btn small primary play-suggest', onclick: () => send({ t: 'load', itemId: m.itemId }) }, '▶ Abspielen'));
  } else {
    li = el('li', { class: 'msg' },
      el('span', { class: 'who', style: `color:${colorFor(m.from)}` }, m.from),
      el('span', { class: 'txt' }, m.text),
      el('span', { class: 'ts' }, time));
  }
  $('#chat').append(li);
  while ($('#chat').children.length > 300) $('#chat').firstElementChild.remove();
  renderChatActions();
  scrollChat(!silent && m.sid === (S.you && S.you.sid));
  if (!silent && m.kind !== 'system') playerToast(m);
}

function renderChatActions() {
  for (const b of $$('.play-suggest')) b.hidden = !canLoad();
  const chatOk = perm('chat');
  const f = $('#chat-form');
  for (const x of $$('input, button', f)) x.disabled = !chatOk;
  f.querySelector('input').placeholder = chatOk ? f.querySelector('input').dataset.ph || f.querySelector('input').placeholder : 'Chatten ist für dich nicht freigeschaltet';
}

function playerToast(m) {
  const layer = $('#toasts-layer');
  const t = el('div', { class: 'ptoast' }, el('b', {}, m.from + ': '), m.kind === 'suggest' ? `schlägt „${m.text}“ vor` : m.text);
  layer.append(t);
  setTimeout(() => t.remove(), 6000);
  while (layer.children.length > 4) layer.firstElementChild.remove();
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  input.value = '';
});

function renderReactBar(list) {
  const bar = $('#react-bar');
  bar.innerHTML = '';
  for (const emoji of list || []) bar.append(el('button', { title: 'Reaktion senden', onclick: () => send({ t: 'react', emoji }) }, emoji));
}

function floatEmoji(emoji, from) {
  const layer = $('#reactions-layer');
  const e = el('div', { class: 'float-emoji', style: `left:${10 + Math.random() * 75}%` }, emoji, el('small', {}, from));
  layer.append(e);
  setTimeout(() => e.remove(), 3000);
}

function memberStatus(m) {
  const st = m.status || {};
  if (!S.playback || !S.playback.item) return { text: 'bereit', cls: '' };
  switch (st.state) {
    case 'buffering': return { text: '⏳ lädt…', cls: 'warn' };
    case 'blocked': return { text: '⚠ muss einmal klicken', cls: 'warn' };
    case 'error': return { text: '✖ Wiedergabefehler', cls: 'bad' };
    case 'idle': return { text: 'verbindet…', cls: '' };
  }
  const drift = Math.abs(st.drift || 0);
  const base = `${st.state === 'playing' ? '▶' : '❚❚'} ${fmt(st.pos)}`;
  if (drift > 2) return { text: `${base} · ${drift.toFixed(0)} s versetzt`, cls: 'warn' };
  return { text: `${base} · synchron`, cls: '' };
}

function renderMembers() {
  const ul = $('#people');
  ul.innerHTML = '';
  $('#member-count').textContent = S.members.length;
  const host = isHost();
  for (const m of S.members) {
    const st = memberStatus(m);
    const me = S.you && m.id === S.you.clientId;
    const acts = el('div', { class: 'acts' });
    if (host && !m.isHost) {
      acts.append(
        el('button', { class: 'icon', title: 'Zum Host machen', onclick: () => send({ t: 'makeHost', clientId: m.id }) }, '👑'),
        el('button', { class: 'icon', title: 'Aus dem Raum entfernen', onclick: () => { if (confirmKick(m.name)) send({ t: 'kick', clientId: m.id }); } }, '✕'));
    }
    ul.append(el('li', {},
      el('div', { class: 'avatar', style: `background:${colorFor(m.name)}` }, (m.name[0] || '?').toUpperCase()),
      el('div', { class: 'info' },
        el('div', { class: 'name' }, m.name, m.isHost ? ' 👑' : '', me ? el('span', { class: 'muted' }, ' (du)') : ''),
        el('div', { class: `st ${st.cls}` }, st.text)),
      acts));
  }
}

let kickArmed = null;
function confirmKick(name) {
  // kein Browser-Dialog: zweimal klicken bestätigt
  if (kickArmed === name) { kickArmed = null; return true; }
  kickArmed = name;
  toast(`Nochmal klicken, um ${name} zu entfernen`);
  setTimeout(() => { if (kickArmed === name) kickArmed = null; }, 3000);
  return false;
}

$('#chk-all-control').addEventListener('change', (e) => send({ t: 'settings', allowAllControl: e.target.checked }));
$('#chk-private').addEventListener('change', (e) => send({ t: 'settings', private: e.target.checked }));

for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of $$('.tab')) t.classList.toggle('active', t === tab);
    for (const b of $$('#side .tab-body')) b.hidden = b.id !== `tab-${tab.dataset.tab}`;
  });
}

$('#btn-invite').addEventListener('click', async () => {
  const link = `${location.origin}/r/${S.code}`;
  try { await navigator.clipboard.writeText(link); toast('Einladungslink kopiert – schick ihn deinem Kumpel!'); }
  catch { toast(link); }
});

$('#btn-rename').addEventListener('click', () => {
  const box = el('form', { class: 'row', style: 'padding:8px 16px' },
    el('input', { name: 'n', maxlength: 24, value: S.me ? S.me.name : '' }),
    el('button', { class: 'btn small primary', type: 'submit' }, 'OK'));
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = box.n.value.trim();
    if (!name) return;
    try {
      S.me = await api('/api/name', { method: 'POST', body: { name } });
      send({ t: 'rename', name: S.me.name });
      try { localStorage.setItem('wp_name', S.me.name); } catch { /* egal */ }
    } catch (ex) { toast(ex.message); }
    box.remove();
  });
  $('.me-panel').before(box);
  box.n.focus();
});

$('#btn-leave').addEventListener('click', () => {
  S.leaving = true;
  teardownPlayer();
  if (S.ws) S.ws.close();
  S.playback = null;
  S.code = null; S.you = null; S.room = null;
  document.title = 'Watchparty';
  $('#agent-banner').hidden = true;
  history.pushState(null, '', '/');
  route();
});
$('#btn-home').addEventListener('click', () => $('#btn-leave').click());

/** Alleine abspielen: eigenen (wiederverwendeten) Raum öffnen und den Titel starten. Freunde kommen per Link dazu. */
async function playSolo(itemId, position = 0) {
  try {
    if (S.code && S.you && !$('#view-room').hidden) {
      if (canLoad()) send({ t: 'load', itemId, position, play: S.members && S.members.length === 1 });
      else toast('Hier steuert gerade jemand anderes.');
      return;
    }
    const { code } = await api('/api/rooms', { method: 'POST', body: { solo: true } });
    S.pendingPlay = { itemId, position };
    history.pushState(null, '', `/r/${code}`);
    enterRoom(code);
  } catch (ex) { toast(ex.message); }
}

window.addEventListener('pagehide', stopTranscode);

/* ------------------------------------------------------------------ */
/* Bibliothek                                                          */
/* ------------------------------------------------------------------ */

function openLibrary() {
  $('#library').hidden = false;
  loadWatchIds();
  if (!S.lib.stack.length) S.lib.stack = [{ id: null, name: 'Bibliothek' }];
  renderLib();
  setTimeout(() => $('#lib-search').focus(), 50);
}
function closeLibrary() { $('#library').hidden = true; }

$('#btn-library').addEventListener('click', openLibrary);
$('#btn-library-empty').addEventListener('click', openLibrary);
$('#lib-close').addEventListener('click', closeLibrary);
$('#library').addEventListener('click', (e) => { if (e.target.id === 'library') closeLibrary(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#library').hidden) closeLibrary(); });

S.lib.view = 'browse';
S.lib.sort = (() => { try { return localStorage.getItem('wp_sort') || 'name'; } catch { return 'name'; } })();
S.watchIds = new Set();
async function loadWatchIds() {
  try { S.watchIds = new Set((await api('/api/watchlist')).items.map((x) => x.id)); } catch { /* egal */ }
}

for (const b of $$('#lib-tabs button')) {
  b.addEventListener('click', () => {
    if (b.dataset.v === 'wishes') { if (window.WP) WP.openBoard(); return; }
    S.lib.view = b.dataset.v;
    S.lib.search = '';
    $('#lib-search').value = '';
    renderLib();
  });
}
$('#lib-sort').value = S.lib.sort;
$('#lib-sort').addEventListener('change', (e) => {
  S.lib.sort = e.target.value;
  try { localStorage.setItem('wp_sort', S.lib.sort); } catch { /* egal */ }
  renderLib();
});

let searchTimer;
$('#lib-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.lib.search = e.target.value.trim(); renderLib(); }, 250);
});
$('#lib-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); S.lib.search = e.target.value.trim(); renderLib(); }
});

function libGo(entry) {
  S.lib.view = 'browse';
  S.lib.stack.push(entry);
  S.lib.search = '';
  $('#lib-search').value = '';
  renderLib();
}

function renderCrumbs() {
  const nav = $('#crumbs');
  nav.innerHTML = '';
  for (const b of $$('#lib-tabs button')) b.classList.toggle('on', !S.lib.search && b.dataset.v === S.lib.view);
  const top = S.lib.stack[S.lib.stack.length - 1];
  const sortable = !S.lib.search && S.lib.view === 'browse' && top && top.id && !['Series', 'Season'].includes(top.type);
  $('#lib-sort').hidden = !sortable;
  if (S.lib.search) { nav.append(el('button', {}, `Suche: „${S.lib.search}“`)); return; }
  if (S.lib.view === 'watchlist') { nav.append(el('button', {}, 'Deine Merkliste')); return; }
  if (S.lib.view === 'top') { nav.append(el('button', {}, 'Bei uns am besten bewertet')); return; }
  if (S.lib.view === 'history') { nav.append(el('button', {}, 'Zuletzt geschaut')); return; }
  S.lib.stack.forEach((c, i) => {
    if (i) nav.append(el('span', { class: 'sep' }, '›'));
    nav.append(el('button', { onclick: () => { S.lib.stack = S.lib.stack.slice(0, i + 1); renderLib(); } }, c.name));
  });
}

function section(title, items, n) {
  const wide = items.every((i) => i.type === 'Episode' || i.type === 'CollectionFolder' || i.type === 'UserView' || (i.aspect && i.aspect > 1.2));
  return el('div', { class: 'lib-section' },
    title ? el('h3', {}, title, n != null ? el('span', { class: 'n' }, `${n}`) : '') : '',
    el('div', { class: `grid${wide ? ' wide' : ''}` }, items.map((it) => tile(it))));
}

let libToken = 0;
async function renderLib(append = false) {
  const token = ++libToken;
  renderCrumbs();
  const body = $('#lib-body');
  const top = S.lib.stack[S.lib.stack.length - 1];
  if (!append) body.innerHTML = '<div class="lib-empty"><div class="spinner" style="margin:auto"></div></div>';
  try {
    /* --- Suche: gruppiert und nach Relevanz --- */
    if (S.lib.search) {
      if (S.lib.search.length < 2) { body.innerHTML = ''; body.append(el('div', { class: 'lib-empty' }, 'Mindestens zwei Buchstaben …')); return; }
      const r = await api(`/api/search?q=${encodeURIComponent(S.lib.search)}`);
      if (token !== libToken) return;
      body.innerHTML = '';
      const total = r.movies.length + r.series.length + r.episodes.length;
      if (!total) { body.append(el('div', { class: 'lib-empty' }, `Nichts gefunden für „${S.lib.search}“. Tipp: weniger Wörter oder nur ein Teil des Titels.`)); return; }
      if (r.year) body.append(el('p', { class: 'search-hint' }, `Nur Titel aus ${r.year}`));
      if (r.movies.length) body.append(section('Filme', r.movies, r.movies.length));
      if (r.series.length) body.append(section('Serien & Sammlungen', r.series, r.series.length));
      if (r.episodes.length) body.append(section('Folgen', r.episodes, r.episodes.length));
      return;
    }
    /* --- Bei uns am besten bewertet --- */
    if (S.lib.view === 'top') {
      const r = await api('/api/top-rated');
      if (token !== libToken) return;
      body.innerHTML = '';
      if (!r.items.length) { body.append(el('div', { class: 'lib-empty' }, 'Noch nichts bewertet. Auf jeder Detailseite kannst du 1–10 Sterne vergeben.')); return; }
      body.append(section('', r.items.map((x) => ({ ...x, ourRating: x.ours }))));
      return;
    }
    /* --- Merkliste --- */
    if (S.lib.view === 'watchlist') {
      const r = await api('/api/watchlist');
      if (token !== libToken) return;
      S.watchIds = new Set(r.items.map((x) => x.id));
      body.innerHTML = '';
      if (!r.items.length) { body.append(el('div', { class: 'lib-empty' }, 'Noch nichts gemerkt. Fahr über einen Titel und klick auf ☆.')); return; }
      body.append(section('', r.items));
      return;
    }
    /* --- Zuletzt geschaut --- */
    if (S.lib.view === 'history') {
      const r = await api('/api/history');
      if (token !== libToken) return;
      body.innerHTML = '';
      if (!r.items.length) { body.append(el('div', { class: 'lib-empty' }, 'Hier erscheint, was du geschaut hast – mit Fortschritt.')); return; }
      const items = r.items.map((h) => ({ id: h.id, name: h.type === 'Episode' ? `${h.title} – ${h.subtitle}` : h.title, type: h.type, playable: true, hasImage: true, runtime: h.runtime, progress: h.progress, finished: h.finished, when: h.at, aspect: h.type === 'Episode' ? 1.78 : null }));
      body.append(section('', items));
      body.append(el('div', { class: 'lib-more' }, el('button', { class: 'btn small', onclick: async () => { await api('/api/history', { method: 'DELETE' }); renderLib(); } }, 'Verlauf leeren')));
      return;
    }
    /* --- Durchblättern --- */
    let data;
    if (!top.id) {
      data = await api('/api/libraries');
      // Startseite: oben die Merkliste-Vorschau und „Weiterschauen“
      if (!append) {
        const [hist, wl] = await Promise.all([api('/api/history').catch(() => ({ items: [] })), api('/api/watchlist').catch(() => ({ items: [] }))]);
        if (token !== libToken) return;
        body.innerHTML = '';
        const cont = hist.items.filter((h) => !h.finished && h.progress > 2).slice(0, 6)
          .map((h) => ({ id: h.id, name: h.type === 'Episode' ? `${h.title} – ${h.subtitle}` : h.title, type: h.type, playable: true, hasImage: true, runtime: h.runtime, progress: h.progress, aspect: 1.78 }));
        if (cont.length) body.append(section('Weiterschauen', cont));
        if (wl.items.length) body.append(section('Merkliste', wl.items.slice(0, 6)));
        body.append(section('Bibliotheken', data.items || []));
        return;
      }
    } else {
      const sort = top.type === 'Series' || top.type === 'Season' ? 'index' : S.lib.sort;
      const q = new URLSearchParams({ parentId: top.id, sort, limit: 60, start: append ? top.loaded || 0 : 0 });
      if (top.collectionType) q.set('collectionType', top.collectionType);
      data = await api(`/api/items?${q}`);
    }
    if (token !== libToken) return;
    const items = data.items || [];
    let grid = append ? $('.grid', body) : null;
    if (!append) {
      body.innerHTML = '';
      if (!items.length) { body.append(el('div', { class: 'lib-empty' }, 'Hier ist nichts.')); return; }
      const wide = items.every((i) => i.type === 'Episode' || i.type === 'CollectionFolder' || i.type === 'UserView' || (i.aspect && i.aspect > 1.2));
      grid = el('div', { class: `grid${wide ? ' wide' : ''}` });
      body.append(grid);
    }
    for (const it of items) grid.append(tile(it));
    $('.lib-more', body)?.remove();
    if (top && top.id) {
      top.loaded = (append ? top.loaded || 0 : 0) + items.length;
      if (data.total > top.loaded) {
        body.append(el('div', { class: 'lib-more' }, el('button', { class: 'btn', onclick: () => renderLib(true) }, `Mehr laden (${data.total - top.loaded})`)));
      }
    }
  } catch (ex) {
    if (token !== libToken) return;
    body.innerHTML = '';
    body.append(el('div', { class: 'lib-empty' }, `Fehler: ${ex.message}`));
  }
}

async function toggleWatch(it, btn) {
  try {
    const r = await api('/api/watchlist', { method: 'POST', body: { itemId: it.id } });
    if (r.on) S.watchIds.add(it.id); else S.watchIds.delete(it.id);
    btn.classList.toggle('on', r.on);
    btn.textContent = r.on ? '★' : '☆';
    toast(r.on ? `„${it.name}“ gemerkt` : 'Von der Merkliste genommen');
    if (S.lib.view === 'watchlist' && !r.on) renderLib();
  } catch (ex) { toast(ex.message); }
}

/* Poster lazy laden: eine Bibliotheksseite liefert bis zu 60 Kacheln. Ohne
   Begrenzung schießt der Browser 60 Bildanfragen gleichzeitig durch den
   Tunnel zum Heimserver und blockiert dort HLS-Segmente und API-Calls. */
const posterIO = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    posterIO.unobserve(en.target);
    en.target.style.backgroundImage = `url('${en.target.dataset.img}')`;
  }
}, { root: $('#lib-body'), rootMargin: '400px' }) : null;

function tile(it) {
  const label = it.type === 'Episode' && !S.lib.search && S.lib.view === 'browse'
    ? `${it.index != null ? it.index + '. ' : ''}${it.name}`
    : it.name;
  let sub = '';
  if (it.type === 'Episode' && (S.lib.search || S.lib.view !== 'browse') && it.seriesName) sub = `${it.seriesName} · S${it.parentIndex ?? '?'}E${it.index ?? '?'}`;
  else if (it.year) sub = String(it.year);
  if (it.runtime && it.playable) sub += `${sub ? ' · ' : ''}${Math.round(it.runtime / 60)} min`;
  if (it.progress != null) sub = it.finished ? 'zu Ende geschaut' : `${Math.round(it.progress)} % geschaut`;
  const wide = it.type === 'Episode' || (it.aspect && it.aspect > 1.2);
  const canFav = it.playable || it.type === 'Series' || it.type === 'BoxSet' || it.type === 'Season';
  const fav = canFav ? el('button', { class: `fav${S.watchIds.has(it.id) ? ' on' : ''}`, title: 'Merken', onclick: (e) => { e.stopPropagation(); toggleWatch(it, e.currentTarget); } }, S.watchIds.has(it.id) ? '★' : '☆') : '';
  const poster = el('div', { class: 'poster' },
    it.hasImage ? '' : (it.isFolder ? '📁' : '🎬'),
    it.played ? el('span', { class: 'badge' }, '✓ gesehen') : '',
    it.ourRating && it.ourRating.avg ? el('span', { class: 'rating ours' }, `★ ${String(it.ourRating.avg).replace('.', ',')} · ${it.ourRating.count}`) : it.rating ? el('span', { class: 'rating' }, `★ ${String(it.rating).replace('.', ',')}`) : '',
    it.progress != null ? el('div', { class: 'prog' }, el('div', { style: `width:${Math.min(100, it.progress)}%` })) : '',
    it.playable ? el('span', { class: 'play' }, canLoad() ? '▶ Abspielen' : perm('suggest') ? '💡 Vorschlagen' : '') : '');
  if (it.hasImage) {
    const posterUrl = `/img/${it.id}?w=${wide ? 480 : 320}`;
    if (posterIO) { poster.dataset.img = posterUrl; posterIO.observe(poster); }
    else poster.style.backgroundImage = `url('${posterUrl}')`;
  }
  return el('div', { class: 'tile', title: it.overview || it.name, role: 'button', tabindex: 0,
    onclick: () => openTile(it),
    onkeydown: (e) => { if (e.key === 'Enter') openTile(it); },
  }, fav, poster, el('div', { class: 't' }, label), sub ? el('div', { class: 's' }, sub) : '');
}

function openTile(it) {
  if (window.WP && WP.openDetail && (it.playable || it.type === 'Series')) { WP.openDetail(it); return; }
  if (it.playable) {
    if (canLoad()) { send({ t: 'load', itemId: it.id }); toast(`„${it.name}“ wird geladen…`); }
    else if (perm('suggest')) { send({ t: 'suggest', itemId: it.id }); toast('Vorschlag im Chat gepostet'); }
    else { toast('Du darfst hier nichts auswählen oder vorschlagen.'); return; }
    closeLibrary();
  } else if (it.isFolder || it.type === 'Series' || it.type === 'BoxSet' || it.type === 'Season') {
    S.lib.search = '';
    $('#lib-search').value = '';
    if (S.lib.view !== 'browse') { S.lib.view = 'browse'; S.lib.stack = [{ id: null, name: 'Bibliothek' }]; }
    libGo({ id: it.id, name: it.name, type: it.type, collectionType: it.collectionType });
  }
}

// Schnittstelle für extras.js (im Desktop-Client gibt es dieselbe mit IPC)
window.WPX = {
  api, send, serverNow, closeLibrary, playSolo,
  joinRoom: (code) => { history.pushState(null, '', `/r/${code}`); enterRoom(code); },
  showLobby, goHome: () => route(),
  openFolder: (it) => { openLibrary(); openTile(it); },
  img: (id, w, type) => `/img/${id}?w=${w}${type ? `&type=${type}` : ''}`,
  seek: (pos) => control('seek', pos),
  segments: () => (S.info && S.info.segments) || [],
};
video.addEventListener('timeupdate', () => { if (window.WP) WP.tick(video.currentTime); });

init();

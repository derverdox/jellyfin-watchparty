'use strict';
/* Watchparty Desktop – Oberfläche */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const call = (ch, ...a) => window.wp.call(ch, ...a);

const REACTIONS_DEFAULT = ['😂', '😮', '❤️', '👍', '🔥', '😱', '👏', '💀'];

const S = {
  me: null,
  server: '',
  code: null,
  you: null,
  room: null,
  members: [],
  playback: null,
  item: null,
  player: null,
  prefs: null,
  setup: null,
  filters: null,
  engine: null,
  tracks: { audio: [], sub: [] },
  lib: { stack: [], search: '', start: 0, total: 0 },
  detail: null,
  seeking: false,
};

/* ---------------- Hilfen ---------------- */

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v; // CSSOM statt Attribut, sonst blockt die CSP
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtNum(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d).replace('.', ',') : '–'; }
function hue(str) { let h = 0; for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360; return h; }
function colorFor(name) { return `hsl(${hue(name)} 75% 68%)`; }
let toastTimer;
function toast(text, bad = false) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3200);
}
function showErr(sel, ex) {
  const e = $(sel);
  if (!ex) { e.hidden = true; return; }
  e.textContent = ex.message || String(ex);
  e.hidden = false;
}
function showView(id) {
  for (const v of $$('.view')) v.hidden = v.id !== id;
  document.body.classList.toggle('in-room', id === 'view-room');
  document.body.classList.toggle('is-admin', !!(S.me && S.me.admin)); // rotes Design für Admins
}
function img(id, w = 400, type = 'Primary') { return `wpimg://img/${id}?w=${w}&type=${type}`; }
function isHost() { return !!(S.room && S.you && S.room.host === S.you.sid); }
function perm(k) { return !!(S.me && (S.me.admin || (S.me.perms && S.me.perms[k]))); }
/** Steuern: Host immer, sonst nur wenn der Host es allen erlaubt UND die eigene Gruppe es darf. */
function canControl() { return !!(S.room && S.you && (isHost() || (S.room.allowAllControl && perm('control')))); }
/** Etwas für alle starten */
function canLoad() { return canControl() && (isHost() || perm('load')); }

/* ---------------- Start ---------------- */

async function init() {
  window.wp.on(onEvent);
  try {
    const st = await call('auth:state');
    S.server = st.server || '';
    $('#login-form').server.value = st.server ? st.server.replace(/^https:\/\//, '') : '';
    $('#login-form').username.value = st.username || '';
    if (st.me) { S.me = st.me; return afterLogin(); }
    if (st.offline) showErr('#login-error', new Error(`${st.offline}. Prüf die Adresse oder deine Verbindung.`));
  } catch (e) { showErr('#login-error', e); }
  showView('view-login');
  ($('#login-form').server.value ? $('#login-form').username.value ? $('#login-form').password : $('#login-form').username : $('#login-form').server).focus();
}

async function afterLogin() {
  S.prefs = await call('prefs:get');
  await refreshSetup();
  if (!S.setup.setupDone && S.setup.platform === 'win32') return openSetup();
  showLobby();
}

/* ---------------- Login ---------------- */

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  showErr('#login-error', null);
  try {
    S.me = await call('auth:login', { server: f.server.value, username: f.username.value.trim(), password: f.password.value, remember: f.remember.checked });
    f.password.value = '';
    const st = await call('auth:state');
    S.server = st.server;
    await afterLogin();
  } catch (e) { showErr('#login-error', e); }
  finally { btn.disabled = false; }
});

/* ---------------- Registrierung per Einladung ---------------- */

$('#btn-to-register').addEventListener('click', () => {
  $('#login-form').hidden = true;
  $('#register-form').hidden = false;
  $('#register-form').link.focus();
});
$('#btn-to-login').addEventListener('click', () => {
  $('#register-form').hidden = true;
  $('#login-form').hidden = false;
});
$('#register-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  showErr('#register-error', null);
  const m = /^(https?:\/\/[^/]+)\/invite\/([A-Za-z0-9_-]{8,40})/.exec(f.link.value.trim());
  if (!m) return showErr('#register-error', new Error('Bitte den kompletten Einladungslink einfügen (…/invite/…).'));
  if (f.password.value !== f.password2.value) return showErr('#register-error', new Error('Die Passwörter stimmen nicht überein.'));
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  try {
    const chk = await call('auth:inviteCheck', { server: m[1], code: m[2] });
    if (!chk.valid) throw new Error('Diese Einladung ist ungültig oder schon benutzt.');
    S.me = await call('auth:register', { server: m[1], code: m[2], username: f.username.value.trim(), password: f.password.value });
    const st = await call('auth:state');
    S.server = st.server;
    toast(`Willkommen, ${S.me.name}!`);
    await afterLogin();
  } catch (e) { showErr('#register-error', e); }
  finally { btn.disabled = false; }
});

/* ---------------- Einrichtung ---------------- */

async function refreshSetup() {
  S.setup = await call('setup:status');
  renderSetup();
  return S.setup;
}

function openSetup() { showView('view-setup'); refreshSetup(); }

function renderSetup() {
  const st = S.setup;
  if (!st) return;
  const gpu = st.gpu;
  $('#gpu-line').innerHTML = '';
  if (st.platform !== 'win32') {
    $('#gpu-line').append(el('span', {}, 'Die automatische Einrichtung gibt es nur unter Windows. Hier wird das mpv aus deinem System benutzt.'));
  } else if (gpu) {
    $('#gpu-line').append(el('span', {}, '🖥️'), el('span', {}, 'Erkannt: ', el('strong', {}, gpu.name), gpu.memory ? ` · ${gpu.memory}` : ''), el('span', { class: 'muted tiny' }, `Empfehlung: ${(st.modelList.find((m) => m.key === st.recommended.model) || {}).label || ''}`));
  } else {
    $('#gpu-line').append(el('span', {}, '⚠️'), el('span', {}, 'Keine NVIDIA-Grafikkarte gefunden. Framegen braucht eine RTX-Karte, der Player selbst läuft trotzdem.'));
  }
  const ms = $('#setup-model');
  if (!ms.options.length) {
    for (const m of st.modelList) ms.append(el('option', { value: m.key }, m.label));
    ms.value = (S.prefs && S.prefs.framegen.model) || st.recommended.model;
  }
  const baseOk = st.base;
  $('#base-state').textContent = baseOk ? '✓ installiert' : 'fehlt';
  $('#base-state').classList.toggle('ok', baseOk);
  $('#step-base').classList.toggle('done', baseOk);
  $('#btn-install-base').textContent = baseOk ? 'Neu installieren' : 'Installieren';
  const model = ms.value;
  const fgOk = st.framegen && st.models.includes(model);
  $('#fg-state').textContent = fgOk ? '✓ installiert' : st.framegen ? 'Modell fehlt' : 'optional';
  $('#fg-state').classList.toggle('ok', fgOk);
  $('#step-fg').classList.toggle('done', fgOk);
  $('#btn-install-fg').textContent = fgOk ? 'Installiert' : st.framegen ? 'Modell laden' : 'Installieren';
  $('#btn-install-fg').disabled = fgOk || st.busy || st.platform !== 'win32';
  $('#btn-install-base').disabled = st.busy || st.platform !== 'win32';
  $('#btn-setup-done').textContent = baseOk || st.platform !== 'win32' ? 'Weiter' : 'Später';
}

$('#setup-model').addEventListener('change', renderSetup);

async function install(what) {
  showErr('#setup-error', null);
  $('#progress-card').hidden = false;
  $('#btn-install-base').disabled = true;
  $('#btn-install-fg').disabled = true;
  const model = $('#setup-model').value;
  try {
    if (what === 'framegen') {
      S.prefs = await call('prefs:set', { framegen: { model } });
    }
    await call('setup:install', { what, model });
    toast(what === 'framegen' ? 'Framegen ist bereit.' : 'Player ist bereit.');
  } catch (e) {
    if (!/Abgebrochen/.test(e.message)) showErr('#setup-error', e);
  } finally {
    $('#progress-card').hidden = true;
    await refreshSetup();
  }
}

$('#btn-install-base').addEventListener('click', () => install('base'));
$('#btn-install-fg').addEventListener('click', () => install('framegen'));
$('#btn-cancel').addEventListener('click', () => call('setup:cancel'));
$('#btn-open-folder').addEventListener('click', () => call('setup:openFolder'));
$('#btn-setup-done').addEventListener('click', async () => {
  if (!S.setup.setupDone) await call('setup:skip');
  await refreshSetup();
  if (S.code) showView('view-room'); else showLobby();
});

function onProgress(p) {
  if (p.step === 'done') return;
  const labels = { mpv: 'mpv', python: 'Python', vapoursynth: 'VapourSynth', tensorrt: 'TensorRT', model: 'RIFE-Modell', extract: 'Entpacken' };
  $('#progress-step').textContent = labels[p.step] || p.step;
  if (p.detail) $('#progress-detail').textContent = p.detail;
  const bar = $('#progress-fill').parentElement;
  bar.classList.toggle('indeterminate', p.pct == null);
  if (p.pct != null) $('#progress-fill').style.width = `${p.pct}%`;
}

/* ---------------- Lobby ---------------- */

async function showLobby() {
  try { S.me = await call('auth:me'); } catch { /* offline: alten Stand nehmen */ }
  showView('view-lobby');
  $('#lobby-name').textContent = S.me ? S.me.name : '';
  const canCreate = perm('createRoom');
  $('#btn-create').hidden = !canCreate;
  $('#lobby-or').hidden = !canCreate;
  $('#lobby-hint').textContent = canCreate ? 'Mach einen Raum auf oder tritt einem bei.' : 'Gib den Raum-Code oder Link ein, den du bekommen hast.';
  $('#admin-flag').hidden = !(S.me && S.me.admin);
  $('#btn-admin').hidden = !(S.me && S.me.admin);
  $('#btn-invite-user').hidden = !(S.me && (S.me.admin || (perm('invite') && S.me.invitesEnabled)));
  $('#motd').hidden = !(S.me && S.me.motd);
  $('#motd').textContent = (S.me && S.me.motd) || '';
  $('#name-form').name.value = S.me ? S.me.name : '';
  $('#lobby-server').textContent = S.server.replace(/^https?:\/\//, '');
  const chips = $('#lobby-chips');
  chips.innerHTML = '';
  const st = S.setup || {};
  if (S.me && !S.me.agentOnline) chips.append(el('span', { class: 'chip warn' }, '● Heimserver offline'));
  else if (S.me) chips.append(el('span', { class: 'chip ok' }, `● ${S.me.server || 'Heimserver'} online`));
  chips.append(el('span', { class: `chip ${st.base || st.platform !== 'win32' ? 'ok' : 'warn'}` }, st.base || st.platform !== 'win32' ? '✓ Player' : 'Player fehlt'));
  if (st.platform === 'win32') chips.append(el('span', { class: `chip ${st.framegen ? 'ok' : ''}` }, st.framegen ? '✓ Framegen' : 'Framegen aus'));
  $('#join-form').code.focus();
}

$('#btn-create').addEventListener('click', async () => {
  showErr('#lobby-error', null);
  try { const r = await call('room:create'); enterRoom(r.code); } catch (e) { showErr('#lobby-error', e); }
});
$('#join-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showErr('#lobby-error', null);
  try { const r = await call('room:join', ev.target.code.value); enterRoom(r.code); } catch (e) { showErr('#lobby-error', e.status === 404 ? new Error('Diesen Raum gibt es nicht.') : e); }
});
$('#btn-logout').addEventListener('click', async () => {
  await call('auth:logout');
  S.me = null;
  showView('view-login');
});
$('#btn-setup').addEventListener('click', openSetup);
$('#btn-admin').addEventListener('click', () => call('admin:open').catch((e) => toast(e.message, true)));
$('#btn-account').addEventListener('click', () => { $('#account-box').hidden = !$('#account-box').hidden; });
$('#btn-invite-user').addEventListener('click', async () => {
  try { const r = await call('room:invite'); await call('util:copy', r.url); toast(`Einladungslink kopiert (${r.hours} h gültig).`); } catch (e) { toast(e.message, true); }
});
$('#name-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try { S.me = await call('auth:name', ev.target.name.value.trim()); toast('Name gespeichert'); $('#lobby-name').textContent = S.me.name; } catch (e) { toast(e.message, true); }
});
$('#pw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try { await call('auth:password', { old: f.old.value, password: f.password.value }); f.reset(); toast('Passwort geändert. Andere Geräte wurden abgemeldet.'); } catch (e) { toast(e.message, true); }
});

/* ---------------- Raum ---------------- */

async function enterRoom(code) {
  S.code = code;
  S.playback = null; S.item = null; S.filters = null; S.tracks = { audio: [], sub: [] };
  $('#room-code').textContent = code;
  $('#chat').innerHTML = '';
  setConn('connecting');
  showView('view-room');
  renderPrefs();
  renderNow();
  loadDisplays();
}

$('#btn-leave').addEventListener('click', async () => {
  await call('room:leave');
  S.code = null;
  showLobby();
});
$('#btn-copy-link').addEventListener('click', async () => {
  const { url } = await call('room:link');
  await call('util:copy', url);
  toast('Link kopiert: Freunde können im Browser oder im Client beitreten.');
});

function setConn(state) {
  const c = $('#conn');
  c.classList.toggle('ok', state === 'open');
  c.classList.toggle('bad', state === 'reconnecting');
  $('#conn-text').textContent = state === 'open' ? 'Verbunden' : state === 'reconnecting' ? 'Verbindung weg, verbinde neu …' : 'Verbinde …';
}

function onEvent(ch, p) {
  switch (ch) {
    case 'setup:progress': onProgress(p); break;
    case 'sys:gpu': if (S.setup) { S.setup.gpu = p; renderSetup(); } break;
    case 'room:conn': setConn(p.state); break;
    case 'room:fatal': toast(p.text, true); S.code = null; showLobby(); break;
    case 'room:welcome':
      setConn('open');
      S.you = p.you; S.room = p.room; S.members = p.members;
      $('#chat').innerHTML = '';
      for (const m of p.chat) addChat(m, true);
      scrollChat(true);
      renderReactBar(p.reactions || REACTIONS_DEFAULT);
      if (S.me) { S.me.agentOnline = p.agentOnline; S.me.server = p.server; }
      renderMembers(); renderControlState();
      break;
    case 'room:playback':
      S.playback = p.playback;
      if (!p.playback.item) { S.item = null; }
      renderNow(); updateTransport();
      break;
    case 'room:item': S.item = p; S.noaccess = null; $('#now').classList.remove('locked'); renderNow(); renderQuality(); break;
    case 'room:members': S.members = p; renderMembers(); break;
    case 'room:room': S.room = p.room; S.members = p.members || S.members; renderMembers(); renderControlState(); break;
    case 'room:chat': addChat(p); break;
    case 'room:react': floatEmoji(p.emoji, p.from); break;
    case 'room:error': toast(p, true); break;
    case 'room:announce': toast(`📣 ${p.from}: ${p.text}`); break;
    case 'room:noaccess':
      S.noaccess = p.id;
      $('#now').classList.add('locked');
      $('#now-eyebrow').textContent = 'Kein Zugriff';
      $('#now-sub').textContent = `„${p.title}“ ist für dein Konto nicht freigegeben. Frag den Admin oder schlagt was anderes vor.`;
      break;
    case 'room:joined': enterRoom(p.code); break;
    case 'room:agent': if (S.me) { S.me.agentOnline = p.online; } if (!p.online) toast('Der Heimserver ist gerade offline.', true); break;
    case 'room:kicked': toast(p.text || 'Du wurdest aus dem Raum entfernt.', true); S.code = null; showLobby(); break;
    case 'player:state': {
      const q = S.player && S.player.quality;
      S.player = p; updateTransport(); renderStats();
      if (p.quality && p.quality !== q) renderQuality();
      break;
    }
    case 'player:tracks': S.tracks = p; renderTracks(); break;
    case 'player:filters': S.filters = p; renderPicture(); renderNow(); break;
    case 'player:opened': $('#btn-player').textContent = '⛶ Vollbild'; break;
    case 'player:closed': $('#btn-player').textContent = '⛶ Player öffnen'; S.tracks = { audio: [], sub: [] }; renderTracks(); break;
    case 'fg:engine': S.engine = p; renderPicture(); break;
    case 'prefs': S.prefs = p; renderPrefs(); break;
    default: break;
  }
}

/* ---------- Jetzt läuft ---------- */

function renderNow() {
  const pb = S.playback;
  const it = pb && pb.item;
  const info = S.item && it && S.item.id === it.id ? S.item : null;
  $('#now-poster').hidden = !it;
  if (!it) {
    $('#now-eyebrow').textContent = 'Noch nichts ausgewählt';
    $('#now-title').textContent = 'Such euch was aus';
    $('#now-sub').textContent = canControl() ? 'Klick auf „Film auswählen“, dann läuft es bei allen.' : 'Der Host sucht gleich etwas aus.';
    $('#now-bg').style.backgroundImage = '';
    $('#now-badges').innerHTML = '';
    return;
  }
  $('#now-eyebrow').textContent = pb.playing ? 'Läuft gerade' : 'Pausiert';
  $('#now-title').textContent = it.title;
  $('#now-sub').textContent = it.subtitle || '';
  const poster = $('#now-poster');
  poster.onerror = () => { poster.hidden = true; };
  if (poster.dataset.id !== it.id) { poster.dataset.id = it.id; poster.src = img(it.id, 300); }
  $('#now-bg').style.backgroundImage = `url("${img(it.id, 1280, 'Backdrop')}")`;
  const b = $('#now-badges');
  b.innerHTML = '';
  if (info && info.width) b.append(el('span', { class: 'badge' }, `${info.width}×${info.height}`));
  if (it.runtime) b.append(el('span', { class: 'badge' }, fmt(it.runtime)));
  const f = S.filters;
  if (f && f.framegen && f.framegen.state === 'on') b.append(el('span', { class: 'badge hot' }, `RIFE ${fmtNum(f.framegen.from, 2)} → ${fmtNum(f.framegen.to, 0)} fps`));
  if (f && f.vsr) b.append(el('span', { class: 'badge hot' }, `VSR ${f.vsr.from}p → ${f.vsr.to}p${f.vsr.hdr ? ' · HDR' : ''}`));
}

/* ---------- Transport ---------- */

function duration() {
  const pb = S.playback;
  return (pb && pb.item && pb.item.runtime) || (S.player && S.player.duration) || 0;
}

function updateTransport() {
  const pb = S.playback;
  const dur = duration();
  const p = S.player;
  const cur = S.seeking ? S.seekValue : p && p.running && p.ready ? p.pos : (p ? p.expected : 0);
  $('#t-cur').textContent = fmt(cur);
  $('#t-dur').textContent = fmt(dur);
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  $('#seek-fill').style.width = `${pct}%`;
  $('#seek-knob').style.left = `${pct}%`;
  const buf = p && p.cache ? Math.min(100, ((cur + p.cache) / (dur || 1)) * 100) : 0;
  $('#seek-buffer').style.width = `${buf}%`;
  const playing = !!(pb && pb.playing);
  const btn = $('#btn-play');
  btn.textContent = playing ? '❚❚' : '▶';
  btn.classList.toggle('paused-icon', playing);
  const hasItem = !!(pb && pb.item);
  const ok = canControl() && hasItem;
  for (const id of ['#btn-play', '#btn-back', '#btn-fwd']) $(id).disabled = !ok;
  $('#seek').classList.toggle('disabled', !ok);
  const next = pb && pb.item && pb.item.nextEpisodeId;
  $('#btn-next').hidden = !(next && canLoad() && dur && cur > dur - 180);
}

function renderControlState() {
  $('#lock-hint').hidden = canControl();
  const chatOk = perm('chat');
  for (const x of $$('#chat-form input, #chat-form button')) x.disabled = !chatOk;
  $('#chat-form').text.placeholder = chatOk ? 'Nachricht …' : 'Chatten ist für dich nicht freigeschaltet';
  $('#react-bar').hidden = !chatOk;
  $('#btn-library').disabled = false;
  $('#host-box').hidden = !isHost();
  $('#chk-all-control').checked = !!(S.room && S.room.allowAllControl);
  $('#btn-invite').hidden = !(S.me && S.me.admin);
  updateTransport();
  renderNow();
}

$('#btn-play').addEventListener('click', () => call('room:toggle'));
$('#btn-next').addEventListener('click', () => { const pb = S.playback; if (pb && pb.item && pb.item.nextEpisodeId) call('room:load', pb.item.nextEpisodeId); });
$('#btn-back').addEventListener('click', () => call('room:seekBy', -10));
$('#btn-fwd').addEventListener('click', () => call('room:seekBy', 10));
$('#btn-player').addEventListener('click', async () => {
  if (S.player && S.player.running) call('player:fullscreen');
  else {
    if (S.setup && S.setup.platform === 'win32' && !S.setup.base) { openSetup(); return; }
    try { await call('player:show'); } catch (e) { toast(e.message, true); }
  }
});

const seekEl = $('#seek');
function seekAt(ev) {
  const r = seekEl.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  return x * duration();
}
seekEl.addEventListener('pointermove', (ev) => {
  const dur = duration();
  if (!dur) return;
  const t = seekAt(ev);
  const tip = $('#seek-tip');
  tip.hidden = false;
  tip.textContent = fmt(t);
  tip.style.left = `${(t / dur) * 100}%`;
  if (S.seeking) { S.seekValue = t; updateTransport(); }
});
seekEl.addEventListener('pointerleave', () => { if (!S.seeking) $('#seek-tip').hidden = true; });
seekEl.addEventListener('pointerdown', (ev) => {
  if (!canControl() || !duration()) return;
  S.seeking = true;
  S.seekValue = seekAt(ev);
  seekEl.setPointerCapture(ev.pointerId);
  updateTransport();
});
seekEl.addEventListener('pointerup', (ev) => {
  if (!S.seeking) return;
  S.seeking = false;
  $('#seek-tip').hidden = true;
  call('room:control', { action: 'seek', position: seekAt(ev) });
});

document.addEventListener('keydown', (ev) => {
  if ($('#view-room').hidden || ev.target.closest('input, select, textarea') || !$('#library').hidden) return;
  if (ev.code === 'Space') { ev.preventDefault(); call('room:toggle'); }
  if (ev.code === 'ArrowLeft') call('room:seekBy', -5);
  if (ev.code === 'ArrowRight') call('room:seekBy', 5);
});

/* ---------- Bild ---------- */

function renderPrefs() {
  const p = S.prefs;
  if (!p) return;
  $('#fg-enabled').checked = !!p.framegen.enabled;
  $('#fg-target').value = p.framegen.target;
  const ms = $('#fg-model');
  if (!ms.options.length && S.setup) for (const m of S.setup.modelList) ms.append(el('option', { value: m.key }, m.label));
  ms.value = p.framegen.model;
  $('#vsr-enabled').checked = !!p.vsr.enabled;
  $('#vsr-hdr').checked = !!p.vsr.hdr;
  renderQuality();
  $('#volume').value = p.volume;
  $('#opt-fullscreen').checked = !!p.fullscreen;
  $('#opt-osdchat').checked = !!p.osdChat;
  const onWin = !S.setup || S.setup.platform === 'win32';
  $('#vsr-enabled').disabled = !onWin;
  $('#vsr-hdr').disabled = !onWin;
  renderPicture();
}

function renderPicture() {
  const p = S.prefs;
  if (!p) return;
  $('#fg-options').classList.toggle('off', !p.framegen.enabled);
  const box = $('#fg-status');
  box.innerHTML = '';
  const st = S.setup || {};
  const f = S.filters;
  const eng = S.engine;
  if (p.framegen.enabled) {
    if (st.platform === 'win32' && (!st.framegen || !st.models.includes(p.framegen.model))) {
      box.append(el('div', { class: 'note work' }, el('span', {}, st.framegen ? 'Dieses Modell ist noch nicht geladen.' : 'Framegen ist noch nicht installiert.'), el('button', { class: 'btn small', onclick: openSetup }, 'Einrichten')));
    } else if (eng && eng.state === 'building') {
      const sec = eng.seconds || 0;
      box.append(el('div', { class: 'note work' }, el('span', {}, `TensorRT-Engine für ${eng.w}×${eng.h} wird gebaut … ${fmt(sec)}`), el('span', { class: 'tiny' }, 'einmalig')));
      const bar = el('div', { class: 'bar indeterminate' }, el('div', { class: 'bar-fill' }));
      box.append(bar);
    } else if (eng && eng.state === 'error') {
      box.append(el('div', { class: 'note' }, el('span', { class: 'error' }, eng.error)));
    } else if (f && f.framegen && f.framegen.state === 'on') {
      box.append(el('div', { class: 'note on' }, el('span', {}, `Aktiv: ${fmtNum(f.framegen.from, 3)} → ${fmtNum(f.framegen.to, 2)} fps (${f.framegen.multi})`), el('span', { class: 'tiny' }, '●')));
    } else if (!S.player || !S.player.running) {
      box.append(el('div', { class: 'note' }, 'Startet, sobald der Player läuft.'));
    }
  }
  if (f && f.notes) for (const n of f.notes) box.append(el('div', { class: 'note' }, n));
  const live = [];
  if (f && f.framegen && f.framegen.state === 'on') live.push('RIFE');
  if (f && f.vsr) live.push('VSR');
  $('#pic-live').textContent = live.length ? `aktiv: ${live.join(' + ')}` : '';
}

async function setPrefs(patch) {
  try { S.prefs = await call('prefs:set', patch); renderPrefs(); } catch (e) { toast(e.message, true); }
}
$('#fg-enabled').addEventListener('change', (e) => setPrefs({ framegen: { enabled: e.target.checked } }));
$('#fg-target').addEventListener('change', (e) => setPrefs({ framegen: { target: e.target.value } }));
$('#fg-model').addEventListener('change', (e) => setPrefs({ framegen: { model: e.target.value } }));
$('#vsr-enabled').addEventListener('change', (e) => setPrefs({ vsr: { enabled: e.target.checked } }));
$('#vsr-hdr').addEventListener('change', (e) => setPrefs({ vsr: { hdr: e.target.checked } }));
$('#sel-quality').addEventListener('change', (e) => setPrefs({ quality: e.target.value }));

/** Qualitäten der aktuellen Datei: nie mehr als das Original hergibt (kommt vom Server). */
function renderQuality() {
  const sel = $('#sel-quality');
  const list = (S.item && S.item.qualities) || [{ id: 'direct', label: 'Original' }];
  const active = (S.player && S.player.quality) || (S.prefs && String(S.prefs.quality)) || 'direct';
  sel.innerHTML = '';
  for (const q of list) sel.append(el('option', { value: q.id }, q.label));
  sel.value = list.some((q) => q.id === active) ? active : list[0].id;
}
$('#opt-fullscreen').addEventListener('change', (e) => setPrefs({ fullscreen: e.target.checked }));
$('#opt-osdchat').addEventListener('change', (e) => setPrefs({ osdChat: e.target.checked }));
let volTimer;
$('#volume').addEventListener('input', (e) => { clearTimeout(volTimer); volTimer = setTimeout(() => setPrefs({ volume: Number(e.target.value) }), 120); });
$('#sel-screen').addEventListener('change', (e) => { setPrefs({ screen: e.target.value }); toast('Gilt ab dem nächsten Player-Start.'); });

async function loadDisplays() {
  const sel = $('#sel-screen');
  sel.innerHTML = '';
  sel.append(el('option', { value: 'auto' }, 'Automatisch'));
  try {
    for (const d of await call('sys:displays')) sel.append(el('option', { value: String(d.index) }, d.label + (d.primary ? ' (Haupt)' : '')));
  } catch { /* egal */ }
  sel.value = S.prefs ? String(S.prefs.screen) : 'auto';
}

function renderTracks() {
  const fill = (sel, list, kind) => {
    sel.innerHTML = '';
    if (!list.length) { sel.append(el('option', {}, '–')); sel.disabled = true; return; }
    sel.disabled = false;
    if (kind === 'sub') sel.append(el('option', { value: 'no' }, 'Aus'));
    for (const t of list) {
      const label = [t.title, t.lang && t.lang.toUpperCase(), t.codec, t.forced && 'erzwungen', t.external && 'extern'].filter(Boolean).join(' · ') || `Spur ${t.id}`;
      sel.append(el('option', { value: String(t.id) }, label));
    }
    const s = list.find((t) => t.selected);
    sel.value = s ? String(s.id) : kind === 'sub' ? 'no' : String(list[0].id);
  };
  fill($('#sel-audio'), S.tracks.audio || [], 'audio');
  fill($('#sel-sub'), S.tracks.sub || [], 'sub');
}
$('#sel-audio').addEventListener('change', (e) => call('player:setTrack', { type: 'audio', id: e.target.value }));
$('#sel-sub').addEventListener('change', (e) => call('player:setTrack', { type: 'sub', id: e.target.value }));

function renderStats() {
  const p = S.player;
  if (!p || !p.running) { $('#stats').textContent = 'Player geschlossen.'; return; }
  const parts = [];
  if (p.ready) parts.push(`Abweichung ${fmtNum((p.expected - p.pos) * 1000, 0)} ms`);
  if (p.speed && Math.abs(p.speed - 1) > 0.001) parts.push(`Tempo ${fmtNum(p.speed * 100, 1)} %`);
  if (p.vfFps) parts.push(`${fmtNum(p.vfFps, 1)} fps`);
  if (p.displayFps) parts.push(`Monitor ${fmtNum(p.displayFps, 0)} Hz`);
  if (p.cache) parts.push(`Puffer ${fmtNum(p.cache, 0)} s`);
  if (p.rtt != null) parts.push(`Ping ${p.rtt} ms`);
  $('#stats').textContent = parts.join(' · ');
}

/* ---------- Chat ---------- */

function scrollChat(force) {
  const c = $('#chat');
  if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 120) c.scrollTop = c.scrollHeight;
}

function addChat(m, silent) {
  let node;
  if (m.kind === 'system') node = el('div', { class: 'msg system' }, m.text);
  else if (m.kind === 'announce') node = el('div', { class: 'msg announce' }, el('span', { class: 'who' }, `📣 ${m.from}`), el('span', { class: 'text' }, m.text));
  else if (m.kind === 'suggest') {
    node = el('div', { class: 'msg suggest' },
      el('span', { class: 'who', style: `color:${colorFor(m.from)}` }, `${m.from} schlägt vor`),
      el('div', { class: 'text' }, el('span', {}, `🎬 ${m.text}`), canLoad() ? el('button', { class: 'btn small', onclick: () => call('room:load', m.itemId) }, 'Abspielen') : null));
  } else {
    node = el('div', { class: 'msg' }, el('span', { class: 'who', style: `color:${colorFor(m.from)}` }, m.from), el('span', { class: 'text' }, m.text));
  }
  $('#chat').append(node);
  if (!silent) scrollChat(false);
}

$('#chat-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = ev.target.text.value.trim();
  if (!t) return;
  call('room:chat', t);
  ev.target.text.value = '';
});

function renderReactBar(list) {
  const bar = $('#react-bar');
  bar.innerHTML = '';
  for (const e of list) bar.append(el('button', { title: 'Reaktion senden', onclick: () => call('room:react', e) }, e));
}

function floatEmoji(emoji, from) {
  const r = $('#now').getBoundingClientRect();
  const f = el('div', { class: 'floaty', title: from, style: `left:${r.left + 40 + Math.random() * (r.width - 80)}px; top:${r.bottom - 40}px` }, emoji);
  document.body.append(f);
  setTimeout(() => f.remove(), 2700);
}

/* ---------- Leute ---------- */

for (const t of $$('.tab')) {
  t.addEventListener('click', () => {
    for (const x of $$('.tab')) x.classList.toggle('active', x === t);
    $('#tab-chat').hidden = t.dataset.tab !== 'chat';
    $('#tab-people').hidden = t.dataset.tab !== 'people';
  });
}

function memberStatus(m) {
  const st = m.status || {};
  const map = { playing: ['spielt', 'good'], paused: ['pausiert', ''], buffering: ['lädt …', 'warn'], idle: ['wartet', ''], blocked: ['muss Play klicken', 'warn'], error: ['Fehler', 'bad'] };
  const [text, cls] = map[st.state] || ['–', ''];
  const drift = Math.abs(st.drift || 0);
  if (st.state === 'playing' && drift > 2) return { text: `${text} · ${drift.toFixed(0)} s versetzt`, cls: 'warn' };
  return { text, cls };
}

function renderMembers() {
  const list = $('#members');
  list.innerHTML = '';
  const av = $('#avatars');
  av.innerHTML = '';
  const seen = new Set();
  $('#people-count').textContent = String(new Set(S.members.map((m) => m.name)).size);
  for (const m of S.members) {
    const st = memberStatus(m);
    const me = S.you && m.id === S.you.clientId;
    const actions = [];
    if (isHost() && !me && !m.isHost) {
      actions.push(el('button', { class: 'icon', title: 'Zum Host machen', onclick: () => call('room:makeHost', m.id) }, '★'));
      actions.push(el('button', { class: 'icon', title: 'Entfernen', onclick: () => { if (confirm(`${m.name} aus dem Raum entfernen?`)) call('room:kick', m.id); } }, '✕'));
    }
    list.append(el('div', { class: 'member' },
      el('div', { class: `avatar${m.isHost ? ' host' : ''}`, style: `background:${colorFor(m.name)}` }, m.name.slice(0, 1).toUpperCase()),
      el('div', { class: 'meta' }, el('span', { class: 'name' }, m.name, me ? el('span', { class: 'muted tiny' }, ' (du)') : null, m.isHost ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'HOST') : null), el('span', { class: `st ${st.cls}` }, st.text)),
      el('div', { class: 'actions' }, actions)));
    if (!seen.has(m.name)) {
      seen.add(m.name);
      av.append(el('div', { class: `avatar${m.isHost ? ' host' : ''}`, style: `background:${colorFor(m.name)}`, title: `${m.name} · ${st.text}` }, m.name.slice(0, 1).toUpperCase()));
    }
  }
}

$('#chk-all-control').addEventListener('change', (e) => call('room:allowAll', e.target.checked));
$('#btn-invite').addEventListener('click', async () => {
  try {
    const r = await call('room:invite');
    await call('util:copy', r.url);
    toast(`Einladungslink kopiert (${r.hours} h gültig).`);
  } catch (e) { toast(e.message, true); }
});

/* ---------- Bibliothek ---------- */

S.lib.view = 'browse';
S.lib.sort = 'name';
S.watchIds = new Set();

$('#btn-library').addEventListener('click', openLibrary);
$('#btn-lib-close').addEventListener('click', () => { $('#library').hidden = true; });
$('#library').addEventListener('click', (e) => { if (e.target.id === 'library') $('#library').hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#detail').hidden) $('#detail').hidden = true;
  else if (!$('#library').hidden) $('#library').hidden = true;
});

async function openLibrary() {
  $('#library').hidden = false;
  if (!S.lib.stack.length) S.lib.stack = [{ id: null, name: 'Bibliothek' }];
  try { S.watchIds = new Set((await call('lib:watchlist')).items.map((x) => x.id)); } catch { /* egal */ }
  renderLib();
  $('#lib-search').focus();
}

for (const b of $$('#lib-tabs button')) {
  b.addEventListener('click', () => { S.lib.view = b.dataset.v; S.lib.search = ''; $('#lib-search').value = ''; renderLib(); });
}
$('#lib-sort').addEventListener('change', (e) => { S.lib.sort = e.target.value; renderLib(); });

let searchTimer;
$('#lib-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.lib.search = e.target.value.trim(); renderLib(); }, 250);
});

function libGo(entry) {
  S.lib.view = 'browse';
  S.lib.search = '';
  $('#lib-search').value = '';
  S.lib.stack.push(entry);
  renderLib();
}

function renderCrumbs() {
  const c = $('#crumbs');
  c.innerHTML = '';
  for (const b of $$('#lib-tabs button')) b.classList.toggle('on', !S.lib.search && b.dataset.v === S.lib.view);
  const top = S.lib.stack[S.lib.stack.length - 1];
  $('#lib-sort').hidden = !(!S.lib.search && S.lib.view === 'browse' && top && top.id && !['Series', 'Season'].includes(top.type));
  if (S.lib.search) { c.append(el('button', {}, `Suche: „${S.lib.search}“`)); return; }
  if (S.lib.view === 'watchlist') { c.append(el('button', {}, 'Deine Merkliste')); return; }
  if (S.lib.view === 'history') { c.append(el('button', {}, 'Zuletzt geschaut')); return; }
  S.lib.stack.forEach((e, i) => {
    if (i) c.append(el('span', { class: 'sep' }, '›'));
    c.append(el('button', { onclick: () => { S.lib.stack = S.lib.stack.slice(0, i + 1); renderLib(); } }, e.name));
  });
}

function section(title, items) {
  return el('div', { class: 'lib-section' }, title ? el('h3', {}, title) : null, el('div', { class: 'lib-row' }, items.map(tile)));
}
const histItem = (h) => ({ id: h.id, name: h.type === 'Episode' ? `${h.title} – ${h.subtitle}` : h.title, type: h.type, playable: true, hasImage: true, runtime: h.runtime, progress: h.progress, finished: h.finished, aspect: 1.78 });

let libToken = 0;
async function renderLib(append = false) {
  const token = ++libToken;
  renderCrumbs();
  const grid = $('#lib-grid');
  const top = S.lib.stack[S.lib.stack.length - 1];
  if (!append) { grid.innerHTML = ''; S.lib.start = 0; grid.classList.remove('sections'); }
  $('#btn-lib-more').hidden = true;
  try {
    if (S.lib.search) {
      if (S.lib.search.length < 2) return;
      const r = await call('lib:search', S.lib.search);
      if (token !== libToken) return;
      grid.classList.add('sections');
      if (!r.movies.length && !r.series.length && !r.episodes.length) { grid.append(el('div', { class: 'lib-empty' }, `Nichts gefunden für „${S.lib.search}“.`)); return; }
      if (r.year) grid.append(el('p', { class: 'muted tiny' }, `Nur Titel aus ${r.year}`));
      if (r.movies.length) grid.append(section('Filme', r.movies));
      if (r.series.length) grid.append(section('Serien & Sammlungen', r.series));
      if (r.episodes.length) grid.append(section('Folgen', r.episodes));
      return;
    }
    if (S.lib.view === 'watchlist') {
      const r = await call('lib:watchlist');
      if (token !== libToken) return;
      S.watchIds = new Set(r.items.map((x) => x.id));
      if (!r.items.length) { grid.append(el('div', { class: 'lib-empty' }, 'Noch nichts gemerkt. Fahr über einen Titel und klick auf ☆.')); return; }
      for (const it of r.items) grid.append(tile(it));
      return;
    }
    if (S.lib.view === 'history') {
      const r = await call('lib:history');
      if (token !== libToken) return;
      if (!r.items.length) { grid.append(el('div', { class: 'lib-empty' }, 'Hier erscheint, was du geschaut hast – mit Fortschritt.')); return; }
      for (const h of r.items) grid.append(tile(histItem(h)));
      return;
    }
    let data;
    if (!top.id) {
      const [libs, hist, wl] = await Promise.all([call('lib:libraries'), call('lib:history').catch(() => ({ items: [] })), call('lib:watchlist').catch(() => ({ items: [] }))]);
      if (token !== libToken) return;
      grid.classList.add('sections');
      const cont = hist.items.filter((h) => !h.finished && h.progress > 2).slice(0, 6).map(histItem);
      if (cont.length) grid.append(section('Weiterschauen', cont));
      if (wl.items.length) grid.append(section('Merkliste', wl.items.slice(0, 6)));
      grid.append(section('Bibliotheken', libs.items || []));
      return;
    }
    const sort = top.sort === 'index' ? 'index' : S.lib.sort;
    data = await call('lib:items', { parentId: top.id, start: S.lib.start, limit: 60, sort, ...(top.collectionType ? { collectionType: top.collectionType } : {}) });
    if (token !== libToken) return;
    const items = data.items || [];
    if (!items.length && !append) grid.append(el('div', { class: 'lib-empty' }, 'Hier ist nichts.'));
    for (const it of items) grid.append(tile(it));
    S.lib.start += items.length;
    $('#btn-lib-more').hidden = !(data.total && S.lib.start < data.total);
  } catch (e) {
    if (token !== libToken) return;
    grid.append(el('div', { class: 'lib-empty' }, e.message));
  }
}
$('#btn-lib-more').addEventListener('click', () => renderLib(true));

async function toggleWatch(it, btn) {
  try {
    const r = await call('lib:toggleWatch', it.id);
    if (r.on) S.watchIds.add(it.id); else S.watchIds.delete(it.id);
    if (btn) { btn.classList.toggle('on', r.on); btn.textContent = r.on ? '★' : '☆'; }
    toast(r.on ? `„${it.name}“ gemerkt` : 'Von der Merkliste genommen');
    return r.on;
  } catch (e) { toast(e.message, true); return null; }
}

function tile(it) {
  const wide = it.type === 'Episode' || it.type === 'CollectionFolder' || it.type === 'UserView' || (it.aspect && it.aspect > 1.2);
  let sub = it.type === 'Episode' && it.seriesName && S.lib.view !== 'browse' ? it.seriesName : it.type === 'Episode' ? `${it.parentIndex != null ? `S${it.parentIndex} ` : ''}${it.index != null ? `E${it.index}` : ''}` : it.year || '';
  if (S.lib.search && it.type === 'Episode') sub = `${it.seriesName || ''} · S${it.parentIndex ?? '?'}E${it.index ?? '?'}`;
  if (it.progress != null) sub = it.finished ? 'zu Ende geschaut' : `${Math.round(it.progress)} % geschaut`;
  const canFav = it.playable || ['Series', 'BoxSet', 'Season'].includes(it.type);
  const fav = canFav ? el('button', { class: `fav${S.watchIds.has(it.id) ? ' on' : ''}`, title: 'Merken', onclick: (e) => { e.stopPropagation(); toggleWatch(it, e.currentTarget); } }, S.watchIds.has(it.id) ? '★' : '☆') : null;
  const imgEl = el('div', { class: 'img', style: it.hasImage ? `background-image:url("${img(it.id, wide ? 480 : 320)}")` : '' },
    it.hasImage ? null : (it.isFolder ? '📁' : '🎬'), it.played ? el('span', { class: 'played' }, '✓') : null,
    it.rating ? el('span', { class: 'rate' }, `★ ${String(it.rating).replace('.', ',')}`) : null,
    it.progress != null ? el('div', { class: 'prog' }, el('div', { style: `width:${Math.min(100, it.progress)}%` })) : null);
  return el('div', {
    class: `tile${wide ? ' wide' : ''}`, role: 'button', tabindex: 0,
    onclick: () => openTile(it),
    onkeydown: (e) => { if (e.key === 'Enter') openTile(it); },
  }, fav, imgEl, el('span', { class: 't' }, it.type === 'Episode' && it.seriesName && S.lib.search ? `${it.seriesName} – ${it.name}` : it.name), sub ? el('span', { class: 's' }, String(sub)) : null);
}

function openTile(it) {
  if (it.playable) return openDetail(it);
  if (it.isFolder || ['Series', 'BoxSet', 'Season'].includes(it.type)) {
    if (S.lib.view !== 'browse' || S.lib.search) S.lib.stack = [{ id: null, name: 'Bibliothek' }];
    libGo({ id: it.id, name: it.name, type: it.type, collectionType: it.collectionType, sort: it.type === 'Series' || it.type === 'Season' ? 'index' : null });
  }
}

async function openDetail(it) {
  S.detail = it;
  $('#detail').hidden = false;
  $('#detail-title').textContent = it.name;
  $('#detail-sub').textContent = [it.seriesName, it.year].filter(Boolean).join(' · ');
  $('#detail-overview').textContent = it.overview || '';
  $('#detail-bg').style.backgroundImage = `url("${img(it.id, 1280, 'Backdrop')}"), url("${img(it.id, 640)}")`;
  $('#btn-detail-play').hidden = !canLoad();
  $('#btn-detail-suggest').hidden = !perm('suggest');
  const wb = $('#btn-detail-watch');
  wb.textContent = S.watchIds.has(it.id) ? '★ Gemerkt' : '☆ Merken';
  const b = $('#detail-badges');
  b.innerHTML = '';
  if (it.runtime) b.append(el('span', { class: 'badge' }, fmt(it.runtime)));
  try {
    const d = await call('lib:item', it.id);
    if (S.detail !== it) return;
    if (d.resolution) b.append(el('span', { class: 'badge hot' }, d.resolution));
    if (d.qualities && d.qualities[0] && d.qualities[0].original) b.append(el('span', { class: 'badge' }, d.qualities[0].label.replace(/^Original · /, '')));
    if (d.audio.length) b.append(el('span', { class: 'badge' }, `${d.audio.length} Tonspur${d.audio.length > 1 ? 'en' : ''}`));
    if (d.subs.length) b.append(el('span', { class: 'badge' }, `${d.subs.length} Untertitel`));
    if (d.resume > 30 && d.runtime && d.resume < d.runtime * 0.92) b.append(el('span', { class: 'badge ok' }, `zuletzt bei ${fmt(d.resume)}`));
    wb.textContent = d.inWatchlist ? '★ Gemerkt' : '☆ Merken';
    if (d.inWatchlist) S.watchIds.add(it.id); else S.watchIds.delete(it.id);
  } catch { /* egal */ }
}
$('#btn-detail-close').addEventListener('click', () => { $('#detail').hidden = true; });
$('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') $('#detail').hidden = true; });
$('#btn-detail-play').addEventListener('click', () => {
  call('room:load', S.detail.id);
  $('#detail').hidden = true;
  $('#library').hidden = true;
});
$('#btn-detail-suggest').addEventListener('click', () => {
  call('room:suggest', S.detail.id);
  $('#detail').hidden = true;
  toast('Vorschlag im Chat gepostet.');
});
$('#btn-detail-watch').addEventListener('click', async () => {
  const on = await toggleWatch(S.detail);
  if (on != null) $('#btn-detail-watch').textContent = on ? '★ Gemerkt' : '☆ Merken';
});

init();

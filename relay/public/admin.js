'use strict';
/* Watchparty – Verwaltung */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const A = {
  me: null,
  view: 'overview',
  ov: null,
  week: null,
  users: [],
  groups: [],
  perms: [],
  bitrates: [],
  defaultGroup: 'standard',
  owner: false,
  userFilter: 'all',
  groupSel: null,
  groupDraft: null,
  invites: [],
  stats: null,
  hourKey: 'viewers',
  weekKey: 'viewers',
  dayKey: 'watchHours',
  auditFilter: '',
  timer: null,
  lastOk: 0,
};

const TITLES = { overview: 'Übersicht', rooms: 'Räume', users: 'Benutzer', groups: 'Gruppen', invites: 'Einladungen', stats: 'Statistik', audit: 'Protokoll', settings: 'Einstellungen' };
const STATE = { playing: ['spielt', 'ok'], paused: ['pausiert', ''], buffering: ['lädt', 'warn'], idle: ['wartet', ''], blocked: ['blockiert', 'warn'], error: ['Fehler', 'bad'] };
const KIND = { web: '🌐 Browser', desktop: '🖥️ Desktop', mobile: '📱 Mobil' };
const BITRATE_LABEL = { 1500000: '1,5 Mbit/s (mobil)', 3000000: '3 Mbit/s', 6000000: '6 Mbit/s (720p)', 10000000: '10 Mbit/s', 20000000: '20 Mbit/s (1080p)', 40000000: '40 Mbit/s (max.)' };

/* ---------------- Hilfen ---------------- */

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'value') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
async function api(p, opts = {}) {
  const r = await fetch(`/api/admin${p}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* egal */ }
  if (!r.ok) { const e = new Error((data && data.error) || `Fehler ${r.status}`); e.status = r.status; throw e; }
  return data;
}
let toastT;
function toast(text, bad = false) {
  const t = $('#toast');
  t.textContent = text; t.classList.toggle('bad', bad); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}
function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360; return h; }
function color(name) { return `hsl(${hue(name)} 75% 68%)`; }
function avatar(name, sm) { return el('div', { class: `avatar${sm ? ' sm' : ''}`, style: `background:${color(name)}` }, String(name || '?').slice(0, 1).toUpperCase()); }
function bytes(n, dec = 1) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? dec : 0).replace('.', ',')} ${u[i]}`;
}
function rate(n) { return `${bytes(n)}/s`; }
function mbit(n) { return `${((n * 8) / 1e6).toFixed(1).replace('.', ',')} Mbit/s`; }
function num(n, d = 0) { return Number.isFinite(n) ? n.toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–'; }
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function dur(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
  return `${Math.floor(sec / 86400)} T ${Math.floor((sec % 86400) / 3600)} h`;
}
function ago(t) {
  if (!t) return 'nie';
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  if (s < 86400 * 30) return `vor ${Math.round(s / 86400)} T`;
  return new Date(t).toLocaleDateString('de-DE');
}
function when(t) { return t ? new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'; }
function clock(t) { return new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }
function uaShort(ua) {
  if (!ua) return 'unbekannt';
  if (/watchparty-desktop/i.test(ua)) return 'Watchparty Desktop';
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${o ? ` · ${o}` : ''}`;
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Kopiert'); } catch { toast('Kopieren nicht möglich', true); } }
function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const card = $('#modal-card');
    card.innerHTML = '';
    const close = (v) => { $('#modal').hidden = true; resolve(v); };
    card.append(el('h2', {}, title), el('p', { class: 'muted' }, text),
      el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: () => close(false) }, 'Abbrechen'), el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okLabel)));
    $('#modal').hidden = false;
  });
}
function showSecret(title, text, secret, extra) {
  const card = $('#modal-card');
  card.innerHTML = '';
  card.append(el('h2', {}, title), el('p', { class: 'muted' }, text),
    el('div', { class: 'secret' }, el('code', {}, secret), el('button', { class: 'btn small', onclick: () => copy(secret) }, 'Kopieren')),
    extra || null,
    el('p', { class: 'tiny muted' }, 'Wird nur jetzt angezeigt.'),
    el('div', { class: 'row end' }, el('button', { class: 'btn primary', onclick: () => { $('#modal').hidden = true; } }, 'Fertig')));
  $('#modal').hidden = false;
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });
function groupById(id) { return A.groups.find((g) => g.id === id); }
function groupChip(id) {
  const g = groupById(id);
  return el('span', { class: 'chip' }, el('span', { class: 'dot', style: `background:${g ? g.color : '#777'}` }), g ? g.name : id);
}
function itemImg(id, w = 160) { return `/img/${id}?w=${w}`; }

/* ---------------- Diagramme ---------------- */

/**
 * Flächendiagramm. series: [{ key, label, color, fmt }]
 */
function areaChart(box, points, series, { xfmt = clock } = {}) {
  box.innerHTML = '';
  if (!points || points.length < 2) { box.append(el('div', { class: 'empty-chart' }, 'Noch zu wenig Daten – füllt sich mit der Zeit.')); return; }
  const W = box.clientWidth || 600, H = box.clientHeight || 190;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  let max = 0;
  for (const s of series) for (const p of points) max = Math.max(max, p[s.key] || 0);
  max = niceMax(max || 1);
  const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v) => pad.t + ih - (v / max) * ih;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const mk = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const grid = mk('g', { class: 'grid' });
  const axis = mk('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    grid.append(mk('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    const tx = mk('text', { x: pad.l - 6, y: y(v) + 3.5, 'text-anchor': 'end' });
    tx.textContent = series[0].fmt ? series[0].fmt(v, true) : num(v);
    axis.append(tx);
  }
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) / 4) * i;
    const tx = mk('text', { x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' });
    tx.textContent = xfmt(t);
    axis.append(tx);
  }
  svg.append(grid, axis);
  for (const s of series) {
    const id = `g${Math.random().toString(36).slice(2)}`;
    const defs = mk('defs', {});
    const lg = mk('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 });
    lg.append(mk('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': '.32' }), mk('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': '0' }));
    defs.append(lg);
    svg.append(defs);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[s.key] || 0).toFixed(1)}`).join('');
    svg.append(mk('path', { d: `${line}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`, fill: `url(#${id})` }));
    svg.append(mk('path', { d: line, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  }
  const cursor = mk('line', { y1: pad.t, y2: pad.t + ih, stroke: '#ffffff40', 'stroke-dasharray': '3 3', visibility: 'hidden' });
  svg.append(cursor);
  box.append(svg);
  const tip = el('div', { class: 'tip', hidden: true });
  box.append(tip);
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((px - pad.l) / iw) * (t1 - t0);
    let best = points[0];
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    cursor.setAttribute('x1', x(best.t)); cursor.setAttribute('x2', x(best.t)); cursor.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = '';
    tip.append(el('span', { class: 'muted' }, xfmt(best.t)));
    for (const s of series) tip.append(el('b', { style: `color:${s.color}` }, `${s.label}: ${s.fmt ? s.fmt(best[s.key] || 0) : num(best[s.key] || 0)}`));
    tip.style.left = `${(x(best.t) / W) * 100}%`;
    tip.style.top = `${(y(Math.max(...series.map((s) => best[s.key] || 0))) / H) * 100}%`;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); });
  if (series.length > 1) box.append(el('div', { class: 'legend' }, series.map((s) => el('span', {}, el('i', { style: `background:${s.color}` }), s.label))));
}

function barChart(box, rows, key, fmt) {
  box.innerHTML = '';
  if (!rows.length) { box.append(el('div', { class: 'empty-chart' }, 'Noch keine Daten.')); return; }
  const W = box.clientWidth || 600, H = box.clientHeight || 240;
  const pad = { l: 40, r: 6, t: 10, b: 24 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(...rows.map((r) => r[key] || 0), 1));
  const bw = iw / rows.length;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const mk = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const g = mk('g', { class: 'grid' }), ax = mk('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = pad.t + ih - (v / max) * ih;
    g.append(mk('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy }));
    const t = mk('text', { x: pad.l - 6, y: yy + 3.5, 'text-anchor': 'end' }); t.textContent = fmt(v, true); ax.append(t);
  }
  svg.append(g, ax);
  const tip = el('div', { class: 'tip', hidden: true });
  rows.forEach((r, i) => {
    const v = r[key] || 0;
    const h = (v / max) * ih;
    const rect = mk('rect', { x: pad.l + i * bw + bw * 0.18, y: pad.t + ih - h, width: Math.max(2, bw * 0.64), height: Math.max(0, h), rx: 3, fill: i === rows.length - 1 ? '#f2b544' : '#f2b544a0' });
    rect.addEventListener('mouseenter', () => {
      tip.hidden = false; tip.innerHTML = '';
      tip.append(el('span', { class: 'muted' }, new Date(r.date).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })), el('b', {}, fmt(v)));
      tip.style.left = `${((pad.l + i * bw + bw / 2) / W) * 100}%`; tip.style.top = `${((pad.t + ih - h) / H) * 100}%`;
    });
    rect.addEventListener('mouseleave', () => { tip.hidden = true; });
    svg.append(rect);
    if (rows.length <= 31 && (i % Math.ceil(rows.length / 10) === 0 || i === rows.length - 1)) {
      const t = mk('text', { x: pad.l + i * bw + bw / 2, y: H - 7, 'text-anchor': 'middle' });
      t.textContent = r.date.slice(8, 10) + '.' + r.date.slice(5, 7) + '.';
      ax.append(t);
    }
  });
  box.append(svg, tip);
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/* ---------------- Start & Navigation ---------------- */

async function init() {
  let me = null;
  try { const r = await fetch('/api/me'); if (r.ok) me = await r.json(); } catch { /* egal */ }
  if (!me || !me.admin) {
    $('#gate').hidden = false;
    if (me) $('#gate-text').textContent = `Du bist als ${me.name} angemeldet, aber kein Admin.`;
    return;
  }
  A.me = me;
  A.owner = !!me.owner;
  $('#me').append(avatar(me.name, true), el('span', {}, me.name), me.owner ? el('span', { class: 'tag owner' }, 'Haupt-Admin') : el('span', { class: 'tag admin' }, 'Admin'));
  $('#shell').hidden = false;
  await loadGroups().catch(() => {});
  const v = (location.hash || '').replace('#', '');
  go(TITLES[v] ? v : 'overview');
  window.addEventListener('hashchange', () => { const h = location.hash.replace('#', ''); if (TITLES[h] && h !== A.view) go(h); });
  window.addEventListener('resize', () => { if (A.view === 'overview') renderCharts(); if (A.view === 'stats') renderStats(); });
}

for (const b of $$('#nav button')) b.addEventListener('click', () => { go(b.dataset.view); $('.nav').classList.remove('open'); });
$('#btn-menu').addEventListener('click', () => $('.nav').classList.toggle('open'));
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) go(g.dataset.goto); });

function go(view) {
  A.view = view;
  history.replaceState(null, '', `#${view}`);
  for (const b of $$('#nav button')) b.classList.toggle('active', b.dataset.view === view);
  for (const s of $$('.view')) s.hidden = s.id !== `v-${view}`;
  $('#view-title').textContent = TITLES[view];
  clearInterval(A.timer);
  if (view === 'overview' || view === 'rooms') { refreshOverview(); A.timer = setInterval(refreshOverview, 3000); }
  if (view === 'overview') loadWeek();
  if (view === 'users') { loadUsers(); A.timer = setInterval(() => { if ($('#drawer').hidden) loadUsers(); }, 10000); }
  if (view === 'groups') loadGroups().then(renderGroups);
  if (view === 'invites') loadInvites();
  if (view === 'stats') loadStats();
  if (view === 'audit') loadAudit();
  if (view === 'settings') loadSettings();
}

setInterval(() => {
  const stale = (A.view === 'overview' || A.view === 'rooms') && Date.now() - A.lastOk > 10000;
  $('#live-dot').classList.toggle('stale', stale);
  $('#live-text').textContent = stale ? 'keine Verbindung' : 'Live';
}, 2000);

/* ---------------- Übersicht ---------------- */

async function refreshOverview() {
  try {
    A.ov = await api('/overview');
    A.lastOk = Date.now();
  } catch (e) {
    if (e.status === 401 || e.status === 403) location.reload();
    return;
  }
  $('#maint-flag').hidden = !A.ov.settings.maintenance;
  $('#nav-rooms').textContent = A.ov.counts.rooms || '';
  if (A.view === 'overview') renderOverview();
  if (A.view === 'rooms') renderRooms();
}

async function loadWeek() {
  try { A.week = (await api('/series')).points; renderCharts(); } catch { /* egal */ }
}

function kpi(k, v, s, cls = '') { return el('div', { class: `kpi ${cls}` }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v), s ? el('span', { class: 's' }, s) : null); }

function renderOverview() {
  const o = A.ov;
  const c = o.counts;
  $('#kpis').replaceChildren(
    kpi('Zuschauer jetzt', String(c.viewers), `${c.users} Konten · Rekord ${o.peak.viewers}${o.peak.at ? ` (${new Date(o.peak.at).toLocaleDateString('de-DE')})` : ''}`, c.viewers ? 'hot' : ''),
    kpi('Schauen gerade', String(c.playing), `${c.desktop} im Desktop-Client`),
    kpi('Aktive Räume', String(c.rooms), `${c.roomsTotal - c.rooms} leer wartend`),
    kpi('Heimserver', o.agent.online ? 'online' : 'offline', o.agent.online ? `${o.agent.info.serverName} · ${o.agent.streams} Streams` : 'Agent nicht verbunden', o.agent.online ? 'okc' : 'badc'),
    kpi('An Zuschauer', mbit(o.traffic.rateOut), `seit Start ${bytes(o.traffic.sessionOut)}`),
    kpi('Vom Heimserver', mbit(o.traffic.rateIn), `seit Start ${bytes(o.traffic.sessionIn)}`),
    kpi('Heim-Upload gespart', `${num(o.traffic.saved, 1)}`, `${bytes(o.traffic.sessionFromCache)} aus dem Cache`, 'okc'),
  );
  $('#kpis').lastChild.querySelector('.v').append(el('small', {}, '%'));
  renderCharts();

  const h = o.health;
  const memPct = (h.rss / h.sysTotal) * 100;
  $('#card-health').replaceChildren(
    el('div', { class: 'card-head' }, el('h3', {}, 'Relay-Server'), el('span', { class: 'tiny muted' }, `läuft seit ${dur(h.uptime)}`)),
    el('div', { class: 'metric-list' },
      metric('CPU (Prozess)', `${num(h.cpu, 1)} %`, h.cpu / (h.cores || 1), h.cpu > 80),
      metric('Arbeitsspeicher', `${bytes(h.rss)} · Heap ${bytes(h.heap)}`, memPct, memPct > 70),
      metric('System frei', `${bytes(h.sysFree)} von ${bytes(h.sysTotal)}`, 100 - (h.sysFree / h.sysTotal) * 100),
      metric('Last (1/5/15 min)', h.load.map((x) => num(x, 2)).join(' · ')),
      metric('Event-Loop-Verzögerung', `Ø ${num(h.lagMs.mean, 1)} ms · p99 ${num(h.lagMs.p99, 1)} ms`, Math.min(100, h.lagMs.p99), h.lagMs.p99 > 50),
      metric('Node', `${h.node} · ${h.cores} Kerne`)));

  const ag = o.agent;
  $('#card-agent').replaceChildren(
    el('div', { class: 'card-head' }, el('h3', {}, 'Heimserver (Agent)')),
    el('div', { class: `status-line${ag.online ? '' : ' off'}` }, el('span', { class: 'dot' }), ag.online ? `Verbunden mit ${ag.info.serverName}` : 'Getrennt'),
    el('div', { class: 'metric-list' },
      metric('Jellyfin', ag.info ? ag.info.version || '–' : '–'),
      metric('Agent-Version', ag.info ? ag.info.agentVersion || '–' : '–'),
      metric('Liest als', ag.info ? ag.info.userName || '–' : '–'),
      metric('Laufende Anfragen', String(ag.streams)),
      metric('Durchsatz vom Heimnetz', rate(o.traffic.rateIn))));

  const ca = o.cache;
  const fill = (ca.bytes / ca.maxBytes) * 100;
  const hit = (ca.hits / Math.max(1, ca.hits + ca.misses)) * 100;
  $('#card-cache').replaceChildren(
    el('div', { class: 'card-head' }, el('h3', {}, 'Video-Cache')),
    el('div', { class: 'metric-list' },
      metric('Belegt', `${bytes(ca.bytes)} von ${bytes(ca.maxBytes, 0)}`, fill, fill > 95),
      metric('Trefferquote', `${num(hit, 1)} %`, hit, false, true),
      metric('Einträge', num(ca.entries)),
      metric('Insgesamt ausgeliefert', bytes(o.traffic.totalOut)),
      metric('Davon aus dem Cache', bytes(o.traffic.totalFromCache))));

  const box = $('#ov-rooms');
  box.innerHTML = '';
  const live = o.rooms.filter((r) => !r.empty);
  if (!live.length) box.append(el('div', { class: 'empty' }, 'Gerade schaut niemand.'));
  for (const r of live.slice(0, 6)) {
    box.append(el('div', { class: 'mini-room' },
      el('div', { class: 'poster', style: r.item ? `background-image:url("${itemImg(r.item.id, 120)}")` : '' }, r.item ? '' : '🎬'),
      el('div', {},
        el('div', {}, el('b', {}, r.item ? r.item.title : 'Noch nichts ausgewählt'), r.item && r.item.subtitle ? el('span', { class: 'muted' }, ` · ${r.item.subtitle}`) : null),
        el('div', { class: 'tiny muted' }, `${r.playing ? '▶' : '❚❚'} ${r.item ? `${fmtTime(r.position)} / ${fmtTime(r.item.runtime)}` : ''} · Raum `, el('span', { class: 'room-code' }, r.code)),
        el('div', { class: 'who' }, r.members.map((m) => el('span', { class: 'chip', title: `${m.name} · ${(STATE[m.status.state] || ['?'])[0]}` }, el('span', { class: 'dot', style: `background:${m.status.state === 'playing' ? 'var(--ok)' : m.status.state === 'buffering' ? 'var(--accent)' : 'var(--line-2)'}` }), m.name)))),
      el('span', { class: 'tiny muted' }, `${r.members.length} 👤`)));
  }

  const feed = $('#feed');
  feed.innerHTML = '';
  if (!o.feed.length) feed.append(el('div', { class: 'empty' }, 'Noch nichts passiert seit dem Start.'));
  const ICON = { login: '🔑', 'login-failed': '⚠️', play: '🎬', room: '▣', register: '✨', admin: '🛡' };
  for (const f of o.feed) feed.append(el('div', { class: `feed-item ${f.level || ''}` }, el('span', {}, ICON[f.type] || '•'), el('span', { class: 'txt' }, f.text), el('span', { class: 't' }, ago(f.t))));
}

function metric(label, value, pct, bad, good) {
  return el('div', { class: 'metric' }, el('span', { class: 'lbl' }, label), el('span', { class: 'val' }, value),
    pct != null ? el('div', { class: `bar${bad ? ' badb' : good ? ' okb' : ''}` }, el('div', { style: `width:${Math.max(0, Math.min(100, pct))}%` })) : null);
}

function seriesFor(key) {
  if (key === 'traffic') {
    return [
      { key: 'out', label: 'An Zuschauer', color: '#f2b544', fmt: (v, axis) => (axis ? `${((v * 8) / 1e6).toFixed(0)}M` : mbit(v)) },
      { key: 'in', label: 'Vom Heimserver', color: '#7aa7ff', fmt: (v) => mbit(v) },
    ];
  }
  return [
    { key: 'viewers', label: 'Zuschauer', color: '#f2b544', fmt: (v) => num(v) },
    { key: 'playing', label: 'Schauen gerade', color: '#5fd68a', fmt: (v) => num(v) },
  ];
}

function renderCharts() {
  if (A.ov) areaChart($('#chart-hour'), A.ov.hour, seriesFor(A.hourKey));
  if (A.week) areaChart($('#chart-week'), A.week, seriesFor(A.weekKey), { xfmt: (t) => new Date(t).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit' }) });
}
function segment(id, prop, after) {
  for (const b of $$(`#${id} button`)) {
    b.addEventListener('click', () => {
      for (const x of $$(`#${id} button`)) x.classList.toggle('on', x === b);
      A[prop] = b.dataset.k || b.dataset.f || '';
      after();
    });
  }
}
segment('seg-hour', 'hourKey', renderCharts);
segment('seg-week', 'weekKey', renderCharts);

/* ---------------- Räume ---------------- */

function renderRooms() {
  const box = $('#rooms');
  const rooms = A.ov.rooms;
  if (!rooms.length) { box.replaceChildren(el('div', { class: 'card empty' }, 'Gerade gibt es keine Räume.')); return; }
  // Eingaben in Ansage-Feldern nicht überschreiben
  const drafts = {};
  for (const i of $$('.announce-row input', box)) drafts[i.dataset.code] = i.value;
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.code : null;
  box.innerHTML = '';
  for (const r of rooms) {
    const pct = r.item && r.item.runtime ? (r.position / r.item.runtime) * 100 : 0;
    const input = el('input', { maxlength: 300, placeholder: 'Ansage an diesen Raum …', 'data-code': r.code, value: drafts[r.code] || '' });
    const card = el('div', { class: 'card room-card' },
      el('div', { class: 'room-top' },
        el('div', { class: 'poster', style: r.item ? `background-image:url("${itemImg(r.item.id, 200)}")` : '' }, r.item ? '' : '🎬'),
        el('div', { class: 'room-title' },
          el('div', { class: 'room-meta' }, el('span', { class: 'room-code' }, r.code), r.empty ? el('span', { class: 'tag' }, `leer seit ${ago(r.emptySince)}`) : el('span', { class: `tag ${r.playing ? 'on' : ''}` }, r.playing ? 'läuft' : 'pausiert'), r.allowAllControl ? el('span', { class: 'tag info' }, 'alle steuern') : el('span', { class: 'tag' }, 'nur Host steuert')),
          el('h3', {}, r.item ? `${r.item.title}${r.item.subtitle ? ` · ${r.item.subtitle}` : ''}` : 'Noch nichts ausgewählt'),
          el('div', { class: 'room-meta' }, `erstellt von ${r.createdBy || '?'} ${ago(r.createdAt)}`, r.host ? ` · Host: ${r.host}` : '', ` · ${r.chat} Chat-Nachrichten`),
          r.item ? el('div', { class: 'progress' }, el('div', { class: 'bar' }, el('div', { style: `width:${pct}%` })), el('div', { class: 'times' }, el('span', {}, fmtTime(r.position)), el('span', {}, fmtTime(r.item.runtime)))) : null),
        el('div', { class: 'room-actions' },
          el('a', { class: 'btn small', href: `/r/${r.code}`, target: '_blank' }, 'Beitreten'),
          r.allowAllControl ? null : el('button', { class: 'btn small', onclick: () => roomAction(r.code, 'unlock') }, 'Steuerung freigeben'),
          el('button', { class: 'btn small danger', onclick: async () => { if (await confirmBox(`Raum ${r.code} schließen?`, 'Alle Mitglieder werden getrennt und sehen einen Hinweis.', 'Schließen', true)) roomAction(r.code, 'close'); } }, 'Schließen'))),
      r.members.length ? el('div', { class: 'members-list' }, r.members.map((m) => {
        const [st, cls] = STATE[m.status.state] || ['?', ''];
        const drift = Math.abs(m.status.drift || 0);
        return el('div', { class: 'member-row' },
          avatar(m.name, true),
          el('div', {}, el('b', {}, m.name), m.isHost ? el('span', { class: 'tag owner', style: 'margin-left:6px' }, 'Host') : null, m.name !== m.username ? el('span', { class: 'tiny muted' }, ` @${m.username}`) : null),
          el('span', { class: `tiny ${cls}` }, st, m.status.state === 'playing' && drift > 0.4 ? ` · ${num(drift, 1)} s versetzt` : ''),
          el('span', { class: 'kind hide-sm' }, KIND[m.kind] || m.kind),
          el('span', { class: 'kind hide-sm', title: m.ip || '' }, `seit ${ago(m.joinedAt).replace('vor ', '')}`),
          m.isHost && r.members.length === 1 ? el('span') : el('button', { class: 'icon', title: 'Aus dem Raum entfernen', onclick: () => kick(r.code, m) }, '✕'));
      })) : null,
      r.empty ? null : el('form', { class: 'announce-row', onsubmit: (e) => { e.preventDefault(); announce(r.code, input); } }, input, el('button', { class: 'btn small', type: 'submit' }, '📣 Senden')));
    box.append(card);
    if (focused === r.code) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
}

async function roomAction(code, action, body) {
  try { await api(`/rooms/${code}/${action}`, { method: 'POST', body: body || {} }); toast('Erledigt'); refreshOverview(); } catch (e) { toast(e.message, true); }
}
async function kick(code, m) {
  if (await confirmBox(`${m.name} entfernen?`, 'Die Person fliegt aus dem Raum, kann aber mit dem Link wieder beitreten. Zum dauerhaften Aussperren das Konto sperren.', 'Entfernen', true)) roomAction(code, 'kick', { clientId: m.id });
}
async function announce(code, input) {
  const text = input.value.trim();
  if (!text) return;
  await roomAction(code, 'announce', { text });
  input.value = '';
}
$('#announce-all').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = e.target.text.value.trim();
  if (!text) return;
  try { const r = await api('/announce', { method: 'POST', body: { text } }); toast(`An ${r.rooms} Räume gesendet`); e.target.text.value = ''; } catch (ex) { toast(ex.message, true); }
});

/* ---------------- Benutzer ---------------- */

async function loadUsers() {
  try {
    const d = await api('/users');
    A.users = d.users;
    A.owner = d.owner;
    renderUsers();
  } catch (e) { toast(e.message, true); }
}

segment('user-filter', 'userFilter', renderUsers);
$('#user-search').addEventListener('input', renderUsers);

function userStatus(u) {
  if (u.disabled) return el('span', { class: 'tag off' }, 'gesperrt');
  if (u.expired) return el('span', { class: 'tag off' }, 'abgelaufen');
  if (u.online.length) return el('span', { class: 'state on' }, el('span', { class: 'dot' }), `im Raum ${[...new Set(u.online.map((o) => o.room))].join(', ')}`);
  return el('span', { class: 'state' }, el('span', { class: 'dot' }), 'offline');
}

function renderUsers() {
  const q = $('#user-search').value.trim().toLowerCase();
  const f = A.userFilter;
  const list = A.users.filter((u) => (!q || u.username.toLowerCase().includes(q) || (u.note || '').toLowerCase().includes(q))
    && (f === 'all' || (f === 'online' && u.online.length) || (f === 'admin' && u.admin) || (f === 'disabled' && (u.disabled || u.expired))));
  const tb = $('#users-table tbody');
  tb.innerHTML = '';
  if (!list.length) tb.append(el('tr', {}, el('td', { colspan: 6, class: 'empty' }, 'Keine Konten gefunden.')));
  for (const u of list) {
    tb.append(el('tr', { class: `click${u.disabled || u.expired ? ' dim' : ''}`, onclick: () => openUser(u.username) },
      el('td', {}, el('div', { class: 'ucell' }, avatar(u.username), el('div', {},
        el('div', { class: 'uname' }, u.username, u.owner ? el('span', { class: 'tag owner' }, 'Haupt-Admin') : u.admin ? el('span', { class: 'tag admin' }, 'Admin') : null, u.expires && !u.expired ? el('span', { class: 'tag', title: when(u.expires) }, `bis ${new Date(u.expires).toLocaleDateString('de-DE')}`) : null),
        u.note ? el('div', { class: 'tiny muted' }, u.note) : null))),
      el('td', {}, u.admin ? el('span', { class: 'tiny muted' }, 'alles') : el('div', { class: 'chips' }, u.effective.map(groupChip))),
      el('td', {}, userStatus(u)),
      el('td', { class: 'muted' }, ago(u.lastSeen || u.lastLogin)),
      el('td', { class: 'num' }, `${num(u.stats.watchHours, 1)} h`),
      el('td', { class: 'muted' }, new Date(u.created).toLocaleDateString('de-DE'))));
  }
}

$('#btn-new-user').addEventListener('click', () => {
  const card = $('#modal-card');
  card.innerHTML = '';
  const f = el('form', { class: 'invite-form' },
    el('h2', {}, 'Neues Konto'),
    el('label', {}, 'Benutzername', el('input', { name: 'username', maxlength: 24, required: true, autocomplete: 'off', pattern: '[A-Za-z0-9_.\\-äöüÄÖÜß]{2,24}' })),
    el('label', {}, 'Passwort ', el('span', { class: 'tiny' }, '(leer lassen = sicheres Zufallspasswort)'), el('input', { name: 'password', type: 'text', minlength: 8, autocomplete: 'new-password' })),
    el('div', {}, el('span', { class: 'section-title' }, 'Gruppen'), el('div', { class: 'group-checks', style: 'margin-top:6px' }, A.groups.map((g) => el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'g', value: g.id, checked: g.id === A.defaultGroup }), el('span', { class: 'dot', style: `width:9px;height:9px;border-radius:3px;background:${g.color};display:inline-block` }), g.name)))),
    el('div', { class: 'form-grid' },
      el('label', {}, 'Läuft ab (optional)', el('input', { name: 'expires', type: 'date' })),
      el('label', {}, 'Notiz', el('input', { name: 'note', maxlength: 200 }))),
    A.owner ? el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'admin' }), 'Admin (darf alles verwalten)') : null,
    el('p', { class: 'error bad tiny', hidden: true }),
    el('div', { class: 'row end' }, el('button', { class: 'btn', type: 'button', onclick: () => { $('#modal').hidden = true; } }, 'Abbrechen'), el('button', { class: 'btn primary', type: 'submit' }, 'Anlegen')));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      username: f.username.value.trim(), password: f.password.value || undefined,
      groups: $$('input[name=g]:checked', f).map((x) => x.value), note: f.note.value,
      expires: f.expires.value ? new Date(`${f.expires.value}T23:59:59`).getTime() : null,
      admin: f.admin ? f.admin.checked : false,
    };
    try {
      const r = await api('/users', { method: 'POST', body });
      loadUsers();
      const login = `${location.origin}\nBenutzer: ${r.user.username}\nPasswort: ${r.password || body.password}`;
      if (r.password) showSecret('Konto angelegt', `Gib ${r.user.username} diese Zugangsdaten:`, r.password, el('button', { class: 'btn small', onclick: () => copy(login) }, 'Komplette Login-Daten kopieren'));
      else { $('#modal').hidden = true; toast(`Konto ${r.user.username} angelegt`); }
    } catch (ex) { const p = $('.error', f); p.textContent = ex.message; p.hidden = false; }
  });
  card.append(f);
  $('#modal').hidden = false;
  f.username.focus();
});

function closeDrawer() { $('#drawer').hidden = true; $('#drawer-bg').hidden = true; }
$('#drawer-bg').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); $('#modal').hidden = true; } });

function openUser(name) {
  const u = A.users.find((x) => x.username === name);
  if (!u) return;
  const self = u.username.toLowerCase() === A.me.username.toLowerCase();
  const locked = u.admin && !self && !A.owner; // andere Admins nur durch Haupt-Admin
  const d = $('#drawer');
  d.innerHTML = '';
  const patch = async (body, msg) => {
    try { await api(`/users/${encodeURIComponent(u.username)}`, { method: 'PATCH', body }); toast(msg || 'Gespeichert'); await loadUsers(); openUser(u.username); }
    catch (e) { toast(e.message, true); }
  };
  const groupsBox = el('div', { class: 'group-checks' }, A.groups.map((g) => el('label', { class: 'inline' },
    el('input', { type: 'checkbox', value: g.id, checked: u.groups.includes(g.id), disabled: locked || u.admin }),
    el('span', { style: `width:9px;height:9px;border-radius:3px;background:${g.color};display:inline-block` }), g.name,
    g.id === A.defaultGroup ? el('span', { class: 'tiny muted' }, ' (Standard)') : null)));
  const expiresIn = el('input', { type: 'date', value: u.expires ? new Date(u.expires).toISOString().slice(0, 10) : '', disabled: locked || u.owner });
  const noteIn = el('input', { maxlength: 500, value: u.note || '', placeholder: 'nur für Admins sichtbar', disabled: locked });
  d.append(
    el('div', { class: 'drawer-head' }, avatar(u.username),
      el('div', { class: 'grow' }, el('h2', {}, u.username), el('div', { class: 'row' }, u.owner ? el('span', { class: 'tag owner' }, 'Haupt-Admin') : u.admin ? el('span', { class: 'tag admin' }, 'Admin') : null, userStatus(u))),
      el('button', { class: 'icon', onclick: closeDrawer }, '✕')),
    el('div', { class: 'kv' },
      el('div', {}, el('span', {}, 'Watchtime'), el('b', {}, `${num(u.stats.watchHours, 1)} h`)),
      el('div', {}, el('span', {}, 'Anmeldungen'), el('b', {}, num(u.stats.logins))),
      el('div', {}, el('span', {}, 'Zuletzt geschaut'), el('b', { title: u.stats.lastItem || '' }, u.stats.lastWatched ? ago(u.stats.lastWatched) : '–')),
      el('div', {}, el('span', {}, 'Angelegt'), el('b', {}, new Date(u.created).toLocaleDateString('de-DE'))),
      el('div', {}, el('span', {}, 'Von'), el('b', {}, u.createdBy || '–')),
      el('div', {}, el('span', {}, 'Letzter Login'), el('b', {}, u.lastLogin ? ago(u.lastLogin) : '–'))),
    locked ? el('p', { class: 'tiny warn' }, 'Andere Admins kann nur der Haupt-Admin bearbeiten.') : null,
    el('section', {}, el('span', { class: 'section-title' }, 'Gruppen'), u.admin ? el('p', { class: 'tiny muted' }, 'Admins dürfen alles, Gruppen spielen keine Rolle.') : groupsBox,
      u.admin ? null : el('p', { class: 'tiny muted' }, 'Keine Gruppe gewählt = Standardgruppe.')),
    el('section', {}, el('div', { class: 'form-grid' }, el('label', {}, 'Läuft ab', expiresIn), el('label', {}, 'Notiz', noteIn))),
    locked ? null : el('div', { class: 'row end' }, el('button', { class: 'btn primary', onclick: () => patch({
      groups: $$('input:checked', groupsBox).map((x) => x.value), note: noteIn.value,
      ...(u.owner ? {} : { expires: expiresIn.value ? new Date(`${expiresIn.value}T23:59:59`).getTime() : null }),
    }) }, 'Speichern')),
    el('section', {}, el('span', { class: 'section-title' }, `Sitzungen (${u.sessions.length})`),
      u.sessions.length ? u.sessions.map((s) => el('div', { class: 'sess' },
        el('span', {}, s.online ? el('span', { class: 'ok' }, '● ') : '', uaShort(s.ua), s.ip ? el('span', { class: 'muted' }, ` · ${s.ip}`) : null),
        el('span', { class: 'ua' }, `angemeldet ${ago(s.created)} · aktiv ${ago(s.lastSeen)}`),
        locked ? null : el('button', { class: 'btn small', onclick: async () => { try { await api(`/sessions/${s.id}`, { method: 'DELETE' }); toast('Sitzung beendet'); await loadUsers(); openUser(u.username); } catch (e) { toast(e.message, true); } } }, 'Beenden')))
        : el('p', { class: 'tiny muted' }, 'Nirgends angemeldet.')),
    locked ? null : el('section', {}, el('span', { class: 'section-title' }, 'Aktionen'),
      el('div', { class: 'row' },
        el('button', { class: 'btn small', onclick: async () => {
          if (!(await confirmBox('Passwort zurücksetzen?', `${u.username} bekommt ein neues Zufallspasswort${self ? '' : ' und wird überall abgemeldet'}.`, 'Zurücksetzen'))) return;
          try { const r = await api(`/users/${encodeURIComponent(u.username)}/password`, { method: 'POST', body: {} }); showSecret('Neues Passwort', `Für ${u.username}:`, r.password); loadUsers(); } catch (e) { toast(e.message, true); }
        } }, '🔑 Passwort zurücksetzen'),
        u.sessions.length && !self ? el('button', { class: 'btn small', onclick: async () => { try { await api(`/users/${encodeURIComponent(u.username)}/logout`, { method: 'POST' }); toast('Überall abgemeldet'); await loadUsers(); openUser(u.username); } catch (e) { toast(e.message, true); } } }, '⏏ Überall abmelden') : null,
        A.owner && !u.owner && !self ? el('button', { class: 'btn small', onclick: () => patch({ admin: !u.admin }, u.admin ? 'Admin-Rechte entzogen' : 'Ist jetzt Admin') }, u.admin ? '⬇ Admin-Rechte entziehen' : '⬆ Zum Admin machen') : null)),
    locked || u.owner || self ? null : el('section', { class: 'danger-zone' },
      el('span', { class: 'section-title bad' }, 'Gefahrenzone'),
      el('div', { class: 'row' },
        el('button', { class: 'btn small danger', onclick: () => patch({ disabled: !u.disabled }, u.disabled ? 'Entsperrt' : 'Gesperrt und getrennt') }, u.disabled ? '🔓 Entsperren' : '⛔ Sperren'),
        el('button', { class: 'btn small danger', onclick: async () => {
          if (!(await confirmBox(`${u.username} löschen?`, 'Das Konto wird endgültig entfernt und sofort überall getrennt. Die Statistik bleibt erhalten.', 'Löschen', true))) return;
          try { await api(`/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' }); toast('Gelöscht'); closeDrawer(); loadUsers(); } catch (e) { toast(e.message, true); }
        } }, '🗑 Konto löschen'))),
    u.owner ? el('p', { class: 'tiny muted' }, 'Der Haupt-Admin kann nicht gelöscht, gesperrt oder herabgestuft werden.') : null,
  );
  d.hidden = false;
  $('#drawer-bg').hidden = false;
}

/* ---------------- Gruppen ---------------- */

async function loadGroups() {
  const d = await api('/groups');
  A.groups = d.groups;
  A.perms = d.permissions;
  A.bitrates = d.bitrates;
  A.defaultGroup = d.defaultGroup;
}

function renderGroups() {
  const box = $('#groups');
  box.innerHTML = '';
  for (const g of A.groups) {
    const on = A.perms.filter((p) => g.perms[p.key]).length;
    const acc = g.access.mode === 'all' ? 'alle Inhalte' : g.access.mode === 'only' ? `nur ${g.access.ids.length} ausgewählte` : `alles außer ${g.access.ids.length}`;
    box.append(el('button', { class: `group-item${A.groupSel === g.id ? ' sel' : ''}`, onclick: () => editGroup(g.id) },
      el('span', { class: 'sw', style: `background:${g.color}` }),
      el('div', {}, el('div', { class: 'gn' }, g.name, g.id === A.defaultGroup ? el('span', { class: 'tag', style: 'margin-left:6px' }, 'Standard') : null),
        el('div', { class: 'gd' }, `${on}/${A.perms.length} Rechte · ${acc}`)),
      el('span', { class: 'tiny muted' }, `${g.members} 👤`)));
  }
  if (A.groupSel) editGroup(A.groupSel, true);
}

$('#btn-new-group').addEventListener('click', async () => {
  try {
    const r = await api('/groups', { method: 'POST', body: { name: 'Neue Gruppe', perms: { chat: true, suggest: true, control: true }, color: `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}` } });
    await loadGroups();
    A.groupSel = r.group.id;
    A.groupDraft = null;
    renderGroups();
  } catch (e) { toast(e.message, true); }
});

function editGroup(id, keepDraft) {
  const g = A.groups.find((x) => x.id === id);
  if (!g) return;
  if (A.groupSel !== id || !keepDraft || !A.groupDraft) A.groupDraft = structuredClone(g);
  A.groupSel = id;
  for (const b of $$('.group-item')) b.classList.toggle('sel', b.textContent.startsWith(g.name));
  const dft = A.groupDraft;
  dft.access.labels = dft.access.labels || {};
  const box = $('#group-edit');
  box.innerHTML = '';
  const name = el('input', { value: dft.name, maxlength: 40, oninput: (e) => { dft.name = e.target.value; } });
  const desc = el('input', { value: dft.description || '', maxlength: 200, oninput: (e) => { dft.description = e.target.value; } });
  const col = el('input', { type: 'color', value: dft.color, style: 'height:38px;padding:3px', oninput: (e) => { dft.color = e.target.value; } });
  const quality = el('select', { onchange: (e) => { dft.maxBitrate = Number(e.target.value); } }, A.bitrates.map((b) => el('option', { value: b, selected: b === dft.maxBitrate }, BITRATE_LABEL[b] || b)));
  const picked = el('div', { class: 'picked' });
  const renderPicked = () => {
    picked.innerHTML = '';
    if (!dft.access.ids.length) picked.append(el('span', { class: 'tiny muted' }, dft.access.mode === 'all' ? '' : 'Noch nichts ausgewählt – unten im Baum hinzufügen.'));
    for (const i of dft.access.ids) picked.append(el('span', { class: 'chip' }, dft.access.labels[i] || i.slice(0, 8), el('button', { title: 'Entfernen', onclick: () => { dft.access.ids = dft.access.ids.filter((x) => x !== i); renderPicked(); tree.refreshMarks(); } }, '✕')));
  };
  const modes = el('div', { class: 'access-modes' }, [['all', 'Alles', 'Alle Bibliotheken (außer was der Agent ausschließt)'], ['only', 'Nur ausgewählte', 'Nur diese Bibliotheken, Ordner oder Serien'], ['except', 'Alles außer', 'Alles, nur die ausgewählten nicht']].map(([m, t, s]) =>
    el('button', { type: 'button', 'data-mode': m, class: `mode${dft.access.mode === m ? ' on' : ''}`, onclick: () => { dft.access.mode = m; for (const b of $$('.mode', modes)) b.classList.toggle('on', b.dataset.mode === m); treeWrap.hidden = m === 'all'; renderPicked(); } }, el('strong', {}, t), el('span', {}, s))));
  const tree = makeTree((it) => {
    const k = it.id.replace(/-/g, '').toLowerCase();
    if (dft.access.ids.includes(k)) dft.access.ids = dft.access.ids.filter((x) => x !== k);
    else { dft.access.ids.push(k); dft.access.labels[k] = it.seriesName && it.type !== 'Series' ? `${it.seriesName} · ${it.name}` : it.name; }
    renderPicked();
  }, (it) => dft.access.ids.includes(it.id.replace(/-/g, '').toLowerCase()));
  const treeWrap = el('div', { class: 'tree-wrap', hidden: dft.access.mode === 'all' }, el('span', { class: 'tiny muted' }, 'Bibliothek durchsuchen und mit + auswählen. Alles darunter (Unterordner, Staffeln, Folgen) zählt automatisch mit.'), tree.el);
  renderPicked();
  box.append(
    el('div', { class: 'form-grid' }, el('label', { class: 'span2' }, 'Name', name), el('label', {}, 'Farbe', col), el('label', { class: 'span2' }, 'Beschreibung', desc), el('label', {}, 'Höchste Qualität', quality)),
    el('div', { style: 'display:grid;gap:10px' }, el('span', { class: 'section-title' }, 'Rechte'),
      el('div', { class: 'perm-grid' }, A.perms.map((p) => el('label', { class: 'perm' }, el('strong', {}, p.label), el('p', {}, p.desc),
        el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked: !!dft.perms[p.key], onchange: (e) => { dft.perms[p.key] = e.target.checked; } }), el('span')))))),
    el('div', { style: 'display:grid;gap:10px' }, el('span', { class: 'section-title' }, 'Inhalte'), modes, picked, treeWrap),
    el('div', { class: 'edit-foot' },
      g.builtin || g.id === A.defaultGroup ? el('span', { class: 'tiny muted' }, g.builtin ? 'Eingebaute Gruppe, kann nicht gelöscht werden.' : 'Standardgruppe für neue Konten.') : el('button', { class: 'btn danger small', onclick: async () => {
        if (!(await confirmBox(`Gruppe „${g.name}“ löschen?`, `${g.members} Konten verlieren diese Gruppe (ohne andere Gruppe → Standardgruppe).`, 'Löschen', true))) return;
        try { await api(`/groups/${g.id}`, { method: 'DELETE' }); A.groupSel = null; await loadGroups(); renderGroups(); $('#group-edit').replaceChildren(el('div', { class: 'empty-state' }, 'Gelöscht.')); } catch (e) { toast(e.message, true); }
      } }, 'Gruppe löschen'),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => { A.groupDraft = null; editGroup(id); } }, 'Verwerfen'),
        el('button', { class: 'btn primary', onclick: async () => {
          if (dft.access.mode === 'only' && !dft.access.ids.length && !(await confirmBox('Keine Inhalte ausgewählt', '„Nur ausgewählte“ ohne Auswahl heißt: diese Gruppe sieht gar nichts. Trotzdem speichern?', 'Speichern'))) return;
          try {
            await api(`/groups/${g.id}`, { method: 'PATCH', body: { name: dft.name, description: dft.description, color: dft.color, perms: dft.perms, maxBitrate: dft.maxBitrate, access: dft.access } });
            toast('Gruppe gespeichert, gilt sofort');
            await loadGroups(); A.groupDraft = null; renderGroups();
          } catch (e) { toast(e.message, true); }
        } }, 'Speichern'))),
  );
}

/** Aufklappbarer Bibliotheks-Baum. onPick(item), isPicked(item) */
function makeTree(onPick, isPicked) {
  const root = el('div', { class: 'tree' });
  const rows = [];
  const FOLDERISH = new Set(['CollectionFolder', 'Folder', 'Series', 'Season', 'BoxSet', 'UserView']);
  const ICON = { CollectionFolder: '📚', Folder: '📁', Series: '📺', Season: '🗂', BoxSet: '🎞', Movie: '🎬', Episode: '▶', Video: '🎬', UserView: '📚' };
  async function load(parentId, into) {
    into.innerHTML = '';
    into.append(el('div', { class: 'tiny muted', style: 'padding:6px' }, 'lädt …'));
    try {
      const d = await api(`/browse${parentId ? `?parentId=${parentId}` : ''}`);
      into.innerHTML = '';
      if (!d.items.length) into.append(el('div', { class: 'tiny muted', style: 'padding:6px' }, 'leer'));
      for (const it of d.items) {
        const kids = el('div', { class: 'tree-kids', hidden: true });
        const folder = FOLDERISH.has(it.type) || it.isFolder;
        let open = false;
        const tg = el('button', { class: 'tg', disabled: !folder, onclick: () => { open = !open; tg.textContent = open ? '▾' : '▸'; kids.hidden = !open; if (open && !kids.childElementCount) load(it.id, kids); } }, folder ? '▸' : '');
        const add = el('button', { class: 'btn small', onclick: () => { onPick(it); mark(); } });
        const row = el('div', { class: 'tree-row' }, tg, el('span', {}, ICON[it.type] || '•'), el('span', {}, it.name, it.year ? el('span', { class: 'muted' }, ` (${it.year})`) : null), add);
        const mark = () => { const p = isPicked(it); row.classList.toggle('picked-row', p); add.textContent = p ? '✓ gewählt' : '+'; };
        rows.push(mark);
        mark();
        into.append(row, kids);
      }
      if (d.total > d.items.length) into.append(el('div', { class: 'tiny muted', style: 'padding:6px' }, `… und ${d.total - d.items.length} weitere`));
    } catch (e) { into.innerHTML = ''; into.append(el('div', { class: 'tiny bad', style: 'padding:6px' }, e.message)); }
  }
  load(null, root);
  return { el: root, refreshMarks: () => rows.forEach((f) => f()) };
}

/* ---------------- Einladungen ---------------- */

async function loadInvites() {
  try {
    if (!A.groups.length) await loadGroups();
    const sel = $('#invite-form').group;
    if (!sel.options.length) for (const g of A.groups) sel.append(el('option', { value: g.id, selected: g.id === A.defaultGroup }, g.name));
    A.invites = (await api('/invites')).invites;
    const tb = $('#invites-table tbody');
    tb.innerHTML = '';
    if (!A.invites.length) tb.append(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, 'Noch keine Einladungen.')));
    for (const i of A.invites) {
      const status = i.revoked ? el('span', { class: 'tag off' }, 'widerrufen') : i.valid ? el('span', { class: 'tag on' }, 'offen') : i.usedBy.length >= i.maxUses ? el('span', { class: 'tag' }, 'verbraucht') : el('span', { class: 'tag' }, 'abgelaufen');
      tb.append(el('tr', { class: i.valid ? '' : 'dim' },
        el('td', {}, when(i.created), i.note ? el('div', { class: 'tiny muted' }, i.note) : null),
        el('td', {}, i.by),
        el('td', {}, i.group ? groupChip(i.group) : el('span', { class: 'muted' }, 'Standard')),
        el('td', {}, `${i.usedBy.length}/${i.maxUses}`, i.usedBy.length ? el('div', { class: 'tiny muted' }, i.usedBy.join(', ')) : null),
        el('td', { class: 'muted' }, i.valid ? `in ${dur((i.expires - Date.now()) / 1000)}` : when(i.expires)),
        el('td', {}, status),
        el('td', { class: 'num' }, i.valid ? el('div', { class: 'row end' },
          el('button', { class: 'btn small', onclick: () => copy(`${location.origin}/invite/${i.code}`) }, 'Link kopieren'),
          el('button', { class: 'btn small danger', onclick: async () => { try { await api(`/invites/${i.code}`, { method: 'DELETE' }); loadInvites(); } catch (e) { toast(e.message, true); } } }, 'Widerrufen')) : null)));
    }
  } catch (e) { toast(e.message, true); }
}

$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('/invites', { method: 'POST', body: { group: f.group.value, hours: Number(f.hours.value), uses: Number(f.uses.value), note: f.note.value } });
    const link = `${location.origin}${r.path}`;
    $('#invite-result').replaceChildren(el('code', {}, link), el('button', { class: 'btn small', type: 'button', onclick: () => copy(link) }, 'Kopieren'));
    copy(link);
    f.note.value = '';
    loadInvites();
  } catch (ex) { toast(ex.message, true); }
});

/* ---------------- Statistik ---------------- */

async function loadStats() {
  try { A.stats = await api('/stats'); renderStats(); } catch (e) { toast(e.message, true); }
}
segment('seg-days', 'dayKey', renderStats);

function renderStats() {
  const s = A.stats;
  if (!s) return;
  const t = s.totals;
  const saved = t.bytesOut ? (t.bytesFromCache / t.bytesOut) * 100 : 0;
  $('#stat-kpis').replaceChildren(
    kpi('Watchtime gesamt', `${num(t.watchHours, 1)} h`, 'Summe über alle Zuschauer', 'hot'),
    kpi('Rekord gleichzeitig', String(s.peak.viewers), s.peak.at ? when(s.peak.at) : '–'),
    kpi('Ausgeliefert', bytes(t.bytesOut), 'an alle Zuschauer'),
    kpi('Heim-Upload gespart', `${num(saved, 1)} %`, `${bytes(t.bytesFromCache)} kamen aus dem Cache`, 'okc'),
    kpi('Titel gestartet (30 T)', num(s.days.reduce((a, d) => a + d.starts, 0)), `${s.topItems.length} verschiedene Titel`),
    kpi('Fehlversuche (30 T)', num(s.days.reduce((a, d) => a + d.failedLogins, 0)), 'falsche Passwörter', s.days.reduce((a, d) => a + d.failedLogins, 0) > 20 ? 'badc' : ''),
  );
  const fmts = { watchHours: (v, ax) => (ax ? num(v, v < 10 ? 1 : 0) : `${num(v, 1)} h`), users: (v) => num(v), peakViewers: (v) => num(v), starts: (v) => num(v) };
  barChart($('#chart-days'), fillDays(s.days), A.dayKey, fmts[A.dayKey]);
  const ti = $('#top-items tbody');
  ti.innerHTML = '';
  if (!s.topItems.length) ti.append(el('tr', {}, el('td', { class: 'empty' }, 'Noch nichts geschaut.')));
  s.topItems.forEach((it, i) => ti.append(el('tr', {},
    el('td', { style: 'width:34px' }, el('span', { class: `rank${i === 0 ? ' r1' : ''}` }, i + 1)),
    el('td', {}, el('b', {}, it.title), it.subtitle && it.type === 'Episode' ? el('span', { class: 'muted' }, ` · ${it.subtitle}`) : null, el('div', { class: 'tiny muted' }, `${it.starts}× gestartet · ${it.viewers} Zuschauer · zuletzt ${ago(it.lastPlayed)}`)),
    el('td', { class: 'num' }, `${num(it.hours, 1)} h`))));
  const tu = $('#top-users tbody');
  tu.innerHTML = '';
  if (!s.topUsers.length) tu.append(el('tr', {}, el('td', { class: 'empty' }, 'Noch keine Daten.')));
  s.topUsers.forEach((u, i) => tu.append(el('tr', {},
    el('td', { style: 'width:34px' }, el('span', { class: `rank${i === 0 ? ' r1' : ''}` }, i + 1)),
    el('td', {}, el('div', { class: 'ucell' }, avatar(u.name, true), el('div', {}, el('b', {}, u.name), el('div', { class: 'tiny muted' }, u.lastItem ? `zuletzt „${u.lastItem}“ ${ago(u.lastWatched)}` : `${u.logins || 0} Anmeldungen`)))),
    el('td', { class: 'num' }, `${num(u.hours, 1)} h`))));
}

/** Lücken der letzten 30 Tage mit Nullen füllen. */
function fillDays(days) {
  const map = Object.fromEntries(days.map((d) => [d.date, d]));
  const out = [];
  for (let i = 29; i >= 0; i--) {
    const t = new Date(Date.now() - i * 86400000);
    const k = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    out.push(map[k] || { date: k, watchHours: 0, users: 0, peakViewers: 0, starts: 0 });
  }
  return out;
}

/* ---------------- Protokoll ---------------- */

const AUDIT = {
  login: ['🔑', 'Anmeldung'], 'login-failed': ['⚠️', 'Fehlversuch'], 'login-blocked': ['⛔', 'Gesperrtes Konto versucht'], register: ['✨', 'Registriert'],
  'user-create': ['➕', 'Konto angelegt'], 'user-update': ['✎', 'Konto geändert'], 'user-delete': ['🗑', 'Konto gelöscht'], 'user-password': ['🔑', 'Passwort zurückgesetzt'], 'user-logout': ['⏏', 'Abgemeldet'],
  'session-revoke': ['⏏', 'Sitzung beendet'], 'group-create': ['◈', 'Gruppe angelegt'], 'group-update': ['◈', 'Gruppe geändert'], 'group-delete': ['🗑', 'Gruppe gelöscht'],
  'invite-create': ['✉', 'Einladung erstellt'], 'invite-revoke': ['✉', 'Einladung widerrufen'], 'room-close': ['▣', 'Raum geschlossen'], 'room-kick': ['✕', 'Aus Raum entfernt'], announce: ['📣', 'Ansage'], settings: ['⚙', 'Einstellungen'],
};
let auditTimer;
$('#audit-search').addEventListener('input', () => { clearTimeout(auditTimer); auditTimer = setTimeout(loadAudit, 250); });
segment('audit-filter', 'auditFilter', loadAudit);

async function loadAudit() {
  try {
    const q = $('#audit-search').value.trim();
    let entries = (await api(`/audit?limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}`)).entries;
    const f = A.auditFilter;
    if (f === 'login') entries = entries.filter((e) => e.type === 'login' || e.type === 'register');
    if (f === 'failed') entries = entries.filter((e) => e.type === 'login-failed' || e.type === 'login-blocked');
    if (f === 'admin') entries = entries.filter((e) => e.by);
    const tb = $('#audit-table tbody');
    tb.innerHTML = '';
    if (!entries.length) tb.append(el('tr', {}, el('td', { colspan: 4, class: 'empty' }, 'Keine Einträge.')));
    for (const e of entries) {
      const [ico, label] = AUDIT[e.type] || ['•', e.type];
      const details = Object.entries(e).filter(([k]) => !['t', 'type', 'by', 'user'].includes(k)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((x) => (groupById(x) ? groupById(x).name : x)).join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : v}`).join(' · ');
      tb.append(el('tr', { class: e.type === 'login-failed' ? 'warn' : '' },
        el('td', { class: 'muted', style: 'white-space:nowrap' }, when(e.t)),
        el('td', {}, `${ico} ${label}`),
        el('td', {}, e.by || e.user || '–'),
        el('td', { class: 'tiny muted' }, details)));
    }
  } catch (ex) { toast(ex.message, true); }
}

/* ---------------- Einstellungen ---------------- */

async function loadSettings() {
  try {
    const d = await api('/settings');
    const f = $('#settings-form');
    f.defaultGroup.innerHTML = '';
    for (const g of d.groups) f.defaultGroup.append(el('option', { value: g.id }, g.name));
    f.defaultGroup.value = d.settings.defaultGroup;
    f.invitesEnabled.checked = !!d.settings.invitesEnabled;
    f.maintenance.checked = !!d.settings.maintenance;
    f.maxRoomsPerUser.value = d.settings.maxRoomsPerUser;
    f.motd.value = d.settings.motd || '';
  } catch (e) { toast(e.message, true); }
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.maintenance.checked && !(A.ov && A.ov.settings.maintenance) && !(await confirmBox('Wartungsmodus einschalten?', 'Alle Nicht-Admins werden sofort getrennt und können sich erst wieder anmelden, wenn du ihn ausschaltest.', 'Einschalten', true))) return;
  try {
    const r = await api('/settings', { method: 'PATCH', body: { defaultGroup: f.defaultGroup.value, invitesEnabled: f.invitesEnabled.checked, maintenance: f.maintenance.checked, maxRoomsPerUser: Number(f.maxRoomsPerUser.value), motd: f.motd.value } });
    A.defaultGroup = r.settings.defaultGroup;
    if (A.ov) A.ov.settings = r.settings;
    $('#maint-flag').hidden = !r.settings.maintenance;
    toast('Gespeichert');
  } catch (ex) { toast(ex.message, true); }
});

init();

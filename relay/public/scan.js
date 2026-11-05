'use strict';
/*
 * Scan-Seite: Kamera (BarcodeDetector, Fallback zxing) oder manuelle Eingabe
 * → /api/scan → Ergebnis-Karte mit Bibliotheks-Vergleich.
 */
const $ = (s) => document.querySelector(s);
const el = (tag, attrs, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'href') n.href = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid && kid.nodeType ? kid : document.createTextNode(kid ?? ''));
  return n;
};

const FMT_NAME = { dvd: 'DVD', bluray: 'Blu-ray', uhd: '4K-UHD' };
let currentCode = '';

async function api(path, opts) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || `Fehler ${r.status}`);
  return d;
}

/* ---------- Kamera ---------- */

let stream = null, det = null, zxing = null, zxTimer = null, scanning = false;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Script geladen fehlgeschlagen'));
    document.head.append(s);
  });
}

async function startCam() {
  const wrap = $('#cam-wrap');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
  } catch (e) {
    $('#cam-note').textContent = 'Kamera nicht verfügbar – bitte Barcode eintippen.';
    return;
  }
  const v = $('#cam');
  v.srcObject = stream;
  await v.play();
  wrap.hidden = false;
  $('#btn-cam').textContent = '⏹ Kamera aus';
  if (!det && 'BarcodeDetector' in window) {
    try { det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] }); } catch { det = null; }
  }
  if (!det && !zxing) {
    try {
      await loadScript('/vendor/zxing.min.js');
      zxing = new ZXing.BrowserMultiFormatReader();
    } catch { zxing = null; }
  }
  scanning = true;
  loop();
  if (!det && !zxing) $('#cam-note').textContent = 'Dieser Browser kann keinen Barcode dekodieren – bitte eintippen.';
}

function stopCam() {
  scanning = false;
  if (zxTimer) { clearTimeout(zxTimer); zxTimer = null; }
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  $('#cam-wrap').hidden = true;
  $('#btn-cam').textContent = '📷 Barcode mit der Kamera scannen';
}

let lastTick = 0;
async function loop() {
  if (!scanning) return;
  const v = $('#cam');
  if (det && v.videoWidth && performance.now() - lastTick > 250) {
    lastTick = performance.now();
    try {
      const codes = await det.detect(v);
      if (codes.length) { onCode(codes[0].rawValue); return; }
    } catch { /* Frame verwerfen */ }
  } else if (zxing && v.videoWidth) {
    try {
      const res = await zxing.decodeFromVideoElement(v);
      if (res && res.getText()) { onCode(res.getText()); return; }
    } catch { /* kein Code im Frame */ }
  }
  zxTimer = setTimeout(loop, 150);
}

function onCode(raw) {
  stopCam();
  $('#code').value = String(raw).trim();
  doScan();
}

/* ---------- Ergebnis ---------- */

const VERDICTS = {
  own: { icon: '✅', cls: 'ok', title: 'Haben wir!' },
  own_other_format: { icon: '🔄', cls: 'warn', title: 'Haben wir – aber anderes Format' },
  own_incomplete: { icon: '🧩', cls: 'warn', title: 'Serie vorhanden, aber mit Lücken' },
  missing: { icon: '❌', cls: 'bad', title: 'Nicht in unserer Bibliothek' },
  unknown: { icon: '🤷', cls: 'warn', title: 'Barcode nicht bekannt' },
};
const FMT_LABEL = { own: 'ok', own_other_format: 'warn', own_incomplete: 'warn', missing: 'bad', unknown: 'warn' };

function fmtList(arr) { return arr.map((f) => FMT_NAME[f] || f).join(', '); }

function productCard(p) {
  const bits = [p.year ? String(p.year) : '', p.kind === 'series' ? 'Serie/Box' : 'Film', p.formats.map((f) => FMT_NAME[f]).join('+'), p.seasons.length ? `Staffel ${p.seasons.join(', ')}` : '', `Quelle: ${p.source}`].filter(Boolean);
  return el('div', { class: 'prod' },
    el('div', { class: 'prod-title' }, p.title),
    el('div', { class: 'muted tiny' }, bits.join(' · ')));
}

function render(d) {
  const box = $('#result');
  box.hidden = false;
  box.replaceChildren();
  const v = VERDICTS[d.verdict] || VERDICTS.unknown;
  const card = el('div', { class: `card ${v.cls}` });
  card.append(el('div', { class: 'verdict' }, `${v.icon} ${v.title}`));
  if (d.product) card.append(productCard(d.product));

  if (d.match) {
    const m = d.match;
    const line = [m.name, m.year ? `(${m.year})` : ''].filter(Boolean).join(' ');
    card.append(el('div', { class: 'match' }, `In der Bibliothek: ${line}`));
    if (d.have && d.have.length) card.append(el('div', { class: 'tiny muted' }, `Bei uns als: ${fmtList(d.have)}`));
    if (d.verdict === 'own_other_format' && d.product) {
      card.append(el('div', { class: 'tiny' }, `Gescannt als: ${fmtList(d.product.formats) || 'Unbekannt'} – das wäre ein Upgrade.`));
    }
    if (d.verdict === 'own_incomplete') {
      card.append(el('div', { class: 'tiny' }, `Uns fehlen: Staffel ${d.gaps.join(', ')}`));
    }
    card.append(el('a', { class: 'btn small primary', href: `/?open=${m.id}` }, '▶ In der Bibliothek öffnen'));
  }

  if (d.verdict === 'missing' || d.verdict === 'unknown') {
    if (d.candidates && d.candidates.length) {
      card.append(el('div', { class: 'tiny muted' }, 'Meintest du vielleicht eines davon?'));
      const row = el('div', { class: 'cands' });
      for (const c of d.candidates) {
        row.append(el('button', {
          class: 'btn small',
          onclick: async () => {
            try { render(await api(`/api/scan?code=${d.code}&bind=${c.id}`)); } catch (e) { card.append(el('p', { class: 'error' }, e.message)); }
          },
        }, `${c.name}${c.year ? ` (${c.year})` : ''}`));
      }
      card.append(row);
    }
    if (d.product) {
      const clean = d.product.title.replace(/\[.*?\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
      const wish = el('button', {
        class: 'btn small',
        onclick: async () => {
          try {
            await api('/api/wishes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: clean.slice(0, 120), year: d.product.year, type: d.product.kind === 'series' ? 'series' : 'movie' }) });
            wish.textContent = '📌 Wunsch eingetragen';
            wish.disabled = true;
          } catch (e) { wish.textContent = e.message; }
        },
      }, '📌 Auf die Wunschliste');
      card.append(wish);
    }
    if (!d.product && !d.lookupConfigured) {
      card.append(el('p', { class: 'tiny muted' }, 'Auf diesem Server ist keine Produktquelle konfiguriert. Such den Titel trotzdem in der Bibliothek:'));
    }
    if (!d.product) {
      card.append(el('a', { class: 'btn small', href: '/?q=' + encodeURIComponent($('#code').value) }, '🔍 In Bibliothek suchen'));
    }
  }

  card.append(el('button', { class: 'link', onclick: () => { $('#result').hidden = true; $('#code').value = ''; } }, 'Neuer Scan'));
  box.append(card);
  box.scrollIntoView({ block: 'nearest' });
}

async function doScan() {
  const code = $('#code').value.trim();
  if (!code) return;
  currentCode = code;
  const box = $('#result');
  box.hidden = false;
  box.replaceChildren(el('p', { class: 'muted' }, 'Suche Produkt und Bibliothek ab …'));
  try {
    const d = await api('/api/scan?code=' + encodeURIComponent(code));
    render(d);
  } catch (e) {
    box.replaceChildren(el('p', { class: 'error' }, e.message));
  }
}

/* ---------- Boot ---------- */

$('#btn-cam').addEventListener('click', () => { stream ? stopCam() : startCam(); });
$('#btn-go').addEventListener('click', doScan);
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doScan(); });

api('/api/me').then((d) => {
  $('#who').textContent = d.username || '';
}).catch(() => { $('#login-hint').hidden = false; });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

'use strict';
/**
 * Anmelden per QR-Code.
 *  - Gerät ohne Konto (Fernseher, Fire-TV-App, Browser): zeigt im Login einen QR-Code + Code
 *    und fragt alle 2 s nach, ob ein Handy ihn bestätigt hat (auf Fernsehern automatisch).
 *  - Angemeldetes Handy: „📷 Gerät anmelden“ in der Lobby scannt den Code (Kamera) oder nimmt
 *    ihn eingetippt; /pair/CODE zeigt eine Bestätigung mit Gerät und Code.
 * Serverseite: relay/lib/pair.js
 */
(function pairing() {
  const q = (s) => document.querySelector(s);
  const isTv = () => document.documentElement.classList.contains('tv');
  const fmtCode = (c) => `${c.slice(0, 4)} ${c.slice(4)}`;

  /* ================= Gerät ohne Konto: QR anzeigen ================= */

  let pollTimer = null;
  let token = null;
  let starting = false;
  let restarts = 0;

  const boxVisible = () => !q('#view-login').hidden && !q('#pair-box').hidden;

  function renderQr(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    q('#pair-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: 'QR-Code zum Anmelden' });
  }

  function stopPair() { clearInterval(pollTimer); pollTimer = null; }

  async function startPair() {
    stopPair();
    if (starting) return;
    starting = true;
    q('#pair-status').textContent = 'Code wird erstellt …';
    try {
      const r = await api('/api/pair/start', { method: 'POST' });
      token = r.token;
      renderQr(location.origin + r.path);
      q('#pair-code-show').textContent = fmtCode(r.code);
      q('#pair-status').textContent = `Gilt ${Math.round(r.expiresIn / 60)} Minuten · danach kommt ein neuer`;
      pollTimer = setInterval(checkPair, 2000);
    } catch (e) {
      q('#pair-status').textContent = `${e.message} – neuer Versuch gleich`;
      setTimeout(() => { if (boxVisible()) startPair(); }, 15000);
    } finally { starting = false; }
  }

  async function checkPair() {
    if (!boxVisible()) { stopPair(); return; }
    let r;
    try { r = await api('/api/pair/poll', { method: 'POST', body: { token } }); } catch { return; }
    if (r.state === 'ok') {
      stopPair();
      S.me = r.me;
      try { localStorage.setItem('wp_name', S.me.username); } catch { /* egal */ }
      q('#pair-box').hidden = !isTv();
      toast(`Angemeldet als ${S.me.name} 👋`);
      route();
    } else if (r.state === 'denied') {
      stopPair();
      q('#pair-status').textContent = 'Am Handy abgelehnt. Neuer Code kommt …';
      setTimeout(() => { if (boxVisible()) startPair(); }, 3000);
    } else if (r.state === 'expired') {
      stopPair();
      if (restarts++ < 30) startPair();
      else q('#pair-status').textContent = 'Abgelaufen. Seite neu laden für einen neuen Code.';
    }
  }

  /** Von app.js, wenn der Login gezeigt wird. Fernseher: QR sofort, sonst nur auf Knopfdruck. */
  function loginShown() {
    restarts = 0;
    if (isTv()) q('#pair-box').hidden = false;
    if (!q('#pair-box').hidden) startPair();
  }

  q('#btn-pair-qr').addEventListener('click', () => {
    const box = q('#pair-box');
    box.hidden = !box.hidden;
    restarts = 0;
    if (box.hidden) stopPair(); else startPair();
  });

  /* ================= Handy: scannen oder Code eintippen ================= */

  let stream = null;
  let scanTimer = null;
  let detector = null;
  let busy = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  function setScanStatus(t) { q('#scan-status').textContent = t; }

  async function openScanner() {
    q('#scan-modal').hidden = false;
    q('#scan-form').code.value = '';
    const view = q('#scan-view');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      view.hidden = true;
      setScanStatus('Kamera geht hier nicht. Tipp den Code ein, oder scanne den QR-Code mit der Kamera-App.');
      return;
    }
    view.hidden = false;
    setScanStatus('Kamera wird gestartet …');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (q('#scan-modal').hidden) { stopCamera(); return; }
      const v = q('#scan-video');
      v.srcObject = stream;
      await v.play().catch(() => {});
      if (!detector && 'BarcodeDetector' in window) {
        try {
          const formats = await window.BarcodeDetector.getSupportedFormats();
          if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch { /* nicht unterstützt */ }
      }
      if (!detector) await loadJsQr();
      setScanStatus('Halte den QR-Code in den Rahmen …');
      scanTimer = setInterval(scanFrame, 200);
    } catch (e) {
      stopCamera();
      view.hidden = true;
      setScanStatus(e && e.name === 'NotAllowedError'
        ? 'Kein Zugriff auf die Kamera. Erlaube ihn in den Einstellungen oder tipp den Code ein.'
        : 'Keine Kamera gefunden. Tipp den Code ein.');
    }
  }

  function loadJsQr() {
    if (window.jsQR) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/jsqr.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Scanner konnte nicht geladen werden'));
      document.head.append(s);
    });
  }

  async function scanFrame() {
    const v = q('#scan-video');
    if (busy || !stream || v.readyState < 2 || !v.videoWidth) return;
    busy = true;
    try {
      let text = null;
      if (detector) {
        const found = await detector.detect(v);
        if (found.length) text = found[0].rawValue;
      } else {
        const w = Math.min(720, v.videoWidth);
        const h = Math.round((v.videoHeight * w) / v.videoWidth);
        canvas.width = w; canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const c = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (c) text = c.data;
      }
      if (text) handleScan(text);
    } catch { /* nächster Versuch */ } finally { busy = false; }
  }

  function handleScan(text) {
    let url;
    try { url = new URL(text, location.origin); } catch { return; }
    const m = url.pathname.match(/^\/pair\/([A-Za-z0-9-]{4,20})/);
    if (!m) { setScanStatus('Das ist kein Watchparty-Anmeldecode.'); return; }
    if (url.host !== location.host) { setScanStatus(`Der Code gehört zu ${url.host}, nicht zu diesem Server.`); return; }
    if (navigator.vibrate) navigator.vibrate(60);
    closeScanner();
    goConfirm(m[1]);
  }

  function stopCamera() {
    clearInterval(scanTimer); scanTimer = null;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    const v = q('#scan-video');
    if (v) v.srcObject = null;
  }

  function closeScanner() { stopCamera(); q('#scan-modal').hidden = true; }

  q('#btn-pair-scan').addEventListener('click', openScanner);
  q('#scan-close').addEventListener('click', closeScanner);
  q('#scan-modal').addEventListener('click', (e) => { if (e.target.id === 'scan-modal') closeScanner(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !q('#scan-modal').hidden) { e.stopPropagation(); closeScanner(); } }, true);
  q('#scan-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = e.target.code.value;
    const m = String(raw).match(/\/pair\/([A-Za-z0-9-]+)/);
    const code = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 6) { setScanStatus('Der Code hat 8 Zeichen, z. B. ABCD 2345.'); return; }
    closeScanner();
    goConfirm(code);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) closeScanner(); });

  /* ================= Handy: Bestätigen ================= */

  let current = null;

  function goConfirm(code) {
    history.pushState(null, '', `/pair/${code}`);
    confirm(code);
  }

  function leave() { history.replaceState(null, '', '/'); route(); }

  async function confirm(code) {
    current = code;
    const err = q('#pair-error');
    err.hidden = true;
    try {
      const r = await api(`/api/pair/${encodeURIComponent(code)}`);
      current = r.code;
      q('#pair-device').textContent = r.device;
      q('#pair-age').textContent = r.ageSec < 90 ? `(vor ${r.ageSec} s)` : `(vor ${Math.round(r.ageSec / 60)} min)`;
      q('#pair-code-confirm').textContent = fmtCode(r.code);
      q('#pair-as').textContent = r.as;
      q('#pair-net').hidden = !!r.sameNetwork;
      const done = r.state !== 'pending';
      q('#btn-pair-ok').disabled = done;
      if (done) {
        err.textContent = { expired: 'Der Code ist abgelaufen. Am Fernseher steht schon ein neuer.', approved: 'Dieser Code wurde schon bestätigt.', denied: 'Dieser Code wurde abgelehnt.' }[r.state] || 'Code nicht mehr gültig.';
        err.hidden = false;
      }
      showView('view-pair');
    } catch (e) {
      toast(e.message);
      leave();
    }
  }

  q('#btn-pair-ok').addEventListener('click', async () => {
    const err = q('#pair-error');
    try {
      await api(`/api/pair/${encodeURIComponent(current)}`, { method: 'POST', body: { approve: true } });
      toast('✓ Gerät angemeldet. Dort geht es in ein paar Sekunden los.');
      leave();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  q('#btn-pair-no').addEventListener('click', async () => {
    try { await api(`/api/pair/${encodeURIComponent(current)}`, { method: 'POST', body: { approve: false } }); } catch { /* egal */ }
    leave();
  });

  window.WPPair = { loginShown, confirm, openScanner };
})();

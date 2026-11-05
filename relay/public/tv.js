'use strict';
/**
 * TV-Modus: Bedienung mit der Fernbedienung (Fire TV / Android TV).
 * Läuft nur in der Watchparty-TV-App (User-Agent enthält „WatchpartyTV“), im Browser passiert nichts.
 *
 * - Pfeiltasten springen zum nächsten Knopf/Feld in der Richtung (räumliche Navigation)
 * - Im Raum ohne Fokus: ←/→ spulen, OK = Play/Pause, ↑ Leiste oben, ↓ Steuerleiste
 * - Zurück-Taste (von der App): schließt Fenster/Menüs Schritt für Schritt
 * - Menü-Taste: Chat ein/aus, Medientasten: Play/Pause und Spulen
 */
(function tvMode() {
  const isTv = /WatchpartyTV/.test(navigator.userAgent) || new URLSearchParams(location.search).has('tv');
  if (!isTv) return;
  const native = window.WatchpartyTV || null; // Brücke aus der App (fehlt beim Testen im Browser mit ?tv)

  document.documentElement.classList.add('tv');
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/tv.css' }));
  document.body.classList.add('chat-hidden');

  const q = (s, r = document) => r.querySelector(s);
  const FOCUSABLE = 'a[href], button, input:not([type=hidden]):not([type=range]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const room = q('#view-room');
  const playerEl = q('#player');
  const vid = q('#video');

  /* ---------------- Sichtbarkeit & Bereich ---------------- */

  function visible(el) {
    if (!el || el.disabled || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  const shown = (sel) => { const e = q(sel); return !!e && !e.hidden; };

  /** Der Bereich, in dem gerade navigiert wird: oberstes offenes Fenster, sonst die aktuelle Ansicht. */
  function scope() {
    if (shown('#xmodal')) return q('#xmodal');
    if (shown('#library')) return q('#library');
    if (!room.hidden && shown('#settings-menu')) return q('#settings-menu');
    return [...document.querySelectorAll('.view')].find((v) => !v.hidden) || document.body;
  }
  const candidates = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(visible);
  const inRoomPlayer = () => !room.hidden && scope() === room;

  /** Spieler-Modus: im Raum, und der Fokus steht auf keinem Bedienelement. */
  function playerMode() {
    if (!inRoomPlayer()) return false;
    const a = document.activeElement;
    return !a || a === document.body || a === vid || a === playerEl || !room.contains(a) || !visible(a);
  }

  /* ---------------- Räumliche Navigation ---------------- */

  function move(dir) {
    const root = scope();
    const list = candidates(root);
    if (!list.length) return false;
    const cur = document.activeElement;
    if (!cur || cur === document.body || !root.contains(cur) || !visible(cur)) {
      focusEl(list.find((e) => e.matches('.btn.primary')) || list[0]);
      return true;
    }
    const a = cur.getBoundingClientRect();
    const acx = a.left + a.width / 2;
    const acy = a.top + a.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === cur || el.contains(cur) || cur.contains(el)) continue;
      const b = el.getBoundingClientRect();
      const bcx = b.left + b.width / 2;
      const bcy = b.top + b.height / 2;
      let main; let cross;
      if (dir === 'right') { main = b.left - a.right; if (bcx <= acx + 1) continue; cross = overlap(a.top, a.bottom, b.top, b.bottom) ? 0 : Math.abs(bcy - acy); }
      else if (dir === 'left') { main = a.left - b.right; if (bcx >= acx - 1) continue; cross = overlap(a.top, a.bottom, b.top, b.bottom) ? 0 : Math.abs(bcy - acy); }
      else if (dir === 'down') { main = b.top - a.bottom; if (bcy <= acy + 1) continue; cross = overlap(a.left, a.right, b.left, b.right) ? 0 : Math.abs(bcx - acx); }
      else { main = a.top - b.bottom; if (bcy >= acy - 1) continue; cross = overlap(a.left, a.right, b.left, b.right) ? 0 : Math.abs(bcx - acx); }
      const score = Math.max(0, main) + cross * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { focusEl(best); return true; }
    return false;
  }
  const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1) > 2;

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    const r = el.getBoundingClientRect();
    const out = r.top < 60 || r.bottom > innerHeight - 40 || r.left < 0 || r.right > innerWidth;
    if (out) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    if (room.contains(el) && typeof wake === 'function') wake();
  }

  /* ---------------- Vollbild im Raum ---------------- */
  // Echtes requestFullscreen braucht in der WebView eine Geste; deshalb „Vollbild“ per CSS.
  function setFs(on) {
    document.body.classList.toggle('tv-fs', on);
    playerEl.classList.toggle('fs', on);
  }
  q('#btn-fs').addEventListener('click', (e) => { e.stopImmediatePropagation(); setFs(!document.body.classList.contains('tv-fs')); }, true);
  vid.addEventListener('playing', () => { setFs(true); if (native) native.keepAwake(true); });
  vid.addEventListener('pause', () => { if (native) native.keepAwake(false); });
  vid.addEventListener('emptied', () => { if (native) native.keepAwake(false); });

  /* ---------------- Tasten ---------------- */

  const PLAYER_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, Enter: 1 };

  function playerKey(key) {
    switch (key) {
      case 'ArrowLeft': seekBy(-10); break;
      case 'ArrowRight': seekBy(10); break;
      case 'Enter': togglePlay(); break;
      case 'ArrowDown': focusEl(q('#btn-play')); break;
      case 'ArrowUp':
        if (document.body.classList.contains('tv-fs')) focusEl(q('#btn-play'));
        else focusEl(q('#btn-library'));
        break;
      default: return false;
    }
    if (typeof wake === 'function') wake();
    return true;
  }

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    // Medientasten (kommen auch direkt von der App, siehe wpTv.media)
    if (k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'MediaPause') { e.preventDefault(); e.stopImmediatePropagation(); media('playpause'); return; }
    if (k === 'MediaFastForward') { e.preventDefault(); e.stopImmediatePropagation(); media('ff'); return; }
    if (k === 'MediaRewind') { e.preventDefault(); e.stopImmediatePropagation(); media('rew'); return; }
    if (!PLAYER_KEYS[k]) return;

    if (playerMode() && !(e.target.closest && e.target.closest('input, textarea, select'))) {
      if (playerKey(k)) { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    if (k === 'Enter') return; // OK auf Knopf/Feld: normal auslösen
    const t = e.target;
    const tag = (t.tagName || '').toLowerCase();
    // In Textfeldern bewegen ←/→ den Cursor, solange er nicht am Rand steht
    if ((tag === 'input' || tag === 'textarea') && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      try {
        const len = (t.value || '').length;
        if (k === 'ArrowLeft' && t.selectionStart > 0) return;
        if (k === 'ArrowRight' && t.selectionEnd < len) return;
      } catch { /* type=email o. Ä. ohne selection */ }
    }
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k];
    e.preventDefault();
    e.stopImmediatePropagation();
    if (move(dir)) return;
    if (inRoomPlayer() && (dir === 'up' || dir === 'down')) {
      // Am Rand der Steuerleiste: zurück ins Bild
      document.activeElement.blur();
      return;
    }
    // Nichts mehr in der Richtung: Text weiterscrollen (z. B. lange Beschreibung)
    const box = scroller(document.activeElement) || scroller(scope().firstElementChild);
    if (box) box.scrollBy({ top: dir === 'down' ? 220 : dir === 'up' ? -220 : 0, behavior: 'smooth' });
  }, true);

  function scroller(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
    }
    return document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight + 4 ? document.scrollingElement : null;
  }

  function media(what) {
    if (room.hidden) return;
    if (what === 'playpause') togglePlay();
    else if (what === 'ff') seekBy(30);
    else if (what === 'rew') seekBy(-30);
    if (typeof wake === 'function') wake();
  }

  /* ---------------- Zurück-Taste ---------------- */

  let leaveArmedAt = 0;
  /** Gibt true zurück, wenn die Seite die Taste verarbeitet hat. Sonst entscheidet die App (zweimal = beenden). */
  function back() {
    // Fenster schließen wie mit Escape (extras.js und die Bibliothek hören darauf)
    if (shown('#xmodal') || shown('#library')) {
      const which = shown('#xmodal') ? '#xmodal' : '#library';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (shown(which)) { if (which === '#library') closeLibrary(); else q(which).hidden = true; }
      restoreFocus();
      return true;
    }
    if (!room.hidden && shown('#settings-menu')) { q('#settings-menu').hidden = true; focusEl(q('#btn-settings')); return true; }
    if (shown('#pw-form')) { q('#pw-form').hidden = true; return true; }
    if (!room.hidden) {
      const a = document.activeElement;
      if (a && a !== document.body && room.contains(a)) { a.blur(); return true; }
      if (document.body.classList.contains('tv-fs')) { setFs(false); return true; }
      if (Date.now() - leaveArmedAt < 2500) { leaveArmedAt = 0; q('#btn-leave').click(); return true; }
      leaveArmedAt = Date.now();
      toast('Nochmal Zurück drücken, um den Raum zu verlassen');
      return true;
    }
    return false;
  }

  function restoreFocus() {
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && visible(a)) return;
      if (!room.hidden) return; // im Raum: zurück ins Bild
      move('down');
    }, 30);
  }

  /* ---------------- Fokus beim Wechsel von Ansichten/Fenstern ---------------- */

  function autofocus() {
    const root = scope();
    if (root === room) {
      if (!playerMode()) return; // da navigiert gerade jemand
      if (shown('#overlay-empty')) focusEl(q('#btn-library-empty'));
      else if (shown('#overlay-blocked')) focusEl(q('#btn-unblock'));
      return;
    }
    const a = document.activeElement;
    if (a && a !== document.body && root.contains(a) && visible(a)) return;
    const list = candidates(root);
    // Formulare: erstes leeres Feld; sonst Hauptknopf
    const field = list.find((e) => (e.tagName === 'INPUT' && !e.value && e.type !== 'search'));
    focusEl(field || list.find((e) => e.matches('.btn.primary')) || list[0]);
  }
  let afTimer = null;
  new MutationObserver(() => { clearTimeout(afTimer); afTimer = setTimeout(autofocus, 120); })
    .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  setTimeout(autofocus, 300);

  /* ---------------- App-spezifisches ---------------- */

  if (native && native.changeServer) {
    const links = q('#view-lobby .row-links');
    if (links) {
      const b = Object.assign(document.createElement('button'), { className: 'link', type: 'button', textContent: 'Server ändern (TV-App)' });
      b.addEventListener('click', () => native.changeServer());
      links.append(b);
    }
  }

  /** Menü-Taste der Fernbedienung: im Raum Chat ein/aus. */
  function menu() {
    if (room.hidden || scope() !== room) return;
    if (document.body.classList.contains('chat-hidden')) {
      setFs(false);
      document.body.classList.remove('chat-hidden');
      focusEl(q('#chat-input'));
    } else {
      document.body.classList.add('chat-hidden');
      if (room.contains(document.activeElement)) document.activeElement.blur();
    }
  }

  window.wpTv = { back, media, menu, move };
})();

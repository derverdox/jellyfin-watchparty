'use strict';
/**
 * YouTube & Twitch zusammen schauen (nur Web/Android-App).
 *
 * Jeder schaut über den eingebetteten Player direkt von YouTube/Twitch, mit dem eigenen Konto
 * (wer dort Premium/Turbo hat und eingeloggt ist, sieht keine Werbung). Gesteuert wird über
 * unsere eigene Leiste: Pause/Spulen gehen an den Raum, der Player folgt dem Raum.
 *
 * - YouTube und Twitch-Videos (VODs): sekundengenau wie bei euren Filmen
 * - Twitch live: Jeder meldet, wie weit er hinter dem Live-Bild ist; wer schneller ist,
 *   hält kurz an, bis er beim Langsamsten ist (genauer als ~1 s wird das nicht)
 *
 * Nutzt aus app.js: S, video, player, el, toast, expectedPos, send, canControl.
 */
(function extPlayer() {
  const q = (s) => document.querySelector(s);
  let cur = null; // { item, a (Adapter), ready, lastSeek, align, failed, volKey, startedAt }
  let timer = null;

  /* ---------------- Skripte der Anbieter ---------------- */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Der Player von YouTube/Twitch ließ sich nicht laden (Internet oder Werbeblocker?).'));
      document.head.append(s);
    });
  }
  let ytPromise = null;
  function ytReady() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (!ytPromise) {
      ytPromise = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
        loadScript('https://www.youtube.com/iframe_api').catch((e) => { ytPromise = null; reject(e); });
      });
    }
    return ytPromise;
  }
  let twPromise = null;
  function twReady() {
    if (window.Twitch && window.Twitch.Player) return Promise.resolve();
    if (!twPromise) twPromise = loadScript('https://player.twitch.tv/js/embed/v1.js').catch((e) => { twPromise = null; throw e; });
    return twPromise;
  }

  /* ---------------- Adapter: einheitliche Steuerung ---------------- */

  function youtube(host, ext, onReady) {
    const p = new window.YT.Player(host, {
      videoId: ext.id,
      host: 'https://www.youtube.com',
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, rel: 0, playsinline: 1, modestbranding: 1, fs: 0, iv_load_policy: 3, start: Math.floor(expectedPos()), origin: location.origin },
      events: {
        onReady,
        onError: (e) => toast(e.data === 101 || e.data === 150 ? 'Dieses Video darf nicht eingebettet werden. Schick lieber einen anderen Link.' : 'YouTube meldet einen Fehler beim Abspielen.'),
      },
    });
    return {
      live: false,
      time: () => (p.getCurrentTime ? p.getCurrentTime() || 0 : 0),
      duration: () => (p.getDuration ? p.getDuration() || 0 : 0),
      // 1 = läuft, 3 = puffert → beides zählt als „spielt“
      paused: () => { const st = p.getPlayerState ? p.getPlayerState() : -1; return st !== 1 && st !== 3; },
      buffering: () => (p.getPlayerState ? p.getPlayerState() === 3 : false),
      play: () => p.playVideo && p.playVideo(),
      pause: () => p.pauseVideo && p.pauseVideo(),
      seek: (t) => p.seekTo && p.seekTo(t, true),
      volume: (v, muted) => { if (!p.setVolume) return; p.setVolume(Math.round(v * 100)); if (muted) p.mute(); else p.unMute(); },
      latency: () => null,
      destroy: () => { try { p.destroy(); } catch { /* egal */ } },
    };
  }

  function twitch(host, ext, onReady) {
    const opts = { width: '100%', height: '100%', parent: [location.hostname], autoplay: true, muted: false, controls: false };
    if (ext.live) opts.channel = ext.channel; else opts.video = `v${ext.video}`;
    if (!ext.live && expectedPos() > 1) opts.time = `${Math.floor(expectedPos())}s`;
    const p = new window.Twitch.Player(host, opts);
    p.addEventListener(window.Twitch.Player.READY, onReady);
    return {
      live: !!ext.live,
      time: () => { try { return p.getCurrentTime() || 0; } catch { return 0; } },
      duration: () => { try { return ext.live ? 0 : p.getDuration() || 0; } catch { return 0; } },
      paused: () => { try { return p.isPaused(); } catch { return true; } },
      buffering: () => false,
      play: () => { try { p.play(); } catch { /* egal */ } },
      pause: () => { try { p.pause(); } catch { /* egal */ } },
      seek: (t) => { try { p.seek(t); } catch { /* egal */ } },
      volume: (v, muted) => { try { p.setVolume(v); p.setMuted(!!muted); } catch { /* egal */ } },
      // Sekunden hinter dem Live-Bild (vom Twitch-Player gemessen)
      latency: () => { try { const s = p.getPlaybackStats(); const l = Number(s && (s.hlsLatencyBroadcaster ?? s.hlsLatencyEncoder)); return Number.isFinite(l) ? l : null; } catch { return null; } },
      destroy: () => { try { host.replaceChildren(); } catch { /* egal */ } },
    };
  }

  /** Twitch-Clips: nur eingebettet, ohne Steuerung (sind ohnehin kurz). */
  function clip(host, ext) {
    host.replaceChildren(Object.assign(document.createElement('iframe'), {
      src: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(ext.clip)}&parent=${encodeURIComponent(location.hostname)}&autoplay=true`,
      allow: 'autoplay; fullscreen', allowFullscreen: true,
    }));
    return { live: false, time: () => 0, duration: () => 0, paused: () => false, buffering: () => false, play() {}, pause() {}, seek() {}, volume() {}, latency: () => null, destroy() {} };
  }

  /* ---------------- Laden / Entladen ---------------- */

  function ensureBox() {
    let box = q('#ext-player');
    if (!box) {
      box = el('div', { class: 'ext-player', id: 'ext-player' },
        el('div', { class: 'ext-frame', id: 'ext-frame' }),
        // Fängt Mausbewegung/Klicks ab (sonst blendet die Leiste aus und Klicks landen im fremden Player)
        el('div', { class: 'ext-shield', id: 'ext-shield', onclick: () => { if (player.classList.contains('idle')) return; if (canControl()) togglePlay(); }, ondblclick: () => toggleFs() }),
        el('button', { class: 'btn primary ext-start', id: 'ext-start', hidden: true, onclick: () => { if (cur) { cur.a.play(); cur.blocked = false; q('#ext-start').hidden = true; } } }, '▶ Klick zum Starten'),
        el('button', { class: 'btn small ext-interact', id: 'ext-interact', title: 'Direkt im YouTube/Twitch-Player klicken (z. B. für Altersfreigabe oder Anmeldung)', onclick: () => { const on = player.classList.toggle('ext-free'); q('#ext-interact').textContent = on ? '✓ Fertig' : '🖱 Player bedienen'; } }, '🖱 Player bedienen'));
      player.insertBefore(box, video.nextSibling);
      box.querySelector('#ext-shield').addEventListener('mousemove', () => player.dispatchEvent(new Event('mousemove')));
    }
    return box;
  }

  async function load(item) {
    unload();
    const ext = item.ext;
    const box = ensureBox();
    player.classList.add('ext');
    player.classList.toggle('ext-live', !!ext.live);
    const host = el('div', { class: 'ext-host' });
    box.querySelector('#ext-frame').replaceChildren(host);
    const me = { item, a: null, ready: false, lastSeek: 0, align: null, failed: false, volKey: '', startedAt: Date.now(), blocked: false };
    cur = me;
    q('#overlay-loading').hidden = false;
    const onReady = () => { if (cur !== me) return; me.ready = true; q('#overlay-loading').hidden = true; sync(true); };
    try {
      if (ext.kind === 'youtube') { await ytReady(); if (cur !== me) return; me.a = youtube(host, ext, onReady); }
      else if (ext.clip) { me.a = clip(host, ext); onReady(); }
      else { await twReady(); if (cur !== me) return; me.a = twitch(host, ext, onReady); }
    } catch (e) {
      q('#overlay-loading').hidden = true;
      toast(e.message);
      return;
    }
    clearInterval(timer);
    // Eingebettete Player melden keine Zeit-Events → Leiste selbst regelmäßig aktualisieren
    timer = setInterval(() => { sync(false); if (typeof updateControls === 'function') updateControls(); }, 500);
  }

  function unload() {
    clearInterval(timer);
    timer = null;
    if (cur && cur.a) cur.a.destroy();
    cur = null;
    const box = q('#ext-player');
    if (box) box.querySelector('#ext-frame').replaceChildren();
    player.classList.remove('ext', 'ext-live', 'ext-free');
  }

  /* ---------------- Gleichlauf ---------------- */

  function sync(force) {
    if (!cur || !cur.ready || !cur.a) return;
    const a = cur.a;
    const pb = S.playback;
    if (!pb || !pb.item || pb.item.id !== cur.item.id) return;
    // Lautstärke kommt von unserer Leiste (die steuert das versteckte <video>)
    const vk = `${video.volume}|${video.muted}`;
    if (vk !== cur.volKey) { cur.volKey = vk; a.volume(video.volume, video.muted); }

    if (!pb.playing) {
      if (!a.paused()) a.pause();
      if (!a.live) {
        const exp = expectedPos();
        if (Math.abs(a.time() - exp) > 0.6 && Date.now() - cur.lastSeek > 1500) { a.seek(exp); cur.lastSeek = Date.now(); }
      }
      return;
    }
    if (cur.align) return; // Twitch live: wir halten gerade absichtlich an
    if (a.paused()) {
      a.play();
      // Browser blockiert Ton ohne Klick → Knopf zeigen
      if (Date.now() - cur.startedAt > 4000 && !cur.blocked) { cur.blocked = true; q('#ext-start').hidden = false; }
      return;
    }
    if (cur.blocked) { cur.blocked = false; q('#ext-start').hidden = true; }

    if (a.live) { alignLive(); return; }
    const exp = expectedPos();
    const diff = exp - a.time();
    if ((force || Math.abs(diff) > 1.2) && Date.now() - cur.lastSeek > 2500 && !a.buffering()) {
      a.seek(exp + (diff > 0 ? 0.4 : 0));
      cur.lastSeek = Date.now();
    }
  }

  /** Twitch live: auf den Langsamsten im Raum warten (kurz anhalten). */
  function alignLive() {
    const a = cur.a;
    if (cur.failed || Date.now() < (cur.cooldown || 0)) return;
    const mine = a.latency();
    if (mine == null) return;
    const others = (S.members || []).filter((m) => S.you && m.id !== S.you.id).map((m) => m.status && m.status.lat).filter((x) => Number.isFinite(x));
    if (!others.length) return;
    const target = Math.max(...others);
    const gap = target - mine;
    if (gap < 1.0) return;
    const me = cur;
    me.align = { from: mine, gap };
    a.pause();
    setTimeout(() => {
      if (cur !== me) return;
      a.play();
      me.align = null;
      me.cooldown = Date.now() + 20000;
      // Prüfen, ob Twitch die Pause behalten hat (sonst springt der Player zurück aufs Live-Bild)
      setTimeout(() => {
        if (cur !== me) return;
        const now = a.latency();
        if (now != null && now < me.cooldownFrom + gap * 0.4) {
          me.failed = true;
          toast('Twitch springt nach einer Pause zurück aufs Live-Bild. Angleichen klappt hier leider nicht.');
        }
      }, 6000);
      me.cooldownFrom = mine;
    }, Math.min(gap, 30) * 1000);
  }

  /* ---------------- Für app.js ---------------- */

  function status() {
    if (!cur || !cur.a || !cur.ready) return { t: 'status', pos: 0, state: 'buffering', drift: 0 };
    const a = cur.a;
    const exp = expectedPos();
    const t = a.live ? exp : a.time();
    const state = cur.blocked ? 'blocked' : cur.align ? 'paused' : a.buffering() ? 'buffering' : a.paused() ? 'paused' : 'playing';
    const msg = { t: 'status', pos: t, state, drift: a.live ? 0 : exp - t };
    const lat = a.latency();
    if (lat != null) msg.lat = lat;
    return msg;
  }

  window.WPExt = {
    load, unload, sync, status,
    active: () => !!cur,
    live: () => !!(cur && cur.item.ext && cur.item.ext.live),
    time: () => (cur && cur.a && cur.ready ? (cur.a.live ? expectedPos() : cur.a.time()) : expectedPos()),
    duration: () => (cur && cur.a && cur.ready ? cur.a.duration() : 0),
    latency: () => (cur && cur.a ? cur.a.latency() : null),
  };
})();

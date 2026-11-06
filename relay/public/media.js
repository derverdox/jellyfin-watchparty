'use strict';
/*
 * Twitch & YouTube im Raum (gehört zu app.js, nutzt dessen S, video, $ …).
 *
 * Twitch: Das Relay holt den Kanal einmal und verteilt dieselben Segmente an alle
 *   (/live/twitch/<kanal>/<qualität>.m3u8). Die Raum-Position ist ein Zeitstempel
 *   (Unix-Sekunden aus #EXT-X-PROGRAM-DATE-TIME). Hier wird zwischen diesem
 *   Zeitstempel und der lokalen Videozeit umgerechnet – so hat auch ein
 *   Livestream eine feste, gemeinsame Timeline und der normale Sync greift.
 * YouTube: offizieller Player (IFrame-API), Position = Sekunden im Video.
 */

/* ------------------------------------------------------------------ */
/* Gemeinsame Schnittstelle für app.js                                 */
/* ------------------------------------------------------------------ */

function isLive() { return S.mode === 'twitch'; }

/** Lokale Position in der Zeitachse des Raums (NaN, solange unbekannt). */
function curPos() {
  if (S.mode === 'twitch') return pdtAt(video.currentTime);
  if (S.mode === 'yt') return ytCur();
  return video.currentTime;
}

/** Lokal an eine Raum-Position springen. */
function seekLocal(p) {
  if (S.mode === 'twitch') {
    const ct = ctAt(p);
    if (Number.isFinite(ct)) video.currentTime = ct;
  } else if (S.mode === 'yt') {
    if (S.ytReady) S.yt.seekTo(Math.max(0, p), true);
  } else video.currentTime = p;
}

function mediaDuration() {
  if (S.mode === 'yt') return S.ytReady ? S.yt.getDuration() || NaN : NaN;
  if (S.mode === 'twitch') return NaN;
  return video.duration;
}

/* ------------------------------------------------------------------ */
/* Laden                                                               */
/* ------------------------------------------------------------------ */

async function loadExternal(item) {
  teardownPlayer();
  S.loadedId = item.id;
  $('#overlay-loading').hidden = false;
  try {
    if (item.source === 'twitch') {
      const info = await api(`/api/twitch/${item.channel}`);
      if (S.loadedId !== item.id) return;
      S.mode = 'twitch';
      S.info = { source: 'twitch', id: item.id, ...info };
      const ids = (info.variants || []).map((v) => v.id);
      const pref = S.prefs.twitch;
      S.twVariant = ids.includes(pref) ? pref : (info.defaultId && ids.includes(info.defaultId) ? info.defaultId : ids[0]);
      if (!S.twVariant) throw new Error('Twitch liefert keine Qualitäten');
    } else if (item.source === 'youtube') {
      S.mode = 'yt';
      S.info = { source: 'youtube', id: item.id, videoId: item.videoId };
    } else throw new Error('Unbekannte Quelle');
    fillExternalSettings();
    buildExternal();
  } catch (ex) {
    toast(`Konnte den Stream nicht laden: ${ex.message}`);
    $('#overlay-loading').hidden = true;
  }
}

function fillExternalSettings() {
  const qs = $('#sel-quality');
  qs.innerHTML = '';
  if (S.mode === 'twitch') {
    for (const v of S.info.variants) qs.append(el('option', { value: v.id, selected: v.id === S.twVariant }, v.name));
    qs.disabled = false;
  } else {
    qs.append(el('option', {}, 'Automatisch (YouTube)'));
    qs.disabled = true;
  }
  for (const id of ['#sel-audio', '#sel-subs']) {
    const s = $(id);
    s.innerHTML = '';
    s.append(el('option', {}, '—'));
    s.disabled = true;
  }
}

function buildExternal() {
  if (S.mode === 'twitch') return buildTwitch();
  if (S.mode === 'yt') return buildYouTube();
}

function teardownExternal() {
  if (S.yt) { try { S.yt.destroy(); } catch { /* egal */ } }
  S.yt = null;
  S.ytReady = false;
  S.ytPlayAt = 0;
  S.ytRate = 1;
  const host = $('#yt-host');
  host.hidden = true;
  if (!$('#yt-frame')) host.prepend(el('div', { id: 'yt-frame' }));
  video.hidden = false;
  player.classList.remove('live');
  D.btnLive.hidden = true;
  if (S.mode !== 'video') {
    S.mode = 'video';
    for (const id of ['#sel-quality', '#sel-audio', '#sel-subs']) $(id).disabled = false;
  }
}

function setTwitchVariant(id) {
  if (!S.info || S.mode !== 'twitch' || !S.info.variants.some((v) => v.id === id)) return;
  S.twVariant = id;
  S.prefs.twitch = id;
  savePrefs();
  buildTwitch();
}

/* ------------------------------------------------------------------ */
/* Twitch: HLS vom Relay, Zeitstempel ↔ Videozeit                     */
/* ------------------------------------------------------------------ */

function buildTwitch() {
  const login = S.playback.item.channel;
  const key = `tw|${login}|${S.twVariant}`;
  if (key === S.loadedKey) return;
  S.loadedKey = key;
  destroyHls();
  player.classList.add('live');
  const url = `/live/twitch/${encodeURIComponent(login)}/${encodeURIComponent(S.twVariant)}.m3u8`;
  $('#overlay-loading').hidden = false;
  if (window.Hls && Hls.isSupported()) {
    const retry = { maxNumRetry: 6, retryDelayMs: 500, maxRetryDelayMs: 4000 };
    const hls = new Hls({
      autoStartLoad: false,      // erst laden, wenn klar ist, wo der Raum gerade ist
      liveDurationInfinity: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      maxBufferLength: 20,
      maxMaxBufferLength: 30,
      liveSyncDurationCount: 3,
      fragLoadPolicy: { default: { maxTimeToFirstByteMs: 20000, maxLoadTimeMs: 30000, timeoutRetry: retry, errorRetry: retry } },
      manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 15000, maxLoadTimeMs: 20000, timeoutRetry: retry, errorRetry: retry } },
      playlistLoadPolicy: { default: { maxTimeToFirstByteMs: 15000, maxLoadTimeMs: 20000, timeoutRetry: retry, errorRetry: retry } },
    });
    let started = false;
    hls.on(Hls.Events.LEVEL_LOADED, () => {
      if (started) return;
      started = true;
      const ct = ctAt(expectedPos());
      hls.startLoad(Number.isFinite(ct) ? ct : -1);
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => { if (S.hls === hls) hls.startLoad(); }, 1000);
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else { toast('Twitch-Wiedergabe abgebrochen – versuch eine andere Qualität.'); reportStatus('error'); }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    S.hls = hls;
  } else {
    // Safari/iOS: HLS nativ, Zeitstempel über video.getStartDate()
    video.src = url;
    video.addEventListener('loadedmetadata', () => { try { seekLocal(expectedPos()); } catch { /* egal */ } }, { once: true });
  }
}

function twFrags() {
  const h = S.hls;
  if (!h || !h.levels || !h.levels.length) return null;
  const lv = h.levels[h.currentLevel >= 0 ? h.currentLevel : 0] || h.levels[0];
  const f = lv && lv.details && lv.details.fragments;
  return f && f.length && Number.isFinite(f[0].programDateTime) ? f : null;
}

function nativeStart() {
  if (S.hls || !video.getStartDate) return NaN;
  const t = video.getStartDate().getTime();
  return Number.isFinite(t) && t > 0 ? t / 1000 : NaN;
}

/** Videozeit → Zeitstempel (Sekunden) */
function pdtAt(ct) {
  const f = twFrags();
  if (!f) return nativeStart() + ct;
  let fr = f[0];
  for (const x of f) { if (x.start <= ct + 0.001) fr = x; else break; }
  return fr.programDateTime / 1000 + (ct - fr.start);
}

/** Zeitstempel (Sekunden) → Videozeit */
function ctAt(p) {
  const f = twFrags();
  if (!f) { const s = nativeStart(); return Number.isFinite(s) ? p - s : NaN; }
  const ms = p * 1000;
  let fr = f[0];
  for (const x of f) { if (x.programDateTime <= ms + 1) fr = x; else break; }
  const last = f[f.length - 1];
  const ct = fr.start + (p - fr.programDateTime / 1000);
  return Math.max(f[0].start, Math.min(ct, last.start + last.duration - 0.1));
}

/** DVR-Fenster als Zeitstempel { start, end } */
function liveWindow() {
  const f = twFrags();
  if (f) {
    const last = f[f.length - 1];
    return { start: f[0].programDateTime / 1000, end: last.programDateTime / 1000 + last.duration };
  }
  const s = nativeStart();
  if (Number.isFinite(s) && video.seekable.length) return { start: s + video.seekable.start(0), end: s + video.seekable.end(video.seekable.length - 1) };
  return null;
}

function updateLiveControls() {
  const pb = S.playback;
  const w = liveWindow();
  const local = curPos();
  const cur = Number.isFinite(local) ? local : expectedPos();
  const delay = (S.info && S.info.delay) || 4;
  const behind = w ? Math.max(0, w.end - delay - cur) : 0;
  const span = w ? Math.max(1, w.end - w.start) : 0;
  D.btnPlay.textContent = pb && pb.playing ? '❚❚' : '▶';
  D.tCur.textContent = behind > 3 ? `−${fmt(behind)}` : 'live';
  D.tDur.textContent = w ? `DVR ${fmt(span)}` : 'live';
  D.btnLive.hidden = false;
  D.btnLive.classList.toggle('at-live', behind <= 3 && !!(pb && pb.playing));
  D.btnNext.hidden = true;
  if (!S.seeking && w) {
    const frac = Math.max(0, Math.min(1, (cur - w.start) / span));
    D.seek.value = Math.round(frac * 1000);
    D.seekFill.style.width = `${frac * 100}%`;
  }
  let buf = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 1) buf = Math.max(buf, video.buffered.end(i));
  }
  const bufP = buf ? pdtAt(buf) : NaN;
  D.seekBuffer.style.width = w && Number.isFinite(bufP) ? `${Math.max(0, Math.min(100, ((bufP - w.start) / span) * 100))}%` : '0';
}

D.btnLive.addEventListener('click', () => control('live'));

/* ------------------------------------------------------------------ */
/* YouTube: IFrame-API                                                 */
/* ------------------------------------------------------------------ */

let ytApiPromise = null;
function ytApi() {
  if (window.YT && YT.Player) return Promise.resolve();
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch { /* egal */ } resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytApiPromise = null; reject(new Error('YouTube-Player lädt nicht (Netz/Adblocker?)')); };
      document.head.append(s);
      setTimeout(() => reject(new Error('YouTube-Player antwortet nicht')), 15000);
    });
  }
  return ytApiPromise;
}

async function buildYouTube() {
  const vid = S.info.videoId;
  const key = `yt|${vid}`;
  if (key === S.loadedKey) return;
  S.loadedKey = key;
  destroyHls();
  video.hidden = true;
  $('#yt-host').hidden = false;
  try { await ytApi(); } catch (ex) { toast(ex.message); $('#overlay-loading').hidden = true; reportStatus('error'); return; }
  if (S.loadedKey !== key) return;
  if (!$('#yt-frame')) $('#yt-host').prepend(el('div', { id: 'yt-frame' }));
  S.ytReady = false;
  S.ytRate = 1;
  S.yt = new YT.Player('yt-frame', {
    host: 'https://www.youtube-nocookie.com',
    videoId: vid,
    width: '100%', height: '100%',
    playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1, start: Math.floor(expectedPos()), origin: location.origin },
    events: {
      onReady: () => {
        if (S.loadedKey !== key) return;
        S.ytReady = true;
        S.ytRates = (S.yt.getAvailablePlaybackRates && S.yt.getAvailablePlaybackRates()) || [1];
        ytVolume();
        $('#overlay-loading').hidden = true;
        syncTick(true);
        updateControls();
      },
      onStateChange: (e) => {
        if (S.loadedKey !== key) return;
        if (e.data === 1) { S.ytPlayAt = 0; $('#overlay-loading').hidden = true; if (S.blocked) { S.blocked = false; $('#overlay-blocked').hidden = true; } }
        else if (e.data === 3) $('#overlay-loading').hidden = false;
        else $('#overlay-loading').hidden = true;
        updateControls();
      },
      onError: (e) => {
        const why = { 2: 'ungültige Video-ID', 5: 'HTML5-Fehler', 100: 'Video nicht gefunden oder privat', 101: 'Einbetten verboten', 150: 'Einbetten verboten' }[e.data] || `Fehler ${e.data}`;
        toast(`YouTube: ${why}`);
        reportStatus('error');
      },
    },
  });
}

function ytCur() {
  if (!S.ytReady) return NaN;
  const v = S.yt.getCurrentTime();
  return Number.isFinite(v) ? v : NaN;
}

function ytState() {
  if (!S.ytReady) return 'buffering';
  const st = S.yt.getPlayerState();
  if (st === 1) return 'playing';
  if (st === 3) return 'buffering';
  if (st === -1) return S.playback && S.playback.playing ? 'buffering' : 'paused';
  return 'paused';
}

function ytBuffered() {
  if (!S.ytReady) return 0;
  return (S.yt.getVideoLoadedFraction() || 0) * (S.yt.getDuration() || 0);
}

function ytPlay() {
  if (!S.ytReady) return;
  S.ytPlayAt = performance.now();
  S.yt.playVideo();
}

function ytVolume() {
  if (!S.ytReady) return;
  S.yt.setVolume(Math.round(S.prefs.volume * 100));
  if (S.prefs.muted) S.yt.mute(); else S.yt.unMute();
}

function ytSetRate(r) {
  if (r === S.ytRate) return;
  S.ytRate = r;
  S.yt.setPlaybackRate(r);
}

/** Nächste verfügbare Geschwindigkeit in die richtige Richtung (YouTube kennt nur feste Stufen). */
function ytPickRate(want) {
  const rates = (S.ytRates || [1]).filter((r) => r >= 0.5 && r <= 1.5);
  const side = rates.filter((r) => (want > 1 ? r > 1 : r < 1));
  if (!side.length) return 1;
  return side.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}

/** Wie syncTick, nur für den YouTube-Player. */
function ytSync(force) {
  if (!S.ytReady) return;
  const pb = S.playback;
  const y = S.yt;
  const st = y.getPlayerState(); // -1 neu, 0 Ende, 1 läuft, 2 Pause, 3 lädt, 5 bereit
  const exp = expectedPos();
  const cur = ytCur();
  const now = performance.now();

  if (!pb.playing) {
    S.ytPlayAt = 0;
    if (st === 1 || st === 3) y.pauseVideo();
    ytSetRate(1);
    // Vor dem ersten Abspielen würde seekTo sofort starten → dann reicht der Startpunkt beim Play
    if (st !== -1 && st !== 5 && Number.isFinite(cur) && Math.abs(cur - exp) > 0.15) y.seekTo(exp, true);
    return;
  }
  const dur = y.getDuration() || Infinity;
  if (st === 0 && exp >= dur - 1) return;
  if (st !== 1 && st !== 3) {
    if (force && !S.blocked) { y.seekTo(exp, true); ytPlay(); return; }
    if (!S.ytPlayAt) { if (!S.blocked) { y.seekTo(exp, true); ytPlay(); } return; }
    if (now - S.ytPlayAt > 3000 && !S.blocked) {
      // Autoplay vom Browser verhindert
      S.blocked = true;
      $('#overlay-blocked').hidden = false;
      reportStatus('blocked');
    }
    return;
  }
  if (st !== 1 || !Number.isFinite(cur)) return;
  const diff = exp - cur;
  const ad = Math.abs(diff);
  if (ad > 1.5 && (force || now - S.lastHardSeek > 3000 || ad > 8)) {
    S.lastHardSeek = now;
    ytSetRate(1);
    y.seekTo(exp + (diff > 0 ? 0.3 : 0), true);
    S.correcting = false;
    return;
  }
  if (ad > 0.12) S.correcting = true;
  if (S.correcting && ad < 0.04) S.correcting = false;
  ytSetRate(S.correcting ? ytPickRate(1 + Math.max(-0.25, Math.min(0.25, diff * 0.6))) : 1);
}

// Klicks auf dem YouTube-Bild wie beim normalen Video behandeln
$('#yt-shield').addEventListener('click', () => {
  if (player.classList.contains('idle')) return wake();
  if (canControl()) togglePlay();
});
$('#yt-shield').addEventListener('dblclick', toggleFs);

/* ------------------------------------------------------------------ */
/* Link einfügen                                                       */
/* ------------------------------------------------------------------ */

function openLinkMenu() {
  if (!canLoad()) { toast('Du darfst hier gerade nichts auswählen.'); return; }
  const m = $('#link-menu');
  m.hidden = false;
  setTimeout(() => $('#link-input').focus(), 0);
}

$('#btn-link').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('#link-menu').hidden) openLinkMenu(); else $('#link-menu').hidden = true;
});
$('#btn-link-empty').addEventListener('click', (e) => { e.stopPropagation(); openLinkMenu(); });
$('#link-menu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { $('#link-menu').hidden = true; });
$('#link-menu').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#link-input').value.trim();
  if (!url) return;
  send({ t: 'load-url', url, play: !!(S.members && S.members.length === 1) });
});

function onLoadUrl(msg) {
  const btn = $('#link-go');
  if (msg.state === 'loading') { btn.disabled = true; btn.textContent = 'Verbinde …'; return; }
  btn.disabled = false;
  btn.textContent = 'Für alle abspielen';
  if (msg.state === 'ok') { $('#link-menu').hidden = true; $('#link-input').value = ''; }
}

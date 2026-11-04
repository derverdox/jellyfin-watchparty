'use strict';
/**
 * Herzstück des Clients: verbindet den Raum (Relay) mit mpv.
 * - setzt Play/Pause/Spulen/Filmwechsel der anderen in mpv um
 * - hält mpv per Abspielgeschwindigkeit und Sprüngen auf der gemeinsamen Zeit
 * - meldet eigene Aktionen (Tastatur, Mausklicks in mpv, Buttons im Client) an den Raum
 * - schaltet Framegen und VSR passend zur Datei
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Mpv } = require('./mpv');

const SYNC_MS = 250;
const STATUS_MS = 2000;
const BITRATES = new Set(['40000000', '20000000', '10000000', '6000000', '3000000', '1500000']);

const INPUT_CONF = `# Watchparty: Steuerung läuft über den Raum
SPACE script-message wp toggle
p script-message wp toggle
MBTN_RIGHT script-message wp toggle
PLAY script-message wp toggle
PLAYPAUSE script-message wp toggle
PAUSE script-message wp pause
LEFT script-message wp seek -5
RIGHT script-message wp seek 5
Shift+LEFT script-message wp seek -1
Shift+RIGHT script-message wp seek 1
UP script-message wp seek 60
DOWN script-message wp seek -60
PGUP script-message wp seek 600
PGDWN script-message wp seek -600
[ ignore
] ignore
{ ignore
} ignore
BS ignore
. ignore
, ignore
q script-message wp close
Q script-message wp close
CLOSE_WIN script-message wp close
ESC set fullscreen no
f cycle fullscreen
MBTN_LEFT_DBL cycle fullscreen
F1 script-message wp framegen
F2 script-message wp vsr
c script-message wp osdchat
s script-message wp skip
S script-message wp skip
i script-binding stats/display-stats-toggle
`;

class Session extends EventEmitter {
  constructor({ relay, settings, installer, framegen, configDir, logDir }) {
    super();
    this.relay = relay;
    this.settings = settings;
    this.installer = installer;
    this.framegen = framegen;
    this.configDir = configDir;
    this.logDir = logDir;
    this.mpv = null;
    this.reset();

    relay.on('message', (m) => this.onMessage(m));
    relay.on('conn', (c) => this.ui('room:conn', c));
    relay.on('fatal', (f) => { this.ui('room:fatal', f); this.stopPlayer(); });

    framegen.on('status', (s) => this.ui('fg:engine', s));

    this.syncTimer = setInterval(() => this.syncTick(false), SYNC_MS);
    this.statusTimer = setInterval(() => this.reportStatus(), STATUS_MS);
    this.uiTimer = setInterval(() => this.pushPlayerState(), 500);
  }

  reset() {
    this.code = null;
    this.you = null;
    this.room = null;
    this.members = [];
    this.playback = null;
    this.info = null;
    this.loadedId = null;
    this.loadedKey = null;
    this.fileReady = false;
    this.correcting = false;
    this.lastHardSeek = 0;
    this.ourPause = null;     // Wert, den wir zuletzt selbst gesetzt haben
    this.ourSeekAt = 0;       // Zeitpunkt des letzten Ladens (Startsprung)
    this.pendingSeeks = 0;    // eigene Sprünge, deren seek-Ereignis noch aussteht
    this.userSeek = false;
    this.planInfo = null;
    this.lastPlanKey = null;
  }

  ui(channel, payload) { this.emit('ui', channel, payload); }

  /* ------------------------------------------------------------ */
  /* Raum                                                          */
  /* ------------------------------------------------------------ */

  join(code) {
    this.reset();
    this.code = String(code).toUpperCase();
    this.relay.join(this.code);
  }

  async leave() {
    this.relay.leave();
    await this.stopPlayer();
    this.reset();
  }

  canControl() {
    if (!this.room || !this.you) return false;
    return this.room.allowAllControl || this.room.host === this.you.sid;
  }

  isHost() { return !!(this.room && this.you && this.room.host === this.you.sid); }

  onMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        this.you = msg.you;
        this.room = msg.room;
        this.members = msg.members;
        this.ui('room:welcome', { ...msg, code: this.code });
        this.setPlayback(msg.playback);
        break;
      case 'playback': this.setPlayback(msg.playback, msg); break;
      case 'members': this.members = msg.members; this.ui('room:members', msg.members); break;
      case 'room':
        this.room = msg.room;
        if (msg.members) this.members = msg.members;
        this.ui('room:room', { room: msg.room, members: this.members });
        break;
      case 'chat':
        this.ui('room:chat', msg.msg);
        if (this.settings.prefs.osdChat && this.mpv && msg.msg.kind !== 'system') {
          this.mpv.osd(`${msg.msg.from}: ${msg.msg.text}`, 5000);
        }
        break;
      case 'react':
        this.ui('room:react', msg);
        if (this.settings.prefs.osdChat && this.mpv) this.mpv.osd(`${msg.from}  ${msg.emoji}`, 2000);
        break;
      case 'agent': this.ui('room:agent', msg); if (msg.online && this.playback && this.playback.item && !this.info) { this.loadedId = null; this.setPlayback(this.playback); } break;
      case 'error': this.ui('room:error', msg.text); if (this.mpv) this.mpv.osd(msg.text); break;
      case 'announce':
        this.ui('room:announce', msg);
        if (this.mpv) this.mpv.osd(`📣 ${msg.from}: ${msg.text}`, 8000);
        break;
      case 'noaccess':
        // Dieser Titel ist für das eigene Konto nicht freigegeben
        this.ui('room:noaccess', msg.item);
        if (this.mpv) { this.mpv.command('stop').catch(() => {}); this.mpv.osd(`🔒 Kein Zugriff auf „${msg.item.title}“`, 6000); }
        this.loadedId = msg.item.id;
        this.loadedKey = null;
        this.fileReady = false;
        break;
      case 'kicked': this.ui('room:kicked', { text: msg.text }); this.leave(); break;
      // Warteschlange, Abstimmung, Bewertungsrunde → an die Oberfläche (extras.js)
      case 'queue': case 'poll': case 'rate-prompt': case 'round': case 'round-end': case 'advancing':
        this.ui('room:extra', msg);
        this.osdExtra(msg);
        break;
      default: break;
    }
  }

  send(msg) { return this.relay.send(msg); }

  osdExtra(msg) {
    if (!this.mpv) return;
    if (msg.t === 'poll' && msg.poll && !this.osdPollId) {
      this.osdPollId = msg.poll.id;
      this.mpv.osd(`🗳 Abstimmung: ${msg.poll.options.map((o) => o.title).join(' · ')} – im Fenster abstimmen`, 6000);
    } else if (msg.t === 'poll' && !msg.poll) {
      this.osdPollId = null;
      if (msg.winner) this.mpv.osd(`🏆 Gewonnen: ${msg.winner.title}`, 5000);
    } else if (msg.t === 'rate-prompt') this.mpv.osd(`⭐ Wie fandet ihr „${msg.item.title}“? Im Fenster 1–10 Sterne vergeben`, 8000);
    else if (msg.t === 'round-end' && msg.count) this.mpv.osd(`⭐ Eure Runde: ${String(msg.avg).replace('.', ',')}/10 (${msg.count})`, 6000);
    else if (msg.t === 'advancing' && msg.next) this.mpv.osd(`⏭ Gleich: ${msg.next.title}`, 6000);
  }

  /* ---------- Intro, Rückblick, Abspann ---------- */

  currentSegment() {
    const segs = (this.info && this.info.segments) || [];
    const t = this.mpv && this.mpv.props['time-pos'];
    if (!Number.isFinite(t)) return null;
    return segs.find((x) => t >= x.start - 0.5 && t < x.end - 1.5 && ['intro', 'recap', 'preview', 'outro'].includes(x.type)) || null;
  }

  checkSegment() {
    const seg = this.currentSegment();
    const key = seg ? `${this.loadedId}|${seg.type}|${seg.start}` : null;
    if (key && key !== this.segKey && this.mpv && this.canControl()) {
      const what = { intro: 'Intro', recap: 'Rückblick', preview: 'Vorschau', outro: 'Abspann' }[seg.type];
      this.mpv.osd(`${what} – [S] ${seg.type === 'outro' ? 'nächste Folge' : 'überspringen'}`, 4000);
    }
    this.segKey = key;
  }

  skipSegment() {
    const seg = this.currentSegment();
    if (!seg) { if (this.mpv) this.mpv.osd('Hier gibt es nichts zu überspringen'); return; }
    if (seg.type === 'outro') {
      const next = this.playback && this.playback.item && this.playback.item.nextEpisodeId;
      if (next) this.send({ t: 'load', itemId: next });
      return;
    }
    this.control('seek', seg.end);
  }

  /* ------------------------------------------------------------ */
  /* Wiedergabe                                                    */
  /* ------------------------------------------------------------ */

  expectedPos() {
    const pb = this.playback;
    if (!pb) return 0;
    let p = pb.playing ? pb.position + (this.relay.serverNow() - pb.updatedAt) / 1000 : pb.position;
    const dur = (pb.item && pb.item.runtime) || (this.mpv && this.mpv.props.duration);
    if (Number.isFinite(dur) && dur > 0) p = Math.min(p, dur);
    return Math.max(0, p);
  }

  setPlayback(pb, meta) {
    const old = this.playback;
    if (old && pb.seq < old.seq && pb.item && old.item && pb.item.id === old.item.id) return;
    this.playback = pb;
    this.ui('room:playback', { playback: pb, by: meta && meta.by, action: meta && meta.action });
    if (meta && meta.by && this.mpv && meta.by !== (this.you && this.you.name)) {
      const a = { play: '▶ Play', pause: '❚❚ Pause', seek: '⇄ Gesprungen', load: '🎬 Neuer Film' }[meta.action];
      if (a) this.mpv.osd(`${a} · ${meta.by}`, 2000);
    }
    if (!pb.item) {
      if (this.mpv && this.loadedId) this.mpv.command('stop').catch(() => {});
      this.loadedId = null; this.loadedKey = null; this.info = null; this.fileReady = false;
      return;
    }
    if (pb.item.id !== this.loadedId) this.loadItem(pb.item.id);
    else this.syncTick(true);
  }

  async loadItem(id) {
    this.loadedId = id;
    this.info = null;
    this.fileReady = false;
    try {
      const info = await this.relay.item(id);
      if (this.loadedId !== id) return;
      this.info = info;
      this.ui('room:item', info);
      await this.openSource();
    } catch (e) {
      this.ui('room:error', `Konnte das Video nicht laden: ${e.message}`);
    }
  }

  /** Gewünschte Qualität auf das abbilden, was diese Datei und die eigene Gruppe hergeben. */
  chooseQuality() {
    const info = this.info;
    const list = info.qualities || [];
    const want = String(this.settings.prefs.quality || 'direct');
    if (list.some((x) => x.id === want)) return want;
    if (want === 'direct' || want === 'auto') return list.length ? list[0].id : 'direct';
    const lower = list.filter((x) => x.id !== 'direct' && Number(x.id) <= Number(want));
    return lower.length ? lower[0].id : (list.length ? list[list.length - 1].id : 'direct');
  }

  sourceUrl() {
    const info = this.info;
    const q = this.chooseQuality();
    this.activeQuality = q;
    if (q === 'direct' || !BITRATES.has(String(q))) {
      return { key: `${info.id}|direct`, url: `${this.relay.base}/stream/${info.id}/direct?ms=${info.mediaSourceId}`, direct: true };
    }
    const ps = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({ ms: info.mediaSourceId, ps, br: String(q) });
    const audio = this.pickAudioFromInfo();
    if (audio != null) params.set('audio', audio);
    return { key: `${info.id}|${q}|${audio}`, url: `${this.relay.base}/stream/${info.id}/master.m3u8?${params}`, direct: false };
  }

  pickAudioFromInfo() {
    const info = this.info;
    const al = this.settings.prefs.audioLang;
    const a = (al && info.audio.find((x) => x.lang === al)) || info.audio.find((x) => x.index === info.defaultAudioIndex) || info.audio[0];
    return a ? a.index : null;
  }

  async openSource() {
    if (!this.info) return;
    await this.ensurePlayer();
    const src = this.sourceUrl();
    if (src.key === this.loadedKey) return;
    this.loadedKey = src.key;
    this.source = src;
    this.fileReady = false;
    this.lastPlanKey = null;
    const mpv = this.mpv;
    const start = this.expectedPos();
    const playing = !!(this.playback && this.playback.playing);
    await mpv.set('http-header-fields', [`Cookie: ${this.relay.cookieHeader}`]).catch(() => {});
    await mpv.command('vf', 'clr', '').catch(() => {});
    this.ourPause = !playing;
    await mpv.set('pause', !playing).catch(() => {});
    await mpv.set('start', `+${start.toFixed(3)}`).catch(() => {});
    this.ourSeekAt = Date.now();
    const title = `${this.info.title}${this.info.subtitle ? ` – ${this.info.subtitle}` : ''}`;
    await mpv.set('force-media-title', title).catch(() => {});
    await mpv.command('loadfile', src.url, 'replace').catch((e) => this.ui('room:error', `mpv: ${e.message}`));
  }

  async onFileLoaded() {
    const mpv = this.mpv;
    if (!mpv || !this.info) return;
    await mpv.set('start', 'none').catch(() => {});
    this.ourSeekAt = Date.now(); // der Startsprung kommt erst nach file-loaded
    this.fileReady = true;
    if (this.settings.prefs.fullscreen) mpv.set('fullscreen', true).catch(() => {});
    await this.selectTracks();
    this.syncTick(true);
    this.applyFilters(true);
  }

  /* ---------- Spuren ---------- */

  tracks() {
    const list = (this.mpv && this.mpv.props['track-list']) || [];
    const map = (t) => ({ id: t.id, type: t.type, title: t.title || '', lang: (t.lang || '').toLowerCase(), codec: t.codec || '', selected: !!t.selected, external: !!t.external, default: !!t.default, forced: !!t.forced, ffIndex: t['ff-index'] });
    return { audio: list.filter((t) => t.type === 'audio').map(map), sub: list.filter((t) => t.type === 'sub').map(map) };
  }

  async selectTracks() {
    const mpv = this.mpv;
    const info = this.info;
    if (!mpv || !info) return;
    const list = (await mpv.get('track-list').catch(() => [])) || [];
    // Externe Untertitel von Jellyfin nachladen (die stecken nicht in der Datei)
    if (this.source && this.source.direct) {
      const embedded = new Set(list.filter((t) => t.type === 'sub' && !t.external).map((t) => t['ff-index']));
      for (const s of info.subs) {
        if (!s.isText || embedded.has(s.index)) continue;
        const url = `${this.relay.base}/subs/${info.id}/${info.mediaSourceId}/${s.index}.vtt`;
        await mpv.command('sub-add', url, 'auto', s.label, s.lang || '').catch(() => {});
      }
    }
    const tl = (await mpv.get('track-list').catch(() => [])) || list;
    const { audioLang, subLang } = this.settings.prefs;
    if (this.source && this.source.direct && audioLang) {
      const a = tl.find((t) => t.type === 'audio' && (t.lang || '').toLowerCase() === audioLang);
      if (a) await mpv.set('aid', a.id).catch(() => {});
    }
    if (subLang === 'off') await mpv.set('sid', 'no').catch(() => {});
    else if (subLang) {
      const c = tl.filter((t) => t.type === 'sub' && (t.lang || '').toLowerCase() === subLang);
      const s = c.find((t) => !t.forced) || c[0];
      if (s) await mpv.set('sid', s.id).catch(() => {});
    }
    this.ui('player:tracks', this.tracks());
  }

  async setTrack(type, id) {
    if (!this.mpv) return;
    const tl = this.tracks();
    if (type === 'audio') {
      await this.mpv.set('aid', id === 'no' ? 'no' : Number(id));
      const t = tl.audio.find((x) => x.id === Number(id));
      if (t) this.settings.setPrefs({ audioLang: t.lang || '' });
    } else {
      await this.mpv.set('sid', id === 'no' ? 'no' : Number(id));
      const t = tl.sub.find((x) => x.id === Number(id));
      this.settings.setPrefs({ subLang: id === 'no' ? 'off' : (t && t.lang) || '' });
    }
    setTimeout(() => this.ui('player:tracks', this.tracks()), 200);
  }

  /* ---------- Framegen & VSR ---------- */

  async applyFilters(force = false) {
    const mpv = this.mpv;
    if (!mpv || !this.fileReady) return;
    const params = mpv.props['video-params'] || await mpv.get('video-params').catch(() => null);
    if (!params || !params.w) return;
    const srcFps = mpv.props['container-fps'] || await mpv.get('container-fps').catch(() => null);
    const displayFps = mpv.props['display-fps'] || null;
    const displayHeight = mpv.props['display-height'] || null;
    const prefs = this.settings.prefs;
    const status = this.installer.status();
    const { vf, info } = this.framegen.plan({ params, srcFps, displayFps, displayHeight }, prefs, status);
    const key = JSON.stringify(vf);
    this.planInfo = info;
    this.ui('player:filters', info);

    if (info.framegen && info.framegen.state === 'needs-engine') {
      this.buildEngineFor(prefs.framegen.model, params);
    }
    if (!force && key === this.lastPlanKey) return;
    this.lastPlanKey = key;

    const wantCopy = vf.some((f) => f.startsWith('@wprife:'));
    const hwdec = wantCopy ? 'auto-copy' : 'auto';
    if (mpv.props['hwdec'] !== hwdec) { mpv.props.hwdec = hwdec; await mpv.set('hwdec', hwdec).catch(() => {}); }
    try {
      await mpv.command('vf', 'set', vf.join(','));
      if (info.framegen && info.framegen.state === 'on') mpv.osd(`Framegen an: ${fmtFps(info.framegen.from)} → ${fmtFps(info.framegen.to)} fps`, 3000);
    } catch (e) {
      this.ui('room:error', `Filter ließ sich nicht aktivieren: ${e.message}. Details im mpv-Log.`);
      await mpv.command('vf', 'clr', '').catch(() => {});
      this.lastPlanKey = '[]';
    }
  }

  async buildEngineFor(model, params) {
    if (this.framegen.building) return;
    const bits = /10|12|16/.test(String(params.pixelformat || '')) ? 10 : 8;
    if (this.mpv) this.mpv.osd('Framegen wird vorbereitet (TensorRT-Engine, nur beim ersten Mal, 1–10 Minuten) …', 6000);
    try {
      await this.framegen.buildEngine(model, params.w, params.h, bits);
      this.ui('fg:engine', { state: 'ready' });
      this.applyFilters(true);
    } catch (e) {
      this.ui('fg:engine', { state: 'error', error: e.message });
      this.ui('room:error', e.message);
    }
  }

  async setPrefs(patch) {
    const before = this.settings.prefs;
    const prefs = this.settings.setPrefs(patch);
    if (patch.quality && patch.quality !== before.quality && this.info) { this.loadedKey = null; await this.openSource(); }
    if (patch.volume != null && this.mpv) this.mpv.set('volume', Number(patch.volume)).catch(() => {});
    if (patch.framegen || patch.vsr) this.applyFilters();
    return prefs;
  }

  /* ---------- Sync ---------- */

  setPause(value) {
    if (!this.mpv) return;
    if (this.mpv.props.pause === value && this.ourPause === value) return;
    this.ourPause = value;
    this.mpv.set('pause', value).catch(() => {});
  }

  seekTo(pos) {
    if (!this.mpv) return;
    this.pendingSeeks++;
    this.mpv.command('seek', pos, 'absolute+exact').catch(() => {});
  }

  setSpeed(v) {
    if (!this.mpv) return;
    const cur = this.mpv.props.speed || 1;
    if (Math.abs(cur - v) < 0.004) return;
    this.mpv.props.speed = v;
    this.mpv.set('speed', Number(v.toFixed(4))).catch(() => {});
  }

  syncTick(force) {
    const mpv = this.mpv;
    const pb = this.playback;
    if (!mpv || !pb || !pb.item || !this.fileReady) return;
    const pos = mpv.props['time-pos'];
    if (!Number.isFinite(pos)) return;
    const exp = this.expectedPos();
    const fgOn = !!(this.planInfo && this.planInfo.framegen && this.planInfo.framegen.state === 'on');

    if (!pb.playing) {
      this.setPause(true);
      this.setSpeed(1);
      this.correcting = false;
      if (!mpv.props.seeking && !this.pendingSeeks && Math.abs(pos - exp) > 0.15) this.seekTo(exp);
      return;
    }

    const dur = mpv.props.duration;
    if (mpv.props['eof-reached'] && Number.isFinite(dur) && exp >= dur - 1) return;
    this.setPause(false);
    if (mpv.props.seeking || mpv.props['paused-for-cache']) return;

    const diff = exp - pos; // > 0: ich hänge hinterher
    const ad = Math.abs(diff);
    const now = Date.now();
    const hard = fgOn ? 2.5 : 1.5;
    if (ad > hard && (force || now - this.lastHardSeek > 4000 || ad > 10)) {
      this.lastHardSeek = now;
      this.setSpeed(1);
      this.correcting = false;
      this.seekTo(exp + (diff > 0 ? 0.3 : 0));
      return;
    }
    if (ad > 0.25) this.correcting = true;
    if (this.correcting && ad < 0.05) this.correcting = false;
    // Verstärkung 0,4: ein Player, der dauerhaft 5 % zu langsam läuft, bleibt so unter ~0,15 s Abweichung
    this.setSpeed(this.correcting ? 1 + Math.max(-0.06, Math.min(0.06, diff * 0.4)) : 1);
  }

  playerStateName() {
    const mpv = this.mpv;
    const pb = this.playback;
    if (!pb || !pb.item) return 'idle';
    if (!mpv || !mpv.running) return 'idle';
    if (!this.fileReady || mpv.props.seeking || mpv.props['paused-for-cache']) return pb.playing ? 'buffering' : 'paused';
    return mpv.props.pause ? 'paused' : 'playing';
  }

  reportStatus() {
    if (!this.code) return;
    const pos = (this.mpv && this.mpv.props['time-pos']) || 0;
    if (!this.playback || !this.playback.item) { this.send({ t: 'status', pos: 0, state: 'idle' }); return; }
    this.send({ t: 'status', pos, state: this.playerStateName(), drift: this.expectedPos() - pos });
  }

  pushPlayerState() {
    if (!this.code) return;
    this.checkSegment();
    const mpv = this.mpv;
    const p = (mpv && mpv.props) || {};
    this.ui('player:state', {
      running: !!(mpv && mpv.running),
      ready: this.fileReady,
      quality: this.activeQuality || null,
      nextEpisodeId: (this.playback && this.playback.item && this.playback.item.nextEpisodeId) || null,
      pos: Number.isFinite(p['time-pos']) ? p['time-pos'] : this.expectedPos(),
      expected: this.expectedPos(),
      duration: (this.playback && this.playback.item && this.playback.item.runtime) || p.duration || 0,
      state: this.playerStateName(),
      speed: p.speed || 1,
      cache: p['demuxer-cache-time'] || 0,
      vfFps: p['estimated-vf-fps'] || null,
      displayFps: p['display-fps'] || null,
      hwdec: p['hwdec-current'] || null,
      rtt: this.relay.rtt,
    });
  }

  /* ---------- Eigene Aktionen ---------- */

  control(action, position) {
    if (!this.playback || !this.playback.item) return;
    if (!this.canControl()) {
      this.ui('room:error', 'Nur der Host darf gerade steuern.');
      if (this.mpv) this.mpv.osd('Nur der Host darf gerade steuern.');
      this.syncTick(true);
      return;
    }
    const pos = Number.isFinite(position) ? position : this.expectedPos();
    this.playback = {
      ...this.playback,
      position: pos,
      updatedAt: this.relay.serverNow(),
      playing: action === 'play' ? true : action === 'pause' ? false : this.playback.playing,
    };
    this.ui('room:playback', { playback: this.playback, by: this.you && this.you.name, action, local: true });
    this.syncTick(true);
    this.send({ t: 'control', action, position: pos });
  }

  togglePlay() {
    if (!this.playback || !this.playback.item) return;
    const pos = this.mpv && Number.isFinite(this.mpv.props['time-pos']) ? this.mpv.props['time-pos'] : this.expectedPos();
    this.control(this.playback.playing ? 'pause' : 'play', pos);
  }

  seekBy(d) {
    if (!this.playback || !this.playback.item) return;
    const dur = (this.playback.item && this.playback.item.runtime) || Infinity;
    this.control('seek', Math.max(0, Math.min(dur, this.expectedPos() + d)));
  }

  /* ------------------------------------------------------------ */
  /* mpv                                                           */
  /* ------------------------------------------------------------ */

  mpvBinary() {
    if (fs.existsSync(this.installer.mpvExe)) return this.installer.mpvExe;
    return process.platform === 'win32' ? null : 'mpv';
  }

  async ensurePlayer() {
    if (this.mpv && this.mpv.running) return this.mpv;
    const bin = this.mpvBinary();
    if (!bin) throw new Error('mpv ist noch nicht installiert. Richte den Player in der Lobby ein.');
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(path.join(this.configDir, 'input.conf'), INPUT_CONF);
    fs.writeFileSync(path.join(this.configDir, 'mpv.conf'), '# wird vom Watchparty-Client verwaltet\n');
    const prefs = this.settings.prefs;
    const args = [
      `--config-dir=${this.configDir}`,
      '--config=yes',
      '--keep-open=yes',
      '--title=${?force-media-title:${force-media-title}}${!force-media-title:Watchparty} · Watchparty',
      '--vo=gpu-next',
      '--hwdec=auto',
      '--cache=yes',
      '--demuxer-max-bytes=1024MiB',
      '--demuxer-max-back-bytes=256MiB',
      '--demuxer-readahead-secs=120',
      '--cache-pause-wait=2',
      '--hr-seek=yes',
      '--network-timeout=60',
      '--user-agent=watchparty-desktop/1.0',
      '--ytdl=no',
      '--sub-auto=no',
      '--audio-file-auto=no',
      '--save-position-on-quit=no',
      '--osd-font-size=36',
      '--osd-duration=2500',
      '--osd-on-seek=msg-bar',
      `--volume=${Number(prefs.volume) || 100}`,
      '--target-colorspace-hint=yes',
    ];
    if (prefs.screen !== 'auto' && prefs.screen !== '' && prefs.screen != null) {
      args.push(`--screen=${prefs.screen}`, `--fs-screen=${prefs.screen}`);
    }
    fs.mkdirSync(this.logDir, { recursive: true });
    const mpv = new Mpv({
      binary: bin, args,
      env: this.framegen.env(),
      cwd: path.dirname(bin) === '.' ? undefined : path.dirname(bin),
      logFile: path.join(this.logDir, 'mpv.log'),
    });
    this.mpv = mpv;
    mpv.on('prop', (name, value) => this.onProp(name, value));
    mpv.on('event', (e) => this.onMpvEvent(e));
    mpv.on('exit', (info) => {
      if (this.mpv !== mpv) return;
      this.mpv = null;
      this.loadedKey = null;
      this.fileReady = false;
      this.ui('player:closed', info);
    });
    await mpv.start();
    this.ui('player:opened', {});
    return mpv;
  }

  async showPlayer() {
    try {
      await this.ensurePlayer();
      if (this.info && !this.loadedKey) await this.openSource();
      else if (this.playback && this.playback.item && !this.info) await this.loadItem(this.playback.item.id);
    } catch (e) { this.ui('room:error', e.message); }
  }

  async stopPlayer() {
    const mpv = this.mpv;
    this.mpv = null;
    this.fileReady = false;
    this.loadedKey = null;
    if (mpv) await mpv.quit();
  }

  onProp(name, value) {
    if (name === 'pause') {
      if (!this.fileReady || !this.playback || !this.playback.item) return;
      if (value === this.ourPause) return;
      if (value && this.mpv.props['eof-reached']) { this.ourPause = value; return; } // keep-open pausiert am Ende selbst
      // Pause/Play kam aus mpv selbst (Mausklick auf die Leiste o. Ä.)
      this.ourPause = value;
      this.control(value ? 'pause' : 'play', this.mpv.props['time-pos']);
    } else if (name === 'track-list') {
      this.ui('player:tracks', this.tracks());
    } else if (name === 'display-fps' || name === 'display-height') {
      if (this.fileReady) this.applyFilters();
    } else if (name === 'volume' && Number.isFinite(value)) {
      if (Math.round(value) !== Math.round(this.settings.prefs.volume)) this.settings.setPrefs({ volume: Math.round(value) });
    } else if (name === 'fullscreen') {
      this.ui('player:fullscreen', !!value);
    }
  }

  onMpvEvent(e) {
    switch (e.event) {
      case 'file-loaded': this.onFileLoaded(); break;
      case 'seek':
        if (this.pendingSeeks > 0) this.pendingSeeks--;
        else if (this.fileReady && Date.now() - this.ourSeekAt > 1500) this.userSeek = true;
        break;
      case 'playback-restart':
        this.pendingSeeks = 0; // mpv fasst schnelle Sprünge zusammen
        if (this.userSeek) {
          this.userSeek = false;
          const pos = this.mpv && this.mpv.props['time-pos'];
          if (Number.isFinite(pos)) {
            // kurz warten, bis time-pos aktuell ist
            setTimeout(() => {
              const p = this.mpv && this.mpv.props['time-pos'];
              this.control('seek', Number.isFinite(p) ? p : pos);
            }, 50);
          }
        }
        break;
      case 'end-file':
        if (e.reason === 'error') {
          this.ui('room:error', 'mpv konnte die Datei nicht öffnen. Mit einer niedrigeren Qualität klappt es vielleicht.');
          this.loadedKey = null;
        }
        break;
      case 'client-message': this.onClientMessage(e.args || []); break;
      default: break;
    }
  }

  onClientMessage(args) {
    if (args[0] !== 'wp') return;
    const [, cmd, val] = args;
    switch (cmd) {
      case 'toggle': this.togglePlay(); break;
      case 'pause': if (this.playback && this.playback.playing) this.togglePlay(); break;
      case 'seek': this.seekBy(Number(val) || 0); break;
      case 'close': this.stopPlayer(); break;
      case 'skip': this.skipSegment(); break;
      case 'framegen': {
        const fg = this.settings.prefs.framegen;
        this.setPrefs({ framegen: { enabled: !fg.enabled } }).then((p) => {
          this.ui('prefs', p);
          if (this.mpv) this.mpv.osd(`Framegen ${p.framegen.enabled ? 'an' : 'aus'}`);
        });
        break;
      }
      case 'vsr': {
        const v = this.settings.prefs.vsr;
        this.setPrefs({ vsr: { enabled: !v.enabled } }).then((p) => {
          this.ui('prefs', p);
          if (this.mpv) this.mpv.osd(`RTX Super Resolution ${p.vsr.enabled ? 'an' : 'aus'}`);
        });
        break;
      }
      case 'osdchat': {
        const p = this.settings.setPrefs({ osdChat: !this.settings.prefs.osdChat });
        this.ui('prefs', p);
        if (this.mpv) this.mpv.osd(`Chat im Bild ${p.osdChat ? 'an' : 'aus'}`);
        break;
      }
      default: break;
    }
  }

  async destroy() {
    clearInterval(this.syncTimer);
    clearInterval(this.statusTimer);
    clearInterval(this.uiTimer);
    this.relay.leave();
    await this.stopPlayer();
  }
}

function fmtFps(f) { return Number.isFinite(f) ? (Math.round(f * 100) / 100).toString().replace('.', ',') : '?'; }

module.exports = { Session, INPUT_CONF };

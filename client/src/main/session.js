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
const AutoQuality = require('../renderer/auto-quality');
/** YouTube-Qualitäten (yt-dlp-Format, jeweils höchstens so hoch) */
const YT_QUALITIES = [
  { id: 'best', label: 'Beste', height: 0 },
  { id: '2160', label: '4K', height: 2160 },
  { id: '1440', label: '1440p', height: 1440 },
  { id: '1080', label: '1080p', height: 1080 },
  { id: '720', label: '720p', height: 720 },
  { id: '480', label: '480p', height: 480 },
];

/** Oberfläche für mpv (uosc + Schriften + Einstellungen), wird bei jedem Start in den Config-Ordner kopiert. */
const UI_DIR = path.join(__dirname, '..', '..', 'mpv-ui').replace('app.asar', 'app.asar.unpacked');

const MPV_CONF = `# wird vom Watchparty-Client verwaltet
# Die Bedienleiste kommt von uosc (scripts/uosc), die eingebaute bleibt aus
osc=no
osd-bar=no
`;

// Zeilen mit „#!“ landen im Menü von uosc (Menü-Knopf links unten oder Kontextmenü-Taste).
// Zeilen, die mit „#“ anfangen, sind reine Menüeinträge ohne eigene Taste.
const INPUT_CONF = `# Watchparty: Steuerung läuft über den Raum
MENU script-binding uosc/menu
# script-binding uosc/subtitles #! Untertitel
# script-binding uosc/audio #! Tonspur
# script-binding uosc/chapters #! Kapitel
# ignore #! ---
F1 script-message wp framegen #! Framegen an/aus
F2 script-message wp vsr #! Upscaling (RTX VSR) an/aus
# ignore #! ---
s script-message wp skip #! Intro/Abspann überspringen
S script-message wp skip
c script-message wp osdchat #! Chat im Bild an/aus
i script-binding stats/display-stats-toggle #! Statistik
f cycle fullscreen #! Vollbild
q script-message wp close #! Player schließen
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
Q script-message wp close
CLOSE_WIN script-message wp close
ESC set fullscreen no
MBTN_LEFT_DBL cycle fullscreen
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

    framegen.on('status', (s) => { this.ui('fg:engine', s); this.updateButtons(); });

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
    this.loadedMediaSourceId = null;
    this.autoQuality = null; this.autoGuard = new AutoQuality.StallGuard();
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
    this.trackSel = null;     // Spurwahl nach selectTracks(); spätere Änderungen kamen vom Nutzer
    this.lastButtons = {};
    this.stopTwitchMap();
    this.twMap = null;
    this.lastReopen = 0;
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
      case 'load-url': this.ui('room:loadurl', msg); break;
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
    if (pb.item && pb.item.live) return p; // Twitch: Zeitstempel, kein Ende
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
    // Twitch-VODs/Clips (eingebetteter Player): laufen nicht in mpv, sondern im Fenster mit der Website
    if (pb.item.ext) {
      if (pb.item.id !== this.loadedId) {
        if (this.mpv) this.mpv.command('stop').catch(() => {});
        this.stopTwitchMap();
        this.loadedId = pb.item.id; this.loadedKey = null; this.info = null; this.fileReady = false;
        this.ui('room:ext', { item: pb.item, code: this.code });
      }
      return;
    }
    // Twitch live (Restream vom Relay) und YouTube (yt-dlp) laufen in mpv
    if (pb.item.id !== this.loadedId && pb.item.source) this.loadExternal(pb.item);
    else if (pb.item.id !== this.loadedId || (pb.item.mediaSourceId && pb.item.mediaSourceId !== this.loadedMediaSourceId)) this.loadItem(pb.item.id, pb.item.mediaSourceId);
    else this.syncTick(true);
  }

  async loadItem(id, mediaSourceId = null) {
    this.stopTwitchMap();
    this.loadedId = id;
    this.loadedMediaSourceId = mediaSourceId;
    this.autoQuality = null; this.autoGuard = new AutoQuality.StallGuard();
    this.info = null;
    this.fileReady = false;
    try {
      const info = await this.relay.item(id, mediaSourceId);
      if (this.loadedId !== id || this.loadedMediaSourceId !== mediaSourceId) return;
      this.info = info;
      this.autoQuality = AutoQuality.recommended(info);
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
    const want = String(this.settings.prefs.quality || 'auto');
    if (want === 'auto') return this.autoQuality || AutoQuality.recommended(info);
    if (list.some((x) => x.id === want)) return want;
    if (want === 'direct' || want === 'auto') return list.length ? list[0].id : 'direct';
    const lower = list.filter((x) => x.id !== 'direct' && Number(x.id) <= Number(want));
    return lower.length ? lower[0].id : (list.length ? list[list.length - 1].id : 'direct');
  }

  sourceUrl() {
    const info = this.info;
    const q = this.chooseQuality();
    this.activeQuality = q;
    if (q === 'direct') {
      return { key: `${info.id}|${info.mediaSourceId}|direct`, url: `${this.relay.base}/stream/${info.id}/direct?ms=${info.mediaSourceId}`, direct: true };
    }
    const ps = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({ ms: info.mediaSourceId, ps, br: String(q) });
    const audio = this.pickAudioFromInfo();
    if (audio != null) params.set('audio', audio);
    return { key: `${info.id}|${info.mediaSourceId}|${q}|${audio}`, url: `${this.relay.base}/stream/${info.id}/master.m3u8?${params}`, direct: false };
  }

  pickAudioFromInfo() {
    const info = this.info;
    const al = this.settings.prefs.audioLang;
    const a = (al && info.audio.find((x) => x.lang === al)) || info.audio.find((x) => x.index === info.defaultAudioIndex) || info.audio[0];
    return a ? a.index : null;
  }

  async openSource() {
    if (!this.info) return;
    if (this.info.source) return this.openExternal();
    await this.ensurePlayer();
    await this.setLiveMode(false);
    const src = this.sourceUrl();
    if (src.key === this.loadedKey) return;
    this.loadedKey = src.key;
    this.source = src;
    this.fileReady = false;
    this.trackSel = null;
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
    // Untertitel nur, wenn man sich mal eine Sprache ausgesucht hat. Sonst aus,
    // auch wenn die Datei eine Spur als „Standard“ markiert.
    let sid = 'no';
    if (subLang && subLang !== 'off') {
      const c = tl.filter((t) => t.type === 'sub' && (t.lang || '').toLowerCase() === subLang);
      const s = c.find((t) => !t.forced) || c[0];
      if (s) sid = s.id;
    }
    await mpv.set('sid', sid).catch(() => {});
    const [aidNow, sidNow] = await Promise.all([mpv.get('aid').catch(() => null), mpv.get('sid').catch(() => null)]);
    this.trackSel = { aid: aidNow, sid: sidNow };
    this.ui('player:tracks', this.tracks());
  }

  /** Spur wurde in mpv selbst gewechselt (Menü von uosc o. Ä.) → als Vorliebe merken. */
  onTrackProp(name, value) {
    if (!this.trackSel || !this.fileReady) return;
    if (JSON.stringify(this.trackSel[name]) === JSON.stringify(value)) return;
    this.trackSel[name] = value;
    const list = (this.mpv && this.mpv.props['track-list']) || [];
    const type = name === 'sid' ? 'sub' : 'audio';
    const t = list.find((x) => x.type === type && x.id === value);
    if (name === 'sid') this.settings.setPrefs({ subLang: !value || value === 'no' ? 'off' : ((t && t.lang) || '').toLowerCase() });
    else if (this.source && this.source.direct && t) this.settings.setPrefs({ audioLang: (t.lang || '').toLowerCase() });
    this.ui('prefs', this.settings.prefs);
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

  /* ---------- Twitch & YouTube ---------- */

  isLive() { return !!(this.info && this.info.source === 'twitch'); }

  async loadExternal(item) {
    this.stopTwitchMap();
    this.loadedId = item.id;
    this.loadedKey = null;
    this.info = null;
    this.fileReady = false;
    this.twMap = null;
    try {
      let info;
      if (item.source === 'twitch') {
        const t = await this.relay.request('GET', `/api/twitch/${encodeURIComponent(item.channel)}`);
        const qualities = (t.variants || []).map((v) => ({ id: v.id, label: v.name }));
        if (!qualities.length) throw new Error('Twitch liefert keine Qualitäten');
        info = { id: item.id, source: 'twitch', channel: item.channel, title: item.title, subtitle: item.subtitle, qualities, defaultId: t.defaultId, delay: t.delay || 4, thumb: item.thumb };
      } else if (item.source === 'youtube') {
        info = { id: item.id, source: 'youtube', videoId: item.videoId, title: item.title, subtitle: item.subtitle, qualities: YT_QUALITIES.map(({ id, label }) => ({ id, label })), thumb: item.thumb };
      } else throw new Error('Unbekannte Quelle');
      if (this.loadedId !== item.id) return;
      this.info = info;
      this.ui('room:item', info);
      await this.openExternal();
    } catch (e) {
      this.ui('room:error', `Konnte den Stream nicht laden: ${e.message}`);
    }
  }

  chooseExternalQuality() {
    const info = this.info;
    const ids = info.qualities.map((q) => q.id);
    const want = String((info.source === 'twitch' ? this.settings.prefs.twitchQuality : this.settings.prefs.ytQuality) || '');
    if (ids.includes(want)) return want;
    if (info.source === 'twitch') return ids.includes(info.defaultId) ? info.defaultId : ids[0];
    return 'best';
  }

  /** Twitch braucht die rohen Zeitstempel des Streams (kein Umrechnen auf 0) und den Start am Anfang der Playlist. */
  async setLiveMode(on) {
    const mpv = this.mpv;
    if (!mpv || this.liveMode === on) return;
    this.liveMode = on;
    await mpv.set('rebase-start-time', on ? 'no' : 'yes').catch(() => {});
    await mpv.set('demuxer-lavf-o', on ? 'live_start_index=0' : '').catch(() => {});
    await mpv.set('demuxer-lavf-linearize-timestamps', on ? 'no' : 'auto').catch(() => {});
    // Springen im Puffer auch bei Livestreams (die sind für ffmpeg nicht „seekable“)
    await mpv.set('demuxer-seekable-cache', on ? 'yes' : 'auto').catch(() => {});
  }

  async openExternal(fromPos) {
    const info = this.info;
    if (!info) return;
    const mpv = await this.ensurePlayer();
    const q = this.chooseExternalQuality();
    this.activeQuality = q;
    let url, key;
    const start = Number.isFinite(fromPos) ? fromPos : this.expectedPos();
    if (info.source === 'twitch') {
      key = `${info.id}|${q}|${Math.round(start)}`;
      if (!Number.isFinite(fromPos) && this.loadedKey && this.loadedKey.startsWith(`${info.id}|${q}|`)) return;
      this.twVariant = q;
      await this.refreshTwitchMap();
      this.startTwitchMap();
      // Im Segment knapp vor dem Ziel anfangen: mpv springt dann im Puffer nach vorn
      // oder holt das kurze Stück notfalls über die Geschwindigkeit auf
      url = `${this.relay.base}/live/twitch/${encodeURIComponent(info.channel)}/${encodeURIComponent(q)}.m3u8?from=${Math.round((start - 0.5) * 1000)}`;
      this.twOpenedAt = Date.now();
      this.twNoSeek = false;
    } else {
      key = `${info.id}|${q}`;
      if (key === this.loadedKey) return;
      this.stopTwitchMap();
      const yt = this.installer.ytdlpPath();
      if (yt !== 'yt-dlp' && !fs.existsSync(yt)) {
        // yt-dlp fehlt noch → nachinstallieren (nur Windows, ein paar MB)
        this.ui('room:error', 'yt-dlp wird für YouTube eingerichtet …');
        try { await this.installer.ensureYtDlp(); } catch (e) { this.ui('room:error', `yt-dlp ließ sich nicht installieren: ${e.message}`); return; }
      }
      const h = (YT_QUALITIES.find((x) => x.id === q) || YT_QUALITIES[0]).height;
      const lim = h ? `[height<=${h}]` : '';
      await mpv.set('ytdl-format', `bv*${lim}+ba/b${lim}/bv*+ba/b`).catch(() => {});
      url = `ytdl://${info.videoId}`;
    }
    this.loadedKey = key;
    this.source = { key, url, direct: false, external: info.source };
    this.fileReady = false;
    this.trackSel = null;
    this.lastPlanKey = null;
    await this.setLiveMode(info.source === 'twitch');
    const playing = !!(this.playback && this.playback.playing);
    await mpv.set('http-header-fields', info.source === 'twitch' ? [`Cookie: ${this.relay.cookieHeader}`] : []).catch(() => {});
    await mpv.command('vf', 'clr', '').catch(() => {});
    this.ourPause = !playing;
    await mpv.set('pause', !playing).catch(() => {});
    // YouTube: normale Zeitachse → direkt an die Stelle; Twitch springt nach dem Laden über die Zuordnung
    await mpv.set('start', info.source === 'youtube' && start > 0 ? `+${start.toFixed(3)}` : 'none').catch(() => {});
    this.ourSeekAt = Date.now();
    await mpv.set('force-media-title', `${info.title}${info.subtitle ? ` – ${info.subtitle}` : ''}`).catch(() => {});
    await mpv.command('loadfile', url, 'replace').catch((e) => this.ui('room:error', `mpv: ${e.message}`));
  }

  startTwitchMap() {
    this.stopTwitchMap();
    this.twTimer = setInterval(() => this.refreshTwitchMap().catch(() => {}), 2000);
  }

  stopTwitchMap() {
    if (this.twTimer) clearInterval(this.twTimer);
    this.twTimer = null;
  }

  async refreshTwitchMap() {
    if (!this.isLive()) return;
    const m = await this.relay.request('GET', `/api/twitch/${encodeURIComponent(this.info.channel)}/map?v=${encodeURIComponent(this.twVariant || '')}`, undefined, { timeout: 8000 });
    if (m && Array.isArray(m.segments)) this.twMap = m;
  }

  /** mpv-Zeit (roher PTS des Streams) → Zeitstempel. Berücksichtigt den 33-Bit-Überlauf. */
  twPdtAt(t) {
    const m = this.twMap;
    if (!m || !Number.isFinite(t)) return NaN;
    const W = m.wrap;
    let best = null;
    let near = null;
    for (const s of m.segments) {
      if (s.pts == null) continue;
      let d = ((t - s.pts) % W + W) % W;
      if (d > W / 2) d -= W;
      if (d >= 0 && d < s.dur + 0.3 && (!best || d < best.d)) best = { s, d };
      else if (d < 0 && d > -0.08 && (!near || d > near.d)) near = { s, d };
    }
    const hit = best || near;
    return hit ? hit.s.pdt / 1000 + hit.d : NaN;
  }

  /** Zeitstempel → mpv-Zeit, auf dieselbe Überlauf-Runde wie die aktuelle Position. */
  twCtAt(p) {
    const m = this.twMap;
    if (!m) return NaN;
    const segs = m.segments.filter((s) => s.pts != null);
    if (!segs.length) return NaN;
    let s = segs[0];
    for (const x of segs) { if (x.pdt <= p * 1000 + 1) s = x; else break; }
    const last = segs[segs.length - 1];
    const d = Math.max(0, Math.min(p - s.pdt / 1000, s === last ? s.dur - 0.1 : s.dur - 0.02));
    const raw = s.pts + d;
    const ref = this.mpv && this.mpv.props['time-pos'];
    if (!Number.isFinite(ref)) return raw;
    return raw + Math.round((ref - raw) / m.wrap) * m.wrap;
  }

  /** Im Puffer springen, wenn möglich – sonst den Stream an der Stelle neu öffnen. */
  async twSeek(p) {
    const ct = this.twCtAt(p);
    const mpv = this.mpv;
    if (!mpv) return;
    if (Number.isFinite(ct)) {
      const cache = await mpv.get('demuxer-cache-state').catch(() => null);
      const ranges = (cache && cache['seekable-ranges']) || [];
      if (ranges.some((r) => ct >= r.start - 0.05 && ct <= r.end - 0.3)) { this.seekTo(ct); return; }
    }
    // Gerade erst geöffnet und trotzdem nicht im Puffer → mpv kann hier nicht springen.
    // Dann nicht immer neu öffnen, sondern über die Geschwindigkeit aufholen (siehe syncTick).
    const now = Date.now();
    if (now - (this.twOpenedAt || 0) < 15000) { this.twNoSeek = true; return; }
    if (now - this.lastReopen < 4000) return;
    this.lastReopen = now;
    await this.openExternal(p);
  }

  pushLiveState() {
    const p = (this.mpv && this.mpv.props) || {};
    const segs = (this.twMap && this.twMap.segments) || [];
    const local = this.localPos();
    const cur = Number.isFinite(local) ? local : this.expectedPos();
    const start = segs.length ? segs[0].pdt / 1000 : cur;
    const end = segs.length ? segs[segs.length - 1].pdt / 1000 + segs[segs.length - 1].dur : cur;
    const delay = (this.info && this.info.delay) || 4;
    this.ui('player:state', {
      running: !!(this.mpv && this.mpv.running),
      ready: this.fileReady,
      quality: this.activeQuality || null,
      nextEpisodeId: null,
      pos: Math.max(0, cur - start),
      expected: Math.max(0, this.expectedPos() - start),
      duration: Math.max(0, end - start),
      live: { start, end, behind: Math.max(0, end - delay - cur) },
      state: this.playerStateName(),
      speed: p.speed || 1,
      cache: p['demuxer-cache-time'] || 0,
      vfFps: p['estimated-vf-fps'] || null,
      displayFps: p['display-fps'] || null,
      hwdec: p['hwdec-current'] || null,
      rtt: this.relay.rtt,
    });
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
    this.updateButtons();

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
    // Qualität bei Twitch/YouTube getrennt merken, sonst wäre die Jellyfin-Wahl weg
    if (patch.quality && this.info && this.info.source) {
      const key = this.info.source === 'twitch' ? 'twitchQuality' : 'ytQuality';
      const { quality, ...rest } = patch;
      patch = { ...rest, [key]: quality };
    }
    const prefs = this.settings.setPrefs(patch);
    if (this.info && this.info.source && (patch.twitchQuality || patch.ytQuality)) { this.loadedKey = null; await this.openSource(); }
    if (patch.quality && patch.quality !== before.quality && this.info && !this.info.source) { this.autoQuality = AutoQuality.recommended(this.info); this.autoGuard = new AutoQuality.StallGuard(); this.loadedKey = null; await this.openSource(); }
    if (patch.volume != null && this.mpv) this.mpv.set('volume', Number(patch.volume)).catch(() => {});
    if (patch.framegen || patch.vsr) { this.updateButtons(); this.applyFilters(); }
    return prefs;
  }

  /* ---------- Knöpfe in der uosc-Leiste ---------- */

  buttonData() {
    const prefs = this.settings.prefs;
    const status = this.installer.status();
    const plan = this.planInfo || {};
    const fgOn = !!(prefs.framegen && prefs.framegen.enabled);
    const vsrOn = !!(prefs.vsr && prefs.vsr.enabled);

    let fgTip = 'Framegen aus · F1';
    let badge;
    if (fgOn) {
      const f = plan.framegen;
      if (!status.framegen) fgTip = 'Framegen an, aber noch nicht installiert (Lobby → Player einrichten) · F1';
      else if (f && f.state === 'on') { fgTip = `Framegen an: ${fmtFps(f.from)} → ${fmtFps(f.to)} fps · F1`; badge = f.multi; }
      else if (this.framegen.building || (f && f.state === 'needs-engine')) { fgTip = 'Framegen wird vorbereitet (TensorRT-Engine) · F1'; badge = '…'; }
      else fgTip = `Framegen an${plan.notes && plan.notes.length ? `: ${plan.notes[0]}` : ''} · F1`;
    }

    let vsrTip = 'Upscaling (RTX Super Resolution) aus · F2';
    if (vsrOn) {
      if (process.platform !== 'win32') vsrTip = 'Upscaling gibt es nur unter Windows · F2';
      else if (plan.vsr) vsrTip = `Upscaling an: ${plan.vsr.from}p → ${plan.vsr.to}p · F2`;
      else vsrTip = 'Upscaling an (Video ist schon bildschirmgroß) · F2';
    }

    return {
      wp_framegen: { icon: 'animation', active: fgOn, badge, tooltip: fgTip, command: 'script-message wp framegen' },
      wp_vsr: { icon: 'hd', active: vsrOn, tooltip: vsrTip, command: 'script-message wp vsr' },
    };
  }

  updateButtons(force = false) {
    const mpv = this.mpv;
    if (!mpv || !mpv.running) return;
    for (const [name, data] of Object.entries(this.buttonData())) {
      const json = JSON.stringify(data);
      if (!force && this.lastButtons[name] === json) continue;
      this.lastButtons[name] = json;
      mpv.command('script-message-to', 'uosc', 'set-button', name, json).catch(() => {});
    }
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

  /** Eigene Position auf der Zeitachse des Raums (bei Twitch: Zeitstempel). */
  localPos() {
    const t = this.mpv && this.mpv.props['time-pos'];
    if (!Number.isFinite(t)) return NaN;
    return this.isLive() ? this.twPdtAt(t) : t;
  }

  /** An eine Raum-Position springen. */
  seekLocal(p) {
    if (this.isLive()) this.twSeek(p);
    else this.seekTo(p);
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
    if (!mpv || !pb || !pb.item || pb.item.ext || !this.fileReady) return;
    const pos = this.localPos();
    if (!Number.isFinite(pos)) return;
    const exp = this.expectedPos();
    const fgOn = !!(this.planInfo && this.planInfo.framegen && this.planInfo.framegen.state === 'on');

    if (!pb.playing) {
      this.setPause(true);
      this.setSpeed(1);
      this.correcting = false;
      if (!mpv.props.seeking && !this.pendingSeeks && Math.abs(pos - exp) > 0.15) this.seekLocal(exp);
      return;
    }

    const dur = mpv.props.duration;
    if (!this.isLive() && mpv.props['eof-reached'] && Number.isFinite(dur) && exp >= dur - 1) return;
    this.setPause(false);
    if (mpv.props.seeking || mpv.props['paused-for-cache']) return;

    const diff = exp - pos; // > 0: ich hänge hinterher
    const ad = Math.abs(diff);
    const now = Date.now();
    const hard = fgOn ? 2.5 : 1.5;
    // Twitch ohne Sprung-Möglichkeit: bis 8 s über die Geschwindigkeit (max. ±25 %) statt springen
    const catchUp = this.isLive() && this.twNoSeek && ad < 8;
    if (!catchUp && ad > hard && (force || now - this.lastHardSeek > 4000 || ad > 10)) {
      this.lastHardSeek = now;
      this.setSpeed(1);
      this.correcting = false;
      this.seekLocal(exp + (diff > 0 ? 0.3 : 0));
      return;
    }
    if (ad > 0.25) this.correcting = true;
    if (this.correcting && ad < 0.05) this.correcting = false;
    // Verstärkung 0,4: ein Player, der dauerhaft 5 % zu langsam läuft, bleibt so unter ~0,15 s Abweichung
    const maxAdj = catchUp && ad > 0.5 ? 0.25 : 0.06;
    this.setSpeed(this.correcting ? 1 + Math.max(-maxAdj, Math.min(maxAdj, diff * 0.4)) : 1);
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
    if (!this.playback || !this.playback.item) { this.send({ t: 'status', pos: 0, state: 'idle' }); return; }
    if (this.info && !this.info.source && this.settings.prefs.quality === 'auto' &&
        this.autoGuard.check({ playing: this.playback.playing, buffering: this.playerStateName() === 'buffering', seeking: !!this.mpv?.props.seeking })) {
      const lower = AutoQuality.lower(this.info, this.autoQuality);
      if (lower) { this.autoQuality = lower; this.openSource().catch((e) => this.ui('room:error', e.message)); }
    }
    const local = this.localPos();
    const pos = Number.isFinite(local) ? local : this.expectedPos();
    const msg = { t: 'status', pos, state: this.playerStateName(), drift: Number.isFinite(local) ? this.expectedPos() - local : 0 };
    // YouTube: die Länge kennt nur der Player
    if (this.info && this.info.source === 'youtube' && Number.isFinite(this.mpv && this.mpv.props.duration)) msg.dur = this.mpv.props.duration;
    this.send(msg);
  }

  pushPlayerState() {
    if (!this.code) return;
    this.checkSegment();
    const mpv = this.mpv;
    const p = (mpv && mpv.props) || {};
    if (this.isLive()) return this.pushLiveState();
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
    if (action === 'live') { this.send({ t: 'control', action }); return; } // Server kennt die Live-Kante
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
    const local = this.localPos();
    this.control(this.playback.playing ? 'pause' : 'play', Number.isFinite(local) ? local : this.expectedPos());
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
    installUi(this.configDir);
    fs.writeFileSync(path.join(this.configDir, 'input.conf'), INPUT_CONF);
    fs.writeFileSync(path.join(this.configDir, 'mpv.conf'), MPV_CONF);
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
      // Nicht zu gierig vorladen: auf der geteilten Heim-Leitung (MAX_UPLOAD_MBPS)
      // hungern sonst die anderen Clients, während dieser Puffer füllt.
      // 45 s ≈ Web (hls.js 40 s) und TV (Exo 50 s).
      '--demuxer-readahead-secs=45',
      '--cache-pause-wait=2',
      '--hr-seek=yes',
      '--network-timeout=60',
      '--user-agent=watchparty-desktop/1.0',
      // yt-dlp nur für YouTube (ytdl://-Adressen); Jellyfin- und Twitch-Streams öffnet mpv selbst
      '--ytdl=yes',
      `--script-opts-append=ytdl_hook-ytdl_path=${this.installer.ytdlpPath()}`,
      '--script-opts-append=ytdl_hook-try_ytdl_first=no',
      '--sub-auto=no',
      '--audio-file-auto=no',
      '--save-position-on-quit=no',
      '--osd-font-size=36',
      '--osd-duration=2500',
      '--osd-on-seek=no', // uosc blendet beim Springen selbst die Leiste ein
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
    this.liveMode = null; // neuer Prozess → Optionen neu setzen
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
    this.lastButtons = {};
    // uosc lädt asynchron; was vorher geschickt wird, geht verloren
    for (const ms of [800, 2500]) setTimeout(() => { if (this.mpv === mpv) this.updateButtons(true); }, ms);
    this.ui('player:opened', {});
    return mpv;
  }

  async showPlayer() {
    try {
      await this.ensurePlayer();
      if (this.info && !this.loadedKey) await this.openSource();
      else if (this.playback && this.playback.item && !this.info) {
        if (this.playback.item.source) await this.loadExternal(this.playback.item);
        else await this.loadItem(this.playback.item.id);
      }
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
      this.control(value ? 'pause' : 'play', this.localPos());
    } else if (name === 'sid' || name === 'aid') {
      this.onTrackProp(name, value);
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
          const pos = this.localPos();
          if (Number.isFinite(pos)) {
            // kurz warten, bis time-pos aktuell ist
            setTimeout(() => {
              const p = this.localPos();
              this.control('seek', Number.isFinite(p) ? p : pos);
            }, 50);
          }
        }
        break;
      case 'end-file':
        if (e.reason === 'error') {
          this.ui('room:error', this.info && this.info.source === 'youtube'
            ? 'YouTube-Video ließ sich nicht öffnen (yt-dlp). Eine niedrigere Qualität oder ein Update von yt-dlp hilft oft.'
            : 'mpv konnte die Datei nicht öffnen. Mit einer niedrigeren Qualität klappt es vielleicht.');
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

/** uosc, Schriften und script-opts in den mpv-Config-Ordner legen (alte uosc-Version vorher weg). */
function installUi(configDir, from = UI_DIR) {
  if (!fs.existsSync(from)) return false;
  fs.rmSync(path.join(configDir, 'scripts', 'uosc'), { recursive: true, force: true });
  fs.cpSync(from, configDir, { recursive: true, force: true });
  return true;
}

function fmtFps(f) { return Number.isFinite(f) ? (Math.round(f * 100) / 100).toString().replace('.', ',') : '?'; }

module.exports = { Session, INPUT_CONF, MPV_CONF, installUi };

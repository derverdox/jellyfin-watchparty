'use strict';
/** Player-Oberfläche (uosc): Dateien, Menü, Knöpfe und Untertitel-Standard. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Session, INPUT_CONF, MPV_CONF, installUi } = require('../src/main/session');
const { DEFAULT_PREFS, merge } = require('../src/main/settings');

const UI = path.join(__dirname, '..', 'mpv-ui');

function fakeSession(prefs = {}, status = {}) {
  const relay = new EventEmitter();
  const framegen = new EventEmitter();
  const settings = {
    prefs: merge(DEFAULT_PREFS, prefs),
    setPrefs(p) { this.prefs = merge(this.prefs, p); return this.prefs; },
  };
  const installer = { status: () => ({ supported: true, base: true, framegen: true, models: ['v4_26'], ...status }) };
  const s = new Session({ relay, settings, installer, framegen, configDir: os.tmpdir(), logDir: os.tmpdir() });
  clearInterval(s.syncTimer); clearInterval(s.statusTimer); clearInterval(s.uiTimer);
  return s;
}

/** Minimaler mpv-Ersatz, der Befehle und gesetzte Eigenschaften mitschreibt. */
function fakeMpv(tracks) {
  const vals = { aid: 1, sid: 2 };
  return {
    running: true,
    props: { 'track-list': tracks },
    calls: [],
    command(...a) { this.calls.push(a); return Promise.resolve(); },
    osd(text) { this.calls.push(['osd', text]); },
    set(k, v) { this.calls.push(['set', k, v]); vals[k] = v === 'no' ? false : v; return Promise.resolve(); },
    get(k) { return Promise.resolve(k === 'track-list' ? tracks : vals[k]); },
  };
}

test('uosc liegt vollständig bei und wird in den Config-Ordner kopiert', () => {
  for (const f of ['scripts/uosc/main.lua', 'scripts/uosc/lib/buttons.lua', 'scripts/uosc/intl/de.json', 'fonts/uosc_icons.otf', 'fonts/uosc_textures.ttf', 'script-opts/uosc.conf']) {
    assert.ok(fs.existsSync(path.join(UI, f)), `${f} fehlt`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ui-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts', 'uosc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'uosc', 'veraltet.lua'), '--');
    assert.ok(installUi(dir));
    assert.ok(fs.existsSync(path.join(dir, 'scripts', 'uosc', 'main.lua')));
    assert.ok(fs.existsSync(path.join(dir, 'fonts', 'uosc_icons.otf')));
    assert.ok(!fs.existsSync(path.join(dir, 'scripts', 'uosc', 'veraltet.lua')), 'alte uosc-Dateien bleiben liegen');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mpv.conf schaltet die alte Leiste ab, uosc.conf hat die Watchparty-Knöpfe', () => {
  assert.match(MPV_CONF, /^osc=no$/m);
  const conf = fs.readFileSync(path.join(UI, 'script-opts', 'uosc.conf'), 'utf8');
  const controls = /^controls=(.*)$/m.exec(conf)[1].split(',');
  assert.ok(controls.includes('button:wp_framegen'));
  assert.ok(controls.includes('button:wp_vsr'));
  // Diese würden am Raum vorbei steuern
  for (const bad of ['speed', 'prev', 'next', 'items', 'shuffle', 'loop-file', 'loop-playlist']) {
    assert.ok(!controls.some((c) => c.replace(/^<[^>]*>/, '').split(':')[0] === bad), `${bad} gehört nicht in die Leiste`);
  }
});

test('input.conf: Hotkeys und uosc-Menü (so geparst wie uosc es tut)', () => {
  const binds = {};
  const menu = [];
  for (const line of INPUT_CONF.split('\n')) {
    // entspricht '%s*([%S]+)%s+([^#]*)%s*(.-)%s*$' in uosc/lib/menus.lua
    const m = /^\s*(\S+)\s+([^#]*)\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, key, cmd, comment] = m;
    if (key !== '#') binds[key] = cmd.trim();
    const title = /^#!\s*(.*)$/.exec(comment);
    if (title) menu.push(title[1]);
  }
  assert.equal(binds.F1, 'script-message wp framegen');
  assert.equal(binds.F2, 'script-message wp vsr');
  assert.equal(binds.SPACE, 'script-message wp toggle');
  assert.equal(binds.MENU, 'script-binding uosc/menu');
  for (const t of ['Untertitel', 'Framegen an/aus', 'Upscaling (RTX VSR) an/aus', 'Player schließen']) assert.ok(menu.includes(t), `Menüeintrag ${t}`);
});

test('Knöpfe zeigen den Zustand von Framegen und Upscaling', async () => {
  const s = fakeSession({ framegen: { enabled: true }, vsr: { enabled: false } });
  s.planInfo = { framegen: { state: 'on', from: 23.976, to: 143.856, multi: '6×' }, vsr: null, notes: [] };
  let b = s.buttonData();
  assert.equal(b.wp_framegen.active, true);
  assert.equal(b.wp_framegen.badge, '6×');
  assert.match(b.wp_framegen.tooltip, /23,98 → 143,86 fps/);
  assert.equal(b.wp_framegen.command, 'script-message wp framegen');
  assert.equal(b.wp_vsr.active, false);
  assert.equal(b.wp_vsr.command, 'script-message wp vsr');

  // Knopf/Hotkey schaltet um und schickt den neuen Zustand an uosc
  s.mpv = fakeMpv([]);
  s.onClientMessage(['wp', 'vsr']);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.settings.prefs.vsr.enabled, true);
  const sent = s.mpv.calls.filter((c) => c[0] === 'script-message-to' && c[2] === 'set-button' && c[3] === 'wp_vsr');
  assert.ok(sent.length, 'set-button an uosc geschickt');
  assert.equal(JSON.parse(sent[sent.length - 1][4]).active, true);

  // Nicht installiert → trotzdem ein sinnvoller Hinweis
  const s2 = fakeSession({ framegen: { enabled: true } }, { framegen: false });
  b = s2.buttonData();
  assert.match(b.wp_framegen.tooltip, /nicht installiert/);
});

test('Empfehlungen am Filmende: Menü im Player, Auswahl geht an den Raum', async () => {
  const s = fakeSession();
  const sent = [];
  s.send = (m) => { sent.push(m); return true; };
  s.mpv = fakeMpv([]);
  const A = 'a'.repeat(32), B = 'b'.repeat(32), SER = 'c'.repeat(32);
  const recs = { item: { id: 'f'.repeat(32), title: 'Batman Begins' }, items: [
    { id: A, name: 'The Dark Knight', type: 'Movie', year: 2008, rating: 9.0, reasons: ['Regie: Christopher Nolan'], seenBy: ['Lea'] },
    { id: SER, name: 'Gotham', type: 'Series', year: 2014 },
    { id: B, name: 'The Prestige', type: 'Movie', year: 2006, rating: 8.5, reasons: [] },
  ] };
  s.onMessage({ t: 'recs', recs });
  const open = s.mpv.calls.find((c) => c[0] === 'script-message-to' && c[1] === 'uosc' && c[2] === 'open-menu');
  assert.ok(open, 'Menü in mpv geöffnet');
  const menu = JSON.parse(open[3]);
  assert.equal(menu.type, 'wp-recs');
  assert.deepEqual(menu.items.filter((i) => i.items).map((i) => i.title), ['The Dark Knight', 'The Prestige'], 'Serien nur im Fenster');
  assert.equal(menu.items[0].hint, '2008 · ★ 9');
  const sub = menu.items[0].items;
  assert.ok(sub.some((i) => i.title === 'Regie: Christopher Nolan' && i.selectable === false));
  assert.ok(sub.some((i) => /Schon gesehen: Lea/.test(i.title)));
  const play = sub.find((i) => /abspielen/.test(i.title));
  assert.deepEqual(play.value, ['script-message', 'wp', 'reco', 'load', A]);

  // Auswahl im Menü kommt als script-message zurück
  s.onClientMessage(play.value.slice(1));
  assert.deepEqual(sent.pop(), { t: 'load', itemId: A });
  s.onClientMessage(['wp', 'reco', 'queue', B]);
  assert.deepEqual(sent.pop(), { t: 'queue-add', itemId: B });
  s.onClientMessage(['wp', 'reco', 'suggest', B]);
  assert.deepEqual(sent.pop(), { t: 'suggest', itemId: B });
  s.onClientMessage(['wp', 'reco', 'load', 'kaputt']);
  assert.equal(sent.length, 0, 'ungültige ID wird ignoriert');

  // Zurückgespult → Menü zu
  s.onMessage({ t: 'recs', recs });
  s.onMessage({ t: 'recs', recs: null });
  assert.ok(s.mpv.calls.some((c) => c[2] === 'close-menu' && c[3] === 'wp-recs'), 'Menü geschlossen');
});

test('Untertitel sind standardmäßig aus, auch bei „Standard“-Spur in der Datei', async () => {
  assert.equal(DEFAULT_PREFS.subLang, 'off');
  const tracks = [
    { id: 1, type: 'audio', lang: 'ger', selected: true },
    { id: 1, type: 'sub', lang: 'ger', default: true, selected: false },
    { id: 2, type: 'sub', lang: 'eng', default: false, selected: true },
  ];
  for (const subLang of ['off', '']) { // '' = alte gespeicherte Einstellung
    const s = fakeSession({ subLang });
    s.mpv = fakeMpv(tracks);
    s.info = { subs: [], audio: [] };
    s.source = { direct: false };
    await s.selectTracks();
    assert.deepEqual(s.mpv.calls.filter((c) => c[0] === 'set' && c[1] === 'sid').pop(), ['set', 'sid', 'no'], `subLang=${JSON.stringify(subLang)}`);
  }
  // Wer eine Sprache gewählt hat, bekommt sie weiter
  const s = fakeSession({ subLang: 'ger' });
  s.mpv = fakeMpv(tracks);
  s.info = { subs: [], audio: [] };
  s.source = { direct: false };
  await s.selectTracks();
  assert.deepEqual(s.mpv.calls.filter((c) => c[0] === 'set' && c[1] === 'sid').pop(), ['set', 'sid', 1]);
});

test('Untertitel-Wechsel im uosc-Menü wird gemerkt, eigene Auswahl nicht', async () => {
  const tracks = [{ id: 1, type: 'sub', lang: 'GER' }, { id: 2, type: 'sub', lang: 'eng' }];
  const s = fakeSession({ subLang: 'off' });
  s.mpv = fakeMpv(tracks);
  s.info = { subs: [], audio: [] };
  s.source = { direct: true };
  s.fileReady = true;
  await s.selectTracks();
  s.onProp('sid', false); // Echo der eigenen Auswahl
  assert.equal(s.settings.prefs.subLang, 'off');
  s.onProp('sid', 1); // Nutzer wählt im Menü
  assert.equal(s.settings.prefs.subLang, 'ger');
  s.onProp('sid', false);
  assert.equal(s.settings.prefs.subLang, 'off');
});

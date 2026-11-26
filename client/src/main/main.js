'use strict';
/* Watchparty Desktop – Hauptprozess */
const { app, BrowserWindow, ipcMain, protocol, shell, clipboard, safeStorage, screen, Menu, session: electronSession } = require('electron');
const path = require('path');
const { RelayClient } = require('./relay');
const { Settings } = require('./settings');
const { Installer, MODELS, detectGpu, recommend } = require('./installer');
const { Framegen } = require('./framegen');
const { Session } = require('./session');
const { Updater } = require('./updater');

if (!app.requestSingleInstanceLock()) app.quit();

protocol.registerSchemesAsPrivileged([{ scheme: 'wpimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const VPY_DIR = path.join(__dirname, '..', '..', 'vpy').replace('app.asar', 'app.asar.unpacked');

let win = null;
let settings, relay, installer, framegen, session, updater;
let gpu = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('evt', channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0c0c10',
    title: 'Watchparty',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#0c0c10', symbolColor: '#ececf1', height: 38 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err), status: err.status }; }
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  settings = new Settings(userData, safeStorage);
  relay = new RelayClient();
  installer = new Installer(path.join(userData, 'components'), VPY_DIR);
  framegen = new Framegen(installer, VPY_DIR, path.join(userData, 'components', 'engines.json'));
  session = new Session({
    relay, settings, installer, framegen,
    configDir: path.join(userData, 'mpv-config'),
    logDir: path.join(userData, 'logs'),
    host: {
      nativeHandle: () => (win && !win.isDestroyed() ? win.getNativeWindowHandle() : null),
      scaleFactor: () => (win && !win.isDestroyed() && screen.getDisplayMatching(win.getBounds()).scaleFactor) || 1,
      enterFullscreen: () => { if (win && !win.isDestroyed() && !win.isFullScreen()) win.setFullScreen(true); },
      exitFullscreen: () => { if (win && !win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false); },
      toggleFullscreen: () => { if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen()); },
    },
  });
  installer.syncScripts();
  installer.updateYtDlp(); // YouTube ändert oft etwas → yt-dlp aktuell halten

  if (settings.data.server) { try { relay.setServer(settings.data.server); } catch { /* egal */ } }
  relay.setSession(settings.getSession());
  relay.on('session', (sid) => settings.setSession(sid));
  session.on('ui', (ch, payload) => send(ch, payload));
  if (process.platform === 'win32') {
    win.on('enter-full-screen', () => session.onHostFullscreen(true));
    win.on('leave-full-screen', () => session.onHostFullscreen(false));
    let movedTimer = 0;
    win.on('move', () => { clearTimeout(movedTimer); movedTimer = setTimeout(() => session.onHostMoved(), 120); }); // Monitorwechsel: anderer Scale-Faktor
    win.on('resize', () => session.onHostMoved());
  }
  installer.on('progress', (p) => send('setup:progress', p));

  // Bilder vom Relay (brauchen das Sitzungs-Cookie) → wpimg://img/<id>?w=300
  protocol.handle('wpimg', async (req) => {
    const u = new URL(req.url);
    const id = u.pathname.replace(/^\//, '');
    if (!/^[a-f0-9-]{32,36}$/i.test(id)) return new Response('bad', { status: 400 });
    try {
      const res = await relay.request('GET', `/img/${id}${u.search}`, undefined, { raw: true });
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=86400' } });
    } catch { return new Response('', { status: 502 }); }
  });

  detectGpu().then((g) => { gpu = g; send('sys:gpu', g); });

  // Updates nur in der installierten Windows-App (nicht beim Entwickeln mit „npm start“)
  updater = new Updater({ current: app.getVersion(), dir: path.join(userData, 'updates'), enabled: app.isPackaged && process.platform === 'win32' });
  updater.on('state', (st) => send('update:state', st));
  updater.start();
  handle('update:state', () => updater.state);
  handle('update:check', () => updater.check({ manual: true }));
  handle('update:install', () => {
    if (!updater.install(true)) throw new Error('Kein Update bereit');
    app.quit(); // der Installer wartet, bis die App zu ist, und startet sie danach neu
    return true;
  });

  /* ---------- Anmeldung ---------- */
  handle('auth:state', async () => {
    const base = { server: settings.data.server, username: settings.data.username, me: null };
    if (!relay.base || !relay.sid) return base;
    try { base.me = await relay.me(); } catch (e) { if (e.status === 401) { relay.setSession(null); settings.setSession(null); } else base.offline = e.message; }
    return base;
  });
  handle('auth:login', async ({ server, username, password, remember }) => {
    relay.setServer(server);
    relay.setSession(null);
    const me = await relay.login(username, password);
    settings.data.server = relay.base;
    settings.data.username = username;
    settings.setSession(remember === false ? null : relay.sid);
    return me;
  });
  handle('auth:inviteCheck', async ({ server, code }) => {
    relay.setServer(server);
    return relay.inviteValid(code);
  });
  handle('auth:register', async ({ server, code, username, password }) => {
    relay.setServer(server);
    relay.setSession(null);
    const me = await relay.register(code, username, password);
    settings.data.server = relay.base;
    settings.data.username = username;
    settings.setSession(relay.sid);
    return me;
  });
  handle('auth:name', async (name) => {
    const me = await relay.setName(name);
    if (session.code) session.send({ t: 'rename', name: me.name });
    return me;
  });
  handle('auth:password', ({ old, password }) => relay.changePassword(old, password));
  handle('auth:me', () => relay.me());
  handle('auth:logout', async () => {
    await session.leave();
    try { await relay.logout(); } catch { /* egal */ }
    settings.setSession(null);
    return true;
  });

  /* ---------- Räume ---------- */
  handle('room:create', async () => {
    const { code } = await relay.createRoom();
    session.join(code);
    return { code };
  });
  handle('room:join', async (code) => {
    const c = String(code || '').trim().toUpperCase().replace(/^.*\/R\//, '').replace(/[^A-Z0-9]/g, '');
    if (!c) throw new Error('Bitte einen Raum-Code eingeben');
    await relay.roomInfo(c);
    session.join(c);
    return { code: c };
  });
  // Alleine schauen: eigener Raum (wird wiederverwendet), Freunde kommen per Link dazu
  handle('room:solo', async () => {
    const { code } = await relay.request('POST', '/api/rooms', { solo: true });
    session.join(code);
    return { code };
  });
  handle('room:private', (v) => session.send({ t: 'settings', private: !!v }));
  handle('room:leave', () => session.leave());
  handle('room:control', ({ action, position }) => session.control(action, position));
  handle('room:toggle', () => session.togglePlay());
  handle('room:seekBy', (d) => session.seekBy(d));
  handle('room:chat', (text) => session.send({ t: 'chat', text }));
  handle('room:react', (emoji) => session.send({ t: 'react', emoji }));
  handle('room:load', (itemId) => session.send({ t: 'load', itemId }));
  handle('room:suggest', (itemId) => session.send({ t: 'suggest', itemId }));
  handle('room:allowAll', (v) => session.send({ t: 'settings', allowAllControl: !!v }));
  handle('room:makeHost', (clientId) => session.send({ t: 'makeHost', clientId }));
  handle('room:kick', (clientId) => session.send({ t: 'kick', clientId }));
  handle('room:invite', () => relay.createInvite().then((r) => ({ ...r, url: `${relay.base}${r.path}` })));
  handle('room:link', () => ({ url: `${relay.base}/r/${session.code}` }));

  /* ---------- Bibliothek ---------- */
  handle('lib:libraries', () => relay.libraries());
  handle('lib:items', (params) => relay.items(params));
  handle('lib:item', (id) => relay.item(id));
  handle('lib:search', (q) => relay.search(q));
  handle('lib:watchlist', () => relay.watchlist());
  handle('lib:toggleWatch', (id) => relay.toggleWatch(id));
  handle('lib:history', () => relay.history());
  handle('lib:clearHistory', (id) => relay.clearHistory(id));

  /* ---------- Zusatzfunktionen (Serien, Bewertungen, Brett, Profil …) ---------- */
  // Der Renderer darf nur diese Endpunkte über das eigene Konto aufrufen
  const ID = '[a-f0-9-]{32,36}';
  const API_ALLOW = [
    ['GET', new RegExp(`^/api/details/${ID}$`, 'i')],
    ['GET', new RegExp(`^/api/show/${ID}(\\?room=[A-Z0-9]{4,12})?$`, 'i')],
    ['GET', /^\/api\/(top-rated|profile|libraries|history|watchlist|activity)$/],
    ['GET', /^\/api\/items\?[\w=&%.-]*$/],
    ['GET', /^\/api\/catalog\?[\w=&%.,-]*$/],
    ['GET', /^\/api\/search\?q=[^#]*$/],
    ['GET', /^\/api\/random(\?[\w=&%.-]*)?$/],
    ['GET', /^\/api\/wishes(\?[\w=&%.-]*)?$/],
    ['GET', /^\/api\/wishes\/check\?q=[^#]*$/],
    ['POST', /^\/api\/(watched|rate|wishes|wishes\/seen)$/],
    ['POST', /^\/api\/watchlist$/],
    ['POST', /^\/api\/wishes\/[a-z0-9]{4,40}\/(vote|tag)$/i],
    ['PATCH', /^\/api\/wishes\/[a-z0-9]{4,40}$/i],
    ['DELETE', /^\/api\/wishes\/[a-z0-9]{4,40}$/i],
  ];
  handle('api', ({ path: p, method = 'GET', body } = {}) => {
    const m = String(method).toUpperCase();
    const ps = String(p || '');
    if (!API_ALLOW.some(([mm, re]) => mm === m && re.test(ps))) throw new Error('Nicht erlaubt');
    return relay.request(m, ps, m === 'GET' ? undefined : (body || {}));
  });
  const SEND_ALLOW = new Set(['load', 'load-url', 'load-ext', 'suggest', 'queue-add', 'queue-remove', 'queue-move', 'queue-clear', 'queue-play', 'poll-start', 'poll-vote', 'poll-end']);
  handle('room:send', (msg) => {
    if (!msg || !SEND_ALLOW.has(msg.t)) throw new Error('Nicht erlaubt');
    return session.send(msg);
  });

  /* ---------- Verwaltung im eigenen Fenster ---------- */
  let adminWin = null;
  handle('admin:open', async () => {
    if (adminWin && !adminWin.isDestroyed()) { adminWin.focus(); return true; }
    const ses = electronSession.fromPartition('persist:wp-admin');
    await ses.cookies.set({ url: relay.base, name: 'wp_sid', value: relay.sid, httpOnly: true, secure: relay.base.startsWith('https:'), sameSite: 'lax' });
    adminWin = new BrowserWindow({
      width: 1440, height: 920, minWidth: 900, minHeight: 600, backgroundColor: '#0b0b0f', title: 'Verwaltung · Watchparty',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.png'), autoHideMenuBar: true,
      webPreferences: { partition: 'persist:wp-admin', contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    adminWin.loadURL(`${relay.base}/admin`);
    adminWin.webContents.setWindowOpenHandler(({ url }) => {
      // „Beitreten“ in der Verwaltung → Raum im Client öffnen
      const m = /\/r\/([A-Za-z0-9]{4,12})/.exec(url);
      if (m && url.startsWith(relay.base)) { session.join(m[1].toUpperCase()); send('room:joined', { code: m[1].toUpperCase() }); if (win) win.focus(); }
      else if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    adminWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(relay.base)) { e.preventDefault(); shell.openExternal(url); } });
    adminWin.on('closed', () => { adminWin = null; });
    return true;
  });

  /* ---------- YouTube/Twitch: Website im eigenen Fenster ---------- */
  let extWin = null;
  handle('ext:window', async ({ code, url } = {}) => {
    let c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!c) c = (await relay.request('POST', '/api/rooms', { solo: true })).code;
    const ses = electronSession.fromPartition('persist:wp-web');
    await ses.cookies.set({ url: relay.base, name: 'wp_sid', value: relay.sid, httpOnly: true, secure: relay.base.startsWith('https:'), sameSite: 'lax' });
    const target = `${relay.base}/r/${c}${url ? `?ext=${encodeURIComponent(String(url).slice(0, 500))}` : ''}`;
    if (extWin && !extWin.isDestroyed()) { extWin.loadURL(target); extWin.focus(); return { code: c }; }
    extWin = new BrowserWindow({
      width: 1280, height: 800, minWidth: 640, minHeight: 400, backgroundColor: '#000000', title: 'YouTube & Twitch · Watchparty',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.png'), autoHideMenuBar: true,
      webPreferences: { partition: 'persist:wp-web', contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    extWin.loadURL(target);
    extWin.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:\/\//.test(u)) shell.openExternal(u); return { action: 'deny' }; });
    extWin.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(relay.base)) { e.preventDefault(); shell.openExternal(u); } });
    extWin.on('closed', () => { extWin = null; });
    return { code: c };
  });

  /* ---------- Player ---------- */
  handle('player:show', () => session.showPlayer());
  handle('player:close', () => session.stopPlayer());
  handle('player:tracks', () => session.tracks());
  handle('player:setTrack', ({ type, id }) => session.setTrack(type, id));
  handle('player:fullscreen', () => session.requestFullscreenToggle());
  // Fenster-Einbettung: Renderer meldet das Buehnen-Rechteck (CSS-px), main skaliert auf physische Pixel
  handle('player:stage', (rect) => { session.setStage(rect); return true; });
  handle('player:embed-info', () => ({ embedded: session.embedAvailable() }));

  /* ---------- Einstellungen & Einrichtung ---------- */
  handle('prefs:get', () => settings.prefs);
  handle('prefs:set', (patch) => session.setPrefs(patch));
  handle('setup:status', () => ({
    ...installer.status(),
    gpu,
    recommended: recommend(gpu),
    models: installer.status().models,
    modelList: Object.entries(MODELS).map(([key, m]) => ({ key, label: m.label })),
    engines: framegen.engines(),
    building: framegen.building ? framegen.building.key : null,
    platform: process.platform,
    setupDone: !!settings.data.setupDone,
  }));
  handle('setup:install', async ({ what, model }) => {
    await installer.run(what, model);
    settings.data.setupDone = true;
    settings.save();
    return installer.status();
  });
  handle('setup:cancel', () => { installer.cancel(); framegen.cancelBuild(); return true; });
  handle('setup:skip', () => { settings.data.setupDone = true; settings.save(); return true; });
  handle('setup:openFolder', () => shell.openPath(installer.root));
  handle('setup:openLogs', () => shell.openPath(path.join(userData, 'logs')));

  handle('sys:displays', () => screen.getAllDisplays().map((d, i) => ({ index: i, label: `${d.label || `Bildschirm ${i + 1}`} · ${d.size.width}×${d.size.height} @ ${Math.round(d.displayFrequency || 60)} Hz`, primary: d.id === screen.getPrimaryDisplay().id })));
  handle('util:copy', (text) => { clipboard.writeText(String(text)); return true; });
  handle('util:open', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });

  createWindow();
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting || !session) return;
  e.preventDefault();
  quitting = true;
  try { await session.destroy(); } finally {
    // Fertig geladenes Update still beim Beenden installieren
    if (updater) updater.install(false);
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());

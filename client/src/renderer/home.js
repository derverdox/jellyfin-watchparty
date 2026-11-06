'use strict';
/**
 * Startseite im Streaming-Stil: großes Titelbild, Reihen zum Durchscrollen,
 * Filme/Serien/Meine Liste, Suche und eine Freundesliste (wer schaut gerade was).
 *
 * Abspielen geht ohne Raum: playSolo() öffnet den eigenen Raum, Freunde kommen per
 * Link oder über „Mitschauen“ dazu. „Zusammen schauen“ führt zur alten Lobby.
 * Die Datei ist in relay/public und client/src/renderer identisch (Test prüft das).
 * Gemeinsame Helfer beider Oberflächen: el, S, toast, colorFor, showView; WP.* aus extras.js.
 * Was sich unterscheidet, kommt über window.WPX:
 *   api(path, opts), img(id, w, type), playSolo(itemId, pos), joinRoom(code),
 *   showLobby(), goHome(), openFolder(item), playExt(url)
 */
(function home() {
  const q = (s) => document.querySelector(s);
  const H = {
    tab: 'start', libs: null, cache: new Map(), friendsTimer: null, search: '', searchTimer: null,
    hero: null, gridState: null,
  };
  const body = () => q('#nf-body');
  const isTv = () => document.documentElement.classList.contains('tv');
  const env = window.WPX;
  const api = (p, o) => env.api(p, o);
  const playSolo = (id, pos) => env.playSolo(id, pos);

  /* ---------------- Daten (mit kurzem Cache) ---------------- */

  async function cached(key, ms, fn) {
    const hit = H.cache.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.data;
    const data = await fn();
    H.cache.set(key, { at: Date.now(), data });
    return data;
  }
  const libraries = () => cached('libs', 10 * 60e3, async () => (await api('/api/libraries')).items || []);
  const libItems = (lib, sort, limit = 24, start = 0) => cached(`items|${lib.id}|${sort}|${limit}|${start}`, 5 * 60e3, async () => {
    const p = new URLSearchParams({ parentId: lib.id, sort, limit: String(limit), start: String(start) });
    if (lib.collectionType === 'movies' || lib.collectionType === 'tvshows') p.set('collectionType', lib.collectionType);
    return api(`/api/items?${p}`);
  });
  const loadHistory = () => cached('history', 15e3, async () => (await api('/api/history')).items || []);
  const watchlist = () => cached('watchlist', 15e3, async () => (await api('/api/watchlist')).items || []);
  const topRated = () => cached('top', 5 * 60e3, async () => (await api('/api/top-rated')).items || []).catch(() => []);
  const movieLibs = (libs) => libs.filter((l) => l.collectionType === 'movies');
  const showLibs = (libs) => libs.filter((l) => l.collectionType === 'tvshows');

  /* ---------------- Bausteine ---------------- */

  const imgUrl = (id, w, type) => env.img(id, w, type);
  const runtime = (s) => (s ? (s >= 3600 ? `${Math.floor(s / 3600)} Std. ${Math.round((s % 3600) / 60)} Min.` : `${Math.round(s / 60)} Min.`) : null);
  const epLabel = (it) => (it.type === 'Episode' && it.index != null ? `S${it.parentIndex ?? '?'}:F${it.index}` : null);

  function picture(src, alt, cls = '') {
    const box = el('div', { class: `nf-pic ${cls}` }, el('span', { class: 'nf-pic-alt' }, alt));
    const im = el('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
    im.addEventListener('load', () => box.classList.add('ok'));
    im.addEventListener('error', () => im.remove());
    box.prepend(im);
    return box;
  }

  function open(it) {
    if (it.playable || it.type === 'Series') { WP.openDetail(it); return; }
    if (it.isFolder || it.type === 'BoxSet' || it.type === 'Season') env.openFolder(it);
  }

  function card(it, opts = {}) {
    const title = it.name || it.title || '';
    const wide = !!opts.wide;
    const src = wide
      ? (it.type === 'Episode' ? imgUrl(it.id, 560) : imgUrl(it.seriesId || it.id, 560, 'Backdrop'))
      : imgUrl(it.type === 'Episode' && it.seriesId ? it.seriesId : it.id, 320);
    const sub = opts.sub || null;
    const c = el('div', {
      class: `nf-card${wide ? ' wide' : ''}${opts.rank ? ' ranked' : ''}`, tabindex: 0, role: 'button', title,
      onclick: () => (opts.onOpen ? opts.onOpen(it) : open(it)),
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); (opts.onOpen ? opts.onOpen(it) : open(it)); } },
    },
    opts.rank ? el('span', { class: 'nf-rank' }, String(opts.rank)) : null,
    el('div', { class: 'nf-art' },
      picture(src, title),
      opts.progress != null ? el('div', { class: 'nf-progress' }, el('i', { style: `width:${Math.min(100, Math.max(2, opts.progress))}%` })) : null,
      it.played && !wide ? el('span', { class: 'nf-seen', title: 'Gesehen' }, '✓') : null,
      wide ? el('span', { class: 'nf-play' }, '▶') : null),
    el('div', { class: 'nf-cap' }, el('b', {}, title), sub ? el('span', {}, sub) : null));
    return c;
  }

  function row(title, items, opts = {}) {
    if (!items || !items.length) return null;
    const scroller = el('div', { class: 'nf-scroller' }, items.map((it, i) => card(it, { ...opts, rank: opts.ranked ? i + 1 : null, sub: opts.subOf ? opts.subOf(it) : null, progress: opts.progressOf ? opts.progressOf(it) : null })));
    const prev = el('button', { class: 'nf-arrow l', tabindex: -1, 'aria-label': 'Zurück', onclick: () => scroller.scrollBy({ left: -scroller.clientWidth * 0.85, behavior: 'smooth' }) }, '‹');
    const next = el('button', { class: 'nf-arrow r', tabindex: -1, 'aria-label': 'Weiter', onclick: () => scroller.scrollBy({ left: scroller.clientWidth * 0.85, behavior: 'smooth' }) }, '›');
    return el('section', { class: `nf-row${opts.ranked ? ' top10' : ''}` },
      el('h3', {}, title, opts.more ? el('button', { class: 'nf-more', onclick: opts.more }, 'Alle ›') : null),
      el('div', { class: 'nf-rowwrap' }, prev, scroller, next));
  }

  function grid(title, items, more) {
    const g = el('div', { class: 'nf-grid' }, items.map((it) => card(it)));
    const sec = el('section', { class: 'nf-row' }, el('h3', {}, title), g);
    if (more) sec.append(el('div', { class: 'nf-loadmore' }, more));
    return sec;
  }

  /* ---------------- Titelbild (Hero) ---------------- */

  function hero(it, inList) {
    const isSeries = it.type === 'Series';
    const meta = [it.year, it.rating ? `★ ${String(it.rating).replace('.', ',')}` : null, !isSeries ? runtime(it.runtime) : 'Serie', it.officialRating].filter(Boolean);
    let listed = inList;
    const listBtn = el('button', { class: 'btn nf-ghost', onclick: async () => {
      try {
        const r = await api('/api/watchlist', { method: 'POST', body: { itemId: it.id } });
        listed = r.on; listBtn.textContent = r.on ? '✓ Meine Liste' : '＋ Meine Liste';
        H.cache.delete('watchlist');
        toast(r.on ? 'Zu „Meine Liste“ hinzugefügt' : 'Aus „Meine Liste“ entfernt');
      } catch (e) { toast(e.message); }
    } }, listed ? '✓ Meine Liste' : '＋ Meine Liste');
    return el('section', { class: 'nf-hero' },
      el('div', { class: 'nf-hero-bg' }, picture(imgUrl(it.id, 1600, 'Backdrop'), '', 'bg')),
      el('div', { class: 'nf-hero-shade' }),
      el('div', { class: 'nf-hero-text' },
        el('div', { class: 'nf-kicker' }, isSeries ? 'SERIE' : 'FILM', el('span', {}, ' · Neu bei euch')),
        el('h1', {}, it.name),
        el('div', { class: 'nf-meta' }, meta.join('  ·  ')),
        it.overview ? el('p', { class: 'nf-overview' }, it.overview) : null,
        el('div', { class: 'nf-hero-actions' },
          el('button', { class: 'btn primary nf-playbtn', onclick: () => (isSeries ? WP.openDetail(it) : playSolo(it.id, 0)) }, isSeries ? '▶ Ansehen' : '▶ Abspielen'),
          el('button', { class: 'btn nf-ghost', onclick: () => WP.openDetail(it) }, 'ⓘ Mehr Infos'),
          listBtn)));
  }

  /* ---------------- Freunde (wie Discord) ---------------- */

  const STATE = { watching: 'schaut', paused: 'pausiert', room: 'im Raum', private: 'in einem privaten Raum', online: 'online' };

  function friendCard(f) {
    const color = colorFor(f.name);
    let line = STATE[f.state] || '';
    let detail = null;
    if (f.item && !f.item.hidden) {
      detail = f.item.type === 'Episode' && f.item.subtitle ? `${f.item.title} · ${f.item.subtitle}` : f.item.title;
    } else if (f.item && f.item.hidden) detail = 'etwas, das du nicht siehst';
    if (f.room && f.room.members > 1) line += ` · ${f.room.members} im Raum`;
    const join = f.room ? el('button', { class: 'btn small primary', onclick: (e) => { e.stopPropagation(); joinRoom(f.room.code); } }, f.state === 'watching' || f.state === 'paused' ? 'Mitschauen' : 'Beitreten') : null;
    const kind = { tv: '📺', mobile: '📱', desktop: '🖥️' }[f.kind] || '';
    return el('div', { class: `nf-friend s-${f.state}`, 'data-user': f.username },
      el('div', { class: 'nf-av', style: `background:${color}` }, f.name.slice(0, 1).toUpperCase(), el('i', { class: 'dot' })),
      el('div', { class: 'nf-fr-text' },
        el('b', {}, f.name, kind ? el('span', { class: 'nf-kind' }, ` ${kind}`) : null),
        el('span', { class: 'nf-fr-state' }, line),
        detail ? el('span', { class: 'nf-fr-item', title: detail }, `▶ ${detail}`) : null),
      join);
  }

  function joinRoom(code) {
    stopFriends();
    env.joinRoom(code);
  }

  async function renderFriends(box, force) {
    let data;
    try { data = await api('/api/activity'); } catch { return; }
    if (!box.isConnected) return;
    const friends = data.friends || [];
    // Nur neu zeichnen, wenn sich etwas geändert hat (sonst flackert es und der Fokus springt weg)
    const sig = JSON.stringify(friends.map((f) => [f.username, f.state, f.item && (f.item.id || 'x'), f.room && f.room.code, f.room && f.room.members]));
    if (!force && box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const focused = box.contains(document.activeElement) ? document.activeElement.closest('[data-user]') : null;
    const keepUser = focused && focused.dataset.user;
    const head = el('h3', {}, 'Freunde ', el('span', { class: 'nf-count' }, friends.length ? `${friends.length} online` : ''));
    const list = friends.length
      ? el('div', { class: 'nf-friends' }, friends.map(friendCard))
      : el('p', { class: 'muted nf-empty' }, 'Gerade ist sonst niemand da. Lade jemanden ein über 👥 Zusammen schauen.');
    box.replaceChildren(head, list);
    if (keepUser) {
      const again = box.querySelector(`[data-user="${CSS.escape(keepUser)}"] button`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function startFriends(box) {
    stopFriends();
    renderFriends(box, true);
    H.friendsBox = box;
    H.friendsTimer = setInterval(() => {
      if (q('#view-home').hidden || document.hidden) return;
      renderFriends(box);
    }, 5000);
  }
  // Zurück in den Tab/die App: sofort aktualisieren
  const freshen = () => {
    if (document.hidden) return;
    if (!q('#view-home').hidden && H.friendsBox && H.friendsBox.isConnected) renderFriends(H.friendsBox);
    if (!q('#view-lobby').hidden) lobbyRooms();
  };
  document.addEventListener('visibilitychange', freshen);
  window.addEventListener('focus', freshen);
  setInterval(() => { if (!document.hidden && !q('#view-lobby').hidden) lobbyRooms(); }, 5000);
  function stopFriends() { clearInterval(H.friendsTimer); H.friendsTimer = null; }

  /** Raum-Browser in „Zusammen schauen“: offene Räume ohne Code betreten. */
  async function lobbyRooms() {
    const box = q('#lobby-rooms');
    let data;
    try { data = await api('/api/activity'); } catch { box.hidden = true; return; }
    const list = (data.rooms || []).filter((r) => !r.mine);
    box.hidden = !list.length;
    box.replaceChildren(el('h4', {}, 'Gerade offen'), ...list.map((r) => el('div', { class: 'lobby-room' },
      el('div', { class: 'grow' },
        el('b', {}, r.members.join(', ')),
        el('span', {}, r.item && !r.item.hidden ? `${r.playing ? '▶' : '❚❚'} ${r.item.title}${r.item.subtitle ? ` · ${r.item.subtitle}` : ''}` : r.item ? 'schaut etwas' : 'sucht noch was aus')),
      el('button', { class: 'btn small primary', onclick: () => joinRoom(r.code) }, 'Beitreten'))));
  }

  /* ---------------- Seiten ---------------- */

  function loading() { body().replaceChildren(el('div', { class: 'nf-loading' }, el('div', { class: 'spinner' }))); }

  async function renderStart() {
    // Heimserver offline: trotzdem Freunde, Weiterschauen usw. zeigen (YouTube/Twitch gehen ja weiter)
    const libs = await libraries().catch(() => []);
    const [hist, list, top] = await Promise.all([loadHistory().catch(() => []), watchlist().catch(() => []), topRated()]);
    const newest = await Promise.all([...movieLibs(libs), ...showLibs(libs)].map((l) => libItems(l, 'added', 20).then((r) => ({ lib: l, items: r.items || [] })).catch(() => ({ lib: l, items: [] }))));
    const out = [];
    // Titelbild: zufällig aus den Neuesten mit Hintergrundbild
    const pool = newest.flatMap((n) => n.items.slice(0, 8)).filter((it) => it.hasBackdrop);
    if (!H.hero || !pool.some((p) => p.id === H.hero.id)) H.hero = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    if (H.hero) out.push(hero(H.hero, list.some((x) => x.id === H.hero.id)));
    else out.push(el('div', { class: 'nf-hero-spacer' }));

    const friends = el('section', { class: 'nf-row nf-friends-row' });
    out.push(friends);

    const cont = hist.filter((h) => !h.finished && h.progress > 1);
    out.push(row('Weiterschauen', cont.map((h) => ({ id: h.id, name: h.title, type: h.type, seriesId: h.seriesId, runtime: h.runtime, pos: h.pos, progress: h.progress, subtitle: h.subtitle })), {
      wide: true,
      subOf: (h) => h.subtitle || (h.runtime ? `noch ${Math.max(1, Math.round((h.runtime - (h.pos || 0)) / 60))} Min.` : null),
      progressOf: (h) => h.progress,
      onOpen: (h) => playSolo(h.id, h.pos || 0),
    }));
    out.push(row('Meine Liste', list, { more: () => setTab('list') }));
    if (top.length >= 3) out.push(row('Top 10 bei euch', top.slice(0, 10), { ranked: true }));
    for (const n of newest) out.push(row(`Neu in ${n.lib.name}`, n.items, { more: () => setTab(n.lib.collectionType === 'tvshows' ? 'series' : 'movies') }));
    const best = await Promise.all(movieLibs(libs).map((l) => libItems(l, 'rating', 20).then((r) => ({ lib: l, items: (r.items || []).filter((x) => x.rating) })).catch(() => null)));
    for (const b of best) if (b && b.items.length >= 4) out.push(row(`Hoch bewertet in ${b.lib.name}`, b.items));
    const rest = libs.filter((l) => l.collectionType !== 'movies' && l.collectionType !== 'tvshows');
    if (rest.length) out.push(row('Weitere Bibliotheken', rest));
    if (out.filter(Boolean).length <= 2) out.push(el('p', { class: 'muted nf-empty' }, S.me && S.me.agentOnline ? 'Hier ist noch nichts. Schau in die Bibliothek oder frag den Admin nach Freigaben.' : 'Der Heimserver ist gerade offline. Sobald er wieder da ist, erscheinen hier die Filme und Serien.'));
    body().replaceChildren(...out.filter(Boolean));
    startFriends(friends);
  }

  async function renderKind(kind) {
    const libs = await libraries();
    const mine = kind === 'movies' ? movieLibs(libs) : showLibs(libs);
    const label = kind === 'movies' ? 'Filme' : 'Serien';
    if (!mine.length) { body().replaceChildren(el('div', { class: 'nf-hero-spacer' }), el('p', { class: 'muted nf-empty' }, `Keine ${label}-Bibliothek freigegeben.`)); return; }
    const out = [el('div', { class: 'nf-page-title' }, el('h2', {}, label))];
    for (const l of mine) {
      const [added, rating, year] = await Promise.all(['added', 'rating', 'year'].map((s) => libItems(l, s, 20).then((r) => r.items || []).catch(() => [])));
      const pre = mine.length > 1 ? `${l.name}: ` : '';
      out.push(row(`${pre}Neu hinzugefügt`, added));
      out.push(row(`${pre}Am besten bewertet`, rating.filter((x) => x.rating)));
      out.push(row(`${pre}Neueste Erscheinungen`, year));
    }
    // Alles A–Z: komplette Liste, auf dem Gerät gespeichert, mit Buchstabenleiste
    out.push(azSection(kind, label, mine));
    body().replaceChildren(...out.filter(Boolean));
  }

  /* ---------------- A–Z (alle Titel, lokal gespeichert) ---------------- */

  const azKey = (kind, libs) => `wp_az_${kind}_${libs.map((l) => l.id).join('_')}`;
  const sortName = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const letterOf = (n) => { const c = sortName(n).trim().charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };

  function azLoad(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v && Array.isArray(v.items) ? v : null; } catch { return null; }
  }
  function azSave(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), etag: data.etag, items: data.items })); } catch { /* Speicher voll: dann eben ohne */ }
  }

  /** Komplette Liste vom Relay (dort zwischengespeichert). Mit Fingerabdruck: unverändert → nichts laden. */
  async function azFetch(libs, etag) {
    const p = new URLSearchParams({ libs: libs.map((l) => l.id).join(',') });
    if (etag) p.set('etag', etag);
    return api(`/api/catalog?${p}`);
  }

  function azSection(kind, label, libs) {
    const key = azKey(kind, libs);
    const status = el('span', { class: 'nf-az-status muted' });
    const bar = el('nav', { class: 'nf-az-bar' });
    const box = el('div', { class: 'nf-az' });
    const sec = el('section', { class: 'nf-row nf-az-row' }, el('h3', {}, `Alle ${label} A–Z `, status), bar, box);
    let shownSig = null;

    const paint = (items) => {
      const sig = items.map((x) => `${x.id}:${x.played ? 1 : 0}`).join(',');
      if (sig === shownSig) return; // nichts geändert → nichts neu zeichnen
      shownSig = sig;
      const groups = new Map();
      for (const it of items) { const L = letterOf(it.name); if (!groups.has(L)) groups.set(L, []); groups.get(L).push(it); }
      const letters = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
      bar.replaceChildren(...letters.map((L) => el('button', {
        class: groups.has(L) ? '' : 'off', disabled: !groups.has(L), tabindex: groups.has(L) ? 0 : -1,
        onclick: () => { const t = box.querySelector(`[data-letter="${L}"]`); if (t) { t.scrollIntoView({ block: 'start', behavior: 'smooth' }); const c = t.querySelector('.nf-card'); if (c) setTimeout(() => c.focus({ preventScroll: true }), 350); } },
      }, L)));
      // Abschnitte nacheinander aufbauen, damit auch schwache Geräte flüssig bleiben
      const order = letters.filter((L) => groups.has(L));
      box.replaceChildren();
      let i = 0;
      const step = () => {
        const t0 = performance.now();
        while (i < order.length && performance.now() - t0 < 40) {
          const L = order[i++];
          box.append(el('div', { class: 'nf-az-group', 'data-letter': L }, el('div', { class: 'nf-az-letter' }, L), el('div', { class: 'nf-grid' }, groups.get(L).map((it) => card(it)))));
        }
        if (i < order.length && box.isConnected) setTimeout(step, 0);
      };
      step();
      status.textContent = `${items.length} Titel`;
    };

    const cached = azLoad(key);
    if (cached) paint(cached.items);
    else { status.textContent = 'lädt …'; box.append(el('div', { class: 'nf-loading' }, el('div', { class: 'spinner' }))); }
    // Beim Relay nachfragen; geändert → neu speichern und (nur dann) neu zeichnen
    azFetch(libs, cached && cached.etag)
      .then((r) => {
        if (r.unchanged) return;
        azSave(key, r);
        if (sec.isConnected) paint(r.items);
      })
      .catch((e) => { if (!cached) box.replaceChildren(el('p', { class: 'error' }, e.message)); });
    return sec;
  }

  /* ---------------- YouTube & Twitch ---------------- */

  const EXT_KEY = 'wp_ext_recent';
  const extRecent = () => { try { return JSON.parse(localStorage.getItem(EXT_KEY) || '[]'); } catch { return []; } };
  function extRemember(url) {
    try { localStorage.setItem(EXT_KEY, JSON.stringify([url, ...extRecent().filter((u) => u !== url)].slice(0, 12))); } catch { /* egal */ }
  }
  function extLabel(url) {
    const m = /(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(url);
    if (m) return `YouTube · ${m[1]}`;
    const t = /twitch\.tv\/(videos\/\d+|[\w]+)/i.exec(url);
    return t ? `Twitch · ${t[1].replace('videos/', 'Video ')}` : url;
  }
  function startExt(url) {
    const u = String(url || '').trim();
    if (!/(youtube\.com|youtu\.be|twitch\.tv)/i.test(u)) { toast('Bitte einen YouTube- oder Twitch-Link einfügen.'); return; }
    extRemember(u);
    env.playExt(u);
  }

  async function renderExt() {
    const input = el('input', { name: 'url', placeholder: 'YouTube- oder Twitch-Link einfügen …', autocomplete: 'off', required: true });
    const form = el('form', { class: 'nf-ext-form', onsubmit: (e) => { e.preventDefault(); startExt(input.value); } },
      input, el('button', { class: 'btn primary', type: 'submit' }, '▶ Zusammen schauen'));
    const out = [
      el('div', { class: 'nf-page-title' }, el('h2', {}, 'YouTube & Twitch')),
      el('section', { class: 'nf-row nf-ext' },
        el('p', { class: 'muted' }, 'Link rein, alle schauen synchron mit. Euer Heimserver hat dabei nichts zu tun.'),
        form,
        el('ul', { class: 'nf-ext-hints muted' },
          el('li', {}, 'Twitch live: Der Server holt den Stream einmal und gibt allen exakt dasselbe Bild – aufs Bild genau synchron, mit Pause, Zurückspulen und „● LIVE“.'),
          el('li', {}, 'YouTube, Twitch-Videos und Clips: Pause und Spulen gelten für alle.'),
          el('li', {}, 'Werbung: Bei YouTube und Twitch-Videos schaut jeder mit seinem eigenen Konto (Premium/Turbo = keine Werbung). Twitch live läuft über den Zugang des Servers.'))),
    ];
    // Freunde, die gerade YouTube/Twitch schauen
    const box = el('section', { class: 'nf-row' });
    out.push(box);
    const recent = extRecent();
    if (recent.length) {
      out.push(el('section', { class: 'nf-row' }, el('h3', {}, 'Zuletzt geteilt'),
        el('div', { class: 'nf-ext-recent' }, recent.map((u) => el('button', { class: 'btn small', title: u, onclick: () => startExt(u) }, `▶ ${extLabel(u)}`)))));
    }
    body().replaceChildren(...out);
    if (!isTv()) input.focus();
    try {
      const data = await api('/api/activity');
      const live = (data.friends || []).filter((f) => f.item && f.item.ext && f.room);
      if (live.length && box.isConnected) box.replaceChildren(el('h3', {}, 'Gerade bei Freunden'), el('div', { class: 'nf-friends' }, live.map(friendCard)));
    } catch { /* egal */ }
  }

  async function renderList() {
    H.cache.delete('watchlist');
    const list = await watchlist();
    const out = [el('div', { class: 'nf-page-title' }, el('h2', {}, 'Meine Liste'))];
    if (!list.length) out.push(el('p', { class: 'muted nf-empty' }, 'Noch leer. Bei jedem Titel gibt es „＋ Meine Liste“ bzw. „☆ Merken“.'));
    else out.push(grid(`${list.length} ${list.length === 1 ? 'Titel' : 'Titel'}`, list));
    body().replaceChildren(...out);
  }

  async function renderSearch(text) {
    const r = await api(`/api/search?q=${encodeURIComponent(text)}`);
    if (H.search !== text) return;
    const out = [el('div', { class: 'nf-page-title' }, el('h2', {}, `Suche: „${text}“`))];
    const all = [...(r.movies || []), ...(r.series || [])];
    if (all.length) out.push(grid('Filme & Serien', all));
    if ((r.episodes || []).length) out.push(row('Folgen', r.episodes, { wide: true, subOf: (e) => [e.seriesName, epLabel(e)].filter(Boolean).join(' · ') }));
    if (!all.length && !(r.episodes || []).length) out.push(el('p', { class: 'muted nf-empty' }, 'Nichts gefunden. Tipp: auch mit Jahr suchen, z. B. „matrix 1999“.'));
    body().replaceChildren(...out);
  }

  /* ---------------- Steuerung ---------------- */

  async function render() {
    stopFriends();
    for (const b of document.querySelectorAll('#nf-tabs button')) b.classList.toggle('on', b.dataset.tab === H.tab && !H.search);
    loading();
    try {
      if (H.search) await renderSearch(H.search);
      else if (H.tab === 'movies') await renderKind('movies');
      else if (H.tab === 'series') await renderKind('series');
      else if (H.tab === 'list') await renderList();
      else if (H.tab === 'ext') await renderExt();
      else await renderStart();
    } catch (e) {
      body().replaceChildren(el('div', { class: 'nf-hero-spacer' }), el('p', { class: 'error nf-empty' }, e.message));
    }
    if (isTv()) setTimeout(() => { const f = body().querySelector('.nf-playbtn, .nf-card'); if (f && (!document.activeElement || document.activeElement === document.body)) f.focus(); }, 50);
  }

  function setTab(tab) {
    if (tab === 'wishes') { WP.openBoard(); return; }
    H.tab = tab;
    H.search = '';
    q('#nf-search').value = '';
    window.scrollTo(0, 0);
    body().scrollTop = 0;
    render();
  }

  function show() {
    showView('view-home');
    document.title = 'Watchparty';
    const name = (S.me && S.me.name) || '?';
    const av = q('#nf-me');
    av.textContent = name.slice(0, 1).toUpperCase();
    av.style.background = colorFor(name);
    av.title = `${name} · Konto & Zusammen schauen`;
    // Frische Daten für die persönlichen Reihen
    H.cache.delete('history'); H.cache.delete('watchlist');
    render();
    if (window.WP && WP.lobby) WP.lobby(); // Wunsch-Neuigkeiten usw.
  }

  q('#nf-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
  q('#nf-party').addEventListener('click', () => env.showLobby());
  q('#nf-me').addEventListener('click', () => env.showLobby());
  q('#btn-lobby-home').addEventListener('click', () => env.goHome());
  q('#nf-search').addEventListener('input', (e) => {
    const t = e.target.value.trim();
    clearTimeout(H.searchTimer);
    H.searchTimer = setTimeout(() => {
      if (t.length < 2) { if (H.search) { H.search = ''; render(); } return; }
      H.search = t;
      render();
    }, 300);
  });
  // Nav wird beim Scrollen dunkel
  q('#view-home').addEventListener('scroll', () => q('#nf-nav').classList.toggle('solid', q('#view-home').scrollTop > 40), { passive: true });
  window.addEventListener('scroll', () => q('#nf-nav').classList.toggle('solid', window.scrollY > 40), { passive: true });

  window.WPHome = { show, setTab, refresh: render, lobbyRooms };
})();

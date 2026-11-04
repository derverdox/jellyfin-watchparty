'use strict';
/*
 * Watchparty – Zusatzfunktionen der Web-Oberfläche:
 * Detail- und Serienansicht, Bewertungen, Gesehen-Status, Warteschlange,
 * Abstimmung, Bewertungsrunde, Intro überspringen, Zufall, schwarzes Brett, Profil.
 * Baut auf den Helfern aus app.js auf ($, el, api, send, S, toast, …).
 */
(() => {
  const X = { detail: null, show: null, season: 0, pollDraft: [], queue: [], poll: null, round: null, rated: null, board: { sort: 'votes', status: '', tag: '' } };

  const img = (id, w, type) => `/img/${id}?w=${w}${type ? `&type=${type}` : ''}`;
  const n1 = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
  const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'gerade eben';
    if (s < 3600) return `vor ${Math.round(s / 60)} min`;
    if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
    return `vor ${Math.round(s / 86400)} T`;
  };
  const inRoom = () => !!(S.code && S.you);

  /* ---------------- Modal ---------------- */

  function openModal(node, cls = '') {
    const box = $('#xbox');
    box.className = `xbox ${cls}`;
    box.replaceChildren(node);
    $('#xmodal').hidden = false;
    box.scrollTop = 0;
  }
  function closeModal() { $('#xmodal').hidden = true; X.detail = null; }
  $('#xmodal').addEventListener('click', (e) => { if (e.target.id === 'xmodal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#xmodal').hidden) { e.stopPropagation(); closeModal(); } }, true);

  /* ---------------- Sterne ---------------- */

  function starPicker(mine, onPick) {
    const wrap = el('div', { class: 'stars', title: 'Deine Bewertung (anonym)' });
    const paint = (v) => { [...wrap.children].forEach((b, i) => b.classList.toggle('on', i < v)); };
    for (let i = 1; i <= 10; i++) {
      wrap.append(el('button', {
        type: 'button', 'aria-label': `${i} von 10`,
        onmouseenter: () => paint(i), onfocus: () => paint(i),
        onclick: () => onPick(i === mine ? null : i),
      }, '★'));
    }
    wrap.addEventListener('mouseleave', () => paint(mine || 0));
    paint(mine || 0);
    return wrap;
  }

  async function rate(id, score) {
    try { return await api('/api/rate', { method: 'POST', body: { itemId: id, score } }); } catch (e) { toast(e.message); return null; }
  }

  /* ---------------- Detailansicht ---------------- */

  async function openDetail(it) {
    X.detail = it;
    openModal(el('div', { class: 'xd-loading' }, el('div', { class: 'spinner' })), 'detail');
    try {
      const d = await api(`/api/details/${it.id}`);
      if (X.detail !== it) return;
      if (d.type === 'Series') {
        const show = await api(`/api/show/${it.id}${inRoom() ? `?room=${S.code}` : ''}`);
        if (X.detail !== it) return;
        X.show = show;
        const nextSeason = show.next ? show.seasons.findIndex((s) => s.episodes.some((e) => e.id === show.next.id)) : 0;
        X.season = Math.max(0, nextSeason);
        renderDetail(d, show);
      } else renderDetail(d, null);
    } catch (e) {
      openModal(el('div', { class: 'xd-loading' }, e.message), 'detail');
    }
  }

  function renderDetail(d, show) {
    const isSeries = d.type === 'Series';
    const meta = [d.year, d.runtime && !isSeries ? `${Math.round(d.runtime / 60)} min` : null, d.officialRating, isSeries && show ? `${show.seasons.length} Staffel${show.seasons.length === 1 ? '' : 'n'} · ${show.total} Folgen` : null].filter(Boolean);
    const ours = el('div', { class: 'ours' });
    const paintOurs = (r) => {
      ours.replaceChildren(
        el('span', { class: 'big' }, r.avg ? `★ ${n1(r.avg)}` : '★ –'),
        el('span', { class: 'muted tiny' }, r.count ? `bei uns · ${r.count} ${r.count === 1 ? 'Stimme' : 'Stimmen'}` : 'noch keine Bewertung'),
      );
    };
    paintOurs(d.ours);
    let mine = d.ours.mine;
    const picker = el('div', { class: 'my-rating' }, el('span', { class: 'tiny muted' }, 'Deine Bewertung (anonym)'), el('span'));
    const rebuildPicker = () => {
      picker.children[1].replaceWith(starPicker(mine, async (v) => {
        const r = await rate(d.id, v);
        if (!r) return;
        mine = r.mine; paintOurs(r); rebuildPicker();
        toast(v ? `${v}/10 gespeichert (anonym)` : 'Bewertung entfernt');
      }));
    };
    rebuildPicker();

    const actions = el('div', { class: 'xd-actions' });
    if (isSeries) {
      if (show && show.next) {
        actions.append(el('button', { class: 'btn primary', disabled: !canLoad() && !perm('suggest'), onclick: () => playOrSuggest({ id: show.next.id, name: `${d.name} ${show.next.label}` }) },
          `▶ ${show.watchedCount ? 'Weiter mit' : 'Los geht\'s mit'} ${show.next.label}`, el('span', { class: 'sub' }, show.next.name)));
      }
    } else {
      if (d.resume > 30 && d.progress < 92) {
        actions.append(el('button', { class: 'btn primary', disabled: !canLoad(), onclick: () => play(d, d.resume) }, `▶ Weiter ab ${fmt(d.resume)}`));
        actions.append(el('button', { class: 'btn', disabled: !canLoad(), onclick: () => play(d, 0) }, 'Von vorn'));
      } else if (canLoad()) actions.append(el('button', { class: 'btn primary', onclick: () => play(d, 0) }, '▶ Für alle abspielen'));
      if (!canLoad() && perm('suggest') && inRoom()) actions.append(el('button', { class: 'btn primary', onclick: () => suggest(d) }, '💡 Vorschlagen'));
      if (inRoom() && (canLoad() || perm('suggest'))) actions.append(el('button', { class: 'btn', onclick: () => queueAdd([d.id], d.name) }, '＋ Liste'));
      if (inRoom() && canLoad()) actions.append(el('button', { class: 'btn', onclick: () => addToPoll(d) }, '🗳 Abstimmung'));
    }
    const fav = el('button', { class: `btn${d.inWatchlist ? ' on' : ''}`, onclick: async () => {
      try { const r = await api('/api/watchlist', { method: 'POST', body: { itemId: d.id } }); d.inWatchlist = r.on; fav.textContent = r.on ? '★ Gemerkt' : '☆ Merken'; fav.classList.toggle('on', r.on); if (S.watchIds) { if (r.on) S.watchIds.add(d.id); else S.watchIds.delete(d.id); } } catch (e) { toast(e.message); }
    } }, d.inWatchlist ? '★ Gemerkt' : '☆ Merken');
    actions.append(fav);
    if (!isSeries) {
      const seen = el('button', { class: `btn${d.watched ? ' on' : ''}`, onclick: async () => {
        await api('/api/watched', { method: 'POST', body: { ids: [d.id], on: !d.watched } });
        d.watched = !d.watched;
        seen.textContent = d.watched ? '✓ Gesehen' : '◯ Als gesehen markieren';
        seen.classList.toggle('on', d.watched);
      } }, d.watched ? '✓ Gesehen' : '◯ Als gesehen markieren');
      actions.append(seen);
    }
    if (d.type === 'Episode' && d.seriesId) actions.append(el('button', { class: 'btn', onclick: () => openDetail({ id: d.seriesId, type: 'Series', name: d.seriesName }) }, '📺 Zur Serie'));

    const root = el('div', { class: 'xd' },
      el('div', { class: 'xd-bg', style: `background-image:url('${img(d.seriesId && d.type === 'Episode' ? d.seriesId : d.id, 1600, 'Backdrop')}')` }),
      el('button', { class: 'icon xd-close', onclick: closeModal, 'aria-label': 'Schließen' }, '✕'),
      el('div', { class: 'xd-head' },
        el('div', { class: 'xd-poster', style: `background-image:url('${img(d.id, 400)}')` }),
        el('div', { class: 'xd-info' },
          el('span', { class: 'eyebrow' }, { Movie: 'Film', Series: 'Serie', Episode: 'Folge', Video: 'Video', BoxSet: 'Sammlung' }[d.type] || d.type),
          el('h1', {}, d.type === 'Episode' && d.seriesName ? `${d.seriesName}` : d.name),
          d.type === 'Episode' ? el('div', { class: 'xd-epname' }, `S${d.parentIndex ?? '?'}E${d.index ?? '?'} · ${d.name}`) : '',
          meta.length ? el('div', { class: 'xd-meta' }, meta.join(' · ')) : '',
          d.genres && d.genres.length ? el('div', { class: 'chips' }, d.genres.slice(0, 5).map((g) => el('span', { class: 'chip' }, g))) : '',
          el('div', { class: 'xd-ratings' },
            d.rating ? el('div', { class: 'ours' }, el('span', { class: 'big jf' }, `★ ${n1(d.rating)}`), el('span', { class: 'muted tiny' }, 'Jellyfin')) : '',
            ours, picker),
          d.overview ? el('p', { class: 'xd-overview' }, d.overview) : '',
          actions)));
    if (isSeries && show) root.append(renderSeasons(d, show));
    openModal(root, 'detail');
  }

  function renderSeasons(d, show) {
    const wrap = el('div', { class: 'xd-seasons' });
    const draw = () => {
      const s = show.seasons[X.season];
      if (!s) { wrap.replaceChildren(el('div', { class: 'lib-empty' }, 'Keine Folgen.')); return; }
      const all = s.episodes.every((e) => e.watched);
      const tabs = el('div', { class: 'season-tabs' }, show.seasons.map((x, i) => {
        const w = x.episodes.filter((e) => e.watched).length;
        return el('button', { class: i === X.season ? 'on' : '', onclick: () => { X.season = i; draw(); } }, x.name, el('span', { class: 'cnt' }, w === x.episodes.length ? '✓' : `${w}/${x.episodes.length}`));
      }));
      const head = el('div', { class: 'season-head' },
        el('span', { class: 'muted' }, `${s.episodes.length} Folgen`),
        el('div', { class: 'grow' }),
        inRoom() && (canLoad() || perm('suggest')) ? el('button', { class: 'btn small', onclick: () => queueAdd(s.episodes.filter((e) => !e.watched).map((e) => e.id), `${s.name}`) }, '＋ Ungesehene in die Liste') : '',
        el('button', { class: 'btn small', onclick: () => markWatched(s.episodes.map((e) => e.id), !all) }, all ? '◯ Staffel ungesehen' : '✓ Staffel gesehen'));
      const list = el('div', { class: 'episodes' }, s.episodes.map((e, idx) => episodeRow(d, s, e, idx)));
      wrap.replaceChildren(tabs, head, list);
      if (show.roomMembers && show.roomMembers.length) wrap.append(el('p', { class: 'tiny muted' }, `Avatare zeigen, wer im Raum die Folge schon gesehen hat (${show.roomMembers.join(', ')}).`));
    };
    const markWatched = async (ids, on) => {
      try {
        await api('/api/watched', { method: 'POST', body: { ids, on } });
        for (const s of show.seasons) for (const e of s.episodes) if (ids.includes(e.id)) e.watched = on;
        show.watchedCount = show.seasons.flatMap((x) => x.episodes).filter((e) => e.watched).length;
        draw();
      } catch (e) { toast(e.message); }
    };
    X.markWatched = markWatched;
    draw();
    return wrap;
  }

  function episodeRow(d, s, e, idx) {
    const isNext = X.show && X.show.next && X.show.next.id === e.id;
    const upTo = () => {
      const flat = X.show.seasons.flatMap((x) => x.episodes);
      const k = flat.findIndex((x) => x.id === e.id);
      X.markWatched(flat.slice(0, k + 1).map((x) => x.id), true);
    };
    return el('div', { class: `ep${e.watched ? ' watched' : ''}${isNext ? ' next' : ''}` },
      el('div', { class: 'ep-thumb', style: `background-image:url('${img(e.id, 480)}')`, onclick: () => playOrSuggest(e) },
        el('span', { class: 'ep-play' }, '▶'),
        e.progress > 1 && !e.watched ? el('div', { class: 'prog' }, el('div', { style: `width:${Math.min(100, e.progress)}%` })) : '',
        e.watched ? el('span', { class: 'ep-check' }, '✓') : ''),
      el('div', { class: 'ep-body' },
        el('div', { class: 'ep-title' }, el('span', { class: 'ep-n' }, `${e.index ?? idx + 1}`), e.name, isNext ? el('span', { class: 'tag-next' }, 'Als Nächstes') : ''),
        el('div', { class: 'ep-meta' }, [e.runtime ? `${Math.round(e.runtime / 60)} min` : null, e.progress > 1 && !e.watched ? `${Math.round(e.progress)} % geschaut` : null].filter(Boolean).join(' · ')),
        e.overview ? el('p', { class: 'ep-desc' }, e.overview) : '',
        e.roomWatched && e.roomWatched.length ? el('div', { class: 'ep-room' }, e.roomWatched.map((n) => el('span', { class: 'mini-av', title: `${n} hat sie gesehen`, style: `background:${colorFor(n)}` }, n.slice(0, 1).toUpperCase()))) : ''),
      el('div', { class: 'ep-actions' },
        el('button', { class: `icon${e.watched ? ' on' : ''}`, title: e.watched ? 'Als ungesehen markieren' : 'Als gesehen markieren', onclick: () => X.markWatched([e.id], !e.watched) }, e.watched ? '✓' : '◯'),
        el('button', { class: 'icon', title: 'Alle bis hier als gesehen', onclick: upTo }, '⤓'),
        inRoom() && (canLoad() || perm('suggest')) ? el('button', { class: 'icon', title: 'In die Liste', onclick: () => queueAdd([e.id], e.name) }, '＋') : ''));
  }

  function play(d, position) {
    if (!inRoom()) { toast('Erst einen Raum öffnen.'); return; }
    send({ t: 'load', itemId: d.id, position: position || 0 });
    toast(`„${d.name}“ wird geladen…`);
    closeModal();
    if (typeof closeLibrary === 'function') closeLibrary();
  }
  function suggest(d) {
    send({ t: 'suggest', itemId: d.id });
    toast('Vorschlag im Chat gepostet');
    closeModal();
    if (typeof closeLibrary === 'function') closeLibrary();
  }
  function playOrSuggest(e) {
    if (!inRoom()) { toast('Erst einen Raum öffnen.'); return; }
    if (canLoad()) play(e, 0);
    else if (perm('suggest')) suggest(e);
    else toast('Du darfst hier nichts auswählen oder vorschlagen.');
  }
  function queueAdd(ids, label) {
    if (!ids.length) { toast('Nichts zum Einreihen.'); return; }
    send({ t: 'queue-add', itemIds: ids });
    toast(`${ids.length > 1 ? `${ids.length} Titel` : `„${label}“`} in die Liste`);
  }

  /* ---------------- Warteschlange ---------------- */

  function renderQueue() {
    const box = $('#queue');
    $('#queue-count').textContent = String(X.queue.length);
    box.innerHTML = '';
    if (!X.queue.length) {
      box.append(el('div', { class: 'queue-empty muted' }, 'Leer. In der Bibliothek „＋ Liste“ wählen – nach dem Film geht es automatisch weiter.'));
      return;
    }
    const can = canLoad();
    X.queue.forEach((q, i) => {
      box.append(el('div', { class: 'q-item' },
        el('div', { class: 'q-thumb', style: `background-image:url('${img(q.id, 160)}')` }),
        el('div', { class: 'q-body' }, el('b', {}, q.title), q.subtitle ? el('span', { class: 'muted tiny' }, q.subtitle) : '', el('span', { class: 'muted tiny' }, `von ${q.by}`)),
        el('div', { class: 'q-act' },
          can ? el('button', { class: 'icon', title: 'Jetzt abspielen', onclick: () => send({ t: 'queue-play', index: i }) }, '▶') : '',
          can && i > 0 ? el('button', { class: 'icon', title: 'Nach oben', onclick: () => send({ t: 'queue-move', index: i, to: i - 1 }) }, '↑') : '',
          can || q.by === (S.me && S.me.name) ? el('button', { class: 'icon', title: 'Entfernen', onclick: () => send({ t: 'queue-remove', index: i }) }, '✕') : '')));
    });
    if (can) box.append(el('button', { class: 'link', onclick: () => send({ t: 'queue-clear' }) }, 'Liste leeren'));
  }

  /* ---------------- Abstimmung ---------------- */

  function addToPoll(d) {
    if (X.pollDraft.some((x) => x.id === d.id)) { toast('Ist schon dabei.'); return; }
    if (X.pollDraft.length >= 4) { toast('Höchstens 4 Titel.'); return; }
    X.pollDraft.push({ id: d.id, name: d.name });
    renderPollDraft();
    toast(`„${d.name}“ zur Abstimmung (${X.pollDraft.length}/4)`);
  }
  function renderPollDraft() {
    let bar = $('#poll-draft');
    if (!bar) { bar = el('div', { class: 'poll-draft', id: 'poll-draft' }); document.body.append(bar); }
    bar.hidden = !X.pollDraft.length;
    bar.replaceChildren(
      el('span', {}, '🗳 Abstimmung: '),
      ...X.pollDraft.map((x) => el('span', { class: 'chip' }, x.name, el('button', { onclick: () => { X.pollDraft = X.pollDraft.filter((y) => y !== x); renderPollDraft(); } }, '✕'))),
      el('button', { class: 'btn small primary', disabled: X.pollDraft.length < 2, onclick: () => {
        send({ t: 'poll-start', itemIds: X.pollDraft.map((x) => x.id), seconds: 60 });
        X.pollDraft = []; renderPollDraft(); closeModal(); if (typeof closeLibrary === 'function') closeLibrary();
      } }, X.pollDraft.length < 2 ? 'mind. 2 Titel' : 'Starten (60 s)'),
      el('button', { class: 'icon', title: 'Verwerfen', onclick: () => { X.pollDraft = []; renderPollDraft(); } }, '✕'));
  }

  let cardTimer;
  function renderCards() {
    const box = $('#player-cards');
    box.innerHTML = '';
    if (X.poll) {
      const me = S.me ? S.me.username.toLowerCase() : '';
      const total = X.poll.options.reduce((a, o) => a + o.votes, 0);
      const left = Math.max(0, Math.round((X.poll.ends - serverNow()) / 1000));
      box.append(el('div', { class: 'pcard poll' },
        el('div', { class: 'pcard-head' }, el('b', {}, '🗳 Was schauen wir?'), el('span', { class: 'muted tiny' }, `noch ${left} s · ${total} ${total === 1 ? 'Stimme' : 'Stimmen'}`)),
        ...X.poll.options.map((o) => el('button', { class: `poll-opt${o.voters.includes(me) ? ' mine' : ''}`, onclick: () => send({ t: 'poll-vote', itemId: o.id }) },
          el('div', { class: 'poll-fill', style: `width:${total ? (o.votes / total) * 100 : 0}%` }),
          el('span', { class: 'poll-t' }, o.title, o.subtitle && o.type === 'Episode' ? ` · ${o.subtitle}` : o.year ? ` (${o.year})` : ''),
          el('span', { class: 'poll-n' }, String(o.votes)))),
        canLoad() ? el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => send({ t: 'poll-end' }) }, 'Jetzt auswerten'), el('button', { class: 'link', onclick: () => send({ t: 'poll-end', cancel: true }) }, 'Abbrechen')) : ''));
    }
    if (X.round) {
      const card = el('div', { class: 'pcard rate' },
        el('div', { class: 'pcard-head' }, el('b', {}, `⭐ Wie fandet ihr „${X.round.item.title}“?`), el('button', { class: 'icon', onclick: () => { X.round.hidden = true; renderCards(); } }, '✕')),
        starPicker(X.rated, async (v) => { const r = await rate(X.round.item.id, v); if (r) { X.rated = r.mine; renderCards(); } }),
        el('span', { class: 'muted tiny' }, X.rated ? `Danke! ${X.round.votes || 1} ${X.round.votes === 1 ? 'Stimme' : 'Stimmen'} bisher · anonym` : 'anonym · Ergebnis kommt gleich in den Chat'));
      if (!X.round.hidden) box.append(card);
    }
    if (X.advancing) {
      const left = Math.max(0, Math.round((X.advancing.at - serverNow()) / 1000));
      if (left > 0) box.append(el('div', { class: 'pcard' }, el('b', {}, `⏭ Gleich: „${X.advancing.next.title}“`), el('span', { class: 'muted tiny' }, X.advancing.next.subtitle || ''), el('span', { class: 'muted tiny' }, `in ${left} s`)));
    }
    clearTimeout(cardTimer);
    if (X.poll || X.advancing) cardTimer = setTimeout(renderCards, 1000);
  }

  /* ---------------- Intro überspringen ---------------- */

  video.addEventListener('timeupdate', () => {
    const btn = $('#btn-skip');
    const segs = (S.info && S.info.segments) || [];
    const t = video.currentTime;
    const seg = segs.find((s) => t >= s.start - 0.5 && t < s.end - 1.5 && ['intro', 'recap', 'preview', 'outro'].includes(s.type));
    const next = S.playback && S.playback.item && S.playback.item.nextEpisodeId;
    if (!seg || !canControl() || (seg.type === 'outro' && !(next && canLoad()))) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = { intro: 'Intro überspringen ⏭', recap: 'Rückblick überspringen ⏭', preview: 'Vorschau überspringen ⏭', outro: 'Nächste Folge ⏭' }[seg.type];
    btn.onclick = () => {
      if (seg.type === 'outro') send({ t: 'load', itemId: next });
      else control('seek', seg.end);
      btn.hidden = true;
    };
  });

  /* ---------------- Zufall ---------------- */

  $('#btn-random').addEventListener('click', () => openRandom());
  async function openRandom(filters) {
    const top = S.lib.stack[S.lib.stack.length - 1];
    const f = filters || { type: 'movie', unwatched: true, maxMinutes: '', minRating: '', here: !!(top && top.id) };
    const form = el('form', { class: 'rnd-form' },
      el('h2', {}, '🎲 Zufall'),
      el('div', { class: 'rnd-grid' },
        el('label', {}, 'Was', el('select', { name: 'type' }, el('option', { value: 'movie' }, 'Film'), el('option', { value: 'series' }, 'Serie'), el('option', { value: 'episode' }, 'Einzelne Folge'))),
        el('label', {}, 'Höchstens', el('select', { name: 'maxMinutes' }, el('option', { value: '' }, 'egal'), el('option', { value: '95' }, '95 min'), el('option', { value: '120' }, '2 h'), el('option', { value: '150' }, '2,5 h'))),
        el('label', {}, 'Bewertung ab', el('select', { name: 'minRating' }, el('option', { value: '' }, 'egal'), el('option', { value: '6' }, '★ 6'), el('option', { value: '7' }, '★ 7'), el('option', { value: '8' }, '★ 8')))),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'unwatched', checked: f.unwatched }), ' Nur, was ich noch nicht gesehen habe'),
      top && top.id ? el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'here', checked: f.here }), ` Nur in „${top.name}“`) : '',
      el('button', { class: 'btn primary', type: 'submit' }, '🎲 Würfeln'),
      el('div', { id: 'rnd-out' }));
    form.type.value = f.type; form.maxMinutes.value = f.maxMinutes; form.minRating.value = f.minRating;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nf = { type: form.type.value, maxMinutes: form.maxMinutes.value, minRating: form.minRating.value, unwatched: form.unwatched.checked, here: form.here ? form.here.checked : false };
      const q = new URLSearchParams({ type: nf.type });
      if (nf.maxMinutes) q.set('maxMinutes', nf.maxMinutes);
      if (nf.minRating) q.set('minRating', nf.minRating);
      if (nf.unwatched) q.set('unwatched', '1');
      if (nf.here && top && top.id) q.set('parentId', top.id);
      const out = $('#rnd-out', form);
      out.replaceChildren(el('div', { class: 'spinner' }));
      try {
        const r = await api(`/api/random?${q}`);
        const p = r.pick;
        out.replaceChildren(el('div', { class: 'rnd-pick' },
          el('div', { class: 'rnd-poster', style: `background-image:url('${img(p.id, 400)}')` }),
          el('div', {},
            el('h3', {}, p.name), el('div', { class: 'muted tiny' }, [p.year, p.runtime ? `${Math.round(p.runtime / 60)} min` : null, p.rating ? `★ ${n1(p.rating)}` : null, (p.genres || []).slice(0, 3).join(', ')].filter(Boolean).join(' · ')),
            p.overview ? el('p', { class: 'tiny' }, p.overview) : '',
            el('div', { class: 'row' }, el('button', { class: 'btn primary small', type: 'button', onclick: () => openDetail(p) }, 'Ansehen'), el('button', { class: 'btn small', type: 'submit' }, 'Nochmal würfeln')),
            el('span', { class: 'muted tiny' }, `aus ${r.pool} passenden Titeln`))));
      } catch (ex) { out.replaceChildren(el('p', { class: 'muted' }, ex.message)); }
    });
    openModal(form, 'small');
  }

  /* ---------------- Schwarzes Brett ---------------- */

  const STATUS = { open: ['offen', ''], progress: ['in Arbeit', 'info'], done: ['verfügbar', 'ok'], rejected: ['abgelehnt', 'off'] };

  async function openBoard() {
    const root = el('div', { class: 'board' });
    openModal(root, 'board');
    await renderBoard(root);
  }

  async function renderBoard(root) {
    let data;
    try {
      const q = new URLSearchParams({ sort: X.board.sort, ...(X.board.status ? { status: X.board.status } : {}) });
      data = await api(`/api/wishes?${q}`);
    } catch (e) { root.replaceChildren(el('p', {}, e.message)); return; }
    const list = data.wishes.filter((w) => !X.board.tag || w.tags.some((t) => t.tag === X.board.tag));
    const tabs = el('div', { class: 'lib-tabs' }, [['votes', '', 'Beliebt'], ['new', '', 'Neu'], ['votes', 'progress', 'In Arbeit'], ['new', 'done', 'Erfüllt']].map(([sort, status, label]) =>
      el('button', { class: X.board.sort === sort && X.board.status === status ? 'on' : '', onclick: () => { X.board.sort = sort; X.board.status = status; renderBoard(root); } }, label)));
    const form = data.canWish ? wishForm(root) : el('p', { class: 'muted tiny' }, 'Du kannst die Wünsche ansehen, aber selbst keine eintragen.');
    const tagBar = data.tags.length ? el('div', { class: 'chips' }, el('span', { class: 'muted tiny' }, 'Tags:'), data.tags.slice(0, 14).map((t) =>
      el('button', { class: `chip${X.board.tag === t.tag ? ' on' : ''}`, onclick: () => { X.board.tag = X.board.tag === t.tag ? '' : t.tag; renderBoard(root); } }, `#${t.tag}`, el('span', { class: 'n' }, String(t.votes))))) : '';
    root.replaceChildren(
      el('div', { class: 'board-head' }, el('h2', {}, '📌 Schwarzes Brett'), el('span', { class: 'muted' }, 'Was soll als Nächstes auf den Server?'), el('div', { class: 'grow' }), el('button', { class: 'icon', onclick: closeModal }, '✕')),
      form, el('div', { class: 'board-bar' }, tabs, tagBar),
      list.length ? el('div', { class: 'wishes' }, list.map((w) => wishCard(w, data, root))) : el('div', { class: 'lib-empty' }, 'Hier ist noch nichts. Trag den ersten Wunsch ein!'));
  }

  function wishForm(root) {
    const hint = el('div', { class: 'wish-hint' });
    const f = el('form', { class: 'wish-form' },
      el('input', { name: 'title', maxlength: 120, placeholder: 'Titel, z. B. „Blade Runner“', required: true, autocomplete: 'off' }),
      el('input', { name: 'year', type: 'number', min: 1900, max: 2100, placeholder: 'Jahr' }),
      el('select', { name: 'type' }, el('option', { value: 'movie' }, 'Film'), el('option', { value: 'series' }, 'Serie')),
      el('input', { name: 'tags', maxlength: 80, placeholder: 'Tags, mit Komma' }),
      el('input', { name: 'note', maxlength: 500, placeholder: 'Notiz (z. B. „Director\'s Cut“)', class: 'wide' }),
      el('button', { class: 'btn primary', type: 'submit' }, '＋ Wünschen'),
      hint);
    let t;
    f.title.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = f.title.value.trim();
        if (q.length < 2) { hint.replaceChildren(); return; }
        try {
          const r = await api(`/api/wishes/check?q=${encodeURIComponent(q)}`);
          hint.replaceChildren(
            ...(r.library.length ? [el('span', { class: 'muted tiny' }, 'Schon da: '), ...r.library.map((x) => el('button', { class: 'chip ok', type: 'button', onclick: () => openDetail(x) }, `▶ ${x.name}${x.year ? ` (${x.year})` : ''}`))] : []),
            ...(r.wishes.length ? [el('span', { class: 'muted tiny' }, ' Schon gewünscht: '), ...r.wishes.map((w) => el('button', { class: 'chip', type: 'button', onclick: async () => { await api(`/api/wishes/${w.id}/vote`, { method: 'POST' }); renderBoard(root); } }, `▲ ${w.title} (${w.votes})`))] : []));
        } catch { /* egal */ }
      }, 300);
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/wishes', { method: 'POST', body: { title: f.title.value, year: f.year.value || null, type: f.type.value, note: f.note.value, tags: f.tags.value.split(',').map((x) => x.trim()).filter(Boolean) } });
        toast('Wunsch eingetragen – sag deinen Freunden, sie sollen abstimmen!');
        renderBoard(root);
      } catch (ex) { toast(ex.message); }
    });
    return f;
  }

  function wishCard(w, data, root) {
    const [st, cls] = STATUS[w.status] || ['?', ''];
    const reload = () => renderBoard(root);
    const tagIn = el('input', { class: 'tag-in', maxlength: 24, placeholder: '+ Tag', onkeydown: async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = e.target.value.trim();
      if (!v) return;
      try { await api(`/api/wishes/${w.id}/tag`, { method: 'POST', body: { tag: v } }); reload(); } catch (ex) { toast(ex.message); }
    } });
    return el('div', { class: `wish ${w.status}` },
      el('button', { class: `vote${w.voted ? ' on' : ''}`, disabled: !data.canWish, title: w.voted ? 'Stimme zurücknehmen' : 'Will ich auch!', onclick: async () => { try { await api(`/api/wishes/${w.id}/vote`, { method: 'POST' }); reload(); } catch (e) { toast(e.message); } } },
        el('span', { class: 'arrow' }, '▲'), el('b', {}, String(w.votes))),
      el('div', { class: 'wish-body' },
        el('div', { class: 'wish-title' }, el('b', {}, w.title), w.year ? el('span', { class: 'muted' }, ` (${w.year})`) : '', el('span', { class: 'chip small' }, w.type === 'series' ? 'Serie' : 'Film'), el('span', { class: `tag ${cls}` }, st)),
        w.note ? el('p', { class: 'wish-note' }, w.note) : '',
        w.statusNote ? el('p', { class: 'tiny muted' }, `💬 ${w.statusNote}`) : '',
        el('div', { class: 'chips' },
          w.tags.map((t) => el('button', { class: `chip${t.voted ? ' on' : ''}`, disabled: !data.canWish, onclick: async () => { await api(`/api/wishes/${w.id}/tag`, { method: 'POST', body: { tag: t.tag } }); reload(); } }, `#${t.tag}`, el('span', { class: 'n' }, String(t.votes)))),
          data.canWish ? tagIn : ''),
        el('div', { class: 'wish-foot' },
          el('span', { class: 'muted tiny' }, `${w.by} · ${ago(w.created)}`),
          w.status === 'done' && w.libraryItemId ? el('button', { class: 'btn small primary', onclick: () => openDetail({ id: w.libraryItemId, name: w.title }) }, '▶ Ansehen') : '',
          data.admin ? el('select', { class: 'status-sel', onchange: async (e) => {
            const note = e.target.value === 'rejected' ? prompt('Begründung (optional):') || '' : '';
            try { await api(`/api/wishes/${w.id}`, { method: 'PATCH', body: { status: e.target.value, statusNote: note } }); reload(); } catch (ex) { toast(ex.message); }
          } }, Object.entries(STATUS).map(([k, [label]]) => el('option', { value: k, selected: k === w.status }, label))) : '',
          data.admin || (w.by === (S.me && S.me.username) && w.votes <= 1) ? el('button', { class: 'link', onclick: async () => { if (!confirm(`„${w.title}“ löschen?`)) return; try { await api(`/api/wishes/${w.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(e.message); } } }, 'löschen') : '')));
  }

  /* ---------------- Profil ---------------- */

  async function openProfile() {
    let p;
    try { p = await api('/api/profile'); } catch (e) { toast(e.message); return; }
    const hrs = (h, s) => (h >= 1 ? `${n1(h)} h` : `${Math.round((s || h * 3600) / 60)} min`);
    const maxG = Math.max(1, ...p.genres.map((g) => g.hours));
    const maxW = Math.max(0.1, ...p.weekday);
    const kpi = (k, v, s) => el('div', { class: 'pkpi' }, el('span', { class: 'k' }, k), el('b', {}, v), s ? el('span', { class: 'muted tiny' }, s) : '');
    openModal(el('div', { class: 'profile' },
      el('div', { class: 'board-head' }, el('h2', {}, `📊 Dein ${p.year}`), el('span', { class: 'muted' }, p.name), el('div', { class: 'grow' }), el('button', { class: 'icon', onclick: closeModal }, '✕')),
      el('div', { class: 'pkpis' },
        kpi('Geschaut dieses Jahr', hrs(p.hoursYear, p.secondsYear)),
        kpi('Insgesamt', hrs(p.hoursAll, p.secondsAll)),
        kpi('Aktive Tage', String(p.daysActive), p.bestStreak > 1 ? `längste Serie: ${p.bestStreak} Tage am Stück` : ''),
        kpi('Gesehen', String(p.watchedCount), 'Filme & Folgen'),
        kpi('Bewertet', String(p.ratings.count), p.ratings.avg ? `im Schnitt ★ ${n1(p.ratings.avg)}` : ''),
        kpi('Wünsche', String(p.wishes), 'auf dem Brett')),
      el('div', { class: 'pgrid' },
        el('div', { class: 'pbox' }, el('h3', {}, 'Am meisten geschaut'),
          p.topTitles.length ? el('ol', { class: 'ptop' }, p.topTitles.map((t) => el('li', {}, el('span', {}, t.title, t.type === 'Series' ? el('span', { class: 'muted tiny' }, ' · Serie') : ''), el('b', {}, hrs(t.hours, t.seconds))))) : el('p', { class: 'muted' }, 'Noch nichts.')),
        el('div', { class: 'pbox' }, el('h3', {}, 'Lieblings-Genres'),
          p.genres.length ? p.genres.map((g) => el('div', { class: 'pbar' }, el('span', {}, g.genre), el('div', { class: 'bar' }, el('div', { style: `width:${(g.hours / maxG) * 100}%` })))) : el('p', { class: 'muted' }, 'Noch nichts.'),
          el('h3', { style: 'margin-top:16px' }, 'Nach Wochentag'),
          el('div', { class: 'pweek' }, ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d, i) => el('div', { class: 'pday' }, el('div', { class: 'pcol', style: `height:${Math.max(4, (p.weekday[i] / maxW) * 100)}%`, title: `${n1(p.weekday[i])} h` }), el('span', {}, d))))))), 'board');
  }

  /* ---------------- Lobby ---------------- */

  $('#btn-board').addEventListener('click', openBoard);
  $('#btn-profile').addEventListener('click', openProfile);

  function lobby() {
    const box = $('#wish-news');
    const news = (S.me && S.me.wishNews) || [];
    box.hidden = !news.length;
    box.replaceChildren(...news.slice(0, 3).map((w) => el('button', { class: 'wish-news-item', onclick: async () => {
      await api('/api/wishes/seen', { method: 'POST' }).catch(() => {});
      box.hidden = true;
      if (w.libraryItemId) openDetail({ id: w.libraryItemId, name: w.title }); else openBoard();
    } }, `🎉 Dein Wunsch ist da: „${w.title}“`)));
  }

  /* ---------------- Nachrichten vom Raum ---------------- */

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        X.queue = m.queue || []; X.poll = m.poll || null; X.round = m.round || null; X.rated = null; X.advancing = null;
        renderQueue(); renderCards();
        break;
      case 'queue': X.queue = m.queue; renderQueue(); break;
      case 'poll':
        X.poll = m.poll;
        if (m.winner) toast(`🏆 Gewonnen: „${m.winner.title}“`);
        renderCards();
        break;
      case 'rate-prompt': X.round = { item: m.item, ends: m.ends, votes: 0 }; X.rated = null; renderCards(); break;
      case 'round': if (X.round) { X.round.votes = m.votes; renderCards(); } break;
      case 'round-end':
        if (m.count) toast(`⭐ Eure Runde: ${n1(m.avg)}/10 (${m.count} ${m.count === 1 ? 'Stimme' : 'Stimmen'})`);
        X.round = null; renderCards();
        break;
      case 'advancing': X.advancing = { next: m.next, at: m.at }; renderCards(); break;
      case 'playback': if (m.action === 'load') { X.advancing = null; renderCards(); } break;
      case 'room': renderQueue(); break;
      default: break;
    }
  }

  window.WP = { onMessage, openDetail, openBoard, openProfile, lobby };
})();

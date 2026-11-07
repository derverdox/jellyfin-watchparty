'use strict';
/*
 * Admin-API (/api/admin/*): Konten, Gruppen, Einladungen, Live-Räume,
 * Telemetrie, Statistik, Protokoll und Einstellungen.
 * Aufrufer ist immer schon als Admin geprüft.
 */
const crypto = require('crypto');
const { PERMISSIONS, BITRATES } = require('./access');

function genPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(14), (b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
}

function sessionView(s, onlineSids) {
  return {
    id: s.id.slice(0, 16), created: s.created, lastSeen: s.lastSeen, ua: s.ua || '', ip: s.ip || null,
    client: /watchparty-desktop/i.test(s.ua || '') ? 'desktop' : /WatchpartyTV/i.test(s.ua || '') ? 'tv' : /Mobi|Android|iPhone|iPad/i.test(s.ua || '') ? 'mobile' : 'web',
    online: onlineSids.has(s.id),
  };
}

async function handleAdmin(ctx, req, res, url, me) {
  const { users, sessions, groups, telemetry, rooms, tunnel, cache, waitlist, grants, readJson, sendJson, HttpError } = ctx;
  const p = url.pathname.slice('/api/admin'.length);
  const method = req.method;
  const ok = (data = { ok: true }) => sendJson(res, 200, data);
  const audit = (type, extra = {}) => {
    telemetry.audit({ type, by: me.username, ...extra });
    return extra;
  };
  const body = method === 'POST' || method === 'PATCH' ? await readJson(req, 64 * 1024) : {};
  let m;

  const onlineSids = new Set();
  const onlineUsers = new Map(); // username → [{ room, kind }]
  for (const room of rooms.values()) {
    for (const c of room.clients.values()) {
      onlineSids.add(c.session.id);
      const k = c.session.username.toLowerCase();
      if (!onlineUsers.has(k)) onlineUsers.set(k, []);
      onlineUsers.get(k).push({ room: room.code, kind: c.kind });
    }
  }

  /* ---------------- Live-Übersicht ---------------- */

  if (p === '/overview' && method === 'GET') {
    const now = Date.now();
    const roomList = [...rooms.values()].map((room) => {
      const host = [...room.clients.values()].find((c) => c.session.id === room.hostSid);
      return {
        code: room.code, createdBy: room.createdBy, createdAt: room.createdAt, allowAllControl: room.allowAllControl,
        host: host ? host.session.name : null, playing: room.playing, position: room.positionAt(now),
        item: room.item ? { id: room.item.id, title: room.item.title, subtitle: room.item.subtitle, type: room.item.type, runtime: room.item.runtime, source: room.item.source || null, live: !!room.item.live, thumb: room.item.thumb || null } : null,
        chat: room.chat.filter((x) => x.kind === 'user').length,
        empty: room.clients.size === 0, emptySince: room.emptySince,
        members: [...room.clients.values()].map((c) => ({
          id: c.id, name: c.session.name, username: c.session.username, isHost: c.session.id === room.hostSid,
          status: c.status, kind: c.kind, ip: c.ip, joinedAt: c.joinedAt,
        })),
      };
    }).sort((a, b) => b.members.length - a.members.length || (b.createdAt - a.createdAt));
    const viewers = roomList.reduce((s, r) => s + r.members.length, 0);
    return ok({
      now,
      counts: {
        viewers, users: onlineUsers.size, rooms: roomList.filter((r) => !r.empty).length, roomsTotal: roomList.length,
        playing: roomList.reduce((s, r) => s + r.members.filter((x) => x.status && x.status.state === 'playing').length, 0),
        accounts: users.count(), sessions: Object.keys(sessions.map).length,
        waitlist: waitlist.pendingCount(),
        desktop: roomList.reduce((s, r) => s + r.members.filter((x) => x.kind === 'desktop').length, 0),
      },
      agent: { online: tunnel.online, info: tunnel.info, streams: tunnel.streams.size },
      cache: cache.stats(),
      traffic: telemetry.traffic(),
      health: telemetry.health(),
      peak: telemetry.persist.peak,
      hour: telemetry.hour,
      feed: telemetry.feed.slice(-60).reverse(),
      rooms: roomList,
      settings: groups.settings,
    });
  }

  if (p === '/series' && method === 'GET') {
    return ok({ range: 'week', points: telemetry.week });
  }

  if (p === '/stats' && method === 'GET') return ok(telemetry.summary());

  if (p === '/audit' && method === 'GET') {
    return ok({ entries: telemetry.readAudit(Math.min(Number(url.searchParams.get('limit')) || 300, 1000), url.searchParams.get('q') || '') });
  }

  /* ---------------- Räume ---------------- */

  if ((m = p.match(/^\/rooms\/([A-Z0-9]{4,12})\/(close|kick|announce|unlock)$/i)) && method === 'POST') {
    const code = m[1].toUpperCase();
    const room = rooms.get(code);
    if (!room) throw new HttpError(404, 'Raum nicht gefunden');
    if (m[2] === 'close') {
      ctx.closeRoom(code, `Der Raum wurde von ${me.name} geschlossen.`);
      audit('room-close', { room: code });
      telemetry.event('admin', `${me.username} hat Raum ${code} geschlossen`, { user: me.username });
      return ok();
    }
    if (m[2] === 'kick') {
      const c = room.clients.get(String(body.clientId || ''));
      if (!c) throw new HttpError(404, 'Mitglied nicht gefunden');
      for (const x of [...room.clients.values()]) {
        if (x.session.id !== c.session.id) continue;
        try { x.ws.send(JSON.stringify({ t: 'kicked', text: `Ein Admin hat dich aus dem Raum entfernt.` })); x.kicked = true; x.ws.close(4001, 'kicked'); } catch { /* egal */ }
      }
      room.system(`${c.session.name} wurde von einem Admin entfernt`);
      audit('room-kick', { room: code, target: c.session.username });
      return ok();
    }
    if (m[2] === 'announce') {
      const text = String(body.text || '').trim().slice(0, 300);
      if (!text) throw new HttpError(400, 'Text fehlt');
      room.addChat({ kind: 'announce', from: me.name, text });
      room.broadcast({ t: 'announce', from: me.name, text });
      audit('announce', { room: code, text });
      return ok();
    }
    if (m[2] === 'unlock') {
      room.allowAllControl = true;
      room.system('Ein Admin hat die Steuerung für alle freigegeben');
      room.broadcast({ t: 'room', room: ctx.publicRoom(room), members: room.members() });
      return ok();
    }
  }

  if (p === '/announce' && method === 'POST') {
    const text = String(body.text || '').trim().slice(0, 300);
    if (!text) throw new HttpError(400, 'Text fehlt');
    let n = 0;
    for (const room of rooms.values()) {
      if (!room.clients.size) continue;
      room.addChat({ kind: 'announce', from: me.name, text });
      room.broadcast({ t: 'announce', from: me.name, text });
      n++;
    }
    audit('announce', { room: '*', text });
    telemetry.event('admin', `${me.username}: Ansage an ${n} Räume`, { user: me.username });
    return ok({ rooms: n });
  }

  /* ---------------- Konten ---------------- */

  if (p === '/users' && method === 'GET') {
    const list = users.list().map((u) => {
      const sess = sessions.forUser(u.username);
      return {
        ...u,
        effective: groups.resolve(users.find(u.username)).groups,
        sessions: sess.map((s) => sessionView(s, onlineSids)).sort((a, b) => b.lastSeen - a.lastSeen),
        lastSeen: sess.reduce((t, s) => Math.max(t, s.lastSeen || 0), 0) || null,
        online: onlineUsers.get(u.username.toLowerCase()) || [],
        stats: telemetry.userStats(u.username),
        expired: !!(u.expires && Date.now() > u.expires),
      };
    }).sort((a, b) => Number(b.owner) - Number(a.owner) || Number(b.admin) - Number(a.admin) || a.username.localeCompare(b.username));
    return ok({ users: list, me: me.username, owner: me.owner });
  }

  if (p === '/users' && method === 'POST') {
    const username = String(body.username || '').trim();
    const generated = !body.password;
    const password = body.password || genPassword();
    if (body.admin && !me.owner) throw new HttpError(403, 'Nur der Haupt-Admin darf Admins anlegen');
    const gs = (body.groups || []).filter((g) => groups.get(g));
    let u;
    try {
      u = await users.create(username, password, {
        admin: !!body.admin, groups: gs, createdBy: me.username, note: body.note, expires: body.expires ? Number(body.expires) : null,
      });
    } catch (e) { throw new HttpError(400, e.message); }
    audit('user-create', { target: u.username, admin: !!body.admin, groups: gs });
    telemetry.event('admin', `${me.username} hat das Konto ${u.username} angelegt`, { user: me.username });
    ctx.bumpAccess();
    return ok({ user: users.view(u), password: generated ? password : null });
  }

  if ((m = p.match(/^\/users\/([^/]+)(?:\/(password|logout))?$/))) {
    const name = decodeURIComponent(m[1]);
    const u = users.find(name);
    if (!u) throw new HttpError(404, 'Benutzer nicht gefunden');
    const self = u.username.toLowerCase() === me.username.toLowerCase();
    // Andere Admins darf nur der Haupt-Admin anfassen
    const guard = () => { if (u.admin && !self && !me.owner) throw new HttpError(403, 'Andere Admins kann nur der Haupt-Admin ändern'); };

    if (!m[2] && method === 'PATCH') {
      guard();
      const patch = {};
      for (const k of ['groups', 'note', 'disabled', 'expires', 'admin']) if (k in body) patch[k] = body[k];
      if ('admin' in patch && !me.owner) throw new HttpError(403, 'Nur der Haupt-Admin darf Admin-Rechte vergeben');
      if (self && (patch.disabled || ('admin' in patch && !patch.admin))) throw new HttpError(400, 'Das kannst du bei dir selbst nicht machen');
      if (patch.groups) patch.groups = patch.groups.filter((g) => groups.get(g));
      try { users.update(u.username, patch); } catch (e) { throw new HttpError(400, e.message); }
      ctx.bumpAccess();
      if (patch.disabled || (patch.expires && patch.expires < Date.now())) {
        sessions.deleteForUser(u.username);
        ctx.disconnectUser(u.username, 'Dein Konto wurde gesperrt.');
      }
      audit('user-update', { target: u.username, ...patch });
      return ok({ user: users.view(users.find(u.username)) });
    }

    if (!m[2] && method === 'DELETE') {
      if (u.owner) throw new HttpError(403, 'Der Haupt-Admin kann nicht gelöscht werden');
      if (self) throw new HttpError(400, 'Du kannst dich nicht selbst löschen');
      guard();
      users.remove(u.username);
      sessions.deleteForUser(u.username);
      ctx.disconnectUser(u.username, 'Dein Konto wurde gelöscht.');
      ctx.bumpAccess();
      audit('user-delete', { target: u.username });
      telemetry.event('admin', `${me.username} hat das Konto ${u.username} gelöscht`, { user: me.username, level: 'warn' });
      return ok();
    }

    if (m[2] === 'password' && method === 'POST') {
      guard();
      const generated = !body.password;
      const password = body.password || genPassword();
      try { await users.setPassword(u.username, password); } catch (e) { throw new HttpError(400, e.message); }
      if (body.logout !== false && !self) { sessions.deleteForUser(u.username); ctx.disconnectUser(u.username, 'Dein Passwort wurde zurückgesetzt. Bitte neu anmelden.'); }
      audit('user-password', { target: u.username });
      return ok({ password: generated ? password : null });
    }

    if (m[2] === 'logout' && method === 'POST') {
      guard();
      const except = self ? me.id : undefined;
      sessions.deleteForUser(u.username, except);
      for (const s of sessions.forUser(u.username)) if (s.id !== except) ctx.disconnectUser(u.username, 'Du wurdest abgemeldet.', s.id);
      if (!self) ctx.disconnectUser(u.username, 'Du wurdest von einem Admin abgemeldet.');
      audit('user-logout', { target: u.username });
      return ok();
    }
  }

  if ((m = p.match(/^\/sessions\/([a-f0-9]{16})$/)) && method === 'DELETE') {
    const s = Object.values(sessions.map).find((x) => x.id.startsWith(m[1]));
    if (!s) throw new HttpError(404, 'Sitzung nicht gefunden');
    const owner = users.find(s.username);
    if (owner && owner.admin && owner.username !== me.username && !me.owner) throw new HttpError(403, 'Sitzungen anderer Admins kann nur der Haupt-Admin beenden');
    ctx.disconnectUser(s.username, 'Diese Sitzung wurde beendet.', s.id);
    sessions.delete(s.id);
    audit('session-revoke', { target: s.username });
    return ok();
  }

  /* ---------------- Gruppen ---------------- */

  if (p === '/groups' && method === 'GET') {
    const counts = {};
    for (const u of users.list()) for (const g of groups.resolve(users.find(u.username)).groups) counts[g] = (counts[g] || 0) + (u.admin ? 0 : 1);
    return ok({
      groups: groups.list().map((g) => ({ ...g, members: counts[g.id] || 0 })),
      permissions: PERMISSIONS, bitrates: BITRATES, defaultGroup: groups.settings.defaultGroup,
    });
  }
  if (p === '/groups' && method === 'POST') {
    let g;
    try { g = groups.create(body); } catch (e) { throw new HttpError(400, e.message); }
    audit('group-create', { target: g.name });
    return ok({ group: g });
  }
  if ((m = p.match(/^\/groups\/([a-z0-9]+)$/))) {
    if (method === 'PATCH') {
      let g;
      try { g = groups.update(m[1], body); } catch (e) { throw new HttpError(400, e.message); }
      ctx.bumpAccess();
      audit('group-update', { target: g.name });
      return ok({ group: g });
    }
    if (method === 'DELETE') {
      const g = groups.get(m[1]);
      try { groups.remove(m[1]); } catch (e) { throw new HttpError(400, e.message); }
      users.dropGroup(m[1]);
      ctx.bumpAccess();
      audit('group-delete', { target: g ? g.name : m[1] });
      return ok();
    }
  }

  /** Bibliotheks-Baum für die Inhaltsauswahl (Admin sieht alles). */
  if (p === '/browse' && method === 'GET') {
    const parentId = url.searchParams.get('parentId');
    if (!parentId) {
      const v = await ctx.jf(`/Users/${ctx.uid()}/Views`);
      return ok({ items: (v.Items || []).map(ctx.mapItem) });
    }
    if (!ctx.ID_RE.test(parentId)) throw new HttpError(400, 'Ungültige ID');
    const q = new URLSearchParams({ ParentId: parentId, SortBy: 'IsFolder,SortName', SortOrder: 'Descending,Ascending', Limit: '300', Fields: ctx.ITEM_FIELDS, EnableImageTypes: 'Primary', ImageTypeLimit: '1' });
    const d = await ctx.jf(`/Users/${ctx.uid()}/Items?${q}`);
    return ok({ items: (d.Items || []).map(ctx.mapItem), total: d.TotalRecordCount || 0 });
  }

  /* ---------------- Einladungen ---------------- */

  if (p === '/invites' && method === 'GET') return ok({ invites: users.listInvites() });
  if (p === '/invites' && method === 'POST') {
    if (body.group && !groups.get(body.group)) throw new HttpError(400, 'Gruppe nicht gefunden');
    const code = users.createInvite(me.username, { hours: body.hours, uses: body.uses, group: body.group, note: body.note });
    audit('invite-create', { code: code.slice(0, 6), group: body.group || null, uses: body.uses || 1 });
    return ok({ code, path: `/invite/${code}` });
  }
  if ((m = p.match(/^\/invites\/([A-Za-z0-9_-]{8,40})$/)) && method === 'DELETE') {
    try { users.revokeInvite(m[1]); } catch (e) { throw new HttpError(404, e.message); }
    audit('invite-revoke', { code: m[1].slice(0, 6) });
    return ok();
  }

  /* ---------------- Warteliste (Bewerbungen) ---------------- */

  if (p === '/waitlist' && method === 'GET') {
    return ok({ entries: waitlist.list(), pending: waitlist.pendingCount(), settings: { waitlistEnabled: groups.settings.waitlistEnabled } });
  }
  if ((m = p.match(/^\/waitlist\/([A-Za-z0-9_-]{4,20})\/accept$/)) && method === 'POST') {
    const entry = waitlist.get(m[1]);
    if (!entry) throw new HttpError(404, 'Bewerbung nicht gefunden');
    if (entry.status === 'accepted' && entry.inviteCode && users.checkInvite(entry.inviteCode)) throw new HttpError(400, 'Diese Bewerbung hat schon einen gültigen Einladungslink');
    const username = String(body.username || '').trim();
    if (username && !users.validName(username)) throw new HttpError(400, 'Benutzername: 2–24 Zeichen, Buchstaben/Zahlen/._-');
    if (username && users.find(username)) throw new HttpError(400, 'Benutzername ist schon vergeben');
    if (body.group && !groups.get(body.group)) throw new HttpError(400, 'Gruppe nicht gefunden');
    const days = Math.min(Math.max(Number(body.days) || 0, 0), 3650);
    const code = users.createInvite(me.username, {
      hours: Math.min(Math.max(Number(body.hours) || 72, 1), 24 * 90), uses: 1,
      group: body.group || null, note: `Bewerbung: ${entry.name}${entry.contact ? ` (${entry.contact})` : ''}`, expiresDays: days || undefined,
    });
    waitlist.accept(m[1], { by: me.username, inviteCode: code, suggestedUser: username, days, note: body.note });
    audit('waitlist-accept', { target: entry.name, days, group: body.group || null });
    telemetry.event('admin', `${me.username} hat die Bewerbung von ${entry.name} angenommen${days ? ` (${days} Tage)` : ''}`, { user: me.username });
    return ok({ code, path: `/invite/${code}`, days });
  }
  if ((m = p.match(/^\/waitlist\/([A-Za-z0-9_-]{4,20})\/reject$/)) && method === 'POST') {
    try { waitlist.reject(m[1], { by: me.username, note: body.note }); } catch (e) { throw new HttpError(404, e.message); }
    audit('waitlist-reject', { target: (waitlist.get(m[1]) || {}).name || m[1] });
    return ok();
  }
  if ((m = p.match(/^\/waitlist\/([A-Za-z0-9_-]{4,20})$/)) && method === 'DELETE') {
    if (!waitlist.remove(m[1])) throw new HttpError(404, 'Bewerbung nicht gefunden');
    audit('waitlist-delete', { target: m[1] });
    return ok();
  }

  /* ---------------- Förder-Heft (Laufzeiten, Zahlungen extern) ---------------- */

  if (p === '/grants' && method === 'GET') {
    const who = url.searchParams.get('user') || '';
    return ok({ grants: grants.list(who || null).slice(0, 200) });
  }
  if ((m = p.match(/^\/users\/([^/]+)\/grant$/)) && method === 'POST') {
    const name = decodeURIComponent(m[1]);
    const u = users.find(name);
    if (!u) throw new HttpError(404, 'Benutzer nicht gefunden');
    if (u.admin && !me.owner) throw new HttpError(403, 'Andere Admins kann nur der Haupt-Admin ändern');
    if (u.owner) throw new HttpError(400, 'Der Haupt-Admin läuft nicht ab');
    const ext = grants.extend(u, body.days);
    users.update(u.username, { expires: ext.to });
    const g = grants.add({
      user: u.username, by: me.username, days: ext.days, from: ext.from, to: ext.to,
      method: body.method, amount: body.amount, ref: body.ref, note: body.note,
    });
    ctx.bumpAccess();
    audit('user-grant', { target: u.username, days: ext.days, method: g.method, to: ext.to });
    telemetry.event('admin', `${me.username} hat ${u.username} um ${ext.days} Tage verlängert`, { user: me.username });
    return ok({ grant: g, user: users.view(users.find(u.username)) });
  }

  /* ---------------- Sicherheit ---------------- */

  if (p === '/security' && method === 'GET') {
    const o = ctx.guard.overview();
    const failed = telemetry.readAudit(1000).filter((e) => e.type === 'login-failed' && Date.now() - e.t < 7 * 86400000);
    return ok({ ...o, failed7d: failed.length, me: ctx.clientIp(req) });
  }
  if (p === '/security/ban' && method === 'POST') {
    const ip = String(body.ip || '').trim();
    if (!/^[0-9a-f:.]{3,45}$/i.test(ip)) throw new HttpError(400, 'Ungültige IP-Adresse');
    if (ip === ctx.clientIp(req)) throw new HttpError(400, 'Das ist deine eigene IP');
    ctx.guard.ban(ip, Number(body.hours) || 0, body.reason || 'manuell', me.username);
    for (const room of rooms.values()) {
      for (const c of [...room.clients.values()]) {
        if (c.ip !== ip || (users.find(c.session.username) || {}).admin) continue;
        try { c.ws.send(JSON.stringify({ t: 'kicked', text: 'Deine IP wurde gesperrt.' })); c.kicked = true; c.ws.close(4001, 'banned'); } catch { /* egal */ }
      }
    }
    return ok();
  }
  if (p === '/security/unban' && method === 'POST') {
    ctx.guard.unban(String(body.ip || ''));
    audit('ip-unban', { ip: String(body.ip || '') });
    return ok();
  }

  /* ---------------- Einstellungen ---------------- */

  if (p === '/settings' && method === 'GET') return ok({ settings: groups.settings, groups: groups.list().map((g) => ({ id: g.id, name: g.name })) });
  if (p === '/settings' && method === 'PATCH') {
    let st;
    try { st = groups.setSettings(body); } catch (e) { throw new HttpError(400, e.message); }
    if ('maintenance' in body && body.maintenance) {
      // Nicht-Admins rauswerfen
      for (const u of users.list()) if (!u.admin) ctx.disconnectUser(u.username, 'Gerade Wartungsarbeiten – gleich wieder da.');
    }
    audit('settings', body);
    return ok({ settings: st });
  }

  throw new HttpError(404, 'Unbekannte Admin-Funktion');
}

module.exports = { handleAdmin, genPassword };

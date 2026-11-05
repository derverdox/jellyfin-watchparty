'use strict';
/*
 * Minimaler Service Worker: macht die App installierbar (Startbildschirm)
 * und zeigt die Seiten offline, wenn das Netz fehlt. API, Streams und Bilder
 * werden bewusst NIEMALS gecacht.
 */
const SHELL = ['/', '/scan', '/style.css', '/scan.css', '/app.js', '/scan.js', '/extras.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/favicon.svg'];
const CACHE = 'wp-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (/^\/(api|stream|img|subs|hls1)\//.test(u.pathname) || u.pathname.startsWith('/vendor/')) return;
  if (e.request.mode === 'navigate') {
    // Netzwerk zuerst (immer aktuell), Fallback: gecachte Shell.
    e.respondWith(fetch(e.request).catch(() => caches.match(u.pathname).then((r) => r || caches.match('/'))));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => r)));
});

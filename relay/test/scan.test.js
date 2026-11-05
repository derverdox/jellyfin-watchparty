'use strict';
/** ISBN/EAN-Scan: Produktquellen (fake), Bibliotheks-Abgleich, Formate, Lücken, Bind. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');

const fs = require('fs');
const os = require('os');
const path = require('path');
const fakeJf = require('./fixtures/fake-jellyfin');
const { normalizeCode, classifyProduct, formatOfHeight, formatsOfItem } = require('../lib/scan');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Normalisierung & Klassifikation', () => {
  assert.strictEqual(normalizeCode('4006680012345'), '4006680012345');
  assert.strictEqual(normalizeCode('400668 001234-5'), '4006680012345');
  assert.strictEqual(normalizeCode('400668001234'), '0400668001234'); // UPC → EAN-13
  assert.strictEqual(normalizeCode('12345678'), '12345678');
  assert.strictEqual(normalizeCode('abc'), null);
  const c = classifyProduct('Blade Runner – The Final Cut [4K Blu-ray] Staffeln 1-3 komplett');
  assert.strictEqual(c.kind, 'series');
  assert.deepStrictEqual(c.formats, ['uhd']); // „4K Blu-ray“ zählt als UHD, nicht als normaler Blu-ray
  assert.deepStrictEqual(c.seasons, [1, 2, 3]);
  assert.strictEqual(c.complete, true);
  assert.deepStrictEqual(['480', '576', '720', '1080', '2160'].map((h) => formatOfHeight(+h)), ['dvd', 'dvd', null, 'bluray', 'uhd']);
  const item = { MediaSources: [{ Path: '/x/Film.1080p.mkv', MediaStreams: [{ Type: 'Video', Height: 1080 }] }] };
  assert.deepStrictEqual(formatsOfItem(item), ['bluray']);
});

/* Produkt-Quellen als lokale Fakes; Zugriffe werden gezählt (Cache-Nachweis). */
const PRODUCTS = {
  '4000000000001': 'Alter Schinken [4K Ultra HD Blu-ray]', // Bibliothek hat nur DVD (576p)
  '4000000000002': 'Testserie - Die komplette Collection Staffel 1-3 DVD', // uns fehlt S3
  '4000000000003': 'Fremdes Ding [Blu-ray]', // nicht in der Bibliothek
  '4000000000004': 'Die Rückkehr der Ritter [Blu-ray]', // Bibliothek hat UHD
  '9780000000001': null, // absichtlich NICHT bei ean-search → Open Library muss liefern
};
const OL_PRODUCTS = { 'ISBN:9780000000001': { title: 'Alter Schinken (DVD)', publishers: [{ name: 'Tollwood Film' }], publish_date: '1985' } };
let eanHits = 0;

test('Scan: anderes Format, Serienlücken, Fehlend, Bind, Cache', { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-scan-'));
  const jf = await fakeJf.start();
  const { I } = jf;
  const prov = await new Promise((r) => {
    const e = http.createServer((req, res) => {
      eanHits++;
      const code = new URL(req.url, 'http://x').searchParams.getAll('barcodes[]')[0];
      const name = PRODUCTS[code];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(name ? { success: 1, products: [{ barcode: code, 'product-name': name, 'brand-name': 'Testlabel' }] } : { success: 1, products: [] }));
    });
    const dg = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ results: [] })); });
    const ol = http.createServer((req, res) => {
      const key = new URL(req.url, 'http://x').searchParams.get('bibkeys');
      const hit = OL_PRODUCTS[key];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hit ? { [key]: hit } : {}));
    });
    e.listen(0, '127.0.0.1', () => dg.listen(0, '127.0.0.1', () => ol.listen(0, '127.0.0.1', () => r({ e, ep: e.address().port, dg, dp: dg.address().port, ol, op: ol.address().port }))));
  });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = 's'.repeat(40);
  const procs = [
    spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_TOKEN: token, ADMIN_USER: 'chef', ADMIN_PASSWORD: 'geheim123', DATA_DIR: path.join(tmp, 'd'), CACHE_DIR: path.join(tmp, 'c'), SCAN_EANSEARCH: 'fake', SCAN_EANSEARCH_URL: `http://127.0.0.1:${prov.ep}`, SCAN_DISCOGS: 'x', SCAN_DISCOGS_URL: `http://127.0.0.1:${prov.dp}`, SCAN_OPENLIBRARY_URL: `http://127.0.0.1:${prov.op}` }, stdio: 'ignore' }),
    spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.js')], { env: { ...process.env, RELAY_URL: `ws://127.0.0.1:${port}/agent`, AGENT_TOKEN: token, JELLYFIN_URL: `http://127.0.0.1:${jf.port}`, JELLYFIN_API_KEY: 'k', DATA_DIR: path.join(tmp, 'a'), ADMIN_PORT: '0' }, stdio: 'ignore' }),
  ];
  t.after(async () => {
    await Promise.all(procs.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); p.kill(); })));
    prov.e.close(); prov.dg.close(); prov.ol.close(); jf.server.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await (await fetch(`${base}/healthz`)).json()).agent) break; } catch { /* startet */ } await sleep(100); }
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const r0 = await req('GET', '/api/scan?code=123');
  assert.ok([401, 400].includes(r0.status), 'ohne Login kein Scan');
  await req('POST', '/api/login', { username: 'chef', password: 'geheim123' });

  // Eingabe-Validierung
  assert.strictEqual((await req('GET', '/api/scan?code=quatsch')).status, 400);

  // 1) Wir haben ihn, aber nur als DVD und gescannt als 4K → anderes Format
  const s1 = (await req('GET', '/api/scan?code=4000000000001')).data;
  assert.strictEqual(s1.product.title, PRODUCTS['4000000000001'], 'Produkt aus ean-search');
  assert.strictEqual(s1.verdict, 'own_other_format');
  assert.strictEqual(s1.match.name, 'Alter Schinken');
  assert.deepStrictEqual(s1.have, ['dvd']);
  assert.deepStrictEqual(s1.product.formats, ['uhd']);

  // 2) Complete Box gescannt, Bibliothek hat S1–S2 → Lücke bei S3
  const s2 = (await req('GET', '/api/scan?code=4000000000002')).data;
  assert.strictEqual(s2.product.kind, 'series');
  assert.strictEqual(s2.match.name, 'Testserie');
  assert.strictEqual(s2.verdict, 'own_incomplete');
  assert.deepStrictEqual(s2.haveSeasons, [1, 2]);
  assert.deepStrictEqual(s2.gaps, [3]);

  // 3) Nicht in der Bibliothek → missing, dann Wunsch anlegen
  const s3 = (await req('GET', '/api/scan?code=4000000000003')).data;
  assert.strictEqual(s3.verdict, 'missing');
  assert.strictEqual(s3.match, null);
  const w = await req('POST', '/api/wishes', { method: 'POST', title: 'Fremdes Ding', year: null, type: 'movie' });
  assert.strictEqual(w.status, 200, 'Wunsch aus Scan-Ergebnis');

  // 4) Scannen (4K) vs. Blu-ray erwartet → wir haben sogar besser (UHD ⊅ bluray? anderes Format)
  const s4 = (await req('GET', '/api/scan?code=4000000000004')).data;
  assert.strictEqual(s4.match.name, 'Die Rückkehr der Ritter');
  assert.ok(['own', 'own_other_format'].includes(s4.verdict), `verdict=${s4.verdict}`);
  assert.deepStrictEqual(s4.have, ['uhd']);

  // 5) Bind: Barcode fest mit Item verknüpfen, danach sofort "Haben wir"
  const b = await req('GET', '/api/scan?code=4000000000003&bind=' + I.M_METRO);
  assert.strictEqual(b.status, 200);
  const s5 = (await req('GET', '/api/scan?code=4000000000003')).data;
  assert.strictEqual(s5.verdict, 'own');
  assert.strictEqual(s5.match.name, 'Metropolis');
  assert.strictEqual(s5.confirmed, true);

  // 5b) 978er-ISBN → Open Library liefert (ean-search hat nichts)
  const s5b = (await req('GET', '/api/scan?code=9780000000001')).data;
  assert.strictEqual(s5b.product.source, 'openlibrary', 'ISBN läuft über Open Library');
  assert.strictEqual(s5b.product.title, 'Alter Schinken (DVD)');
  assert.strictEqual(s5b.match.name, 'Alter Schinken');
  assert.strictEqual(s5b.verdict, 'own'); // DVD gescannt, DVD vorhanden

  // 6) Kein Produkt (Discogs-Fake leer) → unknown
  const s6 = (await req('GET', '/api/scan?code=4000000000009')).data;
  assert.strictEqual(s6.verdict, 'unknown');
  assert.strictEqual(s6.product, null);

  // 7) Zweiter Scan derselben Codes trifft den Cache → keine neuen externen Zugriffe
  const hitsBefore = eanHits;
  await req('GET', '/api/scan?code=4000000000001');
  await req('GET', '/api/scan?code=4000000000002');
  assert.strictEqual(eanHits, hitsBefore, 'zweiter Scan ohne externe Abfrage');

  // 8) Statische Routen + PWA-Artefakte
  for (const f of ['/scan', '/manifest.webmanifest', '/sw.js', '/icon-192.png', '/scan.css', '/scan.js', '/vendor/zxing.min.js']) {
    const r = await fetch(base + f);
    assert.ok(r.ok, `${f} liefert ${r.status}`);
  }
});

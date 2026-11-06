'use strict';
/**
 * Lädt die Abspiel-Komponenten herunter und richtet sie ein (nur Windows):
 *  - Basis: mpv, Python 3.12 (embedded) und VapourSynth R70 (portable)
 *  - Framegen: vs-mlrt mit TensorRT und ein RIFE-Modell
 * Alles landet in einem Ordner, damit mpv VapourSynth ohne Installation findet.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');

const PYTHON_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip';
const VS_URL = 'https://github.com/vapoursynth/vapoursynth/releases/download/R70/VapourSynth64-Portable-R70.zip';
const MPV_API = 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest';
const MPV_ASSET = /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;
const VSMLRT_TAG = 'v15.16';
const VSMLRT_BASE = `https://github.com/AmusementClub/vs-mlrt/releases/download/${VSMLRT_TAG}`;
const VSMLRT_PARTS = [`vsmlrt-windows-x64-tensorrt.${VSMLRT_TAG}.7z.001`, `vsmlrt-windows-x64-tensorrt.${VSMLRT_TAG}.7z.002`];
const VSMLRT_SCRIPTS = `scripts.${VSMLRT_TAG}.7z`;
const MODELS_BASE = 'https://github.com/AmusementClub/vs-mlrt/releases/download/external-models';
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

/** RIFE-Modelle, die der Client anbietet. pad = nötige Teilbarkeit der Bildgröße. */
const MODELS = {
  v4_26: { file: 'rife_v4.26.7z', onnx: 'rife_v4.26.onnx', label: 'RIFE 4.26 · Qualität', pad: 64 },
  v4_25_lite: { file: 'rife_v4.25_lite.7z', onnx: 'rife_v4.25_lite.onnx', label: 'RIFE 4.25 Lite · schnell', pad: 128 },
  v4_22_lite: { file: 'rife_v4.22_lite.7z', onnx: 'rife_v4.22_lite.onnx', label: 'RIFE 4.22 Lite · am schnellsten', pad: 32 },
};

function sevenZipPath() {
  // eslint-disable-next-line global-require
  const p = require('7zip-bin').path7za;
  return p.replace('app.asar', 'app.asar.unpacked');
}

class Cancelled extends Error { constructor() { super('Abgebrochen'); this.cancelled = true; } }

class Installer extends EventEmitter {
  constructor(rootDir, vpyDir) {
    super();
    this.root = rootDir;
    this.vpyDir = vpyDir;
    this.dir = path.join(rootDir, 'mpv');
    this.dl = path.join(rootDir, 'downloads');
    this.manifestFile = path.join(rootDir, 'manifest.json');
    this.busy = false;
    this.abort = null;
  }

  get mpvExe() { return path.join(this.dir, process.platform === 'win32' ? 'mpv.exe' : 'mpv'); }
  get vspipeExe() { return path.join(this.dir, 'VSPipe.exe'); }
  get pluginsDir() { return path.join(this.dir, 'vs-plugins'); }
  get scriptsDir() { return path.join(this.dir, 'vs-scripts'); }
  get modelsDir() { return path.join(this.pluginsDir, 'models', 'rife'); }

  /** yt-dlp für YouTube: unter Windows neben mpv, sonst aus dem PATH. */
  ytdlpPath() { return process.platform === 'win32' ? path.join(this.dir, 'yt-dlp.exe') : 'yt-dlp'; }

  /**
   * yt-dlp holen (falls es fehlt) bzw. aktuell halten. YouTube ändert oft etwas,
   * ein altes yt-dlp ist der häufigste Grund, wenn Videos nicht mehr laden.
   */
  async ensureYtDlp() {
    if (process.platform !== 'win32') return 'yt-dlp';
    const exe = this.ytdlpPath();
    if (fs.existsSync(exe)) return exe;
    if (!fs.existsSync(this.dir)) throw new Error('Erst den Player einrichten (Lobby → Player einrichten)');
    const own = !this.abort;
    if (own) this.abort = new AbortController();
    try {
      await fsp.mkdir(this.dl, { recursive: true });
      const file = await this.download(YTDLP_URL, 'yt-dlp.exe', 'ytdlp', 'yt-dlp herunterladen');
      await fsp.rename(file, exe).catch(async () => { await fsp.copyFile(file, exe); await fsp.rm(file, { force: true }); });
      const m = this.manifest();
      m.ytdlpUpdated = Date.now();
      this.saveManifest(m);
    } finally { if (own) this.abort = null; }
    return exe;
  }

  /** Höchstens einmal am Tag im Hintergrund „yt-dlp -U“. */
  updateYtDlp() {
    const exe = this.ytdlpPath();
    if (process.platform !== 'win32' || !fs.existsSync(exe)) return;
    const m = this.manifest();
    if (m.ytdlpUpdated && Date.now() - m.ytdlpUpdated < 24 * 3600 * 1000) return;
    execFile(exe, ['-U'], { timeout: 120000, windowsHide: true }, () => {
      const mm = this.manifest();
      mm.ytdlpUpdated = Date.now();
      this.saveManifest(mm);
    });
  }

  manifest() {
    try { return JSON.parse(fs.readFileSync(this.manifestFile, 'utf8')); } catch { return {}; }
  }

  saveManifest(m) {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.manifestFile, JSON.stringify(m, null, 2));
  }

  status() {
    const m = this.manifest();
    const supported = process.platform === 'win32';
    const base = !!m.base && fs.existsSync(this.mpvExe);
    const framegen = base && !!m.framegen && fs.existsSync(path.join(this.scriptsDir, 'vsmlrt.py'));
    const models = Object.keys(MODELS).filter((k) => fs.existsSync(path.join(this.modelsDir, MODELS[k].onnx)));
    const ytdlp = supported ? fs.existsSync(this.ytdlpPath()) : true;
    return { supported, base, framegen, models, ytdlp, mpv: m.mpvVersion || null, busy: this.busy, dir: this.root };
  }

  /** Unsere eigenen Python-Hilfsdateien bei jedem Start aktualisieren. */
  syncScripts() {
    if (!fs.existsSync(this.dir)) return;
    fs.mkdirSync(this.scriptsDir, { recursive: true });
    for (const f of ['wp_rife.py']) fs.copyFileSync(path.join(this.vpyDir, f), path.join(this.scriptsDir, f));
  }

  cancel() { if (this.abort) this.abort.abort(); }

  progress(step, detail, pct) { this.emit('progress', { step, detail, pct: pct == null ? null : Math.max(0, Math.min(100, pct)) }); }

  async run(what, model) {
    if (this.busy) throw new Error('Es läuft schon eine Installation');
    if (process.platform !== 'win32') throw new Error('Die automatische Installation gibt es nur unter Windows. Unter Linux/macOS einfach mpv installieren.');
    this.busy = true;
    this.abort = new AbortController();
    try {
      if (!this.status().base) await this.installBase();
      if (!fs.existsSync(this.ytdlpPath())) await this.ensureYtDlp().catch((e) => this.progress('ytdlp', `yt-dlp fehlt (YouTube geht dann nicht): ${e.message}`, null));
      if (what === 'framegen') {
        if (!this.status().framegen) await this.installFramegen();
        if (model && !this.status().models.includes(model)) await this.installModel(model);
      }
      this.syncScripts();
      this.progress('done', 'Fertig', 100);
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  /* ---------------- Basis ---------------- */

  async installBase() {
    await fsp.mkdir(this.dl, { recursive: true });
    this.progress('mpv', 'Suche aktuelle mpv-Version …', 0);
    const rel = await this.fetchJson(MPV_API);
    const asset = (rel.assets || []).find((a) => MPV_ASSET.test(a.name));
    if (!asset) throw new Error('Keine passende mpv-Version gefunden');

    const mpvFile = await this.download(asset.browser_download_url, asset.name, 'mpv', 'mpv herunterladen');
    const pyFile = await this.download(PYTHON_URL, path.basename(PYTHON_URL), 'python', 'Python herunterladen');
    const vsFile = await this.download(VS_URL, path.basename(VS_URL), 'vapoursynth', 'VapourSynth herunterladen');

    await fsp.rm(this.dir, { recursive: true, force: true });
    await fsp.mkdir(this.dir, { recursive: true });

    this.progress('extract', 'mpv entpacken …', null);
    const tmp = path.join(this.root, 'tmp-mpv');
    await fsp.rm(tmp, { recursive: true, force: true });
    await this.extract(mpvFile, tmp);
    const mpvExe = await findFile(tmp, (n) => n.toLowerCase() === 'mpv.exe');
    if (!mpvExe) throw new Error('mpv.exe nicht im Archiv gefunden');
    await moveContents(path.dirname(mpvExe), this.dir);
    await fsp.rm(tmp, { recursive: true, force: true });

    this.progress('extract', 'Python entpacken …', null);
    await this.extract(pyFile, this.dir);

    this.progress('extract', 'VapourSynth entpacken …', null);
    await this.extract(vsFile, this.dir, ['-xr!doc', '-xr!sdk']);

    // Das Wheel ist nur ein Zip: so installieren, wie pip es tun würde
    const wheel = path.join(this.dir, 'wheel', 'VapourSynth-70-cp312-cp312-win_amd64.whl');
    const wtmp = path.join(this.root, 'tmp-wheel');
    await fsp.rm(wtmp, { recursive: true, force: true });
    await this.extract(wheel, wtmp, [], 'zip');
    const site = path.join(this.dir, 'Lib', 'site-packages');
    await fsp.mkdir(site, { recursive: true });
    await moveContents(path.join(wtmp, 'VapourSynth-70.data', 'data', 'Lib', 'site-packages'), site);
    await fsp.rm(path.join(wtmp, 'VapourSynth-70.data'), { recursive: true, force: true });
    await moveContents(wtmp, site);
    await fsp.rm(wtmp, { recursive: true, force: true });
    await fsp.rm(path.join(this.dir, 'wheel'), { recursive: true, force: true });

    // Embedded Python soll unsere Skripte und site-packages finden
    const pth = (await fsp.readdir(this.dir)).find((f) => /^python3\d+\._pth$/i.test(f));
    if (!pth) throw new Error('python312._pth fehlt');
    await fsp.writeFile(path.join(this.dir, pth), ['python312.zip', '.', 'vs-scripts', 'Lib\\site-packages', ''].join('\r\n'));
    await fsp.mkdir(this.scriptsDir, { recursive: true });
    await fsp.mkdir(this.pluginsDir, { recursive: true });

    const m = this.manifest();
    m.base = true;
    m.mpvVersion = asset.name.replace(/\.7z$/, '');
    m.framegen = false;
    this.saveManifest(m);
    for (const f of [mpvFile, pyFile, vsFile]) await fsp.rm(f, { force: true });
  }

  /* ---------------- Framegen ---------------- */

  async installFramegen() {
    await fsp.mkdir(this.dl, { recursive: true });
    const parts = [];
    for (const [i, name] of VSMLRT_PARTS.entries()) {
      parts.push(await this.download(`${VSMLRT_BASE}/${name}`, name, 'tensorrt', `TensorRT herunterladen (Teil ${i + 1}/${VSMLRT_PARTS.length})`));
    }
    const scripts = await this.download(`${VSMLRT_BASE}/${VSMLRT_SCRIPTS}`, VSMLRT_SCRIPTS, 'tensorrt', 'vs-mlrt-Skripte herunterladen');

    this.progress('extract', 'TensorRT entpacken (dauert etwas) …', 0);
    const tmp = path.join(this.root, 'tmp-trt');
    await fsp.rm(tmp, { recursive: true, force: true });
    await this.extract(parts[0], tmp);
    const vstrt = await findFile(tmp, (n) => n.toLowerCase() === 'vstrt.dll');
    if (!vstrt) throw new Error('vstrt.dll nicht im TensorRT-Paket gefunden');
    await moveContents(path.dirname(vstrt), this.pluginsDir);
    await fsp.rm(tmp, { recursive: true, force: true });

    const stmp = path.join(this.root, 'tmp-scripts');
    await fsp.rm(stmp, { recursive: true, force: true });
    await this.extract(scripts, stmp);
    const vsmlrt = await findFile(stmp, (n) => n === 'vsmlrt.py');
    if (!vsmlrt) throw new Error('vsmlrt.py nicht gefunden');
    await fsp.copyFile(vsmlrt, path.join(this.scriptsDir, 'vsmlrt.py'));
    await fsp.rm(stmp, { recursive: true, force: true });
    // Ein vsmlrt.py im Plugin-Ordner würde sonst mit unserem kollidieren
    await fsp.rm(path.join(this.pluginsDir, 'vsmlrt.py'), { force: true });

    const m = this.manifest();
    m.framegen = true;
    m.vsmlrt = VSMLRT_TAG;
    this.saveManifest(m);
    for (const f of [...parts, scripts]) await fsp.rm(f, { force: true });
  }

  async installModel(key) {
    const model = MODELS[key];
    if (!model) throw new Error('Unbekanntes Modell');
    await fsp.mkdir(this.dl, { recursive: true });
    const file = await this.download(`${MODELS_BASE}/${model.file}`, model.file, 'model', `${model.label} herunterladen`);
    const tmp = path.join(this.root, 'tmp-model');
    await fsp.rm(tmp, { recursive: true, force: true });
    await this.extract(file, tmp);
    const onnx = await findFile(tmp, (n) => n === model.onnx);
    if (!onnx) throw new Error(`${model.onnx} nicht im Archiv gefunden`);
    await fsp.mkdir(this.modelsDir, { recursive: true });
    await fsp.copyFile(onnx, path.join(this.modelsDir, model.onnx));
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.rm(file, { force: true });
  }

  /* ---------------- Hilfsfunktionen ---------------- */

  async fetchJson(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'watchparty-desktop', Accept: 'application/vnd.github+json' }, signal: this.abort.signal });
    if (!r.ok) throw new Error(`${new URL(url).host} antwortet mit ${r.status}`);
    return r.json();
  }

  /** Download mit Fortsetzen nach Abbruch. */
  async download(url, name, step, label) {
    const dest = path.join(this.dl, name);
    if (fs.existsSync(dest)) return dest;
    const part = `${dest}.part`;
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const headers = { 'User-Agent': 'watchparty-desktop' };
    if (have) headers.Range = `bytes=${have}-`;
    let res;
    try {
      res = await fetch(url, { headers, redirect: 'follow', signal: this.abort.signal });
    } catch (e) {
      if (this.abort.signal.aborted) throw new Cancelled();
      throw new Error(`Download fehlgeschlagen (${name}): ${e.cause ? e.cause.code || e.cause.message : e.message}`);
    }
    if (res.status === 416) { await fsp.rename(part, dest); return dest; }
    if (!res.ok) throw new Error(`Download fehlgeschlagen (${name}): HTTP ${res.status}`);
    if (res.status !== 206) have = 0;
    const len = Number(res.headers.get('content-length')) || 0;
    const total = len ? have + len : 0;
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let done = have;
    let last = 0;
    const started = Date.now();
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        done += chunk.length;
        const now = Date.now();
        if (now - last > 250) {
          last = now;
          const speed = (done - have) / Math.max(1, (now - started) / 1000);
          this.progress(step, `${label} · ${fmtBytes(done)}${total ? ` / ${fmtBytes(total)}` : ''} · ${fmtBytes(speed)}/s`, total ? (done / total) * 100 : null);
        }
      }
    } catch (e) {
      out.end();
      if (this.abort.signal.aborted) throw new Cancelled();
      throw new Error(`Download abgebrochen (${name}): ${e.message}. Nochmal versuchen setzt dort fort.`);
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (total && fs.statSync(part).size !== total) throw new Error(`Download unvollständig (${name}). Bitte nochmal versuchen.`);
    await fsp.rename(part, dest);
    return dest;
  }

  extract(file, dest, extra = [], type) {
    return new Promise((resolve, reject) => {
      const args = ['x', file, `-o${dest}`, '-y', '-bsp1', '-bso0', ...extra];
      if (type) args.splice(1, 0, `-t${type}`);
      const p = spawn(sevenZipPath(), args, { windowsHide: true });
      let err = '';
      p.stdout.on('data', (d) => {
        const m = /(\d+)%/.exec(d.toString());
        if (m) this.progress('extract', null, Number(m[1]));
      });
      p.stderr.on('data', (d) => { err += d.toString(); });
      const onAbort = () => p.kill();
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      p.on('error', reject);
      p.on('exit', (code) => {
        this.abort.signal.removeEventListener('abort', onAbort);
        if (this.abort.signal.aborted) return reject(new Cancelled());
        if (code === 0) resolve();
        else reject(new Error(`Entpacken fehlgeschlagen (${path.basename(file)}): ${err.trim().split('\n').pop() || code}`));
      });
    });
  }
}

async function findFile(dir, test) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && test(e.name)) return p;
  }
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const r = await findFile(path.join(dir, e.name), test);
      if (r) return r;
    }
  }
  return null;
}

async function moveContents(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const name of await fsp.readdir(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    try {
      await fsp.rename(src, dst);
    } catch {
      await fsp.cp(src, dst, { recursive: true, force: true });
      await fsp.rm(src, { recursive: true, force: true });
    }
  }
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Name der NVIDIA-Grafikkarte (oder null). */
function detectGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 5000, windowsHide: true }, (err, out) => {
      if (err || !out) return resolve(null);
      const [name, mem] = out.trim().split('\n')[0].split(',').map((s) => s.trim());
      resolve({ name, memory: mem || null });
    });
  });
}

/** Empfohlene Voreinstellung je nach Karte. */
function recommend(gpu) {
  const n = ((gpu && gpu.name) || '').toUpperCase();
  const fast = /RTX\s*(50|40)\d{2}/.test(n) || /RTX\s*PRO\s*6000/.test(n);
  const mid = /RTX\s*30\d{2}/.test(n);
  if (fast) return { model: 'v4_26', target: 'display', vsr: true };
  if (mid) return { model: 'v4_25_lite', target: 'x2', vsr: false };
  return { model: 'v4_22_lite', target: 'x2', vsr: false };
}

module.exports = { Installer, MODELS, detectGpu, recommend, findFile };

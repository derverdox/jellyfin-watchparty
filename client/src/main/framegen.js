'use strict';
/**
 * Baut die mpv-Filterkette für Zwischenbilder (RIFE) und Hochskalieren
 * (RTX Video Super Resolution) und kümmert sich um die TensorRT-Engines.
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { q, mergeEnv } = require('./mpv');
const { MODELS } = require('./installer');

const PADDING = { v4_26: 64, v4_25_lite: 128, v4_22_lite: 32 };

/** Kommazahl-fps in einen Bruch umwandeln (23.976 → 24000/1001). */
function toFraction(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  for (const den of [1001, 1000, 1]) {
    const num = Math.round(fps * den);
    if (Math.abs(num / den - fps) < 0.0015) return reduce(num, den);
  }
  return reduce(Math.round(fps * 1000), 1000);
}
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function reduce(n, d) { const g = gcd(n, d); return [n / g, d / g]; }

/**
 * Faktor bestimmen. target: 'display' (auf Bildwiederholrate des Monitors),
 * oder 'x2' … 'x6'. Ergebnis als Bruch [num, den] relativ zur Quelle.
 */
function chooseMulti(srcFps, displayFps, target) {
  if (!srcFps) return null;
  const fixed = /^x(\d)$/.exec(target || '');
  if (fixed) return [Number(fixed[1]), 1];
  if (!Number.isFinite(displayFps) || displayFps < srcFps * 1.4) return [2, 1];
  // Ganzzahliger Faktor, wenn er nah genug am Monitor liegt (gleichmäßiger), sonst genau auf den Monitor
  const ratio = displayFps / srcFps;
  const whole = Math.round(ratio);
  if (Math.abs(ratio - whole) < 0.02) return [Math.min(whole, 8), 1];
  const disp = toFraction(displayFps);
  const src = toFraction(srcFps);
  let [n, d] = reduce(disp[0] * src[1], disp[1] * src[0]);
  if (n / d > 8) [n, d] = [8, 1];
  return [n, d];
}

function matrixName(params) {
  const m = String((params && params.colormatrix) || '').toLowerCase();
  if (m.includes('2020')) return '2020ncl';
  if (m.includes('601') || m.includes('170m')) return '170m';
  if (m.includes('240m')) return '240m';
  if (m.includes('709')) return '709';
  return (params && params.h > 576) ? '709' : '170m';
}

class Framegen extends EventEmitter {
  constructor(installer, vpyDir, enginesFile) {
    super();
    this.installer = installer;
    this.vpyDir = vpyDir;
    this.enginesFile = enginesFile;
    this.building = null; // { key, proc }
  }

  engines() { try { return JSON.parse(fs.readFileSync(this.enginesFile, 'utf8')); } catch { return {}; } }

  engineKey(model, w, h) {
    const m = PADDING[model] || 64;
    const pw = Math.ceil(w / m) * m;
    const ph = Math.ceil(h / m) * m;
    return `${model}|${pw}x${ph}`;
  }

  hasEngine(model, w, h) { return !!this.engines()[this.engineKey(model, w, h)]; }

  /** Baut die Engine für diese Größe vorab mit VSPipe. Dauert beim ersten Mal 1–10 Minuten. */
  buildEngine(model, w, h, bits) {
    const key = this.engineKey(model, w, h);
    if (this.building) {
      if (this.building.key === key) return this.building.promise;
      return Promise.reject(new Error('Es wird schon eine Engine gebaut'));
    }
    const cfg = { model, width: w, height: h, bits, num: 2, den: 1, streams: 2 };
    const b64 = Buffer.from(JSON.stringify(cfg)).toString('base64');
    const started = Date.now();
    this.emit('status', { state: 'building', key, model, w, h });
    const promise = new Promise((resolve, reject) => {
      const proc = spawn(this.installer.vspipeExe, ['-a', `cfg=${b64}`, path.join(this.vpyDir, 'build_engine.vpy'), '-e', '2', '.'], {
        cwd: this.installer.dir,
        env: mergeEnv(this.env()),
        windowsHide: true,
      });
      let log = '';
      const onData = (d) => { log = (log + d.toString()).slice(-6000); };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      const tick = setInterval(() => this.emit('status', { state: 'building', key, model, w, h, seconds: Math.round((Date.now() - started) / 1000) }), 1000);
      proc.on('error', (e) => { clearInterval(tick); reject(e); });
      proc.on('exit', (code) => {
        clearInterval(tick);
        if (code === 0) {
          const all = this.engines();
          all[key] = { built: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000) };
          fs.writeFileSync(this.enginesFile, JSON.stringify(all, null, 2));
          resolve();
        } else {
          const last = log.trim().split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
          reject(new Error(`TensorRT-Engine konnte nicht gebaut werden:\n${last || `Exit ${code}`}`));
        }
      });
      this.building = { key, proc, promise: null };
    }).finally(() => { this.building = null; });
    this.building.promise = promise;
    return promise;
  }

  cancelBuild() { if (this.building) try { this.building.proc.kill(); } catch { /* egal */ } }

  /** Umgebung für mpv/vspipe, damit VapourSynth seine Plugins findet. */
  env() {
    if (process.platform !== 'win32') return {};
    const dir = this.installer.dir;
    return {
      PATH: `${dir};${path.join(this.installer.pluginsDir, 'vsmlrt-cuda')};${process.env.PATH || process.env.Path || ''}`,
      VAPOURSYNTH_EXTRA_PLUGIN_PATH: this.installer.pluginsDir,
      PYTHONNOUSERSITE: '1',
    };
  }

  /**
   * Filterkette für die aktuelle Datei. Gibt { vf: [...], info } zurück.
   * info beschreibt, was aktiv ist (für die Anzeige).
   */
  plan({ params, srcFps, displayFps, displayHeight }, prefs, status) {
    const vf = [];
    const info = { framegen: null, vsr: null, notes: [] };
    if (!params || !params.w) return { vf, info };

    const fg = prefs.framegen || {};
    if (fg.enabled) {
      if (!status.framegen) info.notes.push('Framegen ist noch nicht installiert.');
      else if (!status.models.includes(fg.model)) info.notes.push(`Modell ${MODELS[fg.model] ? MODELS[fg.model].label : fg.model} fehlt noch.`);
      else if (!srcFps) info.notes.push('Bildrate der Datei unbekannt, Framegen aus.');
      else {
        const src = toFraction(srcFps);
        const multi = chooseMulti(srcFps, displayFps, fg.target);
        const out = (srcFps * multi[0]) / multi[1];
        if (!this.hasEngine(fg.model, params.w, params.h)) {
          info.framegen = { state: 'needs-engine', model: fg.model, w: params.w, h: params.h };
        } else {
          const cfg = {
            model: fg.model, num: multi[0], den: multi[1], src_num: src[0], src_den: src[1],
            matrix: matrixName(params), range: params.colorlevels === 'full' ? 'full' : 'limited',
            scene: fg.scene ?? 0.12, streams: 2,
          };
          const ud = Buffer.from(JSON.stringify(cfg)).toString('base64');
          vf.push(`@wprife:vapoursynth=file=${q(path.join(this.vpyDir, 'rife.vpy'))}:buffered-frames=4:concurrent-frames=4:user-data=${q(ud)}`);
          info.framegen = { state: 'on', model: fg.model, from: srcFps, to: out, multi: multi[1] === 1 ? `${multi[0]}×` : `${(multi[0] / multi[1]).toFixed(2).replace('.', ',')}×` };
        }
      }
    }

    const vsr = prefs.vsr || {};
    if (vsr.enabled && process.platform === 'win32') {
      const targetH = displayHeight || 2160;
      const scale = Math.min(4, targetH / params.h);
      if (scale >= 1.1 || vsr.hdr) {
        const opts = ['scaling-mode=nvidia', `scale=${scale >= 1.1 ? scale.toFixed(3) : '1'}`];
        if (vsr.hdr) opts.push('nvidia-true-hdr');
        vf.push(`@wpvsr:d3d11vpp=${opts.join(':')}`);
        info.vsr = { scale: scale >= 1.1 ? scale : 1, from: params.h, to: scale >= 1.1 ? Math.round(params.h * scale) : params.h, hdr: !!vsr.hdr };
      } else info.notes.push('Video ist schon so groß wie der Bildschirm, VSR nicht nötig.');
    }
    return { vf, info };
  }
}

module.exports = { Framegen, chooseMulti, toFraction, matrixName };

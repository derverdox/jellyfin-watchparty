'use strict';
/**
 * Steuert einen mpv-Prozess über dessen JSON-IPC (Named Pipe unter Windows,
 * Unix-Socket sonst). Ereignisse und beobachtete Eigenschaften werden als
 * Events weitergegeben.
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const OBSERVED = [
  'time-pos', 'pause', 'paused-for-cache', 'seeking', 'duration', 'eof-reached',
  'video-params', 'track-list', 'speed', 'display-fps', 'display-width', 'display-height',
  'estimated-vf-fps', 'container-fps', 'fullscreen', 'volume', 'mute', 'idle-active',
  'vf', 'hwdec-current', 'demuxer-cache-time', 'sid', 'aid',
];

/** Umgebung zusammenführen; unter Windows heißt PATH oft „Path“, das darf nicht doppelt vorkommen. */
function mergeEnv(extra) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(extra || {})) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === k.toLowerCase()) delete env[key];
    env[k] = v;
  }
  return env;
}

/** mpv-Optionswerte mit beliebigen Zeichen sicher übergeben: %Länge%Text */
function q(str) {
  const s = String(str);
  return `%${Buffer.byteLength(s, 'utf8')}%${s}`;
}

class Mpv extends EventEmitter {
  constructor({ binary, args = [], env = {}, cwd, logFile }) {
    super();
    this.binary = binary;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.logFile = logFile;
    this.ipcPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\watchparty-mpv-${process.pid}-${Date.now()}`
      : path.join(os.tmpdir(), `watchparty-mpv-${process.pid}-${Date.now()}.sock`);
    this.proc = null;
    this.sock = null;
    this.buf = '';
    this.reqId = 1;
    this.pending = new Map();
    this.props = {};
    this.running = false;
  }

  async start() {
    const args = [
      `--input-ipc-server=${this.ipcPath}`,
      '--idle=yes',
      '--force-window=yes',
      ...this.args,
    ];
    if (this.logFile) args.push(`--log-file=${this.logFile}`);
    this.proc = spawn(this.binary, args, {
      cwd: this.cwd,
      env: mergeEnv(this.env),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false,
    });
    this.running = true;
    let stderr = '';
    this.proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    this.proc.on('error', (e) => { this.running = false; this.emit('exit', { code: -1, error: e.message }); });
    this.proc.on('exit', (code) => {
      this.running = false;
      for (const p of this.pending.values()) p.reject(new Error('mpv wurde beendet'));
      this.pending.clear();
      if (this.sock) this.sock.destroy();
      this.sock = null;
      this.emit('exit', { code, stderr });
    });
    await this._connectIpc();
    for (const [i, name] of OBSERVED.entries()) {
      this.command('observe_property', i + 1, name).catch(() => {});
    }
  }

  async _connectIpc() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!this.running) throw new Error('mpv startet nicht');
      try {
        this.sock = await new Promise((resolve, reject) => {
          const s = net.connect(this.ipcPath);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
        break;
      } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    if (!this.sock) throw new Error('Keine Verbindung zu mpv');
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('error', () => {});
    this.sock.on('close', () => { this.sock = null; });
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.request_id && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error));
        else p.resolve(msg.data);
      } else if (msg.event === 'property-change') {
        this.props[msg.name] = msg.data;
        this.emit('prop', msg.name, msg.data);
      } else if (msg.event) {
        this.emit('event', msg);
      }
    }
  }

  command(...args) {
    if (!this.sock) return Promise.reject(new Error('mpv läuft nicht'));
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(`${JSON.stringify({ command: args, request_id: id })}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`mpv antwortet nicht (${args[0]})`)); }
      }, 10000);
    });
  }

  set(name, value) { return this.command('set_property', name, value); }
  get(name) { return this.command('get_property', name); }
  osd(text, ms = 2500) { return this.command('show-text', text, ms).catch(() => {}); }

  async quit() {
    if (!this.running) return;
    try { await this.command('quit'); } catch { /* egal */ }
    await new Promise((r) => {
      const t = setTimeout(() => { try { this.proc.kill(); } catch { /* egal */ } r(); }, 3000);
      this.proc.once('exit', () => { clearTimeout(t); r(); });
    });
    if (process.platform !== 'win32') fs.rm(this.ipcPath, { force: true }, () => {});
  }
}

module.exports = { Mpv, q, mergeEnv };

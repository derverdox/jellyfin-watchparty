'use strict';
/*
 * Windows-Fenster-Einbettung: mpv erhaelt beim Start --wid=<Electron-HWND> und baut
 * dann ein randloses Kindfenster (Fensterklasse "mpv") in unserem Hauptfenster.
 * Dieses Helper-Modul findet das Kindfenster und schiebt es per SetWindowPos auf das
 * "Buehnen"-Rechteck, das der Renderer meldet (Eltern-Clientkoordinaten, physische Pixel).
 * Ohne koffi / auf anderen Plattformen: Modul liefert null -> Client laeuft wie bisher
 * mit eigenem mpv-Fenster weiter.
 */
let api = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  api = {
    findWindowEx: user32.func('void* __stdcall FindWindowExW(void *hParent, void *hAfter, str16 className, str16 windowName)'),
    setWindowPos: user32.func('bool __stdcall SetWindowPos(void *hWnd, void *hAfter, int x, int y, int cx, int cy, uint32_t flags)'),
    isWindow: user32.func('bool __stdcall IsWindow(void *hWnd)'),
  };
} catch { /* kein koffi oder kein Windows */ }

const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

/** Electron getNativeWindowHandle(): Pointer im Native-Format (win32/x64: 8 Bytes little-endian). */
function hwndOf(buffer) {
  const b = Buffer.from(buffer);
  return b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0));
}

function toPtr(hwnd) {
  if (hwnd === null || hwnd === undefined || hwnd === 0) return null;
  return typeof hwnd === 'bigint' ? hwnd : hwnd; // koffi akzeptiert BigInt als Zeiger
}

/** Kindfenster der Klasse "mpv" unter dem Elternfenster finden. */
function findMpvChild(parentHwnd) {
  if (!api) return null;
  try { return api.findWindowEx(toPtr(parentHwnd), null, 'mpv', null) || null; }
  catch { return null; }
}

function setChildRect(child, x, y, w, h) {
  if (!api || !child) return false;
  try { return api.setWindowPos(child, null, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW); }
  catch { return false; }
}

function alive(child) {
  if (!api || !child) return false;
  try { return api.isWindow(child); } catch { return false; }
}

module.exports = {
  available: !!api && process.platform === 'win32',
  hwndOf, findMpvChild, setChildRect, alive,
};

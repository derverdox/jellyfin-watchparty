'use strict';
(function (root) {
  function recommended(info, list = info.qualities || []) {
    // Laufende Variante des Raums joinen: teilt die Heimleitung statt sie doppelt zu belasten
    if (info.joinBitrate && list.some((q) => q.id === String(info.joinBitrate))) return String(info.joinBitrate);
    const wanted = info.autoQuality;
    if (list.some((q) => q.id === wanted)) return wanted;
    if (list.some((q) => q.id === info.autoTranscodeQuality)) return info.autoTranscodeQuality;
    return (list.find((q) => q.id !== 'direct' && Number(q.id) <= (info.autoMaxBitrate || 10000000)) || list.find((q) => q.id !== 'direct') || {}).id;
  }
  function lower(info, current, list = info.qualities || []) {
    const ceiling = current === 'direct' ? Math.min(info.bitrate || Infinity, info.autoMaxBitrate || 10000000) : Number(current);
    const cands = [...list].filter((q) => q.id !== 'direct' && Number(q.id) < ceiling).sort((a, b) => Number(b.id) - Number(a.id));
    // Beim runterskalen zuerst auf eine bereits laufende Stufe wechseln — das teilt die Leitung
    return (cands.find((q) => q.active) || cands[0] || {}).id || null;
  }
  class StallGuard {
    constructor() { this.since = null; this.last = -Infinity; }
    check({ playing, buffering, seeking = false }, now = Date.now()) {
      if (!playing || !buffering || seeking) { this.since = null; return false; }
      if (this.since == null) this.since = now;
      if (now - this.since < 12000 || now - this.last < 30000) return false;
      this.last = now; this.since = now;
      return true;
    }
  }
  const api = { recommended, lower, StallGuard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WPQuality = api;
})(globalThis);

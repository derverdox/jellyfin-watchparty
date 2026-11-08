'use strict';
const { qualities } = require('./movie-versions');
const TIERS = [
  { br: 40000000, height: 2160, name: '4K' },
  { br: 20000000, height: 1080, name: 'Full HD' },
  { br: 10000000, height: 1080, name: 'Full HD' },
  { br: 6000000, height: 720, name: 'HD' },
  { br: 3000000, height: 480, name: 'SD' },
  { br: 1500000, height: 360, name: 'Mobil' },
];
function videoOf(source) { return (source.MediaStreams || []).find((s) => s.Type === 'Video') || {}; }
function displayHeight(width, height) { return Math.max(Number(height) || 0, Math.round((Number(width) || 0) * 9 / 16)); }
function sourceHeight(source, name) {
  const video = videoOf(source);
  const dimensions = displayHeight(video.Width, video.Height);
  if (dimensions) return dimensions;
  const sourceLabels = qualities({ Name: source.Name });
  return Math.max(0, ...(sourceLabels.length ? sourceLabels : qualities({ Name: name })).map((q) => ({ SD: 576, HD: 720, 'Full HD': 1080, '4K': 2160 })[q]));
}
function compareSources(a, b, name) {
  // Prefer lower bitrate among equal resolutions; IDs make ties deterministic.
  return sourceHeight(b, name) - sourceHeight(a, name) ||
    (Number(a.Bitrate) || Infinity) - (Number(b.Bitrate) || Infinity) || String(a.Id).localeCompare(String(b.Id));
}
function bestSource(item) { return [...(item.MediaSources || [])].sort((a, b) => compareSources(a, b, item.Name))[0]; }
function compareItems(a, b) {
  const ah = bestSource(a), bh = bestSource(b);
  return (bh ? sourceHeight(bh, b.Name) : 0) - (ah ? sourceHeight(ah, a.Name) : 0) || a.Id.localeCompare(b.Id);
}
function tierAt(br) { return TIERS.find((t) => t.br <= br) || TIERS[TIERS.length - 1]; }
function mbitLabel(br) { return `${(br / 1e6).toFixed(br < 10e6 ? 1 : 0).replace('.', ',').replace(',0', '')} Mbit/s`; }
function resolutionName(h) { return h >= 1900 ? '4K' : h >= 1300 ? 'QHD' : h >= 1000 ? 'Full HD' : h >= 700 ? 'HD' : h ? 'SD' : ''; }
function limits(access, { maxMbps = 0, autoMbps = 10, uploadMbps = 0 } = {}) {
  const maxBitrate = Math.floor(Math.min(access.maxBitrate, maxMbps > 0 ? maxMbps * 1e6 : Infinity, uploadMbps > 0 ? uploadMbps * 0.8e6 : Infinity));
  return { maxBitrate, autoMaxBitrate: Math.min(maxBitrate, autoMbps * 1e6) };
}
// Harte Strickleiter: Bitraten liegen immer exakt auf TIERS-Werten, damit Varianten
// deckeluebergreifend identisch sind und sich Zuschauer dieselben Transcodes teilen.
// Ein Deckel filtert Stufen — er verformt sie nie (Verformung erzeuge Geister-Varianten).
// Unterhalb der untersten Stufe bleibt nur der Deckel selbst als Notstufe.
function ladderBr(cap) {
  const rung = TIERS.find((t) => t.br <= cap);
  return rung ? rung.br : Math.floor(Math.min(cap, 40000000));
}
// active = bereits laufende Varianten desselben Titels: [{ br, direct }]
function deliveryPolicy(d, access, settings, active = []) {
  const { maxBitrate, autoMaxBitrate } = limits(access, settings);
  const h = displayHeight(d.width, d.height) || d.sourceDisplayHeight || 0;
  const allowDirect = !!access.perms.direct && d.bitrate > 0 && d.bitrate <= maxBitrate;
  const running = (br) => active.some((v) => !v.direct && v.br === br);
  const options = [];
  if (allowDirect) options.push({ id: 'direct', label: `Original · ${[resolutionName(h), d.hdr ? 'HDR' : ''].filter(Boolean).join(' ')} · ${mbitLabel(d.bitrate)}`, height: h, br: d.bitrate, original: true, active: active.some((v) => v.direct) });
  // A tier is an output ceiling, not a minimum input bitrate. Compressed 1080p is still 1080p.
  for (const t of TIERS) {
    if (h && t.height > h * 1.05) continue;
    if (t.br > maxBitrate) continue;
    const actual = tierAt(t.br);
    options.push({ id: String(t.br), label: `${actual.name} · bis ${mbitLabel(t.br)}`, height: Math.min(t.height, actual.height), br: t.br, active: running(t.br) });
  }
  if (!options.some((q) => !q.original) && maxBitrate >= 500000) {
    const br = ladderBr(maxBitrate);
    options.push({ id: String(br), label: `Mobil · bis ${mbitLabel(br)}`, height: 360, br, active: running(br) });
  }
  const transcodes = options.filter((q) => !q.original);
  const recommended = transcodes.find((q) => q.br <= autoMaxBitrate) || transcodes[transcodes.length - 1];
  const autoTranscodeQuality = recommended ? recommended.id : null;
  // Join-Hinweise: laufende Varianten sind die Leitungs-sparende Wahl
  const joined = transcodes.filter((q) => q.active);
  const joinBitrate = joined.length ? String(Math.max(...joined.map((q) => q.br))) : null;
  const directActive = allowDirect && active.some((v) => v.direct);
  let overbook = false;
  if (settings && settings.uploadMbps > 0 && active.length) {
    const next = allowDirect && d.bitrate > 0 ? d.bitrate : recommended ? recommended.br : 0;
    overbook = active.reduce((s, v) => s + (v.br || 0), 0) + next > 0.8 * settings.uploadMbps * 1e6;
  }
  return { maxBitrate, autoMaxBitrate, allowDirect, qualities: options, autoTranscodeQuality,
    autoQuality: allowDirect && d.bitrate <= autoMaxBitrate ? 'direct' : autoTranscodeQuality,
    joinBitrate, directActive, overbook };
}
module.exports = { TIERS, displayHeight, sourceHeight, compareItems, bestSource, tierAt, ladderBr, deliveryPolicy, resolutionName, limits };

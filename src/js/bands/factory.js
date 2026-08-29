/**
 * Procedural frequency-band factory — extends named brainwave bands to 48 log-spaced nodes.
 */
import { CFG, BAND_COLORS, STEPS } from '../config.js';
import { hexToRgb, euclidPattern } from '../utils.js';
import { roundDecimals, clampBandParams } from '../param-registry.js';
import { BAND_DEFS } from './defs.js';

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(255 * f(0)),
    Math.round(255 * f(8)),
    Math.round(255 * f(4)),
  ];
}

export function roundCarrierHz(hz) {
  if (hz >= 100) return Math.round(hz);
  return roundDecimals(hz, 2);
}

/** Normalized position 0–1 for band index within group size. */
export function bandTier(index, totalBands) {
  return index / Math.max(1, totalBands - 1);
}

/** Consistent numeric card label: 01 … 48. */
export function bandLabel(index, totalBands) {
  const w = totalBands >= 100 ? 3 : 2;
  return String(index + 1).padStart(w, '0');
}

/** Log-spaced carrier from sub-bass to ~20.5 kHz. */
export function spectrumCarrier(index, totalBands) {
  const minHz = CFG.SPECTRUM_CARRIER_MIN;
  const maxHz = CFG.SPECTRUM_CARRIER_MAX;
  const n = Math.max(1, totalBands);
  const t = bandTier(index, n);
  const raw = minHz * (maxHz / minHz) ** t;
  return roundCarrierHz(Math.min(maxHz, Math.max(minHz, raw)));
}

/** Even pan spread across group (5, 25, 48 cards) for viz + spatial field. */
export function groupPan(index, totalBands) {
  const n = Math.max(1, totalBands);
  if (n === 1) return 0;
  return roundDecimals(-1 + (2 * index) / (n - 1), 2);
}

/**
 * Pulse / duration / FX params scaled with carrier tier.
 * Low bands: low pLow/pHigh, short dur; high bands: wider pulse + longer cycles.
 */
export function scaledSpectrumParams(index, totalBands, carrier, tier) {
  const t = tier ?? bandTier(index, totalBands);
  const pLow = roundDecimals(0.35 + t * 9, 2);
  const pHigh = roundDecimals(pLow + 1.25 + t * 42, 2);
  const dur = roundDecimals(6 + t * 54, 2);
  const drive = roundDecimals(0.05 + (index % 6) * 0.01, 2);
  const vol = roundDecimals(Math.max(0.06, 0.16 - t * 0.07), 2);
  const pan = groupPan(index, totalBands);
  const filterFreq = roundCarrierHz(Math.min(20000, carrier * 1.1 + 100));
  const dlySend = roundDecimals(0.05 + t * 0.2, 2);
  const revSend = roundDecimals(0.08 + t * 0.24, 2);
  const filterLFORate = roundDecimals(0.2 + t * 4, 2);
  const binauralOffset = roundDecimals(0.5 + t * 3, 2);
  const sharp = roundDecimals(1.5 + t * 2.5, 2);
  return {
    pLow, pHigh, dur, drive, vol, pan, filterFreq, dlySend, revSend,
    filterLFORate, binauralOffset, sharp,
  };
}

/** Stable color + rgb for viz for any band index. */
export function bandThemeForIndex(index) {
  if (index < BAND_DEFS.length && BAND_DEFS[index].color) {
    return { color: BAND_DEFS[index].color, rgb: BAND_DEFS[index].rgb };
  }
  if (index < BAND_COLORS.length) {
    const color = BAND_COLORS[index];
    return { color, rgb: hexToRgb(color) };
  }
  const hue = (index * 137.508) % 360;
  const [r, g, b] = hslToRgb(hue, 62, 52);
  const color = `rgb(${r},${g},${b})`;
  return { color, rgb: `${r},${g},${b}` };
}

/**
 * Log-spaced spectral band for index >= named defs length.
 * @param {number} index 0-based band index
 * @param {number} totalBands total bands in session (sets spectrum span)
 */
export function buildProceduralBandDef(index, totalBands) {
  const n = Math.max(BAND_DEFS.length + 1, totalBands);
  const t = bandTier(index, n);
  const carrier = spectrumCarrier(index, n);
  const mult = roundDecimals(Math.max(0.0625, 2 ** (t * 5 - 2)), 2);
  const { color, rgb } = bandThemeForIndex(index);
  const scaled = scaledSpectrumParams(index, n, carrier, t);
  const hits = Math.max(2, Math.min(15, Math.round(3 + t * 10 + (index % 4))));

  return clampBandParams({
    name: bandLabel(index, n),
    color,
    rgb,
    carrier,
    mult,
    micSync: false,
    pLow: scaled.pLow,
    pHigh: scaled.pHigh,
    dur: scaled.dur,
    bpmSync: true,
    shape: ['sine', 'triangle', 'ramp'][index % 3],
    vol: scaled.vol,
    sharp: scaled.sharp,
    cType: t > 0.65 ? 'sawtooth' : 'sine',
    filterType: t > 0.7 ? 'highpass' : 'lowpass',
    filterFreq: scaled.filterFreq,
    filterQ: roundDecimals(1 + (index % 3) * 0.5, 2),
    filterLFORate: scaled.filterLFORate,
    filterLFODepth: t < 0.35 ? roundDecimals(60 + index * 4, 2) : 0,
    pan: scaled.pan,
    dlySend: scaled.dlySend,
    revSend: scaled.revSend,
    mode: t > 0.55 && index % 3 === 0 ? 'seq' : 'cont',
    hits,
    rotate: index % STEPS,
    a: 0.002,
    d: roundDecimals(Math.max(0.04, 0.22 - t * 0.12), 2),
    s: 0,
    r: roundDecimals(Math.max(0.02, 0.14 - t * 0.06), 2),
    source: t < 0.12 ? ['sub', 'brown', 'osc'][index % 3] : t > 0.78 ? 'fm' : 'osc',
    pitch: 0,
    drive: scaled.drive,
    driveType: 'fold',
    lfoTarget: 'filter',
    binauralOffset: scaled.binauralOffset,
    fmRatio: [1, 1.414, 2, 2.718, 3][index % 5],
    fmIndex: roundDecimals(12 + t * 45, 2),
    pluckDecay: roundDecimals(0.05 + t * 0.08, 2),
  });
}

/** Log-spaced full-spectrum sine nodes — uniform layout for 5–48 band pads. */
export function buildFullSpectrumBandDef(index, totalBands = CFG.MAX_BANDS) {
  const n = Math.max(1, totalBands);
  const t = bandTier(index, n);
  const carrier = spectrumCarrier(index, n);
  const { color, rgb } = bandThemeForIndex(index);
  const scaled = scaledSpectrumParams(index, n, carrier, t);

  return clampBandParams({
    name: bandLabel(index, n),
    color,
    rgb,
    carrier,
    mult: roundDecimals(Math.max(0.0625, 2 ** (t * 4 - 1)), 2),
    micSync: false,
    pLow: scaled.pLow,
    pHigh: scaled.pHigh,
    dur: scaled.dur,
    bpmSync: true,
    shape: 'sine',
    vol: scaled.vol,
    sharp: scaled.sharp,
    cType: 'sine',
    filterType: 'lowpass',
    filterFreq: scaled.filterFreq,
    filterQ: 1.2,
    filterLFORate: scaled.filterLFORate,
    filterLFODepth: 0,
    pan: scaled.pan,
    dlySend: scaled.dlySend,
    revSend: scaled.revSend,
    mode: 'cont',
    hits: 4,
    rotate: index % STEPS,
    a: 0.004,
    d: roundDecimals(0.18 + t * 0.12, 2),
    s: 0,
    r: roundDecimals(0.1 + t * 0.06, 2),
    source: 'osc',
    pitch: roundDecimals(t * 2, 2),
    drive: scaled.drive,
    driveType: 'fold',
    lfoTarget: 'filter',
    binauralOffset: scaled.binauralOffset,
    fmRatio: 2,
    fmIndex: roundDecimals(15 + t * 25, 2),
    pluckDecay: 0.05,
  });
}

/** All `count` bands as evenly log-spaced nodes (default 48, max 48). */
export function getFullSpectrumBandDefs(count = CFG.MAX_BANDS) {
  const n = Math.min(CFG.MAX_BANDS, Math.max(1, count));
  return Array.from({ length: n }, (_, i) => buildFullSpectrumBandDef(i, n));
}

/** Return `count` band definitions: named Delta–Omega then procedural fill. */
export function getBandDefs(count = CFG.DEFAULT_BANDS) {
  const n = Math.min(CFG.MAX_BANDS, Math.max(1, count));
  const defs = [];
  for (let i = 0; i < n; i++) {
    if (i < BAND_DEFS.length) {
      defs.push(clampBandParams({ ...BAND_DEFS[i], name: bandLabel(i, n) }));
    } else {
      defs.push(buildProceduralBandDef(i, n));
    }
  }
  return defs;
}

/** Serialize band defs to preset/state band rows. */
export function bandDefsToState(defs) {
  return defs.map((b) => ({
    enabled: false,
    bpmSync: b.bpmSync,
    micSync: b.micSync,
    driveType: b.driveType,
    lfoTarget: b.lfoTarget,
    binauralOffset: b.binauralOffset || 0,
    fmRatio: b.fmRatio,
    fmIndex: b.fmIndex,
    pluckDecay: b.pluckDecay,
    source: b.source,
    carrier: b.carrier,
    cType: b.cType,
    pitch: b.pitch,
    pLow: b.pLow,
    pHigh: b.pHigh,
    dur: b.dur,
    shape: b.shape,
    vol: b.vol,
    sharp: b.sharp,
    drive: b.drive,
    filterType: b.filterType,
    filterFreq: b.filterFreq,
    filterQ: b.filterQ,
    filterLFORate: b.filterLFORate,
    filterLFODepth: b.filterLFODepth,
    pan: b.pan,
    dlySend: b.dlySend,
    revSend: b.revSend,
    mode: b.mode,
    hits: b.hits,
    rotate: b.rotate,
    steps: euclidPattern(b.hits, STEPS, b.rotate),
    a: b.a,
    d: b.d,
    s: b.s,
    r: b.r,
    name: b.name,
    color: b.color,
    rgb: b.rgb,
  }));
}

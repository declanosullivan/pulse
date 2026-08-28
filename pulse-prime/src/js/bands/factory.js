/**
 * Procedural frequency-band factory — extends named brainwave bands to 36+ log-spaced nodes.
 */
import { CFG, BAND_COLORS, STEPS } from '../config.js';
import { hexToRgb, euclidPattern } from '../utils.js';
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
  const total = Math.max(BAND_DEFS.length + 1, totalBands);
  const t = index / Math.max(1, total - 1);
  const carrier = Math.round(Math.min(16000, Math.max(28, 28 * (2 ** (t * 9.2)))));
  const mult = Math.max(0.0625, Math.pow(2, t * 5 - 2));
  const { color, rgb } = bandThemeForIndex(index);
  const tier = t;
  const vol = Math.max(0.06, 0.42 - tier * 0.28);
  const pLow = Math.max(0.05, 0.4 + tier * 80);
  const pHigh = Math.max(pLow + 1, pLow * (1.8 + tier * 2.5));
  const shapes = ['sine', 'triangle', 'ramp'];
  const sources = tier < 0.12 ? ['sub', 'brown', 'osc'] : tier > 0.78 ? ['fm', 'osc'] : ['osc', 'pluck'];
  const source = sources[index % sources.length];
  const hits = Math.max(2, Math.min(15, Math.round(3 + tier * 10 + (index % 4))));

  return {
    name: index < BAND_DEFS.length ? BAND_DEFS[index].name : `Spectral ${index + 1}`,
    color,
    rgb,
    carrier,
    mult,
    micSync: false,
    pLow,
    pHigh,
    dur: Math.max(4, 6 + tier * 28),
    bpmSync: true,
    shape: shapes[index % shapes.length],
    vol,
    sharp: Math.max(1.5, Math.min(6, 1.8 + tier * 3.5)),
    cType: tier > 0.65 ? 'sawtooth' : 'sine',
    filterType: tier > 0.7 ? 'highpass' : 'lowpass',
    filterFreq: Math.round(Math.min(18000, 120 + carrier * 0.85)),
    filterQ: 1 + (index % 3) * 0.5,
    filterLFORate: 0.4 + tier * 6,
    filterLFODepth: tier < 0.35 ? 80 + index * 5 : 0,
    pan: Math.max(-0.95, Math.min(0.95, -0.85 + (index / Math.max(1, total - 1)) * 1.7)),
    dlySend: 0.08 + tier * 0.28,
    revSend: 0.12 + tier * 0.3,
    mode: tier > 0.55 && index % 3 === 0 ? 'seq' : 'cont',
    hits,
    rotate: index % STEPS,
    a: 0.002,
    d: Math.max(0.04, 0.22 - tier * 0.12),
    s: 0,
    r: Math.max(0.02, 0.14 - tier * 0.06),
    source,
    pitch: 0,
    drive: tier > 0.5 ? 0.08 + (index % 5) * 0.06 : 0,
    driveType: tier > 0.72 ? 'fold' : 'tanh',
    lfoTarget: 'filter',
    binauralOffset: tier < 0.4 ? (2 + (index % 6)) : (index % 2 === 0 ? 12 + tier * 20 : 0),
    fmRatio: [1, 1.414, 2, 2.718, 3][index % 5],
    fmIndex: 12 + Math.round(tier * 45),
    pluckDecay: 0.05 + tier * 0.08,
  };
}

/** Return `count` band definitions: named Delta–Omega then procedural fill. */
export function getBandDefs(count = CFG.DEFAULT_BANDS) {
  const n = Math.min(CFG.MAX_BANDS, Math.max(1, count));
  const defs = [];
  for (let i = 0; i < n; i++) {
    if (i < BAND_DEFS.length) defs.push({ ...BAND_DEFS[i] });
    else defs.push(buildProceduralBandDef(i, n));
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

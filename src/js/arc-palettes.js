/**
 * Arc Palettes v1 — planned per-band param patches keyed by arc shape + zone.
 */
import { STEPS } from './config.js';

export const ARC_PALETTE_KEYS = Object.freeze([
  'source', 'cType', 'binauralOffset', 'pitch', 'drive', 'driveType', 'sharp', 'shape',
  'pan', 'dlySend', 'revSend', 'filterType', 'filterFreq', 'filterQ', 'lfoTarget',
  'fmRatio', 'fmIndex', 'mode', 'hits', 'rotate',
]);

/** Numeric keys morphed along the arc curve (Palettes v2). */
export const ARC_MORPH_KEYS = Object.freeze([
  'binauralOffset', 'pitch', 'drive', 'sharp', 'pan', 'dlySend', 'revSend',
  'filterFreq', 'filterQ', 'fmIndex',
]);

/** Discrete keys applied at arc start when morphing is on. */
export const ARC_DISCRETE_KEYS = Object.freeze([
  'source', 'cType', 'driveType', 'filterType', 'lfoTarget', 'mode', 'hits', 'rotate', 'shape', 'fmRatio',
]);

/**
 * Fractional spectral zone ranges (0–1) for band targeting at any band count.
 */
export const ZONE_RANGES = Object.freeze({
  sub: [0, 0.14],
  low: [0.08, 0.28],
  mid: [0.22, 0.48],
  high: [0.42, 0.72],
  hyper: [0.68, 1.0],
  wide: [0, 1.0],
});

const FM_RATIOS = [1, 1.414, 1.732, 2, 2.236, 2.718, 3, 3.141, 4];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randBetween(a, b) {
  return a + Math.random() * Math.max(0.01, b - a);
}

function pickRange(range) {
  if (range == null) return undefined;
  if (Array.isArray(range)) {
    if (range.length === 2 && typeof range[0] === 'number') return randBetween(range[0], range[1]);
    return pick(range);
  }
  return range;
}

/** Indices falling in a spectral zone for `totalBands` nodes. */
export function bandIndicesForZone(zoneKey, totalBands, count) {
  const n = Math.max(1, totalBands);
  const range = ZONE_RANGES[zoneKey] || [0.35, 0.65];
  const start = Math.max(0, Math.floor(range[0] * n));
  const end = Math.min(n, Math.ceil(range[1] * n));
  let pool = [];
  for (let i = start; i < end; i++) pool.push(i);
  if (zoneKey === 'wide' && pool.length > 6) {
    const wide = [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1];
    pool = [...new Set(wide.filter((i) => i >= 0 && i < n))];
  }
  if (!pool.length) pool = [Math.floor(n * 0.5)];
  const shuffled = pool.slice().sort(() => Math.random() - 0.5);
  const out = [];
  for (let i = 0; i < Math.min(count, shuffled.length); i++) out.push(shuffled[i]);
  return out;
}

const SHAPE_BIAS = Object.freeze({
  lift: {
    label: 'Ascent',
    sharp: [2, 4.5], drive: [0, 0.22], shape: 'ramp', filterType: 'lowpass',
  },
  fall: {
    label: 'Descent',
    sharp: [1.5, 3.5], drive: [0, 0.18], shape: 'sine', revSend: [0.28, 0.48],
  },
  breath: {
    label: 'Entrainment',
    binauralOffset: [3, 14], sharp: [1.5, 3], shape: 'sine', revSend: [0.35, 0.58],
  },
  surge: {
    label: 'Overdrive',
    drive: [0.35, 0.68], driveType: ['fold', 'crush'], sharp: [4, 7], source: ['fm', 'osc'],
    fmIndex: [28, 55],
  },
  collapse: {
    label: 'Tectonic',
    drive: [0.28, 0.52], driveType: ['tube', 'tanh'], sharp: [1.5, 3], source: ['brown', 'sub'],
    filterFreq: [90, 420],
  },
  cascade: {
    label: 'Glass Steps',
    sharp: [3, 6], pitch: [-4, 5], mode: 'seq', hits: [5, 12], source: ['pluck', 'osc'],
  },
  strobe: {
    label: 'Neural Strobe',
    sharp: [5, 8], drive: [0.38, 0.72], driveType: ['crush', 'fold'], mode: 'seq', hits: [10, 15],
    source: ['fm'],
  },
  'hold-drop': {
    label: 'Plateau Drop',
    sharp: [2, 5], drive: [0.18, 0.42], filterType: 'lowpass', dlySend: [0.22, 0.45],
  },
});

const ZONE_BIAS = Object.freeze({
  sub: { binauralOffset: [2, 7], source: ['sub', 'brown'], filterFreq: [60, 280], sharp: [1, 2.5] },
  low: { binauralOffset: [4, 11], source: ['brown', 'osc'], filterFreq: [180, 750], pan: [-0.45, 0.45] },
  mid: { binauralOffset: [6, 16], pitch: [-2, 5], filterType: ['bandpass', 'lowpass'], fmRatio: FM_RATIOS },
  high: { binauralOffset: [10, 24], sharp: [3, 6], fmIndex: [22, 48], filterFreq: [1200, 6000] },
  hyper: {
    binauralOffset: [18, 40], sharp: [4.5, 7.5], driveType: ['fold', 'crush'], source: ['fm'],
    fmRatio: [1.414, 2.718, 3.141], fmIndex: [35, 70], filterType: 'highpass', filterFreq: [800, 4000],
  },
  wide: { binauralOffset: [2, 22], pan: [-0.85, 0.85], revSend: [0.2, 0.5] },
});

const SLOT_EMPHASIS = [
  { binauralOffset: [2, 12], revSend: [0.3, 0.55] },
  { drive: [0.2, 0.55], sharp: [3, 7], driveType: ['fold', 'tube', 'crush'] },
  { pitch: [-5, 6], fmRatio: FM_RATIOS, fmIndex: [20, 60], lfoTarget: ['filter', 'pitch', 'fm'] },
];

function patchCountForIntensity(intensity, totalBands) {
  const n = Math.max(1, totalBands);
  if (n >= 48) {
    if (intensity === 'subtle') return 3;
    if (intensity === 'extreme') return 8;
    return 5;
  }
  if (n >= 36) {
    if (intensity === 'subtle') return 2;
    if (intensity === 'extreme') return 6;
    return 4;
  }
  if (n >= 24) {
    if (intensity === 'subtle') return 2;
    if (intensity === 'extreme') return 5;
    return 3;
  }
  if (n >= 18) {
    if (intensity === 'subtle') return 2;
    if (intensity === 'extreme') return 4;
    return 3;
  }
  if (intensity === 'subtle') return 1;
  if (intensity === 'extreme') return 3;
  return 2;
}

function resolveParams(shapeKey, zoneKey, slotIndex) {
  const shape = SHAPE_BIAS[shapeKey] || {};
  const zone = ZONE_BIAS[zoneKey] || {};
  const slot = SLOT_EMPHASIS[slotIndex % SLOT_EMPHASIS.length] || {};
  const merged = { ...zone, ...shape, ...slot };
  const params = {};
  for (const key of ARC_PALETTE_KEYS) {
    const val = pickRange(merged[key]);
    if (val !== undefined) params[key] = val;
  }
  if (params.hits != null) {
    params.hits = Math.max(1, Math.min(16, Math.round(params.hits)));
    params.rotate = Math.floor(Math.random() * STEPS);
  }
  if (params.mode === 'seq' || params.hits != null) params.mode = 'seq';
  if (params.binauralOffset != null) {
    params.binauralOffset = Math.max(-40, Math.min(40, Math.round(params.binauralOffset * 2) / 2));
  }
  if (params.pitch != null) params.pitch = Math.max(-12, Math.min(12, Math.round(params.pitch)));
  if (params.sharp != null) params.sharp = Math.max(1, Math.min(8, Math.round(params.sharp * 2) / 2));
  if (params.drive != null) params.drive = Math.max(0, Math.min(1, params.drive));
  if (params.pan != null) params.pan = Math.max(-1, Math.min(1, params.pan));
  if (params.filterFreq != null) params.filterFreq = Math.max(20, Math.min(20000, Math.round(params.filterFreq)));
  return params;
}

/** Build a palette patch set for one arc. */
export function buildArcPalette(shapeKey, zoneKey, intensity, totalBands = 9) {
  const shape = SHAPE_BIAS[shapeKey] || { label: 'Tone' };
  const count = patchCountForIntensity(intensity, totalBands);
  const indices = bandIndicesForZone(zoneKey, totalBands, count);
  const patches = indices.map((bandIndex, slot) => ({
    bandIndex,
    params: resolveParams(shapeKey, zoneKey, slot),
  }));
  return {
    label: shape.label,
    patches,
  };
}

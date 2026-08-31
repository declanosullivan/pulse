/**
 * Single source of truth for PulseForge parameter limits, steps, rounding,
 * and carrier-dependent soft bounds (Sprint 1).
 */
import { CFG } from './config.js';

export const QUAL_PRESETS = Object.freeze(['low', 'med', 'high', 'extreme']);

/** @typedef {'stored'|'uiPct'|'uiMs'|'uiPan'} ParamStorage */

/**
 * @typedef {Object} ParamSpec
 * @property {number} hardMin
 * @property {number} hardMax
 * @property {number} step
 * @property {readonly number[]} stepOptions
 * @property {number} decimals
 * @property {boolean} qualitative
 * @property {ParamStorage} [storage]
 * @property {(band: object) => number} [softMax]
 * @property {(band: object) => number} [softMin]
 */

/** @type {Readonly<Record<string, ParamSpec>>} */
export const PARAM_REGISTRY = Object.freeze({
  carrier: {
    hardMin: CFG.SPECTRUM_CARRIER_MIN,
    hardMax: CFG.SPECTRUM_CARRIER_MAX,
    step: 1,
    stepOptions: Object.freeze([1, 5, 10, 100]),
    decimals: 2,
    qualitative: false,
  },
  fmRatio: {
    hardMin: 0.25,
    hardMax: 8,
    step: 0.25,
    stepOptions: Object.freeze([0.25, 0.5, 1]),
    decimals: 2,
    qualitative: false,
  },
  fmIndex: {
    hardMin: 0,
    hardMax: 100,
    step: 1,
    stepOptions: Object.freeze([1, 5, 10]),
    decimals: 0,
    qualitative: true,
  },
  binauralOffset: {
    hardMin: -40,
    hardMax: 40,
    step: 0.5,
    stepOptions: Object.freeze([0.5, 1, 2]),
    decimals: 1,
    qualitative: true,
    softMax: (b) => safeBinauralMax(b.carrier),
    softMin: (b) => -safeBinauralMax(b.carrier),
  },
  pitch: {
    hardMin: -12,
    hardMax: 12,
    step: 1,
    stepOptions: Object.freeze([1]),
    decimals: 0,
    qualitative: false,
    softMax: (b) => safePitchMax(b.carrier),
    softMin: (b) => -safePitchMax(b.carrier),
  },
  pLow: {
    hardMin: CFG.WORKLET_PULSE_MIN,
    hardMax: CFG.WORKLET_PULSE_MAX,
    step: 0.1,
    stepOptions: Object.freeze([0.1, 0.5, 1, 5, 10]),
    decimals: 2,
    qualitative: true,
    softMax: (b) => Math.min(CFG.WORKLET_PULSE_MAX, Math.max(CFG.WORKLET_PULSE_MIN, (b.carrier || 440) * 0.5)),
  },
  pHigh: {
    hardMin: CFG.WORKLET_PULSE_MIN,
    hardMax: CFG.WORKLET_PULSE_MAX,
    step: 0.1,
    stepOptions: Object.freeze([0.1, 0.5, 1, 5, 10]),
    decimals: 2,
    qualitative: true,
    softMin: (b) => Math.max(CFG.WORKLET_PULSE_MIN, (b.pLow ?? 0.5) + 0.01),
    softMax: (b) => Math.min(CFG.WORKLET_PULSE_MAX, Math.max((b.pLow ?? 0.5) + 0.01, (b.carrier || 440) * 0.8)),
  },
  dur: {
    hardMin: 0.01,
    hardMax: CFG.WORKLET_DUR_MAX,
    step: 0.5,
    stepOptions: Object.freeze([0.5, 1, 5, 10]),
    decimals: 2,
    qualitative: true,
  },
  vol: {
    hardMin: 0,
    hardMax: 1,
    step: 0.01,
    stepOptions: Object.freeze([0.01, 0.05, 0.1]),
    decimals: 2,
    qualitative: true,
  },
  sharp: {
    hardMin: 1,
    hardMax: 8,
    step: 0.5,
    stepOptions: Object.freeze([0.5, 1]),
    decimals: 1,
    qualitative: true,
  },
  drive: {
    hardMin: 0,
    hardMax: 1,
    step: 0.01,
    stepOptions: Object.freeze([1, 5, 10]),
    decimals: 2,
    qualitative: true,
    storage: 'uiPct',
  },
  pan: {
    hardMin: -1,
    hardMax: 1,
    step: 0.01,
    stepOptions: Object.freeze([1, 5, 10]),
    decimals: 2,
    qualitative: false,
    storage: 'uiPan',
  },
  dlySend: {
    hardMin: 0,
    hardMax: 1,
    step: 0.01,
    stepOptions: Object.freeze([0.01, 0.05, 0.1]),
    decimals: 2,
    qualitative: true,
  },
  revSend: {
    hardMin: 0,
    hardMax: 1,
    step: 0.01,
    stepOptions: Object.freeze([0.01, 0.05, 0.1]),
    decimals: 2,
    qualitative: true,
  },
  filterFreq: {
    hardMin: 20,
    hardMax: 20000,
    step: 10,
    stepOptions: Object.freeze([10, 50, 100]),
    decimals: 0,
    qualitative: true,
    softMax: (b) => Math.min(20000, Math.max(20, (b.carrier || 440) * 4)),
  },
  filterQ: {
    hardMin: 0.1,
    hardMax: 20,
    step: 0.1,
    stepOptions: Object.freeze([0.1, 0.5, 1]),
    decimals: 1,
    qualitative: true,
  },
  filterLFORate: {
    hardMin: 0.05,
    hardMax: 10,
    step: 0.05,
    stepOptions: Object.freeze([0.05, 0.1, 0.5, 1]),
    decimals: 2,
    qualitative: true,
  },
  filterLFODepth: {
    hardMin: 0,
    hardMax: CFG.FILTER_LFO_DEPTH_MAX,
    step: 10,
    stepOptions: Object.freeze([10, 50, 100]),
    decimals: 0,
    qualitative: true,
    softMax: (b) => Math.min(CFG.FILTER_LFO_DEPTH_MAX, Math.max(0, (b.filterFreq || 1000) * 0.5)),
  },
  pluckDecay: {
    hardMin: 0.01,
    hardMax: 0.5,
    step: 0.01,
    stepOptions: Object.freeze([0.01, 0.05, 0.1]),
    decimals: 2,
    qualitative: true,
  },
  hits: {
    hardMin: 0,
    hardMax: 16,
    step: 1,
    stepOptions: Object.freeze([1]),
    decimals: 0,
    qualitative: false,
  },
  rotate: {
    hardMin: 0,
    hardMax: 15,
    step: 1,
    stepOptions: Object.freeze([1]),
    decimals: 0,
    qualitative: false,
  },
  a: {
    hardMin: 0.001,
    hardMax: 1,
    step: 0.001,
    stepOptions: Object.freeze([1, 5, 10]),
    decimals: 3,
    qualitative: true,
    storage: 'uiMs',
  },
  d: {
    hardMin: 0.01,
    hardMax: 2,
    step: 0.01,
    stepOptions: Object.freeze([10, 50]),
    decimals: 3,
    qualitative: true,
    storage: 'uiMs',
  },
  s: {
    hardMin: 0,
    hardMax: 1,
    step: 0.01,
    stepOptions: Object.freeze([1, 5]),
    decimals: 2,
    qualitative: true,
    storage: 'uiPct',
  },
  r: {
    hardMin: 0.01,
    hardMax: 3,
    step: 0.01,
    stepOptions: Object.freeze([10, 50]),
    decimals: 3,
    qualitative: true,
    storage: 'uiMs',
  },
});

/** Global (session) controls — hard limits for transport / FX panel. */
export const GLOBAL_PARAM_REGISTRY = Object.freeze({
  masterVol: { hardMin: 0, hardMax: 1, step: 0.01, decimals: 2 },
  tempo: { hardMin: CFG.TEMPO_MIN, hardMax: CFG.TEMPO_MAX, step: 1, decimals: 0 },
  swing: { hardMin: 0, hardMax: 100, step: 1, decimals: 0 },
  delayFeedback: { hardMin: 0, hardMax: 90, step: 1, decimals: 0 },
  delayDamp: { hardMin: 200, hardMax: 12000, step: 50, decimals: 0 },
  delayReturn: { hardMin: 0, hardMax: 100, step: 1, decimals: 0 },
  reverbReturn: { hardMin: 0, hardMax: 100, step: 1, decimals: 0 },
});

export function getParamSpec(key) {
  return PARAM_REGISTRY[key] || null;
}

/** Tier-safe binaural offset cap (Hz) by carrier. */
export function safeBinauralMax(carrier = 440) {
  if (carrier < 220) return 6;
  if (carrier < 2000) return 12;
  if (carrier < 8000) return 25;
  return 40;
}

/** Tier-safe pitch cap (semitones) by carrier. */
export function safePitchMax(carrier = 440) {
  if (carrier < 220) return 3;
  if (carrier < 2000) return 6;
  return 12;
}

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

/** Effective min/max for a parameter (hard ∩ soft when band context given). */
export function getEffectiveLimits(key, band = null) {
  const spec = getParamSpec(key);
  if (!spec) return { min: -Infinity, max: Infinity };
  let min = spec.hardMin;
  let max = spec.hardMax;
  if (band) {
    if (spec.softMin) min = Math.max(min, spec.softMin(band));
    if (spec.softMax) max = Math.min(max, spec.softMax(band));
  }
  if (min > max) max = min;
  return { min, max };
}

export function roundDecimals(v, places = 2) {
  if (!Number.isFinite(v)) return v;
  const p = 10 ** places;
  return Math.round(v * p) / p;
}

/** Round a stored parameter value to registry decimal places. */
export function roundParam(key, value, band = null) {
  const spec = getParamSpec(key);
  if (!spec || !Number.isFinite(value)) return value;
  let v = value;
  if (key === 'carrier' && v >= 100) v = Math.round(v);
  else {
    const p = 10 ** spec.decimals;
    v = Math.round(v * p) / p;
  }
  return clampParam(key, v, band);
}

/** Clamp a stored parameter value to hard + soft limits. */
export function clampParam(key, value, band = null) {
  const spec = getParamSpec(key);
  if (!spec) return value;
  const { min, max } = getEffectiveLimits(key, band);
  return Math.min(max, Math.max(min, finite(value, min)));
}

/** Convert stored value → UI input value. */
export function storedToUi(key, stored) {
  const spec = getParamSpec(key);
  if (!spec) return stored;
  if (spec.storage === 'uiPct') return Math.round(stored * 100);
  if (spec.storage === 'uiPan') return Math.round(stored * 100);
  if (spec.storage === 'uiMs') return Math.round(stored * 1000);
  return stored;
}

/** Convert UI input value → stored value. */
export function uiToStored(key, ui) {
  const spec = getParamSpec(key);
  if (!spec) return ui;
  if (spec.storage === 'uiPct') return ui / 100;
  if (spec.storage === 'uiPan') return ui / 100;
  if (spec.storage === 'uiMs') return ui / 1000;
  return ui;
}

/**
 * HTML input attributes for a band parameter (UI scale).
 * @returns {{ min: string, max: string, step: string, value: string }}
 */
export function paramInputAttrs(key, band, storedValue) {
  const spec = getParamSpec(key);
  if (!spec) {
    return { min: '', max: '', step: 'any', value: String(storedValue ?? '') };
  }
  const { min, max } = getEffectiveLimits(key, band);
  const stored = clampParam(key, finite(storedValue, min), band);
  const uiVal = storedToUi(key, stored);
  const uiMin = storedToUi(key, min);
  const uiMax = storedToUi(key, max);
  let step = spec.step;
  if (spec.storage === 'uiPct' || spec.storage === 'uiPan') step = 1;
  if (spec.storage === 'uiMs' && key === 'a') step = 1;
  if (spec.storage === 'uiMs' && (key === 'd' || key === 'r')) step = 10;
  return {
    min: String(uiMin),
    max: String(uiMax),
    step: String(step),
    value: String(uiVal),
  };
}

/** Rhythm param attrs (same registry, rhythm keys). */
export function rhythmInputAttrs(key, band, storedValue) {
  return paramInputAttrs(key, band, storedValue);
}

/** Clamp and round all numeric fields on a band state object. */
export function clampBandParams(band) {
  if (!band || typeof band !== 'object') return band;
  for (const key of Object.keys(PARAM_REGISTRY)) {
    if (band[key] === undefined) continue;
    band[key] = roundParam(key, band[key], band);
  }
  if (band.pHigh != null && band.pLow != null && band.pHigh <= band.pLow) {
    band.pHigh = roundParam('pHigh', band.pLow + 0.01, band);
  }
  return band;
}

/** Qualitative preset fraction 0–1 for a parameter key. */
export function qualPresetFraction(key, preset = 'med') {
  const map = { low: 0.25, med: 0.5, high: 0.75, extreme: 0.95 };
  const t = map[preset] ?? 0.5;
  const spec = getParamSpec(key);
  if (!spec || !spec.qualitative) return t;
  return t;
}

/** Value at qualitative preset level within effective limits. */
export function qualPresetValue(key, preset, band = null) {
  const spec = getParamSpec(key);
  if (!spec) return 0;
  const { min, max } = getEffectiveLimits(key, band);
  const t = qualPresetFraction(key, preset);
  return roundParam(key, min + (max - min) * t, band);
}

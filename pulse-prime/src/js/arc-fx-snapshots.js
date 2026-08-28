/**
 * Per-arc FX snapshots — morph global delay/reverb between session baseline and arc targets (Phase 4).
 */

export const ARC_FX_MORPH_KEYS = Object.freeze(['feedback', 'damp', 'dlyReturn', 'revReturn']);

const ZONE_FX = Object.freeze({
  sub: { feedback: 0.38, damp: 900, dlyReturn: 0.32, revReturn: 0.58, revPreset: 'cave' },
  low: { feedback: 0.48, damp: 1400, dlyReturn: 0.42, revReturn: 0.52, revPreset: 'hall' },
  mid: { feedback: 0.55, damp: 2200, dlyReturn: 0.48, revReturn: 0.45, revPreset: 'hall' },
  high: { feedback: 0.62, damp: 3800, dlyReturn: 0.38, revReturn: 0.38, revPreset: 'plate' },
  hyper: { feedback: 0.72, damp: 5200, dlyReturn: 0.28, revReturn: 0.32, revPreset: 'plate' },
  wide: { feedback: 0.58, damp: 2800, dlyReturn: 0.45, revReturn: 0.48, revPreset: 'room' },
});

const SHAPE_FX = Object.freeze({
  lift: { dlyReturn: 0.05, revReturn: 0.06 },
  fall: { damp: -400, revReturn: 0.08 },
  breath: { revReturn: 0.12, feedback: -0.08 },
  surge: { feedback: 0.12, dlyReturn: -0.06 },
  collapse: { damp: -800, feedback: -0.1 },
  cascade: { dlyReturn: 0.1, feedback: 0.06 },
  strobe: { feedback: 0.15, damp: 600 },
  'hold-drop': { revReturn: 0.1, damp: -300 },
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Build FX target snapshot for one arc. */
export function buildArcFxSnapshot(zoneKey, shapeKey, intensity) {
  const zone = ZONE_FX[zoneKey] || ZONE_FX.mid;
  const shape = SHAPE_FX[shapeKey] || {};
  const scale = intensity === 'extreme' ? 1.15 : intensity === 'subtle' ? 0.82 : 1;

  const snap = {
    feedback: clamp((zone.feedback + (shape.feedback || 0)) * scale, 0.2, 0.82),
    damp: clamp(zone.damp + (shape.damp || 0), 400, 12000),
    dlyReturn: clamp((zone.dlyReturn + (shape.dlyReturn || 0)) * scale, 0.1, 0.75),
    revReturn: clamp((zone.revReturn + (shape.revReturn || 0)) * scale, 0.15, 0.72),
    revPreset: zone.revPreset,
  };
  return snap;
}

/** Lerp FX snapshot at morph position u (0–1). */
export function lerpFxSnapshot(baseline, target, u) {
  const out = {};
  for (const key of ARC_FX_MORPH_KEYS) {
    const a = baseline[key];
    const b = target[key];
    if (typeof a === 'number' && typeof b === 'number') {
      out[key] = a + (b - a) * u;
    }
  }
  if (target.revPreset) out.revPreset = u >= 0.5 ? target.revPreset : baseline.revPreset;
  return out;
}

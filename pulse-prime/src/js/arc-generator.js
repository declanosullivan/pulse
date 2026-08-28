/**
 * Planned tempo-arc generator — composes contrasting BPM curves with silence gaps.
 * Picks parameters from app min/max ranges; manual ramp sliders are optional overrides.
 */
import { CFG } from './config.js';
import { buildArcPalette } from './arc-palettes.js';
import { buildArcOrchestration } from './arc-orchestration.js';
import { buildArcFxSnapshot } from './arc-fx-snapshots.js';

export const GAP_PROFILES = Object.freeze({
  short: { min: 0.35, max: 1.5, label: 'Short gap' },
  medium: { min: 1.2, max: 5.5, label: 'Medium gap' },
  long: { min: 3.5, max: 14, label: 'Long gap' },
});

export const ARC_INTENSITY = Object.freeze({
  subtle: { contrast: 0.42, durScale: 1.25, jitterMax: 16, depth: 0.68 },
  dramatic: { contrast: 0.78, durScale: 1.0, jitterMax: 26, depth: 0.86 },
  extreme: { contrast: 1.0, durScale: 0.82, jitterMax: 34, depth: 0.94 },
});

const ZONES = Object.freeze({
  sub: { bpmMin: CFG.TEMPO_MIN, bpmMax: 55, bandBias: 0.08, label: 'Sub' },
  low: { bpmMin: 8, bpmMax: 95, bandBias: 0.22, label: 'Low' },
  mid: { bpmMin: 40, bpmMax: 210, bandBias: 0.48, label: 'Mid' },
  high: { bpmMin: 120, bpmMax: 360, bandBias: 0.72, label: 'High' },
  hyper: { bpmMin: 220, bpmMax: CFG.TEMPO_MAX, bandBias: 0.92, label: 'Hyper' },
  wide: { bpmMin: CFG.TEMPO_MIN, bpmMax: CFG.TEMPO_MAX, bandBias: 0.5, label: 'Wide' },
});

const SHAPES = Object.freeze({
  lift: {
    label: 'Lift',
    fn: (t) => t,
    exaggerate: 'bands',
  },
  fall: {
    label: 'Fall',
    fn: (t) => 1 - t,
    exaggerate: 'bands',
  },
  breath: {
    label: 'Breath',
    fn: (t) => Math.sin(t * Math.PI),
    exaggerate: 'combo',
  },
  surge: {
    label: 'Surge',
    fn: (t) => (t < 0.7 ? (t / 0.7) ** 0.5 : 1 - ((t - 0.7) / 0.3) ** 1.9),
    exaggerate: 'combo',
  },
  collapse: {
    label: 'Collapse',
    fn: (t) => (t < 0.15 ? t / 0.15 : 1 - ((t - 0.15) / 0.85) ** 0.62),
    exaggerate: 'thin',
  },
  cascade: {
    label: 'Cascade',
    fn: (t) => {
      const step = Math.floor(t * 5);
      const frac = t * 5 - step;
      return 1 - step * 0.19 - frac * 0.19;
    },
    exaggerate: 'bands',
  },
  strobe: {
    label: 'Strobe',
    fn: (t) => 0.5 + 0.5 * Math.sin(t * Math.PI * 5.5),
    exaggerate: 'sparse',
  },
  'hold-drop': {
    label: 'Hold-Drop',
    fn: (t) => (t < 0.62 ? 0.88 : 0.88 - ((t - 0.62) / 0.38) ** 2.1),
    exaggerate: 'combo',
  },
});

const ZONE_CONTRAST = Object.freeze({
  sub: ['hyper', 'high', 'wide'],
  low: ['high', 'hyper', 'wide'],
  mid: ['sub', 'hyper', 'low'],
  high: ['sub', 'low', 'mid'],
  hyper: ['sub', 'low', 'mid'],
  wide: ['sub', 'hyper', 'high'],
});

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randBetween(a, b) {
  return a + Math.random() * Math.max(0.01, b - a);
}

function pickGapClass(profile, prevClass) {
  if (profile !== 'mixed') return profile;
  const opts = ['short', 'medium', 'long'];
  const filtered = prevClass ? opts.filter((o) => o !== prevClass) : opts;
  return pick(filtered.length ? filtered : opts);
}

function gapDuration(gapClass) {
  const p = GAP_PROFILES[gapClass];
  return randBetween(p.min, p.max);
}

function pickZone(lastZone, intensity) {
  const ic = ARC_INTENSITY[intensity] || ARC_INTENSITY.dramatic;
  if (!lastZone || Math.random() > ic.contrast) return pick(Object.keys(ZONES));
  const candidates = ZONE_CONTRAST[lastZone] || Object.keys(ZONES);
  return pick(candidates);
}

function pickShape(lastShape) {
  const keys = Object.keys(SHAPES).filter((k) => k !== lastShape);
  return pick(keys.length ? keys : Object.keys(SHAPES));
}

/** Build one planned arc with fixed duration and BPM envelope. */
export function buildArc(intensity, lastZone, lastShape, totalBands = 9, meta = {}) {
  const ic = ARC_INTENSITY[intensity] || ARC_INTENSITY.dramatic;
  const zoneKey = pickZone(lastZone, intensity);
  const zone = ZONES[zoneKey];
  const shapeKey = pickShape(lastShape);
  const shape = SHAPES[shapeKey];
  const duration = randBetween(5, 24) * ic.durScale;
  const jitter = randBetween(6, ic.jitterMax);
  const depth = ic.depth + (Math.random() - 0.5) * 0.08;
  const palette = buildArcPalette(shapeKey, zoneKey, intensity, totalBands);
  const orchestration = buildArcOrchestration(shapeKey, zoneKey, intensity, totalBands, {
    exaggerate: shape.exaggerate,
    bpmHi: zone.bpmMax,
    rotatePhase: meta.rotatePhase || 0,
    palettePatches: palette.patches,
  });
  const fxSnapshot = buildArcFxSnapshot(zoneKey, shapeKey, intensity);

  return {
    type: 'arc',
    name: `${shape.label} · ${zone.label} · ${orchestration.label}`,
    shapeKey,
    zoneKey,
    bpmLo: zone.bpmMin,
    bpmHi: zone.bpmMax,
    duration,
    jitter,
    depth: Math.max(0.55, Math.min(1, depth)),
    exaggerate: shape.exaggerate,
    bandBias: zone.bandBias,
    palette,
    orchestration,
    fxSnapshot,
  };
}

/** Sample planned BPM along arc shape at normalized time 0–1. */
export function sampleArcBpm(arc, t) {
  const shape = SHAPES[arc.shapeKey];
  if (!shape) return arc.bpmLo;
  const u = shape.fn(Math.max(0, Math.min(1, t)));
  return Math.max(CFG.TEMPO_MIN, Math.min(CFG.TEMPO_MAX, arc.bpmLo + (arc.bpmHi - arc.bpmLo) * u));
}

/** Morph curve 0–1 for palette + FX interpolation (same shape as BPM). */
export function sampleArcMorph(arc, t) {
  const shape = SHAPES[arc.shapeKey];
  if (!shape) return Math.max(0, Math.min(1, t));
  return shape.fn(Math.max(0, Math.min(1, t)));
}

/** Generate a sequence of arcs each followed by a silence gap. */
export function generateArcProgram(arcCount, gapProfile, intensity, meta = {}, totalBands = 9) {
  const items = [];
  let lastZone = meta.lastZone || null;
  let lastShape = meta.lastShape || null;
  let lastGapClass = meta.lastGapClass || null;
  let rotatePhase = meta.rotatePhase || 0;
  const rotateSpan = Math.max(3, Math.ceil(totalBands / 6));

  for (let i = 0; i < arcCount; i++) {
    const arc = buildArc(intensity, lastZone, lastShape, totalBands, { rotatePhase });
    items.push(arc);
    lastZone = arc.zoneKey;
    lastShape = arc.shapeKey;
    rotatePhase = (rotatePhase + 1) % rotateSpan;

    const gapClass = pickGapClass(gapProfile, lastGapClass);
    items.push({
      type: 'gap',
      gapClass,
      duration: gapDuration(gapClass),
      name: GAP_PROFILES[gapClass].label,
    });
    lastGapClass = gapClass;
  }

  return { items, lastZone, lastShape, lastGapClass, rotatePhase };
}

export function createArcStream(gapProfile = 'mixed', intensity = 'dramatic', totalBands = 9) {
  const prog = generateArcProgram(5, gapProfile, intensity, {}, totalBands);
  return {
    gapProfile,
    intensity,
    totalBands,
    queue: prog.items,
    meta: {
      lastZone: prog.lastZone,
      lastShape: prog.lastShape,
      lastGapClass: prog.lastGapClass,
      rotatePhase: prog.rotatePhase,
    },
    index: 0,
    phaseStart: 0,
    arcsCompleted: 0,
    sessionAppliedIndex: -1,
  };
}

/** Top up queue so playback never runs dry. */
export function refillArcQueue(stream, minAhead = 8) {
  const pending = stream.queue.length - stream.index;
  if (pending >= minAhead) return;
  const prog = generateArcProgram(4, stream.gapProfile, stream.intensity, stream.meta, stream.totalBands || 9);
  stream.queue.push(...prog.items);
  Object.assign(stream.meta, {
    lastZone: prog.lastZone,
    lastShape: prog.lastShape,
    lastGapClass: prog.lastGapClass,
    rotatePhase: prog.rotatePhase,
  });
}

/** Trim consumed items to keep queue bounded. */
export function compactArcQueue(stream) {
  if (stream.index < 4) return;
  stream.queue.splice(0, stream.index);
  stream.index = 0;
}

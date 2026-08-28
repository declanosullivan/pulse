/**
 * Arc Orchestration (Phase 2) — per-arc enable/disable of spectral band groups.
 */
import { bandIndicesForZone } from './arc-palettes.js';

export const DENSITY_PROFILES = Object.freeze({
  sparse: { label: 'Sparse', minRatio: 0.04, maxRatio: 0.08 },
  ensemble: { label: 'Ensemble', minRatio: 0.12, maxRatio: 0.22 },
  full: { label: 'Full Stack', minRatio: 0.28, maxRatio: 0.42 },
});

const TILE_LABELS = Object.freeze(['Infrasub', 'Low', 'Mid-Low', 'Mid-High', 'High', 'Hyper']);

const ZONE_TILE_BIAS = Object.freeze({
  sub: 0,
  low: 0.16,
  mid: 0.42,
  high: 0.68,
  hyper: 0.88,
  wide: null,
});

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Number of spectral tiles for a given band count. */
export function tileCount(totalBands) {
  if (totalBands >= 36) return 6;
  if (totalBands >= 18) return 4;
  if (totalBands >= 9) return 3;
  return Math.max(1, Math.min(3, totalBands));
}

/** Band indices belonging to a tile. */
export function bandsInTile(tileIndex, totalBands, tiles) {
  const perTile = Math.ceil(totalBands / tiles);
  const start = tileIndex * perTile;
  const end = Math.min(totalBands, start + perTile);
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

function neighborTile(primary, tiles) {
  const candidates = [primary - 1, primary + 1, (primary + 2) % tiles].filter(
    (t) => t >= 0 && t < tiles && t !== primary,
  );
  return candidates.length ? pick(candidates) : (primary + 1) % tiles;
}

function tilesForZone(zoneKey, totalBands, tiles) {
  if (zoneKey === 'wide') {
    const a = Math.floor(Math.random() * tiles);
    let b = Math.floor(Math.random() * tiles);
    while (b === a && tiles > 1) b = Math.floor(Math.random() * tiles);
    return [a, b];
  }
  const bias = ZONE_TILE_BIAS[zoneKey] ?? 0.5;
  const primary = Math.min(tiles - 1, Math.floor(bias * tiles));
  return [primary, neighborTile(primary, tiles)];
}

function densityFromContext(exaggerate, intensity, bpmHi) {
  if (exaggerate === 'sparse' || exaggerate === 'thin') return 'sparse';
  if (intensity === 'subtle') return Math.random() < 0.45 ? 'sparse' : 'ensemble';
  if (intensity === 'extreme' && bpmHi < 130 && Math.random() < 0.32) return 'full';
  if (intensity === 'extreme' && Math.random() < 0.18) return 'full';
  return 'ensemble';
}

function targetCount(density, intensity, totalBands) {
  const prof = DENSITY_PROFILES[density] || DENSITY_PROFILES.ensemble;
  let ratio = prof.minRatio + Math.random() * (prof.maxRatio - prof.minRatio);
  if (intensity === 'extreme') ratio *= 1.15;
  if (intensity === 'subtle') ratio *= 0.82;
  const n = Math.max(1, totalBands);
  let count = Math.round(n * ratio);
  if (density === 'sparse') count = Math.max(2, Math.min(4, count));
  else if (density === 'full') count = Math.max(6, Math.min(16, count));
  else count = Math.max(3, Math.min(10, count));
  return Math.min(n, count);
}

/**
 * Build enable indices for one arc — primary tile + neighbor, rotated across arcs.
 */
export function buildArcOrchestration(shapeKey, zoneKey, intensity, totalBands, options = {}) {
  const {
    exaggerate = 'combo',
    bpmHi = 200,
    rotatePhase = 0,
    palettePatches = [],
  } = options;

  const n = Math.max(1, totalBands);
  const tiles = tileCount(n);
  const density = densityFromContext(exaggerate, intensity, bpmHi);
  const count = targetCount(density, intensity, n);
  const [primary, neighbor] = tilesForZone(zoneKey, n, tiles);

  let pool = [...bandsInTile(primary, n, tiles), ...bandsInTile(neighbor, n, tiles)];
  if (pool.length < count) {
    const zoneExtra = bandIndicesForZone(zoneKey, n, count);
    pool = [...new Set([...pool, ...zoneExtra])];
  }

  const rot = rotatePhase % Math.max(1, pool.length);
  pool = [...pool.slice(rot), ...pool.slice(0, rot)];

  const enableIndices = [];
  for (let i = 0; i < pool.length && enableIndices.length < count; i++) {
    enableIndices.push(pool[i]);
  }

  for (const patch of palettePatches) {
    if (patch.bandIndex != null && !enableIndices.includes(patch.bandIndex)) {
      enableIndices.push(patch.bandIndex);
    }
  }

  enableIndices.sort((a, b) => a - b);

  const tileLabel = TILE_LABELS[primary] || `Tile ${primary + 1}`;
  const densityLabel = DENSITY_PROFILES[density]?.label || 'Ensemble';

  return {
    density,
    densityLabel,
    tiles: [primary, neighbor],
    tileLabel,
    enableIndices,
    rotatePhase,
    label: `${densityLabel} · ${tileLabel}`,
    shapeKey,
    zoneKey,
  };
}

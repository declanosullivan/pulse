/**
 * Spectral band grouping for collapsible UI (Phase 3).
 */

/** Collapsible groups for the bands panel. */
export function getBandGroups(totalBands) {
  const n = Math.max(1, totalBands);
  if (n <= 12) {
    return [{ id: 'all', label: 'All Bands', indices: Array.from({ length: n }, (_, i) => i), defaultOpen: true }];
  }

  const groups = [];
  const namedCount = Math.min(9, n);
  if (namedCount > 0) {
    groups.push({
      id: 'named',
      label: `Bands 01–${String(namedCount).padStart(2, '0')}`,
      indices: Array.from({ length: namedCount }, (_, i) => i),
      defaultOpen: true,
    });
  }

  const spectralCount = n - namedCount;
  if (spectralCount > 0) {
    const tileCount = Math.min(6, Math.max(3, Math.ceil(spectralCount / 4)));
    const perTile = Math.ceil(spectralCount / tileCount);
    for (let t = 0; t < tileCount; t++) {
      const indices = [];
      const start = namedCount + t * perTile;
      const end = Math.min(n, namedCount + (t + 1) * perTile);
      for (let i = start; i < end; i++) indices.push(i);
      if (!indices.length) continue;
      groups.push({
        id: `spectral-${t}`,
        label: `${String(namedCount + start + 1).padStart(2, '0')}–${String(Math.min(n, namedCount + end)).padStart(2, '0')}`,
        indices,
        defaultOpen: t < 2,
      });
    }
  }

  return groups;
}

/** Suggested view mode for a band count. */
export function defaultBandViewMode(totalBands) {
  if (totalBands >= 24) return 'compact';
  if (totalBands >= 12) return 'groups';
  return 'full';
}

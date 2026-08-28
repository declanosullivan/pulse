/** Shared runtime constants for PulseForge. */
export const TAU = Math.PI * 2;
export const STEPS = 16;
export const PRESET_KEY = 'pulseforge.presets.v1';

export const CFG = Object.freeze({
  MAX_DPR: 2,
  GRID: 40,
  UI_TAU: 0.02,
  RELEASE_TAU: 0.045,
  PAN_VIS_WIDTH: 0.2,
  PULSE_RADIUS: 22,
  PARTICLE_MAX: 512,
  TICK_MS: 25,
  LOOKAHEAD_MIN: 0.35,
  LOOKAHEAD_PAGE: 3.0,
  CURVE_WINDOW: 0.1,
  CURVE_N: 256,
  WORKLET_TIMEOUT: 1500,
  VIS_STEP: 1 / 1024,
  VIS_MAX_CATCHUP: 150000,
  DELAY_MAX: 2.0,
  DELAY_TAU: 0.08,
  FB_MAX: 0.85,
  NOISE_SEC: 2,
  DRIVE_CURVE_N: 1024,
  OFFLINE_CURVE_RATE: 3000,
  BAND_START_OFFSET: 0.03,
  TRANSPORT_ANCHOR_OFFSET: 0.06,
  NODE_DISCONNECT_DELAY: 450,
  OSC_STOP_TAIL: 0.25,
  LOG_MAX_ENTRIES: 500,
  LOG_RENDER_MS: 500,
  LOG_VISIBLE_ROWS: 100,
  WAVEFORM_DRAW_INTERVAL: 2,
  /** Pulse Low/High are Hz at this reference tempo when SYNC is on. */
  REF_BPM: 60,
  TEMPO_MIN: 1,
  TEMPO_MAX: 500,
  /** Max simultaneous frequency bands in a session. */
  MAX_BANDS: 48,
  /** Target band count for Arc Stream orchestration. */
  ARC_STREAM_BANDS: 36,
  /** Bands loaded on fresh session (named brainwave set). */
  DEFAULT_BANDS: 9,
  WORKLET_PULSE_MIN: 0.001,
  WORKLET_PULSE_MAX: 2000,
  WORKLET_DUR_MAX: 600,
});

export const CURVE_DT = CFG.CURVE_WINDOW / CFG.CURVE_N;

export const SHAPE_NUM = Object.freeze({ ramp: 0, triangle: 1, sine: 2 });

export const REVERB_PRESETS = Object.freeze({
  room: { dur: 1.1, damp: 0.35, pow: 2.0 },
  hall: { dur: 2.8, damp: 0.22, pow: 1.6 },
  cave: { dur: 4.6, damp: 0.12, pow: 1.2 },
  plate: { dur: 1.7, damp: 0.4, pow: 2.5 },
});

export const BAND_COLORS = Object.freeze([
  '#E11D48', '#D97706', '#059669', '#DB2777', '#7C3AED', '#0284C7',
  '#C026D3', '#EA580C', '#65A30D', '#0891B2', '#E11D48', '#84CC16',
]);

export const ICON_PLAY =
  '<svg width="11" height="11" viewBox="0 0 12 12" style="display:inline-block;vertical-align:-1px;margin-right:6px" aria-hidden="true"><path d="M2 1l9 5-9 5z" fill="currentColor"/></svg>';

export const ICON_STOP =
  '<svg width="11" height="11" viewBox="0 0 12 12" style="display:inline-block;vertical-align:-1px;margin-right:6px" aria-hidden="true"><rect x="2" y="2" width="8" height="8" fill="currentColor"/></svg>';

export const ART_SVG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect fill="%2308080D" width="512" height="512"/><circle cx="256" cy="256" r="120" fill="none" stroke="%23D97706" stroke-width="4"/><circle cx="256" cy="256" r="60" fill="%23D97706" opacity=".3"/></svg>',
  );

/**
 * PulseForge — generative multi-band spatial rhythm synthesizer.
 * Refactored into ES modules with layout/perf improvements.
 */
import {
  CFG, TAU, STEPS, PRESET_KEY, AUDIO_SINK_KEY, SHAPE_NUM, REVERB_PRESETS, BAND_COLORS,
  ICON_PLAY, ICON_STOP, ART_SVG, CURVE_DT,
} from './config.js';
import {
  $, REDUCED, euclidPattern, lfoValue, panLabel, truncName, hexToRgb,
  makeDriveCurve, applyFilterType, downloadBlob, flashBtn, makeNoiseBuffer,
  clampOscFreq, fmModFrequency, nyquistHz,
  paramInputAttrs, rhythmInputAttrs, clampBandParams, roundParam, uiToStored, storedToUi,
} from './utils.js';
import { WORKLET_SRC, TICKER_SRC } from './audio/worklet-src.js';
import {
  logParamChange, clearLog, renderLogTable, maybeRenderLog, exportLogCsv,
} from './log.js';
import { BAND_DEFS } from './bands/defs.js';
import { getBandDefs, bandDefsToState, getFullSpectrumBandDefs, bandLabel } from './bands/factory.js';
import { getBandGroups, defaultBandViewMode } from './band-groups.js';
import {
  createArcStream, refillArcQueue, compactArcQueue, sampleArcBpm, sampleArcMorph,
} from './arc-generator.js';
import { ARC_PALETTE_KEYS, ARC_MORPH_KEYS } from './arc-palettes.js';
import { ARC_FX_MORPH_KEYS, lerpFxSnapshot } from './arc-fx-snapshots.js';

function bandInp(key, band, stored) {
  const a = paramInputAttrs(key, band, stored);
  return `min="${a.min}" max="${a.max}" step="${a.step}" value="${a.value}"`;
}

function rhythmInp(key, band, stored) {
  const a = rhythmInputAttrs(key, band, stored);
  return `min="${a.min}" max="${a.max}" step="${a.step}" value="${a.value}"`;
}

export function initPulseForge() {
'use strict';

const noiseBuffers = { white: null, pink: null, brown: null };
function getNoiseBuffer(type) {
  if (!audioCtx) return null;
  if (noiseBuffers[type]) return noiseBuffers[type];
  noiseBuffers[type] = makeNoiseBuffer(audioCtx, type);
  return noiseBuffers[type];
}

function getBandEffectiveParams(b, tempoOverride) {
  if (!b) return { pLow: 0.5, pHigh: 4, dur: 8, tempo: 90 };
  const tempo = Math.max(1, tempoOverride !== undefined ? tempoOverride : (fxState.tempo || 90));
  const pLow = Math.max(CFG.WORKLET_PULSE_MIN, b.pLow || 0.5);
  const pHigh = Math.max(CFG.WORKLET_PULSE_MIN, b.pHigh || 4);
  const dur = Math.max(CFG.WORKLET_DUR_MIN, b.dur || 8);
  if (!b.bpmSync) {
    return {
      pLow: Math.min(CFG.WORKLET_PULSE_MAX, pLow),
      pHigh: Math.min(CFG.WORKLET_PULSE_MAX, pHigh),
      dur: Math.min(CFG.WORKLET_DUR_MAX, dur),
      tempo,
    };
  }
  // SYNC: stored Low/High are pulse Hz at REF_BPM (60). Scale with current tempo.
  // Dur is LFO cycle length in beats → seconds at current tempo.
  const beatHz = tempo / CFG.REF_BPM;
  return {
    pLow: Math.min(CFG.WORKLET_PULSE_MAX, Math.max(CFG.WORKLET_PULSE_MIN, pLow * beatHz)),
    pHigh: Math.min(CFG.WORKLET_PULSE_MAX, Math.max(CFG.WORKLET_PULSE_MIN, pHigh * beatHz)),
    dur: Math.min(CFG.WORKLET_DUR_MAX, Math.max(0.01, dur / beatHz)),
    tempo,
  };
}

function clampWorkletPulse(v) {
  return Math.min(CFG.WORKLET_PULSE_MAX, Math.max(CFG.WORKLET_PULSE_MIN, Number.isFinite(v) ? v : CFG.WORKLET_PULSE_MIN));
}

/** Restart a band's audio graph without clearing the user enabled flag. */
function restartBand(b) {
  if (!isPlaying || !b.enabled || !audioCtx) return;
  stopBand(b);
  startBand(b);
}

let audioCtx = null, masterGain = null, rampSilenceGain = null, compressor = null, analyser = null, scopeBuf = null;
let isPlaying = false, lastFrameT = 0, dpr = 1, renderSuspended = false;
let vizW = 0, vizH = 0, waveW = 0, waveH = 0, gridLayer = null;
let engineMode = '—', timerSource = '—';
let tickerWorker = null, pageTimer = null, lastTickT = 0, lookahead = CFG.LOOKAHEAD_MIN;
let latencyMode = 'live';
let wakeRequested = false, wakeSentinel = null;
let chainCounter = 0;
let conductorActive = false;
let micStream = null, micSourceNode = null, micAnalyser = null, micBuffer = null;
let micActive = false, micBeatTrack = false;
let detectedPitch = 0, smoothedPitch = 0;
let lastTransientTime = 0, micNoiseFloor = 0.01, smoothedMicBpm = 90;
let dlyBus=null,dlyL=null,dlyR=null,dampL=null,dampR=null,fbGainL=null,fbGainR=null,dlyWetL=null,dlyWetR=null;
let revBus=null,convolver=null,revWet=null;
const fxState = {
  tempo:90, subdiv:0.375, feedback:0.45, damp:3200, dlyReturn:0.50,
  revPreset:'hall', revReturn:0.45, swing:0,
};
const rampState = {
  enabled:false, startBpm:180, endBpm:60, duration:10,
  loop:true, mode:'micro-loops', subLen:'random', jitter:40, startTime:0,
  silenceGapMin:0.5, silenceGapMax:3.0,
  exaggerateMode:'thin', exaggerateDepth:0.8,
  variationsEnabled:true, varInterval:2, varCount:3,
  lastLoopIndex:-1, totalLoopsCompleted:0,
  segStartTime:0, segDuration:3, segStartBpm:180, segEndBpm:120, segCurveType:'linear', currentBpmFloat:180,
  macroPhaseStart:0, macroPhases:null, macroPhase:'up', inSilence:false,
  arcGapProfile:'mixed', arcIntensity:'dramatic', arcOrchestration:true, arcMorph:true,
};
let arcStream = null;
let arcPaletteBaseline = null;
let arcFxBaseline = null;
let bandViewMode = 'full';
const transport = { anchorTime:0, nextStepIndex:0, running:false };
let lastTransportStep = -1;
const transportCells = [];
let midiAccess=null, midiLearnActive=false, midiArmed=null, midiArmedEl=null;
const midiMap = {};
let selectedSinkId = '';
const curvePool = [];
const bands = BAND_DEFS.map((d, i) => {
  const def = clampBandParams({ ...d, name: bandLabel(i, BAND_DEFS.length) });
  const b = {
    ...def,
    steps: euclidPattern(d.hits, STEPS, d.rotate),
    enabled:false, pulseVal:0, curFreq:d.pLow,
    srcNode:null, pulseGain:null, level:null, shaper:null, filter:null, panner:null,
    filterLFO:null, filterLFOGain:null, worklet:null, _chainId:0,
    dlySendG:null, revSendG:null, sampleBuf:null, sampleName:'',
    lfoPhaseS:0, pulsePhaseS:0, schedUntil:0,
    visLfo:0, visPulse:0, visT:0,
    lastTrig:-1, lastStepDur:0.25,
    _idx:i, ui:null, _miniDirty:true,
    _curveBuf: new Float32Array(CFG.CURVE_N + 1),
  };
  curvePool.push(b._curveBuf);
  return b;
});
const P_STRIDE = 9;
const pool = new Float32Array(CFG.PARTICLE_MAX * P_STRIDE);
let pHead = 0;
let aliveParticles = 0;

let cachedCanvasBg = '#F4F3EF';
let cachedGridLine = 'rgba(200,195,185,0.45)';
function cacheThemeColors() {
  const s = getComputedStyle(document.body);
  cachedCanvasBg = s.getPropertyValue('--canvas-bg').trim() || '#F4F3EF';
  cachedGridLine = s.getPropertyValue('--grid-line').trim() || 'rgba(200,195,185,0.45)';
}
cacheThemeColors();

const vizCanvas = $('viz-canvas'), vizCtx = vizCanvas.getContext('2d', { alpha: false });
const waveCanvas = $('wave-canvas'), waveCtx = waveCanvas.getContext('2d', { alpha: false });
const bandsGrid = $('bands-grid'), playBtn = $('play-btn');
const modeBtn = $('mode-btn'), wakeBtn = $('wake-btn'), themeBtn = $('theme-btn');
const sys = {
  state:$('sys-state'), rate:$('sys-rate'), engine:$('sys-engine'),
  timer:$('sys-timer'), wake:$('sys-wake'),
  ledState:$('led-state'), ledEngine:$('led-engine'),
  ledTimer:$('led-timer'), ledWake:$('led-wake'),
};
const sysCache = {};
function setLed(el, on, green) {
  el.classList.toggle('on', !!on && !green);
  el.classList.toggle('grn', !!on && !!green);
}
function updateBandCountUI() {
  const meta = $('band-count-meta');
  const addBtn = $('btn-add-band');
  const expandBtn = $('btn-expand-36');
  const label = `${bands.length} / ${CFG.MAX_BANDS} bands`;
  if (meta) meta.textContent = label;
  if (addBtn) addBtn.disabled = bands.length >= CFG.MAX_BANDS;
  if (expandBtn) expandBtn.disabled = bands.length >= CFG.ARC_STREAM_BANDS;
}
function syncBandViewUI() {
  const mode = bandViewMode || 'full';
  for (const id of ['full', 'groups', 'compact']) {
    const btn = $(`band-view-${id}`);
    if (btn) {
      btn.classList.toggle('on', mode === id);
      btn.setAttribute('aria-pressed', String(mode === id));
    }
  }
  if (bandsGrid) {
    bandsGrid.classList.toggle('compact-view', mode === 'compact');
    bandsGrid.classList.toggle('group-view', mode === 'groups');
  }
}
function setBandViewMode(mode) {
  if (!['full', 'groups', 'compact'].includes(mode)) return;
  bandViewMode = mode;
  rebuildCards();
  syncBandViewUI();
  logParamChange('Bands', 'System', 'View', mode);
}
function expandBandsTo(targetCount) {
  const n = Math.min(CFG.MAX_BANDS, targetCount);
  if (bands.length >= n) return 0;
  const defs = getBandDefs(n);
  const added = [];
  while (bands.length < n) {
    const idx = bands.length;
    const b = addBand(defs[idx], { rebuild: false });
    if (!b) break;
    added.push(b);
  }
  if (bands.length >= 18 && bandViewMode === 'full') {
    bandViewMode = defaultBandViewMode(bands.length);
  }
  rebuildCards();
  syncBandViewUI();
  updateBandCountUI();
  if (isPlaying) {
    for (let i = 0; i < added.length; i++) if (added[i].enabled) startBand(added[i]);
  }
  if (added.length) logParamChange('Bands', 'System', 'Expand', `${bands.length} bands`);
  return added.length;
}
function ensureArcStreamBands() {
  if (bands.length < CFG.ARC_STREAM_BANDS) {
    expandBandsTo(CFG.ARC_STREAM_BANDS);
    arcPaletteBaseline = null;
  }
}
function updateSysUI() {
  const put = (k, el, v) => { if (sysCache[k] !== v) { sysCache[k] = v; el.textContent = v; } };
  put('state', sys.state, isPlaying ? 'RUNNING' : 'IDLE');
  put('rate', sys.rate, audioCtx ? (audioCtx.sampleRate / 1000).toFixed(1) + ' kHz' : '—');
  put('engine', sys.engine, engineMode === '—' ? '—' : engineMode.toUpperCase());
  put('timer', sys.timer, timerSource.toUpperCase());
  put('wake', sys.wake, !('wakeLock' in navigator) ? 'N/A' : wakeSentinel ? 'ON' : 'OFF');
  setLed(sys.ledState, isPlaying, true);
  setLed(sys.ledEngine, audioCtx, engineMode === 'worklet');
  setLed(sys.ledTimer, !!(tickerWorker || pageTimer), timerSource === 'worker');
  setLed(sys.ledWake, wakeSentinel, true);
}


function buildCards() {
  bandsGrid.replaceChildren();
  bandsGrid.classList.toggle('compact-view', bandViewMode === 'compact');
  bandsGrid.classList.toggle('group-view', bandViewMode === 'groups');

  function mountBandCard(band, parent) {
    band._idx = bands.indexOf(band);
    const card = document.createElement('article');
    card.className = 'band-card';
    card.style.setProperty('--band-color', band.color);
    card.dataset.bandIndex = String(band._idx);
    card.innerHTML = `
<div class="band-head">
  <div class="band-head-left">
    <div class="toggle" role="switch" aria-checked="${band.enabled}" aria-label="Toggle ${band.name}" tabindex="0"></div>
    <span class="band-name" style="color:${band.color}">${band.name}</span>
  </div>
  <div class="band-head-right">
    <span class="freq-display" style="color:${band.color}">${band.pLow.toFixed(1)} Hz</span>
    <button type="button" class="sm-btn danger" data-btn="remove" title="Remove" aria-label="Remove ${band.name}">✕</button>
    <div class="pulse-dot" style="--band-color:${band.color}"></div>
  </div>
</div>
<canvas class="lfo-canvas" aria-hidden="true"></canvas>
<div class="band-row">
  <span class="ctrl-label">Source</span>
  <select data-source aria-label="${band.name} source">
    <option value="osc" ${band.source==='osc'?'selected':''}>Oscillator</option>
    <option value="fm" ${band.source==='fm'?'selected':''}>2-Op FM</option>
    <option value="pluck" ${band.source==='pluck'?'selected':''}>Pluck</option>
    <option value="sub" ${band.source==='sub'?'selected':''}>Sub-Bass</option>
    <option value="white" ${band.source==='white'?'selected':''}>White Noise</option>
    <option value="pink" ${band.source==='pink'?'selected':''}>Pink Noise</option>
    <option value="brown" ${band.source==='brown'?'selected':''}>Brown Noise</option>
    <option value="smp" ${band.source==='smp'?'selected':''} ${band.sampleBuf?'':'disabled'}>${band.sampleBuf?'SMP: '+truncName(band.sampleName,10):'Sample'}</option>
  </select>
  <button type="button" class="sm-btn" data-load>SMP</button>
</div>
<div class="fm-box ${band.source==='fm'?'':'hidden'}" data-fmbody>
  <div class="band-row"><span class="ctrl-label">FM Ratio</span><input class="num-input" type="number" ${bandInp('fmRatio', band, band.fmRatio||2)} data-ctl="fmRatio"><span class="ctrl-val" data-val="fmRatio">${(band.fmRatio||2).toFixed(2)}x</span></div>
  <div class="band-row"><span class="ctrl-label">FM Index</span><input class="num-input" type="number" ${bandInp('fmIndex', band, band.fmIndex||20)} data-ctl="fmIndex"><span class="ctrl-val" data-val="fmIndex">${band.fmIndex||20}</span></div>
</div>
<div class="pluck-box ${band.source==='pluck'?'':'hidden'}" data-pluckbody>
  <div class="band-row"><span class="ctrl-label">Decay</span><input class="num-input" type="number" ${bandInp('pluckDecay', band, band.pluckDecay||0.05)} data-ctl="pluckDecay"><span class="ctrl-val" data-val="pluckDecay">${(band.pluckDecay||0.05).toFixed(2)}</span></div>
</div>
<div class="band-row"><span class="ctrl-label">Carrier</span><input class="num-input" type="number" ${bandInp('carrier', band, band.carrier)} data-ctl="carrier"><button type="button" class="chip-btn" data-ctl="micSync" aria-pressed="${band.micSync}">MIC</button><select data-ctl="cType"><option value="sine" ${band.cType==='sine'?'selected':''}>Sine</option><option value="triangle" ${band.cType==='triangle'?'selected':''}>Tri</option><option value="sawtooth" ${band.cType==='sawtooth'?'selected':''}>Saw</option><option value="square" ${band.cType==='square'?'selected':''}>Sq</option></select></div>
<div class="band-row" style="justify-content:flex-end"><span class="ctrl-val" data-val="carrier">${band.carrier>=1000?(band.carrier/1000).toFixed(2)+' kHz':band.carrier+' Hz'}</span></div>
<div class="band-row"><span class="ctrl-label">Binaural</span><input class="num-input" type="number" ${bandInp('binauralOffset', band, band.binauralOffset||0)} data-ctl="binauralOffset"><span class="ctrl-val" data-val="binauralOffset">${(band.binauralOffset||0)>0?'+':''}${(band.binauralOffset||0).toFixed(1)}Hz</span></div>
<div class="band-row"><span class="ctrl-label">Pitch</span><input class="num-input" type="number" ${bandInp('pitch', band, band.pitch)} data-ctl="pitch"><span class="ctrl-val" data-val="pitch">${band.pitch>0?'+':''}${band.pitch}st</span></div>
<div class="band-row"><span class="ctrl-label" title="Pulse rate low. With SYNC: Hz at 60 BPM">Low</span><input class="num-input" type="number" ${bandInp('pLow', band, band.pLow)} data-ctl="pLow"><span class="ctrl-val" data-val="pLow">${band.pLow.toFixed(2)}</span></div>
<div class="band-row"><span class="ctrl-label" title="Pulse rate high. With SYNC: Hz at 60 BPM">High</span><input class="num-input" type="number" ${bandInp('pHigh', band, band.pHigh)} data-ctl="pHigh"><span class="ctrl-val" data-val="pHigh">${band.pHigh.toFixed(2)}</span></div>
<div class="band-row"><span class="ctrl-label" title="LFO duration. With SYNC: length in beats">Dur</span><input class="num-input" type="number" ${bandInp('dur', band, band.dur)} data-ctl="dur"><button type="button" class="chip-btn" data-ctl="bpmSync" aria-pressed="${band.bpmSync}" title="Scale pulse rates with global tempo (values are Hz @ 60 BPM)">SYNC</button><span class="ctrl-val" data-val="dur">${band.dur.toFixed(2)}</span></div>
<div class="band-row"><span class="ctrl-label">L.Target</span><select data-ctl="lfoTarget"><option value="filter" ${band.lfoTarget==='filter'?'selected':''}>Filter</option><option value="pitch" ${band.lfoTarget==='pitch'?'selected':''}>Pitch</option><option value="volume" ${band.lfoTarget==='volume'?'selected':''}>Volume</option><option value="pan" ${band.lfoTarget==='pan'?'selected':''}>Pan</option><option value="fm" ${band.lfoTarget==='fm'?'selected':''}>FM</option></select></div>
<div class="band-row"><span class="ctrl-label">Shape</span><select data-ctl="shape"><option value="ramp" ${band.shape==='ramp'?'selected':''}>Ramp</option><option value="triangle" ${band.shape==='triangle'?'selected':''}>Tri</option><option value="sine" ${band.shape==='sine'?'selected':''}>Sine</option></select></div>
<div class="band-row"><span class="ctrl-label">Vol</span><input class="num-input" type="number" ${bandInp('vol', band, band.vol)} data-ctl="vol"><span class="ctrl-val" data-val="vol">${Math.round(band.vol*100)}%</span></div>
<div class="band-row"><span class="ctrl-label">Sharp</span><input class="num-input" type="number" ${bandInp('sharp', band, band.sharp)} data-ctl="sharp"><span class="ctrl-val" data-val="sharp">${band.sharp.toFixed(1)}</span></div>
<div class="band-row"><span class="ctrl-label">Drive</span><select data-ctl="driveType" style="flex:0 0 4rem"><option value="tanh" ${band.driveType==='tanh'?'selected':''}>Soft</option><option value="tube" ${band.driveType==='tube'?'selected':''}>Tube</option><option value="fold" ${band.driveType==='fold'?'selected':''}>Fold</option><option value="crush" ${band.driveType==='crush'?'selected':''}>Crush</option></select><input class="num-input" type="number" ${bandInp('drive', band, band.drive)} data-ctl="drive"><span class="ctrl-val" data-val="drive">${Math.round(band.drive*100)}%</span></div>
<details class="band-subpanel">
  <summary>FX &amp; Space</summary>
  <div class="band-subpanel-body">
    <div class="band-row"><span class="ctrl-label">Pan</span><input class="num-input" type="number" ${bandInp('pan', band, band.pan)} data-ctl="pan"><span class="ctrl-val" data-val="pan">${panLabel(band.pan)}</span></div>
    <div class="band-row"><span class="ctrl-label">Dly Snd</span><input class="num-input" type="number" ${bandInp('dlySend', band, band.dlySend)} data-ctl="dlySend"><span class="ctrl-val" data-val="dlySend">${Math.round(band.dlySend*100)}%</span></div>
    <div class="band-row"><span class="ctrl-label">Rev Snd</span><input class="num-input" type="number" ${bandInp('revSend', band, band.revSend)} data-ctl="revSend"><span class="ctrl-val" data-val="revSend">${Math.round(band.revSend*100)}%</span></div>
    <div class="band-row"><span class="ctrl-label">Filter</span><select data-ctl="filterType" style="flex:0 0 5rem"><option value="lowpass" ${band.filterType==='lowpass'?'selected':''}>LPF</option><option value="highpass" ${band.filterType==='highpass'?'selected':''}>HPF</option><option value="bandpass" ${band.filterType==='bandpass'?'selected':''}>BPF</option><option value="notch" ${band.filterType==='notch'?'selected':''}>Notch</option><option value="ladder" ${band.filterType==='ladder'?'selected':''}>Ladder</option><option value="formant" ${band.filterType==='formant'?'selected':''}>Formant</option><option value="comb" ${band.filterType==='comb'?'selected':''}>Comb</option></select><input class="num-input" type="number" ${bandInp('filterFreq', band, band.filterFreq)} data-ctl="filterFreq"><span class="ctrl-val" data-val="filterFreq">${band.filterFreq}Hz</span></div>
    <div class="band-row"><span class="ctrl-label">Res</span><input class="num-input" type="number" ${bandInp('filterQ', band, band.filterQ)} data-ctl="filterQ"><span class="ctrl-val" data-val="filterQ">${band.filterQ.toFixed(1)}</span></div>
    <div class="band-row"><span class="ctrl-label">F.LFO</span><input class="num-input" type="number" ${bandInp('filterLFORate', band, band.filterLFORate)} data-ctl="filterLFORate"><span class="ctrl-val" data-val="filterLFORate">${band.filterLFORate.toFixed(2)}Hz</span></div>
    <div class="band-row"><span class="ctrl-label">F.Dpth</span><input class="num-input" type="number" ${bandInp('filterLFODepth', band, band.filterLFODepth)} data-ctl="filterLFODepth"><span class="ctrl-val" data-val="filterLFODepth">${band.filterLFODepth}</span></div>
  </div>
</details>
<details class="band-subpanel" ${band.mode==='seq'?'open':''}>
  <summary><span>Rhythm</span><span class="band-head-right"><span class="ctrl-label">Seq</span><button type="button" class="toggle mini-toggle" role="switch" aria-checked="${band.mode==='seq'}" data-mode></button></span></summary>
  <div class="${band.mode==='seq'?'':'hidden'}" data-seqbody></div>
</details>`;
    parent.appendChild(card);
    const q = (s) => card.querySelector(s);
    const lfoCanvas = q('.lfo-canvas');
    band.ui = {
      card, toggle:q('.toggle'), dot:q('.pulse-dot'), freqDisp:q('.freq-display'),
      lfoCanvas, lfoCtx:lfoCanvas.getContext('2d'), lfoW:0, lfoH:0,
      sourceSel:q('[data-source]'), loadBtn:q('[data-load]'),
      fmBody:q('[data-fmbody]'), pluckBody:q('[data-pluckbody]'), removeBtn:q('[data-btn="remove"]'),
      modeToggle:q('[data-mode]'), seqBody:q('[data-seqbody]'),
      gridCells:[], phIdx:-1, controls:{},
      _active:band.enabled, _lit:false, _freq:'',
    };
    wireBand(band, card);
    wireSourceUI(band, card);
    buildRhythmUI(band, card);
    band.ui.toggle.classList.toggle('on', band.enabled);
    band.ui.toggle.setAttribute('aria-checked', String(band.enabled));
    card.classList.toggle('active', band.enabled);
    band.ui.modeToggle.classList.toggle('on', band.mode === 'seq');
    band.ui.modeToggle.setAttribute('aria-checked', String(band.mode === 'seq'));
    band.ui.seqBody.classList.toggle('hidden', band.mode !== 'seq');
  }

  if (bandViewMode === 'groups') {
    for (const group of getBandGroups(bands.length)) {
      const section = document.createElement('details');
      section.className = 'band-group';
      section.open = group.defaultOpen !== false;
      const summary = document.createElement('summary');
      summary.className = 'band-group-summary';
      summary.innerHTML = `${group.label}<span class="band-group-meta">${group.indices.length}</span>`;
      section.appendChild(summary);
      const inner = document.createElement('div');
      inner.className = 'bands-grid-inner';
      for (const idx of group.indices) {
        if (bands[idx]) mountBandCard(bands[idx], inner);
      }
      section.appendChild(inner);
      bandsGrid.appendChild(section);
    }
  } else {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < bands.length; i++) mountBandCard(bands[i], frag);
    bandsGrid.appendChild(frag);
  }
}
function rebuildCards() { buildCards(); resize(); }

function wireSourceUI(b, card) {
  const sel = b.ui.sourceSel, loadBtn = b.ui.loadBtn;
  const fi = document.createElement('input');
  fi.type = 'file'; fi.accept = 'audio/*'; fi.hidden = true;
  card.appendChild(fi);
  sel.addEventListener('change', () => {
    const v = sel.value;
    if (v === 'smp' && !b.sampleBuf) { sel.value = b.source; return; }
    b.source = v; b._miniDirty = true;
    if (b.ui.fmBody) b.ui.fmBody.classList.toggle('hidden', v !== 'fm');
    if (b.ui.pluckBody) b.ui.pluckBody.classList.toggle('hidden', v !== 'pluck');
    if (isPlaying && b.enabled) restartBand(b);
  });
  if (b.ui.removeBtn) b.ui.removeBtn.addEventListener('click', () => removeBand(b._idx));
  loadBtn.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { if (fi.files[0]) loadSample(b, fi.files[0]); });
  card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', e => { e.preventDefault(); card.classList.remove('drag-over'); if (e.dataTransfer.files[0]) loadSample(b, e.dataTransfer.files[0]); });
}
async function loadSample(b, file) {
  const btn = b.ui.loadBtn; btn.textContent = '…';
  try {
    await ensureAudio();
    const buf = await audioCtx.decodeAudioData(await file.arrayBuffer());
    b.sampleBuf = buf; b.sampleName = file.name;
    const opt = b.ui.sourceSel.querySelector('option[value="smp"]');
    opt.disabled = false; opt.textContent = 'SMP: ' + truncName(file.name, 10);
    b.ui.sourceSel.value = 'smp'; b.source = 'smp'; b._miniDirty = true;
    btn.textContent = '✓';
    if (isPlaying && b.enabled) restartBand(b);
  } catch (err) {
    console.warn('Sample load failed:', err);
    btn.textContent = 'ERR'; setTimeout(() => { btn.textContent = 'SMP'; }, 1200);
  }
}
function buildRhythmUI(b, card) {
  const body = b.ui.seqBody;
  body.innerHTML = `<div class="step-grid" data-grid></div>
<div class="band-row"><span class="ctrl-label">Hits</span><input class="num-input" type="number" ${rhythmInp('hits', b, b.hits)} data-rctl="hits"><span class="ctrl-val" data-rval="hits">${b.hits}</span></div>
<div class="band-row"><span class="ctrl-label">Rotate</span><input class="num-input" type="number" ${rhythmInp('rotate', b, b.rotate)} data-rctl="rotate"><span class="ctrl-val" data-rval="rotate">${b.rotate}</span></div>
<div class="adsr-grid">
  <div class="band-row"><span class="ctrl-label" style="width:1.5rem">A</span><input class="num-input" type="number" ${rhythmInp('a', b, b.a)} data-rctl="a"><span class="ctrl-val" data-rval="a">${Math.round(b.a*1000)}ms</span></div>
  <div class="band-row"><span class="ctrl-label" style="width:1.5rem">D</span><input class="num-input" type="number" ${rhythmInp('d', b, b.d)} data-rctl="d"><span class="ctrl-val" data-rval="d">${Math.round(b.d*1000)}ms</span></div>
  <div class="band-row"><span class="ctrl-label" style="width:1.5rem">S</span><input class="num-input" type="number" ${rhythmInp('s', b, b.s)} data-rctl="s"><span class="ctrl-val" data-rval="s">${Math.round(b.s*100)}%</span></div>
  <div class="band-row"><span class="ctrl-label" style="width:1.5rem">R</span><input class="num-input" type="number" ${rhythmInp('r', b, b.r)} data-rctl="r"><span class="ctrl-val" data-rval="r">${Math.round(b.r*1000)}ms</span></div>
</div>`;
  const grid = body.querySelector('[data-grid]');
  for (let i = 0; i < STEPS; i++) {
    const cell = document.createElement('button');
    cell.type = 'button'; cell.className = 'step-cell' + (i % 4 === 0 ? ' beat' : '');
    cell.setAttribute('aria-label', `${b.name} step ${i+1}`); cell.dataset.step = i;
    if (b.steps[i]) cell.classList.add('on');
    cell.addEventListener('click', () => { b.steps[i] = b.steps[i] ? 0 : 1; cell.classList.toggle('on', !!b.steps[i]); });
    grid.appendChild(cell); b.ui.gridCells.push(cell);
  }
  const rq = (s) => body.querySelector(s);
  const refreshGrid = () => { for (let i = 0; i < STEPS; i++) b.ui.gridCells[i].classList.toggle('on', !!b.steps[i]); };
  rq('[data-rctl="hits"]').addEventListener('input', e => { b.hits = roundParam('hits', +e.target.value, b); rq('[data-rval="hits"]').textContent = b.hits; b.steps = euclidPattern(b.hits, STEPS, b.rotate); refreshGrid(); });
  rq('[data-rctl="rotate"]').addEventListener('input', e => { b.rotate = roundParam('rotate', +e.target.value, b); rq('[data-rval="rotate"]').textContent = b.rotate; b.steps = euclidPattern(b.hits, STEPS, b.rotate); refreshGrid(); });
  rq('[data-rctl="a"]').addEventListener('input', e => { b.a = roundParam('a', +e.target.value / 1000, b); rq('[data-rval="a"]').textContent = Math.round(b.a * 1000) + 'ms'; });
  rq('[data-rctl="d"]').addEventListener('input', e => { b.d = roundParam('d', +e.target.value / 1000, b); rq('[data-rval="d"]').textContent = Math.round(b.d * 1000) + 'ms'; });
  rq('[data-rctl="s"]').addEventListener('input', e => { b.s = roundParam('s', +e.target.value / 100, b); rq('[data-rval="s"]').textContent = Math.round(b.s * 100) + '%'; });
  rq('[data-rctl="r"]').addEventListener('input', e => { b.r = roundParam('r', +e.target.value / 1000, b); rq('[data-rval="r"]').textContent = Math.round(b.r * 1000) + 'ms'; });
  b.ui.modeToggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setBandMode(b, b.ui.modeToggle.getAttribute('aria-checked') !== 'true');
  });
}
function setBandMode(b, seq) {
  b.mode = seq ? 'seq' : 'cont';
  b.ui.modeToggle.setAttribute('aria-checked', String(seq));
  b.ui.modeToggle.classList.toggle('on', seq);
  b.ui.seqBody.classList.toggle('hidden', !seq);
  const details = b.ui.seqBody.closest('details');
  if (details && seq) details.open = true;
  b._miniDirty = true;
  if (isPlaying && b.enabled) restartBand(b);
}

const smooth = (param, v, tau) => {
  const safe = Math.max(0.0001, v);
  param.setTargetAtTime(Number.isFinite(safe) ? safe : 0.0001, audioCtx.currentTime, tau);
};
function clampAudioFreq(hz) {
  return clampOscFreq(hz, audioCtx);
}
function setOscParam(param, hz) {
  if (!param) return clampAudioFreq(hz);
  const v = clampAudioFreq(hz);
  param.value = v;
  return v;
}
function smoothOsc(param, hz, tau) {
  if (!param) return;
  smooth(param, clampAudioFreq(hz), tau);
}
function capPitchLfoDepth(b) {
  if (!b || b.lfoTarget !== 'pitch' || !b.filterLFOGain) return;
  const base = b.carrier || 440;
  const maxDepth = Math.max(0, nyquistHz(audioCtx) - base);
  if (b.filterLFODepth > maxDepth) {
    b.filterLFODepth = maxDepth;
    b.filterLFOGain.gain.value = maxDepth;
  }
}
function wset(b, name, v, discrete) {
  const p = b.worklet && b.worklet.parameters.get(name);
  if (!p || !audioCtx) return;
  const t = audioCtx.currentTime;
  let safe = Number.isFinite(v) ? v : 0.0001;
  if (name === 'pLow' || name === 'pHigh') safe = clampWorkletPulse(safe);
  else if (name === 'dur') safe = Math.min(CFG.WORKLET_DUR_MAX, Math.max(0.01, safe));
  else safe = Math.max(0.0001, safe);
  if (discrete) p.setValueAtTime(safe, t);
  else p.setTargetAtTime(safe, t, CFG.UI_TAU);
}
function connectLFOTarget(b) {
  if (!b.filterLFO || !b.filterLFOGain || !audioCtx) return;
  try { b.filterLFO.disconnect(); b.filterLFOGain.disconnect(); } catch(_) {}
  b.filterLFO.connect(b.filterLFOGain);
  if (b.lfoTarget === 'pitch' && b.srcNode?.frequency) b.filterLFOGain.connect(b.srcNode.frequency);
  else if (b.lfoTarget === 'volume' && b.level?.gain) b.filterLFOGain.connect(b.level.gain);
  else if (b.lfoTarget === 'pan' && b.panner?.pan) b.filterLFOGain.connect(b.panner.pan);
  else if (b.lfoTarget === 'fm' && b.fmGainNode?.gain) b.filterLFOGain.connect(b.fmGainNode.gain);
  else if (b.filter?.frequency) b.filterLFOGain.connect(b.filter.frequency);
  capPitchLfoDepth(b);
}
function updateBandSyncParams(b) {
  if (!b || !audioCtx) return;
  const eff = getBandEffectiveParams(b);
  if (b.worklet) {
    wset(b, 'pLow', eff.pLow); wset(b, 'pHigh', eff.pHigh); wset(b, 'dur', eff.dur);
  }
  b._miniDirty = true;
}
function refreshBandInputLimits(b) {
  if (!b?.ui?.controls) return;
  for (const key of ['pLow', 'pHigh', 'filterFreq', 'filterLFODepth', 'binauralOffset', 'pitch']) {
    const ctl = b.ui.controls[key];
    if (!ctl?.el) continue;
    const a = paramInputAttrs(key, b, b[key]);
    ctl.el.min = a.min;
    ctl.el.max = a.max;
    ctl.el.step = a.step;
  }
}

function commitBandParam(b, c, el, valEl) {
  const isNumeric = el.type === 'range' || el.type === 'number';
  let raw = c.parse ? c.parse(el.value) : (isNumeric ? parseFloat(el.value) : el.value);
  if (isNumeric && !Number.isFinite(raw)) return;
  let stored = c.transform ? c.transform(raw) : uiToStored(c.key, raw);
  if (isNumeric) {
    stored = roundParam(c.key, stored, b);
    const uiShow = c.transform ? storedToUi(c.key, stored) : storedToUi(c.key, stored);
    if (String(el.value) !== String(uiShow)) el.value = uiShow;
  } else {
    stored = raw;
  }
  b[c.key] = stored;
  if (valEl && c.fmt) valEl.textContent = c.fmt(b[c.key]);
  if (c.apply) c.apply(b, b[c.key]);
  if (c.key === 'carrier') refreshBandInputLimits(b);
  if (c.dirtyMini) b._miniDirty = true;
  logParamChange('UI', b.name, c.key, String(b[c.key]));
}

const BAND_CONTROLS = [
  { key:'carrier', fmt:v=>v>=1000?(v/1000).toFixed(2)+' kHz':v+' Hz', apply:(b,v)=>{ if(b.micSync){b.micSync=false;const sb=b.ui.card.querySelector('[data-ctl="micSync"]');if(sb)sb.setAttribute('aria-pressed','false');} if(b.srcNode&&b.source==='osc')smoothOsc(b.srcNode.frequency,v,CFG.UI_TAU); if(b.srcNodeL) setOscParam(b.srcNodeL.frequency, v - (b.binauralOffset||0)/2); if(b.srcNodeR) setOscParam(b.srcNodeR.frequency, v + (b.binauralOffset||0)/2); capPitchLfoDepth(b); }},
  { key:'cType', evt:'change', apply:(b,v)=>{ if(b.srcNode&&b.source==='osc')b.srcNode.type=v; }},
  { key:'fmRatio', fmt:v=>v.toFixed(2)+'x', apply:(b,v)=>{ if(b.fmModNode)smoothOsc(b.fmModNode.frequency,fmModFrequency(b.carrier,v,audioCtx),CFG.UI_TAU); if(b.fmModNodeL) setOscParam(b.fmModNodeL.frequency, fmModFrequency(b.carrier - (b.binauralOffset||0)/2, v, audioCtx)); if(b.fmModNodeR) setOscParam(b.fmModNodeR.frequency, fmModFrequency(b.carrier + (b.binauralOffset||0)/2, v, audioCtx)); }},
  { key:'fmIndex', fmt:v=>String(v), apply:(b,v)=>{ if(b.fmGainNode)smooth(b.fmGainNode.gain,v*b.carrier*0.05,CFG.UI_TAU); }},
  { key:'binauralOffset', fmt:v=>(v>0?'+':'')+v.toFixed(1)+'Hz', apply:(b)=>restartBand(b) },
  { key:'lfoTarget', evt:'change', apply:(b)=>connectLFOTarget(b) },
  { key:'pitch', fmt:v=>(v>0?'+':'')+v+'st', apply:(b,v)=>{ if(b.srcNode?.playbackRate&&b.source!=='osc')smooth(b.srcNode.playbackRate,Math.pow(2,v/12),CFG.UI_TAU); }},
  { key:'pLow', fmt:v=>v.toFixed(2), apply:(b)=>{ updateBandSyncParams(b); if (b.ui) b.ui._freq=''; } },
  { key:'pHigh', fmt:v=>v.toFixed(2), apply:(b)=>{ updateBandSyncParams(b); if (b.ui) b.ui._freq=''; } },
  { key:'dur', fmt:v=>v.toFixed(1), apply:(b)=>{ updateBandSyncParams(b); if (b.ui) b.ui._freq=''; } },
  { key:'shape', evt:'change', dirtyMini:true, apply:(b,v)=>wset(b,'shape',SHAPE_NUM[v]??0,true) },
  { key:'vol', fmt:v=>Math.round(v*100)+'%', apply:(b,v)=>b.level&&smooth(b.level.gain,v,CFG.UI_TAU) },
  { key:'sharp', fmt:v=>v.toFixed(1), apply:(b,v)=>wset(b,'sharp',v) },
  { key:'driveType', evt:'change', apply:(b,v)=>{ if(b.shaper)b.shaper.curve=b.drive>0.001?makeDriveCurve(b.drive,v):null; }},
  { key:'drive', transform:v=>v/100, fmt:v=>Math.round(v*100)+'%', apply:(b,v)=>{ if(b.shaper)b.shaper.curve=v>0.001?makeDriveCurve(v,b.driveType):null; }},
  { key:'pan', parse:parseInt, transform:v=>v/100, fmt:v=>panLabel(v), apply:(b,v)=>b.panner&&smooth(b.panner.pan,v,CFG.UI_TAU) },
  { key:'dlySend', fmt:v=>Math.round(v*100)+'%', apply:(b,v)=>b.dlySendG&&smooth(b.dlySendG.gain,v,CFG.UI_TAU) },
  { key:'revSend', fmt:v=>Math.round(v*100)+'%', apply:(b,v)=>b.revSendG&&smooth(b.revSendG.gain,v,CFG.UI_TAU) },
  { key:'filterType', evt:'change', apply:(b,v)=>applyFilterType(b.filter,v,b.filterFreq,b.filterQ) },
  { key:'filterFreq', fmt:v=>v+'Hz', apply:(b,v)=>b.filter&&smooth(b.filter.frequency,v,CFG.UI_TAU) },
  { key:'filterQ', fmt:v=>v.toFixed(1), apply:(b,v)=>applyFilterType(b.filter,b.filterType,b.filterFreq,v) },
  { key:'filterLFORate', fmt:v=>v.toFixed(2)+'Hz', apply:(b,v)=>b.filterLFO&&smooth(b.filterLFO.frequency,v,CFG.UI_TAU) },
  { key:'filterLFODepth', fmt:v=>String(v), apply:(b,v)=>{ b.filterLFODepth=v; capPitchLfoDepth(b); if(b.filterLFOGain) smooth(b.filterLFOGain.gain,b.filterLFODepth,CFG.UI_TAU); }},
  { key:'pluckDecay', fmt:v=>v.toFixed(2), apply:(b,v)=>{ if(b.pluckFb) b.pluckFb.gain.value = Math.min(0.98, 0.90 + v); }},
];
function wireBand(b, card) {
  for (const c of BAND_CONTROLS) {
    const el = card.querySelector(`[data-ctl="${c.key}"]`);
    if (!el) continue;
    const valEl = card.querySelector(`[data-val="${c.key}"]`);
    b.ui.controls[c.key] = { el, valEl, ctl: c };
    const commit = () => commitBandParam(b, c, el, valEl);
    el.addEventListener(c.evt || 'change', commit);
    if (el.type === 'number') el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); el.blur(); } });
    if (el.type === 'range' || el.type === 'number') {
      el.addEventListener('click', () => {
        if (!midiLearnActive) return;
        clearMidiArm(); midiArmed = { bandIdx: b._idx, key: c.key }; midiArmedEl = el;
        el.classList.add('midi-armed'); setMidiStatus(`CC? → ${b.name}:${c.key}`);
      });
    }
  }
  const syncBtn = card.querySelector('[data-ctl="bpmSync"]');
  if (syncBtn) {
    syncBtn.setAttribute('aria-pressed', String(b.bpmSync));
    syncBtn.addEventListener('click', () => {
      b.bpmSync = !b.bpmSync;
      syncBtn.setAttribute('aria-pressed', String(b.bpmSync));
      updateBandSyncParams(b);
      b._miniDirty = true;
      b.ui._freq = '';
    });
  }
  const micBtn = card.querySelector('[data-ctl="micSync"]');
  if (micBtn) {
    micBtn.setAttribute('aria-pressed', String(b.micSync || false));
    micBtn.addEventListener('click', () => { b.micSync = !b.micSync; micBtn.setAttribute('aria-pressed', String(b.micSync)); if (b.micSync && !micActive) toggleMicInput(); });
  }
  const flip = () => setBandEnabled(b, !b.enabled);
  b.ui.toggle.addEventListener('click', flip);
  b.ui.toggle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
}

function addBand(customDef, opts = {}) {
  const rebuild = opts.rebuild !== false;
  const i = bands.length;
  if (i >= CFG.MAX_BANDS) return null;
  const targetTotal = Math.max(i + 1, customDef ? i + 1 : CFG.ARC_STREAM_BANDS);
  const baseDef = customDef ? clampBandParams({ ...customDef }) : getBandDefs(Math.min(targetTotal, CFG.MAX_BANDS))[i];
  if (!baseDef) return null;
  const b = {
    ...baseDef, steps: Array.isArray(baseDef.steps) ? baseDef.steps.slice() : euclidPattern(baseDef.hits, STEPS, baseDef.rotate),
    enabled: !!baseDef.enabled, pulseVal: 0, curFreq: baseDef.pLow,
    srcNode: null, pulseGain: null, level: null, shaper: null, filter: null, panner: null,
    filterLFO: null, filterLFOGain: null, worklet: null, _chainId: 0,
    dlySendG: null, revSendG: null, sampleBuf: null, sampleName: '',
    lfoPhaseS: 0, pulsePhaseS: 0, schedUntil: 0, visLfo: 0, visPulse: 0, visT: 0,
    lastTrig: -1, lastStepDur: 0.25, _idx: i, ui: null, _miniDirty: true,
    _curveBuf: new Float32Array(CFG.CURVE_N + 1),
  };
  bands.push(b);
  curvePool.push(b._curveBuf);
  if (rebuild) {
    rebuildCards();
    updateBandCountUI();
    if (isPlaying && b.enabled) startBand(b);
  }
  logParamChange('Band Engine', 'System', 'Add Band', `Added ${b.name}`);
  return b;
}

function readSavedSinkId() {
  try { return localStorage.getItem(AUDIO_SINK_KEY) || ''; } catch (_) { return ''; }
}

function setAudioOutputStatus(text) {
  const el = $('audio-output-status');
  if (el) el.textContent = text;
}

function supportsAudioSinkSelect() {
  return typeof AudioContext !== 'undefined'
    && 'setSinkId' in AudioContext.prototype;
}

async function refreshAudioOutputList() {
  const sel = $('audio-output-select');
  if (!sel) return;
  if (!supportsAudioSinkSelect()) {
    sel.disabled = true;
    setAudioOutputStatus('unsupported');
    return;
  }
  if (!navigator.mediaDevices?.enumerateDevices) {
    sel.disabled = true;
    setAudioOutputStatus('no enum');
    return;
  }
  let outputs = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    outputs = devices.filter((d) => d.kind === 'audiooutput');
  } catch (e) {
    console.warn('enumerateDevices failed:', e);
    setAudioOutputStatus('enum error');
    return;
  }
  const prev = sel.value || selectedSinkId || readSavedSinkId();
  sel.replaceChildren();
  const defOpt = document.createElement('option');
  defOpt.value = '';
  defOpt.textContent = 'System Default';
  sel.appendChild(defOpt);
  outputs.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Output ${i + 1}`;
    sel.appendChild(opt);
  });
  sel.disabled = !audioCtx;
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else sel.value = '';
  const label = sel.selectedOptions[0]?.textContent || 'System Default';
  setAudioOutputStatus(label.length > 28 ? label.slice(0, 27) + '…' : label);
}

async function applyAudioSink(sinkId) {
  selectedSinkId = sinkId || '';
  try { localStorage.setItem(AUDIO_SINK_KEY, selectedSinkId); } catch (_) {}
  const sel = $('audio-output-select');
  if (sel) sel.value = selectedSinkId;
  if (!audioCtx?.setSinkId) {
    setAudioOutputStatus(supportsAudioSinkSelect() ? 'init on play' : 'unsupported');
    return;
  }
  try {
    await audioCtx.setSinkId(selectedSinkId);
    const label = sel?.selectedOptions[0]?.textContent || 'System Default';
    setAudioOutputStatus(label.length > 28 ? label.slice(0, 27) + '…' : label);
    logParamChange('Audio', 'System', 'Output', label);
  } catch (e) {
    console.warn('setSinkId failed:', e);
    setAudioOutputStatus('route failed');
  }
}

async function initAudioOutputRouting() {
  selectedSinkId = readSavedSinkId();
  await refreshAudioOutputList();
  if (selectedSinkId) await applyAudioSink(selectedSinkId);
}

function removeBand(index) {
  if (bands.length <= 1) return;
  const b = bands[index];
  stopBand(b);
  logParamChange('Band Engine', 'System', 'Remove Band', `Removed ${b.name}`);
  bands.splice(index, 1);
  rebuildCards();
  updateBandCountUI();
}

async function ensureAudio() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
    const sel = $('audio-output-select');
    if (sel && supportsAudioSinkSelect()) sel.disabled = false;
    return;
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: latencyMode === 'ambient' ? 'playback' : 'interactive',
  });
  noiseBuffers.white = noiseBuffers.pink = noiseBuffers.brown = null;
  masterGain = audioCtx.createGain();
  masterGain.gain.value = parseFloat($('master-vol').value);
  rampSilenceGain = audioCtx.createGain();
  rampSilenceGain.gain.value = 1;
  compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -12; compressor.knee.value = 10;
  compressor.ratio.value = 6; compressor.attack.value = 0.003; compressor.release.value = 0.15;
  analyser = audioCtx.createAnalyser(); analyser.fftSize = 2048;
  scopeBuf = new Uint8Array(analyser.frequencyBinCount);
  masterGain.connect(rampSilenceGain); rampSilenceGain.connect(compressor);
  compressor.connect(analyser); analyser.connect(audioCtx.destination);
  buildFxBus();
  engineMode = 'scheduler';
  if (audioCtx.audioWorklet) {
    try {
      const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(WORKLET_SRC);
      await Promise.race([
        audioCtx.audioWorklet.addModule(dataUrl),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CFG.WORKLET_TIMEOUT)),
      ]);
      engineMode = 'worklet';
    } catch (e) { console.warn('Worklet fallback:', e.message); engineMode = 'scheduler'; }
  }
  updateSysUI();
  await initAudioOutputRouting();
}
function buildFxBus() {
  dlyBus = audioCtx.createGain();
  dlyL = audioCtx.createDelay(CFG.DELAY_MAX); dlyR = audioCtx.createDelay(CFG.DELAY_MAX);
  dampL = audioCtx.createBiquadFilter(); dampL.type = 'lowpass'; dampL.Q.value = 0.5;
  dampR = audioCtx.createBiquadFilter(); dampR.type = 'lowpass'; dampR.Q.value = 0.5;
  fbGainL = audioCtx.createGain(); fbGainR = audioCtx.createGain();
  dlyWetL = audioCtx.createGain(); dlyWetR = audioCtx.createGain();
  dlyBus.connect(dlyL); dlyL.connect(dampL); dampL.connect(fbGainL); fbGainL.connect(dlyR);
  dlyR.connect(dampR); dampR.connect(fbGainR); fbGainR.connect(dlyL);
  dlyL.connect(dlyWetL); dlyWetL.connect(masterGain);
  dlyR.connect(dlyWetR); dlyWetR.connect(masterGain);
  revBus = audioCtx.createGain(); convolver = audioCtx.createConvolver(); revWet = audioCtx.createGain();
  revBus.connect(convolver); convolver.connect(revWet); revWet.connect(masterGain);
  applyFxState();
}
function applyFxState() {
  const t = audioCtx.currentTime;
  const fb = Math.min(fxState.feedback, CFG.FB_MAX);
  setDelayTime();
  fbGainL.gain.setTargetAtTime(fb, t, CFG.UI_TAU);
  fbGainR.gain.setTargetAtTime(fb, t, CFG.UI_TAU);
  dampL.frequency.setTargetAtTime(fxState.damp, t, CFG.UI_TAU);
  dampR.frequency.setTargetAtTime(fxState.damp, t, CFG.UI_TAU);
  dlyWetL.gain.setTargetAtTime(fxState.dlyReturn, t, CFG.UI_TAU);
  dlyWetR.gain.setTargetAtTime(fxState.dlyReturn, t, CFG.UI_TAU);
  revWet.gain.setTargetAtTime(fxState.revReturn, t, CFG.UI_TAU);
  convolver.buffer = makeImpulse(fxState.revPreset);
  updateFxReadouts(); updateFxLeds();
}
function setDelayTime() {
  const dt = Math.min((60 / Math.max(1, fxState.tempo)) * fxState.subdiv, CFG.DELAY_MAX - 0.05);
  if (dlyL && audioCtx) {
    const t = audioCtx.currentTime;
    dlyL.delayTime.setTargetAtTime(dt, t, CFG.DELAY_TAU);
    dlyR.delayTime.setTargetAtTime(dt, t, CFG.DELAY_TAU);
  }
  $('fx-delay-ms').textContent = Math.round(dt * 1000) + ' ms';
}
function makeImpulse(key, ctxArg) {
  const c = ctxArg || audioCtx;
  const p = REVERB_PRESETS[key] || REVERB_PRESETS.hall;
  const rate = c.sampleRate, len = Math.max(2, Math.floor(p.dur * rate));
  const buf = c.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch); let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len, n = Math.random() * 2 - 1;
      lp += p.damp * (n - lp);
      d[i] = lp * Math.pow(1 - t, p.pow) * Math.exp(-1.5 * t);
    }
  }
  return buf;
}
function updateFxReadouts() { $('fx-rev-tail').textContent = (REVERB_PRESETS[fxState.revPreset]||REVERB_PRESETS.hall).dur.toFixed(1) + ' s'; }
function updateFxLeds() {
  $('fx-led-dly').classList.toggle('on', fxState.dlyReturn > 0.001);
  $('fx-led-rev').classList.toggle('on', fxState.revReturn > 0.001);
}
function bindRange(id, valId, fmt, apply) {
  const el = $(id), val = $(valId);
  if (!el) return;
  const run = () => {
    const v = parseFloat(el.value);
    if (!Number.isFinite(v)) return;
    if (val) val.textContent = fmt(v);
    apply(v);
  };
  el.addEventListener('input', run);
  el.addEventListener('change', run);
}
function wireFx() {
  $('fx-subdiv').addEventListener('change', e => { fxState.subdiv = parseFloat(e.target.value); setDelayTime(); });
  bindRange('fx-feedback','fx-feedback-val', v=>Math.round(v)+'%', v => {
    fxState.feedback = Math.min(v/100, CFG.FB_MAX);
    if (fbGainL) { const t=audioCtx.currentTime; fbGainL.gain.setTargetAtTime(fxState.feedback,t,CFG.UI_TAU); fbGainR.gain.setTargetAtTime(fxState.feedback,t,CFG.UI_TAU); }
  });
  bindRange('fx-damp','fx-damp-val', v=>v>=1000?(v/1000).toFixed(1)+'k':String(Math.round(v)), v => {
    fxState.damp = v;
    if (dampL) { const t=audioCtx.currentTime; dampL.frequency.setTargetAtTime(v,t,CFG.UI_TAU); dampR.frequency.setTargetAtTime(v,t,CFG.UI_TAU); }
  });
  bindRange('fx-dly-ret','fx-dly-ret-val', v=>Math.round(v)+'%', v => {
    fxState.dlyReturn = v/100;
    if (dlyWetL) { const t=audioCtx.currentTime; dlyWetL.gain.setTargetAtTime(fxState.dlyReturn,t,CFG.UI_TAU); dlyWetR.gain.setTargetAtTime(fxState.dlyReturn,t,CFG.UI_TAU); }
    updateFxLeds();
  });
  $('fx-rev-preset').addEventListener('change', e => { fxState.revPreset = e.target.value; if (convolver) convolver.buffer = makeImpulse(fxState.revPreset); updateFxReadouts(); });
  bindRange('fx-rev-ret','fx-rev-ret-val', v=>Math.round(v)+'%', v => {
    fxState.revReturn = v/100;
    if (revWet) revWet.gain.setTargetAtTime(fxState.revReturn, audioCtx.currentTime, CFG.UI_TAU);
    updateFxLeds();
  });
}

function buildTransportGrid() {
  const grid = $('tr-grid');
  grid.replaceChildren();
  transportCells.length = 0;
  for (let i = 0; i < STEPS; i++) {
    const cell = document.createElement('div');
    cell.className = 'tr-cell' + (i % 4 === 0 ? ' beat' : '');
    grid.appendChild(cell); transportCells.push(cell);
  }
}
function clampTempo(v) {
  return Math.max(CFG.TEMPO_MIN, Math.min(CFG.TEMPO_MAX, v));
}
function getSubLenRange() {
  if (rampState.subLen === 'short') return { minD: 1.0, maxD: 3.0 };
  if (rampState.subLen === 'medium') return { minD: 3.0, maxD: 7.0 };
  if (rampState.subLen === 'long') return { minD: 6.0, maxD: 14.0 };
  if (rampState.subLen === 'chaos') return { minD: 0.5, maxD: 2.5 };
  return { minD: 1.0, maxD: 8.0 };
}
function randPhaseDuration(minD, maxD) {
  return minD + Math.random() * Math.max(0.05, maxD - minD);
}
function pickMacroPhases() {
  const { minD, maxD } = getSubLenRange();
  const silMin = rampState.silenceGapMin ?? 0.5;
  const silMax = Math.max(silMin + 0.1, rampState.silenceGapMax ?? 3.0);
  const cores = [
    ['up', randPhaseDuration(minD, maxD)],
    ['down', randPhaseDuration(minD, maxD)],
    ['silence', randPhaseDuration(silMin, silMax)],
  ];
  for (let i = cores.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cores[i], cores[j]] = [cores[j], cores[i]];
  }
  if (Math.random() < 0.45) {
    const extra = Math.random() < 0.5 ? 'up' : 'down';
    cores.splice(1 + Math.floor(Math.random() * cores.length), 0, [extra, randPhaseDuration(minD, maxD * 0.6)]);
  }
  if (Math.random() < 0.25) {
    cores.push(['silence', randPhaseDuration(silMin * 0.5, silMax * 0.75)]);
  }
  return cores;
}
function getMacroPhaseAt(nowTime) {
  if (!rampState.macroPhases?.length) {
    rampState.macroPhaseStart = nowTime;
    rampState.macroPhases = pickMacroPhases();
  }
  let elapsed = nowTime - rampState.macroPhaseStart;
  let acc = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < rampState.macroPhases.length; i++) {
      const [type, dur] = rampState.macroPhases[i];
      if (elapsed < acc + dur) {
        return { type, localT: elapsed - acc, dur, idx: i };
      }
      acc += dur;
    }
    rampState.macroPhaseStart = nowTime - (elapsed - acc);
    rampState.macroPhases = pickMacroPhases();
    elapsed = nowTime - rampState.macroPhaseStart;
    acc = 0;
  }
  return { type: 'up', localT: 0, dur: 1, idx: 0 };
}
function syncBandPaletteUI(b) {
  if (!b.ui) return;
  for (const c of BAND_CONTROLS) {
    const ctrl = b.ui.controls?.[c.key];
    if (!ctrl?.el) continue;
    let uiVal = b[c.key];
    if (c.key === 'drive') uiVal = Math.round(b.drive * 100);
    else if (c.key === 'pan') uiVal = Math.round(b.pan * 100);
    ctrl.el.value = uiVal;
    if (ctrl.valEl && c.fmt) ctrl.valEl.textContent = c.fmt(b[c.key]);
  }
  if (b.ui.sourceSel) {
    if (b.source === 'smp' && !b.sampleBuf) b.source = 'osc';
    b.ui.sourceSel.value = b.source;
  }
  if (b.ui.fmBody) b.ui.fmBody.classList.toggle('hidden', b.source !== 'fm');
  const seq = b.mode === 'seq';
  if (b.ui.modeToggle) {
    b.ui.modeToggle.setAttribute('aria-checked', String(seq));
    b.ui.modeToggle.classList.toggle('on', seq);
  }
  if (b.ui.seqBody) b.ui.seqBody.classList.toggle('hidden', !seq);
  if (b.ui.gridCells?.length) {
    for (let k = 0; k < STEPS; k++) b.ui.gridCells[k]?.classList.toggle('on', !!b.steps[k]);
  }
  const hitsEl = b.ui.seqBody?.querySelector('[data-rctl="hits"]');
  const rotEl = b.ui.seqBody?.querySelector('[data-rctl="rotate"]');
  if (hitsEl) {
    hitsEl.value = b.hits;
    const hv = b.ui.seqBody?.querySelector('[data-rval="hits"]');
    if (hv) hv.textContent = b.hits;
  }
  if (rotEl) {
    rotEl.value = b.rotate;
    const rv = b.ui.seqBody?.querySelector('[data-rval="rotate"]');
    if (rv) rv.textContent = b.rotate;
  }
}
function applyBandPaletteParams(b, params, opts = {}) {
  if (!params) return false;
  const silent = opts.silent === true;
  let needsRestart = false;
  const next = { ...params };
  if (next.source === 'smp' && !b.sampleBuf) next.source = 'osc';
  if (next.source != null && next.source !== b.source) needsRestart = true;
  if (next.binauralOffset != null && Math.abs(next.binauralOffset - (b.binauralOffset || 0)) > 0.01) needsRestart = true;
  for (const key of ARC_PALETTE_KEYS) {
    if (next[key] !== undefined) b[key] = next[key];
  }
  if (b.mode === 'seq') b.steps = euclidPattern(b.hits, STEPS, b.rotate);
  if (!silent) syncBandPaletteUI(b);
  for (const key of ARC_PALETTE_KEYS) {
    if (next[key] === undefined) continue;
    const c = BAND_CONTROLS.find((x) => x.key === key);
    if (c?.apply) c.apply(b, b[key]);
  }
  if (next.filterType != null || next.filterFreq != null || next.filterQ != null) {
    if (b.filter) applyFilterType(b.filter, b.filterType, b.filterFreq, b.filterQ);
  }
  if (next.lfoTarget != null) connectLFOTarget(b);
  if (!silent && next.mode != null && (b.mode === 'seq') !== (next.mode === 'seq')) setBandMode(b, next.mode === 'seq');
  else if (!silent && (next.hits != null || next.rotate != null)) {
    b.steps = euclidPattern(b.hits, STEPS, b.rotate);
    syncBandPaletteUI(b);
  }
  updateBandSyncParams(b);
  b._miniDirty = true;
  if (b.ui) b.ui._freq = '';
  if (needsRestart && isPlaying && b.enabled) restartBand(b);
  return needsRestart;
}
/** Lightweight morph apply — audio params only, no restarts or UI sync. */
function applyBandMorphParams(b, params) {
  if (!params || !Object.keys(params).length) return;
  for (const key of ARC_MORPH_KEYS) {
    if (params[key] === undefined) continue;
    b[key] = params[key];
    const c = BAND_CONTROLS.find((x) => x.key === key);
    if (c?.apply) c.apply(b, params[key]);
  }
  if (params.drive != null && b.shaper) {
    b.shaper.curve = b.drive > 0.001 ? makeDriveCurve(b.drive, b.driveType) : null;
  }
}
function snapshotArcSessionBaseline() {
  arcPaletteBaseline = bands.map((b) => {
    const snap = { enabled: b.enabled };
    for (const k of ARC_PALETTE_KEYS) snap[k] = b[k];
    snap.steps = b.steps.slice();
    return snap;
  });
  arcFxBaseline = {
    feedback: fxState.feedback,
    damp: fxState.damp,
    dlyReturn: fxState.dlyReturn,
    revReturn: fxState.revReturn,
    revPreset: fxState.revPreset,
  };
}
function applyArcFxMorph(target, u) {
  if (!target || !arcFxBaseline || !audioCtx) return;
  const morphed = lerpFxSnapshot(arcFxBaseline, target, u);
  const t = audioCtx.currentTime;
  for (const key of ARC_FX_MORPH_KEYS) {
    if (morphed[key] == null) continue;
    fxState[key] = morphed[key];
  }
  const fb = Math.min(fxState.feedback, CFG.FB_MAX);
  if (fbGainL) { fbGainL.gain.setTargetAtTime(fb, t, CFG.UI_TAU); fbGainR.gain.setTargetAtTime(fb, t, CFG.UI_TAU); }
  if (dampL) { dampL.frequency.setTargetAtTime(fxState.damp, t, CFG.UI_TAU); dampR.frequency.setTargetAtTime(fxState.damp, t, CFG.UI_TAU); }
  if (dlyWetL) { dlyWetL.gain.setTargetAtTime(fxState.dlyReturn, t, CFG.UI_TAU); dlyWetR.gain.setTargetAtTime(fxState.dlyReturn, t, CFG.UI_TAU); }
  if (revWet) revWet.gain.setTargetAtTime(fxState.revReturn, t, CFG.UI_TAU);
  const wantPreset = morphed.revPreset;
  if (wantPreset && wantPreset !== fxState.revPreset && u >= 0.5) {
    if (arcStream?._fxPresetApplied !== wantPreset) {
      fxState.revPreset = wantPreset;
      if (convolver) convolver.buffer = makeImpulse(fxState.revPreset);
      if (arcStream) arcStream._fxPresetApplied = wantPreset;
      updateFxReadouts();
    }
  }
}
function applyArcMorph(arc, progress) {
  if (rampState.arcMorph === false || !arc?.palette?.patches?.length || !arcPaletteBaseline) return;
  const u = sampleArcMorph(arc, progress);
  if (arcStream && Math.abs(u - (arcStream.lastMorphU ?? -1)) < CFG.ARC_MORPH_STEP) return;
  if (arcStream) arcStream.lastMorphU = u;
  for (const patch of arc.palette.patches) {
    const b = bands[patch.bandIndex];
    const snap = arcPaletteBaseline[patch.bandIndex];
    if (!b || !snap) continue;
    const morphed = {};
    for (const key of ARC_MORPH_KEYS) {
      if (patch.params[key] === undefined) continue;
      const from = snap[key];
      const to = patch.params[key];
      if (typeof from === 'number' && typeof to === 'number') {
        morphed[key] = from + (to - from) * u;
      }
    }
    if (Object.keys(morphed).length) applyBandMorphParams(b, morphed);
  }
  if (arc.fxSnapshot) applyArcFxMorph(arc.fxSnapshot, u);
}
function updateArcOrchestrationUI(indices) {
  for (let i = 0; i < bands.length; i++) {
    const card = bands[i].ui?.card;
    if (card) card.classList.toggle('arc-spotlight', !!(indices && indices.includes(i)));
  }
}
function applyArcOrchestration(arc) {
  if (!rampState.arcOrchestration) return;
  const indices = arc?.orchestration?.enableIndices;
  if (!indices?.length) return;
  const enableSet = new Set(indices);
  for (let i = 0; i < bands.length; i++) {
    const want = enableSet.has(i);
    if (bands[i].enabled !== want) setBandEnabled(bands[i], want);
  }
  updateArcOrchestrationUI(indices);
}
function restoreArcSessionBaseline() {
  if (!arcPaletteBaseline) return;
  for (let i = 0; i < bands.length; i++) {
    const snap = arcPaletteBaseline[i];
    const b = bands[i];
    if (!snap || !b) continue;
    if (b.enabled !== !!snap.enabled) setBandEnabled(b, !!snap.enabled);
    const params = {};
    for (const k of ARC_PALETTE_KEYS) params[k] = snap[k];
    applyBandPaletteParams(b, params);
    b.steps = snap.steps.slice();
    syncBandPaletteUI(b);
  }
  if (arcFxBaseline) {
    Object.assign(fxState, arcFxBaseline);
    if (audioCtx) {
      const t = audioCtx.currentTime;
      const fb = Math.min(fxState.feedback, CFG.FB_MAX);
      if (fbGainL) { fbGainL.gain.setTargetAtTime(fb, t, CFG.UI_TAU); fbGainR.gain.setTargetAtTime(fb, t, CFG.UI_TAU); }
      if (dampL) { dampL.frequency.setTargetAtTime(fxState.damp, t, CFG.UI_TAU); dampR.frequency.setTargetAtTime(fxState.damp, t, CFG.UI_TAU); }
      if (dlyWetL) { dlyWetL.gain.setTargetAtTime(fxState.dlyReturn, t, CFG.UI_TAU); dlyWetR.gain.setTargetAtTime(fxState.dlyReturn, t, CFG.UI_TAU); }
      if (revWet) revWet.gain.setTargetAtTime(fxState.revReturn, t, CFG.UI_TAU);
      if (convolver) convolver.buffer = makeImpulse(fxState.revPreset);
      updateFxReadouts();
    }
  }
  updateArcOrchestrationUI(null);
}
function clearArcPaletteSession() {
  restoreArcSessionBaseline();
  arcPaletteBaseline = null;
  arcFxBaseline = null;
  if (arcStream) arcStream.sessionAppliedIndex = -1;
}
function applyArcPalette(arc) {
  if (!arc?.palette?.patches?.length) return;
  const discreteOnly = rampState.arcMorph !== false;
  const touched = [];
  for (const patch of arc.palette.patches) {
    const b = bands[patch.bandIndex];
    if (!b) continue;
    const params = {};
    for (const key of ARC_PALETTE_KEYS) {
      if (patch.params[key] === undefined) continue;
      if (discreteOnly && ARC_MORPH_KEYS.includes(key)) continue;
      params[key] = patch.params[key];
    }
    if (Object.keys(params).length) applyBandPaletteParams(b, params);
    touched.push(b.name);
  }
  if (touched.length) logParamChange('Arc Palette', arc.name, arc.palette.label, touched.join(', '));
}
function renderArcQueuePreview() {
  const wrap = $('arc-queue-preview');
  const list = $('arc-queue-list');
  if (!wrap || !list) return;
  const show = arcStream && rampState.mode === 'arc-stream';
  wrap.hidden = !show;
  if (!show) return;
  list.replaceChildren();
  const items = arcStream.queue.slice(arcStream.index, arcStream.index + 8);
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = `arc-queue-item ${item.type}${i === 0 ? ' current' : ''}`;
    const dur = item.duration != null ? `${item.duration.toFixed(1)}s` : '';
    if (item.type === 'arc') {
      li.textContent = i === 0 ? `▶ ${item.name}` : item.name;
      li.title = `${item.bpmLo}–${item.bpmHi} BPM · ${dur}`;
    } else {
      li.textContent = item.name || 'Gap';
      li.title = dur;
    }
    list.appendChild(li);
  });
}
function restartArcStream() {
  ensureArcStreamBands();
  if (rampState.mode === 'arc-stream' && !arcPaletteBaseline) snapshotArcSessionBaseline();
  arcStream = createArcStream(rampState.arcGapProfile || 'mixed', rampState.arcIntensity || 'dramatic', bands.length);
  if (arcStream) {
    arcStream.phaseStart = 0;
    arcStream.sessionAppliedIndex = -1;
    arcStream.lastMorphU = -1;
    arcStream._fxPresetApplied = null;
  }
  renderArcQueuePreview();
}
function setArcStreamUI(on) {
  const manual = $('ramp-manual-fields');
  const auto = $('ramp-arc-fields');
  if (manual) manual.classList.toggle('arc-muted', on);
  if (auto) auto.hidden = !on;
  if ($('arc-stream-toggle')) $('arc-stream-toggle').setAttribute('aria-pressed', String(on));
}
function applyRampExaggeration(currentBpm, exaggerateMode, depth, bpmLo, bpmHi, bandBias = null) {
  const mode = exaggerateMode || 'off';
  if (mode === 'off' || depth <= 0 || !audioCtx || !isPlaying) return;
  const minB = bpmLo ?? Math.min(rampState.startBpm, rampState.endBpm);
  const maxB = bpmHi ?? Math.max(rampState.startBpm, rampState.endBpm);
  const range = Math.max(1, maxB - minB);
  const E = Math.max(0, Math.min(1, (maxB - currentBpm) / range)) * depth;
  const bpmNorm = (currentBpm - CFG.TEMPO_MIN) / Math.max(1, CFG.TEMPO_MAX - CFG.TEMPO_MIN);
  const total = bands.length;
  for (let i = 0; i < total; i++) {
    const b = bands[i];
    const bandNorm = total > 1 ? i / (total - 1) : 0.5;
    let levelMult = 1;
    if ((mode === 'bands' || mode === 'combo') && b.level?.gain) {
      let dist = Math.abs(bpmNorm - bandNorm);
      if (bandBias != null) dist += Math.abs(bandNorm - bandBias) * 0.65;
      levelMult *= Math.max(0.03, 1 - dist * (1.8 + depth * 2.2));
    }
    if ((mode === 'thin' || mode === 'combo') && b.level?.gain) {
      const thresh = (total - 1 - i) / total;
      levelMult *= E > thresh ? Math.max(0, 1 - (E - thresh) * total) : 1;
    }
    if ((mode === 'thin' || mode === 'bands' || mode === 'combo') && b.level?.gain) {
      smooth(b.level.gain, b.vol * levelMult, CFG.UI_TAU);
    }
    if ((mode === 'sparse' || mode === 'combo') && b.mode === 'seq') {
      const sparse = Math.max(1, Math.round((b.hits || 5) * (1 - E * 0.75)));
      if (b._curSparse !== sparse) {
        b._curSparse = sparse;
        b.steps = euclidPattern(sparse, STEPS, b.rotate);
        if (b.ui?.gridCells) for (let k = 0; k < STEPS; k++) b.ui.gridCells[k].classList.toggle('on', !!b.steps[k]);
      }
    }
    if ((mode === 'vinyl' || mode === 'combo') && b.srcNode && b.source === 'osc') {
      smoothOsc(b.srcNode.frequency, b.carrier * Math.max(0.2, 1 - E * 0.6), CFG.UI_TAU);
    }
  }
}
function updateArcStream(nowTime) {
  if (!arcStream) restartArcStream();
  refillArcQueue(arcStream);
  const item = arcStream.queue[arcStream.index];
  if (!item) return;
  if (item.type === 'arc') {
    if (arcStream.sessionAppliedIndex !== arcStream.index) {
      if (rampState.arcOrchestration) applyArcOrchestration(item);
      applyArcPalette(item);
      const orch = item.orchestration;
      if (orch?.enableIndices?.length && rampState.arcOrchestration) {
        logParamChange('Arc Orchestration', item.name, orch.label, `${orch.enableIndices.length} bands`);
      }
      arcStream.sessionAppliedIndex = arcStream.index;
      arcStream.lastMorphU = -1;
      arcStream._fxPresetApplied = null;
    }
  } else if (arcStream.sessionAppliedIndex !== -1) {
    restoreArcSessionBaseline();
    arcStream.sessionAppliedIndex = -1;
  }
  if (!arcStream.phaseStart) arcStream.phaseStart = nowTime;
  const elapsed = nowTime - arcStream.phaseStart;
  if (elapsed >= item.duration) {
    if (item.type === 'arc') {
      arcStream.arcsCompleted++;
      rampState.totalLoopsCompleted++;
      if (rampState.variationsEnabled && arcStream.arcsCompleted % (rampState.varInterval || 2) === 0) {
        triggerMusicalVariation();
      }
    }
    arcStream.index++;
    compactArcQueue(arcStream);
    arcStream.phaseStart = nowTime;
    logParamChange('Arc Stream', 'Transport', item.type === 'gap' ? 'Gap' : 'Arc', item.name);
    return updateArcStream(nowTime);
  }
  const progress = item.duration > 0 ? elapsed / item.duration : 0;
  const bar = $('ramp-progress-bar');
  const st = $('ramp-status-text');
  const arcSt = $('arc-status-text');
  if (item.type === 'gap') {
    setRampSilence(true);
    if (bar) bar.style.width = (progress * 100).toFixed(1) + '%';
    if (st) st.textContent = `⏸ ${(item.duration - elapsed).toFixed(1)}s`;
    if (arcSt) arcSt.textContent = `${item.name} · next arc queued`;
    renderArcQueuePreview();
    return;
  }
  setRampSilence(false);
  const bpmVal = sampleArcBpm(item, progress);
  const wobble = Math.sin(nowTime * 5.5) * (item.jitter / 100) * 3;
  const currentBpm = clampTempo(Math.round(bpmVal + wobble));
  rampState.currentBpmFloat = currentBpm;
  rampState.startBpm = Math.round(item.bpmLo);
  rampState.endBpm = Math.round(item.bpmHi);
  if (Math.abs(fxState.tempo - currentBpm) >= 0.5) {
    onTempoChange(currentBpm);
    $('tr-tempo').value = currentBpm;
    $('tr-tempo-val').textContent = currentBpm + ' BPM';
  }
  applyRampExaggeration(currentBpm, item.exaggerate, item.depth, item.bpmLo, item.bpmHi, item.bandBias);
  if (rampState.arcMorph !== false) applyArcMorph(item, progress);
  if (bar) bar.style.width = (progress * 100).toFixed(1) + '%';
  if (st) st.textContent = `◆ ${currentBpm}`;
  if (arcSt) {
    const orch = item.orchestration;
    const orchNote = rampState.arcOrchestration && orch?.enableIndices?.length
      ? ` · ${orch.enableIndices.length} bands`
      : '';
    arcSt.textContent = `${item.name}${item.palette?.label ? ' · ' + item.palette.label : ''}${orchNote}`;
  }
  if ($('ramp-start-val')) $('ramp-start-val').textContent = rampState.startBpm + ' BPM';
  if ($('ramp-end-val')) $('ramp-end-val').textContent = rampState.endBpm + ' BPM';
  renderArcQueuePreview();
}
function setRampSilence(on) {
  if (rampState.inSilence === on) return;
  rampState.inSilence = on;
  if (rampSilenceGain && audioCtx) smooth(rampSilenceGain.gain, on ? 0 : 1, on ? 0.04 : 0.08);
}
function onTempoChange(v) {
  v = clampTempo(v);
  const old = fxState.tempo; fxState.tempo = v; setDelayTime();
  if (transport.running && audioCtx && old !== v) {
    const now = audioCtx.currentTime;
    const oldSD = (60/old)/4, newSD = (60/v)/4;
    transport.anchorTime = now - ((now - transport.anchorTime) / oldSD) * newSD;
  }
  for (let i = 0; i < bands.length; i++) {
    if (bands[i].bpmSync) updateBandSyncParams(bands[i]);
    if (bands[i].ui) bands[i].ui._freq = '';
  }
}
function setRampEnabled(on) {
  rampState.enabled = on;
  rampState.startTime = audioCtx ? audioCtx.currentTime : performance.now()/1000;
  rampState.lastLoopIndex = -1; rampState.totalLoopsCompleted = 0;
  rampState.segStartTime = 0;
  rampState.macroPhaseStart = 0;
  rampState.macroPhases = null;
  rampState.currentBpmFloat = rampState.startBpm;
  if (on && rampState.mode === 'arc-stream') restartArcStream();
  else if (!on) {
    clearArcPaletteSession();
    arcStream = null;
  }
  if (!on) setRampSilence(false);
  setArcStreamUI(on && rampState.mode === 'arc-stream');
  $('ramp-toggle').setAttribute('aria-pressed', String(on));
  if (!on) { $('ramp-progress-bar').style.width = '0%'; $('ramp-status-text').textContent = 'OFF'; if ($('arc-status-text')) $('arc-status-text').textContent = 'idle'; }
  logParamChange('BPM Ramp', 'Transport', 'Toggle', on ? 'Active' : 'Off');
}
function triggerMusicalVariation() {
  const count = Math.min(rampState.varCount || 3, bands.length);
  const paramKeys = ['pLow','pHigh','dur','carrier','filterFreq','pan','vol','hits'];
  for (let i = 0; i < count; i++) {
    const b = bands[Math.floor(Math.random() * bands.length)];
    const key = paramKeys[Math.floor(Math.random() * paramKeys.length)];
    const oldVal = b[key];
    let newVal = oldVal;
    if (key === 'pan') newVal = Math.max(-1, Math.min(1, oldVal + (Math.random()-0.5)*0.4));
    else if (key === 'vol') newVal = Math.max(0.05, Math.min(1, oldVal + (Math.random()-0.5)*0.2));
    else if (key === 'hits') newVal = Math.max(1, Math.min(16, Math.round(oldVal + (Math.random()-0.5)*4)));
    else if (key === 'carrier') newVal = Math.max(20, Math.min(20000, oldVal * (0.8 + Math.random()*0.4)));
    else if (key === 'filterFreq') newVal = Math.max(20, Math.min(20000, oldVal * (0.7 + Math.random()*0.6)));
    else newVal = Math.max(0.1, oldVal * (0.7 + Math.random()*0.6));
    b[key] = newVal;
    if (key === 'hits') b.steps = euclidPattern(b.hits, STEPS, b.rotate);
    b._miniDirty = true;
    logParamChange('Var Engine', b.name, key, `${typeof oldVal==='number'?oldVal.toFixed(2):oldVal} → ${typeof newVal==='number'?newVal.toFixed(2):newVal}`);
  }
  $('var-status-text').textContent = `Var: Loop #${rampState.totalLoopsCompleted}`;
}
function advanceDynamicRampSegment(nowTime, macroProgress, phaseHint) {
  rampState.segStartTime = nowTime;
  const { minD, maxD } = getSubLenRange();
  rampState.segDuration = randPhaseDuration(minD, maxD);
  const currentActual = rampState.currentBpmFloat || rampState.startBpm;
  rampState.segStartBpm = currentActual;
  const bpmHigh = Math.max(rampState.startBpm, rampState.endBpm);
  const bpmLow = Math.min(rampState.startBpm, rampState.endBpm);
  const macroDur = Math.max(1, rampState.duration);
  const nextProgress = Math.min(1, macroProgress + rampState.segDuration / macroDur);
  let baseTarget = rampState.startBpm + (rampState.endBpm - rampState.startBpm) * nextProgress;
  if (phaseHint === 'up') baseTarget = bpmLow + (bpmHigh - bpmLow) * (0.35 + Math.random() * 0.65);
  else if (phaseHint === 'down') baseTarget = bpmHigh - (bpmHigh - bpmLow) * (0.35 + Math.random() * 0.65);
  const jScale = ((rampState.jitter !== undefined ? rampState.jitter : 40) / 100);
  const trendDir = phaseHint === 'up' ? 1 : phaseHint === 'down' ? -1 : (Math.sign(rampState.endBpm - rampState.startBpm) || -1);
  const randOffset = (Math.random() - 0.35) * 60 * jScale * trendDir;
  rampState.segEndBpm = clampTempo(baseTarget + randOffset);
  const curves = ['linear', 'sine', 'exp', 'bounce'];
  rampState.segCurveType = curves[Math.floor(Math.random() * curves.length)];
}

function updateTempoRamp(nowTime) {
  if (!rampState.enabled) return;
  if (rampState.mode === 'arc-stream') {
    updateArcStream(nowTime);
    return;
  }
  if (!rampState.startTime) rampState.startTime = nowTime;
  const elapsed = nowTime - rampState.startTime;
  const dur = Math.max(0.1, rampState.duration);
  let progress = 0, dir = 1;
  let phaseHint = null;
  if (rampState.mode === 'pulse-wave') {
    const phase = getMacroPhaseAt(nowTime);
    rampState.macroPhase = phase.type;
    phaseHint = phase.type === 'silence' ? null : phase.type;
    progress = phase.dur > 0 ? phase.localT / phase.dur : 0;
    dir = phase.type === 'up' ? 1 : phase.type === 'down' ? -1 : 0;
    setRampSilence(phase.type === 'silence');
    if (phase.type === 'silence') {
      const bar = $('ramp-progress-bar'), st = $('ramp-status-text');
      if (bar) bar.style.width = (progress * 100).toFixed(1) + '%';
      if (st) st.textContent = `⏸ gap ${(phase.dur - phase.localT).toFixed(1)}s`;
      return;
    }
  } else {
    setRampSilence(false);
  }
  if (rampState.loop) {
    if (rampState.mode === 'pingpong') {
      const cycle = (elapsed / dur) % 2;
      progress = cycle <= 1 ? cycle : 2 - cycle;
      dir = cycle <= 1 ? 1 : -1;
    } else if (rampState.mode === 'sawtooth') {
      progress = (elapsed / dur) % 1; dir = 1;
    } else if (rampState.mode !== 'pulse-wave') {
      progress = (elapsed / dur) % 1;
      dir = rampState.endBpm >= rampState.startBpm ? 1 : -1;
    }
    const currentPass = Math.floor(elapsed / dur);
    if (currentPass !== rampState.lastLoopIndex) {
      rampState.lastLoopIndex = currentPass;
      rampState.totalLoopsCompleted++;
      rampState.segStartTime = 0;
      if (rampState.mode === 'pulse-wave') {
        rampState.macroPhaseStart = 0;
        rampState.macroPhases = null;
      }
      if (rampState.variationsEnabled && rampState.totalLoopsCompleted % (rampState.varInterval || 2) === 0) {
        triggerMusicalVariation();
      }
    }
  } else {
    progress = Math.min(1, elapsed / dur);
    dir = progress < 1 ? (rampState.endBpm >= rampState.startBpm ? 1 : -1) : 0;
  }
  let currentBpm = rampState.startBpm;
  if (rampState.mode === 'pingpong' || rampState.mode === 'sawtooth') {
    currentBpm = clampTempo(Math.round(rampState.startBpm + (rampState.endBpm - rampState.startBpm) * progress));
  } else {
    if (!rampState.segStartTime || (nowTime - rampState.segStartTime) >= rampState.segDuration) {
      advanceDynamicRampSegment(nowTime, progress, phaseHint);
    }
    const segElapsed = nowTime - rampState.segStartTime;
    const u = Math.max(0, Math.min(1, segElapsed / Math.max(0.01, rampState.segDuration)));
    let uCurved = u;
    if (rampState.segCurveType === 'sine') uCurved = 0.5 - 0.5 * Math.cos(u * Math.PI);
    else if (rampState.segCurveType === 'exp') uCurved = u * u;
    else if (rampState.segCurveType === 'bounce') uCurved = u + 0.12 * Math.sin(u * Math.PI * 2);
    let bpmVal = rampState.segStartBpm + (rampState.segEndBpm - rampState.segStartBpm) * uCurved;
    if (rampState.mode === 'stochastic') bpmVal += (Math.random() - 0.5) * ((rampState.jitter || 40) / 100) * 25;
    rampState.currentBpmFloat = bpmVal;
    const microWobble = Math.sin(nowTime * 6) * ((rampState.jitter || 40) / 100) * 2.5;
    currentBpm = clampTempo(Math.round(bpmVal + microWobble));
  }
  if (Math.abs(fxState.tempo - currentBpm) >= 0.5) {
    onTempoChange(currentBpm);
    $('tr-tempo').value = currentBpm;
    $('tr-tempo-val').textContent = currentBpm + ' BPM';
  }
  const mode = rampState.exaggerateMode || 'off';
  const depth = rampState.exaggerateDepth || 0;
  applyRampExaggeration(currentBpm, mode, depth);
  const bar = $('ramp-progress-bar'), st = $('ramp-status-text');
  if (bar) bar.style.width = (progress * 100).toFixed(1) + '%';
  if (st) {
    let modeSymbol = '▶';
    if (rampState.mode === 'pingpong') modeSymbol = (rampState.endBpm >= rampState.startBpm ? dir > 0 : dir < 0) ? '▲' : '▼';
    else if (rampState.mode === 'pulse-wave') modeSymbol = dir > 0 ? '▲' : dir < 0 ? '▼' : '⏸';
    else if (rampState.mode === 'micro-loops' || rampState.mode === 'dynamic') modeSymbol = '🔀';
    else if (rampState.mode === 'stochastic') modeSymbol = '🎲';
    else if (rampState.mode === 'arc-stream') modeSymbol = '◆';
    st.textContent = `${modeSymbol} ${currentBpm}`;
  }
}
function syncRampUI() {
  $('ramp-toggle').setAttribute('aria-pressed', String(rampState.enabled));
  $('ramp-start').value = rampState.startBpm; $('ramp-start-val').textContent = rampState.startBpm + ' BPM';
  $('ramp-end').value = rampState.endBpm; $('ramp-end-val').textContent = rampState.endBpm + ' BPM';
  $('ramp-time').value = rampState.duration; $('ramp-time-val').textContent = rampState.duration + 's';
  $('ramp-mode').value = rampState.mode || 'micro-loops';
  if ($('ramp-sublen')) $('ramp-sublen').value = rampState.subLen || 'random';
  if ($('ramp-jitter')) {
    const j = rampState.jitter !== undefined ? rampState.jitter : 40;
    $('ramp-jitter').value = j; $('ramp-jitter-val').textContent = j + '%';
  }
  if ($('ramp-silence-min')) {
    $('ramp-silence-min').value = rampState.silenceGapMin ?? 0.5;
    $('ramp-silence-min-val').textContent = (rampState.silenceGapMin ?? 0.5) + 's';
  }
  if ($('ramp-silence-max')) {
    $('ramp-silence-max').value = rampState.silenceGapMax ?? 3;
    $('ramp-silence-max-val').textContent = (rampState.silenceGapMax ?? 3) + 's';
  }
  $('ramp-loop').classList.toggle('on', rampState.loop); $('ramp-loop').setAttribute('aria-checked', String(rampState.loop));
  $('ramp-exaggerate').value = rampState.exaggerateMode || 'thin';
  $('ramp-depth').value = Math.round((rampState.exaggerateDepth||0.8)*100); $('ramp-depth-val').textContent = Math.round((rampState.exaggerateDepth||0.8)*100)+'%';
  $('var-toggle').setAttribute('aria-pressed', String(rampState.variationsEnabled !== false));
  $('var-interval').value = String(rampState.varInterval||2); $('var-count').value = String(rampState.varCount||3);
  if ($('arc-gap-profile')) $('arc-gap-profile').value = rampState.arcGapProfile || 'mixed';
  if ($('arc-intensity')) $('arc-intensity').value = rampState.arcIntensity || 'dramatic';
  if ($('arc-orchestration-toggle')) {
    const on = rampState.arcOrchestration !== false;
    $('arc-orchestration-toggle').classList.toggle('on', on);
    $('arc-orchestration-toggle').setAttribute('aria-pressed', String(on));
    $('arc-orchestration-toggle').textContent = on ? 'On' : 'Off';
  }
  if ($('arc-morph-toggle')) {
    const on = rampState.arcMorph !== false;
    $('arc-morph-toggle').classList.toggle('on', on);
    $('arc-morph-toggle').setAttribute('aria-pressed', String(on));
    $('arc-morph-toggle').textContent = on ? 'On' : 'Off';
  }
  setArcStreamUI(rampState.enabled && rampState.mode === 'arc-stream');
  if (!rampState.enabled) { $('ramp-progress-bar').style.width = '0%'; $('ramp-status-text').textContent = 'OFF'; }
}
function wireTransport() {
  $('tr-tempo').addEventListener('input', () => { if (rampState.enabled) setRampEnabled(false); const v = parseFloat($('tr-tempo').value); $('tr-tempo-val').textContent = Math.round(v)+' BPM'; onTempoChange(v); });
  bindRange('tr-swing','tr-swing-val', v=>Math.round(v)+'%', v => { fxState.swing = v; });
  $('ramp-toggle').addEventListener('click', () => setRampEnabled(!rampState.enabled));
  bindRange('ramp-start','ramp-start-val', v=>Math.round(v)+' BPM', v => { rampState.startBpm = v; });
  bindRange('ramp-end','ramp-end-val', v=>Math.round(v)+' BPM', v => { rampState.endBpm = v; });
  bindRange('ramp-time','ramp-time-val', v=>Math.round(v)+'s', v => { rampState.duration = v; });
  $('ramp-mode').addEventListener('change', e => {
    rampState.mode = e.target.value;
    rampState.segStartTime = 0; rampState.macroPhaseStart = 0; rampState.macroPhases = null;
    if (rampState.mode === 'arc-stream') {
      restartArcStream();
      if (!rampState.enabled) setRampEnabled(true);
    } else {
      clearArcPaletteSession();
      arcStream = null;
    }
    setArcStreamUI(rampState.enabled && rampState.mode === 'arc-stream');
    logParamChange('BPM Ramp', 'Transport', 'Mode', rampState.mode);
  });
  if ($('arc-stream-toggle')) $('arc-stream-toggle').addEventListener('click', () => {
    const on = rampState.mode !== 'arc-stream' || !rampState.enabled;
    if (on) {
      rampState.mode = 'arc-stream';
      if ($('ramp-mode')) $('ramp-mode').value = 'arc-stream';
      restartArcStream();
      setRampEnabled(true);
    } else {
      setRampEnabled(false);
    }
  });
  if ($('arc-gap-profile')) $('arc-gap-profile').addEventListener('change', e => {
    rampState.arcGapProfile = e.target.value;
    restartArcStream();
    logParamChange('Arc Stream', 'Transport', 'Gap Profile', rampState.arcGapProfile);
  });
  if ($('arc-intensity')) $('arc-intensity').addEventListener('change', e => {
    rampState.arcIntensity = e.target.value;
    restartArcStream();
    logParamChange('Arc Stream', 'Transport', 'Intensity', rampState.arcIntensity);
  });
  if ($('arc-orchestration-toggle')) $('arc-orchestration-toggle').addEventListener('click', () => {
    rampState.arcOrchestration = !rampState.arcOrchestration;
    if (!rampState.arcOrchestration) updateArcOrchestrationUI(null);
    else if (arcStream) {
      const item = arcStream.queue[arcStream.index];
      if (item?.type === 'arc') applyArcOrchestration(item);
    }
    syncRampUI();
    logParamChange('Arc Stream', 'Transport', 'Orchestration', rampState.arcOrchestration ? 'On' : 'Off');
  });
  if ($('arc-morph-toggle')) $('arc-morph-toggle').addEventListener('click', () => {
    rampState.arcMorph = !rampState.arcMorph;
    syncRampUI();
    logParamChange('Arc Stream', 'Transport', 'Morph', rampState.arcMorph ? 'On' : 'Off');
  });
  if ($('arc-regen')) $('arc-regen').addEventListener('click', () => {
    restoreArcSessionBaseline();
    restartArcStream();
    logParamChange('Arc Stream', 'Transport', 'Regenerate', 'New program');
    flashBtn('arc-regen');
  });
  if ($('ramp-sublen')) $('ramp-sublen').addEventListener('change', e => { rampState.subLen = e.target.value; rampState.segStartTime = 0; rampState.macroPhaseStart = 0; rampState.macroPhases = null; logParamChange('BPM Ramp', 'Transport', 'Sub-Loop', rampState.subLen); });
  if ($('ramp-jitter')) bindRange('ramp-jitter', 'ramp-jitter-val', v=>Math.round(v)+'%', v => { rampState.jitter = v; });
  if ($('ramp-silence-min')) bindRange('ramp-silence-min', 'ramp-silence-min-val', v=>v.toFixed(1)+'s', v => { rampState.silenceGapMin = v; rampState.macroPhases = null; });
  if ($('ramp-silence-max')) bindRange('ramp-silence-max', 'ramp-silence-max-val', v=>v.toFixed(1)+'s', v => { rampState.silenceGapMax = Math.max(v, rampState.silenceGapMin || 0.5); rampState.macroPhases = null; });
  $('ramp-loop').addEventListener('click', () => { rampState.loop = !rampState.loop; $('ramp-loop').classList.toggle('on',rampState.loop); $('ramp-loop').setAttribute('aria-checked',String(rampState.loop)); });
  $('ramp-exaggerate').addEventListener('change', e => { rampState.exaggerateMode = e.target.value; });
  bindRange('ramp-depth','ramp-depth-val', v=>Math.round(v)+'%', v => { rampState.exaggerateDepth = v/100; });
  $('var-toggle').addEventListener('click', () => { rampState.variationsEnabled = !rampState.variationsEnabled; $('var-toggle').setAttribute('aria-pressed',String(rampState.variationsEnabled)); });
  $('var-interval').addEventListener('change', e => { rampState.varInterval = +e.target.value; });
  $('var-count').addEventListener('change', e => { rampState.varCount = +e.target.value; });
}
function scheduleTransport() {
  const now = audioCtx.currentTime;
  const stepDur = (60 / fxState.tempo) / 4;
  if (!transport.running) { transport.anchorTime = now + CFG.TRANSPORT_ANCHOR_OFFSET; transport.nextStepIndex = 0; transport.running = true; }
  const swingOff = (fxState.swing / 100) * stepDur * 0.5;
  const horizon = now + lookahead;
  while (true) {
    const t = transport.anchorTime + transport.nextStepIndex * stepDur;
    if (t >= horizon) break;
    const idx = ((transport.nextStepIndex % STEPS) + STEPS) % STEPS;
    const tt = t + (idx % 2 === 1 ? swingOff : 0);
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (b.enabled && b.mode === 'seq' && b.steps[idx] && b.pulseGain) triggerStep(b, tt, stepDur);
    }
    transport.nextStepIndex++;
  }
}
function scheduleEnvelope(g, t, stepDur, a, d, s, r) {
  const aa = Math.max(0.001, a), dTau = Math.max(0.005, d)/4, rTau = Math.max(0.005, r)/4, ss = Math.max(0.0001, s);
  try { g.cancelScheduledValues(t); g.setValueAtTime(0.0001,t); g.linearRampToValueAtTime(1,t+aa); g.setTargetAtTime(ss,t+aa,dTau); g.setTargetAtTime(0.0001,t+stepDur,rTau); } catch(_) {}
}
function triggerStep(b, t, stepDur) { scheduleEnvelope(b.pulseGain.gain, t, stepDur, b.a, b.d, b.s, b.r); b.lastTrig = t; b.lastStepDur = stepDur; }
function currentVisStep(nowA) {
  if (!transport.running || !audioCtx) return -1;
  const sf = (nowA - transport.anchorTime) / ((60/fxState.tempo)/4);
  return sf < 0 ? -1 : Math.floor(sf) % STEPS;
}
function updateTransportVisual(nowA) {
  const step = currentVisStep(nowA);
  if (step === lastTransportStep) return;
  if (lastTransportStep >= 0 && transportCells[lastTransportStep]) transportCells[lastTransportStep].classList.remove('ph');
  if (step >= 0 && transportCells[step]) transportCells[step].classList.add('ph');
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.mode !== 'seq' || !b.ui?.gridCells.length) continue;
    if (b.ui.phIdx >= 0 && b.ui.gridCells[b.ui.phIdx]) b.ui.gridCells[b.ui.phIdx].classList.remove('ph');
    if (step >= 0 && b.ui.gridCells[step]) b.ui.gridCells[step].classList.add('ph');
    b.ui.phIdx = step;
  }
  lastTransportStep = step;
}

function genCurve(b) {
  const out = b._curveBuf;
  const eff = getBandEffectiveParams(b);
  const durEff = Math.max(0.01, eff.dur);
  let lp = b.lfoPhaseS, pp = b.pulsePhaseS;
  for (let i = 0; i <= CFG.CURVE_N; i++) {
    const s = Math.sin(pp * TAU);
    out[i] = Math.pow(s > 0 ? s : 0, b.sharp);
    if (i < CFG.CURVE_N) {
      lp += CURVE_DT / durEff; if (lp >= 1) lp -= 1;
      const cf = eff.pLow + (eff.pHigh - eff.pLow) * lfoValue(b.shape, lp);
      pp += cf * CURVE_DT; pp -= Math.floor(pp);
    }
  }
  b.lfoPhaseS = lp; b.pulsePhaseS = pp;
  return out;
}
function scheduleAhead(b, horizon) {
  if (b.schedUntil < audioCtx.currentTime) b.schedUntil = audioCtx.currentTime;
  while (b.schedUntil < horizon) {
    try { b.pulseGain.gain.setValueCurveAtTime(genCurve(b), b.schedUntil, CFG.CURVE_WINDOW); }
    catch(_) { break; }
    b.schedUntil += CFG.CURVE_WINDOW;
  }
}

async function toggleMicInput() {
  if (micActive) {
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (micSourceNode) { try { micSourceNode.disconnect(); } catch(_) {} }
    micStream = null; micSourceNode = null; micAnalyser = null; micBuffer = null;
    micActive = false;
    $('mic-status').textContent = 'mic off';
    $('mic-enable').setAttribute('aria-pressed', 'false');
    return;
  }
  try {
    await ensureAudio();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micSourceNode = audioCtx.createMediaStreamSource(micStream);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 2048;
    micBuffer = new Float32Array(micAnalyser.fftSize);
    micSourceNode.connect(micAnalyser);
    micActive = true;
    $('mic-status').textContent = 'listening…';
    $('mic-enable').setAttribute('aria-pressed', 'true');
  } catch (err) {
    console.warn('Mic access denied:', err);
    $('mic-status').textContent = 'denied';
  }
}
function processMicSignal() {
  if (!micActive || !micAnalyser || !micBuffer) return;
  micAnalyser.getFloatTimeDomainData(micBuffer);
  let rms = 0;
  for (let i = 0; i < micBuffer.length; i++) rms += micBuffer[i] * micBuffer[i];
  rms = Math.sqrt(rms / micBuffer.length);
  if (rms < micNoiseFloor) { smoothedPitch = 0; return; }
  const bufLen = micBuffer.length;
  let bestCorr = -1, bestLag = 0;
  const minLag = Math.floor(audioCtx.sampleRate / 2000);
  const maxLag = Math.floor(audioCtx.sampleRate / 50);
  for (let lag = minLag; lag < Math.min(maxLag, bufLen / 2); lag++) {
    let corr = 0;
    for (let i = 0; i < bufLen / 2; i++) corr += micBuffer[i] * micBuffer[i + lag];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  if (bestLag > 0) {
    detectedPitch = audioCtx.sampleRate / bestLag;
    smoothedPitch += (detectedPitch - smoothedPitch) * 0.15;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (b.micSync && b.srcNode?.frequency && smoothedPitch > 20) {
        smoothOsc(b.srcNode.frequency, smoothedPitch, CFG.UI_TAU * 2);
      }
    }
  }
  if (micBeatTrack && audioCtx) {
    const now = audioCtx.currentTime;
    if (rms > micNoiseFloor * 3 && now - lastTransientTime > 0.2) {
      const interval = now - lastTransientTime;
      lastTransientTime = now;
      if (interval > 0.25 && interval < 2.0) {
        const bpm = 60 / interval;
        smoothedMicBpm += (bpm - smoothedMicBpm) * 0.1;
        if (Math.abs(fxState.tempo - smoothedMicBpm) > 2) {
          onTempoChange(Math.round(smoothedMicBpm));
          $('tr-tempo').value = Math.round(smoothedMicBpm);
          $('tr-tempo-val').textContent = Math.round(smoothedMicBpm) + ' BPM';
        }
      }
    }
  }
}
function processDynamicConductor(nowSec) {
  if (!conductorActive || !audioCtx || !isPlaying) return;
  if (nowSec - (processDynamicConductor._last || 0) < 0.5) return;
  processDynamicConductor._last = nowSec;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (!b.enabled || !b.level) continue;
    let clash = 0;
    for (let j = 0; j < bands.length; j++) {
      if (i === j || !bands[j].enabled) continue;
      const ratio = Math.max(b.curFreq, bands[j].curFreq) / Math.max(1, Math.min(b.curFreq, bands[j].curFreq));
      if (ratio < 1.15) clash += 0.15;
    }
    const target = Math.max(0.1, b.vol * (1 - Math.min(0.6, clash)));
    smooth(b.level.gain, target, 0.1);
  }
  $('conductor-status').textContent = 'active';
}

function onTick() {
  if (!audioCtx || !isPlaying) return;
  const nowSec = audioCtx.currentTime;
  updateTempoRamp(nowSec);
  processMicSignal();
  processDynamicConductor(nowSec);
  const t = performance.now(), gap = t - lastTickT; lastTickT = t;
  lookahead = gap > 400 ? CFG.LOOKAHEAD_PAGE : CFG.LOOKAHEAD_MIN;
  if (engineMode === 'scheduler') {
    const horizon = audioCtx.currentTime + lookahead;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (b.enabled && b.pulseGain && b.mode === 'cont') scheduleAhead(b, horizon);
    }
  }
  scheduleTransport();
}
function startTicker() {
  if (tickerWorker || pageTimer) return;
  lastTickT = performance.now();
  try {
    const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(TICKER_SRC);
    tickerWorker = new Worker(dataUrl);
    tickerWorker.onmessage = onTick;
    tickerWorker.postMessage('start');
    timerSource = 'worker';
  } catch(_) { pageTimer = setInterval(onTick, CFG.TICK_MS); timerSource = 'page'; }
  updateSysUI();
}
function stopTicker() {
  if (tickerWorker) { try { tickerWorker.postMessage('stop'); tickerWorker.terminate(); } catch(_) {} tickerWorker = null; }
  if (pageTimer) { clearInterval(pageTimer); pageTimer = null; }
  timerSource = '—'; updateSysUI();
}

function startBand(b) {
  if (!audioCtx || !b.enabled) return;
  // Tear down any leftover graph before rebuilding (avoids double-starts).
  if (b.pulseGain || b.srcNode || b.worklet) stopBand(b);
  const t0 = audioCtx.currentTime + CFG.BAND_START_OFFSET;
  b._chainId = ++chainCounter;
  b.pulseGain = audioCtx.createGain(); b.pulseGain.gain.value = 0;
  b.level = audioCtx.createGain(); b.level.gain.value = b.vol;
  b.shaper = audioCtx.createWaveShaper(); b.shaper.oversample = '2x';
  b.shaper.curve = b.drive > 0.001 ? makeDriveCurve(b.drive, b.driveType) : null;
  b.filter = audioCtx.createBiquadFilter();
  applyFilterType(b.filter, b.filterType, b.filterFreq, b.filterQ);
  b.filter.frequency.value = b.filterFreq;
  b.panner = audioCtx.createStereoPanner(); b.panner.pan.value = b.pan;
  b.filterLFO = audioCtx.createOscillator(); b.filterLFO.type = 'sine'; b.filterLFO.frequency.value = b.filterLFORate;
  b.filterLFOGain = audioCtx.createGain(); b.filterLFOGain.gain.value = b.filterLFODepth;
  let srcType = b.source;
  if (srcType === 'smp' && !b.sampleBuf) srcType = 'osc';
  if (srcType === 'fm') {
    const hasBinaural = b.binauralOffset && Math.abs(b.binauralOffset) > 0.01;
    const car = clampAudioFreq(b.carrier);
    if (hasBinaural) {
      b.srcNodeL = audioCtx.createOscillator(); b.srcNodeL.type = b.cType;
      const fL = setOscParam(b.srcNodeL.frequency, car - b.binauralOffset / 2);
      b.fmModNodeL = audioCtx.createOscillator(); b.fmModNodeL.type = 'sine';
      setOscParam(b.fmModNodeL.frequency, fmModFrequency(fL, b.fmRatio, audioCtx));
      b.fmGainNodeL = audioCtx.createGain();
      b.fmGainNodeL.gain.value = (b.fmIndex||20) * fL * 0.05;
      b.fmModNodeL.connect(b.fmGainNodeL); b.fmGainNodeL.connect(b.srcNodeL.frequency);
      b.srcNodeR = audioCtx.createOscillator(); b.srcNodeR.type = b.cType;
      const fR = setOscParam(b.srcNodeR.frequency, car + b.binauralOffset / 2);
      b.fmModNodeR = audioCtx.createOscillator(); b.fmModNodeR.type = 'sine';
      setOscParam(b.fmModNodeR.frequency, fmModFrequency(fR, b.fmRatio, audioCtx));
      b.fmGainNodeR = audioCtx.createGain();
      b.fmGainNodeR.gain.value = (b.fmIndex||20) * fR * 0.05;
      b.fmModNodeR.connect(b.fmGainNodeR); b.fmGainNodeR.connect(b.srcNodeR.frequency);
      b.merger = audioCtx.createChannelMerger(2);
      b.srcNodeL.connect(b.merger, 0, 0);
      b.srcNodeR.connect(b.merger, 0, 1);
      b.merger.connect(b.pulseGain);
      b.srcNodeL.start(t0); b.srcNodeR.start(t0);
      b.fmModNodeL.start(t0); b.fmModNodeR.start(t0);
      b.srcNode = b.srcNodeL;
    } else {
      b.srcNode = audioCtx.createOscillator(); b.srcNode.type = b.cType;
      setOscParam(b.srcNode.frequency, car);
      b.fmModNode = audioCtx.createOscillator(); b.fmModNode.type = 'sine';
      setOscParam(b.fmModNode.frequency, fmModFrequency(car, b.fmRatio, audioCtx));
      b.fmGainNode = audioCtx.createGain(); b.fmGainNode.gain.value = (b.fmIndex||20) * car * 0.05;
      b.fmModNode.connect(b.fmGainNode); b.fmGainNode.connect(b.srcNode.frequency);
      b.fmModNode.start(t0); b.srcNode.connect(b.pulseGain);
      b.srcNode.start(t0);
    }
  } else if (srcType === 'pluck') {
    const bLen = Math.floor(audioCtx.sampleRate * 0.015);
    const bBuf = audioCtx.createBuffer(1, bLen, audioCtx.sampleRate);
    const d = bBuf.getChannelData(0); for (let i=0;i<bLen;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(bLen*0.3));
    b.srcNode = audioCtx.createBufferSource(); b.srcNode.buffer = bBuf;
    b.pluckDelay = audioCtx.createDelay(0.1); b.pluckDelay.delayTime.value = 1/Math.max(20,b.carrier);
    b.pluckFb = audioCtx.createGain(); b.pluckFb.gain.value = Math.min(0.98, 0.90+(b.pluckDecay||0.05));
    b.srcNode.connect(b.pluckDelay); b.pluckDelay.connect(b.pluckFb); b.pluckFb.connect(b.pluckDelay); b.pluckDelay.connect(b.pulseGain);
  } else if (srcType === 'sub') {
    b.srcNode = audioCtx.createOscillator(); b.srcNode.type = 'sine';
    setOscParam(b.srcNode.frequency, b.carrier * 0.5);
    b.srcNode.connect(b.pulseGain);
  } else if (srcType === 'osc') {
    if (b.binauralOffset && Math.abs(b.binauralOffset) > 0.01) {
      b.srcNodeL = audioCtx.createOscillator(); b.srcNodeR = audioCtx.createOscillator();
      b.srcNodeL.type = b.cType; b.srcNodeR.type = b.cType;
      setOscParam(b.srcNodeL.frequency, b.carrier - b.binauralOffset / 2);
      setOscParam(b.srcNodeR.frequency, b.carrier + b.binauralOffset / 2);
      b.merger = audioCtx.createChannelMerger(2);
      b.srcNodeL.connect(b.merger,0,0); b.srcNodeR.connect(b.merger,0,1); b.merger.connect(b.pulseGain);
      b.srcNodeL.start(t0); b.srcNodeR.start(t0); b.srcNode = b.srcNodeL;
    } else {
      b.srcNode = audioCtx.createOscillator(); b.srcNode.type = b.cType;
      setOscParam(b.srcNode.frequency, b.carrier);
      b.srcNode.connect(b.pulseGain);
    }
  } else {
    b.srcNode = audioCtx.createBufferSource();
    b.srcNode.buffer = srcType === 'smp' ? b.sampleBuf : getNoiseBuffer(srcType);
    b.srcNode.loop = true; b.srcNode.playbackRate.value = Math.pow(2, b.pitch/12);
    b.srcNode.connect(b.pulseGain);
  }
  b.pulseGain.connect(b.level); b.level.connect(b.shaper); b.shaper.connect(b.filter);
  b.filter.connect(b.panner); b.panner.connect(masterGain);
  b.dlySendG = audioCtx.createGain(); b.dlySendG.gain.value = b.dlySend;
  b.revSendG = audioCtx.createGain(); b.revSendG.gain.value = b.revSend;
  b.panner.connect(b.dlySendG); b.dlySendG.connect(dlyBus);
  b.panner.connect(b.revSendG); b.revSendG.connect(revBus);
  connectLFOTarget(b);
  const eff = getBandEffectiveParams(b);
  if (b.mode === 'seq') { b.pulseGain.gain.value = 0; b.lastTrig = -1; }
  else if (engineMode === 'worklet') {
    b.worklet = new AudioWorkletNode(audioCtx, 'pulse-voice');
    const P = b.worklet.parameters;
    P.get('pLow').value = clampWorkletPulse(eff.pLow);
    P.get('pHigh').value = clampWorkletPulse(eff.pHigh);
    P.get('dur').value = Math.min(CFG.WORKLET_DUR_MAX, Math.max(0.01, eff.dur));
    P.get('sharp').value = b.sharp;
    P.get('shape').value = SHAPE_NUM[b.shape] ?? 0;
    P.get('gate').setValueAtTime(1, t0);
    b.worklet.connect(b.pulseGain.gain);
  } else { b.lfoPhaseS = 0; b.pulsePhaseS = 0; b.schedUntil = t0; }
  if (b.srcNode?.start && srcType !== 'fm' && !(srcType === 'osc' && b.srcNodeL)) b.srcNode.start(t0);
  if (srcType === 'fm' && !b.srcNodeL && b.srcNode?.start) { /* already started */ }
  if (b.filterLFO?.start) b.filterLFO.start(t0);
  b.visLfo = 0; b.visPulse = 0; b.visT = t0;
  b.curFreq = b.mode === 'seq' ? b.carrier : eff.pLow; b._miniDirty = true;
}
function stopBand(b) {
  // IMPORTANT: do not clear b.enabled — that is the user's arming state.
  // Global Stop / param restarts must leave toggles alone.
  if (!audioCtx) return;
  if (!b.pulseGain && !b.srcNode && !b.worklet && !b.srcNodeL) return;
  const now = audioCtx.currentTime, id = b._chainId;
  const dead = [b.srcNode,b.srcNodeL,b.srcNodeR,b.fmModNode,b.fmGainNode,b.fmModNodeL,b.fmGainNodeL,b.fmModNodeR,b.fmGainNodeR,b.pluckDelay,b.pluckFb,
  b.filterLFO,b.pulseGain,b.level,b.shaper,b.filter,b.panner,
  b.filterLFOGain,b.worklet,b.dlySendG,b.revSendG,b.merger].filter(Boolean);
  if (b.pulseGain) { try{b.pulseGain.gain.cancelScheduledValues(now);}catch(_){} try{b.pulseGain.gain.setTargetAtTime(0,now,CFG.RELEASE_TAU);}catch(_){} }
  if (b.worklet) { try{b.worklet.parameters.get('gate').setTargetAtTime(0,now,CFG.RELEASE_TAU);}catch(_){} }
  for (const src of [b.srcNode,b.srcNodeL,b.srcNodeR,b.fmModNode,b.fmModNodeL,b.fmModNodeR,b.filterLFO]) { if(src?.stop) try{src.stop(now+CFG.OSC_STOP_TAIL);}catch(_){} }
  b.srcNode=b.srcNodeL=b.srcNodeR=b.fmModNode=b.fmGainNode=b.fmModNodeL=b.fmGainNodeL=b.fmModNodeR=b.fmGainNodeR=b.pluckDelay=b.pluckFb=null;
  b.pulseGain=b.level=b.shaper=b.filter=b.panner=b.filterLFO=b.filterLFOGain=b.merger=null;
  b.worklet=null; b.dlySendG=null; b.revSendG=null;
  setTimeout(() => { if(b._chainId!==id)return; for(const n of dead) try{n.disconnect();}catch(_){} }, CFG.NODE_DISCONNECT_DELAY);
}
function setBandEnabled(b, on) {
  if (on === b.enabled) return;
  b.enabled = !!on;
  if (isPlaying) {
    if (on) startBand(b);
    else stopBand(b);
  }
  b._miniDirty = true;
}

async function setPlaying(on) {
  if (on === isPlaying) return;
  if (on) {
    await ensureAudio();
    rampState.startTime = audioCtx.currentTime; rampState.lastLoopIndex = -1; rampState.totalLoopsCompleted = 0;
    rampState.segStartTime = 0; rampState.macroPhaseStart = 0; rampState.macroPhases = null;
    rampState.currentBpmFloat = rampState.startBpm;
    if (rampState.mode === 'arc-stream') restartArcStream();
    startTicker();
    for (let i = 0; i < bands.length; i++) if (bands[i].enabled) startBand(bands[i]);
    playBtn.innerHTML = ICON_STOP + 'STOP'; playBtn.classList.add('playing');
  } else {
    for (let i = 0; i < bands.length; i++) stopBand(bands[i]);
    stopTicker(); transport.running = false;
    playBtn.innerHTML = ICON_PLAY + 'START'; playBtn.classList.remove('playing');
  }
  isPlaying = on;
  if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = on ? 'playing' : 'paused'; } catch(_) {}
  updateSysUI();
}
async function setWakeLock(on) {
  wakeRequested = on; wakeBtn.setAttribute('aria-pressed', String(on));
  if (wakeSentinel) { try{await wakeSentinel.release();}catch(_){} wakeSentinel = null; }
  if (on && document.visibilityState === 'visible') { try{wakeSentinel=await navigator.wakeLock.request('screen');}catch(_){wakeSentinel=null;} }
  updateSysUI();
}

function serializeState() {
  return {
    app:'pulseforge', version:1,
    fx:{ tempo:fxState.tempo, subdiv:fxState.subdiv, feedback:fxState.feedback, damp:fxState.damp, dlyReturn:fxState.dlyReturn, revPreset:fxState.revPreset, revReturn:fxState.revReturn, swing:fxState.swing },
    ramp:{ enabled:rampState.enabled, startBpm:rampState.startBpm, endBpm:rampState.endBpm, duration:rampState.duration, loop:rampState.loop, mode:rampState.mode, subLen:rampState.subLen, jitter:rampState.jitter, silenceGapMin:rampState.silenceGapMin, silenceGapMax:rampState.silenceGapMax, arcGapProfile:rampState.arcGapProfile, arcIntensity:rampState.arcIntensity, arcOrchestration:rampState.arcOrchestration, arcMorph:rampState.arcMorph, exaggerateMode:rampState.exaggerateMode, exaggerateDepth:rampState.exaggerateDepth, variationsEnabled:rampState.variationsEnabled, varInterval:rampState.varInterval, varCount:rampState.varCount },
    bands: bands.map(b => ({ enabled:b.enabled, bpmSync:b.bpmSync, micSync:b.micSync, driveType:b.driveType, lfoTarget:b.lfoTarget, binauralOffset:b.binauralOffset, fmRatio:b.fmRatio, fmIndex:b.fmIndex, pluckDecay:b.pluckDecay, source:(b.source==='smp'&&!b.sampleBuf)?'osc':b.source, carrier:b.carrier, cType:b.cType, pitch:b.pitch, pLow:b.pLow, pHigh:b.pHigh, dur:b.dur, shape:b.shape, vol:b.vol, sharp:b.sharp, drive:b.drive, filterType:b.filterType, filterFreq:b.filterFreq, filterQ:b.filterQ, filterLFORate:b.filterLFORate, filterLFODepth:b.filterLFODepth, pan:b.pan, dlySend:b.dlySend, revSend:b.revSend, mode:b.mode, hits:b.hits, rotate:b.rotate, steps:b.steps.slice(), a:b.a, d:b.d, s:b.s, r:b.r, name:b.name, color:b.color, rgb:b.rgb })),
  };
}

function getDefaultState() {
  return {
    app:'pulseforge', version:1,
    fx:{ tempo:90, subdiv:0.375, feedback:0.45, damp:3200, dlyReturn:0.50, revPreset:'hall', revReturn:0.45, swing:0 },
    ramp:{ enabled:false, startBpm:180, endBpm:60, duration:10, loop:true, mode:'micro-loops', subLen:'random', jitter:40, silenceGapMin:0.5, silenceGapMax:3, arcGapProfile:'mixed', arcIntensity:'dramatic', arcOrchestration:true, arcMorph:true, exaggerateMode:'thin', exaggerateDepth:0.8, variationsEnabled:true, varInterval:2, varCount:3 },
    bands: bandDefsToState(getBandDefs(CFG.DEFAULT_BANDS)),
  };
}

function applyState(state) {
  if (!state || !Array.isArray(state.bands)) return;
  if (state.fx) Object.assign(fxState, state.fx);
  if (state.ramp) Object.assign(rampState, state.ramp);
  state.bands.forEach((s, i) => {
    s.name = bandLabel(i, state.bands.length);
  });
  for (let i = 0; i < bands.length; i++) stopBand(bands[i]);
  bands.length = 0;
  arcPaletteBaseline = null;
  arcFxBaseline = null;
  arcStream = null;
  // Batch rebuild — one DOM pass instead of N
  state.bands.forEach(s => addBand(clampBandParams({ ...s }), { rebuild: false }));
  transport.running = false;
  rebuildCards();
  syncFxUI(); syncRampUI(); updateSysUI(); updateBandCountUI();
  if (bands.length >= 24) setBandViewMode(defaultBandViewMode(bands.length));
  if (rampState.mode === 'arc-stream' && rampState.enabled) restartArcStream();
  if (isPlaying) {
    for (let i = 0; i < bands.length; i++) if (bands[i].enabled) startBand(bands[i]);
  }
}
function syncFxUI() {
  $('tr-tempo').value = fxState.tempo; $('tr-tempo-val').textContent = Math.round(fxState.tempo)+' BPM';
  $('tr-swing').value = fxState.swing; $('tr-swing-val').textContent = Math.round(fxState.swing)+'%';
  $('fx-feedback').value = fxState.feedback*100; $('fx-feedback-val').textContent = Math.round(fxState.feedback*100)+'%';
  $('fx-damp').value = fxState.damp; $('fx-damp-val').textContent = fxState.damp>=1000?(fxState.damp/1000).toFixed(1)+'k':String(Math.round(fxState.damp));
  $('fx-dly-ret').value = fxState.dlyReturn*100; $('fx-dly-ret-val').textContent = Math.round(fxState.dlyReturn*100)+'%';
  $('fx-rev-ret').value = fxState.revReturn*100; $('fx-rev-ret-val').textContent = Math.round(fxState.revReturn*100)+'%';
  $('fx-subdiv').value = String(fxState.subdiv); $('fx-rev-preset').value = fxState.revPreset;
  setDelayTime();
  if (audioCtx && fbGainL) {
    const t=audioCtx.currentTime, fb=Math.min(fxState.feedback,CFG.FB_MAX);
    fbGainL.gain.setTargetAtTime(fb,t,CFG.UI_TAU); fbGainR.gain.setTargetAtTime(fb,t,CFG.UI_TAU);
    dampL.frequency.setTargetAtTime(fxState.damp,t,CFG.UI_TAU); dampR.frequency.setTargetAtTime(fxState.damp,t,CFG.UI_TAU);
    dlyWetL.gain.setTargetAtTime(fxState.dlyReturn,t,CFG.UI_TAU); dlyWetR.gain.setTargetAtTime(fxState.dlyReturn,t,CFG.UI_TAU);
    revWet.gain.setTargetAtTime(fxState.revReturn,t,CFG.UI_TAU); convolver.buffer = makeImpulse(fxState.revPreset);
  }
  updateFxReadouts(); updateFxLeds();
}
function readPresets() { try{return JSON.parse(localStorage.getItem(PRESET_KEY))||{};}catch(_){return{};} }
function writePresets(map) { try{localStorage.setItem(PRESET_KEY,JSON.stringify(map));}catch(_){} }
function refreshPresetList() { const sel=$('preset-list'),cur=sel.value,all=readPresets(); sel.innerHTML='<option value="">—</option>'; Object.keys(all).sort().forEach(n=>{const o=document.createElement('option');o.value=n;o.textContent=n;sel.appendChild(o);}); sel.value=cur; }
function saveCurrentPreset() { const name=$('preset-name').value.trim(); if(!name){$('preset-name').focus();return;} const all=readPresets(); all[name]=serializeState(); writePresets(all); refreshPresetList(); $('preset-list').value=name; flashBtn('preset-save'); }
function loadSelectedPreset() { const name=$('preset-list').value; if(!name)return; const all=readPresets(); if(all[name])applyState(all[name]); }
function deleteSelectedPreset() { const name=$('preset-list').value; if(!name)return; const all=readPresets(); delete all[name]; writePresets(all); refreshPresetList(); }
function exportPresetJson() { downloadBlob(new Blob([JSON.stringify(serializeState(),null,2)],{type:'application/json'}),'pulseforge-preset.json'); flashBtn('preset-export'); }
function importPresetJson(file) { const r=new FileReader(); r.onload=()=>{try{applyState(JSON.parse(r.result));}catch(e){console.warn('Bad preset JSON',e);}}; r.readAsText(file); }

function generatePresetState(type, baseState) {
  const base = structuredClone(baseState || getDefaultState());
  if (type === 'meditation') { base.fx.tempo = 60; base.bands.forEach(b => { b.carrier = Math.max(20, b.carrier * 0.98); b.vol *= 0.7; b.shape = 'sine'; }); }
  else if (type === 'cyberpunk') { base.fx.tempo = 140; base.bands.forEach(b => { b.drive = 0.4; b.driveType = 'fold'; b.filterType = 'bandpass'; }); }
  else if (type === 'harp') { base.bands.forEach(b => { b.source = 'pluck'; b.pluckDecay = 0.15; b.a = 0.001; b.d = 0.5; }); }
  else if (type === 'drone') { base.fx.tempo = 40; base.bands.forEach(b => { b.mode = 'cont'; b.pLow = 0.2; b.pHigh = 1; b.dur = 30; }); }
  else if (type === 'fm-binaural') {
    base.fx.tempo = 120;
    base.bands.forEach((b, i) => {
      b.source = 'fm'; b.cType = 'sine';
      const binauralTargets = [2, 6, 10, 18, 40, 6, 10];
      b.binauralOffset = binauralTargets[i % binauralTargets.length];
      b.fmRatio = [1, 2, 3, 4, 1.5, 2, 3][i % 7];
      b.fmIndex = 15 + (i * 5); b.shape = 'sine'; b.sharp = 6.0; b.drive = 0.0; b.driveType = 'tanh';
      b.filterType = 'lowpass'; b.filterFreq = 2500 + (i * 600); b.filterQ = 2.5;
      b.pLow = 2 + i; b.pHigh = 15 + (i * 2); b.dur = 8; b.vol = 0.35;
      b.pan = (i % 2 === 0) ? -0.5 : 0.5;
    });
  }
  else if (type === 'tectonic') {
    base.fx.tempo = 55; base.fx.feedback = 0.65; base.fx.damp = 1200; base.fx.revPreset = 'cave'; base.fx.revReturn = 0.6;
    base.bands.forEach((b, i) => {
      b.source = i < 3 ? 'sub' : 'brown'; b.carrier = 30 + (i * 15); b.cType = 'sine'; b.binauralOffset = 0;
      b.pLow = 0.05; b.pHigh = 1.5 + (i * 0.5); b.dur = 25 + (i * 5); b.shape = 'sine'; b.sharp = 1.5;
      b.drive = 0.45 + (i * 0.05); b.driveType = 'tube'; b.filterType = 'lowpass';
      b.filterFreq = 150 + (i * 80); b.filterQ = 4.0; b.vol = 0.6 - (i * 0.05);
      b.pan = (i % 2 === 0) ? -0.3 : 0.3; b.dlySend = 0.05; b.revSend = 0.4 + (i * 0.05);
    });
  }
  else if (type === 'gamma-ascension') {
    base.fx.tempo = 135; base.fx.subdiv = 0.125; base.fx.feedback = 0.55;
    base.bands.forEach((b, i) => {
      b.source = 'osc'; b.cType = 'sine'; b.carrier = 300 + (i * 150);
      b.binauralOffset = (i % 2 === 0) ? 40 : 20; b.pLow = 15 + (i * 2); b.pHigh = 40 + (i * 5);
      b.dur = 6; b.shape = 'triangle'; b.sharp = 5.5; b.drive = 0.0; b.filterType = 'bandpass';
      b.filterFreq = 1500 + (i * 400); b.filterQ = 2.0; b.vol = 0.25;
      b.pan = (i % 2 === 0) ? -0.85 : 0.85; b.dlySend = 0.3; b.revSend = 0.2;
    });
  }
  else if (type === 'glitch-matrix') {
    base.fx.tempo = 110; base.fx.swing = 25; base.fx.feedback = 0.7; base.fx.damp = 4500;
    base.ramp.variationsEnabled = true; base.ramp.varInterval = 1; base.ramp.varCount = 4;
    base.bands.forEach((b, i) => {
      b.source = 'fm'; b.cType = 'sawtooth'; b.carrier = 180 + (i * 120);
      b.fmRatio = [1.414, 2.718, 3.141, 0.618, 4.236, 1.732, 2.236, 3.333][i % 8];
      b.fmIndex = 40 + (i * 8); b.binauralOffset = 0; b.mode = 'seq';
      b.hits = 3 + Math.floor(Math.random() * 8); b.rotate = i * 2;
      b.a = 0.001; b.d = 0.08; b.s = 0.0; b.r = 0.05;
      b.drive = 0.5 + (i * 0.05); b.driveType = i % 2 === 0 ? 'crush' : 'fold';
      b.filterType = 'highpass'; b.filterFreq = 400 + (i * 200); b.filterQ = 6.0; b.vol = 0.3;
      b.pan = (Math.random() - 0.5) * 1.6; b.dlySend = 0.4; b.revSend = 0.15;
    });
  }
  else if (type === 'chaos-cascade') {
    base.fx.tempo = 420; base.fx.subdiv = 0.125; base.fx.feedback = 0.62; base.fx.damp = 2800;
    base.fx.revPreset = 'plate'; base.fx.revReturn = 0.35;
    base.ramp.enabled = true;
    base.ramp.startBpm = 500; base.ramp.endBpm = 1;
    base.ramp.duration = 18; base.ramp.loop = true;
    base.ramp.mode = 'pulse-wave'; base.ramp.subLen = 'chaos';
    base.ramp.jitter = 75; base.ramp.silenceGapMin = 0.8; base.ramp.silenceGapMax = 4.5;
    base.ramp.exaggerateMode = 'combo'; base.ramp.exaggerateDepth = 0.92;
    base.ramp.variationsEnabled = true; base.ramp.varInterval = 1; base.ramp.varCount = 5;
    base.bands.forEach((b, i) => {
      b.enabled = true; b.bpmSync = true; b.mode = i < 3 ? 'cont' : 'seq';
      b.source = i < 2 ? 'sub' : (i > 6 ? 'fm' : 'osc');
      b.pLow = 0.5 + i * 8; b.pHigh = 20 + i * 45; b.dur = 4 + i;
      b.vol = 0.15 + (i % 3) * 0.08;
      b.hits = 2 + (i % 7); b.rotate = i * 3;
      b.filterType = i > 5 ? 'highpass' : 'lowpass';
      b.filterFreq = 200 + i * 900; b.drive = i > 4 ? 0.35 : 0.1;
      b.pan = ((i % 4) - 1.5) * 0.45; b.dlySend = 0.2 + (i % 3) * 0.1;
    });
  }
  else if (type === 'tectonic-breath') {
    base.fx.tempo = 95; base.fx.feedback = 0.58; base.fx.damp = 900;
    base.fx.revPreset = 'cave'; base.fx.revReturn = 0.55;
    base.ramp.enabled = true;
    base.ramp.startBpm = 280; base.ramp.endBpm = 8;
    base.ramp.duration = 24; base.ramp.loop = true;
    base.ramp.mode = 'pulse-wave'; base.ramp.subLen = 'chaos';
    base.ramp.jitter = 55; base.ramp.silenceGapMin = 1.2; base.ramp.silenceGapMax = 6;
    base.ramp.exaggerateMode = 'bands'; base.ramp.exaggerateDepth = 0.88;
    base.ramp.variationsEnabled = true; base.ramp.varInterval = 2; base.ramp.varCount = 3;
    base.bands.forEach((b, i) => {
      b.enabled = true; b.bpmSync = true; b.mode = 'cont';
      b.source = i < 4 ? 'brown' : 'osc'; b.carrier = 40 + i * 22;
      b.pLow = 0.08 + i * 0.4; b.pHigh = 1.2 + i * 2.5; b.dur = 18 + i * 3;
      b.shape = 'sine'; b.vol = 0.5 - i * 0.04; b.filterType = 'lowpass';
      b.filterFreq = 120 + i * 140; b.filterQ = 3.5; b.drive = 0.3 + i * 0.04;
      b.driveType = 'tube'; b.pan = (i % 2 === 0 ? -1 : 1) * (0.2 + i * 0.08);
      b.revSend = 0.35 + i * 0.04; b.dlySend = 0.05;
    });
  }
  else if (type === 'full-spectrum-48') {
    base.bands = bandDefsToState(getFullSpectrumBandDefs(CFG.MAX_BANDS));
    base.fx.tempo = 90;
    base.fx.subdiv = 0.375;
    base.fx.feedback = 0.38;
    base.fx.damp = 2600;
    base.fx.dlyReturn = 0.32;
    base.fx.revPreset = 'hall';
    base.fx.revReturn = 0.4;
    base.ramp.enabled = false;
    base.ramp.mode = 'micro-loops';
    base.bands.forEach((b) => {
      b.enabled = true;
      b.bpmSync = true;
      b.source = 'osc';
      b.cType = 'sine';
      b.mode = 'cont';
      b.driveType = 'fold';
      b.lfoTarget = 'filter';
      b.filterLFODepth = 0;
    });
  }
  else if (type === 'arc-stream' || type === 'arc-orchestra' || type === 'arc-orchestra-48') {
    const bandCount = type === 'arc-orchestra-48' ? CFG.MAX_BANDS : CFG.ARC_STREAM_BANDS;
    base.bands = bandDefsToState(getBandDefs(bandCount));
    base.fx.tempo = 120; base.fx.feedback = 0.6; base.fx.damp = 1800; base.fx.revReturn = 0.48;
    base.ramp.enabled = true; base.ramp.mode = 'arc-stream';
    base.ramp.arcGapProfile = 'mixed';
    base.ramp.arcIntensity = (type === 'arc-orchestra' || type === 'arc-orchestra-48') ? 'extreme' : 'dramatic';
    base.ramp.arcOrchestration = true;
    base.ramp.arcMorph = true;
    base.ramp.variationsEnabled = true; base.ramp.varInterval = 1; base.ramp.varCount = 4;
    base.bands.forEach((b, i) => {
      b.bpmSync = true;
      b.enabled = i < Math.min(9, bandCount);
      b.driveType = 'fold';
      if (b.drive < 0.05) b.drive = 0.05 + (i % 6) * 0.01;
      b.mode = i > Math.floor(bandCount * 0.55) ? 'seq' : 'cont';
      b.vol = Math.max(0.08, 0.28 - (i / bandCount) * 0.12);
      b.hits = 3 + (i % 7); b.rotate = i * 2;
    });
  }
  else { base.bands.forEach(b => { b.carrier = 50 + Math.random() * 4000; b.vol = 0.1 + Math.random() * 0.4; b.hits = 1 + Math.floor(Math.random() * 12); }); }
  return base;
}

function exportPresetPack() {
  const pack = { app: 'pulseforge', version: 1, type: 'pack', presets: {} };
  const types = ['meditation', 'cyberpunk', 'harp', 'drone', 'fm-binaural', 'tectonic', 'gamma-ascension', 'glitch-matrix', 'chaos-cascade', 'tectonic-breath', 'full-spectrum-48', 'arc-stream', 'arc-orchestra', 'arc-orchestra-48'];
  const names = ['Meditation (432Hz)', 'Cyberpunk (140BPM)', 'Pluck Ensemble', 'Cosmic Drone', 'Crisp FM Binaural', 'Sub-Harmonic Tectonic', 'Neural Gamma Ascension', 'Glitch Matrix', 'Chaos Cascade (500→1)', 'Tectonic Breath', '48-Band Full Spectrum', 'Arc Stream Auto', '36-Band Arc Orchestra', '48-Band Arc Orchestra'];
  types.forEach((type, i) => { pack.presets[names[i]] = generatePresetState(type, getDefaultState()); });
  downloadBlob(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }), 'pulseforge-presets-pack.json');
  flashBtn('pack-export');
}

function importPresetPack(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (data.type === 'pack' && data.presets) {
        const all = readPresets();
        let count = 0;
        for (const [name, state] of Object.entries(data.presets)) { all[name] = state; count++; }
        writePresets(all); refreshPresetList();
        flashBtn('pack-import');
        $('midi-status').textContent = `imported ${count}`;
      } else {
        console.warn('Invalid preset pack file.');
      }
    } catch (e) { console.warn('Bad preset pack JSON', e); }
  };
  r.readAsText(file);
}

function setMidiStatus(s) { $('midi-status').textContent = s; }
async function toggleMidi() {
  if (midiAccess) { setMidiStatus('already on'); return; }
  if (!navigator.requestMIDIAccess) { setMidiStatus('not supported'); return; }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    const wire = () => midiAccess.inputs.forEach(inp => { inp.onmidimessage = onMidiMsg; });
    wire(); midiAccess.onstatechange = wire;
    setMidiStatus(midiAccess.inputs.size ? 'ready' : 'no devices'); $('midi-enable').textContent = 'ON';
  } catch(_) { setMidiStatus('denied'); }
}
function onMidiMsg(e) {
  if (!e.data || e.data.length < 3 || (e.data[0]&0xf0) !== 0xB0) return;
  const cc = e.data[1], val = e.data[2];
  if (midiLearnActive && midiArmed) { midiMap[cc] = midiArmed; setMidiStatus(`CC${cc} → ${bands[midiArmed.bandIdx].name}:${midiArmed.key}`); exitLearn(); return; }
  const m = midiMap[cc]; if (m) applyMidi(m, val);
}
function enterLearn() { midiLearnActive = true; $('midi-learn').textContent = 'LISTEN…'; setMidiStatus('click a knob'); }
function exitLearn() { midiLearnActive = false; clearMidiArm(); $('midi-learn').textContent = 'LEARN'; }
function clearMidiArm() { if (midiArmedEl) midiArmedEl.classList.remove('midi-armed'); midiArmedEl = null; midiArmed = null; }
function applyMidi(m, val127) {
  const b = bands[m.bandIdx]; if (!b?.ui) return;
  const ref = b.ui.controls[m.key]; if (!ref?.el) return;
  const c = ref.ctl, min = parseFloat(ref.el.min), max = parseFloat(ref.el.max);
  if (isNaN(min) || isNaN(max)) return;
  const raw = min + (val127/127) * (max - min);
  ref.el.value = raw; b[m.key] = c.transform ? c.transform(raw) : raw;
  if (ref.valEl) ref.valEl.textContent = c.fmt(b[m.key]);
  if (c.apply) c.apply(b, b[m.key]);
}

function encodeWav(buffer) {
  const numCh=buffer.numberOfChannels, sr=buffer.sampleRate, len=buffer.length;
  const blockAlign=numCh*2, dataSize=len*blockAlign, ab=new ArrayBuffer(44+dataSize), view=new DataView(ab);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)view.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF');view.setUint32(4,36+dataSize,true);ws(8,'WAVE');ws(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,numCh,true);
  view.setUint32(24,sr,true);view.setUint32(28,sr*blockAlign,true);view.setUint16(32,blockAlign,true);view.setUint16(34,16,true);
  ws(36,'data');view.setUint32(40,dataSize,true);
  const chans=[];for(let c=0;c<numCh;c++)chans.push(buffer.getChannelData(c));
  let offset=44;
  for(let i=0;i<len;i++)for(let c=0;c<numCh;c++){let s=Math.max(-1,Math.min(1,chans[c][i]));s=s<0?s*0x8000:s*0x7FFF;view.setInt16(offset,s,true);offset+=2;}
  return new Blob([ab],{type:'audio/wav'});
}
async function renderWav() {
  const durSec = +$('export-dur').value, statusEl = $('export-status'), btn = $('export-wav');
  btn.disabled = true; statusEl.textContent = 'rendering…';
  try {
    const sr = audioCtx?.sampleRate || 44100;
    const off = new OfflineAudioContext(2, Math.floor(sr*durSec), sr);
    const mGain = off.createGain(); mGain.gain.value = parseFloat($('master-vol').value);
    const comp = off.createDynamicsCompressor(); comp.threshold.value=-12;comp.knee.value=10;comp.ratio.value=6;comp.attack.value=0.003;comp.release.value=0.15;
    mGain.connect(comp); comp.connect(off.destination);
    const dlyB = off.createGain(), revB = off.createGain();
    const oL=off.createDelay(CFG.DELAY_MAX),oR=off.createDelay(CFG.DELAY_MAX);
    const dt=Math.min((60/fxState.tempo)*fxState.subdiv,CFG.DELAY_MAX-0.05);
    oL.delayTime.value=dt;oR.delayTime.value=dt;
    const fb=Math.min(fxState.feedback,CFG.FB_MAX),fL=off.createGain(),fR=off.createGain();
    fL.gain.value=fb;fR.gain.value=fb;
    dlyB.connect(oL);oL.connect(fL);fL.connect(oR);oR.connect(fR);fR.connect(oL);
    const wL=off.createGain(),wR=off.createGain();wL.gain.value=fxState.dlyReturn;wR.gain.value=fxState.dlyReturn;
    oL.connect(wL);wL.connect(mGain);oR.connect(wR);wR.connect(mGain);
    const conv=off.createConvolver(),revOut=off.createGain();
    revB.connect(conv);conv.connect(revOut);revOut.connect(mGain);revOut.gain.value=fxState.revReturn;
    conv.buffer=makeImpulse(fxState.revPreset,off);
    const t0=0.05;
    for(let i=0;i<bands.length;i++) if(bands[i].enabled) buildOfflineBand(off,bands[i],mGain,dlyB,revB,t0,durSec);
    const rendered = await off.startRendering();
    downloadBlob(encodeWav(rendered), `pulseforge-${Date.now()}.wav`);
    statusEl.textContent = 'saved ✓';
  } catch(e) { console.error('WAV render error:', e); statusEl.textContent = 'error'; }
  btn.disabled = false;
  setTimeout(() => { if(statusEl.textContent==='saved ✓') statusEl.textContent='idle'; }, 2500);
}
function buildOfflineBand(off, b, mGain, dlyB, revB, t0, durSec) {
  let src, srcType = b.source;
  if (srcType === 'smp' && !b.sampleBuf) srcType = 'osc';
  const pulseGain = off.createGain(); pulseGain.gain.value = 0;
  const level = off.createGain(); level.gain.value = b.vol;
  const shaper = off.createWaveShaper(); shaper.oversample='2x';
  shaper.curve = b.drive > 0.001 ? makeDriveCurve(b.drive, b.driveType) : null;
  const filter = off.createBiquadFilter(); applyFilterType(filter,b.filterType,b.filterFreq,b.filterQ); filter.frequency.value=b.filterFreq;
  const panner = off.createStereoPanner(); panner.pan.value = b.pan;
  const fLFO = off.createOscillator(); fLFO.type='sine'; fLFO.frequency.value=b.filterLFORate;
  const fDepth = off.createGain(); fDepth.gain.value = b.filterLFODepth;
  if (srcType==='fm') {
    const car = clampOscFreq(b.carrier, off);
    src=off.createOscillator();src.type=b.cType;src.frequency.value=car;
    const mod=off.createOscillator();mod.type='sine';
    mod.frequency.value=fmModFrequency(car,b.fmRatio,off);
    const modG=off.createGain();modG.gain.value=(b.fmIndex||20)*car*0.05;mod.connect(modG);modG.connect(src.frequency);mod.start(t0);src.connect(pulseGain);
  }
  else if (srcType==='osc') { src=off.createOscillator();src.type=b.cType;src.frequency.value=clampOscFreq(b.carrier,off);src.connect(pulseGain); }
  else if (srcType==='sub') { src=off.createOscillator();src.type='sine';src.frequency.value=clampOscFreq(b.carrier*0.5,off);src.connect(pulseGain); }
  else { src=off.createBufferSource();src.buffer=srcType==='smp'?b.sampleBuf:makeNoiseBuffer(off,srcType);src.loop=true;src.playbackRate.value=Math.pow(2,b.pitch/12);src.connect(pulseGain); }
  pulseGain.connect(level);level.connect(shaper);shaper.connect(filter);filter.connect(panner);panner.connect(mGain);
  fLFO.connect(fDepth);fDepth.connect(filter.frequency);
  const dS=off.createGain();dS.gain.value=b.dlySend;const rS=off.createGain();rS.gain.value=b.revSend;
  panner.connect(dS);dS.connect(dlyB);panner.connect(rS);rS.connect(revB);
  const rate=CFG.OFFLINE_CURVE_RATE, n=Math.max(2,Math.floor(durSec*rate)), curve=new Float32Array(n+1), step=1/rate;
  let lp=0,pp=0;
  for(let i=0;i<=n;i++){const s=Math.sin(pp*TAU);curve[i]=Math.pow(s>0?s:0,b.sharp);if(i<n){const eff=getBandEffectiveParams(b);const durEff=Math.max(0.01,eff.dur);lp+=step/durEff;if(lp>=1)lp-=1;const cf=eff.pLow+(eff.pHigh-eff.pLow)*lfoValue(b.shape,lp);pp+=cf*step;pp-=Math.floor(pp);}}
  pulseGain.gain.setValueAtTime(0,0);pulseGain.gain.setValueCurveAtTime(curve,t0,durSec);
  if(src?.start)src.start(t0);fLFO.start(t0);
}

function envVisual(b, t) {
  if (t < 0) return 0;
  const a=Math.max(0.001,b.a), d=Math.max(0.005,b.d), s=b.s, r=Math.max(0.005,b.r), gate=b.lastStepDur||0.25;
  if (t < a) return t / a;
  if (t < a + d) return 1 + (s - 1) * ((t - a) / d);
  if (t < gate) return s;
  const rt = t - gate, rel = r * 4;
  return rt < rel ? s * (1 - rt / rel) : 0;
}
function updateBandVisual(b, nowA, dt) {
  if (b.enabled && isPlaying && audioCtx) {
    if (b.mode === 'seq') {
      b.curFreq = b.carrier;
      b.pulseVal = (b.lastTrig >= 0 ? envVisual(b, nowA - b.lastTrig) : 0) * b.vol;
    } else {
      const eff = getBandEffectiveParams(b);
      const step = CFG.VIS_STEP, durEff = Math.max(0.01, eff.dur);
      let n = Math.floor((nowA - b.visT) / step);
      if (n > 0) {
        if (n > CFG.VIS_MAX_CATCHUP) {
          const el = nowA - b.visT;
          b.visLfo += el / durEff; b.visLfo -= Math.floor(b.visLfo);
          b.visPulse += el * (eff.pLow + eff.pHigh) * 0.5; b.visPulse -= Math.floor(b.visPulse);
          b.visT = nowA;
        } else {
          for (let k = 0; k < n; k++) {
            b.visLfo += step / durEff; if (b.visLfo >= 1) b.visLfo -= 1;
            const cf = eff.pLow + (eff.pHigh - eff.pLow) * lfoValue(b.shape, b.visLfo);
            b.visPulse += cf * step; b.visPulse -= Math.floor(b.visPulse);
            b.curFreq = cf;
          }
          b.visT += n * step;
        }
      }
      const s = Math.sin(b.visPulse * TAU);
      b.pulseVal = Math.pow(s > 0 ? s : 0, b.sharp) * b.vol;
      if ((frameCount & 3) === (b._idx & 3)) b._miniDirty = true;
    }
  } else {
    b.pulseVal *= Math.exp(-10 * dt);
    if (b.pulseVal < 0.001) b.pulseVal = 0;
  }
}

function emitParticle(bi, cx, cy, r) {
  const o = pHead * P_STRIDE;
  pool[o]=Math.random()*TAU; pool[o+1]=r; pool[o+2]=cx; pool[o+3]=cy;
  pool[o+4]=25+Math.random()*50; pool[o+5]=1; pool[o+6]=0.6+Math.random()*1.2;
  pool[o+7]=1.5+Math.random()*2.5; pool[o+8]=bi;
  pHead = (pHead + 1) % CFG.PARTICLE_MAX;
  aliveParticles = Math.min(aliveParticles + 1, CFG.PARTICLE_MAX);
}
function drawParticles(dt, ctx) {
  if (aliveParticles === 0) return;
  let alive = 0;
  for (let i = 0; i < pool.length; i += P_STRIDE) {
    const life = pool[i+5];
    if (life <= 0) continue;
    const nl = life - pool[i+6] * dt;
    if (nl <= 0) { pool[i+5] = 0; continue; }
    alive++;
    pool[i+5] = nl; pool[i+1] += pool[i+4] * dt;
    const px = pool[i+2] + Math.cos(pool[i]) * pool[i+1];
    const py = pool[i+3] + Math.sin(pool[i]) * pool[i+1];
    ctx.beginPath();
    ctx.arc(px, py, Math.max(0.5, pool[i+7] * nl), 0, TAU);
    ctx.fillStyle = bands[pool[i+8]] ? bands[pool[i+8]].color : '#059669';
    ctx.globalAlpha = nl * 0.6;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  aliveParticles = alive;
}
function buildGrid() {
  gridLayer = document.createElement('canvas');
  gridLayer.width = vizCanvas.width; gridLayer.height = vizCanvas.height;
  const g = gridLayer.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.strokeStyle = cachedGridLine; g.lineWidth = 0.5;
  for (let x = CFG.GRID; x < vizW; x += CFG.GRID) { g.beginPath(); g.moveTo(x,0); g.lineTo(x,vizH); g.stroke(); }
  for (let y = CFG.GRID; y < vizH; y += CFG.GRID) { g.beginPath(); g.moveTo(0,y); g.lineTo(vizW,y); g.stroke(); }
}
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, CFG.MAX_DPR);
  vizW = vizCanvas.clientWidth; vizH = vizCanvas.clientHeight;
  vizCanvas.width = vizW * dpr; vizCanvas.height = vizH * dpr;
  vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  waveW = waveCanvas.clientWidth; waveH = waveCanvas.clientHeight;
  waveCanvas.width = waveW * dpr; waveCanvas.height = waveH * dpr;
  waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.ui?.lfoCanvas) {
      const c = b.ui.lfoCanvas;
      b.ui.lfoW = c.clientWidth; b.ui.lfoH = c.clientHeight;
      c.width = b.ui.lfoW * dpr; c.height = b.ui.lfoH * dpr;
      b.ui.lfoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      b._miniDirty = true;
    }
  }
  buildGrid();
}
let frameCount = 0;

function spectrumTierCount(n) {
  if (n >= 48) return CFG.VIZ_SPECTRUM_TIERS_48;
  if (n >= 36) return CFG.VIZ_SPECTRUM_TIERS_36;
  return 4;
}

/** Classic concentric rings — best for ≤23 bands. */
function drawVizClassic(drawList, cx, cy) {
  const ringSpacing = Math.min(vizH, vizW) * (0.35 / Math.max(1, drawList.length));
  for (let vi = 0; vi < drawList.length; vi++) {
    const b = drawList[vi];
    const bandCx = cx + b.pan * (vizW * CFG.PAN_VIS_WIDTH);
    const baseR = Math.max(10, 14 + vi * ringSpacing);
    const pR = baseR + b.pulseVal * CFG.PULSE_RADIUS;
    if (!b.enabled && b.pulseVal < 0.01) {
      vizCtx.beginPath(); vizCtx.arc(bandCx, cy, baseR, 0, TAU);
      vizCtx.strokeStyle = b.color; vizCtx.lineWidth = 0.5; vizCtx.globalAlpha = 0.15;
      vizCtx.stroke(); vizCtx.globalAlpha = 1; continue;
    }
    vizCtx.beginPath(); vizCtx.arc(bandCx, cy, pR, 0, TAU);
    vizCtx.strokeStyle = b.color;
    vizCtx.lineWidth = 1.5 + b.pulseVal * 3;
    vizCtx.globalAlpha = 0.45 + b.pulseVal * 0.55;
    vizCtx.stroke();
    vizCtx.lineWidth = 4 + b.pulseVal * 8;
    vizCtx.globalAlpha = 0.12 + b.pulseVal * 0.2;
    vizCtx.stroke();
    const alpha = (b.pulseVal * 0.18).toFixed(3);
    const grad = vizCtx.createRadialGradient(bandCx, cy, Math.max(1, pR - 10), bandCx, cy, pR + 4);
    grad.addColorStop(0, `rgba(${b.rgb},0)`);
    grad.addColorStop(1, `rgba(${b.rgb},${alpha})`);
    vizCtx.beginPath(); vizCtx.arc(bandCx, cy, pR + 4, 0, TAU);
    vizCtx.fillStyle = grad; vizCtx.fill();
    if (drawList.length <= 18) {
      vizCtx.font = '9px "Space Mono"'; vizCtx.fillStyle = b.color;
      vizCtx.globalAlpha = 0.6 + b.pulseVal * 0.4; vizCtx.textAlign = 'center';
      vizCtx.fillText(b.name, bandCx, cy - pR - 8); vizCtx.globalAlpha = 1;
    }
    if (!REDUCED && isPlaying && b.enabled && b.pulseVal > 0.7 * b.vol && Math.random() < 0.35) {
      emitParticle(b._idx, bandCx, cy, pR);
    }
  }
}

/**
 * Orbital constellation viz for 24–48 bands — tier rings with nodes by index + pan.
 * Avoids overcrowded concentric stacks while keeping pulse glow + particles.
 */
function drawVizConstellation(layoutList, cx, cy) {
  const n = layoutList.length;
  const tiers = spectrumTierCount(n);
  const perTier = Math.ceil(n / tiers);
  const maxR = Math.min(vizW, vizH) * 0.44;
  const minR = Math.max(14, maxR * 0.14);

  for (let t = 0; t < tiers; t++) {
    const tierT = tiers > 1 ? t / (tiers - 1) : 0;
    const orbitR = minR + tierT * (maxR - minR);
    vizCtx.beginPath();
    vizCtx.arc(cx, cy, orbitR, 0, TAU);
    vizCtx.strokeStyle = cachedGridLine;
    vizCtx.lineWidth = 0.6;
    vizCtx.globalAlpha = 0.28 + tierT * 0.12;
    vizCtx.stroke();
    vizCtx.globalAlpha = 1;
  }

  for (let i = 0; i < n; i++) {
    const b = layoutList[i];
    const idx = b._idx ?? i;
    const tier = Math.min(tiers - 1, Math.floor(idx / perTier));
    const posInTier = idx % perTier;
    const countInTier = Math.min(perTier, n - tier * perTier);
    const tierT = tiers > 1 ? tier / (tiers - 1) : 0;
    const baseR = minR + tierT * (maxR - minR);
    const angleSpread = TAU / Math.max(1, countInTier);
    const angle = -Math.PI / 2 + posInTier * angleSpread + b.pan * 0.4;
    const px = cx + Math.cos(angle) * baseR;
    const py = cy + Math.sin(angle) * baseR;
    const pulseR = 3.5 + b.pulseVal * (8 + tier * 1.2);
    const lit = b.enabled || b.pulseVal > 0.01;

    if (!lit) {
      vizCtx.beginPath();
      vizCtx.arc(px, py, 2, 0, TAU);
      vizCtx.fillStyle = b.color;
      vizCtx.globalAlpha = 0.18;
      vizCtx.fill();
      vizCtx.globalAlpha = 1;
      continue;
    }

    if (b.pulseVal > 0.15) {
      vizCtx.beginPath();
      vizCtx.moveTo(cx, cy);
      vizCtx.lineTo(px, py);
      vizCtx.strokeStyle = b.color;
      vizCtx.lineWidth = 0.6;
      vizCtx.globalAlpha = Math.min(0.22, b.pulseVal * 0.18);
      vizCtx.stroke();
      vizCtx.globalAlpha = 1;
    }

    const glow = vizCtx.createRadialGradient(px, py, 0, px, py, pulseR + 8);
    glow.addColorStop(0, `rgba(${b.rgb},${(0.2 + b.pulseVal * 0.45).toFixed(3)})`);
    glow.addColorStop(1, `rgba(${b.rgb},0)`);
    vizCtx.beginPath();
    vizCtx.arc(px, py, pulseR + 8, 0, TAU);
    vizCtx.fillStyle = glow;
    vizCtx.fill();

    vizCtx.beginPath();
    vizCtx.arc(px, py, pulseR, 0, TAU);
    vizCtx.strokeStyle = b.color;
    vizCtx.lineWidth = 1 + b.pulseVal * 2.2;
    vizCtx.globalAlpha = 0.55 + b.pulseVal * 0.45;
    vizCtx.stroke();
    vizCtx.globalAlpha = 1;

    if (b.pulseVal > 0.35) {
      vizCtx.beginPath();
      vizCtx.arc(px, py, pulseR * 0.45, 0, TAU);
      vizCtx.fillStyle = b.color;
      vizCtx.globalAlpha = 0.35 + b.pulseVal * 0.4;
      vizCtx.fill();
      vizCtx.globalAlpha = 1;
    }

    if (n <= 36 && b.pulseVal > 0.25) {
      vizCtx.font = '8px "Space Mono"';
      vizCtx.fillStyle = b.color;
      vizCtx.globalAlpha = 0.55 + b.pulseVal * 0.35;
      vizCtx.textAlign = 'center';
      vizCtx.fillText(b.name, px, py - pulseR - 5);
      vizCtx.globalAlpha = 1;
    }

    if (!REDUCED && isPlaying && b.enabled && b.pulseVal > 0.6 * b.vol && Math.random() < 0.22) {
      emitParticle(b._idx, px, py, pulseR);
    }
  }
}

function drawViz(dt) {
  const cx = vizW / 2, cy = vizH / 2;
  vizCtx.fillStyle = cachedCanvasBg;
  vizCtx.fillRect(0, 0, vizW, vizH);
  if (gridLayer) vizCtx.drawImage(gridLayer, 0, 0, vizW, vizH);

  const layoutList = bands;
  const useConstellation = layoutList.length >= CFG.VIZ_DENSE_BANDS;

  if (useConstellation) {
    drawVizConstellation(layoutList, cx, cy);
  } else {
    const vizBands = [];
    for (let i = 0; i < bands.length; i++) {
      if (bands[i].enabled || bands[i].pulseVal > 0.01) vizBands.push(bands[i]);
    }
    const drawList = vizBands.length ? vizBands : bands;
    drawVizClassic(drawList, cx, cy);
  }

  drawParticles(dt, vizCtx);
  let total = 0;
  for (let i = 0; i < bands.length; i++) total += bands[i].pulseVal;
  const avg = bands.length ? total / bands.length : 0;
  const cR = Math.max(1, 8 + avg * 18);
  const cGrad = vizCtx.createRadialGradient(cx, cy, 0, cx, cy, cR);
  cGrad.addColorStop(0, `rgba(217,119,6,${(0.6 + avg * 0.4).toFixed(3)})`);
  cGrad.addColorStop(1, 'rgba(217,119,6,0)');
  vizCtx.beginPath(); vizCtx.arc(cx, cy, cR, 0, TAU);
  vizCtx.fillStyle = cGrad; vizCtx.fill();
}
function drawWaveform() {
  if (frameCount % CFG.WAVEFORM_DRAW_INTERVAL !== 0) return;
  waveCtx.fillStyle = cachedCanvasBg;
  waveCtx.fillRect(0, 0, waveW, waveH);
  if (!analyser) {
    waveCtx.strokeStyle = 'rgba(217,119,6,0.2)'; waveCtx.lineWidth = 1;
    waveCtx.beginPath(); waveCtx.moveTo(0, waveH/2); waveCtx.lineTo(waveW, waveH/2); waveCtx.stroke();
    return;
  }
  analyser.getByteTimeDomainData(scopeBuf);
  waveCtx.strokeStyle = 'rgba(217,119,6,0.85)'; waveCtx.lineWidth = 1.5;
  waveCtx.beginPath();
  const n = scopeBuf.length, step = Math.max(1, Math.floor(n / waveW));
  for (let i = 0; i < n; i += step) {
    const x = (i/n)*waveW, y = (scopeBuf[i]/128)*waveH/2;
    i === 0 ? waveCtx.moveTo(x, y) : waveCtx.lineTo(x, y);
  }
  waveCtx.stroke();
}
function drawLFOMini(b) {
  if (!b.ui?.lfoCtx) return;
  const playingAnim = b.enabled && isPlaying;
  const interval = CFG.LFO_MINI_FRAME_INTERVAL || 4;
  if (!b._miniDirty && !(playingAnim && (frameCount % interval === (b._idx % interval)))) return;
  b._miniDirty = false;
  const ctx = b.ui.lfoCtx, w = b.ui.lfoW, h = b.ui.lfoH;
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  const isDark = document.body.classList.contains('dark-mode');
  ctx.fillStyle = isDark ? 'rgba(8,8,13,0.6)' : 'rgba(244,243,239,0.85)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = isDark ? 'rgba(30,30,50,0.5)' : 'rgba(210,205,195,0.6)';
  ctx.lineWidth = 0.5;
  for (const f of [0.25,0.5,0.75]) { ctx.beginPath();ctx.moveTo(0,h*f);ctx.lineTo(w,h*f);ctx.stroke(); }
  if (b.mode === 'seq') {
    const a=Math.max(0.001,b.a),d=Math.max(0.005,b.d),s=b.s,r=Math.max(0.005,b.r),gate=b.lastStepDur||0.25;
    const total=Math.max(a+d,gate)+r*4, xOf=t=>(t/total)*w, yOf=v=>h-v*h*0.8-h*0.1;
    ctx.strokeStyle=b.color;ctx.lineWidth=1.5;ctx.beginPath();
    ctx.moveTo(0,yOf(0));ctx.lineTo(xOf(a),yOf(1));ctx.lineTo(xOf(a+d),yOf(s));ctx.lineTo(xOf(gate),yOf(s));ctx.lineTo(xOf(gate+r*4),yOf(0));ctx.stroke();
    if (b.lastTrig>=0&&isPlaying&&audioCtx) { const t=audioCtx.currentTime-b.lastTrig,v=envVisual(b,t); ctx.beginPath();ctx.arc(Math.min(xOf(t),w),yOf(v),3.5,0,TAU);ctx.fillStyle=b.color;ctx.fill(); }
    return;
  }
  ctx.beginPath();ctx.strokeStyle=b.color;ctx.lineWidth=1.5;
  for (let px=0;px<=w;px++) { const y=h-lfoValue(b.shape,px/w)*h*0.8-h*0.1; px===0?ctx.moveTo(px,y):ctx.lineTo(px,y); }
  ctx.stroke();ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();ctx.fillStyle=`rgba(${b.rgb},0.12)`;ctx.fill();
  const dotX=b.visLfo*w, dotY=h-lfoValue(b.shape,b.visLfo)*h*0.8-h*0.1;
  ctx.strokeStyle=`rgba(${b.rgb},0.4)`;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(dotX,0);ctx.lineTo(dotX,h);ctx.stroke();
  ctx.beginPath();ctx.arc(dotX,dotY,4,0,TAU);ctx.fillStyle=b.color;ctx.fill();
  ctx.strokeStyle=isDark?'#08080D':'#F4F3EF';ctx.lineWidth=1.5;ctx.stroke();
}
function formatBandPulseReadout(b) {
  const hzLabel = b.carrier >= 1000
    ? `${(b.carrier / 1000).toFixed(2)} kHz`
    : `${b.carrier} Hz`;
  if (bands.length >= CFG.VIZ_DENSE_BANDS) return hzLabel;
  if (b.source === 'smp') return 'SMP';
  if (b.source === 'white' || b.source === 'pink' || b.source === 'brown') return b.source.toUpperCase();
  if (b.mode === 'seq') return hzLabel;
  const eff = getBandEffectiveParams(b);
  const mid = (eff.pLow + eff.pHigh) * 0.5;
  const pulseBpm = Math.round(mid * 60);
  if (b.bpmSync) {
    return `${eff.pLow.toFixed(2)}–${eff.pHigh.toFixed(2)} Hz · ~${pulseBpm} BPM`;
  }
  return `${eff.pLow.toFixed(2)}–${eff.pHigh.toFixed(2)} Hz`;
}

function updateUI() {
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i], u = b.ui;
    if (!u) continue;
    if (b.enabled !== u._active) { u._active=b.enabled; u.card.classList.toggle('active',b.enabled); u.toggle.classList.toggle('on',b.enabled); u.toggle.setAttribute('aria-checked',String(b.enabled)); }
    const lit = b.pulseVal > 0.15;
    if (lit !== u._lit) { u._lit=lit; u.dot.classList.toggle('lit',lit); }
    u.dot.style.transform = `scale(${(1+b.pulseVal*1.5).toFixed(3)})`;
    const ft = formatBandPulseReadout(b);
    if (ft !== u._freq) { u._freq=ft; u.freqDisp.textContent=ft; }
  }
}

function animate(time) {
  requestAnimationFrame(animate);
  if (renderSuspended || document.visibilityState === 'hidden') { lastFrameT = time; return; }
  const dt = Math.min((time - lastFrameT) / 1000, 0.1);
  lastFrameT = time; frameCount++;
  const nowA = audioCtx ? audioCtx.currentTime : performance.now() / 1000;
  if (!audioCtx || !isPlaying) { updateTempoRamp(nowA); processMicSignal(); }
  for (let i = 0; i < bands.length; i++) updateBandVisual(bands[i], nowA, dt);
  drawViz(dt);
  drawWaveform();
  for (let i = 0; i < bands.length; i++) drawLFOMini(bands[i]);
  updateTransportVisual(nowA);
  updateUI();
  maybeRenderLog(time);
}

playBtn.addEventListener('click', () => setPlaying(!isPlaying));
$('master-vol').addEventListener('input', e => { const v=parseFloat(e.target.value); $('master-vol-val').textContent=Math.round(v*100)+'%'; if(masterGain)smooth(masterGain.gain,v,CFG.UI_TAU); });
const audioOutputSel = $('audio-output-select');
if (audioOutputSel) {
  audioOutputSel.addEventListener('change', () => { applyAudioSink(audioOutputSel.value); });
}
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => { refreshAudioOutputList(); });
}
$('btn-add-band').addEventListener('click', () => addBand());
$('btn-conductor').addEventListener('click', () => { conductorActive=!conductorActive; $('btn-conductor').setAttribute('aria-pressed',String(conductorActive)); if(!conductorActive)$('conductor-status').textContent='idle'; logParamChange('Conductor','System','Mode',conductorActive?'Active':'Idle'); });
$('btn-gen-preset').addEventListener('click', () => { const type=$('preset-gen-select').value; if(!type)return; applyState(generatePresetState(type)); flashBtn('btn-gen-preset'); });
$('btn-export-csv').addEventListener('click', exportLogCsv);
$('btn-clear-log').addEventListener('click', clearLog);
$('btn-sync-all').addEventListener('click', () => { const anyOff=bands.some(b=>!b.bpmSync); bands.forEach(b=>{b.bpmSync=anyOff;const sb=b.ui?.card.querySelector('[data-ctl="bpmSync"]');if(sb)sb.setAttribute('aria-pressed',String(anyOff));updateBandSyncParams(b);b._miniDirty=true;}); });
$('mic-enable').addEventListener('click', toggleMicInput);
$('mic-beat-track').addEventListener('click', () => { micBeatTrack=!micBeatTrack; $('mic-beat-track').setAttribute('aria-pressed',String(micBeatTrack)); if(micBeatTrack&&!micActive)toggleMicInput(); logParamChange('Mic','System','Beat Track',micBeatTrack?'On':'Off'); });
$('mic-sync-all').addEventListener('click', () => { const anyOff=bands.some(b=>!b.micSync); bands.forEach(b=>{b.micSync=anyOff;const mb=b.ui?.card.querySelector('[data-ctl="micSync"]');if(mb)mb.setAttribute('aria-pressed',String(anyOff));}); if(anyOff&&!micActive)toggleMicInput(); });
$('btn-enable-all').addEventListener('click', () => bands.forEach(b => setBandEnabled(b, true)));
$('btn-disable-all').addEventListener('click', () => bands.forEach(b => setBandEnabled(b, false)));
$('preset-save').addEventListener('click', saveCurrentPreset);
$('preset-load').addEventListener('click', loadSelectedPreset);
$('preset-del').addEventListener('click', deleteSelectedPreset);
$('preset-export').addEventListener('click', exportPresetJson);
$('preset-import').addEventListener('click', () => $('preset-file').click());
$('preset-file').addEventListener('change', e => { if(e.target.files[0])importPresetJson(e.target.files[0]); e.target.value=''; });
$('pack-export').addEventListener('click', exportPresetPack);
$('pack-import').addEventListener('click', () => $('pack-file').click());
$('pack-file').addEventListener('change', e => { if(e.target.files[0])importPresetPack(e.target.files[0]); e.target.value=''; });
$('midi-enable').addEventListener('click', toggleMidi);
$('midi-learn').addEventListener('click', () => { midiLearnActive ? exitLearn() : enterLearn(); });
$('export-wav').addEventListener('click', renderWav);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    lastFrameT = performance.now(); renderSuspended = false;
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    if (wakeRequested && !wakeSentinel) setWakeLock(true);
  } else { renderSuspended = true; }
});
themeBtn.addEventListener('click', () => {
  const isDark = document.body.classList.toggle('dark-mode');
  themeBtn.textContent = isDark ? 'Dark' : 'Light';
  themeBtn.setAttribute('aria-pressed', String(isDark));
  cacheThemeColors();
  buildGrid();
  for (let i = 0; i < bands.length; i++) bands[i]._miniDirty = true;
});
modeBtn.addEventListener('click', async () => {
  latencyMode = latencyMode === 'live' ? 'ambient' : 'live';
  modeBtn.textContent = latencyMode === 'live' ? 'Live' : 'Ambient';
  modeBtn.setAttribute('aria-pressed', String(latencyMode === 'ambient'));
  if (audioCtx) {
    const was = isPlaying;
    if (was) await setPlaying(false);
    try { await audioCtx.close(); } catch(_) {}
    audioCtx=null;masterGain=null;rampSilenceGain=null;analyser=null;
    dlyBus=dlyL=dlyR=dampL=dampR=fbGainL=fbGainR=dlyWetL=dlyWetR=null;
    revBus=convolver=revWet=null; engineMode='—'; updateSysUI();
    if (was) await setPlaying(true);
  }
});
wakeBtn.addEventListener('click', () => setWakeLock(!wakeRequested));
if (!('wakeLock' in navigator)) { wakeBtn.disabled = true; wakeBtn.title = 'Not supported'; }
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title:'PulseForge', artist:'PulseForge', album:'Web Audio', artwork:[{src:ART_SVG,sizes:'512x512',type:'image/svg+xml'}] });
    navigator.mediaSession.setActionHandler('play', () => setPlaying(true));
    navigator.mediaSession.setActionHandler('pause', () => setPlaying(false));
    navigator.mediaSession.setActionHandler('stop', () => setPlaying(false));
  } catch(_) {}
}

buildCards(); buildTransportGrid(); wireFx(); wireTransport();
syncBandViewUI();
for (const mode of ['full', 'groups', 'compact']) {
  const btn = $(`band-view-${mode}`);
  if (btn) btn.addEventListener('click', () => setBandViewMode(mode));
}
refreshPresetList(); renderLogTable(); setDelayTime();
updateFxReadouts(); updateFxLeds();
playBtn.innerHTML = ICON_PLAY + 'START';
updateSysUI();
updateBandCountUI();
refreshAudioOutputList();
if ($('btn-expand-36')) $('btn-expand-36').addEventListener('click', () => {
  const n = expandBandsTo(CFG.ARC_STREAM_BANDS);
  if (n) flashBtn('btn-expand-36');
});
let resizePending = false;
const ro = new ResizeObserver(() => { if(resizePending)return; resizePending=true; requestAnimationFrame(()=>{resizePending=false;resize();}); });
ro.observe(vizCanvas); ro.observe(waveCanvas);
resize();
lastFrameT = performance.now();
requestAnimationFrame(animate);
}

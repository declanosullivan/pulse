import { CFG, TAU } from './config.js';

export const $ = (id) => document.getElementById(id);

export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function euclidPattern(hits, steps, rotate) {
  const n = steps;
  const h = Math.max(0, Math.min(n, Math.round(hits)));
  const base = new Array(n).fill(0);
  if (h >= n) base.fill(1);
  else if (h > 0) {
    let bucket = 0;
    for (let i = 0; i < n; i++) {
      bucket += h;
      if (bucket >= n) {
        bucket -= n;
        base[i] = 1;
      }
    }
  }
  const r = ((rotate % n) + n) % n;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = base[(i - r + n) % n];
  return out;
}

export function lfoValue(shape, p) {
  if (shape === 'triangle') return p < 0.5 ? p * 2 : 2 - p * 2;
  if (shape === 'sine') return 0.5 - 0.5 * Math.cos(p * TAU);
  return p;
}

export function panLabel(pan) {
  const v = Math.round(pan * 100);
  return v === 0 ? 'C' : (v > 0 ? 'R' : 'L') + Math.abs(v);
}

export function truncName(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

export function makeDriveCurve(amount, type = 'tanh') {
  const n = CFG.DRIVE_CURVE_N;
  const curve = new Float32Array(n);
  const k = Math.max(0.01, amount * 12);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    if (type === 'fold') curve[i] = Math.sin(x * k * Math.PI * 0.75);
    else if (type === 'crush') {
      const steps = Math.pow(2, Math.max(2, Math.floor(16 - amount * 13.5)));
      curve[i] = Math.round(x * steps) / steps;
    } else if (type === 'tube') {
      curve[i] = x >= 0 ? Math.tanh(x * k) : Math.tanh(x * k * 0.55) * 1.25;
    } else {
      const norm = Math.tanh(k);
      curve[i] = Math.tanh(x * k) / norm;
    }
  }
  return curve;
}

export function applyFilterType(filter, type, freq, q) {
  if (!filter) return;
  switch (type) {
    case 'highpass':
      filter.type = 'highpass';
      break;
    case 'bandpass':
      filter.type = 'bandpass';
      break;
    case 'notch':
      filter.type = 'notch';
      break;
    case 'ladder':
      filter.type = 'lowpass';
      filter.Q.value = Math.max(1, q * 1.8);
      break;
    case 'formant':
      filter.type = 'peaking';
      filter.Q.value = Math.max(2, q * 2.5);
      break;
    case 'comb':
      filter.type = 'allpass';
      filter.Q.value = Math.max(1, q * 2.0);
      break;
    default:
      filter.type = 'lowpass';
      break;
  }
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 100);
}

export function flashBtn(id) {
  const el = $(id);
  if (!el) return;
  const t = el.textContent;
  el.textContent = '✓';
  setTimeout(() => {
    el.textContent = t;
  }, 900);
}

/** Fill a mono buffer with white / pink / brown noise (shared implementation). */
export function fillNoiseChannel(data, type) {
  const len = data.length;
  if (type === 'pink') {
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return;
  }
  if (type === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    return;
  }
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
}

export function makeNoiseBuffer(ctx, type) {
  const sr = ctx.sampleRate;
  const len = sr * CFG.NOISE_SEC;
  const buf = ctx.createBuffer(1, len, sr);
  fillNoiseChannel(buf.getChannelData(0), type);
  return buf;
}

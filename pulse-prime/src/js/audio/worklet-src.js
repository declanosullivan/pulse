/** AudioWorklet processor source (inlined for CSP-friendly blob/data URL loading). */
export const WORKLET_SRC = `
class PulseVoice extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pLow', defaultValue: 1, minValue: 0.001, maxValue: 2000 },
      { name: 'pHigh', defaultValue: 4, minValue: 0.001, maxValue: 2000 },
      { name: 'dur', defaultValue: 8, minValue: 0.01, maxValue: 600 },
      { name: 'sharp', defaultValue: 2, minValue: 1, maxValue: 8 },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 2 },
      { name: 'gate', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    this.lfoPhase = 0;
    this.pulsePhase = 0;
  }
  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const pLow = parameters.pLow[0];
    const pHigh = parameters.pHigh[0];
    const dur = Math.max(0.01, parameters.dur[0]);
    const sharp = parameters.sharp[0];
    const shape = parameters.shape[0];
    const gate = parameters.gate[0];
    const dt = 1 / sampleRate;
    for (let i = 0; i < out.length; i++) {
      const s = Math.sin(this.pulsePhase * 6.2831853);
      out[i] = Math.pow(s > 0 ? s : 0, sharp) * gate;
      this.lfoPhase += dt / dur;
      if (this.lfoPhase >= 1) this.lfoPhase -= 1;
      const lfo =
        shape === 1
          ? this.lfoPhase < 0.5
            ? this.lfoPhase * 2
            : 2 - this.lfoPhase * 2
          : shape === 2
            ? 0.5 - 0.5 * Math.cos(this.lfoPhase * 6.2831853)
            : this.lfoPhase;
      const cf = pLow + (pHigh - pLow) * lfo;
      this.pulsePhase += cf * dt;
      this.pulsePhase -= Math.floor(this.pulsePhase);
    }
    return true;
  }
}
registerProcessor('pulse-voice', PulseVoice);
`;

export const TICKER_SRC = `
let id = null;
self.onmessage = (e) => {
  if (e.data === 'start') {
    id = setInterval(() => self.postMessage('tick'), 25);
  } else if (e.data === 'stop') {
    clearInterval(id);
    id = null;
  }
};
`;

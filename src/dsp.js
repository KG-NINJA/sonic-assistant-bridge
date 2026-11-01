// Original implementation inspired by SoundWave (Gupta et al., CHI 2012).
// No distance/person classifier: Doppler motion and direct-path attenuation evidence.
export const FFT_SIZE = 16384;
/** @typedef {{state: string, score: number, reason?: string, dropDb?: number, progress?: number, pilotDb?: number, pilotRiseDb?: number, calibrated?: boolean, event?: boolean, toward?: number, away?: number, shiftHz?: number, sampleRate?: number, excludedFrames?: number}} DetectionResult */
const EPS = 1e-15;
/** @param {number[]} values */
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
/** @param {number} power */
const db = power => 10 * Math.log10(Math.max(EPS, power));

export class Spectrum {
  constructor(size = FFT_SIZE) {
    if (size < 8 || (size & (size - 1))) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.real = new Float64Array(size);
    this.imag = new Float64Array(size);
    this.power = new Float64Array(size / 2);
    this.window = Float64Array.from({ length: size }, (_, i) =>
      0.42 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (size - 1)));
    this.scale = 4 / this.window.reduce((s, v) => s + v, 0) ** 2;
  }
  /** @param {Float32Array} samples */
  transform(samples) {
    if (samples.length !== this.size) throw new Error('Invalid audio frame size');
    const { real: re, imag: im, size: n } = this;
    im.fill(0);
    let clip = 0;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(samples[i])) throw new Error('Non-finite audio sample');
      re[i] = samples[i] * this.window[i];
      if (Math.abs(samples[i]) >= 0.98) clip++;
    }
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) [re[i], re[j]] = [re[j], re[i]];
    }
    for (let len = 2; len <= n; len <<= 1) {
      const angle = -2 * Math.PI / len;
      const wr = Math.cos(angle), wi = Math.sin(angle);
      for (let start = 0; start < n; start += len) {
        let ur = 1, ui = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = start + j, b = a + len / 2;
          const vr = re[b] * ur - im[b] * ui, vi = re[b] * ui + im[b] * ur;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
          [ur, ui] = [ur * wr - ui * wi, ur * wi + ui * wr];
        }
      }
    }
    for (let i = 0; i < this.power.length; i++) this.power[i] = (re[i] ** 2 + im[i] ** 2) * this.scale;
    return { power: this.power, clipped: clip / n > 0.001 };
  }
}

export class DopplerDetector {
  constructor({ sampleRate = 48000, frequency = 20500, threshold = 8, calibrationFrames = 80 } = {}) {
    if (!Number.isFinite(sampleRate) || !Number.isFinite(frequency) || frequency < 18000 || frequency > 21500 || frequency + 550 >= sampleRate / 2)
      throw new Error('このサンプルレートでは選択した周波数を解析できません。周波数を下げてください。');
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 20 || !Number.isInteger(calibrationFrames) || calibrationFrames < 10)
      throw new Error('Invalid detector configuration');
    this.sampleRate = sampleRate;
    this.frequency = frequency;
    this.threshold = threshold;
    this.exaggerated = threshold <= 1;
    this.sensitive = threshold <= 3;
    this.guardHz = this.sensitive ? 18 : 35;
    this.motionDwell = this.exaggerated ? 0.15 : this.sensitive ? 0.6 : 0.3;
    this.calibrationFrames = calibrationFrames;
    this.binHz = sampleRate / FFT_SIZE;
    this.center = Math.round(frequency / this.binHz);
    this.bins = [];
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      const offset = i * this.binHz - frequency;
      if (Math.abs(offset) >= this.guardHz && Math.abs(offset) <= 450) this.bins.push({ i, offset });
    }
    this.reset();
  }
  reset() {
    this.baseline = null;
    this.frames = [];
    this.pilotLevels = [];
    this.clearMotion();
  }
  clearMotion() {
    this.candidate = 'CALM'; this.since = null; this.lastTime = null;
    this.state = 'CALM'; this.lastAlert = -Infinity;
    this.reason = ''; this.occluded = false;
  }
  /** @param {Float64Array} power */
  pilotLevel(power) {
    let peak = 0;
    for (let i = this.center - 2; i <= this.center + 2; i++) peak = Math.max(peak, power[i]);
    return db(peak);
  }
  /** @param {number[] | null} frame @param {number} pilotDb @returns {DetectionResult} */
  calibrate(frame, pilotDb) {
    // Keep recent spectra only. Transient noise must not raise the permanent baseline.
    this.frames.push(frame);
    this.pilotLevels.push(pilotDb);
    if (this.frames.length > Math.ceil(this.calibrationFrames * 1.5)) {
      this.frames.shift(); this.pilotLevels.shift();
    }
    const valid = this.frames.flatMap((values, i) => values ? [{ values, pilot: this.pilotLevels[i] }] : []);
    const waiting = (count, excluded) => ({ state: excluded ? 'CALIBRATION_NOISE' : 'CALIBRATING', score: 0,
      progress: Math.min(0.99, count / this.calibrationFrames), pilotDb, excludedFrames: excluded });
    if (valid.length < this.calibrationFrames) return waiting(valid.length, this.frames.length - valid.length);
    const center = this.bins.map((_, j) => median(valid.map(f => f.values[j])));
    const pilotCenter = median(valid.map(f => f.pilot));
    const relevantFloor = this.sensitive ? -60 : -48;
    const clean = valid.filter(f => {
      if (Math.abs(f.pilot - pilotCenter) > 4) return false;
      let run = 0;
      for (let j = 0; j < center.length; j++) {
        if (j && this.bins[j].i !== this.bins[j - 1].i + 1) run = 0;
        // Quiet dips are ordinary noise-floor variation, not a corrupting sound burst.
        const changed = f.values[j] > relevantFloor && f.values[j] - center[j] > 8;
        run = changed ? run + 1 : 0;
        if (run >= 3) return false;
      }
      return true;
    });
    const excluded = this.frames.length - clean.length;
    // A stable majority plus a full set of clean frames is required. Interference cannot
    // complete calibration merely by exhausting a timer or collecting a few quiet gaps.
    if (clean.length < this.calibrationFrames || clean.length < this.frames.length * 0.8 || !clean.some(f => f.values === frame))
      return waiting(clean.length, excluded);
    this.baseline = center.map((_, j) => {
      const values = clean.map(f => f.values[j]).sort((a, b) => a - b);
      return Math.max(this.exaggerated ? -72 : this.sensitive ? -65 : -55, values[Math.floor(values.length * 0.9)]);
    });
    this.referencePilot = median(clean.map(f => f.pilot));
    this.frames = []; this.pilotLevels = [];
    return { state: 'CALM', score: 0, pilotDb, calibrated: true, excludedFrames: excluded };
  }
  /** @param {Float64Array} power @param {number} time @returns {DetectionResult} */
  process(power, time, clipped = false) {
    if (power.length !== FFT_SIZE / 2 || !Number.isFinite(time) || power.some(v => !Number.isFinite(v) || v < 0)) {
      this.clearMotion();
      return { state: 'INVALID', score: 0, event: false };
    }
    const pilotDb = this.pilotLevel(power);
    if (this.lastTime !== null && (time <= this.lastTime || time - this.lastTime > 0.5)) this.clearMotion();
    if (clipped && !this.baseline) return this.calibrate(null, pilotDb);
    // After qualification, attenuation (including silence) is an obstruction cue.
    // It cannot distinguish a hand/person from speaker muting or gain reduction.
    const dropDb = this.baseline ? this.referencePilot - pilotDb : 0;
    if (this.baseline && !clipped && (pilotDb < -75 || dropDb >= (this.exaggerated ? (this.occluded ? 1 : 2) : (this.occluded ? 4 : 6)))) {
      this.occluded = true;
      return this.transition('APPROACH', time, { score: dropDb, dropDb, pilotDb, reason: 'occlusion' });
    }
    this.occluded = false;
    const unhealthy = clipped ? 'CLIPPING' : pilotDb < -75 ? 'NO_SIGNAL' : null;
    if (unhealthy) {
      if (!this.baseline) { this.frames = []; this.pilotLevels = []; }
      this.clearMotion();
      return { state: unhealthy, score: 0, event: false, pilotDb };
    }
    const normalized = this.bins.map(({ i }) => db(power[i]) - pilotDb);
    if (!this.baseline) return this.calibrate(normalized, pilotDb);
    if (pilotDb - this.referencePilot > 12) {
      this.clearMotion();
      return { state: 'SIGNAL_CHANGED', score: 0, event: false, pilotDb };
    }
    let toward = 0, away = 0, shiftHz = 0;
    // Three adjacent bins: suppress isolated spectral spikes and require a resolved sideband.
    for (let j = 1; j < this.bins.length - 1; j++) {
      if (this.bins[j + 1].i - this.bins[j - 1].i !== 2) continue;
      const indices = [j - 1, j, j + 1];
      const excess = Math.min(...indices.map(k => normalized[k] - this.baseline[k]));
      if (Math.min(...indices.map(k => db(power[this.bins[k].i]))) < (this.exaggerated ? -100 : this.sensitive ? -95 : -85)) continue;
      if (excess > Math.max(toward, away)) shiftHz = this.bins[j].offset;
      if (this.bins[j].offset > 0) toward = Math.max(toward, excess);
      else away = Math.max(away, excess);
    }
    const score = Math.max(toward, away);
    const limit = this.state === 'CALM' ? this.threshold : Math.max(this.exaggerated ? 0.5 : 2, this.threshold - 2);
    const next = score < limit ? 'CALM' : toward >= limit && away >= limit ? 'MOTION' :
      toward > away + 3 ? 'APPROACH' : away > toward + 3 ? 'RECEDE' : 'MOTION';
    return this.transition(next, time, { score, toward, away, shiftHz, pilotDb, reason: 'doppler' });
  }
  /** @param {string} next @param {number} time @param {{score: number, reason: string, pilotDb: number, dropDb?: number, toward?: number, away?: number, shiftHz?: number}} evidence @returns {DetectionResult} */
  transition(next, time, evidence) {
    this.lastTime = time;
    // Direction may alternate while a hand crosses the speaker. Accumulate motion
    // persistence independently of direction, and count one event per episode.
    const candidate = next === 'CALM' ? 'CALM' : 'MOVING';
    if (candidate !== this.candidate || this.since === null) { this.candidate = candidate; this.since = time; }
    let event = false;
    if (time - this.since >= (next === 'CALM' ? 0.65 : this.motionDwell)) {
      if (next !== 'CALM' && this.state === 'CALM' && time - this.lastAlert >= 3) {
        event = true; this.lastAlert = time;
      }
      this.state = next;
      this.reason = next === 'CALM' ? '' : evidence.reason;
    }
    return { ...evidence, state: this.state, reason: this.reason || evidence.reason, event };
  }
}

/** @param {number} offDb @param {number} onDb */
export function pilotIsUsable(offDb, onDb) {
  return Number.isFinite(offDb) && Number.isFinite(onDb) && onDb >= -75 && onDb - offDb >= 10;
}

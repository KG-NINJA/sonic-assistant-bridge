import test from 'node:test';
import assert from 'node:assert/strict';
import { Spectrum, DopplerDetector, FFT_SIZE, pilotIsUsable } from '../src/dsp.js';

function frame({ rate = 48000, pilot = 20500, amplitude = 0.08, tones = [], noise = 0, phase = 0 } = {}) {
  const samples = new Float32Array(FFT_SIZE);
  let seed = 727 + phase;
  for (let i = 0; i < samples.length; i++) {
    const time = (i + phase * 2400) / rate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    samples[i] = amplitude * Math.sin(2 * Math.PI * pilot * time) + noise * (seed / 2 ** 32 - 0.5);
    for (const [frequency, amp] of tones) samples[i] += amp * Math.sin(2 * Math.PI * frequency * time);
  }
  return new Spectrum().transform(samples);
}
function calibrated(options = {}) {
  const d = new DopplerDetector({ ...options, calibrationFrames: 10 });
  const quiet = frame({ rate: d.sampleRate, pilot: d.frequency });
  for (let i = 0; i < 10; i++) d.process(quiet.power, i * 0.05);
  assert.ok(d.baseline);
  return d;
}
function feed(d, power, start = 1, count = 12) {
  return Array.from({ length: count }, (_, i) => d.process(power, start + i * 0.05));
}

test('FFT locates a non-bin-centered 20.5kHz pilot and resolves power', () => {
  const { power } = frame();
  const peak = power.indexOf(Math.max(...power));
  assert.ok(Math.abs(peak * 48000 / FFT_SIZE - 20500) < 48000 / FFT_SIZE);
  assert.ok(10 * Math.log10(power[peak]) > -25);
});
test('stationary pilot, phase changes, quiet noise and speech-range audio stay calm', () => {
  const d = calibrated();
  for (let i = 0; i < 30; i++) {
    const { power } = frame({ phase: i, noise: 0.00005, tones: [[350, 0.12], [1300, 0.07], [5000, 0.03]] });
    const r = d.process(power, 1 + i * 0.05);
    assert.equal(r.state, 'CALM'); assert.ok(!r.event);
  }
});
test('positive reflected shift triggers approach after dwell, once per episode', () => {
  const d = calibrated(), { power } = frame({ tones: [[20640, 0.004]] });
  const out = feed(d, power, 1, 60);
  assert.equal(out[0].state, 'CALM');
  assert.equal(out.at(-1).state, 'APPROACH');
  assert.equal(out.filter(r => r.event).length, 1);
  assert.ok(out.at(-1).shiftHz > 0);
});
test('negative shift is receding and raises a detection event', () => {
  const out = feed(calibrated(), frame({ tones: [[20360, 0.004]] }).power);
  assert.equal(out.at(-1).state, 'RECEDE'); assert.equal(out.filter(r => r.event).length, 1);
});
test('both sidebands produce ambiguous motion', () => {
  const out = feed(calibrated(), frame({ tones: [[20640, 0.004], [20360, 0.004]] }).power);
  assert.equal(out.at(-1).state, 'MOTION'); assert.equal(out.filter(r => r.event).length, 1);
});
test('short impulses and missing analysis intervals cannot satisfy dwell', () => {
  const d = calibrated(), motion = frame({ tones: [[20640, 0.004]] }).power;
  assert.equal(d.process(motion, 1).state, 'CALM');
  assert.equal(d.process(motion, 5).state, 'CALM');
  assert.equal(d.process(motion, 5.1).event, false);
  const out = feed(d, frame().power, 5.15, 20);
  assert.ok(out.every(r => !r.event)); assert.equal(out.at(-1).state, 'CALM');
});
test('initial silence, clipping and invalid arrays fail closed; detector recovers without stale dwell', () => {
  const d = calibrated();
  assert.equal(new DopplerDetector().process(new Float64Array(FFT_SIZE / 2), 1).state, 'NO_SIGNAL');
  assert.equal(d.process(frame().power, 2, true).state, 'CLIPPING');
  assert.equal(d.process(new Float64Array(12), 3).state, 'INVALID');
  const corrupt = frame().power; corrupt[40] = NaN;
  assert.equal(d.process(corrupt, 4).state, 'INVALID');
  assert.equal(d.process(frame().power, 5).state, 'CALM');
});
test('increased direct path requires recalibration; modest gain changes do not trigger motion', () => {
  const d = calibrated();
  assert.equal(feed(d, frame({ amplitude: 0.12 }).power).at(-1).state, 'CALM');
  assert.equal(d.process(frame({ amplitude: 0.4 }).power, 2).state, 'SIGNAL_CHANGED');
});
test('calibration rejects changing movement and restarts on silence', () => {
  const d = new DopplerDetector({ calibrationFrames: 10 });
  let result;
  for (let i = 0; i < 10; i++) result = d.process(frame({ tones: i % 2 ? [[20640, 0.004]] : [] }).power, i * 0.05);
  assert.equal(result.state, 'CALIBRATION_NOISE'); assert.equal(d.baseline, null);
  d.process(frame().power, 1);
  d.process(new Float64Array(FFT_SIZE / 2), 1.1);
  assert.equal(d.frames.length, 0);
});
test('44.1kHz and shifted carrier settings retain directional detection', () => {
  for (const [sampleRate, frequency] of [[44100, 20500], [48000, 18000], [48000, 21000]]) {
    const d = calibrated({ sampleRate, frequency });
    const power = frame({ rate: sampleRate, pilot: frequency, tones: [[frequency + 120, 0.004]] }).power;
    assert.equal(feed(d, power).at(-1).state, 'APPROACH');
  }
});
test('pilot qualification requires both absolute level and an off/on difference', () => {
  assert.equal(pilotIsUsable(-100, -40), true);
  assert.equal(pilotIsUsable(-42, -40), false);
  assert.equal(pilotIsUsable(-120, -90), false);
  assert.equal(pilotIsUsable(NaN, -30), false);
});
test('invalid configurations and samples are rejected', () => {
  assert.throws(() => new DopplerDetector({ sampleRate: 32000 }));
  assert.throws(() => new DopplerDetector({ sampleRate: 44100, frequency: 21500 }));
  assert.throws(() => new DopplerDetector({ threshold: NaN }));
  assert.throws(() => new Spectrum(777));
  assert.throws(() => new Spectrum().transform(new Float32Array(1)));
  const samples = new Float32Array(FFT_SIZE); samples[0] = NaN;
  assert.throws(() => new Spectrum().transform(samples));
});
test('quiet release and later reapproach produce a second event', () => {
  const d = calibrated(), motion = frame({ tones: [[20640, 0.004]] }).power;
  assert.equal(feed(d, motion, 1).filter(r => r.event).length, 1);
  assert.equal(feed(d, frame().power, 1.6, 50).at(-1).state, 'CALM');
  assert.equal(feed(d, motion, 4.1).filter(r => r.event).length, 1);
});

test('sensitive mode detects weaker echoes that the previous high threshold misses', () => {
  const weak = frame({ tones: [[20640, 0.0002]] }).power;
  assert.equal(feed(calibrated({ threshold: 5 }), weak, 1, 25).at(-1).state, 'CALM');
  assert.equal(feed(calibrated({ threshold: 3 }), weak, 1, 25).at(-1).state, 'APPROACH');
});
test('sensitive mode resolves slow approaching and receding shifts near the pilot', () => {
  for (const shift of [25, -25]) {
    const slow = frame({ tones: [[20500 + shift, 0.002]] }).power;
    assert.equal(feed(calibrated({ threshold: 5 }), slow, 1, 25).at(-1).state, 'CALM');
    assert.equal(feed(calibrated({ threshold: 3 }), slow, 1, 25).at(-1).state, shift > 0 ? 'APPROACH' : 'RECEDE');
  }
});
test('sensitive mode requires longer persistence and rejects isolated spectral spikes', () => {
  const d = calibrated({ threshold: 3 }), movement = frame({ tones: [[20640, 0.002]] }).power;
  assert.ok(feed(d, movement, 1, 10).every(r => !r.event));
  assert.ok(feed(d, frame().power, 1.5, 20).every(r => !r.event));
  const spike = frame().power; spike[Math.round(20640 * FFT_SIZE / 48000)] = 0.01;
  assert.equal(feed(d, spike, 3, 25).at(-1).state, 'CALM');
});
test('sensitive mode remains calm for phase changes, gain changes, speech and calibrated noise', () => {
  const d = new DopplerDetector({ threshold: 3, calibrationFrames: 40 });
  for (let i = 0; i < 40; i++) d.process(frame({ noise: 0.00015, phase: i }).power, i * 0.05);
  assert.ok(d.baseline);
  for (let i = 40; i < 110; i++) {
    const audio = frame({ noise: 0.00015, phase: i, amplitude: i % 2 ? 0.09 : 0.08, tones: [[400, 0.1], [2300, 0.07]] });
    const r = d.process(audio.power, i * 0.05);
    assert.equal(r.state, 'CALM'); assert.ok(!r.event);
  }
});
test('sensitive mode rejects unstable weak calibration and retains pilot health gates', () => {
  const d = new DopplerDetector({ threshold: 3, calibrationFrames: 10 });
  let r;
  for (let i = 0; i < 10; i++) r = d.process(frame({ tones: i % 2 ? [[20640, 0.0002]] : [] }).power, i * 0.05);
  assert.equal(r.state, 'CALIBRATION_NOISE');
  const stable = calibrated({ threshold: 3 });
  assert.equal(feed(stable, new Float64Array(FFT_SIZE / 2), 1, 25).at(-1).state, 'APPROACH');
  assert.equal(stable.process(frame().power, 2, true).state, 'CLIPPING');
});

test('conversation throughout calibration does not prevent calibration or weaken detection', () => {
  const d = new DopplerDetector({ threshold: 3, calibrationFrames: 20 });
  let result;
  for (let i = 0; i < 20; i++) result = d.process(frame({ phase: i, tones: [[300, 0.2], [1200, 0.1], [4200, 0.04]], noise: 0.0001 }).power, i * 0.05);
  assert.ok(result.calibrated);
  assert.equal(feed(d, frame({ tones: [[20640, 0.0002]] }).power, 2, 25).at(-1).state, 'APPROACH');
});

test('transient high-frequency bangs are excluded without poisoning the baseline', () => {
  const d = new DopplerDetector({ threshold: 3, calibrationFrames: 40 });
  const quiet = frame().power, bang = frame({ noise: 0.15, tones: [[20640, 0.005]] }).power;
  let completed;
  for (let i = 0; i < 50; i++) {
    const result = d.process(i >= 8 && i < 14 ? bang : quiet, i * 0.05);
    assert.ok(!result.event);
    if (result.calibrated) completed = result;
  }
  assert.ok(completed); assert.ok(completed.excludedFrames >= 6);
  assert.equal(feed(d, quiet, 3, 25).at(-1).state, 'CALM');
  assert.equal(feed(d, frame({ tones: [[20640, 0.0002]] }).power, 5, 25).at(-1).state, 'APPROACH');
});

test('brief clipping during calibration is excluded; continuous clipping never calibrates', () => {
  const d = new DopplerDetector({ calibrationFrames: 10 }), quiet = frame().power;
  d.process(quiet, 0); d.process(quiet, 0.05);
  assert.equal(d.process(quiet, 0.1, true).state, 'CALIBRATION_NOISE');
  for (let i = 3; i < 15; i++) d.process(quiet, i * 0.05);
  assert.ok(d.baseline);
  assert.equal(d.process(quiet, 1, true).state, 'CLIPPING');
  const blocked = new DopplerDetector({ calibrationFrames: 10 });
  for (let i = 0; i < 100; i++) assert.ok(!blocked.process(quiet, i * 0.05, true).calibrated);
  assert.equal(blocked.baseline, null); assert.ok(blocked.frames.length <= 15);
});

test('persistent alternating interference cannot calibrate; later stable input recovers', () => {
  const d = new DopplerDetector({ threshold: 3, calibrationFrames: 20 });
  const quiet = frame().power, noise = frame({ tones: [[20640, 0.004]] }).power;
  for (let i = 0; i < 100; i++) assert.ok(!d.process(i % 2 ? noise : quiet, i * 0.05).calibrated);
  assert.equal(d.baseline, null);
  for (let i = 100; i < 135; i++) d.process(quiet, i * 0.05);
  assert.ok(d.baseline);
});

test('weak but usable pilot with ordinary broadband background can calibrate', () => {
  const d = new DopplerDetector({ threshold: 8, calibrationFrames: 40 });
  let completed = false;
  for (let i = 0; i < 100; i++) {
    const result = d.process(frame({ amplitude: 0.0004, noise: 0.002, phase: i }).power, i * 0.05);
    if (result.calibrated) completed = true;
  }
  assert.equal(completed, true);
});

test('obstruction and complete attenuation trigger once, recover, and allow another episode', () => {
  for (const threshold of [3, 8]) {
    const d = calibrated({ threshold }), blocked = frame({ amplitude: 0.008 }).power;
    const out = feed(d, blocked, 1, 80);
    assert.equal(out[0].state, 'CALM');
    assert.equal(out.at(-1).state, 'APPROACH');
    assert.equal(out.at(-1).reason, 'occlusion');
    assert.ok(Math.abs(out.at(-1).dropDb - 20) < 0.1);
    assert.equal(out.filter(r => r.event).length, 1);
    const silence = feed(d, new Float64Array(FFT_SIZE / 2), 5, 20);
    assert.ok(silence.every(r => r.state === 'APPROACH' && !r.event));
    assert.equal(feed(d, frame().power, 6, 20).at(-1).state, 'CALM');
    assert.equal(feed(d, blocked, 7, 25).filter(r => r.event).length, 1);
  }
});

test('brief attenuation and discontinuous samples do not count as an approach', () => {
  const d = calibrated(), blocked = frame({ amplitude: 0.008 }).power;
  assert.ok(feed(d, blocked, 1, 4).every(r => !r.event));
  assert.ok(feed(d, frame().power, 1.2, 20).every(r => !r.event));
  assert.equal(d.process(blocked, 3).event, false);
  assert.equal(d.process(blocked, 4).event, false);
  assert.equal(d.process(blocked, 4.1, true).state, 'CLIPPING');
  assert.equal(d.process(blocked, 4.2).event, false);
});

test('a weak calibrated pilot falling below the receive floor becomes obstruction instead of an error', () => {
  const d = new DopplerDetector({ calibrationFrames: 10 });
  const quiet = frame({ amplitude: 0.00025 }).power;
  for (let i = 0; i < 10; i++) d.process(quiet, i * 0.05);
  assert.ok(d.baseline);
  const out = feed(d, frame({ amplitude: 0.00017 }).power, 1, 20);
  assert.equal(out.at(-1).state, 'APPROACH');
  assert.equal(out.at(-1).reason, 'occlusion');
  assert.equal(out.filter(r => r.event).length, 1);
  assert.equal(feed(d, quiet, 2, 20).at(-1).state, 'CALM');
});

test('crossing motion with alternating directions counts once, then rearms after calm', () => {
  for (const threshold of [3, 8]) {
    const d = calibrated({ threshold });
    const signals = [frame({ tones: [[20640, 0.004]] }).power,
      frame({ tones: [[20360, 0.004]] }).power,
      frame({ tones: [[20640, 0.004], [20360, 0.004]] }).power];
    const out = Array.from({ length: 80 }, (_, i) => d.process(signals[i % 3], 1 + i * 0.05));
    assert.equal(out[0].state, 'CALM');
    assert.equal(out.filter(r => r.event).length, 1);
    assert.notEqual(out.at(-1).state, 'CALM');
    assert.equal(feed(d, frame().power, 5, 20).at(-1).state, 'CALM');
    assert.equal(feed(d, signals[2], 6, 25).filter(r => r.event).length, 1);
  }
});

test('exaggerated mode detects a finer echo promptly without increasing measured score', () => {
  const weak = frame({ tones: [[20535, 0.0001]] }).power;
  assert.equal(feed(calibrated({ threshold: 3 }), weak, 1, 25).at(-1).state, 'CALM');
  const out = feed(calibrated({ threshold: 1 }), weak, 1, 6);
  assert.equal(out[0].event, false);
  assert.equal(out.filter(r => r.event).length, 1);
  assert.notEqual(out.at(-1).state, 'CALM');
});

test('exaggerated mode retains impulse rejection and detects a smaller obstruction', () => {
  const d = calibrated({ threshold: 1 }), weak = frame({ tones: [[20535, 0.0001]] }).power;
  assert.ok(feed(d, weak, 1, 2).every(r => !r.event));
  assert.ok(feed(d, frame().power, 1.1, 20).every(r => !r.event));
  const blocked = frame({ amplitude: 0.08 * 10 ** (-3 / 20) }).power;
  const out = feed(d, blocked, 2.1, 8);
  assert.equal(out.filter(r => r.event).length, 1);
  assert.equal(out.at(-1).reason, 'occlusion');
  assert.equal(feed(d, frame().power, 2.5, 20).at(-1).state, 'CALM');
});

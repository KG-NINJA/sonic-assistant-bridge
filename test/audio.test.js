import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioSensor } from '../src/audio.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function rig(t, { permission, resumeError, noPilot = false, processed = false } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const contexts = [], streams = [], results = [], errors = [];
  const param = value => ({ value, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; } });
  const node = () => ({ connect() {}, disconnect() { this.disconnected = true; } });
  class Context {
    constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; this.destination = {}; this.gains = []; contexts.push(this); }
    resume() { return resumeError ? Promise.reject(resumeError) : Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return node(); }
    createAnalyser() {
      return { ...node(), getFloatTimeDomainData: samples => {
        const amplitude = noPilot ? 0 : (this.gains[1]?.gain.value || 0) * 3;
        for (let i = 0; i < samples.length; i++) {
          const time = this.currentTime + i / this.sampleRate;
          samples[i] = amplitude * Math.sin(2 * Math.PI * 20500 * time);
          if (this.motion) samples[i] += 0.004 * Math.sin(2 * Math.PI * 20640 * time);
          if (this.clipping) samples[i] = 1;
        }
      } };
    }
    createGain() { const gain = { ...node(), gain: param(1) }; this.gains.push(gain); return gain; }
    createOscillator() { return this.osc = { ...node(), frequency: param(0), start() { this.started = true; }, stop() { this.stopped = true; } }; }
  }
  function stream() {
    const listeners = new Map();
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; }, getSettings: () => ({ echoCancellation: processed, noiseSuppression: false, autoGainControl: false }), addEventListener: (name, fn) => listeners.set(name, fn) };
    const value = { getTracks: () => [track], getAudioTracks: () => [track], track, listeners };
    streams.push(value); return value;
  }
  const mediaDevices = { getUserMedia: () => permission ? permission.promise : Promise.resolve(stream()) };
  const sensor = new AudioSensor(r => results.push(r), e => errors.push(e), { AudioContext: Context, mediaDevices });
  t.after(() => sensor.stop());
  function advance(count, step = 0.05) {
    for (let i = 0; i < count; i++) { contexts.forEach(c => { c.currentTime += step; }); t.mock.timers.tick(50); }
  }
  return { sensor, contexts, streams, results, errors, stream, advance };
}
const options = { frequency: 20500, volume: 0.02, threshold: 8 };

test('stop while permission is pending releases a late stream without starting a tone', async t => {
  const permission = deferred(), r = rig(t, { permission });
  const pending = r.sensor.start(options);
  r.sensor.stop(); const lateStream = r.stream(); permission.resolve(lateStream); await pending;
  assert.equal(lateStream.track.readyState, 'ended'); assert.equal(r.contexts[0].state, 'closed');
  assert.equal(r.contexts[0].osc, undefined); assert.equal(r.sensor.session, null);
  assert.equal(r.errors.length, 0);
});
test('permission denial reports failure and closes audio context', async t => {
  const permission = deferred(), r = rig(t, { permission });
  const pending = r.sensor.start(options); permission.reject(new Error('denied')); await pending;
  assert.equal(r.errors.length, 1); assert.equal(r.contexts[0].state, 'closed'); assert.equal(r.sensor.session, null);
});
test('resume rejection stops granted microphone without starting oscillator', async t => {
  const r = rig(t, { resumeError: new Error('suspended') }); await r.sensor.start(options);
  assert.equal(r.errors.length, 1); assert.equal(r.streams[0].track.readyState, 'ended'); assert.equal(r.sensor.session, null);
});
test('off/on probe, calibration, approach, and stop use the actual audio processing path', async t => {
  const r = rig(t); await r.sensor.start(options);
  r.advance(165);
  assert.equal(r.errors.length, 0, r.errors.map(e => e.message).join());
  assert.ok(r.results.some(v => v.state === 'PROBE_OFF'));
  assert.ok(r.results.some(v => v.state === 'PROBE_ON'));
  assert.ok(r.results.some(v => v.calibrated));
  r.contexts[0].motion = true; r.advance(12);
  assert.equal(r.results.at(-1).state, 'APPROACH'); assert.equal(r.results.filter(v => v.event).length, 1);
  r.sensor.stop(); r.sensor.stop();
  assert.equal(r.contexts[0].gains[1].gain.value, 0);
  assert.equal(r.contexts[0].osc.stopped, true);
  assert.equal(r.streams[0].track.readyState, 'ended'); assert.equal(r.contexts[0].state, 'closed');
  const count = r.results.length; r.advance(10); assert.equal(r.results.length, count);
});
test('missing pilot fails qualification instead of displaying calm monitoring', async t => {
  const r = rig(t, { noPilot: true }); await r.sensor.start(options); r.advance(90);
  assert.equal(r.errors.length, 1); assert.ok(!r.results.some(v => v.calibrated));
  assert.equal(r.streams[0].track.readyState, 'ended'); assert.equal(r.contexts[0].gains[1].gain.value, 0);
});
test('clipping while monitoring and timer stalls stop measurement', async t => {
  const r = rig(t); await r.sensor.start(options);
  r.advance(165);
  r.contexts[0].clipping = true; r.advance(1);
  assert.equal(r.errors.length, 1); assert.equal(r.sensor.session, null);
  await r.sensor.start(options); r.advance(1, 1);
  assert.equal(r.errors.length, 2); assert.equal(r.sensor.session, null);
});

test('a brief clipped bang during startup and calibration resumes without failure', async t => {
  const r = rig(t); await r.sensor.start(options);
  r.contexts[0].clipping = true; r.advance(5);
  assert.equal(r.results.at(-1).state, 'PROBE_NOISE'); assert.equal(r.errors.length, 0);
  r.contexts[0].clipping = false; r.advance(70);
  assert.equal(r.sensor.session.phase, 'calibrate');
  r.contexts[0].clipping = true; r.advance(8);
  assert.equal(r.results.at(-1).state, 'CALIBRATION_NOISE'); assert.equal(r.errors.length, 0);
  r.contexts[0].clipping = false; r.advance(110);
  assert.ok(r.results.some(v => v.calibrated)); assert.equal(r.errors.length, 0);
});

test('continuous startup clipping times out, mutes, and releases the microphone', async t => {
  const r = rig(t); await r.sensor.start(options); r.contexts[0].clipping = true;
  r.advance(170);
  assert.equal(r.errors.length, 1); assert.match(r.errors[0].message, /物音/);
  assert.equal(r.sensor.session, null); assert.equal(r.streams[0].track.readyState, 'ended');
  assert.equal(r.contexts[0].gains[1].gain.value, 0);
});

test('persistent calibration interference stops within 20 seconds rather than inventing a baseline', async t => {
  const r = rig(t); await r.sensor.start({ ...options, threshold: 3 }); r.advance(72);
  assert.equal(r.sensor.session.phase, 'calibrate');
  for (let i = 0; i < 420; i++) { r.contexts[0].motion = i % 2 === 0; r.advance(1); }
  assert.equal(r.errors.length, 1); assert.match(r.errors[0].message, /20秒/);
  assert.ok(!r.results.some(v => v.calibrated)); assert.equal(r.sensor.session, null);
  assert.equal(r.contexts[0].gains[1].gain.value, 0); assert.equal(r.streams[0].track.readyState, 'ended');
});

test('stop while collecting noise-free calibration samples cancels all work', async t => {
  const r = rig(t); await r.sensor.start(options); r.advance(75);
  r.contexts[0].clipping = true; r.advance(2);
  r.sensor.stop(); const count = r.results.length; r.advance(100);
  assert.equal(r.results.length, count); assert.equal(r.errors.length, 0);
  assert.equal(r.streams[0].track.readyState, 'ended'); assert.equal(r.contexts[0].osc.stopped, true);
});
test('audio processing that could erase the pilot is rejected', async t => {
  const r = rig(t, { processed: true }); await r.sensor.start(options);
  assert.equal(r.errors.length, 1); assert.equal(r.streams[0].track.readyState, 'ended');
});
test('mic disconnection and context suspension release output', async t => {
  const r = rig(t); await r.sensor.start(options);
  r.streams[0].listeners.get('ended')();
  assert.equal(r.sensor.session, null); assert.equal(r.contexts[0].osc.stopped, true);
  await r.sensor.start(options);
  r.contexts[1].state = 'suspended'; r.contexts[1].onstatechange();
  assert.equal(r.sensor.session, null); assert.equal(r.streams[1].track.readyState, 'ended');
});
test('a replacement session is not affected by a late cancelled permission result', async t => {
  const permission = deferred(), r = rig(t, { permission });
  const first = r.sensor.start(options); r.sensor.stop();
  // The fake environment deliberately resolves both pending requests with separate tracks.
  r.sensor.env.mediaDevices.getUserMedia = () => Promise.resolve(r.stream());
  await r.sensor.start(options);
  const active = r.sensor.session;
  const late = r.stream(); permission.resolve(late); await first;
  assert.equal(late.track.readyState, 'ended'); assert.equal(r.sensor.session, active);
  assert.equal(r.streams[0].track.readyState, 'live');
});

test('output above 3 percent is rejected before permission or sound; sensitive mode does not boost volume', async t => {
  const r = rig(t);
  await r.sensor.start({ ...options, threshold: 3, volume: 0.1 });
  assert.equal(r.contexts.length, 0); assert.equal(r.streams.length, 0); assert.equal(r.errors.length, 1);
  await r.sensor.start({ ...options, threshold: 3, volume: 0.02 });
  r.advance(170);
  assert.equal(r.contexts[0].gains[1].gain.value, 0.02);
  assert.ok(r.results.some(v => v.calibrated));
  r.contexts[0].motion = true; r.advance(20);
  assert.equal(r.results.at(-1).state, 'APPROACH');
  r.sensor.stop(); assert.equal(r.contexts[0].gains[1].gain.value, 0);
});

test('monitoring continues through obstruction and silence, recovers, and still stops on mic mute', async t => {
  const r = rig(t); await r.sensor.start(options); r.advance(165);
  r.contexts[0].gains[1].gain.value = 0.002; r.advance(20);
  assert.equal(r.results.at(-1).state, 'APPROACH');
  assert.equal(r.results.at(-1).reason, 'occlusion');
  assert.equal(r.results.filter(v => v.event).length, 1);
  r.contexts[0].gains[1].gain.value = 0; r.advance(140);
  assert.equal(r.results.at(-1).state, 'APPROACH');
  assert.equal(r.errors.length, 0); assert.ok(r.sensor.session);
  r.contexts[0].gains[1].gain.value = 0.02; r.advance(20);
  assert.equal(r.results.at(-1).state, 'CALM');
  r.streams[0].listeners.get('mute')();
  assert.equal(r.sensor.session, null); assert.equal(r.contexts[0].osc.stopped, true);
});

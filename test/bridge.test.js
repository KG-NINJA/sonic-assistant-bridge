import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionBridge, validateMotionEvent, MOTION_EVENT_SCHEMA } from '../src/bridge.js';

function fixture() {
  let time = Date.parse('2026-11-01T12:00:00.000Z');
  let id = 0;
  const events = [];
  const bridge = new MotionBridge({ onEvent: event => events.push(event), now: () => time,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` });
  return { bridge, events, advance: ms => { time += ms; } };
}
const motion = { state: 'APPROACH', event: true, score: 5, reason: 'doppler' };
const calm = { state: 'CALM', event: false, score: 0 };

test('bridge stays silent until explicit start, preserves session order, and stops', () => {
  const { bridge, events } = fixture();
  assert.equal(bridge.ingest(motion), null);
  assert.equal(bridge.end(), null);
  bridge.begin('live'); bridge.ingest(calm); bridge.ingest(motion); bridge.end('page_hidden');
  assert.deepEqual(events.map(event => event.type), ['session.started', 'motion.detected', 'session.stopped']);
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
  assert.ok(events.every(event => event.sessionId === events[0].sessionId && event.mode === 'live' && validateMotionEvent(event)));
  assert.equal(events[2].reason, 'page_hidden');
  bridge.ingest(motion); bridge.end();
  assert.equal(events.length, 3);
});

test('strict scalar projection excludes audio, spectrum, user text, and device information', () => {
  const { bridge } = fixture(); bridge.begin();
  const event = bridge.ingest({ ...motion, samples: new Float32Array([0.1]), power: [1, 2],
    transcript: 'private speech', deviceId: 'private-device', arbitrary: 'private data', pilotDb: -50 });
  assert.deepEqual(Object.keys(event).sort(), MOTION_EVENT_SCHEMA.required.toSorted());
  assert.deepEqual(event.score, { value: 5, unit: 'dB', basis: 'above_baseline' });
  assert.equal(event.mode, 'synthetic');
  assert.ok(!JSON.stringify(event).includes('private'));
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.score));
});

test('repeated event flags and direction changes produce only one event per calm-separated episode', () => {
  const { bridge, events, advance } = fixture(); bridge.begin(); bridge.ingest(motion);
  advance(10000);
  for (const state of ['APPROACH', 'RECEDE', 'MOTION']) bridge.ingest({ ...motion, state });
  assert.equal(events.filter(event => event.type === 'motion.detected').length, 1);
  bridge.ingest(calm); bridge.ingest({ ...motion, state: 'RECEDE' });
  assert.equal(events.filter(event => event.type === 'motion.detected').length, 2);
});

test('cooldown drops flapping episodes without later replay and survives restarts', () => {
  const { bridge, events, advance } = fixture(); bridge.begin(); bridge.ingest(motion);
  advance(2999); bridge.ingest(calm); assert.equal(bridge.ingest(motion), null);
  advance(5000); assert.equal(bridge.ingest(motion), null);
  bridge.ingest(calm); assert.ok(bridge.ingest(motion));
  bridge.begin('live'); bridge.ingest(calm); assert.equal(bridge.ingest(motion), null);
  advance(3000); assert.equal(bridge.ingest(motion), null);
  bridge.ingest(calm); assert.ok(bridge.ingest(motion));
  assert.equal(events.filter(event => event.type === 'motion.detected').length, 3);
  assert.equal(events.find(event => event.type === 'session.stopped').reason, 'restart');
  const starts = events.filter(event => event.type === 'session.started');
  assert.notEqual(starts[0].sessionId, starts[1].sessionId);
});

test('backwards wall clock cannot trigger an early motion notification', () => {
  const { bridge, advance } = fixture(); bridge.begin(); bridge.ingest(motion);
  advance(-1000); bridge.ingest(calm); assert.equal(bridge.ingest(motion), null);
  advance(3999); bridge.ingest(calm); assert.equal(bridge.ingest(motion), null);
  advance(1); bridge.ingest(calm); assert.ok(bridge.ingest(motion));
});

test('occlusion carries attenuation units without mislabeling confidence or distance', () => {
  const { bridge } = fixture(); bridge.begin();
  const event = bridge.ingest({ ...motion, reason: 'occlusion', score: 12, dropDb: 12 });
  assert.deepEqual(event.score, { value: 12, unit: 'dB', basis: 'pilot_attenuation' });
  assert.equal(event.reason, 'occlusion');
  assert.ok(validateMotionEvent(event));
});

test('unqualified frames and malformed motion evidence never become events', () => {
  const { bridge, events } = fixture(); bridge.begin();
  for (const frame of [
    { ...motion, event: false }, { ...motion, event: 'true' },
    { ...motion, state: 'CALIBRATING' }, { ...motion, state: 'ERROR' },
    { ...motion, score: NaN }, { ...motion, score: Infinity }, { ...motion, score: -1 },
    { ...motion, reason: 'private speech' }, { ...motion, reason: 'occlusion', state: 'RECEDE' },
  ]) assert.equal(bridge.ingest(frame), null);
  assert.equal(events.length, 1);
  assert.ok(bridge.ingest(motion));
});

test('receiver validator rejects extra keys, malformed values, and mismatched semantics', () => {
  const { bridge } = fixture(); bridge.begin();
  const event = bridge.ingest(motion);
  const invalid = [null, [], 'text', {},
    { ...event, audio: [] }, { ...event, score: { ...event.score, transcript: 'speech' } },
    { ...event, schemaVersion: 2 }, { ...event, source: 'another-source' },
    { ...event, id: '../private' }, { ...event, sessionId: '' },
    { ...event, sequence: 0 }, { ...event, sequence: 1 }, { ...event, sequence: 1.1 },
    { ...event, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...event, occurredAt: '2026-02-30T00:00:00.000Z' },
    { ...event, occurredAt: '2026-11-01T12:00:00Z' },
    { ...event, mode: 'recording' }, { ...event, state: 'CALM' },
    { ...event, type: 'confidence' }, { ...event, reason: 'started' },
    { ...event, score: null }, { ...event, score: { ...event.score, value: NaN } },
    { ...event, score: { ...event.score, value: Infinity } },
    { ...event, score: { ...event.score, value: '5' } },
    { ...event, score: { ...event.score, value: -1 } },
    { ...event, score: { ...event.score, unit: '%' } },
    { ...event, score: { ...event.score, basis: 'pilot_attenuation' } },
    { ...event, reason: 'occlusion' },
  ];
  for (const value of invalid) assert.equal(validateMotionEvent(value), false, JSON.stringify(value));
  const missing = { ...event }; delete missing.mode;
  assert.equal(validateMotionEvent(missing), false);
  assert.equal(validateMotionEvent(JSON.parse(JSON.stringify(event))), true);
});

test('lifecycle schemas reject fake motion or misplaced session metadata', () => {
  const { bridge } = fixture();
  const started = bridge.begin(); const stopped = bridge.end('sensor_error');
  for (const event of [{ ...started, reason: 'manual' }, { ...started, state: 'APPROACH' },
    { ...started, sequence: 2 }, { ...stopped, reason: 'started' },
    { ...stopped, state: 'ERROR' }, { ...stopped, sequence: 1 },
    { ...stopped, score: { value: 0, unit: 'dB', basis: 'above_baseline' } }]) {
    assert.equal(validateMotionEvent(event), false);
  }
  assert.ok(validateMotionEvent(started) && validateMotionEvent(stopped));
});

test('invalid configuration cannot weaken the minimum throttle or add arbitrary modes/reasons', () => {
  for (const cooldownMs of [-1, 0, 2999, NaN, Infinity]) {
    assert.throws(() => new MotionBridge({ cooldownMs }), /Invalid bridge configuration/);
  }
  const { bridge } = fixture();
  assert.throws(() => bridge.begin('background'), /Invalid bridge mode/);
  assert.throws(() => bridge.end('user speech'), /Invalid stop reason/);
  assert.throws(() => new MotionBridge({ createId: () => 'bad-id' }).begin(), /Invalid session ID/);
});

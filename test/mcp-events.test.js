import test from 'node:test';
import assert from 'node:assert/strict';
import { eventDefinition, toMcpEvent } from '../bridge/mcp-events.js';
import { MOTION_EVENT_SCHEMA, validateMotionEvent } from '../src/bridge.js';

function motionEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    id: '4c2a6f62-3f8c-4ced-9834-203061b178d5',
    sessionId: '009b603d-48db-46f3-b62a-7264102bca30',
    sequence: 2,
    occurredAt: '2026-11-01T12:00:04.000Z',
    source: 'sonic-forcefield',
    mode: 'synthetic',
    type: 'motion.detected',
    state: 'APPROACH',
    reason: 'doppler',
    score: { value: 4, unit: 'dB', basis: 'above_baseline' },
    ...overrides,
  };
}

test('project event definition describes the shared strict event contract', () => {
  assert.equal(eventDefinition.name, 'sonic.motion');
  assert.deepEqual(eventDefinition.delivery, ['webhook']);
  assert.deepEqual(eventDefinition.inputSchema, {
    type: 'object', properties: { includeSynthetic: { type: 'boolean', default: false } }, additionalProperties: false,
  });
  assert.deepEqual(eventDefinition.payloadSchema, MOTION_EVENT_SCHEMA);
  assert.notEqual(eventDefinition.payloadSchema, MOTION_EVENT_SCHEMA);
  assert.equal(eventDefinition.payloadSchema.additionalProperties, false);
});

test('envelope keeps source identity and occurrence time without remote calls', t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Pure adapter must not send network requests');
  });
  const input = motionEvent();
  assert.equal(validateMotionEvent(input), true);
  assert.deepEqual(toMcpEvent(input), {
    eventId: input.id,
    name: 'sonic.motion',
    timestamp: input.occurredAt,
    data: input,
    cursor: null,
  });
  assert.deepEqual(toMcpEvent(input), toMcpEvent(input));
  assert.equal(fetch.mock.callCount(), 0);
});

test('MCP data is independent of the source, including nested score data', () => {
  const input = motionEvent();
  const envelope = toMcpEvent(input);
  input.score.value = 99;
  input.state = 'RECEDE';
  assert.equal(envelope.data.score.value, 4);
  assert.equal(envelope.data.state, 'APPROACH');
  envelope.data.score.value = 7;
  assert.equal(input.score.value, 99);
});

test('malformed and extra payload fields cannot cross the adapter boundary', () => {
  for (const event of [
    null,
    {},
    motionEvent({ id: 'not-a-uuid' }),
    motionEvent({ occurredAt: 'yesterday' }),
    motionEvent({ sequence: 0 }),
    motionEvent({ rawAudio: [0, 1, 2] }),
    motionEvent({ score: { value: 0.9, unit: 'probability', basis: 'above_baseline' } }),
  ]) {
    assert.throws(() => toMcpEvent(event), { name: 'TypeError', message: 'Invalid motion event' });
  }
});

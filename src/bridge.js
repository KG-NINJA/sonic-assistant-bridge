// Event-only boundary: never spread a detector frame into a transport payload.
/** @typedef {'live'|'synthetic'} BridgeMode */
/** @typedef {'manual'|'page_hidden'|'pagehide'|'sensor_error'|'device_change'|'restart'} StopReason */
/** @typedef {{value: number, unit: 'dB', basis: 'above_baseline'|'pilot_attenuation'}} MotionScore */
/** @typedef {{schemaVersion: 1, id: string, sessionId: string, sequence: number, occurredAt: string, source: 'sonic-forcefield', mode: BridgeMode, type: 'session.started'|'motion.detected'|'session.stopped', state: 'STARTING'|'APPROACH'|'RECEDE'|'MOTION'|'STOPPED', reason: 'started'|'doppler'|'occlusion'|StopReason, score: MotionScore|null}} MotionEvent */

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const UUID = new RegExp(UUID_PATTERN);
const ISO_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const ISO = new RegExp(ISO_PATTERN);
const STOP_REASONS = ['manual', 'page_hidden', 'pagehide', 'sensor_error', 'device_change', 'restart'];
const MOTION_STATES = ['APPROACH', 'RECEDE', 'MOTION'];
const EVENT_KEYS = ['schemaVersion', 'id', 'sessionId', 'sequence', 'occurredAt', 'source', 'mode', 'type', 'state', 'reason', 'score'];

// Shared with adapters. This is the Sonic payload schema, not a dot API name.
export const MOTION_EVENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: EVENT_KEYS,
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', pattern: UUID_PATTERN },
    sessionId: { type: 'string', pattern: UUID_PATTERN },
    sequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    occurredAt: { type: 'string', format: 'date-time', pattern: ISO_PATTERN },
    source: { const: 'sonic-forcefield' },
    mode: { enum: ['live', 'synthetic'] },
    type: { enum: ['session.started', 'motion.detected', 'session.stopped'] },
    state: { enum: ['STARTING', ...MOTION_STATES, 'STOPPED'] },
    reason: { enum: ['started', 'doppler', 'occlusion', ...STOP_REASONS] },
    score: {
      anyOf: [
        { type: 'null' },
        { type: 'object', additionalProperties: false, required: ['value', 'unit', 'basis'], properties: {
          value: { type: 'number', minimum: 0, maximum: Number.MAX_VALUE },
          unit: { const: 'dB' }, basis: { enum: ['above_baseline', 'pilot_attenuation'] },
        } },
      ],
    },
  },
  oneOf: [
    { properties: { type: { const: 'session.started' }, state: { const: 'STARTING' }, reason: { const: 'started' }, score: { type: 'null' }, sequence: { const: 1 } } },
    { properties: { type: { const: 'session.stopped' }, state: { const: 'STOPPED' }, reason: { enum: STOP_REASONS }, score: { type: 'null' }, sequence: { minimum: 2 } } },
    { properties: { type: { const: 'motion.detected' }, state: { enum: MOTION_STATES }, reason: { const: 'doppler' }, score: { type: 'object', properties: { basis: { const: 'above_baseline' } } }, sequence: { minimum: 2 } } },
    { properties: { type: { const: 'motion.detected' }, state: { const: 'APPROACH' }, reason: { const: 'occlusion' }, score: { type: 'object', properties: { basis: { const: 'pilot_attenuation' } } }, sequence: { minimum: 2 } } },
  ],
};

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Validate incoming JSON without accepting extra fields, audio, or free text.
 * @param {unknown} value
 * @returns {value is MotionEvent}
 */
export function validateMotionEvent(value) {
  if (!exactKeys(value, EVENT_KEYS)) return false;
  const event = /** @type {MotionEvent} */ (value);
  if (event.schemaVersion !== 1 || event.source !== 'sonic-forcefield' ||
    !['live', 'synthetic'].includes(event.mode) ||
    typeof event.id !== 'string' || !UUID.test(event.id) ||
    typeof event.sessionId !== 'string' || !UUID.test(event.sessionId) ||
    !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
    typeof event.occurredAt !== 'string' || !ISO.test(event.occurredAt)) return false;
  const timestamp = Date.parse(event.occurredAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== event.occurredAt) return false;
  if (event.type === 'session.started') return event.state === 'STARTING' && event.reason === 'started' && event.score === null && event.sequence === 1;
  if (event.sequence < 2) return false;
  if (event.type === 'session.stopped') return event.state === 'STOPPED' && STOP_REASONS.includes(event.reason) && event.score === null;
  if (event.type !== 'motion.detected' || !MOTION_STATES.includes(event.state) ||
    !exactKeys(event.score, ['value', 'unit', 'basis']) || event.score.unit !== 'dB' ||
    !Number.isFinite(event.score.value) || event.score.value < 0) return false;
  return event.reason === 'occlusion'
    ? event.state === 'APPROACH' && event.score.basis === 'pilot_attenuation'
    : event.reason === 'doppler' && event.score.basis === 'above_baseline';
}

export class MotionBridge {
  /** @param {{onEvent?: (event: MotionEvent) => void, now?: () => number, createId?: () => string, cooldownMs?: number}} options */
  constructor({ onEvent = () => {}, now = () => Date.now(), createId = () => globalThis.crypto.randomUUID(), cooldownMs = 3000 } = {}) {
    if (typeof onEvent !== 'function' || typeof now !== 'function' || typeof createId !== 'function' ||
      !Number.isFinite(cooldownMs) || cooldownMs < 3000) throw new TypeError('Invalid bridge configuration');
    this.onEvent = onEvent; this.now = now; this.createId = createId; this.cooldownMs = cooldownMs;
    /** @type {{id: string, mode: BridgeMode, sequence: number}|null} */
    this.session = null;
    this.episodeHandled = false;
    // Keep this across sessions, so rapid restarts cannot bypass motion throttling.
    this.lastMotionAt = -Infinity;
  }

  /** @param {BridgeMode} mode @returns {MotionEvent} */
  begin(mode = 'synthetic') {
    if (!['live', 'synthetic'].includes(mode)) throw new TypeError('Invalid bridge mode');
    if (this.session) this.end('restart');
    const id = this.createId();
    if (!UUID.test(id)) throw new TypeError('Invalid session ID');
    this.session = { id, mode, sequence: 0 }; this.episodeHandled = false;
    return this.emit('session.started', 'STARTING', 'started', null);
  }

  /** @param {import('./dsp.js').DetectionResult} frame @returns {MotionEvent|null} */
  ingest(frame) {
    if (!this.session || !frame || typeof frame !== 'object') return null;
    if (frame.state === 'CALM') { this.episodeHandled = false; return null; }
    if (frame.event !== true || !MOTION_STATES.includes(frame.state) || this.episodeHandled) return null;
    const occlusion = frame.reason === 'occlusion';
    if ((!occlusion && frame.reason !== undefined && frame.reason !== 'doppler') ||
      (occlusion && frame.state !== 'APPROACH') || !Number.isFinite(frame.score) || frame.score < 0) return null;
    // Discard a cooldown-suppressed episode. It must not be replayed later.
    this.episodeHandled = true;
    const at = this.now();
    if (!Number.isFinite(at) || at - this.lastMotionAt < this.cooldownMs) return null;
    this.lastMotionAt = at;
    return this.emit('motion.detected', /** @type {MotionEvent['state']} */ (frame.state), occlusion ? 'occlusion' : 'doppler', {
      value: frame.score, unit: 'dB', basis: occlusion ? 'pilot_attenuation' : 'above_baseline',
    }, at);
  }

  /** @param {StopReason} reason @returns {MotionEvent|null} */
  end(reason = 'manual') {
    if (!STOP_REASONS.includes(reason)) throw new TypeError('Invalid stop reason');
    if (!this.session) return null;
    try { return this.emit('session.stopped', 'STOPPED', reason, null); }
    finally { this.session = null; this.episodeHandled = false; }
  }

  /** @param {MotionEvent['type']} type @param {MotionEvent['state']} state @param {MotionEvent['reason']} reason @param {MotionScore|null} score @returns {MotionEvent} */
  emit(type, state, reason, score, at = this.now()) {
    if (!this.session) throw new Error('Bridge session is stopped');
    /** @type {MotionEvent} */
    const event = { schemaVersion: 1, id: this.createId(), sessionId: this.session.id,
      sequence: ++this.session.sequence, occurredAt: new Date(at).toISOString(),
      source: 'sonic-forcefield', mode: this.session.mode, type, state, reason, score };
    if (!validateMotionEvent(event)) throw new TypeError('Invalid motion event');
    if (score) Object.freeze(score);
    Object.freeze(event);
    this.onEvent(event);
    return event;
  }
}

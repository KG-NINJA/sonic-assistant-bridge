import { MOTION_EVENT_SCHEMA, validateMotionEvent } from '../src/bridge.js';

// Project-defined name, not an existing dot API or an installed event source.
export const eventDefinition = Object.freeze({
  name: 'sonic.motion',
  description: 'Experimental acoustic motion and explicit session lifecycle events. Does not establish occupancy, identity, distance, or confidence.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: structuredClone(MOTION_EVENT_SCHEMA),
});

/**
 * Build a candidate MCP Events delivery envelope without performing any I/O.
 * A future authenticated backend must manage subscriptions and signed delivery.
 * @param {unknown} event
 */
export function toMcpEvent(event) {
  if (!validateMotionEvent(event)) {
    throw new TypeError('Invalid motion event');
  }
  return {
    eventId: event.id,
    name: eventDefinition.name,
    timestamp: event.occurredAt,
    data: structuredClone(event),
    cursor: null,
  };
}

import assert from 'node:assert/strict';
import { MotionBridge } from '../src/bridge.js';
import { createMockReceiver } from '../bridge/receiver.js';
import { createServer } from '../server.js';

// No microphone, speakers, credentials or external HTTP endpoint.
const receiver = createMockReceiver();
const server = createServer({ bridgeEnabled: true, receiver });
await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
try {
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('Expected a loopback port');
  const origin = `http://127.0.0.1:${address.port}`;
  const events = [];
  let now = Date.now();
  const bridge = new MotionBridge({ now: () => now, onEvent: event => events.push(event) });
  bridge.begin('synthetic');
  bridge.ingest({ state: 'APPROACH', score: 6, event: true });
  bridge.ingest({ state: 'RECEDE', score: 7, event: true }); // Same episode: suppressed.
  bridge.ingest({ state: 'CALM', score: 0 });
  now += 4000;
  bridge.ingest({ state: 'RECEDE', score: 5, event: true });
  bridge.end('manual');
  bridge.ingest({ state: 'APPROACH', score: 9, event: true }); // Stopped: ignored.
  assert.equal(events.length, 4);
  for (const event of [...events, events[1]]) {
    const response = await fetch(origin + '/bridge/events', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(event), redirect: 'error' });
    assert.ok(response.ok);
    const result = await response.json();
    assert.equal(result.eventId, event.id);
    assert.equal(result.delivery, 'local-mock');
  }
  assert.equal(receiver.snapshot().receivedCount, 4);
  console.log(JSON.stringify({ result: 'PASS', syntheticEvents: 4, duplicateIgnored: 1,
    transport: 'loopback HTTP -> local MCP envelope mock', dotConnected: false,
    microphoneUsed: false, speakersUsed: false, sample: receiver.snapshot().latest }, null, 2));
} finally {
  await new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections(); });
}

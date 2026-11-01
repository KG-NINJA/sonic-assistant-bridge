import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.js';
import { createMockReceiver } from '../bridge/receiver.js';
import { MotionBridge } from '../src/bridge.js';

async function setup(t, enabled = true, now = () => Date.now()) {
  const receiver = createMockReceiver({ now });
  const server = createServer({ bridgeEnabled: enabled, receiver });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (event, headers = {}) => fetch(origin + '/bridge/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(event),
  });
  return { receiver, origin, post };
}

test('receiver is disabled by default, even for valid metadata', async t => {
  const { post, origin } = await setup(t, false);
  assert.equal((await post(new MotionBridge().begin('synthetic'))).status, 404);
  assert.equal((await fetch(origin + '/bridge/status')).status, 404);
});

test('local mock receives metadata once and maps it to an MCP envelope', async t => {
  const { post, receiver, origin } = await setup(t);
  const event = new MotionBridge().begin('synthetic');
  const first = await post(event);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: true, duplicate: false, eventId: event.id, delivery: 'local-mock' });
  const duplicate = await post({ ...event });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(receiver.snapshot().receivedCount, 1);
  assert.deepEqual(receiver.snapshot().latest.data, event);
  assert.equal(receiver.snapshot().latest.eventId, event.id);
  assert.equal((await post({ ...event, mode: 'live' })).status, 409);
  const status = await (await fetch(origin + '/bridge/status')).json();
  assert.deepEqual(status, { enabled: true, delivery: 'local-mock', receivedCount: 1 });
});

test('receiver rejects unrelated origins, forged hosts and non-JSON submissions', async t => {
  const { post, origin, receiver } = await setup(t);
  const event = new MotionBridge().begin('synthetic');
  for (const headers of [
    { Origin: 'https://example.com' }, { Origin: 'null' }, { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await post(event, headers)).status, 403, JSON.stringify(headers));
  // Fetch normalises Host to its URL. Use HTTP directly to exercise DNS rebinding.
  const forgedHost = await new Promise((resolve, reject) => {
    const req = http.request(origin + '/bridge/events', { method: 'POST',
      headers: { Host: 'attacker.example', Origin: origin, 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(JSON.stringify(event));
  });
  assert.equal(forgedHost, 403);
  assert.equal((await post(event, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(event, { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await fetch(origin + '/bridge/events', { method: 'OPTIONS' })).status, 405);
  assert.equal(receiver.snapshot().receivedCount, 0);
});

test('receiver rejects raw data, malformed and oversized bodies, and stale timestamps', async t => {
  const { post, origin, receiver } = await setup(t);
  const event = new MotionBridge().begin('synthetic');
  assert.equal((await post({ ...event, audio: [1, 2, 3] })).status, 400);
  assert.equal((await post({ ...event, url: 'https://example.com' })).status, 400);
  assert.equal((await post({ ...event, occurredAt: new Date(Date.now() - 301000).toISOString() })).status, 400);
  assert.equal((await post({ ...event, occurredAt: new Date(Date.now() + 31000).toISOString() })).status, 400);
  assert.equal((await post({ ...event, audio: 'x'.repeat(9000) })).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(origin + '/bridge/events', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('"' + 'x'.repeat(4000)); req.end('x'.repeat(5000) + '"');
  });
  assert.equal(chunked, 413);
  const bad = await fetch(origin + '/bridge/events', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  assert.equal(receiver.snapshot().receivedCount, 0);
});

test('receiver rate cap drops bursts, preserves duplicate recognition, and recovers', async t => {
  let now = Date.now();
  const { post, receiver } = await setup(t, true, () => now);
  const first = new MotionBridge({ now: () => now }).begin('synthetic');
  assert.equal((await post(first)).status, 202);
  for (let i = 1; i < 60; i++) assert.equal((await post(new MotionBridge({ now: () => now }).begin('synthetic'))).status, 202);
  assert.equal((await post(new MotionBridge({ now: () => now }).begin('synthetic'))).status, 429);
  assert.equal((await post(first)).status, 200);
  now += 60000;
  assert.equal((await post(new MotionBridge({ now: () => now }).begin('synthetic'))).status, 202);
  assert.equal(receiver.snapshot().receivedCount, 61);
});

test('future clock skew cannot outlive duplicate protection while its timestamp is accepted', async t => {
  let now = Date.now();
  const { post, receiver } = await setup(t, true, () => now);
  const event = new MotionBridge({ now: () => now + 30000 }).begin('synthetic');
  assert.equal((await post(event)).status, 202);
  now += 300000;
  assert.equal((await (await post(event)).json()).duplicate, true);
  now += 30000;
  assert.equal((await (await post(event)).json()).duplicate, true);
  now++;
  assert.equal((await post(event)).status, 400);
  assert.equal(receiver.snapshot().receivedCount, 1);
});

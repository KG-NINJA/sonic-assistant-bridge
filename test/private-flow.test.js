import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createPrivateBridgeHandler } from '../bridge/private-handler.js';
import { createEventService, createSyntheticMemoryStore } from '../bridge/service.js';
import { MotionBridge } from '../src/bridge.js';

test('synthetic authenticated HTTP → subscription → signed callback → unsubscribe, no real delivery', async () => {
  const origin = 'https://private.example';
  const owner = { siteId: 'synthetic-site', userId: 'synthetic-owner' };
  const time = Date.parse('2026-11-01T23:50:00.000Z');
  // Fixed public test bytes, never a generated service credential.
  const secret = 'whsec_' + Buffer.alloc(32, 97).toString('base64');
  const captured = [];
  const service = createEventService({ store: createSyntheticMemoryStore(), now: () => time,
    transport: { kind: 'synthetic-test', async post(url, { body, headers }) {
      assert.equal(url, 'https://callback.example/events');
      const expected = createHmac('sha256', Buffer.alloc(32, 97)).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
      assert.equal(headers['webhook-signature'], 'v1,' + expected);
      const payload = JSON.parse(body);
      captured.push(payload);
      return { status: 200, body: payload.type === 'verification' ? JSON.stringify({ challenge: payload.challenge }) : '{}' };
    } },
  });
  const handle = createPrivateBridgeHandler({ siteOrigin: origin, service, authenticate: async () => owner });
  const request = (path, body) => handle(new Request(origin + path, body ? {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {}));
  const rpc = async (method, params) => (await request('/mcp', { jsonrpc: '2.0', id: 1, method, params })).json();
  const definition = await rpc('events/list', {});
  assert.equal(definition.result.events[0].name, 'sonic.motion');
  const params = { name: 'sonic.motion', arguments: { includeSynthetic: true },
    delivery: { mode: 'webhook', url: 'https://callback.example/events', secret }, cursor: null };
  const subscribed = await rpc('events/subscribe', params);
  assert.ok(subscribed.result.id);
  const status = await (await request('/api/bridge/status')).json();
  assert.equal(status.testMode, true);
  assert.equal(status.deliveryReady, true);
  assert.equal(JSON.stringify(status).includes('whsec_'), false);
  const bridge = new MotionBridge({ now: () => time });
  const started = bridge.begin('synthetic');
  assert.equal((await (await request('/api/bridge/events', started)).json()).outcome, 'filtered');
  const motion = bridge.ingest({ state: 'APPROACH', event: true, score: 5, reason: 'doppler' });
  const accepted = await (await request('/api/bridge/events', motion)).json();
  assert.equal(accepted.outcome, 'callback-accepted');
  assert.equal(accepted.testMode, true);
  const duplicate = await (await request('/api/bridge/events', motion)).json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(captured.length, 2); // one challenge and one synthetic motion
  assert.equal(captured[1].data.mode, 'synthetic');
  assert.deepEqual(captured[1].data, motion);
  assert.equal((await (await request('/api/bridge/unsubscribe', {})).json()).unsubscribed, true);
  assert.equal((await (await request('/api/bridge/status')).json()).subscriptionActive, false);
  assert.equal(captured.length, 2);
});

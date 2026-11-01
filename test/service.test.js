import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createEventService, createSyntheticMemoryStore } from '../bridge/service.js';
import { MotionBridge } from '../src/bridge.js';

const owner = { siteId: 'synthetic-site', userId: 'synthetic-user' };
const other = { siteId: 'synthetic-site', userId: 'other-user' };
// Fixed fixtures only: these are never credentials or registered secrets.
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const rotated = 'whsec_' + Buffer.alloc(32, 9).toString('base64');
const callback = 'https://callback.example.com/events';
const params = (extra = {}) => ({ name: 'sonic.motion', arguments: {}, delivery: { mode: 'webhook', url: callback, secret }, cursor: null, ...extra });
const unsubscribeParams = () => ({ name: 'sonic.motion', arguments: {}, delivery: { mode: 'webhook', url: callback } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ post, timeoutMs = 100, store = createSyntheticMemoryStore() } = {}) {
  let time = Date.parse('2026-11-01T12:00:00.000Z');
  const calls = [];
  const transport = { kind: 'synthetic-test', async post(url, request) {
    const payload = JSON.parse(request.body);
    calls.push({ url, ...request, payload });
    if (post) return post(payload, request);
    return { status: 200, body: payload.type === 'verification' ? JSON.stringify({ challenge: payload.challenge }) : '{}' };
  } };
  const service = createEventService({ store, transport, now: () => time, timeoutMs });
  const event = (mode = 'live', offset = 0) => {
    const bridge = new MotionBridge({ now: () => time + offset });
    bridge.begin(mode);
    return bridge.ingest({ state: 'APPROACH', reason: 'doppler', score: 5, event: true });
  };
  return { service, store, calls, event, now: () => time, advance: ms => { time += ms; } };
}

test('default service fails closed without persistence, transport, or trusted identity', async () => {
  const service = createEventService();
  assert.equal((await service.status(null)).authenticated, false);
  assert.equal((await service.status(owner)).deliveryReady, false);
  assert.equal((await service.status(owner)).blockedReason, 'durable-store-required');
  await assert.rejects(service.subscribe(owner, params()), error => error.data.reason === 'durable-store-required');
  await assert.rejects(service.subscribe(null, params()), error => error.data.reason === 'unauthenticated');
  const blocked = createEventService({ store: createSyntheticMemoryStore(), transport: { kind: 'safe-https', productionSafe: true, post() { throw new Error('must not run'); } } });
  assert.equal((await blocked.status(owner)).blockedReason, 'unverified-storage-or-transport');
});

test('signed fresh challenge must be echoed before subscription becomes active', async () => {
  const entered = deferred(), finish = deferred();
  const f = fixture({ post: async payload => { entered.resolve(); await finish.promise; return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) }; } });
  const subscribing = f.service.subscribe(owner, params());
  await entered.promise;
  assert.equal((await f.service.status(owner)).subscriptionActive, false);
  finish.resolve();
  const result = await subscribing;
  assert.match(result.id, /^sub_[a-f0-9]{64}$/);
  assert.equal(result.refreshBefore, '2026-11-01T13:00:00.000Z');
  assert.deepEqual(result.cursor, null); assert.equal(result.truncated, false);
  const request = f.calls[0];
  assert.deepEqual(Object.keys(request.payload).sort(), ['challenge', 'type']);
  assert.equal(request.payload.type, 'verification');
  assert.match(request.headers['webhook-id'], /^msg_verification_/);
  assert.equal(request.headers['X-MCP-Subscription-Id'], result.id);
  const input = `${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.${request.body}`;
  assert.equal(request.headers['webhook-signature'], 'v1,' + createHmac('sha256', Buffer.alloc(32, 7)).update(input).digest('base64'));
  assert.deepEqual(await f.service.status(owner), { authenticated: true, subscriptionActive: true, deliveryReady: true,
    blockedReason: null, delivery: 'mcp-webhook', testMode: true });
  assert.ok(!JSON.stringify(await f.service.status(owner)).includes(secret));
});

test('wrong challenge, non-2xx, redirect, and oversized response do not activate', async () => {
  for (const response of [
    { status: 200, body: '{"challenge":"wrong"}' }, { status: 204, body: '' },
    { status: 302, body: '{}' }, { status: 500, body: '{}' },
    { status: 200, body: 'x'.repeat(8193) },
  ]) {
    const f = fixture({ post: async () => response });
    await assert.rejects(f.service.subscribe(owner, params()), error => error.code === -32015 && error.data.reason === 'challenge_failed');
    assert.equal((await f.service.status(owner)).subscriptionActive, false);
    assert.equal(await f.store.transaction(JSON.stringify([owner.siteId, owner.userId]), state => state.subscription), null);
  }
});

test('challenge timeout aborts the request and clears the pending secret', async () => {
  const f = fixture({ post: async () => new Promise(() => {}), timeoutMs: 10 });
  await assert.rejects(f.service.subscribe(owner, params()), error => error.code === -32015 && error.data.reason === 'timeout');
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal((await f.service.status(owner)).subscriptionActive, false);
  assert.equal(await f.store.transaction(JSON.stringify([owner.siteId, owner.userId]), state => state.subscription), null);
});

test('strict subscription parameters reject unsafe callbacks, secrets, and unknown fields before I/O', async () => {
  const f = fixture();
  const candidates = [
    { ...params(), extra: true }, { ...params(), name: 'another.event' },
    { ...params(), cursor: 'resume-token' }, { ...params(), ttlMs: 1 },
    { ...params(), arguments: { includeSynthetic: 'yes' } }, { ...params(), arguments: { audio: true } },
    ...['http://callback.example.com', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/',
      'https://callback.example.com:8443/', 'https://name:secret@callback.example.com/', 'https://callback.example.com/#fragment',
      'https://callback.example.com/\nprivate', 'https://service.internal/'].map(url => ({ ...params(), delivery: { ...params().delivery, url } })),
    ...['bad', 'whsec_' + Buffer.alloc(23).toString('base64'), 'whsec_' + Buffer.alloc(65).toString('base64')].map(secret => ({ ...params(), delivery: { ...params().delivery, secret } })),
    { ...params(), delivery: { ...params().delivery, headers: {} } },
  ];
  for (const candidate of candidates) await assert.rejects(f.service.subscribe(owner, candidate), error => error.code === -32602);
  assert.equal(f.calls.length, 0);
});

test('upsert is idempotent, caps TTL, and permits only one subscription per owner', async () => {
  const f = fixture();
  const first = await f.service.subscribe(owner, params({ ttlMs: 99999999 }));
  const again = await f.service.subscribe(owner, params({ ttlMs: null }));
  assert.equal(again.id, first.id); assert.equal(f.calls.length, 1);
  assert.equal(again.refreshBefore, '2026-11-01T13:00:00.000Z');
  await assert.rejects(f.service.subscribe(owner, params({ arguments: { includeSynthetic: true } })), error => error.data.reason === 'subscription_limit');
  const secondOwner = await f.service.subscribe(other, params());
  assert.notEqual(secondOwner.id, first.id);
  const otherSite = await f.service.subscribe({ ...owner, siteId: 'other-site' }, params());
  assert.notEqual(otherSite.id, first.id);
});

test('concurrent identical subscriptions share a single verification', async () => {
  const entered = deferred(), finish = deferred();
  const f = fixture({ post: async payload => { entered.resolve(); await finish.promise; return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) }; } });
  const first = f.service.subscribe(owner, params());
  await entered.promise;
  const second = f.service.subscribe(owner, params());
  finish.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.id, two.id); assert.equal(f.calls.length, 1);
});

test('rotating a secret verifies again, retains ID, and briefly dual signs delivery', async () => {
  const f = fixture(); const first = await f.service.subscribe(owner, params());
  const next = await f.service.subscribe(owner, params({ delivery: { ...params().delivery, secret: rotated } }));
  assert.equal(next.id, first.id); assert.equal(f.calls.length, 2);
  await f.service.ingest(owner, f.event());
  assert.equal(f.calls[2].headers['webhook-signature'].split(' ').length, 2);
  f.advance(30001); await f.service.ingest(owner, f.event());
  assert.equal(f.calls[3].headers['webhook-signature'].split(' ').length, 1);
});

test('failed secret rotation keeps the existing verified subscription only', async () => {
  let fail = false;
  const f = fixture({ post: async payload => ({ status: 200, body: JSON.stringify({ challenge: fail ? 'wrong' : payload.challenge }) }) });
  await f.service.subscribe(owner, params()); fail = true;
  await assert.rejects(f.service.subscribe(owner, params({ delivery: { ...params().delivery, secret: rotated } })));
  assert.equal((await f.service.status(owner)).subscriptionActive, true);
  const current = await f.store.transaction(JSON.stringify([owner.siteId, owner.userId]), state => state.subscription);
  assert.equal(current.secret, secret); assert.equal(current.previousSecret, null);
});

test('only live motion is delivered by default; lifecycle and synthetic events are explicit drops', async () => {
  const f = fixture(); await f.service.subscribe(owner, params());
  const lifecycle = new MotionBridge({ now: f.now }).begin('live');
  const stopped = await f.service.ingest(owner, lifecycle);
  assert.equal(stopped.status, 200); assert.equal(stopped.body.outcome, 'filtered'); assert.equal(stopped.body.accepted, false);
  const synthetic = await f.service.ingest(owner, f.event('synthetic'));
  assert.equal(synthetic.body.reason, 'synthetic-disabled'); assert.equal(synthetic.body.accepted, false);
  assert.equal(f.calls.length, 1);
  const event = f.event(); const delivered = await f.service.ingest(owner, event);
  assert.equal(delivered.status, 202); assert.equal(delivered.body.accepted, true);
  assert.equal(delivered.body.outcome, 'callback-accepted'); assert.equal(delivered.body.delivery, 'mcp-webhook');
  assert.equal(delivered.body.testMode, true);
  const sent = f.calls[1];
  assert.equal(sent.payload.eventId, event.id); assert.equal(sent.payload.timestamp, event.occurredAt);
  assert.deepEqual(sent.payload.data, event);
  assert.equal(sent.headers['webhook-id'], event.id);
  assert.equal(sent.payload.cursor, null);
});

test('synthetic motion needs explicit subscription filter', async () => {
  const f = fixture(); await f.service.subscribe(owner, params({ arguments: { includeSynthetic: true } }));
  assert.equal((await f.service.ingest(owner, f.event('synthetic'))).body.outcome, 'callback-accepted');
});

test('invalid payloads, stale/future data and extra fields never reach the callback', async () => {
  const f = fixture(); await f.service.subscribe(owner, params());
  const event = f.event();
  for (const bad of [{ ...event, transcript: 'private text' }, { ...event, audio: [1, 2] },
    { ...event, score: { ...event.score, confidence: 1 } }, { ...event, score: { ...event.score, value: Infinity } },
    f.event('live', -300001), f.event('live', 30001), { ...event, extra: 'x'.repeat(8192) }]) {
    const response = await f.service.ingest(owner, bad);
    assert.equal(response.body.accepted, false); assert.ok(response.status >= 400);
  }
  assert.equal(f.calls.length, 1);
});

test('dedup covers future skew and inclusive freshness, conflicts reject, and no retry occurs', async () => {
  const f = fixture(); await f.service.subscribe(owner, params());
  const event = f.event('live', 30000);
  const first = await f.service.ingest(owner, event); assert.equal(first.body.accepted, true);
  const duplicate = await f.service.ingest(owner, event); assert.equal(duplicate.body.duplicate, true);
  f.advance(300000);
  assert.equal((await f.service.ingest(owner, event)).body.duplicate, true);
  f.advance(30000);
  assert.equal((await f.service.ingest(owner, event)).body.duplicate, true);
  const changed = { ...event, score: { ...event.score, value: 6 } };
  assert.equal((await f.service.ingest(owner, changed)).status, 409);
  f.advance(1); assert.equal((await f.service.ingest(owner, event)).status, 400);
  assert.equal(f.calls.length, 2);
});

test('minimum three-second rate limit survives disable/resubscribe, and dropped events never replay', async () => {
  const f = fixture(); await f.service.subscribe(owner, params());
  await f.service.ingest(owner, f.event());
  const suppressed = f.event();
  assert.equal((await f.service.ingest(owner, suppressed)).status, 429);
  await f.service.disable(owner); await f.service.subscribe(owner, params());
  assert.equal((await f.service.ingest(owner, f.event())).status, 429);
  f.advance(3000);
  assert.equal((await f.service.ingest(owner, suppressed)).body.outcome, 'rate-limited');
  assert.equal((await f.service.ingest(owner, f.event())).body.accepted, true);
  assert.equal(f.calls.filter(call => !call.payload.type).length, 2);
});

test('failed/uncertain callback results are never reported as accepted and are not retried', async () => {
  for (const status of [302, 400, 413, 500]) {
    const f = fixture({ post: async payload => payload.type === 'verification'
      ? { status: 200, body: JSON.stringify({ challenge: payload.challenge }) } : { status, body: '' } });
    await f.service.subscribe(owner, params());
    const event = f.event(), result = await f.service.ingest(owner, event);
    assert.equal(result.body.accepted, false); assert.equal(result.body.outcome, 'callback-rejected');
    const repeated = await f.service.ingest(owner, event);
    assert.equal(repeated.body.accepted, false); assert.equal(repeated.body.duplicate, true);
    assert.equal(f.calls.length, 2);
  }
  const f = fixture({ timeoutMs: 10, post: async payload => payload.type === 'verification'
    ? { status: 200, body: JSON.stringify({ challenge: payload.challenge }) } : new Promise(() => {}) });
  await f.service.subscribe(owner, params());
  const event = f.event(), result = await f.service.ingest(owner, event);
  assert.equal(result.body.accepted, false); assert.equal(result.body.outcome, 'delivery-uncertain');
  assert.equal(result.body.reason, 'timeout'); assert.equal(f.calls[1].signal.aborted, true);
  await f.service.ingest(owner, event); assert.equal(f.calls.length, 2);
});

test('410 ends subscription, clears secret, and causes no retry', async () => {
  const f = fixture({ post: async payload => payload.type === 'verification'
    ? { status: 200, body: JSON.stringify({ challenge: payload.challenge }) } : { status: 410, body: '' } });
  await f.service.subscribe(owner, params());
  assert.equal((await f.service.ingest(owner, f.event())).body.accepted, false);
  assert.equal((await f.service.status(owner)).subscriptionActive, false);
  assert.equal(await f.store.transaction(JSON.stringify([owner.siteId, owner.userId]), state => state.subscription), null);
  assert.equal(f.calls.length, 2);
});

test('disable while verification is in flight aborts it and cannot resurrect a subscription', async () => {
  const entered = deferred(), finish = deferred();
  const f = fixture({ post: async payload => { entered.resolve(); await finish.promise; return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) }; } });
  const subscribe = f.service.subscribe(owner, params());
  await entered.promise;
  assert.equal((await f.service.disable(owner)).body.unsubscribed, true);
  finish.resolve(); await assert.rejects(subscribe);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal((await f.service.status(owner)).subscriptionActive, false);
  assert.equal(await f.store.transaction(JSON.stringify([owner.siteId, owner.userId]), state => state.subscription), null);
});

test('disable and unsubscribe fence a subscribe paused before reservation', async () => {
  for (const operation of ['disable', 'unsubscribe']) {
    const entered = deferred(), finish = deferred(), base = createSyntheticMemoryStore();
    let first = true;
    const store = { ...base, async transaction(owner, mutate) {
      const result = await base.transaction(owner, mutate);
      if (first) { first = false; entered.resolve(); await finish.promise; }
      return result;
    } };
    const f = fixture({ store });
    const subscribing = f.service.subscribe(owner, params());
    await entered.promise;
    if (operation === 'disable') await f.service.disable(owner);
    else await f.service.unsubscribe(owner, unsubscribeParams());
    finish.resolve();
    await assert.rejects(subscribing, error => error.data.reason === 'disabled');
    assert.equal((await f.service.status(owner)).subscriptionActive, false);
    assert.equal(f.calls.length, 0);
  }
});

test('unsubscribe with different parameters leaves an existing subscription intact', async () => {
  const f = fixture(); await f.service.subscribe(owner, params());
  await f.service.unsubscribe(owner, { ...unsubscribeParams(), arguments: { includeSynthetic: true } });
  assert.equal((await f.service.status(owner)).subscriptionActive, true);
  assert.equal((await f.service.ingest(owner, f.event())).body.accepted, true);
});

test('unsubscribe while delivery is in flight aborts it and suppresses late success', async () => {
  const entered = deferred(), finish = deferred();
  const f = fixture({ post: async payload => {
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    entered.resolve(); await finish.promise; return { status: 200, body: '{}' };
  } });
  await f.service.subscribe(owner, params());
  const sending = f.service.ingest(owner, f.event()); await entered.promise;
  assert.deepEqual(await f.service.unsubscribe(owner, unsubscribeParams()), {});
  finish.resolve(); const response = await sending;
  assert.equal(response.body.accepted, false); assert.equal(response.body.outcome, 'disabled');
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal((await f.service.status(owner)).subscriptionActive, false);
});

test('cross-owner unsubscribe/disable and ingest cannot access another owner subscription', async () => {
  const f = fixture(); await f.service.subscribe(owner, params());
  await f.service.unsubscribe(other, unsubscribeParams()); await f.service.disable(other);
  assert.equal((await f.service.status(owner)).subscriptionActive, true);
  assert.equal((await f.service.status(other)).subscriptionActive, false);
  assert.equal((await f.service.ingest(other, f.event())).body.accepted, false);
  assert.equal((await f.service.ingest({ ...owner, siteId: 'other-site' }, f.event())).body.accepted, false);
  assert.equal(f.calls.length, 1);
});

test('expiry stops delivery and status, with no implicit renewal', async () => {
  const f = fixture(); await f.service.subscribe(owner, params({ ttlMs: 60000 }));
  f.advance(60000);
  assert.equal((await f.service.status(owner)).subscriptionActive, false);
  assert.equal((await f.service.ingest(owner, f.event())).body.accepted, false);
  assert.equal(f.calls.length, 1);
});

test('RPC exposes authenticated event discovery and a read-only owner-scoped status tool', async () => {
  const f = fixture();
  const call = (method, params = {}) => f.service.rpc(owner, { jsonrpc: '2.0', id: 1, method, params });
  assert.deepEqual((await call('server/discover')).result, { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } });
  const events = (await call('events/list')).result.events;
  assert.equal(events[0].inputSchema.properties.includeSynthetic.default, false);
  const tool = (await call('tools/list')).result.tools[0];
  assert.equal(tool.name, 'sonic_bridge_status'); assert.equal(tool.annotations.readOnlyHint, true);
  const content = (await call('tools/call', { name: tool.name, arguments: {} })).result.content;
  assert.equal(JSON.parse(content[0].text).subscriptionActive, false);
  assert.ok((await call('tools/call', { name: tool.name, arguments: { userId: 'other' } })).error);
  assert.ok((await call('tools/call', { name: 'enable_motion', arguments: {} })).error);
  assert.ok((await call('events/list', { cursor: 'unsupported' })).error);
  assert.ok((await call('events/subscribe', { ...params(), secret })).error);
  assert.ok((await f.service.rpc(null, { jsonrpc: '2.0', id: 2, method: 'events/list' })).error);
  assert.equal(f.calls.length, 0);
});

test('synthetic storage is bounded and refuses asynchronous transaction mutators', async () => {
  const store = createSyntheticMemoryStore({ maxOwners: 1 });
  await store.transaction('first', state => state.epoch++);
  await assert.rejects(store.transaction('second', () => {}), error => error.data.reason === 'owner_capacity');
  await assert.rejects(store.transaction('first', async () => {}), /synchronous/);
});

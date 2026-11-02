import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createD1Store } from '../bridge/d1-store.js';
import { createEventService } from '../bridge/service.js';
import { createSitesReceiver } from '../bridge/sites-receiver.js';
import { MotionBridge } from '../src/bridge.js';

const migration = await readFile(new URL('../migrations/0001_bridge_state.sql', import.meta.url), 'utf8');
const owner = { siteId: 'test-site', userId: 'test-owner' };
const ownerKey = JSON.stringify([owner.siteId, owner.userId]);
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64'); // fixed public fixture
const params = { name: 'sonic.motion', arguments: { includeSynthetic: true }, cursor: null,
  delivery: { mode: 'webhook', url: 'https://callback.example.com/events', secret } };
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };

// Real SQLite statements behind a synthetic D1 API; no cloud DB or HTTP is used.
async function fixture(t, afterWrite = () => {}) {
  const db = new DatabaseSync(':memory:'); db.exec(migration); t.after(() => db.close());
  const encryptionKey = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const database = { withSession(constraint) {
    assert.equal(constraint, 'first-primary');
    return { prepare(sql) { return { bind(...values) { return { async first() {
      const row = db.prepare(sql).get(...values) ?? null;
      if (/^(INSERT|UPDATE)/.test(sql)) afterWrite(sql, values);
      return row;
    } }; } }; } };
  } };
  const options = { database, encryptionKey, keyId: 'fixed-test-key' };
  const calls = [];
  const transport = { kind: 'synthetic-test', async post(url, request) {
    assert.equal(await request.beforeConnect(), true);
    const payload = JSON.parse(request.body); calls.push(payload);
    return { status: 200, body: payload.type === 'verification' ? JSON.stringify({ challenge: payload.challenge }) : '{}' };
  } };
  const make = (sender = transport) => createEventService({ store: createD1Store(options), transport: sender, revocationPollMs: 5 });
  const event = () => { const b = new MotionBridge(); b.begin('synthetic'); return b.ingest({ state: 'APPROACH', event: true, reason: 'doppler', score: 4 }); };
  return { db, options, calls, transport, make, event };
}
async function eventually(action) {
  for (let i = 0; i < 100; i++) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Synthetic operation did not reach the expected state');
}

test('encrypted D1 state integrates with subscription, dedup and rate state across service restarts', async t => {
  const f = await fixture(t), first = f.make();
  await first.subscribe(owner, params);
  const event = f.event();
  assert.equal((await first.ingest(owner, event)).body.accepted, true);
  const restarted = f.make();
  assert.equal((await restarted.status(owner)).subscriptionActive, true);
  assert.equal((await restarted.ingest(owner, event)).body.duplicate, true);
  assert.equal((await restarted.ingest(owner, f.event())).status, 429);
  assert.equal(f.calls.length, 2);
  const revoked = await restarted.disable(owner);
  assert.equal(revoked.body.stopState, 'confirmed');
  assert.equal((await f.make().status(owner)).subscriptionActive, false);
  const rows = f.db.prepare('SELECT * FROM sonic_bridge_state').all();
  assert.equal(JSON.stringify(rows).includes(secret), false);
  assert.equal(JSON.stringify(rows).includes(owner.userId), false);
});

test('two D1-backed workers persist pending stop until an ignored abort actually settles', async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred();
  const sender = { kind: 'synthetic-test', async post(url, request) {
    if (JSON.parse(request.body).type === 'verification') return f.transport.post(url, request);
    assert.equal(await request.beforeConnect(), true);
    entered.resolve(); await finish.promise;
    return { status: 200, body: '{}' };
  } };
  const a = f.make(sender), b = f.make();
  await a.subscribe(owner, params);
  const sending = a.ingest(owner, f.event()); await entered.promise;
  const stopped = await b.disable(owner);
  assert.equal(stopped.status, 202); assert.equal(stopped.body.stopState, 'pending');
  const result = await sending;
  assert.equal(result.body.accepted, false);
  assert.equal(result.body.outcome, 'disabled');
  const restarted = f.make();
  assert.equal((await restarted.status(owner)).pendingDispatches, 1);
  await assert.rejects(restarted.subscribe(owner, params), error => error.data.reason === 'dispatch_pending');
  finish.resolve();
  await eventually(async () => (await restarted.status(owner)).stopState === 'confirmed');
  assert.equal((await restarted.status(owner)).subscriptionActive, false);
});

test('a committed D1 admission with a lost write response cannot lead to a network call or blind retry', async t => {
  let failed = false;
  const f = await fixture(t, (sql, values) => {
    if (!failed && sql.startsWith('UPDATE') && values[1] === 2) { failed = true; throw new Error('synthetic response loss'); }
  });
  await assert.rejects(f.make().subscribe(owner, params));
  assert.equal(f.calls.length, 0);
  const state = await createD1Store(f.options).transaction(ownerKey, state => state);
  assert.equal(state.subscription, null);
  assert.ok(state.dispatch);
  assert.equal((await f.make().status(owner)).pendingDispatches, 1);
});

test('Sites receiver assembly has authenticated durable status/stop but no external transport', async t => {
  const f = await fixture(t);
  const origin = 'https://private.example';
  const handle = createSitesReceiver({ siteId: owner.siteId, siteOrigin: origin, ...f.options });
  assert.equal((await handle(new Request(origin + '/api/bridge/status'))).status, 401);
  const headers = { 'oai-authenticated-user-id': owner.userId, Origin: origin, 'Content-Type': 'application/json' };
  const status = await (await handle(new Request(origin + '/api/bridge/status', { headers }))).json();
  assert.equal(status.deliveryReady, false);
  assert.equal(status.blockedReason, 'safe-transport-required');
  assert.equal(status.stopState, 'confirmed');
  const rpc = await (await handle(new Request(origin + '/mcp', { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params }) }))).json();
  assert.equal(rpc.error.data.reason, 'safe-transport-required');
  assert.equal(f.calls.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventService, createSyntheticMemoryStore } from '../bridge/service.js';
import { MotionBridge } from '../src/bridge.js';

const owner = { siteId: 'dispatch-test-site', userId: 'dispatch-test-user' };
const ownerKey = JSON.stringify([owner.siteId, owner.userId]);
// Fixed synthetic fixtures only; no credentials, sockets or registered callbacks.
const secret = 'whsec_' + Buffer.alloc(32, 17).toString('base64');
const rotatedSecret = 'whsec_' + Buffer.alloc(32, 19).toString('base64');
const callback = 'https://callback.example.com/events';
const params = (signingSecret = secret) => ({ name: 'sonic.motion', arguments: {},
  delivery: { mode: 'webhook', url: callback, secret: signingSecret }, cursor: null });
const unsubscribeParams = () => ({ name: 'sonic.motion', arguments: {}, delivery: { mode: 'webhook', url: callback } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function whenAborted(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function fixture({ beforeAdmission, afterAdmission, afterConnection, afterCommit, responseFor,
  timeoutMs = 1000, replayMutators = false } = {}) {
  let time = Date.parse('2026-11-02T12:00:00.000Z');
  let insideMutator = false;
  let replayCount = 0;
  const base = createSyntheticMemoryStore();
  const watchers = new Set();
  const calls = [], connections = [];
  const store = { ...base, async transaction(key, mutate) {
    let before, after;
    const result = await base.transaction(key, state => {
      before = structuredClone(state);
      insideMutator = true;
      try {
        // Simulate a discarded CAS attempt, then run against the committed state.
        // Network side effects inside either invocation fail in the mock below.
        if (replayMutators) { mutate(structuredClone(state)); replayCount++; }
        const result = mutate(state);
        after = structuredClone(state);
        return result;
      } finally { insideMutator = false; }
    });
    if (key === ownerKey) {
      for (const watcher of [...watchers]) {
        if (watcher.predicate(after)) { watchers.delete(watcher); watcher.resolve(structuredClone(after)); }
      }
    }
    if (afterCommit) await afterCommit({ key, before, after, result });
    return result;
  } };
  const services = ['A', 'B'].map(worker => createEventService({ store, now: () => time,
    timeoutMs, revocationPollMs: 5, transport: { kind: 'synthetic-test', async post(url, request) {
      assert.equal(insideMutator, false, 'network must never run inside a retryable transaction');
      assert.equal(typeof request.beforeConnect, 'function', 'transport needs a durable connection gate');
      const call = { worker, url, request, payload: JSON.parse(request.body) };
      calls.push(call);
      if (beforeAdmission) await beforeAdmission(call);
      if (!await request.beforeConnect()) throw new Error('Dispatch was revoked before connection');
      if (afterAdmission) await afterAdmission(call);
      request.signal.throwIfAborted();
      connections.push(call);
      // This hook deliberately may ignore AbortSignal, modeling remote acceptance
      // or a transport that has not actually settled when the caller times out.
      if (afterConnection) await afterConnection(call);
      if (responseFor) {
        const response = responseFor(call);
        if (response) return response;
      }
      return { status: 200, body: call.payload.type === 'verification'
        ? JSON.stringify({ challenge: call.payload.challenge }) : '{}' };
    } },
  }));
  const state = () => store.transaction(ownerKey, value => value);
  const waitForState = predicate => {
    const gate = deferred();
    const watcher = { predicate, resolve: gate.resolve };
    watchers.add(watcher);
    // Install the observer before reading, so a fast settlement cannot be missed.
    state().catch(error => { watchers.delete(watcher); gate.resolve(Promise.reject(error)); });
    return gate.promise;
  };
  return { a: services[0], b: services[1], store, calls, connections, state, waitForState,
    replayCount: () => replayCount,
    advance: milliseconds => { time += milliseconds; },
    event() {
      const bridge = new MotionBridge({ now: () => time });
      bridge.begin('live');
      return bridge.ingest({ state: 'APPROACH', reason: 'doppler', score: 5, event: true });
    },
  };
}

function assertPending(result) {
  assert.equal(result.status, 202);
  assert.equal(result.body.unsubscribed, true);
  assert.equal(result.body.stopState, 'pending');
  assert.equal(result.body.pendingDispatches, 1);
}
async function assertStopped(service) {
  const status = await service.status(owner);
  assert.equal(status.subscriptionActive, false);
  assert.equal(status.deliveryReady, false);
  assert.equal(status.pendingDispatches, 0);
  assert.equal(status.stopState, 'confirmed');
}

test('worker B revokes a durable reservation while worker A has not entered transport', { timeout: 2000 }, async () => {
  const reserved = deferred(), release = deferred();
  let armed = false;
  const f = fixture({ afterCommit: async ({ before, after }) => {
    if (armed && !before.dispatch && after.dispatch) {
      armed = false; reserved.resolve(); await release.promise;
    }
  } });
  await f.a.subscribe(owner, params());
  armed = true;
  const sending = f.a.ingest(owner, f.event());
  await reserved.promise;
  assertPending(await f.b.disable(owner));
  release.resolve();
  assert.equal((await sending).body.accepted, false);
  await f.waitForState(state => !state.dispatch);
  assert.equal(f.connections.filter(call => call.payload.name === 'sonic.motion').length, 0);
  await assertStopped(f.b);
});

test('revocation after DNS work but before the transport gate prevents connection', { timeout: 2000 }, async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ beforeAdmission: async call => {
    if (call.payload.name === 'sonic.motion') { entered.resolve(); await release.promise; }
  } });
  await f.a.subscribe(owner, params());
  const sending = f.a.ingest(owner, f.event());
  await entered.promise;
  assertPending(await f.b.disable(owner));
  release.resolve();
  assert.equal((await sending).body.accepted, false);
  await f.waitForState(state => !state.dispatch);
  assert.equal(f.connections.length, 1, 'only initial verification may have connected');
  await assertStopped(f.b);
});

test('already admitted but paused work keeps stop pending until the transport settles', { timeout: 2000 }, async () => {
  const admitted = deferred(), release = deferred();
  const f = fixture({ afterAdmission: async call => {
    if (call.payload.name === 'sonic.motion') { admitted.resolve(call); await release.promise; }
  } });
  await f.a.subscribe(owner, params());
  const sending = f.a.ingest(owner, f.event());
  const call = await admitted.promise;
  assertPending(await f.b.disable(owner));
  await whenAborted(call.request.signal);
  assert.equal((await sending).body.accepted, false);
  assert.equal((await f.b.status(owner)).stopState, 'pending');
  release.resolve();
  await f.waitForState(state => !state.dispatch);
  assert.equal(f.connections.length, 1);
  await assertStopped(f.b);
});

test('cross-worker unsubscribe suppresses late 200 and retains permit beyond caller cancellation', { timeout: 2000 }, async () => {
  const connected = deferred(), release = deferred();
  const f = fixture({ afterConnection: async call => {
    if (call.payload.name === 'sonic.motion') { connected.resolve(call); await release.promise; }
  } });
  await f.a.subscribe(owner, params());
  const event = f.event();
  const sending = f.a.ingest(owner, event);
  const call = await connected.promise;
  assert.deepEqual(await f.b.unsubscribe(owner, unsubscribeParams()), {});
  const pending = await f.b.status(owner);
  assert.equal(pending.stopState, 'pending'); assert.equal(pending.pendingDispatches, 1);
  await whenAborted(call.request.signal);
  const result = await sending;
  assert.equal(result.body.accepted, false);
  assert.equal((await f.b.status(owner)).pendingDispatches, 1);
  release.resolve();
  await f.waitForState(state => !state.dispatch);
  await assertStopped(f.b);
  assert.equal((await f.b.ingest(owner, event)).body.accepted, false, 'late acceptance cannot replace disabled dedup result');
});

test('timeout, worker pause and a large clock jump cannot reclaim an unsettled permit', { timeout: 2000 }, async () => {
  const connected = deferred(), release = deferred();
  const f = fixture({ timeoutMs: 15, afterConnection: async call => {
    if (call.payload.name === 'sonic.motion') { connected.resolve(call); await release.promise; }
  } });
  await f.a.subscribe(owner, params());
  const sending = f.a.ingest(owner, f.event());
  const call = await connected.promise;
  await whenAborted(call.request.signal);
  assert.equal((await sending).body.accepted, false);
  const oldPermit = (await f.state()).dispatch;
  assert.ok(oldPermit);
  f.advance(24 * 60 * 60 * 1000);
  const expired = await f.b.status(owner);
  assert.equal(expired.subscriptionActive, false);
  assert.equal(expired.stopState, 'pending'); assert.equal(expired.pendingDispatches, 1);
  assert.equal((await f.state()).dispatch.id, oldPermit.id);
  assertPending(await f.b.disable(owner));
  await assert.rejects(f.b.subscribe(owner, params()));
  assert.equal((await f.b.ingest(owner, f.event())).body.accepted, false);
  assert.equal(f.connections.length, 2);
  release.resolve();
  await f.waitForState(state => !state.dispatch);
  await assertStopped(f.b);
});

test('one owner cannot use another worker or secret rotation to bypass an active dispatch', { timeout: 2000 }, async () => {
  const connected = deferred(), release = deferred();
  let hold = true;
  const f = fixture({ afterConnection: async call => {
    if (hold && call.payload.name === 'sonic.motion') { hold = false; connected.resolve(); await release.promise; }
  } });
  await f.a.subscribe(owner, params());
  const sending = f.a.ingest(owner, f.event());
  await connected.promise;
  f.advance(3001); // Exceed rate cooldown so the dispatch fence is what blocks B.
  const second = await f.b.ingest(owner, f.event());
  assert.equal(second.body.accepted, false);
  await assert.rejects(f.b.subscribe(owner, params(rotatedSecret)));
  assert.equal(f.connections.length, 2);
  assert.equal((await f.b.status(owner)).pendingDispatches, 1);
  release.resolve();
  assert.equal((await sending).body.accepted, true);
  await f.waitForState(state => !state.dispatch);
  f.advance(3001);
  assert.equal((await f.b.ingest(owner, f.event())).body.accepted, true);
  assert.equal(f.connections.length, 3);
});

test('an old transport completion cannot clear a different durable permit', { timeout: 2000 }, async () => {
  const connected = deferred(), release = deferred();
  const f = fixture({ afterConnection: async call => {
    if (call.payload.name === 'sonic.motion') { connected.resolve(call); await release.promise; }
  } });
  await f.a.subscribe(owner, params());
  const sending = f.a.ingest(owner, f.event());
  const call = await connected.promise;
  assertPending(await f.b.disable(owner));
  await whenAborted(call.request.signal);
  assert.equal((await sending).body.accepted, false);
  // Inject a replacement only in this test to exercise stale completion fencing.
  // Production must never reclaim a permit merely because its deadline expired.
  const replacementId = crypto.randomUUID();
  await f.store.transaction(ownerKey, state => {
    state.dispatch = { ...state.dispatch, id: replacementId, epoch: state.epoch };
  });
  const completed = deferred();
  const observed = f.store.transaction;
  f.store.transaction = async (key, mutate) => {
    const result = await observed(key, mutate);
    if (key === ownerKey) completed.resolve();
    return result;
  };
  release.resolve();
  await completed.promise;
  assert.equal((await f.state()).dispatch.id, replacementId);
  assert.equal((await f.b.status(owner)).stopState, 'pending');
});

test('unsubscribe during rotated-secret verification cannot restore the old subscription', { timeout: 2000 }, async () => {
  const verifying = deferred(), release = deferred();
  let verificationCount = 0;
  const f = fixture({ afterConnection: async call => {
    if (call.payload.type === 'verification' && ++verificationCount === 2) { verifying.resolve(call); await release.promise; }
  } });
  await f.a.subscribe(owner, params());
  const rotating = f.a.subscribe(owner, params(rotatedSecret));
  const rejected = assert.rejects(rotating);
  const call = await verifying.promise;
  assertPending(await f.b.disable(owner));
  await whenAborted(call.request.signal);
  await rejected;
  assert.equal((await f.state()).subscription, null);
  assert.equal((await f.b.status(owner)).stopState, 'pending');
  release.resolve();
  await f.waitForState(state => !state.dispatch);
  assert.equal((await f.state()).subscription, null);
  await assertStopped(f.b);
});

test('discarded CAS mutator attempts and concurrent duplicates never duplicate network effects', { timeout: 2000 }, async () => {
  const f = fixture({ replayMutators: true });
  await f.a.subscribe(owner, params());
  assert.equal(f.connections.length, 1);
  const event = f.event();
  const responses = await Promise.all([f.a.ingest(owner, event), f.b.ingest(owner, event)]);
  assert.ok(responses.some(result => result.body.accepted));
  assert.equal(f.connections.filter(call => call.payload.name === 'sonic.motion').length, 1);
  assert.ok(f.replayCount() > 0);
  assert.equal((await f.b.status(owner)).pendingDispatches, 0);
});

test('revocation after a successful active read still suppresses the final acknowledgement', { timeout: 2000 }, async () => {
  const checked = deferred(), release = deferred();
  let armed = false;
  const f = fixture({ afterCommit: async ({ after, result }) => {
    if (armed && result === true && !after.dispatch && after.subscription?.state === 'active') {
      armed = false; checked.resolve(); await release.promise;
    }
  } });
  await f.a.subscribe(owner, params());
  armed = true;
  const event = f.event();
  const sending = f.a.ingest(owner, event);
  await checked.promise;
  const stopped = await f.b.disable(owner);
  assert.equal(stopped.status, 200); assert.equal(stopped.body.stopState, 'confirmed');
  release.resolve();
  const result = await sending;
  assert.equal(result.body.accepted, false, 'a stale pre-ack read cannot override durable revocation');
  assert.equal((await f.b.ingest(owner, event)).body.accepted, false);
  await assertStopped(f.b);
});

test('a stale callback 410 cannot revoke a newer subscription generation', { timeout: 2000 }, async () => {
  const checked = deferred(), release = deferred();
  let armed = false;
  const f = fixture({
    responseFor: call => call.payload.name === 'sonic.motion' ? { status: 410, body: '{}' } : null,
    afterCommit: async ({ after, result }) => {
      if (armed && result === true && !after.dispatch && after.subscription?.state === 'active') {
        armed = false; checked.resolve(); await release.promise;
      }
    },
  });
  await f.a.subscribe(owner, params());
  const previousGeneration = (await f.state()).subscription.generation;
  armed = true;
  const sending = f.a.ingest(owner, f.event());
  await checked.promise;
  await f.b.subscribe(owner, params(rotatedSecret));
  const currentGeneration = (await f.state()).subscription.generation;
  assert.notEqual(currentGeneration, previousGeneration);
  release.resolve();
  assert.equal((await sending).body.accepted, false);
  assert.equal((await f.b.status(owner)).subscriptionActive, true);
  assert.equal((await f.state()).subscription.generation, currentGeneration);
});

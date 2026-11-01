import { eventDefinition, toMcpEvent } from './mcp-events.js';
import { validateMotionEvent } from '../src/bridge.js';

const MAX_BYTES = 8192;
const FRESH_MS = 300000;
const FUTURE_MS = 30000;
const MIN_INTERVAL_MS = 3000;
const DEFAULT_TTL_MS = 3600000;
const MIN_TTL_MS = 60000;
const MAX_IDS = 512;
const MAX_PER_MINUTE = 60;
const encoder = new TextEncoder();

/** Identity must come from a verified, site-scoped server adapter, never a request header/body.
 * @typedef {{siteId: string, userId: string}} TrustedPrincipal
 */

export class EventServiceError extends Error {
  constructor(code, message, reason) {
    super(message); this.code = code; this.data = { reason };
  }
}
const invalid = () => new EventServiceError(-32602, 'Invalid event parameters', 'invalid_params');

function ownerKey(principal) {
  if (!principal || typeof principal.siteId !== 'string' || !principal.siteId || principal.siteId.length > 200 ||
      typeof principal.userId !== 'string' || !principal.userId || principal.userId.length > 200) return null;
  return JSON.stringify([principal.siteId, principal.userId]);
}
function keys(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => [...required, ...optional].includes(key));
}
function base64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function secretBytes(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw invalid();
  let bytes;
  try { bytes = Uint8Array.from(atob(secret.slice(6)), character => character.charCodeAt(0)); }
  catch { throw invalid(); }
  if (bytes.length < 24 || bytes.length > 64 || base64(bytes).replace(/=+$/, '') !== secret.slice(6).replace(/=+$/, '')) throw invalid();
  return bytes;
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function signingKey(secret) {
  return crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signature(secret, content) {
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(content))));
}
async function equalChallenge(secret, expected, actual) {
  if (typeof actual !== 'string' || actual.length > 256) return false;
  const key = await signingKey(secret);
  const expectedMac = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  // Native HMAC verification avoids a timing-sensitive string comparison.
  return crypto.subtle.verify('HMAC', key, expectedMac, encoder.encode(actual));
}
function callbackUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      !url.hostname.includes('.') || [':', '[', ']'].some(character => url.hostname.includes(character)) || /^\d+(?:\.\d+){3}$/.test(url.hostname) ||
      /(?:^|\.)(localhost|local|internal|invalid|test)$/.test(url.hostname)) throw invalid();
  // Syntax is only the first check. A real transport must validate DNS and pin
  // the public address at connection time, for every POST, with no redirects.
  return url.href;
}
function parameters(params, subscribe) {
  if (!keys(params, ['name', 'arguments', 'delivery'], subscribe ? ['cursor', 'ttlMs'] : []) ||
      params.name !== eventDefinition.name || !keys(params.arguments, [], ['includeSynthetic']) ||
      (Object.hasOwn(params.arguments, 'includeSynthetic') && typeof params.arguments.includeSynthetic !== 'boolean') ||
      !keys(params.delivery, subscribe ? ['mode', 'url', 'secret'] : ['mode', 'url']) || params.delivery.mode !== 'webhook') throw invalid();
  if (subscribe && params.cursor !== undefined && params.cursor !== null) throw invalid();
  let ttl = DEFAULT_TTL_MS;
  if (subscribe && params.ttlMs !== undefined && params.ttlMs !== null) {
    if (!Number.isSafeInteger(params.ttlMs) || params.ttlMs < MIN_TTL_MS) throw invalid();
    ttl = Math.min(params.ttlMs, DEFAULT_TTL_MS);
  }
  if (subscribe) secretBytes(params.delivery.secret);
  return { name: params.name, arguments: { includeSynthetic: params.arguments.includeSynthetic === true },
    url: callbackUrl(params.delivery.url), secret: subscribe ? params.delivery.secret : null, ttl };
}
function newState() {
  return { epoch: 0, subscription: null, ids: {}, minuteStart: 0, minuteCount: 0, lastMotionAt: null };
}
function prune(state, now) {
  for (const [id, entry] of Object.entries(state.ids)) if (entry.expires <= now) delete state.ids[id];
  if (state.subscription?.expiresAt <= now) state.subscription = null;
  if (state.subscription?.previousSecretUntil <= now) {
    state.subscription.previousSecret = null; state.subscription.previousSecretUntil = null;
  }
}

/**
 * Tests only: bounded process-local storage. This is never production persistence.
 * A real store must provide atomic, synchronous-mutator transactions, durable
 * expiry/deletion, encryption of secrets at rest, and isolation by the supplied key.
 * Its transaction(owner, mutate) loads state (newState() for a missing owner),
 * commits all mutations atomically, and returns the mutator's cloned return value.
 * Atomic storage alone is insufficient for multiple dispatch workers: a production
 * adapter must fence revocation against connection creation across all workers.
 * Only the explicit in-process synthetic configuration is exercised here.
 */
export function createSyntheticMemoryStore({ maxOwners = 128 } = {}) {
  if (!Number.isSafeInteger(maxOwners) || maxOwners < 1 || maxOwners > 1024) throw new TypeError('Invalid synthetic store capacity');
  const records = new Map();
  return Object.freeze({
    kind: 'synthetic-memory', atomic: true,
    async transaction(owner, mutate) {
      if (!records.has(owner) && records.size >= maxOwners) throw new EventServiceError(-32000, 'Synthetic store capacity reached', 'owner_capacity');
      const state = structuredClone(records.get(owner) || newState());
      const result = mutate(state);
      if (result && typeof result.then === 'function') throw new TypeError('Store mutators must be synchronous');
      records.set(owner, structuredClone(state));
      return structuredClone(result);
    },
  });
}

/**
 * Server-only service. The default has no store or network transport and fails closed.
 * Test transports must identify themselves as kind:'synthetic-test'. A production
 * transport is a trusted server-created instance with kind:'safe-https',
 * productionSafe:true and post(url,{headers,body,signal})->{status,body:string}.
 * These are adapter contracts, never flags accepted from a client request.
 */
export function createEventService({ store = null, transport = null, now = () => Date.now(), timeoutMs = 5000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new TypeError('Invalid callback timeout');
  const testMode = store?.kind === 'synthetic-memory' && transport?.kind === 'synthetic-test';
  const ready = Boolean(store?.transaction && (testMode || (store?.kind === 'durable' && store.atomic === true &&
    store.encryptedSecrets === true && transport?.kind === 'safe-https' && transport.productionSafe === true)) && typeof transport?.post === 'function');
  const configurationBlock = !store ? 'durable-store-required' : !transport ? 'safe-transport-required' : !ready ? 'unverified-storage-or-transport' : null;
  const inflight = new Map();
  const pendingSubscriptions = new Map();
  function requireOwner(principal) {
    const owner = ownerKey(principal);
    if (!owner) throw new EventServiceError(-32000, 'Authentication required', 'unauthenticated');
    return owner;
  }
  function requireReady() {
    if (!ready) throw new EventServiceError(-32603, 'Event service is not configured for delivery', configurationBlock);
  }
  function register(owner) {
    const controller = new AbortController();
    if (!inflight.has(owner)) inflight.set(owner, new Set());
    inflight.get(owner).add(controller);
    return controller;
  }
  function unregister(owner, controller) {
    inflight.get(owner)?.delete(controller);
    if (inflight.get(owner)?.size === 0) inflight.delete(owner);
  }
  function abortOwner(owner) {
    for (const controller of inflight.get(owner) || []) controller.abort('disabled');
  }
  async function active(owner, generation) {
    return store.transaction(owner, state => {
      prune(state, now());
      return state.subscription?.generation === generation;
    });
  }
  async function postSigned(owner, subscription, payload, id, controller) {
    const body = JSON.stringify(payload);
    if (encoder.encode(body).byteLength > MAX_BYTES) throw new Error('Callback body exceeds limit');
    const timestamp = String(Math.floor(now() / 1000));
    const content = `${id}.${timestamp}.${body}`;
    const signatures = [`v1,${await signature(subscription.secret, content)}`];
    if (subscription.previousSecret && subscription.previousSecretUntil > now()) signatures.push(`v1,${await signature(subscription.previousSecret, content)}`);
    if (controller.signal.aborted || !await active(owner, subscription.generation)) throw new Error('Subscription disabled');
    const remaining = subscription.expiresAt - now();
    if (remaining <= 0) throw new Error('Subscription expired');
    let timer, onAbort;
    try {
      const cancelled = new Promise((resolve, reject) => {
        onAbort = () => reject(new Error(controller.signal.reason === 'timeout' ? 'Callback timeout' : 'Subscription disabled'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      timer = setTimeout(() => controller.abort(remaining <= timeoutMs ? 'expired' : 'timeout'), Math.min(timeoutMs, remaining));
      controller.signal.throwIfAborted();
      const response = await Promise.race([transport.post(subscription.url, { body, signal: controller.signal, headers: {
        'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
        'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscription.id,
      } }), cancelled]);
      if (controller.signal.aborted || !await active(owner, subscription.generation)) throw new Error('Subscription disabled');
      if (!response || !Number.isInteger(response.status) || typeof response.body !== 'string' || encoder.encode(response.body).byteLength > MAX_BYTES) throw new Error('Invalid callback response');
      return response;
    } finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }
  async function status(principal) {
    const owner = ownerKey(principal);
    if (!owner) return { authenticated: false, subscriptionActive: false, deliveryReady: false,
      blockedReason: 'unauthenticated', delivery: 'mcp-webhook', testMode };
    const subscription = store ? await store.transaction(owner, state => { prune(state, now()); return state.subscription; }) : null;
    const subscriptionActive = subscription?.state === 'active';
    return { authenticated: true, subscriptionActive, deliveryReady: ready && subscriptionActive,
      blockedReason: configurationBlock || (subscriptionActive ? null : 'no-active-subscription'), delivery: 'mcp-webhook', testMode };
  }
  async function subscribe(principal, params) {
    const owner = requireOwner(principal), parsed = parameters(params, true);
    requireReady();
    const epoch = await store.transaction(owner, state => { prune(state, now()); return state.epoch; });
    const id = 'sub_' + await digest(JSON.stringify([owner, parsed.url, parsed.name, parsed.arguments]));
    const pendingKey = owner + ':' + id + ':' + await digest(parsed.secret);
    if (pendingSubscriptions.has(pendingKey)) return pendingSubscriptions.get(pendingKey);
    const operation = (async () => {
      const generation = crypto.randomUUID();
      const reserved = await store.transaction(owner, state => {
        prune(state, now());
        if (state.epoch !== epoch) throw new EventServiceError(-32000, 'Subscription was disabled', 'disabled');
        if (state.subscription && state.subscription.id !== id) throw new EventServiceError(-32000, 'One subscription per owner is allowed', 'subscription_limit');
        if (state.subscription?.state === 'verifying') throw new EventServiceError(-32000, 'Subscription verification is pending', 'verification_pending');
        if (state.subscription?.state === 'active' && state.subscription.secret === parsed.secret) {
          state.subscription.expiresAt = now() + parsed.ttl;
          return { existing: true, subscription: state.subscription };
        }
        const previous = state.subscription;
        state.subscription = { id, generation, url: parsed.url, arguments: parsed.arguments,
          secret: parsed.secret, expiresAt: now() + parsed.ttl, state: 'verifying',
          previousSecret: null, previousSecretUntil: null };
        return { existing: false, subscription: state.subscription, previous };
      });
      const subscription = reserved.subscription;
      if (!reserved.existing) {
        const controller = register(owner);
        try {
          const challenge = base64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, value => ({ '+': '-', '/': '_', '=': '' }[value]));
          const response = await postSigned(owner, subscription, { type: 'verification', challenge }, 'msg_verification_' + crypto.randomUUID(), controller);
          let echoed;
          try { echoed = JSON.parse(response.body); } catch { /* Rejected below. */ }
          if (response.status < 200 || response.status >= 300 || !keys(echoed, ['challenge']) || !await equalChallenge(subscription.secret, challenge, echoed.challenge)) throw new Error('Challenge failed');
          await store.transaction(owner, state => {
            prune(state, now());
            if (state.subscription?.generation !== generation || controller.signal.aborted) throw new Error('Subscription disabled');
            state.subscription.state = 'active';
            if (reserved.previous?.secret && reserved.previous.secret !== subscription.secret) {
              state.subscription.previousSecret = reserved.previous.secret;
              state.subscription.previousSecretUntil = now() + 30000;
            }
          });
        } catch {
          await store.transaction(owner, state => {
            if (state.subscription?.generation === generation) {
              state.subscription = reserved.previous?.expiresAt > now() ? reserved.previous : null;
            }
          });
          throw new EventServiceError(-32015, 'Callback verification failed', controller.signal.reason === 'timeout' ? 'timeout' : 'challenge_failed');
        } finally { unregister(owner, controller); }
      }
      return { id, refreshBefore: new Date(subscription.expiresAt).toISOString(), cursor: null, truncated: false };
    })();
    pendingSubscriptions.set(pendingKey, operation);
    try { return await operation; }
    finally { if (pendingSubscriptions.get(pendingKey) === operation) pendingSubscriptions.delete(pendingKey); }
  }
  async function disable(principal) {
    const owner = requireOwner(principal);
    abortOwner(owner);
    if (store) await store.transaction(owner, state => { state.epoch++; state.subscription = null; });
    return { status: 200, body: { unsubscribed: true, delivery: 'mcp-webhook' } };
  }
  async function unsubscribe(principal, params) {
    const owner = requireOwner(principal), parsed = parameters(params, false);
    const id = 'sub_' + await digest(JSON.stringify([owner, parsed.url, parsed.name, parsed.arguments]));
    if (store) {
      const removed = await store.transaction(owner, state => {
        if (state.subscription && state.subscription.id !== id) return false;
        // Also fence a subscribe still hashing its identity before reservation.
        // Otherwise an unsubscribe could return before that older call activates.
        state.epoch++; state.subscription = null; return true;
      });
      if (removed) abortOwner(owner);
    }
    return {};
  }
  function acknowledgement(eventId, outcome, statusCode, extra = {}) {
    return { status: statusCode, body: { accepted: outcome === 'callback-accepted', eventId,
      delivery: 'mcp-webhook', outcome, testMode, ...extra } };
  }
  async function ingest(principal, event) {
    const owner = ownerKey(principal);
    if (!owner) return acknowledgement(null, 'blocked', 401, { reason: 'unauthenticated' });
    let raw;
    try { raw = JSON.stringify(event); } catch { return acknowledgement(null, 'blocked', 400, { reason: 'invalid-event' }); }
    if (!raw || encoder.encode(raw).byteLength > MAX_BYTES) return acknowledgement(null, 'blocked', 413, { reason: 'event-size' });
    if (!validateMotionEvent(event)) return acknowledgement(null, 'blocked', 400, { reason: 'invalid-event' });
    const occurred = Date.parse(event.occurredAt), time = now();
    if (occurred < time - FRESH_MS || occurred > time + FUTURE_MS) return acknowledgement(event.id, 'blocked', 400, { reason: 'event-time' });
    if (!ready) return acknowledgement(event.id, 'blocked', 503, { reason: configurationBlock });
    const fingerprint = await digest(JSON.stringify([event.schemaVersion, event.id, event.sessionId, event.sequence,
      event.occurredAt, event.source, event.mode, event.type, event.state, event.reason,
      event.score && [event.score.value, event.score.unit, event.score.basis]]));
    const reserved = await store.transaction(owner, state => {
      prune(state, now());
      const previous = state.ids[event.id];
      if (previous) {
        if (previous.fingerprint !== fingerprint) return { response: acknowledgement(event.id, 'blocked', 409, { reason: 'id-conflict' }) };
        return { response: acknowledgement(event.id, previous.outcome === 'pending' ? 'delivery-uncertain' : previous.outcome,
          previous.status, { duplicate: true, reason: previous.reason }) };
      }
      if (Object.keys(state.ids).length >= MAX_IDS) return { response: acknowledgement(event.id, 'rate-limited', 429, { reason: 'dedup-capacity' }) };
      const entry = { fingerprint, expires: Math.max(now(), occurred) + FRESH_MS + 1, outcome: 'pending', status: 409, reason: null };
      state.ids[event.id] = entry;
      const drop = (outcome, code, reason) => {
        entry.outcome = outcome; entry.status = code; entry.reason = reason;
        return { response: acknowledgement(event.id, outcome, code, { reason }) };
      };
      const subscription = state.subscription;
      if (!subscription || subscription.state !== 'active') return drop('blocked', 409, 'no-active-subscription');
      if (event.type !== 'motion.detected') return drop('filtered', 200, 'lifecycle-not-delivered');
      if (event.mode === 'synthetic' && !subscription.arguments.includeSynthetic) return drop('filtered', 200, 'synthetic-disabled');
      if (now() - state.minuteStart >= 60000) { state.minuteStart = now(); state.minuteCount = 0; }
      if (state.minuteCount >= MAX_PER_MINUTE || (state.lastMotionAt !== null && now() - state.lastMotionAt < MIN_INTERVAL_MS)) return drop('rate-limited', 429, 'motion-rate');
      state.minuteCount++; state.lastMotionAt = now();
      return { subscription };
    });
    if (reserved.response) return reserved.response;
    const subscription = reserved.subscription, controller = register(owner);
    let outcome = 'delivery-uncertain', statusCode = 502, reason = 'callback-unconfirmed';
    try {
      const response = await postSigned(owner, subscription, toMcpEvent(event), event.id, controller);
      if (response.status >= 200 && response.status < 300) { outcome = 'callback-accepted'; statusCode = 202; reason = null; }
      else {
        outcome = 'callback-rejected'; reason = 'callback-http-error';
        if (response.status === 410) await disable(principal);
      }
    } catch {
      if (controller.signal.reason === 'disabled' || !await active(owner, subscription.generation)) { outcome = 'disabled'; statusCode = 409; reason = 'subscription-disabled'; }
      else reason = controller.signal.reason === 'timeout' ? 'timeout' : 'callback-unconfirmed';
    } finally { unregister(owner, controller); }
    await store.transaction(owner, state => {
      if (state.ids[event.id]?.fingerprint === fingerprint) {
        Object.assign(state.ids[event.id], { outcome, status: statusCode, reason });
      }
    });
    return acknowledgement(event.id, outcome, statusCode, { duplicate: false, reason });
  }
  function eventList(params = {}) {
    if (!keys(params, [], ['cursor']) || (params.cursor !== undefined && params.cursor !== null)) throw invalid();
    return { events: [structuredClone(eventDefinition)] };
  }
  async function rpc(principal, request) {
    const id = request?.id ?? null;
    try {
      requireOwner(principal);
      if (!keys(request, ['jsonrpc', 'id', 'method'], ['params']) || request.jsonrpc !== '2.0' ||
        !['string', 'number'].includes(typeof request.id) || typeof request.method !== 'string') throw new EventServiceError(-32600, 'Invalid JSON-RPC request', 'invalid_request');
      const params = request.params ?? {};
      let result;
      switch (request.method) {
        case 'events/list': result = eventList(params); break;
        case 'events/subscribe': result = await subscribe(principal, params); break;
        case 'events/unsubscribe': result = await unsubscribe(principal, params); break;
        case 'server/discover':
          if (!keys(params, [])) throw invalid();
          result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } }; break;
        case 'tools/list':
          if (!keys(params, [], ['cursor']) || (params.cursor !== undefined && params.cursor !== null)) throw invalid();
          result = { tools: [{ name: 'sonic_bridge_status', description: 'Read this authenticated user\'s motion event subscription status. Does not start sensing or enable delivery.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] }; break;
        case 'tools/call':
          if (!keys(params, ['name'], ['arguments']) || params.name !== 'sonic_bridge_status' || !keys(params.arguments ?? {}, [])) throw invalid();
          try { result = { content: [{ type: 'text', text: JSON.stringify(await status(principal)) }] }; }
          catch { result = { content: [{ type: 'text', text: 'Subscription status is unavailable.' }], isError: true }; }
          break;
        default: throw new EventServiceError(-32601, 'Method not found', 'method_not_found');
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      const failure = error instanceof EventServiceError ? error : new EventServiceError(-32603, 'Event service operation failed', 'internal_error');
      return { jsonrpc: '2.0', id, error: { code: failure.code, message: failure.message, data: failure.data } };
    }
  }
  return Object.freeze({ status, subscribe, unsubscribe, disable, ingest, capture: ingest, eventList, rpc });
}

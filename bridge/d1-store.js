// Server-only D1 adapter. No schema creation, outbound HTTP, logging, or key generation.
const SCHEMA_VERSION = 1;
const SCHEMA_ID = 'sonic-bridge-owner-state-v1';
const MAX_STATE_BYTES = 262144;
const MAX_CIPHERTEXT_BYTES = MAX_STATE_BYTES + 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const stores = new WeakSet();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const token = /^[a-z][a-z0-9_-]{0,63}$/;

const READ = `SELECT s.version AS schema_version, s.schema_id,
  r.owner_hash, r.format_version, r.revision, r.key_id, r.nonce, r.ciphertext, r.updated_at
  FROM sonic_bridge_schema AS s
  LEFT JOIN sonic_bridge_state AS r ON r.owner_hash = ?1
  WHERE s.singleton = 1 LIMIT 1`;
const INSERT = `INSERT INTO sonic_bridge_state
  (owner_hash, format_version, revision, key_id, nonce, ciphertext, updated_at)
  VALUES (?1, 1, 1, ?2, ?3, ?4, ?5)
  ON CONFLICT(owner_hash) DO NOTHING RETURNING revision`;
const UPDATE = `UPDATE sonic_bridge_state
  SET revision = ?2, key_id = ?3, nonce = ?4, ciphertext = ?5, updated_at = ?6
  WHERE owner_hash = ?1 AND revision = ?7 AND format_version = 1 AND key_id = ?3
  RETURNING revision`;

/** Sanitized errors intentionally omit SQL parameters, owner IDs, and underlying messages. */
export class D1StoreError extends Error {
  constructor(code) { super(`D1 state operation failed: ${code}`); this.name = 'D1StoreError'; this.code = code; }
}
/** This brand comes only from this module's factory, never from client-supplied flags. */
export function isD1Store(value) { return Boolean(value && stores.has(value)); }
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}
function keys(value, expected) {
  return plain(value) && Reflect.ownKeys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
const integer = value => Number.isSafeInteger(value) && value >= 0;
function validSecret(value) {
  if (typeof value !== 'string' || value.length > 94 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = decodeBase64(value.slice(6));
    return bytes.length >= 24 && bytes.length <= 64;
  } catch { return false; }
}
function validSubscription(value) {
  if (value === null) return true;
  if (!keys(value, ['id', 'generation', 'url', 'arguments', 'secret', 'expiresAt', 'state', 'previousSecret', 'previousSecretUntil']) ||
    typeof value.id !== 'string' || !/^sub_[0-9a-f]{64}$/.test(value.id) || !uuid.test(value.generation) ||
    typeof value.url !== 'string' || value.url.length > 2048 || !keys(value.arguments, ['includeSynthetic']) ||
    typeof value.arguments.includeSynthetic !== 'boolean' || !validSecret(value.secret) || !integer(value.expiresAt) ||
    !['verifying', 'active'].includes(value.state)) return false;
  if (value.previousSecret === null ? value.previousSecretUntil !== null : !validSecret(value.previousSecret) || !integer(value.previousSecretUntil)) return false;
  try {
    const url = new URL(value.url);
    // Persist only the same syntactic destinations accepted by the service.
    // Public DNS/address checks remain the connection-time transport's job.
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') &&
      ![...value.url].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) &&
      url.hostname.includes('.') && ![':', '[', ']'].some(character => url.hostname.includes(character)) &&
      !/^\d+(?:\.\d+){3}$/.test(url.hostname) && !/(?:^|\.)(localhost|local|internal|invalid|test)$/.test(url.hostname);
  } catch { return false; }
}
function validDispatch(value) {
  return value === null || (keys(value, ['id', 'epoch', 'generation', 'phase', 'startedAt', 'deadlineAt', 'revocationRequested']) &&
    uuid.test(value.id) && integer(value.epoch) && uuid.test(value.generation) &&
    ['reserved', 'inflight', 'uncertain'].includes(value.phase) && integer(value.startedAt) &&
    integer(value.deadlineAt) && value.deadlineAt >= value.startedAt && typeof value.revocationRequested === 'boolean');
}
function validState(state) {
  if (!keys(state, ['epoch', 'subscription', 'ids', 'minuteStart', 'minuteCount', 'lastMotionAt', 'dispatch']) ||
      !integer(state.epoch) || !validSubscription(state.subscription) || !plain(state.ids) ||
      Object.keys(state.ids).length > 512 || !integer(state.minuteStart) || !integer(state.minuteCount) ||
      state.minuteCount > 60 || (state.lastMotionAt !== null && !integer(state.lastMotionAt)) || !validDispatch(state.dispatch)) return false;
  return Object.entries(state.ids).every(([id, entry]) => uuid.test(id) &&
    keys(entry, ['fingerprint', 'expires', 'outcome', 'status', 'reason']) && hash.test(entry.fingerprint) &&
    integer(entry.expires) && typeof entry.outcome === 'string' && token.test(entry.outcome) &&
    Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599 &&
    (entry.reason === null || (typeof entry.reason === 'string' && token.test(entry.reason))));
}
function initialState() {
  return { epoch: 0, subscription: null, ids: {}, minuteStart: 0, minuteCount: 0, lastMotionAt: null, dispatch: null };
}
function encodeBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}
function decodeBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new D1StoreError('invalid-record');
  let bytes;
  try { bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
  catch { throw new D1StoreError('invalid-record'); }
  if (encodeBase64(bytes).replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new D1StoreError('invalid-record');
  return bytes;
}
async function ownerHash(owner) {
  if (typeof owner !== 'string' || !owner || encoder.encode(owner).length > 1024) throw new D1StoreError('invalid-owner');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(owner)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function additionalData(owner, revision, keyId) {
  return encoder.encode(JSON.stringify([SCHEMA_ID, SCHEMA_VERSION, owner, revision, keyId]));
}

/**
 * Prototype configuration: createD1Store({ database: env.EXISTING_D1_BINDING,
 *   encryptionKey: trustedNonextractableAesGcm256Key, keyId: 'owner-state-v1' }).
 * The binding, key, and label are server configuration, never request fields.
 * Apply migrations/0001_bridge_state.sql through the supported Sites migration workflow.
 * No fallback/reset occurs if the schema, encryption key, or stored state is wrong.
 *
 * Mutators MUST be synchronous and free of I/O or observable side effects: a
 * confirmed revision conflict can rerun them up to maxAttempts. A thrown database
 * write has an unknown outcome and is NEVER automatically retried. The caller must
 * fail closed and reconcile durable state before performing a dependent side effect.
 * Dispatch records and epochs never expire here; a crashed operation remains blocked.
 * D1 CAS is storage serialization, not proof that an HTTP request was cancelled.
 *
 * @param {{database: {withSession: (constraint: string) => {prepare: (sql: string) => {bind: (...values: (string|number)[]) => {first: () => Promise<any>}}}}, encryptionKey: CryptoKey, keyId: string, now?: () => number, maxAttempts?: number}} options
 */
export function createD1Store({ database, encryptionKey, keyId, now = () => Date.now(), maxAttempts = 4 }) {
  const algorithm = /** @type {AesKeyAlgorithm} */ (encryptionKey?.algorithm);
  if (!database || typeof database.withSession !== 'function' || !(encryptionKey instanceof CryptoKey) ||
    encryptionKey.type !== 'secret' || encryptionKey.extractable || algorithm.name !== 'AES-GCM' || algorithm.length !== 256 ||
    !encryptionKey.usages.includes('encrypt') || !encryptionKey.usages.includes('decrypt') ||
    typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || typeof now !== 'function' ||
    !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) throw new D1StoreError('invalid-configuration');

  async function decode(row, owner) {
    if (!row || row.schema_version !== SCHEMA_VERSION || row.schema_id !== SCHEMA_ID) throw new D1StoreError('schema-mismatch');
    if (row.owner_hash === null) return { revision: 0, state: initialState() };
    if (row.owner_hash !== owner || row.format_version !== SCHEMA_VERSION || !integer(row.revision) || row.revision < 1 ||
      row.key_id !== keyId || !integer(row.updated_at) || typeof row.ciphertext !== 'string' || row.ciphertext.length > 349548) throw new D1StoreError('invalid-record');
    const nonce = decodeBase64(row.nonce), ciphertext = decodeBase64(row.ciphertext);
    if (nonce.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_CIPHERTEXT_BYTES) throw new D1StoreError('invalid-record');
    let state;
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce,
        additionalData: additionalData(owner, row.revision, keyId), tagLength: 128 }, encryptionKey, ciphertext);
      if (plaintext.byteLength > MAX_STATE_BYTES) throw new Error('State exceeds limit');
      state = JSON.parse(decoder.decode(plaintext));
    } catch { throw new D1StoreError('state-authentication-failed'); }
    if (!validState(state)) throw new D1StoreError('invalid-state');
    return { revision: row.revision, state };
  }
  const store = Object.freeze({
    kind: 'durable', adapter: 'cloudflare-d1-cas-v1', atomic: true, encryptedSecrets: true,
    async transaction(owner, mutate) {
      if (typeof mutate !== 'function') throw new D1StoreError('invalid-mutator');
      const indexedOwner = await ownerHash(owner);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // A NEW primary-started session is required on each CAS attempt. Reusing
        // a session after conflict can otherwise repeatedly read an older replica.
        let session, row;
        try {
          session = database.withSession('first-primary');
          row = await session.prepare(READ).bind(indexedOwner).first();
        } catch { throw new D1StoreError('read-failed'); }
        const { revision, state } = await decode(row, indexedOwner);
        const before = JSON.stringify(state);
        const result = mutate(state);
        if (result && typeof result.then === 'function') {
          void Promise.resolve(result).catch(() => {});
          throw new D1StoreError('async-mutator');
        }
        if (!validState(state)) throw new D1StoreError('invalid-state');
        let resultCopy;
        try { resultCopy = structuredClone(result); } catch { throw new D1StoreError('invalid-result'); }
        const serialized = JSON.stringify(state);
        // The first query was a fresh primary read, so a read-only transaction
        // can linearize at that SELECT without rewriting encrypted state. Dispatch
        // still needs a separate durable permit; a read cannot fence later I/O.
        if (serialized === before) return resultCopy;
        if (revision >= Number.MAX_SAFE_INTEGER) throw new D1StoreError('revision-exhausted');
        const plaintext = encoder.encode(serialized);
        if (plaintext.byteLength > MAX_STATE_BYTES) throw new D1StoreError('state-size');
        const nextRevision = revision + 1, nonce = crypto.getRandomValues(new Uint8Array(12)), updated = now();
        if (!integer(updated)) throw new D1StoreError('invalid-clock');
        let ciphertext;
        try {
          ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
            additionalData: additionalData(indexedOwner, nextRevision, keyId), tagLength: 128 }, encryptionKey, plaintext));
        } catch { throw new D1StoreError('encryption-failed'); }
        let committed;
        try {
          committed = revision === 0
            ? await session.prepare(INSERT).bind(indexedOwner, keyId, encodeBase64(nonce), encodeBase64(ciphertext), updated).first()
            : await session.prepare(UPDATE).bind(indexedOwner, nextRevision, keyId, encodeBase64(nonce), encodeBase64(ciphertext), updated, revision).first();
        } catch { throw new D1StoreError('write-outcome-unknown'); }
        if (committed === null) continue; // Only a confirmed CAS miss can retry.
        if (!committed || committed.revision !== nextRevision) throw new D1StoreError('write-outcome-unknown');
        return resultCopy;
      }
      throw new D1StoreError('revision-contention');
    },
  });
  stores.add(store);
  return store;
}

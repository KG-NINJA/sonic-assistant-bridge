import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createD1Store, isD1Store } from '../bridge/d1-store.js';

// These tests execute real SQLite SQL behind a small D1 binding API emulator.
// They do not connect to Workers/D1, create cloud resources, or provision secrets.
const migration = await readFile(new URL('../migrations/0001_bridge_state.sql', import.meta.url), 'utf8');
const owner = JSON.stringify(['test-site', 'test-user']);
const other = JSON.stringify(['test-site', 'other-user']);
const fixedNow = 1793534400000;
const id = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
async function testKey(byte = 7) {
  return crypto.subtle.importKey('raw', new Uint8Array(32).fill(byte), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function binding(database, hooks = {}) {
  const queries = [], sessions = [];
  return {
    queries, sessions,
    withSession(constraint) {
      sessions.push(constraint);
      return { prepare(sql) { return { bind(...values) { return { async first() {
        queries.push({ sql, values: structuredClone(values) });
        await hooks.before?.(sql, values);
        const row = database.prepare(sql).get(...values) ?? null;
        await hooks.after?.(sql, values, row);
        return row;
      } }; } }; } };
    },
  };
}
async function fixture(t, { path = ':memory:', migrate = true, hooks = {}, maxAttempts = 4 } = {}) {
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  if (migrate) db.exec(migration);
  const database = binding(db, hooks), encryptionKey = await testKey();
  const options = { database, encryptionKey, keyId: 'public-test-key-v1', now: () => fixedNow, maxAttempts };
  return { db, database, options, store: createD1Store(options) };
}
function sampleSubscription() {
  return { id: 'sub_' + 'a'.repeat(64), generation, url: 'https://callback.example.com/events',
    arguments: { includeSynthetic: false }, secret, expiresAt: fixedNow + 60000,
    state: 'active', previousSecret: null, previousSecretUntil: null };
}
function sampleDispatch() {
  return { id, epoch: 2, generation, phase: 'inflight', startedAt: fixedNow,
    deadlineAt: fixedNow + 5000, revocationRequested: false };
}

test('D1 configuration needs an actual nonextractable AES-GCM key and factory brand cannot be copied', async t => {
  const f = await fixture(t);
  assert.equal(isD1Store(f.store), true);
  assert.equal(isD1Store({ ...f.store }), false);
  assert.equal(isD1Store({ kind: 'durable', atomic: true, encryptedSecrets: true }), false);
  assert.equal(isD1Store(null), false);
  for (const options of [
    { ...f.options, encryptionKey: {} }, { ...f.options, database: {} },
    { ...f.options, keyId: 'key/from-client' }, { ...f.options, maxAttempts: 9 },
    { ...f.options, encryptionKey: await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', true, ['encrypt', 'decrypt']) },
    { ...f.options, encryptionKey: await crypto.subtle.importKey('raw', new Uint8Array(16).fill(7), 'AES-GCM', false, ['encrypt', 'decrypt']) },
  ]) assert.throws(() => createD1Store(options), error => error.code === 'invalid-configuration');
});

test('full owner state persists encrypted across adapter instances without plaintext identities or secrets in SQL', async t => {
  const f = await fixture(t);
  const written = await f.store.transaction(owner, state => {
    state.epoch = 2; state.subscription = sampleSubscription(); state.dispatch = sampleDispatch();
    state.ids[id] = { fingerprint: 'b'.repeat(64), expires: fixedNow + 300001, outcome: 'pending', status: 409, reason: null };
    state.minuteStart = fixedNow; state.minuteCount = 1; state.lastMotionAt = fixedNow;
    return state;
  });
  const second = createD1Store({ ...f.options, database: binding(f.db) });
  const loaded = await second.transaction(owner, state => state);
  assert.deepEqual(loaded, written);
  const row = f.db.prepare('SELECT * FROM sonic_bridge_state').get();
  assert.equal(row.revision, 1);
  assert.match(row.owner_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(row).includes(secret));
  assert.ok(!JSON.stringify(row).includes('test-user'));
  assert.ok(!JSON.stringify(row).includes('callback.example.com'));
  assert.ok(!JSON.stringify(f.database.queries).includes(secret));
  assert.ok(!JSON.stringify(f.database.queries).includes(owner));
  assert.ok(f.database.queries.every(query => !/CREATE|ALTER|DROP/i.test(query.sql)));
  assert.ok(f.database.sessions.every(value => value === 'first-primary'));
  loaded.epoch = 999;
  assert.equal(await second.transaction(owner, state => state.epoch), 2);
});

test('state survives closing/reopening a real SQLite file, without recreating schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sonic-d1-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const encryptionKey = await testKey();
  const first = new DatabaseSync(path); first.exec(migration);
  const store = createD1Store({ database: binding(first), encryptionKey, keyId: 'public-test-key-v1' });
  await store.transaction(owner, state => { state.epoch = 7; state.subscription = sampleSubscription(); state.dispatch = { ...sampleDispatch(), phase: 'uncertain', revocationRequested: true }; });
  first.close();
  const reopened = new DatabaseSync(path); t.after(() => reopened.close());
  const restarted = createD1Store({ database: binding(reopened), encryptionKey, keyId: 'public-test-key-v1' });
  const state = await restarted.transaction(owner, state => state);
  assert.equal(state.epoch, 7); assert.equal(state.subscription.secret, secret);
  assert.equal(state.dispatch.phase, 'uncertain'); assert.equal(state.dispatch.revocationRequested, true);
});

test('unchanged mutators use fresh primary reads without creating or rewriting owner rows', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.transaction(owner, state => state.epoch), 0);
  assert.equal(f.db.prepare('SELECT count(*) count FROM sonic_bridge_state').get().count, 0);
  await f.store.transaction(owner, state => { state.epoch = 2; });
  const before = f.db.prepare('SELECT revision,nonce,ciphertext FROM sonic_bridge_state').get();
  for (let count = 0; count < 3; count++) assert.equal(await f.store.transaction(owner, state => state.epoch), 2);
  assert.deepEqual(f.db.prepare('SELECT revision,nonce,ciphertext FROM sonic_bridge_state').get(), before);
  assert.ok(f.database.sessions.every(value => value === 'first-primary'));
  assert.equal(f.database.queries.filter(query => query.sql.startsWith('UPDATE')).length, 0);
});

test('two adapter instances resolve concurrent initial insertion and updates without lost epochs', async t => {
  const f = await fixture(t), secondBinding = binding(f.db);
  const otherWorker = createD1Store({ ...f.options, database: secondBinding });
  const results = await Promise.all([f.store.transaction(owner, state => ++state.epoch), otherWorker.transaction(owner, state => ++state.epoch)]);
  assert.deepEqual(results.sort(), [1, 2]);
  for (let round = 0; round < 4; round++) {
    await Promise.all([f.store.transaction(owner, state => ++state.epoch), otherWorker.transaction(owner, state => ++state.epoch)]);
  }
  assert.equal(await otherWorker.transaction(owner, state => state.epoch), 10);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM sonic_bridge_state').get().count, 1);
  const allQueries = [...f.database.queries, ...secondBinding.queries];
  assert.ok(allQueries.some(query => /UPDATE[\s\S]*WHERE owner_hash = \?1 AND revision = \?7[\s\S]*RETURNING revision/.test(query.sql)));
  assert.ok(f.database.sessions.length + secondBinding.sessions.length > 11, 'CAS conflicts use fresh primary-started sessions');
});

test('bounded CAS retries never overwrite a concurrently changing owner', async t => {
  const f = await fixture(t);
  await f.store.transaction(owner, state => { state.minuteStart = fixedNow; });
  let interference = 0;
  const hostileTiming = binding(f.db, { before: async sql => {
    if (sql.startsWith('UPDATE')) { interference++; await f.store.transaction(owner, state => ++state.epoch); }
  } });
  const contender = createD1Store({ ...f.options, database: hostileTiming, maxAttempts: 3 });
  await assert.rejects(contender.transaction(owner, state => { state.epoch += 100; }), error => error.code === 'revision-contention');
  assert.equal(interference, 3);
  assert.equal(await f.store.transaction(owner, state => state.epoch), 3);
});

test('an uncertain committed write is not resent and can be read back by another adapter', async t => {
  const f = await fixture(t);
  const uncertainBinding = binding(f.db, { after: async sql => {
    if (sql.startsWith('INSERT')) throw new Error('transport lost response including ' + secret);
  } });
  const uncertain = createD1Store({ ...f.options, database: uncertainBinding });
  await assert.rejects(uncertain.transaction(owner, state => ++state.epoch), error => {
    assert.equal(error.code, 'write-outcome-unknown');
    assert.ok(!JSON.stringify(error).includes(secret)); assert.ok(!error.message.includes(secret)); return true;
  });
  assert.equal(uncertainBinding.queries.filter(query => query.sql.startsWith('INSERT')).length, 1);
  assert.equal(await f.store.transaction(owner, state => state.epoch), 1);
});

test('wrong key, altered ciphertext/nonce/revision, and owner-row substitution fail closed', async t => {
  for (const mutation of ['key', 'ciphertext', 'nonce', 'revision', 'owner']) {
    const f = await fixture(t);
    await f.store.transaction(owner, state => { state.subscription = sampleSubscription(); });
    await f.store.transaction(other, state => { state.minuteStart = fixedNow; });
    const rows = f.db.prepare('SELECT * FROM sonic_bridge_state ORDER BY rowid').all();
    const row = rows[0];
    if (mutation === 'ciphertext') {
      const changed = (row.ciphertext[0] === 'A' ? 'B' : 'A') + row.ciphertext.slice(1);
      f.db.prepare('UPDATE sonic_bridge_state SET ciphertext=? WHERE owner_hash=?').run(changed, row.owner_hash);
    } else if (mutation === 'nonce') {
      f.db.prepare('UPDATE sonic_bridge_state SET nonce=? WHERE owner_hash=?').run(Buffer.alloc(12, 4).toString('base64'), row.owner_hash);
    } else if (mutation === 'revision') {
      f.db.prepare('UPDATE sonic_bridge_state SET revision=revision+1 WHERE owner_hash=?').run(row.owner_hash);
    } else if (mutation === 'owner') {
      f.db.prepare('UPDATE sonic_bridge_state SET ciphertext=?,nonce=?,revision=? WHERE owner_hash=?').run(row.ciphertext, row.nonce, row.revision, rows[1].owner_hash);
    }
    const reader = createD1Store({ ...f.options, encryptionKey: mutation === 'key' ? await testKey(9) : f.options.encryptionKey });
    await assert.rejects(reader.transaction(mutation === 'owner' ? other : owner, () => {}), error => error.code === 'state-authentication-failed');
  }
});

test('schema absence, bad marker, or wrong configured key label cannot reset persisted state', async t => {
  const absent = await fixture(t, { migrate: false });
  await assert.rejects(absent.store.transaction(owner, () => {}), error => error.code === 'read-failed');
  assert.equal(absent.db.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table'").get().count, 0);
  const f = await fixture(t); await f.store.transaction(owner, state => ++state.epoch);
  const mismatchedKey = createD1Store({ ...f.options, keyId: 'different-public-label' });
  await assert.rejects(mismatchedKey.transaction(owner, () => {}), error => error.code === 'invalid-record');
  f.db.exec("DROP VIEW sonic_bridge_schema; CREATE VIEW sonic_bridge_schema AS SELECT 1 AS singleton, 2 AS version, 'sonic-bridge-owner-state-v1' AS schema_id;");
  await assert.rejects(f.store.transaction(owner, () => {}), error => error.code === 'schema-mismatch');
  assert.equal(f.db.prepare('SELECT revision FROM sonic_bridge_state').get().revision, 1);
  f.db.exec('DROP VIEW sonic_bridge_schema;');
  await assert.rejects(f.store.transaction(owner, () => {}), error => error.code === 'read-failed');
  assert.equal(f.db.prepare('SELECT revision FROM sonic_bridge_state').get().revision, 1);
});

test('SQL constraints reject invalid row versions, identities, revisions, and timestamps', async t => {
  const f = await fixture(t); await f.store.transaction(owner, state => { state.minuteStart = fixedNow; });
  for (const sql of [
    'UPDATE sonic_bridge_state SET format_version=2', 'UPDATE sonic_bridge_state SET revision=0',
    "UPDATE sonic_bridge_state SET owner_hash='not-a-hash'", "UPDATE sonic_bridge_state SET key_id='bad/label'",
    "UPDATE sonic_bridge_state SET nonce='too-short'", "UPDATE sonic_bridge_state SET ciphertext='invalid*'",
    'UPDATE sonic_bridge_state SET updated_at=-1',
  ]) assert.throws(() => f.db.exec(sql), /constraint failed/i);
  assert.throws(() => f.db.exec('UPDATE sonic_bridge_schema SET version=2'), /cannot modify.*view/i);
});

test('migration is schema-only and persisted callback/rate/dedup boundaries remain strict', async t => {
  const statements = migration.replace(/--[^\n]*/g, '').split(';').map(value => value.trim()).filter(Boolean);
  assert.ok(statements.every(statement => /^CREATE (?:TABLE|VIEW) /i.test(statement)));
  const f = await fixture(t);
  for (const url of ['http://callback.example.com/', 'https://callback.example.com:8443/', 'https://localhost/',
    'https://127.0.0.1/', 'https://name:secret@callback.example.com/', 'https://callback.example.com/#fragment']) {
    await assert.rejects(f.store.transaction(owner, state => { state.subscription = { ...sampleSubscription(), url }; }), error => error.code === 'invalid-state');
  }
  await assert.rejects(f.store.transaction(owner, state => { state.minuteCount = 61; }), error => error.code === 'invalid-state');
  await assert.rejects(f.store.transaction(owner, state => {
    for (let index = 0; index < 513; index++) state.ids[`00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`] = {
      fingerprint: 'b'.repeat(64), expires: fixedNow + 300001, outcome: 'pending', status: 409, reason: null,
    };
  }), error => error.code === 'invalid-state');
  assert.equal(f.db.prepare('SELECT count(*) count FROM sonic_bridge_state').get().count, 0);
});

test('unknown or malformed state and async mutators do not commit', async t => {
  const f = await fixture(t);
  for (const mutate of [
    state => { state.audio = [1]; }, state => { state.epoch = -1; }, state => { state.epoch = Number.MAX_SAFE_INTEGER + 1; },
    state => { state.subscription = { ...sampleSubscription(), transcript: 'private text' }; },
    state => { state.dispatch = { ...sampleDispatch(), phase: 'automatically-expired' }; },
    state => { state.dispatch = { ...sampleDispatch(), deadlineAt: -1 }; },
    state => { state.ids['not-a-uuid'] = {}; }, state => { state.lastMotionAt = Infinity; },
  ]) await assert.rejects(f.store.transaction(owner, mutate), error => error.code === 'invalid-state');
  await assert.rejects(f.store.transaction(owner, async state => { state.epoch = 8; }), error => error.code === 'async-mutator');
  await assert.rejects(f.store.transaction(owner, () => () => {}), error => error.code === 'invalid-result');
  assert.equal(f.db.prepare('SELECT count(*) count FROM sonic_bridge_state').get().count, 0);
});

test('durable revocation and an uncertain dispatch survive time advancement and adapter restart', async t => {
  const f = await fixture(t);
  await f.store.transaction(owner, state => { state.epoch = 2; state.subscription = sampleSubscription(); state.dispatch = sampleDispatch(); });
  const workerTwo = createD1Store({ ...f.options, database: binding(f.db) });
  await workerTwo.transaction(owner, state => {
    state.epoch++; state.subscription = null; state.dispatch.revocationRequested = true; state.dispatch.phase = 'uncertain';
  });
  const restarted = createD1Store({ ...f.options, database: binding(f.db), now: () => fixedNow + 86400000 });
  const result = await restarted.transaction(owner, state => state);
  assert.equal(result.epoch, 3); assert.equal(result.subscription, null);
  assert.equal(result.dispatch.id, id); assert.equal(result.dispatch.revocationRequested, true);
  assert.equal(result.dispatch.phase, 'uncertain');
  assert.ok(result.dispatch.deadlineAt < fixedNow + 86400000, 'expired dispatch is retained, never silently reclaimed');
});

test('owner text is always a bound hashed value, and no owner can mutate another owner row', async t => {
  const f = await fixture(t);
  const injection = "'); DROP TABLE sonic_bridge_state; --";
  await f.store.transaction(owner, state => { state.epoch = 4; });
  await f.store.transaction(injection, state => { state.epoch = 8; });
  assert.equal(await f.store.transaction(owner, state => state.epoch), 4);
  assert.equal(await f.store.transaction(injection, state => state.epoch), 8);
  assert.equal(f.db.prepare('SELECT count(*) count FROM sonic_bridge_state').get().count, 2);
  assert.ok(f.database.queries.every(query => !query.sql.includes(injection) && !query.values.includes(injection)));
});

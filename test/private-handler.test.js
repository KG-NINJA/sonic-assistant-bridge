import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateBridgeHandler, createSitesBridgeHandler } from '../bridge/private-handler.js';

const siteOrigin = 'https://sonic.example';
const principal = { siteId: 'test-site', userId: 'synthetic-owner' };
function fixture(authenticate = async () => principal) {
  const calls = [];
  const service = {
    status: async user => { calls.push(['status', user]); return { authenticated: true, subscriptionActive: false, deliveryReady: false }; },
    ingest: async (user, body) => { calls.push(['ingest', user, body]); return { status: 202, body: { accepted: true } }; },
    disable: async user => { calls.push(['disable', user]); return { status: 200, body: { unsubscribed: true } }; },
    rpc: async (user, body) => { calls.push(['rpc', user, body]); return { jsonrpc: '2.0', id: body.id, result: {} }; },
  };
  return { service, calls, handle: createPrivateBridgeHandler({ siteOrigin, service, authenticate }) };
}
function post(path, body = '{}', headers = {}) {
  return new Request(siteOrigin + path, { method: 'POST', headers: { Origin: siteOrigin, 'Content-Type': 'application/json', ...headers }, body });
}

test('synthetic HTTP boundary denies missing identity even with forged identity headers', async () => {
  const f = fixture();
  const handler = createPrivateBridgeHandler({ siteOrigin, service: f.service });
  for (const path of ['/mcp', '/api/bridge/events', '/api/bridge/unsubscribe']) {
    const response = await handler(post(path, '{}', { 'oai-authenticated-user-id': 'forged', Authorization: 'Bearer fake' }));
    assert.equal(response.status, 401);
  }
  assert.deepEqual(f.calls, []);
});

test('same-origin authenticated requests pass only server-derived principal', async () => {
  const f = fixture();
  const response = await f.handle(post('/api/bridge/events', '{"userId":"forged"}'));
  assert.equal(response.status, 202);
  assert.deepEqual(f.calls, [['ingest', principal, { userId: 'forged' }]]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await f.handle(post('/api/bridge/unsubscribe'))).status, 200);
  assert.equal((await f.handle(new Request(siteOrigin + '/api/bridge/status'))).status, 200);
});

test('browser CSRF, CORS preflight, wrong origin, query routing and methods fail before mutations', async () => {
  const f = fixture();
  const cases = [
    [post('/api/bridge/events', '{}', { Origin: 'https://evil.example' }), 403],
    [post('/api/bridge/events', '{}', { 'Sec-Fetch-Site': 'cross-site' }), 403],
    [new Request(siteOrigin + '/api/bridge/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), 403],
    [new Request(siteOrigin + '/api/bridge/events', { method: 'OPTIONS' }), 405],
    [post('/api/bridge/events?userId=x'), 404],
    [new Request('https://evil.example/api/bridge/status'), 404],
    [new Request(siteOrigin + '/api/bridge/events'), 405],
  ];
  for (const [request, status] of cases) assert.equal((await f.handle(request)).status, status);
  assert.deepEqual(f.calls, []);
});

test('MCP clients may omit browser Origin but still require authenticated identity', async () => {
  const f = fixture();
  const request = new Request(siteOrigin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"events/list"}' });
  assert.equal((await f.handle(request)).status, 200);
  assert.equal(f.calls[0][0], 'rpc');
  assert.deepEqual(f.calls[0][1], principal);
  assert.equal((await f.handle(post('/mcp', '{}', { Origin: 'https://evil.example' }))).status, 403);
});

test('bounded uncompressed UTF-8 JSON reads reject overflow including chunked bodies', async () => {
  const f = fixture();
  for (const request of [
    post('/api/bridge/events', 'x'.repeat(8193)),
    post('/api/bridge/events', '{}', { 'Content-Length': '8193' }),
    post('/api/bridge/events', '{}', { 'Content-Length': 'NaN' }),
  ]) assert.equal((await f.handle(request)).status, 413);
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Encoding': 'gzip' }]) {
    assert.equal((await f.handle(post('/api/bridge/events', '{}', headers))).status, 415);
  }
  assert.equal((await f.handle(post('/api/bridge/events', '{'))).status, 400);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel() { cancelled = true; } });
  const response = await f.handle(new Request(siteOrigin + '/api/bridge/events', { method: 'POST', headers: { Origin: siteOrigin, 'Content-Type': 'application/json' }, body, duplex: 'half' }));
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.deepEqual(f.calls, []);
});

test('unsubscribe rejects extra fields; thrown service failures do not expose secrets', async () => {
  const f = fixture();
  assert.equal((await f.handle(post('/api/bridge/unsubscribe', '{"secret":"do-not-echo"}'))).status, 400);
  f.service.disable = () => { throw new Error('whsec_do-not-echo'); };
  const response = await f.handle(post('/api/bridge/unsubscribe'));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('whsec'), false);
});

test('Sites adapter uses fixed deployment site ID and platform user ID, never email/body identity', async () => {
  const f = fixture();
  const handler = createSitesBridgeHandler({ siteId: 'fixed-site', siteOrigin, service: f.service });
  assert.equal((await handler(new Request(siteOrigin + '/api/bridge/status'))).status, 401);
  const request = new Request(siteOrigin + '/api/bridge/status', { headers: { 'oai-authenticated-user-id': 'site-scoped-owner', 'oai-authenticated-user-email': 'ignored@example.com' } });
  assert.equal((await handler(request)).status, 200);
  assert.deepEqual(f.calls, [['status', { siteId: 'fixed-site', userId: 'site-scoped-owner' }]]);
  assert.throws(() => createPrivateBridgeHandler({ siteOrigin: 'http://sonic.example', service: f.service }));
  assert.throws(() => createSitesBridgeHandler({ siteId: '', siteOrigin, service: f.service }));
});

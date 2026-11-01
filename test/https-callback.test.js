import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createPinnedCallbackTransport } from '../bridge/https-callback.js';

const destination = 'https://callback.example.test/mcp?opaque=value';
const signed = {
  'Content-Type': 'application/json', 'webhook-id': 'evt_123', 'webhook-timestamp': '1793534400',
  'webhook-signature': 'v1,c2lnbmF0dXJl', 'X-MCP-Subscription-Id': 'sub_123',
};
const payload = { headers: signed, body: '{"challenge":"test"}' };

// Both DNS and HTTPS are mocked in every test: no callback or socket is created.
function network(t, { addresses = [{ address: '8.8.8.8', family: 4 }], status = 200,
  headers = {}, chunks = ['{"challenge":"test"}'], complete = true, hang = false,
  dnsError = false, requestError = false } = {}) {
  const requests = [];
  const lookup = t.mock.method(dns, 'lookup', async () => {
    if (dnsError) throw new Error('private DNS details');
    return addresses;
  });
  t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    Object.assign(response, { statusCode: status, headers, complete });
    request.destroy = () => { request.destroyed = true; };
    response.destroy = () => { response.destroyed = true; };
    request.end = body => {
      request.body = body;
      queueMicrotask(() => {
        if (requestError) { request.emit('error', new Error('socket details')); return; }
        if (hang) return;
        options.lookup(url.hostname, {}, (error, address, family) => {
          assert.equal(error, null);
          request.address = address;
          request.family = family;
        });
        callback(response);
        for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
        response.emit('end');
      });
    };
    requests.push({ url, options, request, response });
    return request;
  });
  return { lookup, requests };
}

test('signed bytes use a freshly validated pinned IPv4 and original TLS hostname', async t => {
  const { lookup, requests } = network(t);
  const transport = createPinnedCallbackTransport();
  assert.equal(Object.isFrozen(transport), true);
  assert.equal(transport.kind, 'safe-https');
  assert.equal(transport.productionSafe, true);
  assert.equal(requests.length, 0);
  assert.deepEqual(await transport.post(destination, payload), { status: 200, body: '{"challenge":"test"}' });
  const { url, options, request } = requests[0];
  assert.equal(url.hostname, 'callback.example.test');
  assert.equal(url.search, '?opaque=value');
  assert.equal(options.servername, 'callback.example.test');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.autoSelectFamily, false);
  assert.equal(options.family, 4);
  assert.equal(options.method, 'POST');
  assert.equal(request.address, '8.8.8.8');
  assert.equal(request.body, payload.body);
  assert.equal(options.headers['content-length'], Buffer.byteLength(payload.body));
  assert.equal(options.headers['webhook-signature'], signed['webhook-signature']);
  assert.equal(options.headers.connection, 'close');
  assert.equal(Object.hasOwn(options.headers, 'host'), false);
  assert.deepEqual(lookup.mock.calls[0].arguments, ['callback.example.test', { all: true, verbatim: true }]);
  assert.equal(lookup.mock.callCount(), 1);
});

test('DNS rebinding cannot re-resolve between validation and connection; retries recheck', async t => {
  const { lookup, requests } = network(t);
  lookup.mock.mockImplementationOnce(async () => [{ address: '127.0.0.1', family: 4 }], 1);
  const transport = createPinnedCallbackTransport();
  await transport.post(destination, payload);
  assert.equal(requests[0].request.address, '8.8.8.8');
  assert.equal(lookup.mock.callCount(), 1);
  await assert.rejects(transport.post(destination, payload), { code: 'non_public_address' });
  assert.equal(lookup.mock.callCount(), 2);
  assert.equal(requests.length, 1);
});

test('all answers must be public IPv4: private, mixed, mapped and IPv6 fail before HTTPS', async t => {
  const { lookup, requests } = network(t);
  const denied = [
    '0.0.0.1', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.254', '192.0.0.9', '192.0.2.1', '192.31.196.1', '192.52.193.1',
    '192.88.99.1', '192.168.0.1', '192.175.48.1', '198.18.0.1', '198.19.255.254', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '239.255.255.254', '240.0.0.1', '255.255.255.255',
  ];
  for (const address of denied) {
    lookup.mock.mockImplementation(async () => [{ address: '8.8.8.8', family: 4 }, { address, family: 4 }]);
    await assert.rejects(createPinnedCallbackTransport().post(destination, payload), { code: 'non_public_address' });
  }
  for (const addresses of [[], [{ address: '::1', family: 6 }], [{ address: '::ffff:8.8.8.8', family: 6 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }],
    [{ address: 'invalid', family: 4 }], [{ address: '8.8.8.8', family: 0 }]]) {
    lookup.mock.mockImplementation(async () => addresses);
    await assert.rejects(createPinnedCallbackTransport().post(destination, payload), { code: 'non_public_address' });
  }
  assert.equal(requests.length, 0);
});

test('URL forms cannot select credentials, fragments, other protocols or ports', async t => {
  const { lookup, requests } = network(t);
  for (const url of ['http://example.test/', 'https://user:pass@example.test/', 'https://example.test:8443/',
    'https://example.test/#secret', 'https://example.test/#', 'file:///tmp/a', 'not a URL',
    ' https://example.test/', 'https://exa\nmple.test/', `https://example.test/${'a'.repeat(2048)}`]) {
    await assert.rejects(createPinnedCallbackTransport().post(url, payload), { code: 'invalid_url' });
  }
  for (const url of ['https://[::1]/', 'https://[::ffff:8.8.8.8]/', 'https://127.1/', 'https://0x7f000001/', 'https://2130706433/']) {
    await assert.rejects(createPinnedCallbackTransport().post(url, payload), { code: 'non_public_address' });
  }
  assert.equal(requests.length, 0);
  assert.equal(lookup.mock.callCount(), 0);
});

test('public IP literals are validated directly without SNI substitution or DNS', async t => {
  const { lookup, requests } = network(t);
  await createPinnedCallbackTransport().post('https://8.8.8.8:443/path', payload);
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(requests[0].options.servername, '');
  assert.equal(requests[0].url.hostname, '8.8.8.8');
  assert.equal(requests[0].options.rejectUnauthorized, true);
});

test('no redirect is followed, including redirects to internal addresses', async t => {
  const { requests } = network(t, { status: 302, headers: { location: 'https://127.0.0.1/' } });
  await assert.rejects(createPinnedCallbackTransport().post(destination, payload), { code: 'redirect_forbidden' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.destroyed, true);
  assert.equal(requests[0].response.destroyed, true);
});

test('declared and streaming response limits fail closed, including UTF-8 byte size', async t => {
  const { requests } = network(t, { chunks: ['1234', 'ééé'] });
  await assert.rejects(createPinnedCallbackTransport({ maxResponseBytes: 8 }).post(destination, payload), { code: 'response_too_large' });
  assert.equal(requests[0].response.destroyed, true);
});

test('oversized declared response and encoded responses are rejected', async t => {
  network(t, { headers: { 'content-length': '8193' }, chunks: [] });
  await assert.rejects(createPinnedCallbackTransport().post(destination, payload), { code: 'response_too_large' });
});

test('compressed responses are never expanded or accepted', async t => {
  network(t, { headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(createPinnedCallbackTransport().post(destination, payload), { code: 'response_encoding' });
});

test('incomplete responses and socket failures do not produce success', async t => {
  network(t, { complete: false });
  await assert.rejects(createPinnedCallbackTransport().post(destination, payload), { code: 'response_incomplete' });
});

test('network errors use categorized messages without destination or secret details', async t => {
  network(t, { requestError: true });
  await assert.rejects(createPinnedCallbackTransport().post(destination, payload), { code: 'request_failed', message: 'Callback transport: request_failed' });
});

test('DNS failure cannot reach HTTPS', async t => {
  const { requests } = network(t, { dnsError: true });
  await assert.rejects(createPinnedCallbackTransport().post(destination, payload), { code: 'dns_failed' });
  assert.equal(requests.length, 0);
});

test('deadline covers slow DNS without a late connection', async t => {
  const { lookup, requests } = network(t);
  let release;
  lookup.mock.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(createPinnedCallbackTransport({ timeoutMs: 5 }).post(destination, payload), { code: 'timeout' });
  release([{ address: '8.8.8.8', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 0);
});

test('deadline destroys an unresponsive request', async t => {
  const { requests } = network(t, { hang: true });
  await assert.rejects(createPinnedCallbackTransport({ timeoutMs: 5 }).post(destination, payload), { code: 'timeout' });
  assert.equal(requests[0].request.destroyed, true);
});

test('caller cancellation before lookup and during delivery sends no later work', async t => {
  const { lookup, requests } = network(t, { hang: true });
  const preaborted = AbortSignal.abort();
  await assert.rejects(createPinnedCallbackTransport().post(destination, { ...payload, signal: preaborted }), { code: 'aborted' });
  assert.equal(lookup.mock.callCount(), 0);
  const controller = new AbortController();
  const pending = createPinnedCallbackTransport().post(destination, { ...payload, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(requests[0].request.destroyed, true);
});

test('request bounds and signing-header restrictions apply before DNS', async t => {
  const { lookup, requests } = network(t);
  for (const body of ['', 'é'.repeat(4097), {}, null]) {
    await assert.rejects(createPinnedCallbackTransport().post(destination, { headers: signed, body }), { code: 'request_too_large' });
  }
  for (const headers of [null, {}, [], { ...signed, Host: '127.0.0.1' }, { ...signed, Authorization: 'secret' },
    { ...signed, 'content-type': 'application/json' }, { ...signed, 'webhook-id': 'x\r\nHost: localhost' },
    { ...signed, 'webhook-id': 'a'.repeat(1025) }, { ...signed, 'Content-Type': 'text/plain' }]) {
    await assert.rejects(createPinnedCallbackTransport().post(destination, { headers, body: payload.body }), { code: 'invalid_headers' });
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(requests.length, 0);
});

test('configuration cannot increase maximum limits', () => {
  for (const options of [{ timeoutMs: 10001 }, { timeoutMs: 0 }, { maxRequestBytes: 8193 }, { maxResponseBytes: Infinity }]) {
    assert.throws(() => createPinnedCallbackTransport(options), { code: 'invalid_limit' });
  }
});

test('non-2xx response is returned for service-level retry and revoke policy', async t => {
  network(t, { status: 410, chunks: ['gone'] });
  assert.deepEqual(await createPinnedCallbackTransport().post(destination, payload), { status: 410, body: 'gone' });
});

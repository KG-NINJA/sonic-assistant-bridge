import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { english } from './english.js';
import { validateMotionEvent } from '../src/bridge.js';

// All origins and API replies below are intercepted test fixtures. This script
// never authenticates with a real service, subscribes, emits sound, or uses a mic.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const artifacts = new URL('artifacts/', root);
await mkdir(artifacts, { recursive: true });
const html = english(await readFile(new URL('index.html', root), 'utf8'));
const checks = [], requests = [], pageErrors = [], blockedRequests = [], probes = [];
const delayed = [];
const fixture = {
  marker: false, loopbackTestMarker: false, statusDelay: false, unsubscribeDelay: false,
  eventMode: 'auto', unsubscribeAccepted: true,
  status: { authenticated: true, subscriptionActive: true, deliveryReady: true, delivery: 'mcp-webhook', testMode: false },
};
let browser, failure;
const acknowledge = (event, overrides = {}) => ({ accepted: true, eventId: event.id,
  delivery: 'mcp-webhook', outcome: 'callback-accepted', testMode: fixture.status.testMode, ...overrides });

try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addCookies([{ name: 'test_session', value: 'synthetic-only', url: 'https://bridge.invalid',
    httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['bridge.invalid', '127.0.0.1'].includes(url.hostname)) {
      blockedRequests.push(url.origin); await route.abort(); return;
    }
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/api/bridge/')) {
      const body = request.method() === 'POST' ? request.postDataJSON() : null;
      requests.push({ path: url.pathname, method: request.method(), body, headers: request.headers() });
      if (url.pathname === '/api/bridge/status') {
        if (fixture.statusDelay) { delayed.push(route); return; }
        await reply(fixture.status); return;
      }
      if (url.pathname === '/api/bridge/unsubscribe') {
        if (fixture.unsubscribeDelay) { delayed.push(route); return; }
        await reply({ unsubscribed: fixture.unsubscribeAccepted, delivery: 'mcp-webhook' }); return;
      }
      if (url.pathname === '/api/bridge/events') {
        assert.ok(validateMotionEvent(body), 'Only the strict metadata event may leave the browser');
        if (fixture.eventMode === 'delay') { delayed.push(route); return; }
        if (fixture.eventMode === 'reject') { await reply({ error: 'Test rejection' }, 403); return; }
        if (fixture.eventMode === 'wrong-id') { await reply(acknowledge(body, { eventId: 'wrong' })); return; }
        if (fixture.eventMode === 'wrong-delivery') { await reply(acknowledge(body, { delivery: 'another-target' })); return; }
        if (fixture.eventMode === 'unknown-outcome') { await reply(acknowledge(body, { outcome: 'unknown' })); return; }
        if (body.type !== 'motion.detected') {
          await reply(acknowledge(body, { accepted: false, outcome: 'filtered', reason: 'lifecycle-not-delivered' })); return;
        }
        await reply(acknowledge(body)); return;
      }
      await reply({ error: 'Unknown test route' }, 404); return;
    }
    if (url.pathname === '/') {
      const markers = `${fixture.marker ? ' data-private-bridge="true"' : ''}${fixture.loopbackTestMarker ? ' data-private-bridge-test="true"' : ''}`;
      await route.fulfill({ contentType: 'text/html', body: html.replace('<body>', `<body${markers}>`) }); return;
    }
    let file;
    let contentType;
    if (url.pathname === '/style.css') { file = 'style.css'; contentType = 'text/css'; }
    else if (/^\/src\/[a-z-]+\.js$/.test(url.pathname)) { file = url.pathname.slice(1); contentType = 'text/javascript'; }
    else if (/^\/vendor\/three\.(module|core)\.js$/.test(url.pathname)) { file = 'node_modules/three/build/' + url.pathname.split('/').at(-1); contentType = 'text/javascript'; }
    else { await route.fulfill({ status: 404, body: 'Not part of the fixture' }); return; }
    const source = await readFile(new URL(file, root), 'utf8');
    await route.fulfill({ contentType, body: file.startsWith('src/') ? english(source) : source });
  });
  await context.addInitScript(() => {
    const probe = { microphone: 0, audio: 0, aborts: 0, fetches: [] };
    Reflect.set(globalThis, '__privateBridgeProbe', probe);
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
      probe.microphone++; throw new Error('Real microphone forbidden');
    };
    Object.defineProperty(globalThis, 'AudioContext', { value: class {
      constructor() { probe.audio++; throw new Error('Real audio output forbidden'); }
    } });
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      probe.fetches.push({ path: String(input), credentials: init?.credentials, method: init?.method || 'GET' });
      init?.signal?.addEventListener('abort', () => probe.aborts++);
      return original(input, init);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
  });
  const saveProbe = async () => probes.push(await page.evaluate(() => Reflect.get(globalThis, '__privateBridgeProbe')));
  const load = async (url = 'https://bridge.invalid/') => {
    if (page.url() !== 'about:blank') await saveProbe();
    await page.goto(url);
    await settle();
  };
  const statusCheck = async () => {
    await page.click('#bridge-check');
    await page.waitForFunction(() => !/** @type {HTMLButtonElement} */ (document.getElementById('bridge-check')).disabled);
  };
  const ready = async () => {
    fixture.status = { authenticated: true, subscriptionActive: true, deliveryReady: true, delivery: 'mcp-webhook', testMode: false };
    await page.selectOption('#bridge-destination', 'private');
    await statusCheck();
    assert.equal(await page.locator('#bridge-enable').isDisabled(), false);
  };
  const waitForText = text => page.waitForFunction(expected => document.getElementById('bridge-delivery').textContent.includes(expected), text);
  const stopDemo = async () => { if (!(await page.locator('#stop').isDisabled())) await page.click('#stop'); };
  const clearDelayed = async () => { for (const route of delayed.splice(0)) await route.abort().catch(() => {}); };
  const assertOff = async () => {
    assert.equal(await page.locator('#bridge-enable').isDisabled(), true);
    assert.equal(await page.locator('#bridge-disable').isDisabled(), true);
  };

  await load();
  assert.equal(await page.locator('#bridge-local-option').isDisabled(), true);
  assert.equal(await page.locator('#bridge-private-controls').isVisible(), false);
  assert.match(await page.locator('#bridge-availability').textContent(), /public page supports preview only/);
  await page.selectOption('#demo-motion', 'APPROACH');
  await page.click('#demo');
  await page.waitForFunction(() => document.getElementById('bridge-preview').textContent.includes('motion.detected'));
  await stopDemo();
  assert.equal(requests.length, 0);
  checks.push('Public HTTPS page explains preview-only mode and performs no API requests, including during a synthetic demo');

  fixture.marker = true;
  await load('http://bridge.invalid/');
  assert.equal(await page.locator('#bridge-private-controls').isVisible(), false);
  await load('http://127.0.0.1:9876/');
  assert.equal(await page.locator('#bridge-private-controls').isVisible(), false);
  fixture.loopbackTestMarker = true;
  await load('http://127.0.0.1:9876/');
  assert.equal(await page.locator('#bridge-private-controls').isVisible(), true);
  assert.equal(requests.length, 0);
  fixture.loopbackTestMarker = false;
  checks.push('Private mode requires the server marker and HTTPS; loopback additionally requires the explicit test marker');

  await load();
  await page.selectOption('#bridge-destination', 'private');
  await assertOff();
  assert.equal(requests.length, 0);
  for (const flags of [
    { authenticated: false, subscriptionActive: false, deliveryReady: false },
    { authenticated: true, subscriptionActive: false, deliveryReady: false },
    { authenticated: true, subscriptionActive: true, deliveryReady: false },
  ]) {
    fixture.status = { ...fixture.status, ...flags };
    await statusCheck();
    assert.equal(await page.locator('#bridge-enable').isDisabled(), true);
  }
  await ready();
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(await page.locator('#bridge-disable').isDisabled(), true);
  await page.click('#bridge-enable');
  await page.selectOption('#demo-motion', 'APPROACH');
  await page.click('#demo');
  await waitForText('filtered out');
  assert.equal(await page.locator('#bridge-disable').isDisabled(), false);
  await waitForText('Callback acceptance confirmed');
  assert.match(await page.locator('#bridge-delivery').textContent(), /does not confirm dot processing or receipt/);
  assert.ok(requests.every(request => request.headers.authorization === undefined));
  assert.ok(requests.every(request => request.headers.cookie === 'test_session=synthetic-only'));
  assert.ok(requests.filter(request => request.method === 'POST').every(request => request.headers.origin === 'https://bridge.invalid'));
  checks.push('Authentication, active subscription, and delivery readiness all gate opt-in; filtered events stay local and callback acceptance never claims dot receipt');

  await page.click('#bridge-disable');
  assert.equal(await page.locator('#bridge-unsubscribe').isDisabled(), false);
  const disabledCount = requests.length;
  await stopDemo(); await page.click('#demo'); await stopDemo(); await settle();
  assert.equal(requests.length, disabledCount);
  await page.click('#bridge-unsubscribe');
  await page.waitForFunction(() => document.getElementById('bridge-private-status').textContent.includes('Unsubscription confirmed'));
  await assertOff();
  assert.equal(requests.at(-1).path, '/api/bridge/unsubscribe');
  checks.push('Disable stops browser delivery without unsubscribing; a separate explicit unsubscribe request confirms removal');

  for (const eventMode of ['wrong-id', 'wrong-delivery', 'unknown-outcome', 'reject']) {
    fixture.eventMode = eventMode;
    await ready(); await page.click('#bridge-enable'); await page.click('#demo');
    await waitForText('Delivery outcome could not be confirmed');
    await assertOff();
    const rejectedCount = requests.length;
    await stopDemo(); await settle();
    assert.equal(requests.length, rejectedCount);
  }
  checks.push('Wrong event IDs, wrong transport, unknown outcomes, and HTTP rejections disable sending without retries');

  fixture.eventMode = 'auto';
  // Reset the independent per-session detector/bridge cooldown for this case.
  await load();
  await ready();
  fixture.status.testMode = true;
  await statusCheck();
  assert.match(await page.locator('#bridge-private-status').textContent(), /not real delivery/);
  await page.click('#bridge-enable'); await page.selectOption('#demo-motion', 'APPROACH'); await page.click('#demo');
  await waitForText('Test receiver processing confirmed');
  // Delivered evidence must visibly identify this intercepted API fixture as synthetic.
  await page.screenshot({ path: new URL('private-bridge-ui.png', artifacts).pathname, fullPage: true });
  await page.click('#bridge-disable'); await stopDemo();
  checks.push('Synthetic transport acknowledgement is explicitly identified as a test rather than real delivery');

  for (const eventName of ['visibilitychange', 'pagehide']) {
    fixture.eventMode = 'delay';
    await ready(); await page.click('#bridge-enable');
    const before = await page.evaluate(() => Reflect.get(globalThis, '__privateBridgeProbe').aborts);
    const requested = page.waitForRequest(request => request.url().endsWith('/api/bridge/events'));
    await page.click('#demo'); await requested;
    await page.evaluate(name => {
      if (name === 'visibilitychange') {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event(name));
      } else window.dispatchEvent(new Event(name));
    }, eventName);
    await page.waitForFunction(count => Reflect.get(globalThis, '__privateBridgeProbe').aborts > count, before);
    await assertOff();
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'standby');
    const stoppedCount = requests.length;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    assert.equal(requests.length, stoppedCount);
    await clearDelayed();
  }
  checks.push('Hidden and pagehide abort pending requests and stop sensing; visibility never resumes delivery');

  fixture.eventMode = 'auto';
  await ready();
  fixture.unsubscribeDelay = true;
  const unsubscribeRequest = page.waitForRequest(request => request.url().endsWith('/api/bridge/unsubscribe'));
  await page.click('#bridge-unsubscribe'); await unsubscribeRequest;
  await page.click('#bridge-disable');
  assert.match(await page.locator('#bridge-private-status').textContent(), /could not be confirmed/);
  assert.equal(await page.locator('#bridge-unsubscribe').isDisabled(), true);
  await clearDelayed(); fixture.unsubscribeDelay = false;
  checks.push('Uncertain unsubscribe is not retried and requires an explicit status recheck');

  await ready(); await page.click('#bridge-enable');
  const reloadCount = requests.length;
  await load();
  assert.equal(await page.locator('#bridge-destination').inputValue(), 'preview');
  await assertOff();
  assert.equal(requests.length, reloadCount);
  await saveProbe();
  assert.ok(probes.every(probe => probe.microphone === 0 && probe.audio === 0));
  assert.ok(probes.flatMap(probe => probe.fetches).every(call => call.credentials === 'same-origin'));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, []);
  checks.push('Reload clears opt-in; no real microphone, audio, external request, bearer token, or persistent client setting was used');
} catch (error) {
  failure = error;
} finally {
  await browser?.close();
  const report = { passed: !failure, checks, syntheticApiOnly: true, realAuthentication: false,
    realSubscription: false, realCallbackDelivery: false, dotReceiptVerified: false,
    requestCount: requests.length, pageErrors, blockedRequests,
    hardwareCalls: probes.map(({ microphone, audio }) => ({ microphone, audio })), error: failure ? String(failure) : null };
  await writeFile(new URL('browser-private-bridge-smoke.json', artifacts), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;

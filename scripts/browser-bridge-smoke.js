import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../server.js';
import { buildPages } from './build-pages.js';
import { createPagesPreview } from './preview-pages.js';

// Optional browser tooling stays outside production dependencies.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifactDirectory = new URL('../artifacts/', import.meta.url);
await mkdir(artifactDirectory, { recursive: true });
const checks = [];
const server = createServer({ bridgeEnabled: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = /** @type {import('node:net').AddressInfo} */ (server.address());
const origin = `http://127.0.0.1:${address.port}`;
const allowedOrigins = new Set([origin]);
let browser;
let staticServer;
let failure;
const posts = [], pageErrors = [], blockedExternalRequests = [], audioProbes = [];
const pendingRoutes = [];

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true, args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  let receiverBehavior = 'pass';
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!allowedOrigins.has(url.origin)) {
      blockedExternalRequests.push(url.origin);
      await route.abort();
    } else if (url.pathname === '/bridge/events' && receiverBehavior === 'delay') {
      pendingRoutes.push(route);
    } else if (url.pathname === '/bridge/events' && receiverBehavior === 'reject') {
      await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Rejected for smoke test' });
    } else {
      await route.continue();
    }
  });
  await context.addInitScript(() => {
    const probe = { microphone: 0, audio: 0, aborts: 0 };
    Reflect.set(globalThis, '__bridgeProbe', probe);
    navigator.mediaDevices.getUserMedia = () => {
      probe.microphone++;
      throw new Error('Real microphone use is forbidden in this synthetic check');
    };
    Object.defineProperty(globalThis, 'AudioContext', { value: class {
      constructor() {
        probe.audio++;
        throw new Error('Real audio output is forbidden in this synthetic check');
      }
    } });
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      if (String(input) === '/bridge/events') init?.signal?.addEventListener('abort', () => probe.aborts++);
      return originalFetch(input, init);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST') posts.push(request.postDataJSON());
  });
  await page.goto(origin);

  const payload = () => page.locator('#bridge-preview').textContent().then(text => JSON.parse(text));
  const waitForEvent = type => page.waitForFunction(expected => {
    const text = document.getElementById('bridge-preview').textContent;
    return text.startsWith('{') && JSON.parse(text).type === expected;
  }, type);
  const settleFrames = () => page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
  });
  const enable = async () => {
    await page.selectOption('#bridge-destination', 'local');
    await page.click('#bridge-enable');
  };
  const assertDisabled = async () => {
    assert.equal(await page.locator('#bridge-disable').isDisabled(), true);
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'standby');
  };
  const waitForAbort = count => page.waitForFunction(expected => Reflect.get(globalThis, '__bridgeProbe').aborts > expected, count);
  const abortCount = () => page.evaluate(() => Reflect.get(globalThis, '__bridgeProbe').aborts);
  const clearDelayed = async () => {
    for (const route of pendingRoutes.splice(0)) await route.abort().catch(() => {});
  };

  assert.equal(await page.locator('#bridge-destination').inputValue(), 'preview');
  assert.equal(posts.length, 0);
  await page.selectOption('#demo-motion', 'APPROACH');
  await page.click('#demo');
  await waitForEvent('motion.detected');
  assert.equal((await payload()).mode, 'synthetic');
  assert.equal((await payload()).score.unit, 'dB');
  assert.equal(posts.length, 0);
  checks.push('Default preview generates synthetic motion with zero POST requests');

  await page.click('#stop');
  await waitForEvent('session.stopped');
  assert.equal((await payload()).state, 'STOPPED');
  const stoppedPayload = await page.locator('#bridge-preview').textContent();
  await settleFrames();
  assert.equal(await page.locator('#bridge-preview').textContent(), stoppedPayload);
  checks.push('Stop ends the session and event growth');

  await enable();
  assert.equal(posts.length, 0);
  await page.click('#demo');
  await page.waitForFunction(() => document.getElementById('bridge-delivery').textContent.includes('dot'));
  assert.equal(posts.at(-1).mode, 'synthetic');
  assert.equal(posts.at(-1).type, 'session.started');
  await page.screenshot({ path: new URL('bridge-ui.png', artifactDirectory).pathname, fullPage: true });
  checks.push('Explicit opt-in receives a local acknowledgement with dot still unconnected');

  await page.click('#bridge-disable');
  const beforeDisabledEvents = posts.length;
  await page.click('#stop');
  await page.click('#demo');
  await waitForEvent('session.started');
  await settleFrames();
  assert.equal(posts.length, beforeDisabledEvents);
  checks.push('Disabling delivery prevents later session events from being sent');

  receiverBehavior = 'delay';
  await enable();
  let priorAborts = await abortCount();
  const pendingStop = page.waitForRequest(request => request.method() === 'POST');
  await page.click('#stop');
  await pendingStop;
  await page.click('#bridge-disable');
  await waitForAbort(priorAborts);
  await clearDelayed();
  checks.push('Disabling delivery aborts an in-flight request');

  await enable();
  priorAborts = await abortCount();
  const pendingHidden = page.waitForRequest(request => request.method() === 'POST');
  await page.click('#demo');
  await pendingHidden;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitForAbort(priorAborts);
  await assertDisabled();
  assert.equal((await payload()).reason, 'page_hidden');
  const hiddenPostCount = posts.length;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settleFrames();
  await assertDisabled();
  assert.equal(posts.length, hiddenPostCount);
  await clearDelayed();
  checks.push('Hidden page aborts sending and stops sensing; visibility does not resume either');

  await enable();
  priorAborts = await abortCount();
  const pendingPagehide = page.waitForRequest(request => request.method() === 'POST');
  await page.click('#demo');
  await pendingPagehide;
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await waitForAbort(priorAborts);
  await assertDisabled();
  assert.equal((await payload()).reason, 'pagehide');
  await clearDelayed();
  checks.push('Pagehide aborts sending and stops the session');

  receiverBehavior = 'reject';
  await enable();
  await page.click('#demo');
  await page.waitForFunction(() => /** @type {HTMLButtonElement} */ (document.getElementById('bridge-disable')).disabled);
  await page.click('#stop');
  const rejectedPostCount = posts.length;
  await settleFrames();
  assert.equal(posts.length, rejectedPostCount);
  checks.push('Rejected delivery disables sending without retry');

  receiverBehavior = 'pass';
  await enable();
  audioProbes.push(await page.evaluate(() => Reflect.get(globalThis, '__bridgeProbe')));
  await page.reload();
  assert.equal(await page.locator('#bridge-destination').inputValue(), 'preview');
  assert.equal(await page.locator('#bridge-disable').isDisabled(), true);
  assert.equal(posts.length, rejectedPostCount);
  checks.push('Reload clears the delivery opt-in');

  for (const failingStage of ['begin', 'end', 'observer']) {
    await page.reload();
    await enable();
    if (failingStage === 'end') {
      await page.click('#demo');
      await page.waitForFunction(() => document.getElementById('bridge-delivery').textContent.includes('dot'));
    }
    await page.evaluate(stage => {
      if (stage === 'observer') {
        document.getElementById('bridge-history').prepend = () => { throw new Error('Injected observer failure'); };
      } else {
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => { throw new Error('Injected ID failure'); } });
      }
    }, failingStage);
    if (failingStage !== 'end') await page.click('#demo');
    await page.click('#stop');
    await assertDisabled();
    assert.equal(await page.locator('#bridge-enable').isDisabled(), true);
    const afterFailureCount = posts.length;
    await page.click('#demo');
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'demo');
    await page.click('#stop');
    await settleFrames();
    assert.equal(posts.length, afterFailureCount);
    audioProbes.push(await page.evaluate(() => Reflect.get(globalThis, '__bridgeProbe')));
  }
  checks.push('Injected begin, end, and observer failures disable the bridge without breaking demo or Stop');

  await buildPages();
  staticServer = createPagesPreview();
  await new Promise(resolve => staticServer.listen(0, '127.0.0.1', () => resolve(undefined)));
  const staticOrigin = `http://127.0.0.1:${staticServer.address().port}`;
  allowedOrigins.add(staticOrigin);
  const beforeStatic = posts.length;
  await page.goto(staticOrigin + '/sonic-assistant-bridge/');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.match(await page.locator('#bridge-heading').textContent(), /ASSISTANT EVENTS/);
  await page.selectOption('#demo-motion', 'APPROACH');
  await page.click('#demo');
  await waitForEvent('motion.detected');
  assert.equal((await payload()).mode, 'synthetic');
  await page.click('#stop');
  await waitForEvent('session.stopped');
  assert.equal(posts.length, beforeStatic);
  checks.push('English static project-prefix build generates and stops synthetic preview events without a backend');
  audioProbes.push(await page.evaluate(() => Reflect.get(globalThis, '__bridgeProbe')));
  assert.ok(audioProbes.every(probe => probe.microphone === 0 && probe.audio === 0));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedExternalRequests, []);
  checks.push('All browser checks used zero microphone or audio contexts and no external requests');
} catch (error) {
  failure = error;
} finally {
  await browser?.close();
  if (staticServer) await new Promise(resolve => { staticServer.close(() => resolve(undefined)); staticServer.closeAllConnections(); });
  await new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections(); });
  const report = {
    passed: !failure, checks, syntheticOnly: true, realHardwareVerified: false, dotConnected: false,
    postCount: posts.length, pageErrors, blockedExternalRequests, audioProbes,
    error: failure ? String(failure) : null,
  };
  await writeFile(new URL('browser-bridge-smoke.json', artifactDirectory), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;

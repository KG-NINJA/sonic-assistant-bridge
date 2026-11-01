import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { buildPages } from './build-pages.js';
import { createPagesPreview } from './preview-pages.js';

// These are real browser audio APIs fed exclusively by Chromium's fake device.
// Fault cases below inject errors/events; no physical microphone or sound is used.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = new URL('../artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'sonic-fake-microphone-'));
const wavPath = join(temporary, 'synthetic-pilot.wav');
const sampleRate = 48000, seconds = 40, count = sampleRate * seconds;
const wav = Buffer.alloc(44 + count * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(count * 2, 40);
for (let i = 0; i < count; i++) {
  const t = i / sampleRate;
  const pilot = t < 1.9 ? 0 : 0.06 * Math.sin(2 * Math.PI * 20000 * t);
  const motion = t >= 10 && t < 14 ? 0.004 * Math.sin(2 * Math.PI * 20140 * t) : 0;
  wav.writeInt16LE(Math.round((pilot + motion) * 32767), 44 + i * 2);
}
await writeFile(wavPath, wav);
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = /** @type {import('node:net').AddressInfo} */ (server.address());
const origin = `http://127.0.0.1:${address.port}`;
const allowedOrigins = new Set([origin]);
const checks = [], snapshots = [], errors = [], externalRequests = [], posts = [];
const staticLocales = [];
let browser, staticServer, failure, diagnostic;

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true,
    args: ['--no-sandbox', '--mute-audio', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`],
  });
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => {
    if (!allowedOrigins.has(new URL(route.request().url()).origin)) {
      externalRequests.push(route.request().url()); return route.abort();
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    const NativeContext = globalThis.AudioContext;
    const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    /** @type {AudioContext[]} */ const contexts = [];
    /** @type {MediaStreamTrack[]} */ const tracks = [];
    /** @type {GainNode[]} */ const gains = [];
    const probe = {
      behavior: 'normal', calls: 0, nativeCalls: 0, oscillatorStarts: 0, oscillatorStops: 0,
      /** @type {null | (() => void)} */ releasePermission: null,
      snapshot: () => ({ calls: probe.calls, nativeCalls: probe.nativeCalls,
        contextStates: contexts.map(value => value.state), trackStates: tracks.map(value => value.readyState),
        oscillatorStarts: probe.oscillatorStarts, oscillatorStops: probe.oscillatorStops,
        gainValues: gains.map(value => value.gain.value), deviceLabels: tracks.map(value => value.label) }),
      mute: () => tracks.at(-1)?.dispatchEvent(new Event('mute')),
      endTrack: () => tracks.at(-1)?.dispatchEvent(new Event('ended')),
      suspend: () => contexts.at(-1)?.suspend(),
    };
    Reflect.set(globalThis, '__microphoneProbe', probe);
    globalThis.AudioContext = class extends NativeContext {
      constructor(options) { super(options); contexts.push(this); }
      createGain() { const node = super.createGain(); gains.push(node); return node; }
      createOscillator() {
        const node = super.createOscillator();
        const start = node.start.bind(node), stop = node.stop.bind(node);
        node.start = (...args) => { probe.oscillatorStarts++; return start(...args); };
        node.stop = (...args) => { probe.oscillatorStops++; return stop(...args); };
        return node;
      }
    };
    navigator.mediaDevices.getUserMedia = async constraints => {
      probe.calls++;
      if (probe.behavior === 'denied') throw new DOMException('Injected permission denial', 'NotAllowedError');
      if (probe.behavior === 'missing') throw new DOMException('Injected missing input', 'NotFoundError');
      if (probe.behavior === 'unreadable') throw new DOMException('Injected busy input', 'NotReadableError');
      if (probe.behavior === 'pending') await new Promise(resolve => { probe.releasePermission = () => resolve(undefined); });
      probe.nativeCalls++;
      const stream = await nativeGetUserMedia(constraints);
      tracks.push(...stream.getTracks());
      if (probe.behavior === 'processed') {
        const track = stream.getAudioTracks()[0], settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), echoCancellation: true });
      }
      return stream;
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto(origin);

  const snapshot = () => page.evaluate(() => Reflect.get(globalThis, '__microphoneProbe').snapshot());
  const behavior = value => page.evaluate(mode => { Reflect.get(globalThis, '__microphoneProbe').behavior = mode; }, value);
  const assertReleased = async () => {
    await page.waitForFunction(() => {
      const value = Reflect.get(globalThis, '__microphoneProbe').snapshot();
      return value.contextStates.every(state => state === 'closed') && value.trackStates.every(state => state === 'ended') &&
        value.oscillatorStarts === value.oscillatorStops && value.gainValues.every(gain => gain === 0);
    });
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'standby');
    const language = await page.locator('html').getAttribute('lang');
    assert.match(await page.locator('#capture-state').textContent(), language === 'en' ? /Microphone: off.*Tone: off/i : /停止/);
    const value = await snapshot();
    snapshots.push({ calls: value.calls, nativeCalls: value.nativeCalls,
      closedContexts: value.contextStates.length, endedTracks: value.trackStates.length,
      oscillatorStarts: value.oscillatorStarts, oscillatorStops: value.oscillatorStops,
      allGainsZero: value.gainValues.every(gain => gain === 0) });
    return value;
  };
  const start = async () => {
    await page.click('#start');
    await page.waitForFunction(() => document.body.dataset.mode === 'live');
  };
  const started = () => page.waitForFunction(() => {
    const value = Reflect.get(globalThis, '__microphoneProbe').snapshot();
    return value.oscillatorStarts > value.oscillatorStops;
  });
  const assertError = async () => {
    await page.waitForFunction(() => document.body.dataset.state === 'ERROR');
    await assertReleased();
    const message = await page.locator('#message').textContent();
    assert.ok(message.length > 10); assert.doesNotMatch(message, /Injected/);
  };

  const initial = await snapshot();
  assert.equal(initial.calls, 0); assert.equal(initial.oscillatorStarts, 0); assert.deepEqual(initial.contextStates, []);
  assert.notEqual(await page.locator('body').getAttribute('data-mode'), 'live');
  assert.match(await page.locator('#capture-state').textContent(), /停止/);
  checks.push('Before explicit Start: no getUserMedia, AudioContext, or oscillator');

  await start(); await started();
  assert.equal(await page.locator('body').getAttribute('data-mode'), 'live');
  assert.match(await page.locator('#capture-state').textContent(), /マイク使用中/);
  await page.waitForFunction(() => ['CALM', 'APPROACH'].includes(document.body.dataset.state), null, { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('bridge-preview').textContent.includes('motion.detected'), null, { timeout: 15000 });
  const live = JSON.parse(await page.locator('#bridge-preview').textContent());
  assert.equal(live.mode, 'live'); assert.equal(live.type, 'motion.detected'); assert.equal(live.score.unit, 'dB');
  assert.match(await page.locator('#capture-state').textContent(), /高周波音を出力中/);
  assert.ok((await snapshot()).deviceLabels.every(label => /fake/i.test(label)));
  await page.screenshot({ path: new URL('microphone-fake-device.png', artifacts).pathname, fullPage: true });
  await page.click('#stop'); await assertReleased();
  checks.push('Chromium fake microphone WAV passes actual getUserMedia, WebAudio, FFT qualification/calibration and live motion UI; Stop releases resources');

  for (let i = 0; i < 3; i++) {
    await start(); await started(); await page.click('#stop'); await assertReleased();
  }
  checks.push('Three repeated explicit real-mode starts/stops release every track, oscillator, gain and context');

  for (const mode of ['denied', 'missing', 'unreadable', 'processed']) {
    await behavior(mode); await page.click('#start'); await assertError();
  }
  checks.push('Injected permission denial, missing/busy input and unsupported audio processing show clear errors and clean up');

  await behavior('pending'); await start();
  const pending = await snapshot();
  assert.equal(pending.oscillatorStarts, pending.oscillatorStops);
  assert.match(await page.locator('#capture-state').textContent(), /許可/);
  await page.click('#stop'); await assertReleased();
  await page.evaluate(() => Reflect.get(globalThis, '__microphoneProbe').releasePermission());
  await page.waitForFunction(count => Reflect.get(globalThis, '__microphoneProbe').snapshot().trackStates.length > count, pending.trackStates.length);
  const late = await assertReleased();
  assert.equal(late.oscillatorStarts, pending.oscillatorStarts);
  checks.push('Stopping a pending permission request closes context and discards the late fake stream without starting tone');

  await behavior('normal'); await start(); await started();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await assertReleased();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await assertReleased();
  checks.push('Injected hidden/visible transition stops the real mode and does not restart it');

  await start(); await started();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await assertReleased();
  checks.push('Injected pagehide stops actual fake-device tracks and WebAudio output');

  for (const event of ['mute', 'endTrack', 'suspend']) {
    await start(); await started();
    await page.evaluate(name => Reflect.get(globalThis, '__microphoneProbe')[name](), event);
    await assertError();
  }
  checks.push('Injected track mute/ended and actual context suspension stop and release the session');

  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
  await start(); await started();
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
  await assertReleased();
  checks.push('Device-change event stops an active real-mode session');

  const beforeDemo = await snapshot();
  await page.click('#demo');
  assert.equal(await page.locator('body').getAttribute('data-mode'), 'demo');
  assert.match(await page.locator('#capture-state').textContent(), /マイク入力・発音なし/);
  assert.equal(JSON.parse(await page.locator('#bridge-preview').textContent()).mode, 'synthetic');
  await page.click('#stop'); await assertReleased();
  assert.equal((await snapshot()).calls, beforeDemo.calls);
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); assert.deepEqual(posts, []);
  checks.push('Demo remains separate without microphone requests; no external requests, event POSTs or page errors occurred');

  const beforeUnsupported = await snapshot();
  await page.evaluate(() => Reflect.set(globalThis, 'AudioContext', undefined));
  await page.click('#start'); await assertError();
  assert.equal((await snapshot()).calls, beforeUnsupported.calls);
  checks.push('Unavailable WebAudio API fails clearly before acquiring any microphone');

  await buildPages();
  staticServer = createPagesPreview();
  await new Promise(resolve => staticServer.listen(0, '127.0.0.1', () => resolve(undefined)));
  const staticOrigin = `http://127.0.0.1:${staticServer.address().port}`;
  allowedOrigins.add(staticOrigin);
  for (const locale of ['', 'ja/']) {
    const language = locale ? 'ja' : 'en';
    const url = staticOrigin + '/sonic-assistant-bridge/' + locale;
    await page.goto(url);
    assert.equal(await page.locator('html').getAttribute('lang'), language);
    assert.equal((await snapshot()).calls, 0);
    assert.equal(await page.locator('a[href="./LICENSE"]').count(), 1);
    assert.equal(await page.locator('a[href="./vendor/LICENSE"]').count(), 1);
    for (const asset of ['LICENSE', 'vendor/LICENSE', 'style.css', 'src/audio.js', 'src/bridge.js', 'vendor/three.module.js', 'vendor/three.core.js']) {
      const response = await fetch(url + asset);
      assert.equal(response.status, 200, url + asset);
      if (asset.endsWith('LICENSE')) assert.match(await response.text(), /MIT License/);
    }
    await start(); await started();
    await page.waitForFunction(() => document.body.dataset.state === 'PROBE_OFF');
    assert.equal(JSON.parse(await page.locator('#bridge-preview').textContent()).mode, 'live');
    assert.match(await page.locator('#capture-state').textContent(), language === 'en' ? /microphone active/i : /マイク使用中/);
    await page.click('#stop'); await assertReleased();
    await behavior('denied'); await page.click('#start'); await assertError();
    assert.match(await page.locator('#message').textContent(), language === 'en' ? /microphone access was denied/i : /マイクの使用が許可されていません/);
    await behavior('normal');
    const beforeStaticDemo = await snapshot();
    await page.click('#demo');
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'demo');
    assert.equal(JSON.parse(await page.locator('#bridge-preview').textContent()).mode, 'synthetic');
    await page.click('#stop'); await assertReleased();
    assert.equal((await snapshot()).calls, beforeStaticDemo.calls);
    staticLocales.push({ language, projectPath: '/sonic-assistant-bridge/' + locale,
      assets: 7, licenseLinks: true, fakeRealStartAndStop: true, localizedPermissionDenial: true, separateDemo: true });
  }
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); assert.deepEqual(posts, []);
  checks.push('English and Japanese static project-prefix builds serve assets/licenses, start and release native fake microphones, localize denial and keep demo separate');
} catch (error) {
  failure = error;
  try {
    const pages = browser?.contexts()[0]?.pages();
    if (pages?.[0]) diagnostic = await pages[0].evaluate(() => ({ state: document.body.dataset.state,
      message: document.getElementById('message')?.textContent, probe: Reflect.get(globalThis, '__microphoneProbe')?.snapshot() }));
  } catch { /* Keep the original failure if the page has already closed. */ }
} finally {
  await browser?.close();
  if (staticServer) await new Promise(resolve => { staticServer.close(() => resolve(undefined)); staticServer.closeAllConnections(); });
  await new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections(); });
  await rm(temporary, { recursive: true, force: true });
  const report = { passed: !failure, checks, realBrowserFakeDevice: true, audioOutputMuted: true,
    physicalMicrophoneUsed: false, realAcousticsVerified: false, dotConnected: false,
    injectedCases: ['permission/device errors', 'unsupported processing/API', 'pending permission', 'visibilitychange', 'pagehide', 'track mute/ended', 'devicechange'],
    staticLocales, publicHttpsVerified: false, snapshots, pageErrors: errors, externalRequests, eventPosts: posts, diagnostic,
    error: failure ? String(failure) : null };
  await writeFile(new URL('browser-microphone-smoke.json', artifacts), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;

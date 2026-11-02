import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

test('local app serves only explicit public assets and disallows writes', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/', '/LICENSE', '/vendor/LICENSE', '/style.css', '/src/app.js', '/src/dsp.js', '/src/audio.js', '/src/scene.js', '/src/bridge.js', '/src/bridge-ui.js', '/vendor/three.module.js', '/vendor/three.core.js']) {
    const r = await fetch(origin + path);
    assert.equal(r.status, 200, path); assert.ok((await r.text()).length > 0);
    assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/);
  }
  for (const path of ['/package.json', '/server.js', '/.git/config', '/..%2fpackage.json', '/missing',
    '/bridge/d1-store.js', '/bridge/sites-receiver.js', '/migrations/0001_bridge_state.sql']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal((await fetch(origin, { method: 'POST', body: 'no' })).status, 405);
  assert.equal(await (await fetch(origin, { method: 'HEAD' })).text(), '');
});

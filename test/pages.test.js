import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { buildPages } from '../scripts/build-pages.js';
import { createPagesPreview } from '../scripts/preview-pages.js';
import { english } from '../scripts/english.js';

test('static project-prefix builds resolve all assets and language links without a backend', async t => {
  await buildPages();
  const server = createPagesPreview();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const locale of ['', 'ja/']) {
    const page = origin + '/sonic-assistant-bridge/' + locale;
    const html = await (await fetch(page)).text();
    assert.match(html, locale ? /lang="ja"/ : /lang="en"/);
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (match[1].startsWith('https:')) continue;
      assert.equal((await fetch(new URL(match[1], page))).status, 200, match[1]);
    }
    for (const name of ['app', 'audio', 'dsp', 'scene', 'bridge', 'bridge-ui']) {
      const url = page + 'src/' + name + '.js';
      const source = await (await fetch(url)).text();
      for (const match of source.matchAll(/(?:from\s*|import\()['"](\.[^'"]+)['"]/g)) {
        assert.equal((await fetch(new URL(match[1], url))).status, 200, match[1]);
      }
      execFileSync(process.execPath, ['--check', `pages/${locale}src/${name}.js`]);
    }
    assert.match(await (await fetch(page + 'vendor/three.module.js')).text(), /three.core.js/);
    assert.equal((await fetch(page + 'vendor/three.core.js')).status, 200);
    assert.match(await (await fetch(page + 'vendor/LICENSE')).text(), /MIT/);
    assert.equal(await (await fetch(page + 'vendor/LICENSE')).text(), await readFile(new URL('../node_modules/three/LICENSE', import.meta.url), 'utf8'));
    assert.equal(await (await fetch(page + 'LICENSE')).text(), await readFile(new URL('../LICENSE', import.meta.url), 'utf8'));
  }
  assert.equal((await fetch(origin + '/sonic-assistant-bridge/server.js')).status, 404);
  assert.equal((await fetch(origin + '/sonic-assistant-bridge/bridge/events')).status, 404);
  for (const file of ['bridge/service.js', 'bridge/private-handler.js', 'bridge/https-callback.js',
    'bridge/d1-store.js', 'bridge/sites-receiver.js', 'migrations/0001_bridge_state.sql', 'api/bridge/status']) {
    assert.equal((await fetch(origin + '/sonic-assistant-bridge/' + file)).status, 404);
  }
  const publicHtml = await readFile(new URL('../pages/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(publicHtml, /data-private-bridge(?:-test)?=/);
  assert.ok(!(await readdir(new URL('../pages/', import.meta.url))).includes('node_modules'));
  const source = await readFile(new URL('../src/dsp.js', import.meta.url), 'utf8');
  assert.equal(await readFile(new URL('../pages/src/dsp.js', import.meta.url), 'utf8'), english(source));
});

test('English build refuses untranslated content', () => {
  assert.throws(() => english('未翻訳の新規メッセージ'), /Untranslated/);
});

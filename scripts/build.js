import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
const files = ['index.html', 'style.css', 'server.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'src/app.js', 'src/audio.js', 'src/dsp.js', 'src/scene.js',
  'src/bridge.js', 'src/bridge-ui.js', 'bridge/receiver.js', 'bridge/mcp-events.js', 'docs/assistant-bridge.md', 'docs/private-connection.md',
  'start-sonic-forcefield.cmd'];
for (const file of files) {
  const target = new URL(file, output);
  await mkdir(dirname(fileURLToPath(target)), { recursive: true });
  await copyFile(new URL(file, root), target);
}
// Keep the portable runtime self-contained without shipping a node_modules tree.
await mkdir(new URL('vendor/', output), { recursive: true });
for (const file of ['three.module.js', 'three.core.js']) {
  await copyFile(new URL('node_modules/three/build/' + file, root), new URL('vendor/' + file, output));
}
await copyFile(new URL('node_modules/three/LICENSE', root), new URL('vendor/LICENSE', output));
const server = await readFile(new URL('server.js', root), 'utf8');
await writeFile(new URL('server.js', output), server.replaceAll('node_modules/three/build/', 'vendor/').replaceAll('node_modules/three/LICENSE', 'vendor/LICENSE'));
const launcher = await readFile(new URL('start-sonic-forcefield.cmd', root), 'utf8');
await writeFile(new URL('start-sonic-forcefield.cmd', output), launcher
  .replace('node_modules\\three\\build\\three.module.js', 'vendor\\three.module.js')
  .replace('Run npm ci in this folder once, then launch again.', 'Runtime assets are missing. Extract the complete ZIP and try again.')
  .replace('Node.js 20 or later', 'Node.js 22 or later').replace(/\r?\n/g, '\r\n'));
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
await writeFile(new URL('package.json', output), JSON.stringify({ name: pkg.name, version: pkg.version, private: true,
  type: 'module', license: pkg.license, scripts: { start: 'node server.js' }, engines: pkg.engines }, null, 2) + '\n');
await writeFile(new URL('README.txt', output), 'Sonic Assistant Bridge\nNode.js 22+ is required.\nRun start-sonic-forcefield.cmd or node server.js.\nOpen http://127.0.0.1:8765 in Chrome/Edge.\nUse Start demo for synthetic testing without microphone or speakers.\nKeep the page visible; measurement stops when hidden.\nThis detects motion, not identity, distance, or stationary presence.\nNo microphone data is stored or transmitted.\nEvent delivery is disabled by default. Read docs/assistant-bridge.md for the opt-in local mock receiver.\nNo dot connection or remote event delivery is implemented.\nOwned source is MIT licensed; see LICENSE. Three.js retains its own vendor/LICENSE notice.\nSoundWave reference: https://www.microsoft.com/en-us/research/project/soundwave-using-the-doppler-effect-to-sense-gestures/\n');
console.log('Built dist/ — includes Three.js; no package installation required at runtime.');

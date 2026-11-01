import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createMockReceiver } from './bridge/receiver.js';

const routes = new Map([
  ['/', ['index.html', 'text/html']],
  ['/LICENSE', ['LICENSE', 'text/plain']],
  ['/vendor/LICENSE', ['node_modules/three/LICENSE', 'text/plain']],
  ['/style.css', ['style.css', 'text/css']],
  ['/src/app.js', ['src/app.js', 'text/javascript']],
  ['/src/audio.js', ['src/audio.js', 'text/javascript']],
  ['/src/dsp.js', ['src/dsp.js', 'text/javascript']],
  ['/src/scene.js', ['src/scene.js', 'text/javascript']],
  ['/src/bridge.js', ['src/bridge.js', 'text/javascript']],
  ['/src/bridge-ui.js', ['src/bridge-ui.js', 'text/javascript']],
  ['/vendor/three.module.js', ['node_modules/three/build/three.module.js', 'text/javascript']],
  ['/vendor/three.core.js', ['node_modules/three/build/three.core.js', 'text/javascript']],
]);

export function createServer({ bridgeEnabled = false, receiver = createMockReceiver() } = {}) {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    if (['/bridge/events', '/bridge/status'].includes(req.url)) {
      if (!bridgeEnabled) { res.writeHead(404).end('Local receiver is disabled'); return; }
      await receiver.handle(req, res); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const route = routes.get((req.url || '/').split('?')[0]);
    if (!route) { res.writeHead(404).end('Not found'); return; }
    try {
      const data = await readFile(new URL(route[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': route[1] + '; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(500).end('Cannot read application file'); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const bridgeEnabled = process.env.BRIDGE_RECEIVER === '1';
  const server = createServer({ bridgeEnabled });
  server.on('error', error => {
    console.error(('code' in error && error.code === 'EADDRINUSE')
      ? `Port ${port} is in use. Choose another PORT; the existing process was not changed.`
      : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Sonic ForceField: http://127.0.0.1:${port}\nLocal mock receiver: ${bridgeEnabled ? 'enabled (no dot connection)' : 'disabled'}\nCtrl+C to stop.`));
}

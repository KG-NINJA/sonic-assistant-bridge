import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const files = ['LICENSE', 'index.html', 'style.css', 'src/app.js', 'src/audio.js', 'src/dsp.js', 'src/scene.js', 'src/bridge.js', 'src/bridge-ui.js', 'vendor/three.module.js', 'vendor/three.core.js', 'vendor/LICENSE'];
export function createPagesPreview() {
  const routes = new Map();
  for (const prefix of ['', 'ja/']) for (const file of files) routes.set('/sonic-assistant-bridge/' + prefix + (file === 'index.html' ? '' : file), prefix + file);
  return http.createServer(async (req, res) => {
    const file = routes.get((req.url || '').split('?')[0]);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    if (!file) { res.writeHead(404).end(); return; }
    try {
      const content = await readFile(new URL('../pages/' + file, import.meta.url));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(500).end(); }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) createPagesPreview().listen(8766, '127.0.0.1', () => console.log('Pages preview: http://127.0.0.1:8766/sonic-assistant-bridge/'));

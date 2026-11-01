import { toMcpEvent } from './mcp-events.js';
import { validateMotionEvent } from '../src/bridge.js';
import { createHash } from 'node:crypto';

const MAX_BYTES = 8192;
const RETENTION_MS = 300000;

/** A loopback-only, memory-only receiver. This never calls a remote service. */
export function createMockReceiver({ now = () => Date.now() } = {}) {
  const ids = new Map();
  let latest = null, receivedCount = 0, windowStart = now(), windowCount = 0;
  function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  async function handle(req, res) {
    // Check both authority and browser origin; loopback binding alone does not
    // prevent an unrelated website from submitting requests or DNS rebinding.
    const authority = `127.0.0.1:${req.socket.localPort}`;
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== authority ||
        (req.headers.origin && req.headers.origin !== `http://${authority}`) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      reply(res, 403, { error: 'Only the same loopback origin is accepted' }); return;
    }
    if (req.url === '/bridge/status' && req.method === 'GET') {
      reply(res, 200, { enabled: true, delivery: 'local-mock', receivedCount }); return;
    }
    if (req.url !== '/bridge/events' || req.method !== 'POST') {
      reply(res, 405, { error: 'Unsupported receiver operation' }); return;
    }
    if (req.headers.origin !== `http://${authority}`) {
      reply(res, 403, { error: 'Same-origin Origin header is required' }); return;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) {
      reply(res, 415, { error: 'Use uncompressed application/json' }); return;
    }
    if (Number(req.headers['content-length']) > MAX_BYTES) {
      reply(res, 413, { error: 'Event exceeds 8 KiB' }); req.resume(); return;
    }
    // Consume without buffering over the limit. No body is logged or persisted.
    let size = 0, chunks = [];
    try {
      await new Promise((resolve, reject) => {
        req.on('data', chunk => {
          size += chunk.length;
          if (size <= MAX_BYTES) chunks.push(chunk);
          else chunks = [];
        });
        req.on('end', resolve); req.on('error', reject);
        req.on('aborted', () => reject(new Error('Request aborted')));
      });
      if (size > MAX_BYTES) { reply(res, 413, { error: 'Event exceeds 8 KiB' }); return; }
      const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!validateMotionEvent(event)) { reply(res, 400, { error: 'Invalid motion event' }); return; }
      const time = now(), occurred = Date.parse(event.occurredAt);
      if (occurred < time - RETENTION_MS || occurred > time + 30000) {
        reply(res, 400, { error: 'Event timestamp is stale or in the future' }); return;
      }
      for (const [id, entry] of ids) if (entry.expires <= time) ids.delete(id);
      // Normalise key order before comparing repeated IDs.
      const fingerprint = createHash('sha256').update(JSON.stringify([event.schemaVersion, event.id, event.sessionId, event.sequence,
        event.occurredAt, event.source, event.mode, event.type, event.state, event.reason,
        event.score && [event.score.value, event.score.unit, event.score.basis]])).digest('hex');
      const previous = ids.get(event.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) { reply(res, 409, { error: 'Event ID already has a different payload' }); return; }
        reply(res, 200, { accepted: true, duplicate: true, eventId: event.id, delivery: 'local-mock' }); return;
      }
      if (time - windowStart >= 60000) { windowStart = time; windowCount = 0; }
      if (ids.size >= 512 || windowCount >= 60) {
        reply(res, 429, { error: 'Local receiver capacity reached; events are not queued' }); return;
      }
      latest = toMcpEvent(event);
      // Keep IDs for the full timestamp acceptance window, including permitted
      // future clock skew and the inclusive freshness boundary.
      ids.set(event.id, { fingerprint, expires: Math.max(time, occurred) + RETENTION_MS + 1 });
      receivedCount++; windowCount++;
      reply(res, 202, { accepted: true, duplicate: false, eventId: event.id, delivery: 'local-mock' });
    } catch {
      if (!res.writableEnded && !res.destroyed) reply(res, 400, { error: 'Invalid JSON or interrupted request' });
    }
  }
  return { handle, snapshot: () => ({ receivedCount, latest: structuredClone(latest) }) };
}

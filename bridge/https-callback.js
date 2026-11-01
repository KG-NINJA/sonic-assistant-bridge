import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

const MAX_BYTES = 8192;
const SIGNED_HEADERS = new Set([
  'content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id',
]);

export class CallbackTransportError extends Error {
  constructor(code) {
    super(`Callback transport: ${code}`);
    this.name = 'CallbackTransportError';
    this.code = code;
  }
}

const failure = code => new CallbackTransportError(code);

function unsafeCharacters(value, includeSpace = false) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= (includeSpace ? 32 : 31) || code === 127;
  });
}

// Deliberately conservative: exclude IPv4 special-use ranges and all IPv6.
// An IPv6-only or mixed A/AAAA destination needs a separately reviewed transport.
// Includes every IANA IPv4 special-purpose prefix (reviewed 2026-11-01),
// plus multicast: https://www.iana.org/assignments/iana-ipv4-special-registry
function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 ||
      (b === 0 && (c === 0 || c === 2)) ||
      (b === 31 && c === 196) || (b === 52 && c === 193) ||
      (b === 88 && c === 99) || (b === 175 && c === 48))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function callbackURL(input) {
  if (typeof input !== 'string' || input.length > 2048 || unsafeCharacters(input, true)) {
    throw failure('invalid_url');
  }
  let url;
  try { url = new URL(input); } catch { throw failure('invalid_url'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') ||
      url.username || url.password || url.href.includes('#') || !url.hostname) {
    throw failure('invalid_url');
  }
  return url;
}

function requestHeaders(headers, bytes) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw failure('invalid_headers');
  const checked = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!SIGNED_HEADERS.has(name) || Object.hasOwn(checked, name) ||
        typeof value !== 'string' || value.length === 0 || value.length > 1024 ||
        unsafeCharacters(value)) throw failure('invalid_headers');
    checked[name] = value;
  }
  if (Object.keys(checked).length !== SIGNED_HEADERS.size || checked['content-type'] !== 'application/json') {
    throw failure('invalid_headers');
  }
  return { ...checked, 'content-length': bytes, connection: 'close', accept: 'application/json', 'accept-encoding': 'identity' };
}

function abortReason(signal) {
  return signal.reason instanceof CallbackTransportError ? signal.reason : failure('aborted');
}

async function resolveAddress(hostname, signal) {
  if (signal.aborted) throw abortReason(signal);
  // URL.hostname includes brackets for IPv6 literals. They intentionally fail closed.
  if (hostname.startsWith('[')) throw failure('non_public_address');
  if (isIP(hostname)) {
    if (!publicIPv4(hostname)) throw failure('non_public_address');
    return hostname;
  }
  const addresses = await new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    dns.lookup(hostname, { all: true, verbatim: true }).then(resolve, () => reject(failure('dns_failed')))
      .finally(() => signal.removeEventListener('abort', abort));
  });
  if (signal.aborted) throw abortReason(signal);
  if (!Array.isArray(addresses) || addresses.length === 0 ||
      addresses.some(answer => answer.family !== 4 || !publicIPv4(answer.address))) {
    throw failure('non_public_address');
  }
  return addresses[0].address;
}

function boundedInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure('invalid_limit');
  return value;
}

/**
 * Server-side Node HTTPS only. Never substitute ordinary fetch or a client flag.
 * No connection occurs until post(); every post resolves all addresses afresh.
 * DNS answers are validated then pinned into the actual TLS connection's lookup.
 * Keeping the URL hostname preserves Host, SNI and Node's certificate validation.
 * No browser/Pages bundle or Sites Worker may treat this as a usable transport.
 */
export function createPinnedCallbackTransport({ timeoutMs = 10_000, maxRequestBytes = MAX_BYTES, maxResponseBytes = MAX_BYTES } = {}) {
  boundedInteger(timeoutMs, 10_000);
  boundedInteger(maxRequestBytes, MAX_BYTES);
  boundedInteger(maxResponseBytes, MAX_BYTES);

  /**
   * @param {string} input
   * @param {{headers?: Record<string, string>, body?: string, signal?: AbortSignal}} options
   * @returns {Promise<{status: number, body: string}>}
   */
  async function post(input, { headers, body, signal: callerSignal } = {}) {
    const url = callbackURL(input);
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') < 1 ||
        Buffer.byteLength(body, 'utf8') > maxRequestBytes) throw failure('request_too_large');
    const checkedHeaders = requestHeaders(headers, Buffer.byteLength(body, 'utf8'));
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) throw failure('invalid_signal');
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(failure('timeout')), timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
    try {
      const address = await resolveAddress(url.hostname, signal);
      if (signal.aborted) throw abortReason(signal);
      return await new Promise((resolve, reject) => {
        let request;
        let response;
        let settled = false;
        const abort = () => finish(abortReason(signal));
        function finish(error, result = undefined) {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          if (error) {
            response?.destroy();
            request?.destroy();
            reject(error);
          } else resolve(result);
        }
        try {
          // https forwards net.connect options; RequestOptions omits this one.
          /** @type {import('node:https').RequestOptions & {autoSelectFamily: boolean}} */
          const options = {
            method: 'POST', headers: checkedHeaders, agent: false,
            family: 4, autoSelectFamily: false, rejectUnauthorized: true,
            servername: isIP(url.hostname) ? '' : url.hostname,
            maxHeaderSize: MAX_BYTES,
            // Never perform a second DNS lookup after validation (DNS rebinding).
            lookup(hostname, options, callback) {
              if (hostname !== url.hostname) return callback(failure('hostname_changed'), '', 4);
              if (options.all) callback(null, [{ address, family: 4 }]);
              else callback(null, address, 4);
            },
          };
          request = https.request(url, options, incoming => {
            response = incoming;
            incoming.on('error', () => finish(failure('response_failed')));
            incoming.on('aborted', () => finish(failure('response_incomplete')));
            if (settled) { incoming.destroy(); return; }
            const status = incoming.statusCode;
            if (!Number.isInteger(status) || status < 100 || status > 599) {
              finish(failure('invalid_status')); return;
            }
            if (status >= 300 && status < 400) { finish(failure('redirect_forbidden')); return; }
            if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
              finish(failure('response_encoding')); return;
            }
            const declared = incoming.headers['content-length'];
            if (declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > maxResponseBytes)) {
              finish(failure('response_too_large')); return;
            }
            const chunks = [];
            let received = 0;
            incoming.on('data', chunk => {
              if (settled) return;
              const bytes = Buffer.from(chunk);
              received += bytes.length;
              if (received > maxResponseBytes) { finish(failure('response_too_large')); return; }
              chunks.push(bytes);
            });
            incoming.on('end', () => {
              if (!incoming.complete) { finish(failure('response_incomplete')); return; }
              finish(null, { status, body: Buffer.concat(chunks).toString('utf8') });
            });
          });
          request.on('error', () => finish(failure('request_failed')));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          else request.end(body);
        } catch { finish(failure('request_failed')); }
      });
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({ kind: 'safe-https', productionSafe: true, post });
}

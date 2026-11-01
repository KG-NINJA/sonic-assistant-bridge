// Server-only HTTP boundary. No public Pages bundle imports this module.
const MAX_BYTES = 8192;
const paths = new Set(['/mcp', '/api/bridge/status', '/api/bridge/events', '/api/bridge/unsubscribe']);

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Authorization',
  } });
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '') ||
      request.headers.has('content-encoding')) throw { status: 415 };
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw { status: 413 };
  if (!request.body) throw { status: 400 };
  const reader = request.body.getReader();
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw { status: 413 }; }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/**
 * Framework-independent authenticated boundary. authenticate MUST verify the
 * hosting platform's identity before returning {siteId,userId}; no identity
 * supplied in JSON, query strings, or a public reverse proxy is trusted here.
 * Without an authenticator, every supported route denies access.
 * @param {{siteOrigin:string,service:any,authenticate?:(request:Request)=>Promise<{siteId:string,userId:string}|null>}} options
 */
export function createPrivateBridgeHandler({ siteOrigin, service, authenticate = async () => null }) {
  const origin = new URL(siteOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== siteOrigin || origin.username || origin.password) {
    throw new TypeError('An exact HTTPS Site origin is required');
  }
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (url.origin !== siteOrigin || !paths.has(url.pathname) || url.search) return json(404, { error: 'Not found' });
      const statusRoute = url.pathname === '/api/bridge/status';
      if (request.method !== (statusRoute ? 'GET' : 'POST')) return json(405, { error: 'Method not allowed' });
      const principal = await authenticate(request);
      if (!principal || typeof principal.siteId !== 'string' || !principal.siteId ||
          typeof principal.userId !== 'string' || !principal.userId ||
          principal.siteId.length > 200 || principal.userId.length > 200) return json(401, { error: 'Sign in on the private Site' });
      // MCP callers are authenticated server clients and need not send Origin.
      // Browser writes require Origin even when a session cookie is present.
      const requestOrigin = request.headers.get('origin');
      if ((requestOrigin !== null && requestOrigin !== siteOrigin) ||
          request.headers.get('sec-fetch-site') === 'cross-site' ||
          (!statusRoute && url.pathname !== '/mcp' && requestOrigin !== siteOrigin)) {
        return json(403, { error: 'Same-origin request required' });
      }
      if (statusRoute) return json(200, await service.status(principal));
      const body = await readJson(request);
      if (url.pathname === '/mcp') return json(200, await service.rpc(principal, body));
      if (url.pathname === '/api/bridge/unsubscribe') {
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
          return json(400, { error: 'Empty JSON object required' });
        }
        const result = await service.disable(principal);
        return json(result.status, result.body);
      }
      const result = await service.ingest(principal, body);
      return json(result.status, result.body);
    } catch (error) {
      // Never return request bodies, callback URLs, tokens, or upstream errors.
      const status = [400, 413, 415].includes(error?.status) ? error.status : error instanceof SyntaxError || error instanceof TypeError ? 400 : 503;
      return json(status, { error: status === 503 ? 'Bridge unavailable' : 'Invalid request' });
    }
  };
}

/**
 * Use ONLY behind Sites Dispatch, which verifies/overwrites these headers.
 * This is not authentication for a standalone Node server or public proxy.
 * The returned Site ID/origin must be fixed server configuration after approved
 * provisioning. No provisioned identity or live service is included here.
 */
export function createSitesBridgeHandler({ siteId, siteOrigin, service }) {
  if (typeof siteId !== 'string' || !siteId || siteId.length > 200) throw new TypeError('A configured Site ID is required');
  return createPrivateBridgeHandler({ siteOrigin, service, authenticate: async request => {
    const userId = request.headers.get('oai-authenticated-user-id');
    return userId ? { siteId, userId } : null;
  } });
}

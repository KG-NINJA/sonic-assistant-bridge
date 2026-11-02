import { createD1Store } from './d1-store.js';
import { createEventService } from './service.js';
import { createSitesBridgeHandler } from './private-handler.js';

/**
 * Server-only entry point for Sites Dispatch. Mount the returned Request handler
 * at /mcp and /api/bridge/* using the supported Sites starter and D1 migrations.
 * Pass fixed deployment identity, the platform D1 binding, and a trusted runtime
 * nonextractable encryption key. Never accept these from request fields.
 *
 * No transport is installed: subscription creation and event delivery fail closed.
 * Persistence, authenticated discovery/status and revocation remain available.
 * A compatibility flag or hostname allowlist cannot enable external delivery here.
 * No source key, Site ID, private origin, or database ID is embedded in this module.
 * @param {{siteId:string,siteOrigin:string,database:any,encryptionKey:CryptoKey,keyId:string}} options
 */
export function createSitesReceiver({ siteId, siteOrigin, database, encryptionKey, keyId }) {
  const store = createD1Store({ database, encryptionKey, keyId });
  const service = createEventService({ store });
  return createSitesBridgeHandler({ siteId, siteOrigin, service });
}

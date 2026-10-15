import * as client from 'openid-client';
import { getConfig, type OidcSettings } from './config.server';

/**
 * The discovery result for the last issuer/client pair. The promise itself is cached, so concurrent
 * sign-ins share one discovery request.
 */
let cached: { key: string; config: Promise<client.Configuration> } | undefined;

/**
 * Discovers the provider configuration and caches it per issuer and client id.
 *
 * A failed discovery is evicted from the cache, so the next sign-in retries instead of failing forever.
 * Without a client secret the app acts as a public client (no client authentication) and relies on PKCE; `http://`
 * issuers (e.g. Keycloak on localhost) are allowed because this is a debugger, not a production login.
 */
export function getOidcClient(settings: OidcSettings): Promise<client.Configuration> {
  const key = `${settings.issuer}|${settings.clientId}`;
  if (cached?.key !== key) {
    const config = client
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        settings.clientSecret,
        settings.clientSecret ? undefined : client.None(),
        // Local providers (e.g. Keycloak on http://localhost) are fine for a debugger.
        settings.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined
      )
      .catch((err: unknown) => {
        cached = undefined;
        throw err;
      });
    cached = { key, config };
  }
  return cached.config;
}

/**
 * The callback URL sent to the provider, built from `APP_URL` rather than the incoming request so it
 * matches the registered redirect URI even behind a proxy.
 */
export function redirectUri() {
  return `${getConfig().appUrl}/auth/callback`;
}

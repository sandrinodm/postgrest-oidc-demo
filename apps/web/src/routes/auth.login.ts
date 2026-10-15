import { createFileRoute } from '@tanstack/react-router';
import * as client from 'openid-client';
import { getConfig } from '#/lib/config.server';
import { getOidcClient, redirectUri } from '#/lib/oidc.server';
import { proxyToken, writeOidcTransaction } from '#/lib/session.server';

/**
 * Starts the OIDC authorization code flow with PKCE: stores a fresh state, nonce and code verifier in a
 * short-lived cookie, then redirects to the provider.
 *
 * Behind an authenticating reverse proxy it just goes home, since the proxy already signed the user in;
 * without OIDC settings it answers 404.
 */
export const Route = createFileRoute('/auth/login')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Behind an authenticating reverse proxy there is nothing to sign in to.
        if (proxyToken(request.headers)) {
          return new Response(null, { status: 302, headers: { Location: '/' } });
        }
        const settings = getConfig().oidc;
        if (!settings) {
          return new Response('OIDC is not configured.', { status: 404 });
        }

        const oidc = await getOidcClient(settings);
        const codeVerifier = client.randomPKCECodeVerifier();
        const state = client.randomState();
        const nonce = client.randomNonce();
        writeOidcTransaction({ state, nonce, codeVerifier });

        const url = client.buildAuthorizationUrl(oidc, {
          redirect_uri: redirectUri(),
          scope: settings.scopes,
          code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
          code_challenge_method: 'S256',
          state,
          nonce,
        });
        return new Response(null, { status: 302, headers: { Location: url.href } });
      },
    },
  },
});

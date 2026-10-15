import { createFileRoute } from '@tanstack/react-router';
import * as client from 'openid-client';
import { getConfig } from '#/lib/config.server';
import { errorMessage } from '#/lib/errors';
import { getOidcClient, redirectUri } from '#/lib/oidc.server';
import { takeOidcTransaction, writeSession } from '#/lib/session.server';

/**
 * Redirects to the debugger, passing a failure as the `error` query parameter for the page to show.
 */
function backHome(error?: string) {
  const location = error ? `/?error=${encodeURIComponent(error)}` : '/';
  return new Response(null, { status: 302, headers: { Location: location } });
}

/**
 * Finishes the OIDC flow: exchanges the code using the one-time transaction from the login route
 * (checking state, nonce and the PKCE verifier) and stores the token PostgREST should receive.
 *
 * Every failure, including an expired attempt or a provider error, redirects home with a message rather
 * than rendering an error page.
 */
export const Route = createFileRoute('/auth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const settings = getConfig().oidc;
        if (!settings) {
          return backHome('OIDC is not configured.');
        }

        const tx = takeOidcTransaction();
        if (!tx) {
          return backHome('The sign-in attempt expired. Try again.');
        }

        // Rebuild the URL from APP_URL so it matches the registered redirect
        // URI even behind a proxy.
        const currentUrl = new URL(redirectUri());
        currentUrl.search = new URL(request.url).search;

        try {
          const oidc = await getOidcClient(settings);
          const tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
            pkceCodeVerifier: tx.codeVerifier,
            expectedState: tx.state,
            expectedNonce: tx.nonce,
            idTokenExpected: true,
          });
          const token = settings.forwardToken === 'access_token' ? tokens.access_token : tokens.id_token;
          if (!token) {
            return backHome(`The provider did not return an ${settings.forwardToken}.`);
          }
          writeSession(token, 'oidc');
          return backHome();
        } catch (err) {
          return backHome(errorMessage(err));
        }
      },
    },
  },
});

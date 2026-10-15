import { deleteCookie, getCookie, getRequestHeaders, setCookie } from '@tanstack/react-start/server';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { getConfig } from './config.server';
import type { Claims, ProxyInfo, Session, TokenSource } from './types';

/**
 * Cookie holding the token PostgREST receives.
 *
 * It is httpOnly, so browser JavaScript never handles the token and an XSS bug cannot steal it; server
 * functions read it and attach it to PostgREST calls. The UI gets a copy for display only.
 */
const TOKEN_COOKIE = 'pgdbg_token';

/**
 * Cookie recording how the stored token was obtained (OIDC or pasted), so the UI can label the session.
 */
const SOURCE_COOKIE = 'pgdbg_source';

/**
 * Options shared by all session cookies: httpOnly, `SameSite=Lax` so the OIDC redirect back to the app
 * still carries them, and `Secure` whenever `APP_URL` is HTTPS (plain HTTP for local development).
 */
function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: getConfig().appUrl.startsWith('https://'),
    path: '/',
    maxAge,
  };
}

/**
 * Decodes a JWT's header and claims without verifying the signature: good enough for display, sanity
 * checks on pasted tokens and cookie lifetimes, never for authorization.
 *
 * Verification is PostgREST's job; a token that cannot be decoded yields `null` parts instead of throwing.
 */
export function decodeToken(token: string) {
  try {
    return { header: decodeProtectedHeader(token), claims: decodeJwt(token) };
  } catch {
    return { header: null, claims: null };
  }
}

/**
 * Seconds the session cookie should live: until the token's `exp`, clamped to at least a minute and at
 * most a day, or an hour when the token has no `exp`.
 *
 * The one-minute floor means an already-expired token is still stored, so PostgREST's rejection shows up
 * in the call log instead of the sign-in silently doing nothing.
 */
function cookieLifetime(token: string) {
  const exp = decodeToken(token).claims?.exp;
  const remaining = typeof exp === 'number' ? exp - Math.floor(Date.now() / 1000) : 3600;
  return Math.min(Math.max(remaining, 60), 86_400);
}

/**
 * Header in which an authenticating reverse proxy in front of the app (oauth2-proxy and compatible) passes
 * the user's id_token on every request. Its presence switches the app to the proxy's session.
 */
const PROXY_TOKEN_HEADER = 'x-auth-request-token';

/**
 * Headers in which such a proxy names the signed-in user, in order of preference; display only.
 */
const PROXY_USER_HEADERS = ['x-auth-request-user', 'x-forwarded-user', 'x-auth-request-email'];

/**
 * Trims a token and drops an optional `Bearer ` prefix, so a pasted `Authorization` header value or a proxy
 * header in either form yields the bare JWT.
 */
export function stripBearer(value: string) {
  return value.trim().replace(/^Bearer\s+/i, '');
}

/**
 * The token an authenticating reverse proxy sent with this request, or `null` when there is none.
 */
export function proxyToken(headers: Headers) {
  return stripBearer(headers.get(PROXY_TOKEN_HEADER) ?? '') || null;
}

/**
 * Wraps a raw token in the session shape the UI shows, with its decoded header, claims and expiry.
 */
function toSession(token: string, source: TokenSource, proxy: ProxyInfo | null): Session {
  const { header, claims } = decodeToken(token);
  const exp = claims?.exp;
  return {
    source,
    token,
    header: header as Claims | null,
    claims: claims as Claims | null,
    expiresAt: typeof exp === 'number' ? new Date(exp * 1000).toISOString() : null,
    proxy,
  };
}

/**
 * The token for this request. A token from the reverse proxy wins over the
 * app's own session cookie. Trusting the header is safe even when the app is
 * reachable without the proxy: PostgREST still verifies the token.
 */
export function readSession(): Session | null {
  const headers = getRequestHeaders();
  const fromProxy = proxyToken(headers);
  if (fromProxy) {
    const shown: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (name === PROXY_TOKEN_HEADER) {
        shown[name] = `${value.slice(0, 16)}…`;
      } else if (name.startsWith('x-auth-request-') || name.startsWith('x-forwarded-')) {
        shown[name] = value;
      }
    });
    const user = PROXY_USER_HEADERS.map((name) => headers.get(name)).find(Boolean) ?? null;
    return toSession(fromProxy, 'proxy', { user, headers: shown });
  }

  const token = getCookie(TOKEN_COOKIE);
  if (!token) {
    return null;
  }
  return toSession(token, (getCookie(SOURCE_COOKIE) ?? 'manual') as TokenSource, null);
}

/**
 * Stores a token (and how it was obtained) in the session cookies, expiring together with the token.
 */
export function writeSession(token: string, source: TokenSource) {
  const maxAge = cookieLifetime(token);
  setCookie(TOKEN_COOKIE, token, cookieOptions(maxAge));
  setCookie(SOURCE_COOKIE, source, cookieOptions(maxAge));
}

/**
 * Signs out of the app's own session by deleting both session cookies. A proxy-supplied token is
 * unaffected, since it arrives in a header on every request.
 */
export function clearSession() {
  deleteCookie(TOKEN_COOKIE, { path: '/' });
  deleteCookie(SOURCE_COOKIE, { path: '/' });
}

/**
 * Cookie carrying the in-flight OIDC transaction from `/auth/login` to `/auth/callback`; it lives for ten
 * minutes at most and is deleted as soon as the callback reads it.
 */
const OIDC_COOKIE = 'pgdbg_oidc';

/**
 * The per-attempt secrets of an authorization code flow, generated at login and checked at the callback.
 *
 * Kept in an httpOnly cookie rather than server memory, so sign-in works without server-side state.
 */
export interface OidcTransaction {
  /**
   * Must come back unchanged on the callback; ties the response to this browser and blocks login CSRF.
   */
  state: string;

  /**
   * Must appear in the returned id_token, which prevents replaying a token from another sign-in.
   */
  nonce: string;

  /**
   * PKCE secret whose hash was sent with the authorization request; proves the code exchange comes
   * from the client that started the flow.
   */
  codeVerifier: string;
}

/**
 * Saves the transaction for the callback, valid for ten minutes.
 */
export function writeOidcTransaction(tx: OidcTransaction) {
  setCookie(OIDC_COOKIE, JSON.stringify(tx), cookieOptions(600));
}

/**
 * Reads and deletes the pending transaction, so each `state`/`nonce`/verifier can be used only once.
 *
 * Returns `null` when it is missing, expired or malformed, which the callback reports as an expired
 * sign-in attempt.
 */
export function takeOidcTransaction(): OidcTransaction | null {
  const raw = getCookie(OIDC_COOKIE);
  deleteCookie(OIDC_COOKIE, { path: '/' });
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as OidcTransaction;
  } catch {
    return null;
  }
}

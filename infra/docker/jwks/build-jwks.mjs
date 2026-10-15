// Builds the JWKS PostgREST uses to verify tokens (PGRST_JWT_SECRET=@/jwt/jwks.json).
//
// The set can hold two kinds of keys:
//   - the signing keys of an OIDC provider, when OIDC_ISSUER is set. They are
//     discovered from <issuer>/.well-known/openid-configuration, or taken from
//     OIDC_JWKS_URI directly.
//   - optionally, a static HS256 key from JWT_SECRET, for verifying tokens you
//     sign yourself (PostgREST's classic setup, e.g. when OIDC is off).
//
// PostgREST reads the file at startup and on a config reload, which db-setup
// triggers after this runs. Re-run `pnpm infra:up` after the provider rotates
// its keys.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Where the key set is written (`JWKS_OUTPUT`); the default is the shared volume PostgREST reads via `PGRST_JWT_SECRET=@/jwt/jwks.json`.
 */
const out = process.env.JWKS_OUTPUT ?? '/jwt/jwks.json';

/**
 * OIDC provider whose signing keys are trusted (`OIDC_ISSUER`, trailing slashes dropped); empty turns OIDC off, leaving only the JWT_SECRET key.
 */
const issuer = process.env.OIDC_ISSUER?.trim().replace(/\/+$/, '');

/**
 * Explicit key set URL (`OIDC_JWKS_URI`) that skips discovery, for issuers not reachable from inside Docker such as the local test server on `localhost`.
 */
const jwksUri = process.env.OIDC_JWKS_URI?.trim();

/**
 * Shared secret for tokens you sign yourself (`JWT_SECRET`); empty leaves the static key out.
 *
 * At least 32 characters are required: HS256 keys are 256 bits, and shorter secrets are easy to brute-force.
 */
const secret = process.env.JWT_SECRET?.trim() ?? '';

/**
 * Fetches a JSON document, retrying up to 10 times with a growing delay (capped at 5 seconds) because the identity provider container may still be starting.
 */
async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt >= 10) {
        throw new Error(`GET ${url} failed: ${err.message}`);
      }
      console.warn(`GET ${url} failed (${err.message}), retrying...`);
      await new Promise((r) => setTimeout(r, Math.min(attempt, 5) * 1000));
    }
  }
}

/**
 * Keys written to the output file: the static HS256 key first, then the provider's signing keys (encryption keys are left out).
 */
const keys = [];

if (secret) {
  if (secret.length < 32) {
    console.error('JWT_SECRET must be at least 32 characters.');
    process.exit(1);
  }
  keys.push({
    kty: 'oct',
    alg: 'HS256',
    use: 'sig',
    k: Buffer.from(secret).toString('base64url'),
  });
  console.log('static secret: HS256 key from JWT_SECRET');
} else {
  console.log('static secret: none (JWT_SECRET is empty)');
}

if (issuer || jwksUri) {
  let uri = jwksUri;
  if (!uri) {
    const discovery = await getJson(`${issuer}/.well-known/openid-configuration`);
    uri = discovery.jwks_uri;
    if (!uri) {
      throw new Error(`${issuer} does not advertise a jwks_uri`);
    }
  }
  const jwks = await getJson(uri);
  const signing = (jwks.keys ?? []).filter((k) => k.use !== 'enc');
  keys.push(...signing);
  console.log(`oidc: ${signing.length} signing key(s) from ${uri}`);
  for (const k of signing) {
    console.log(`  - ${k.kid ?? '(no kid)'} ${k.kty} ${k.alg ?? ''}`);
  }
} else {
  console.log('oidc: disabled (OIDC_ISSUER is empty)');
}

if (keys.length === 0) {
  console.error('No keys: configure OIDC_ISSUER and/or JWT_SECRET.');
  process.exit(1);
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ keys }, null, 2));
console.log(`wrote ${keys.length} key(s) to ${out}`);

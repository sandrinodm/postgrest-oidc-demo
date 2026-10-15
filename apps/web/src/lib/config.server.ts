import type { AdminCriteria, PublicConfig } from './types';

/**
 * Settings for the app's own "Sign in with OIDC" flow, read from the `OIDC_*` environment variables.
 *
 * Only present when both `OIDC_ISSUER` and `OIDC_CLIENT_ID` are set. Behind an authenticating reverse
 * proxy they can stay empty, because the proxy does the login.
 */
export interface OidcSettings {
  /**
   * Issuer URL used for discovery (`OIDC_ISSUER`); PostgREST must trust the same issuer's keys.
   */
  issuer: string;

  /**
   * Client id registered at the provider (`OIDC_CLIENT_ID`).
   */
  clientId: string;

  /**
   * Client secret (`OIDC_CLIENT_SECRET`); without one the app acts as a public client and relies on PKCE.
   */
  clientSecret: string | undefined;

  /**
   * Space-separated scopes to request (`OIDC_SCOPES`), `openid profile email` by default.
   */
  scopes: string;

  /**
   * Which token from the code exchange is forwarded to PostgREST (`OIDC_FORWARD_TOKEN`).
   *
   * Defaults to the id_token; use `access_token` only when the provider issues JWT access tokens that
   * carry the claims the admin rules need.
   */
  forwardToken: 'id_token' | 'access_token';

  /**
   * The issuer is the local test server from the `oidc-mock` compose profile, so the UI can suggest
   * subjects and claims that match the seed data.
   */
  isTestServer: boolean;
}

/**
 * Server-only settings derived from environment variables. They may hold secrets, so the UI only ever
 * receives the subset produced by `toPublicConfig`.
 */
export interface ServerConfig {
  /**
   * Base URI of the PostgREST API without a trailing slash (`POSTGREST_BASE_URI`), falling back to
   * `http://localhost:<POSTGREST_PORT>` for the local Docker stack.
   */
  postgrestUrl: string;

  /**
   * Public URL of this app without a trailing slash (`APP_URL`). It builds the OIDC redirect URI and
   * decides whether cookies are marked `Secure`.
   */
  appUrl: string;

  /**
   * OIDC sign-in settings, or `null` when the app's own OIDC login is disabled.
   */
  oidc: OidcSettings | null;

  /**
   * Admin rules from the `ADMIN_*` variables, for display only; the database enforces its own copy.
   */
  adminCriteria: AdminCriteria;
}

/**
 * Trims an environment value and treats an empty or whitespace-only one as unset, so `VAR=` in an
 * `.env` file falls back to the default.
 */
const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

/**
 * Splits a delimited environment value into trimmed, non-empty items; unset means an empty list.
 */
const list = (v: string | undefined, separator = ',') =>
  (v ?? '')
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Reads the same `ADMIN_*` variables that `scripts/setup-database.sh` turns into admin rules (Docker passes
 * them from `infra/docker/.env`).
 *
 * They are only shown to users who are not admins, who cannot read the rules from the database. Claim
 * rules are `claim|operator|value` entries separated by `;`, and the value may itself contain `|`.
 */
function readAdminCriteria(env: NodeJS.ProcessEnv): AdminCriteria {
  return {
    emails: list(env.ADMIN_EMAILS),
    domains: list(env.ADMIN_EMAIL_DOMAINS).map((d) => d.replace(/^@/, '')),
    groups: list(env.ADMIN_GROUPS),
    groupsClaim: blank(env.ADMIN_GROUPS_CLAIM) ?? '$.groups',
    claimRules: list(env.ADMIN_CLAIM_RULES, ';').map((rule) => {
      const [claim = '', operator = '', ...value] = rule.split('|');
      return { claim: claim.trim(), operator: operator.trim(), value: value.join('|') };
    }),
  };
}

/**
 * The configuration built on first use; the environment does not change while the server runs.
 */
let config: ServerConfig | undefined;

/**
 * Returns the server configuration, built once from `process.env` with defaults that fit the local Docker
 * stack and dev server.
 */
export function getConfig(): ServerConfig {
  return (config ??= readConfig());
}

/**
 * Builds the server configuration from `process.env`.
 */
function readConfig(): ServerConfig {
  const env = process.env;
  const issuer = blank(env.OIDC_ISSUER);
  const clientId = blank(env.OIDC_CLIENT_ID);

  return {
    postgrestUrl: (blank(env.POSTGREST_BASE_URI) ?? `http://localhost:${blank(env.POSTGREST_PORT) ?? '3000'}`).replace(
      /\/+$/,
      ''
    ),
    appUrl: (blank(env.APP_URL) ?? 'http://localhost:5173').replace(/\/+$/, ''),
    oidc:
      issuer && clientId
        ? {
            issuer,
            clientId,
            clientSecret: blank(env.OIDC_CLIENT_SECRET),
            scopes: blank(env.OIDC_SCOPES) ?? 'openid profile email',
            forwardToken: env.OIDC_FORWARD_TOKEN === 'access_token' ? 'access_token' : 'id_token',
            isTestServer: (env.COMPOSE_PROFILES ?? '').split(',').some((p) => p.trim() === 'oidc-mock'),
          }
        : null,
    adminCriteria: readAdminCriteria(env),
  };
}

/**
 * Strips the server configuration down to what the UI needs to display; anything secret, notably the
 * OIDC client secret, stays on the server.
 */
export function toPublicConfig(config: ServerConfig): PublicConfig {
  return {
    postgrestUrl: config.postgrestUrl,
    oidc: config.oidc
      ? {
          issuer: config.oidc.issuer,
          clientId: config.oidc.clientId,
          forwardToken: config.oidc.forwardToken,
          isTestServer: config.oidc.isTestServer,
        }
      : null,
    adminCriteria: config.adminCriteria,
  };
}

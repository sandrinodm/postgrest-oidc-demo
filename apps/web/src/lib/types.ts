// Shapes shared between the server functions and the UI.

/**
 * How the current token reached the app: the OIDC sign-in flow, a JWT pasted by hand, or the
 * `X-Auth-Request-Token` header of an authenticating reverse proxy.
 *
 * Only `proxy` sessions are owned by something outside the app, so sign-in and sign-out are refused for them.
 */
export type TokenSource = 'oidc' | 'manual' | 'proxy';

/**
 * Any JSON value, used for payloads instead of `unknown` because server functions can only carry
 * serializable data to the browser.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A decoded JWT header or payload, kept as raw JSON because each identity provider puts different claims in its tokens.
 */
export type Claims = { [key: string]: Json };

/**
 * One HTTP call the server made to PostgREST, recorded for the call log so the exact exchange behind a result can be inspected.
 */
export interface ApiCall {
  /**
   * Random UUID that identifies the entry in the call log.
   */
  id: string;

  /**
   * ISO 8601 timestamp of when the call was started.
   */
  at: string;

  /**
   * Short description of why the call was made, such as `whoami`, `list requests` or `console`.
   */
  label: string;

  /**
   * HTTP method sent to PostgREST, `GET` unless the caller asked for another.
   */
  method: string;

  /**
   * Absolute URL that was requested: the configured PostgREST base URL plus the path and query string.
   */
  url: string;

  /**
   * Headers that were sent, including `Accept-Profile` or `Content-Profile` for the API schema, with the bearer
   * token in `Authorization` shortened so the log never exposes a usable token.
   */
  requestHeaders: Record<string, string>;

  /**
   * JSON body that was sent, absent for requests without a body.
   */
  requestBody?: Json;

  /**
   * HTTP status PostgREST answered with, or `0` when it could not be reached.
   */
  status: number;

  /**
   * HTTP reason phrase that came with the status, empty when PostgREST could not be reached.
   */
  statusText: string;

  /**
   * The response headers that matter for debugging PostgREST (such as `content-range`, `preference-applied` and
   * `www-authenticate`); all others are dropped.
   */
  responseHeaders: Record<string, string>;

  /**
   * Parsed JSON response, the raw text when the body is not JSON, or `null` when it is empty or no response arrived.
   */
  responseBody: Json;

  /**
   * Wall-clock time in milliseconds from sending the request to reading the full body, including a retried attempt.
   */
  durationMs: number;

  /**
   * Network error message (with its cause) when PostgREST could not be reached; absent whenever an HTTP response
   * came back, even an error status.
   */
  error?: string;
}

/**
 * The admin settings from the app's `ADMIN_*` environment variables, which setup turns into admin rules in the database.
 *
 * Shown to users who are not admins, since they cannot read the rules themselves. They reflect the app's
 * environment, so they can drift from the database when it was set up with other values or has manual rules.
 */
export interface AdminCriteria {
  /**
   * Addresses from `ADMIN_EMAILS`; each becomes a rule that `$.email` equals the address.
   */
  emails: string[];

  /**
   * Domains from `ADMIN_EMAIL_DOMAINS` without a leading `@`; each becomes a rule that `$.email` ends with `@<domain>`.
   */
  domains: string[];

  /**
   * Group names from `ADMIN_GROUPS`; a user matches when any value at `groupsClaim` equals one of them.
   */
  groups: string[];

  /**
   * SQL/JSON path of the claim holding the user's groups or roles, from `ADMIN_GROUPS_CLAIM` and `$.groups` by default.
   */
  groupsClaim: string;

  /**
   * Free-form rules parsed from `ADMIN_CLAIM_RULES` (`<jsonpath>|<operator>|<value>`, separated by `;`), with the
   * operator passed through unvalidated.
   */
  claimRules: Array<{ claim: string; operator: string; value: string }>;
}

/**
 * The part of the server configuration that is safe to send to the browser; secrets such as the OIDC client secret
 * stay on the server.
 */
export interface PublicConfig {
  /**
   * Base URL the server uses to reach PostgREST, without a trailing slash.
   */
  postgrestUrl: string;

  /**
   * Admin settings from the environment, shown to explain how someone becomes an admin.
   */
  adminCriteria: AdminCriteria;

  /**
   * The app's own OIDC sign-in settings, or `null` when `OIDC_ISSUER` or `OIDC_CLIENT_ID` is not set and only pasted
   * or proxy tokens can be used.
   *
   * `forwardToken` says which token from the provider is sent to PostgREST, and `isTestServer` is true when the
   * `oidc-mock` Compose profile is active, so the UI can suggest test identities.
   */
  oidc: {
    issuer: string;
    clientId: string;
    forwardToken: 'id_token' | 'access_token';
    isTestServer: boolean;
  } | null;
}

/**
 * What an authenticating reverse proxy (oauth2-proxy or compatible) sent along with the token it supplied.
 */
export interface ProxyInfo {
  /**
   * The user the proxy says is signed in, taken from `X-Auth-Request-User`, `X-Forwarded-User` or
   * `X-Auth-Request-Email` in that order, or `null` when it sent none of them.
   */
  user: string | null;

  /**
   * Every `X-Auth-Request-*` and `X-Forwarded-*` header the proxy sent, keyed by lowercase name, with
   * `x-auth-request-token` cut to its first 16 characters.
   */
  headers: Record<string, string>;
}

/**
 * The token used for the current request and what it decodes to, rebuilt on every request from the proxy header or the
 * session cookie.
 */
export interface Session {
  /**
   * Where the token came from; a proxy token takes precedence over the app's own session cookie.
   */
  source: TokenSource;

  /**
   * The raw JWT sent to PostgREST. Server functions read it from the httpOnly cookie or the proxy header themselves,
   * so the browser's copy is for display only.
   */
  token: string;

  /**
   * Decoded JOSE header (`alg`, `kid`, …), or `null` when the token cannot be decoded.
   */
  header: Claims | null;

  /**
   * Decoded payload, or `null` when the token cannot be decoded.
   *
   * The app does not verify the signature on purpose: PostgREST does, and its rejection is what a debugger should show.
   */
  claims: Claims | null;

  /**
   * ISO 8601 time from the `exp` claim, or `null` when the token has none.
   */
  expiresAt: string | null;

  /**
   * Details from the reverse proxy when `source` is `proxy`, `null` otherwise.
   */
  proxy: ProxyInfo | null;
}

/**
 * What Postgres sees for the current request, as returned by the `whoami()` RPC after PostgREST verified the token and
 * switched roles.
 */
export interface WhoAmI {
  /**
   * The database role the request runs as (`current_user`): the anonymous role without a token, the authenticated
   * role once `timeoff.pre_request()` found a subject, or the role named by the token's own `role` claim.
   */
  role: string;

  /**
   * The token's `sub` claim (`timeoff.uid()`), which row level security compares with `user_id`; `null` without a
   * token or subject.
   */
  uid: string | null;

  /**
   * Lowercased address from the first of the `email`, `preferred_username` or `upn` claims (`timeoff.email()`), or
   * `null` when the token has none of them.
   */
  email: string | null;

  /**
   * Whether the claims match at least one enabled admin rule (`timeoff.is_admin()`), which lets the request pass every
   * row level security policy; always false without a subject.
   */
  is_admin: boolean;

  /**
   * The verified claims PostgREST put in `request.jwt.claims`, or `{}` for requests without a token.
   */
  claims: Claims;
}

/**
 * A kind of time off from `time_off_types`, readable by any signed-in user and writable only by admins.
 */
export interface TimeOffType {
  /**
   * Stable key such as `vacation` or `sick`, referenced by `TimeOffRequest.type_code`.
   */
  code: string;

  /**
   * Display name shown in the UI.
   */
  label: string;

  /**
   * CSS color for the type's marker, a hex value such as `#2563eb`.
   */
  color: string;

  /**
   * Whether requests of this type are meant to wait for an admin's approval. Informational only: nothing enforces
   * it, and users' requests start as `pending` whatever the type.
   */
  requires_approval: boolean;
}

/**
 * Lifecycle of a time-off request. Users create requests as `pending` and can only keep their own pending or cancel
 * them; row level security leaves approving and rejecting to admins.
 */
export type TimeOffStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * A row of `time_off_requests`. Row level security returns only the caller's own rows unless they are an admin.
 */
export interface TimeOffRequest {
  /**
   * UUID generated by Postgres.
   */
  id: string;

  /**
   * Owner of the request, the `sub` claim of whoever created it unless an admin booked it on someone's behalf.
   */
  user_id: string;

  /**
   * Email of whoever inserted the row, taken from their token by a column default, so an admin booking on someone's
   * behalf records their own; `null` when the token carried none.
   */
  user_email: string | null;

  /**
   * The `name` claim of whoever inserted the row, filled in the same way as `user_email`; `null` when the token had
   * none.
   */
  user_name: string | null;

  /**
   * The `TimeOffType.code` this request is booked as.
   */
  type_code: string;

  /**
   * First day off as an ISO date (`YYYY-MM-DD`).
   */
  start_date: string;

  /**
   * Last day off as an ISO date (`YYYY-MM-DD`), inclusive and never before `start_date`.
   */
  end_date: string;

  /**
   * Whether only half of a single day is taken; Postgres rejects it when `start_date` and `end_date` differ.
   */
  half_day: boolean;

  /**
   * Days taken, computed by Postgres: `0.5` for a half day, otherwise the weekdays between the dates, inclusive
   * (public holidays are not excluded).
   */
  days: number;

  /**
   * Free-text explanation, or `null` when none was given.
   */
  reason: string | null;

  /**
   * Where the request is in its lifecycle; `pending` when created.
   */
  status: TimeOffStatus;

  /**
   * ISO 8601 timestamp of when the row was inserted.
   */
  created_at: string;

  /**
   * ISO 8601 timestamp of the last update, maintained by a trigger.
   */
  updated_at: string;
}

/**
 * An admin rule as exposed by the `admin_rules` view, which returns rows only to admins.
 */
export interface AdminRule {
  /**
   * Identity value from the private `timeoff.admin_rules` table.
   */
  id: number;

  /**
   * SQL/JSON path into the token claims, such as `$.email` or `$.realm_access.roles`; arrays found there are unwrapped
   * so each element is compared on its own.
   */
  claim: string;

  /**
   * How claim values are compared with `value`: `equals`, `ends_with`, `starts_with`, `contains` or `matches` (a
   * regular expression), always ignoring case.
   */
  operator: string;

  /**
   * The text or pattern a claim value is compared with.
   */
  value: string;

  /**
   * Whether the rule only applies when the token's `email_verified` claim is `true`.
   */
  require_email_verified: boolean;

  /**
   * Whether the rule is considered at all; disabled rules never match.
   */
  enabled: boolean;

  /**
   * `env` for rules rewritten from the `ADMIN_*` settings on every setup run, `manual` for rules added by hand and
   * left alone.
   */
  source: string;

  /**
   * Free-text note; setup-managed rules carry the name of the variable they came from, such as `ADMIN_EMAILS`.
   */
  description: string | null;

  /**
   * Whether this rule matches the claims of the token that read it, which shows why the caller is an admin.
   */
  matches_me: boolean;
}

/**
 * Which time-off requests to list: only the caller's own, or everyone's. `all` only widens the list for admins, since
 * row level security limits everyone else to their own rows anyway.
 */
export type Scope = 'mine' | 'all';

/**
 * Everything the debugger page shows, gathered in one server round trip; fields stay `null` when the call that fills
 * them was skipped or failed.
 */
export interface DebuggerState {
  /**
   * Browser-safe server configuration.
   */
  config: PublicConfig;

  /**
   * The current token and its decoded contents, or `null` when nobody is signed in.
   */
  session: Session | null;

  /**
   * What Postgres sees for this token, or `null` when the `whoami` call failed (for example because PostgREST
   * rejected the token).
   */
  whoami: WhoAmI | null;

  /**
   * Requests visible under the chosen scope, newest start date first, or `null` when signed out or the call failed.
   */
  requests: TimeOffRequest[] | null;

  /**
   * Time-off types ordered by label, empty when signed out or the call failed.
   */
  types: TimeOffType[];

  /**
   * Admin rules, only loaded for admins; `null` for everyone else or when the call failed.
   */
  adminRules: AdminRule[] | null;

  /**
   * Readable message for the first failed call that blocked part of the page, or `null` when everything loaded.
   */
  error: string | null;

  /**
   * Every PostgREST call made to build this state, in the order they were recorded.
   */
  calls: ApiCall[];
}

/**
 * What a mutating server function returns: its own result plus the log of the PostgREST calls it made, so the call
 * log can show them.
 */
export interface WithCalls<T> {
  /**
   * The function's own outcome, such as an error message or the number of rows deleted.
   */
  result: T;

  /**
   * The PostgREST calls made while producing `result`.
   */
  calls: ApiCall[];
}

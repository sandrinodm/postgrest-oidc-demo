// Server functions. They run on the server, read the token from the session
// cookie, call PostgREST with it, and hand back the result together with a
// log of every PostgREST call they made.
import { createServerFn } from '@tanstack/react-start';
import { getConfig, toPublicConfig } from './config.server';
import { describeError, pgrst } from './postgrest.server';
import { clearSession, decodeToken, readSession, stripBearer, writeSession } from './session.server';
import type {
  AdminRule,
  ApiCall,
  DebuggerState,
  Json,
  Scope,
  TimeOffRequest,
  TimeOffType,
  WhoAmI,
  WithCalls,
} from './types';

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Appended to a permission error on `whoami` with a signed-in session, which means PostgREST accepted the
 * token but ran the request as its anonymous role, which has no access.
 *
 * That happens when the token has no `role` claim and PostgREST has no pre-request hook to switch roles,
 * as with a managed PostgREST service and an identity provider that can't add the claim.
 */
const ANONYMOUS_ROLE_HINT =
  ' · PostgREST verified your token but ran it as its anonymous role, which has no access. Either have your' +
  ' identity provider add "role": "authenticated" to tokens, or set PGRST_DB_PRE_REQUEST=timeoff.pre_request.';

/**
 * Loads everything the debugger page shows for the current token: what Postgres thinks of the caller
 * (`/rpc/whoami`), their time-off requests, the time-off types and, for admins, the admin rules.
 *
 * Without a session it only checks that PostgREST answers, because the anonymous role has no access to
 * anything. With one, `whoami` runs alongside the types and a failure there stops the load; the requests
 * and admin rules wait for it, since they depend on the caller's uid and admin flag. The "all" scope only applies
 * to admins, since RLS would hide other users' rows anyway. Every call is recorded in `calls`, and errors
 * land in `error` instead of throwing so the page still renders.
 */
export const loadDebuggerState = createServerFn({ method: 'GET' })
  .validator((input: { scope: Scope }) => ({ scope: input.scope === 'all' ? 'all' : 'mine' }) as const)
  .handler(async ({ data }): Promise<DebuggerState> => {
    const config = getConfig();
    const session = readSession();
    const token = session?.token ?? null;
    const calls: ApiCall[] = [];

    const state: DebuggerState = {
      config: toPublicConfig(config),
      session,
      whoami: null,
      requests: null,
      types: [],
      adminRules: null,
      error: null,
      calls,
    };

    // The anonymous role has no access to anything in the API schema, so a
    // signed-out page only checks that PostgREST answers (its OpenAPI root).
    if (!session) {
      const health = await pgrst({ label: 'health', path: '/', token: null });
      calls.push(health.call);
      if (!health.ok) {
        state.error = describeError(health);
      }
      return state;
    }

    const [whoami, types] = await Promise.all([
      pgrst<WhoAmI>({ label: 'whoami', path: '/rpc/whoami', token }),
      pgrst<TimeOffType[]>({ label: 'list types', path: '/time_off_types?select=*&order=label', token }),
    ]);
    calls.push(whoami.call, types.call);
    if (types.ok) {
      state.types = types.data;
    }
    if (!whoami.ok) {
      const ranAsAnonymous = (whoami.data as { code?: string } | null)?.code === '42501';
      state.error = describeError(whoami) + (ranAsAnonymous ? ANONYMOUS_ROLE_HINT : '');
      return state;
    }
    state.whoami = whoami.data;

    const uid = whoami.data.uid;
    const ownOnly = data.scope === 'mine' || !whoami.data.is_admin;
    const filter = ownOnly && uid ? `&user_id=eq.${encodeURIComponent(uid)}` : '';

    const [requests, rules] = await Promise.all([
      pgrst<TimeOffRequest[]>({
        label: 'list requests',
        path: `/time_off_requests?select=*&order=start_date.desc${filter}`,
        token,
      }),
      whoami.data.is_admin
        ? pgrst<AdminRule[]>({
            label: 'admin rules',
            path: '/admin_rules?select=*&order=id',
            token,
          })
        : null,
    ]);

    calls.push(requests.call);
    if (requests.ok) {
      state.requests = requests.data;
    } else {
      state.error = describeError(requests);
    }
    if (rules) {
      calls.push(rules.call);
      if (rules.ok) {
        state.adminRules = rules.data;
      }
    }
    return state;
  });

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Refuses to change the session when the token comes from an authenticating reverse proxy.
 *
 * The proxy owns that session and sends its token on every request, so a cookie written or cleared here
 * would have no effect; the user has to sign in or out at the proxy instead.
 */
function assertNotBehindProxy() {
  if (readSession()?.source === 'proxy') {
    throw new Error('You are signed in through the reverse proxy; sign in and out there.');
  }
}

/**
 * Stores a pasted JWT (an optional `Bearer ` prefix is stripped) as the session token.
 *
 * The validator only checks that the token has three parts and a decodable payload; the signature is not
 * verified here on purpose, so a bad token reaches PostgREST and its error shows up in the call log.
 */
export const signInWithToken = createServerFn({ method: 'POST' })
  .validator((input: { token: string }) => {
    const token = stripBearer(input.token ?? '');
    if (!token || token.split('.').length !== 3) {
      throw new Error('That does not look like a JWT.');
    }
    if (!decodeToken(token).claims) {
      throw new Error('Could not decode the JWT payload.');
    }
    return { token };
  })
  .handler(async ({ data }) => {
    assertNotBehindProxy();
    // Not verified here on purpose: PostgREST does that, and its error is
    // exactly what you want to see when debugging a bad token.
    writeSession(data.token, 'manual');
    return { ok: true };
  });

/**
 * Clears the session cookies. Refused behind an authenticating reverse proxy, which owns the session.
 */
export const signOut = createServerFn({ method: 'POST' }).handler(async () => {
  assertNotBehindProxy();
  clearSession();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------

/**
 * The form input for a new time-off request, sent to PostgREST as the row to insert.
 *
 * RLS decides what is allowed: users can only create pending requests for themselves.
 */
export interface NewTimeOff {
  /**
   * Code of an entry in `time_off_types`, such as `vacation` or `sick`.
   */
  type_code: string;

  /**
   * First day off, as an ISO date (`YYYY-MM-DD`).
   */
  start_date: string;

  /**
   * Last day off, inclusive, as an ISO date.
   */
  end_date: string;

  /**
   * Counts the request as half a day; the database only allows it when start and end are the same date.
   */
  half_day: boolean;

  /**
   * Free-text note; whitespace-only input is stored as `null`.
   */
  reason: string;

  /**
   * The user to book for, when an admin books on behalf of someone else.
   *
   * Omitted (or blank) means the caller; the database fills in `timeoff.uid()`, and RLS rejects another
   * user's id from anyone who is not an admin.
   */
  user_id?: string;
}

/**
 * Inserts a time-off request through PostgREST with the session token.
 *
 * A rejected insert (for example an RLS violation) is returned as a readable `error`, not thrown, so the
 * dialog can show it next to the logged call.
 */
export const createTimeOff = createServerFn({ method: 'POST' })
  .validator((input: NewTimeOff) => input)
  .handler(async ({ data }): Promise<WithCalls<{ error: string | null }>> => {
    const body: { [key: string]: Json } = {
      type_code: data.type_code,
      start_date: data.start_date,
      end_date: data.end_date,
      half_day: data.half_day,
      reason: data.reason.trim() || null,
    };
    if (data.user_id?.trim()) {
      body.user_id = data.user_id.trim();
    }
    const res = await pgrst({
      label: 'create request',
      method: 'POST',
      path: '/time_off_requests',
      token: readSession()?.token,
      body,
      prefer: 'return=representation',
    });
    return { result: { error: res.ok ? null : describeError(res) }, calls: [res.call] };
  });

/**
 * Deletes one time-off request by id, reporting an error when PostgREST removed nothing.
 *
 * RLS does not raise on DELETE: rows the caller may not touch are simply invisible, so PostgREST answers
 * success with an empty result. Asking for `return=representation` makes that case detectable, and it is
 * reported as "not visible (RLS)" instead of a silent success.
 */
export const deleteTimeOff = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<WithCalls<{ error: string | null }>> => {
    const res = await pgrst<TimeOffRequest[]>({
      label: 'delete request',
      method: 'DELETE',
      path: `/time_off_requests?id=eq.${encodeURIComponent(data.id)}`,
      token: readSession()?.token,
      prefer: 'return=representation',
    });
    if (!res.ok) {
      return { result: { error: describeError(res) }, calls: [res.call] };
    }
    // RLS does not raise on DELETE; rows you may not touch are just invisible.
    const error = res.data.length === 0 ? 'Nothing deleted: the row is not visible to you (RLS).' : null;
    return { result: { error }, calls: [res.call] };
  });

// ---------------------------------------------------------------------------
// Console: send any request to PostgREST with the current token
// ---------------------------------------------------------------------------

/**
 * HTTP methods the console offers, in menu order; the console's method type is derived from it.
 */
export const CONSOLE_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

/**
 * A free-form request from the console panel, as typed by the user.
 */
export interface ConsoleRequest {
  /**
   * HTTP method sent to PostgREST.
   */
  method: (typeof CONSOLE_METHODS)[number];

  /**
   * Path and query string relative to the PostgREST root, e.g. `/time_off_requests?select=*`.
   */
  path: string;

  /**
   * Raw JSON request body; blank means no body.
   */
  body: string;

  /**
   * Value for the `Prefer` header (e.g. `return=representation`); blank omits the header.
   */
  prefer: string;

  /**
   * Sends the session token; off sends the request anonymously, to see what the `anon` role gets.
   */
  withToken: boolean;
}

/**
 * Sends an arbitrary request to PostgREST, with or without the session token, and returns only the call log.
 *
 * The path must be relative (starting with a single `/` and carrying no scheme) so it is always appended
 * to the configured PostgREST URL; otherwise the console could make the server send the user's token to
 * any host. An invalid JSON body throws before anything is sent.
 */
export const sendConsoleRequest = createServerFn({ method: 'POST' })
  .validator((input: ConsoleRequest) => {
    const path = input.path.trim();
    if (!path.startsWith('/') || path.startsWith('//') || /^\/?[a-z]+:/i.test(path)) {
      throw new Error('Path must be relative to PostgREST, e.g. /time_off_requests?select=*');
    }
    return {
      ...input,
      path,
      parsedBody: input.body.trim() ? (JSON.parse(input.body) as Json) : undefined,
    };
  })
  .handler(async ({ data }): Promise<WithCalls<null>> => {
    const res = await pgrst({
      label: 'console',
      method: data.method,
      path: data.path,
      token: data.withToken ? readSession()?.token : null,
      body: data.parsedBody,
      prefer: data.prefer.trim() || undefined,
    });
    return { result: null, calls: [res.call] };
  });

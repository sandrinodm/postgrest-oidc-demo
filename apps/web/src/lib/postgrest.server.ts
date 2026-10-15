import { getConfig, withoutPassword } from './config.server';
import { errorMessage } from './errors';
import type { ApiCall, Json } from './types';

/**
 * The schema the time-off API lives in: the tables, the `admin_rules` view and `whoami()` are installed in
 * `public` by `scripts/setup-database.sh`.
 */
const API_SCHEMA = 'public';

/**
 * Response headers copied into the request log: the ones that explain PostgREST's behavior, such as
 * `content-range` (row counts), `preference-applied` (honored `Prefer` values) and `www-authenticate`
 * (why a JWT was rejected).
 */
const INTERESTING_HEADERS = [
  'content-type',
  'content-range',
  'content-location',
  'location',
  'preference-applied',
  'proxy-status',
  'www-authenticate',
];

/**
 * One call to make against the configured PostgREST.
 */
export interface PgrstRequest {
  /**
   * Short human-readable name for the call in the request log, such as `whoami` or `delete request`.
   */
  label: string;

  /**
   * HTTP method, `GET` when omitted. Only GETs are retried after a network error.
   */
  method?: string;

  /**
   * Path relative to the PostgREST root, including the query string.
   */
  path: string;

  /**
   * JWT sent as a Bearer token; without one the request runs as PostgREST's anonymous role.
   */
  token?: string | null;

  /**
   * JSON request body; omitted means no body and no `Content-Type` header.
   */
  body?: Json;

  /**
   * Value for the `Prefer` header, e.g. `return=representation` or `count=exact`.
   */
  prefer?: string;
}

/**
 * The outcome of a PostgREST call. Failures are returned rather than thrown, so callers can always log
 * `call`.
 */
export interface PgrstResponse<T> {
  /**
   * True for a 2xx response; false for HTTP errors and for network failures.
   */
  ok: boolean;

  /**
   * Parsed JSON body (raw text if it was not JSON, `null` if empty). Only shaped like `T` when `ok`;
   * otherwise it is PostgREST's error object or `null`.
   */
  data: T;

  /**
   * The logged exchange, with the bearer token redacted, for the UI's call log.
   */
  call: ApiCall;
}

/**
 * Shortens a token for the call log, keeping only enough of both ends to tell tokens apart. The log is
 * sent to the browser, so the full token must never appear in it; short tokens are hidden entirely.
 */
function redactBearer(token: string) {
  return token.length > 24 ? `Bearer ${token.slice(0, 12)}…${token.slice(-8)}` : 'Bearer …';
}

/**
 * Calls PostgREST and records the exchange so the UI can show it. Network
 * failures do not throw; they come back as status 0 with `call.error` set.
 *
 * Every request names the configured schema, and a GET that fails at the network level is retried once.
 */
export async function pgrst<T = Json>(req: PgrstRequest): Promise<PgrstResponse<T>> {
  const method = req.method ?? 'GET';
  const url = `${getConfig().postgrestUrl}${req.path.startsWith('/') ? '' : '/'}${req.path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Select the schema explicitly, so this also works against a PostgREST that
  // exposes several schemas (where public might not be the default).
  if (method === 'GET' || method === 'HEAD') {
    headers['Accept-Profile'] = API_SCHEMA;
  } else {
    headers['Content-Profile'] = API_SCHEMA;
  }
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (req.prefer) {
    headers.Prefer = req.prefer;
  }
  if (req.token) {
    headers.Authorization = `Bearer ${req.token}`;
  }

  const call: ApiCall = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    label: req.label,
    method,
    url: withoutPassword(url),
    requestHeaders: {
      ...headers,
      ...(req.token ? { Authorization: redactBearer(req.token) } : {}),
    },
    requestBody: req.body,
    status: 0,
    statusText: '',
    responseHeaders: {},
    responseBody: null,
    durationMs: 0,
  };

  /**
   * Performs the actual fetch; a function so the GET retry below can repeat it.
   */
  const send = () =>
    fetch(url, {
      method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });

  const started = performance.now();
  try {
    // A pooled keep-alive connection can point at a PostgREST container that
    // was just recreated. Reads are safe to retry once.
    const res = await send().catch((err: unknown) => {
      if (method !== 'GET') {
        throw err;
      }
      return send();
    });
    const text = await res.text();
    let body: Json = text;
    try {
      body = text ? (JSON.parse(text) as Json) : null;
    } catch {
      // Not JSON; keep the text.
    }
    call.status = res.status;
    call.statusText = res.statusText;
    call.responseBody = body;
    for (const name of INTERESTING_HEADERS) {
      const value = res.headers.get(name);
      if (value) {
        call.responseHeaders[name] = value;
      }
    }
    call.durationMs = Math.round(performance.now() - started);
    return { ok: res.ok, data: body as T, call };
  } catch (err) {
    call.durationMs = Math.round(performance.now() - started);
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    // Node's fetch error quotes the full URL; never echo a password from it.
    const base = getConfig().postgrestUrl;
    call.error = `${errorMessage(err)}${cause}`.split(base).join(withoutPassword(base));
    return { ok: false, data: null as T, call };
  }
}

/**
 * Turns a failed PostgREST response into a one-line message for the UI.
 *
 * Network failures name the PostgREST URL that could not be reached; PostgREST errors are shown as
 * status, error code, message and hint, since the code (e.g. `42501` for an RLS violation) is often the
 * real signal.
 */
export function describeError(res: PgrstResponse<unknown>): string {
  if (res.call.error) {
    return `Could not reach PostgREST at ${withoutPassword(getConfig().postgrestUrl)} (${res.call.error})`;
  }
  const body = res.data as { message?: string; code?: string; hint?: string | null } | null;
  if (body && typeof body === 'object' && body.message) {
    return [`${res.call.status} ${body.code ?? ''}`.trim(), body.message, body.hint].filter(Boolean).join(' · ');
  }
  return `${res.call.status} ${res.call.statusText}`;
}

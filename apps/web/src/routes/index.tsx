import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminHelpPanel } from '#/components/admin-help-panel';
import { AdminRulesPanel } from '#/components/admin-rules-panel';
import { ConnectionBar } from '#/components/connection-bar';
import { ConsolePanel } from '#/components/console-panel';
import { IdentityPanel } from '#/components/identity-panel';
import { RequestLog } from '#/components/request-log';
import { RequestsPanel } from '#/components/requests-panel';
import { loadDebuggerState } from '#/lib/api';
import type { ApiCall, Scope } from '#/lib/types';

/**
 * Search parameters of the debugger page, validated so a hand-edited URL cannot inject unexpected values.
 */
interface Search {
  /**
   * Whose requests to list; unset means everyone's, which the server narrows to your own unless you are an admin.
   */
  scope?: Scope;

  /**
   * Sign-in failure reported by the OIDC callback redirect, shown as a dismissible banner.
   */
  error?: string;
}

/**
 * The debugger page, whose loader fetches the session, `whoami`, and the visible requests in one server call and reloads whenever the scope changes.
 */
export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    scope: search.scope === 'mine' || search.scope === 'all' ? search.scope : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  loaderDeps: ({ search }) => ({ scope: search.scope ?? 'all' }),
  loader: ({ deps }) => loadDebuggerState({ data: { scope: deps.scope } }),
  component: Debugger,
});

/**
 * Caps the request log so a long debugging session does not grow the page without bound; the oldest calls drop off first.
 */
const MAX_LOG = 200;

/**
 * Lays out the debugger: identity and admin rules on the side, and the requests table, admin help, console, and request log in the main column.
 *
 * Calls from the loader, the dialogs, and the console are merged into one log, deduplicated by id because the effect that feeds in the loader's calls can run more than once for the same data (React Strict Mode re-runs effects in development).
 */
function Debugger() {
  const state = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const scope = search.scope ?? 'all';

  // Every PostgREST call the server made on our behalf, newest first.
  const [log, setLog] = useState<ApiCall[]>([]);
  const seen = useRef(new Set<string>());
  const addCalls = useCallback((calls: ApiCall[]) => {
    const fresh = calls.filter((c) => !seen.current.has(c.id));
    for (const c of fresh) {
      seen.current.add(c.id);
    }
    if (fresh.length > 0) {
      setLog((prev) => [...fresh.reverse(), ...prev].slice(0, MAX_LOG));
    }
  }, []);
  useEffect(() => addCalls(state.calls), [state.calls, addCalls]);

  const refresh = useCallback(() => router.invalidate(), [router]);

  return (
    <div className="app">
      <ConnectionBar url={state.config.postgrestUrl} reachable={!state.error} />

      <header className="topbar">
        <div className="brand">
          <span className="logo">⟁</span>
          <div>
            <h1>PostgREST debugger</h1>
            <p className="muted small">time-off API</p>
          </div>
        </div>
        <div className="modes">
          {state.session?.source === 'proxy' ? (
            <span className="pill on">reverse proxy</span>
          ) : (
            <span className={state.config.oidc ? 'pill on' : 'pill'}>OIDC</span>
          )}
          <span className={state.error ? 'pill bad' : 'pill on'}>{state.error ? 'API error' : 'API up'}</span>
        </div>
      </header>

      {search.error && (
        <p className="error banner">
          Sign-in failed: {search.error}{' '}
          <button className="link" onClick={() => void navigate({ search: { scope: search.scope } })}>
            dismiss
          </button>
        </p>
      )}
      {state.error && <p className="error banner">{state.error}</p>}

      <main className="layout">
        <aside className="side">
          <IdentityPanel config={state.config} session={state.session} whoami={state.whoami} onChanged={refresh} />
          {state.whoami?.is_admin && state.adminRules && <AdminRulesPanel rules={state.adminRules} />}
        </aside>

        <div className="main">
          {state.session && state.whoami && state.requests ? (
            <RequestsPanel
              requests={state.requests}
              types={state.types}
              whoami={state.whoami}
              scope={scope}
              onScopeChange={(next) => void navigate({ search: { scope: next } })}
              onCalls={addCalls}
              onChanged={refresh}
            />
          ) : (
            <section className="panel placeholder">
              <h2>{state.session ? 'Nothing to show' : 'Not signed in'}</h2>
              <p className="muted">
                {state.session
                  ? 'PostgREST did not accept the current token. Open the failing call below to see why.'
                  : 'Pick an identity on the left. Anonymous requests have no access to the time-off tables.'}
              </p>
            </section>
          )}
          {!state.whoami?.is_admin && (
            <AdminHelpPanel
              criteria={state.config.adminCriteria}
              isTestServer={state.config.oidc?.isTestServer ?? false}
            />
          )}
          <ConsolePanel onCalls={addCalls} />
          <RequestLog
            calls={log}
            onClear={() => {
              setLog([]);
            }}
          />
        </div>
      </main>
    </div>
  );
}

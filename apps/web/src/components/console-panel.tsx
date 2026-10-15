import { useState, type FormEvent } from 'react';
import { CONSOLE_METHODS, sendConsoleRequest, type ConsoleRequest } from '#/lib/api';
import { useAction } from '#/lib/hooks';
import type { ApiCall } from '#/lib/types';

/**
 * Preset requests for the console, chosen to show the API and its row level security at work.
 *
 * "Bob's rows" returns nothing unless you are Bob or an admin, and "approve own" fails for regular users because the update policy only lets them set `pending` or `cancelled`.
 */
const EXAMPLES: Array<{ label: string; request: Partial<ConsoleRequest> }> = [
  { label: 'whoami', request: { method: 'GET', path: '/rpc/whoami' } },
  {
    label: 'list',
    request: { method: 'GET', path: '/time_off_requests?select=*&order=start_date' },
  },
  {
    label: "Bob's rows",
    request: { method: 'GET', path: '/time_off_requests?user_id=eq.user-bob' },
  },
  {
    label: 'approve own',
    request: {
      method: 'PATCH',
      path: '/time_off_requests?status=eq.pending',
      body: '{"status": "approved"}',
      prefer: 'return=representation',
    },
  },
  { label: 'admin rules', request: { method: 'GET', path: '/admin_rules' } },
  { label: 'OpenAPI', request: { method: 'GET', path: '/' } },
];

/**
 * Sends a hand-written request to PostgREST through the server, with or without the session token.
 *
 * Results are not shown here: the call, including any PostgREST error, lands in the request log via `onCalls`.
 */
export function ConsolePanel({ onCalls }: { onCalls: (calls: ApiCall[]) => void }) {
  const [req, setReq] = useState<ConsoleRequest>({
    method: 'GET',
    path: '/time_off_requests?select=*',
    body: '',
    prefer: '',
    withToken: true,
  });
  const { busy, error, run } = useAction();
  /**
   * Merges a partial update into the request being edited.
   */
  const set = (patch: Partial<ConsoleRequest>) => setReq((r) => ({ ...r, ...patch }));
  const hasBody = req.method !== 'GET' && req.method !== 'DELETE';

  /**
   * Sends the request, dropping any body for GET and DELETE; only failures to reach the server function (such as an invalid path or JSON body) show inline.
   */
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const { calls } = await sendConsoleRequest({
        data: { ...req, body: hasBody ? req.body : '' },
      });
      onCalls(calls);
    });
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Console</h2>
        <span className="muted small">results land in the call log</span>
      </header>
      <form className="panel-body form console" onSubmit={submit}>
        <div className="presets">
          {EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex.label}
              className="chip"
              onClick={() => set({ body: '', prefer: '', ...ex.request })}
            >
              {ex.label}
            </button>
          ))}
        </div>
        <div className="row">
          <select value={req.method} onChange={(e) => set({ method: e.target.value as ConsoleRequest['method'] })}>
            {CONSOLE_METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input className="grow mono" value={req.path} onChange={(e) => set({ path: e.target.value })} />
        </div>
        {hasBody && (
          <textarea
            className="mono"
            rows={3}
            value={req.body}
            placeholder="JSON body"
            onChange={(e) => set({ body: e.target.value })}
          />
        )}
        <div className="row">
          <label className="grow">
            <span>Prefer</span>
            <input
              className="mono"
              value={req.prefer}
              placeholder="return=representation, count=exact"
              onChange={(e) => set({ prefer: e.target.value })}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={req.withToken} onChange={(e) => set({ withToken: e.target.checked })} />
            <span>Send token</span>
          </label>
          <button className="btn primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  );
}

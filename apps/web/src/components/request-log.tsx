import { useState } from 'react';
import type { ApiCall } from '#/lib/types';
import { Json } from './json';

/**
 * Picks the status badge color: transport failures and 5xx are errors, while 4xx is only a warning because rejected tokens and RLS denials are often exactly what you are debugging.
 */
function statusClass(call: ApiCall) {
  if (call.error || call.status === 0 || call.status >= 500) {
    return 'err';
  }
  if (call.status >= 400) {
    return 'warn';
  }
  return 'ok';
}

/**
 * Lists every PostgREST call the server made, newest first, and expands one at a time to show its headers, bodies, status, and timing.
 *
 * The query string is URL-decoded so PostgREST filters such as `user_id=eq.user-bob` stay readable.
 */
export function RequestLog({ calls, onClear }: { calls: ApiCall[]; onClear: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section className="panel log">
      <header className="panel-head">
        <h2>
          PostgREST calls <span className="muted">({calls.length})</span>
        </h2>
        <button className="btn small" onClick={onClear} disabled={calls.length === 0}>
          Clear
        </button>
      </header>
      {calls.length === 0 && <p className="empty">No calls yet.</p>}
      <ol className="calls">
        {calls.map((c) => {
          const open = openId === c.id;
          const url = new URL(c.url);
          return (
            <li key={c.id} className={open ? 'open' : ''}>
              <button className="call-row" onClick={() => setOpenId(open ? null : c.id)}>
                <span className={`code ${statusClass(c)}`}>{c.error ? 'ERR' : c.status}</span>
                <span className={`method m-${c.method.toLowerCase()}`}>{c.method}</span>
                <span className="path">
                  {url.pathname}
                  <span className="muted">{decodeURIComponent(url.search)}</span>
                </span>
                <span className="label">{c.label}</span>
                <span className="muted small">{c.durationMs} ms</span>
              </button>
              {open && (
                <div className="call-detail">
                  {c.error && <p className="error">{c.error}</p>}
                  <div className="cols">
                    <div>
                      <h4>Request</h4>
                      <Json value={c.requestHeaders} />
                      {c.requestBody !== undefined && <Json value={c.requestBody} />}
                    </div>
                    <div>
                      <h4>
                        Response {c.status} {c.statusText}
                      </h4>
                      {Object.keys(c.responseHeaders).length > 0 && <Json value={c.responseHeaders} />}
                      <Json value={c.responseBody} />
                    </div>
                  </div>
                  <p className="muted small">
                    {new Date(c.at).toLocaleTimeString()} · {c.url}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

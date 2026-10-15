import { useState } from 'react';
import { signInWithToken } from '#/lib/api';
import { useAction, useCopy } from '#/lib/hooks';
import type { PublicConfig } from '#/lib/types';
import { Json } from './json';

/**
 * Sign-in methods offered as tabs when no session exists.
 */
type Tab = 'oidc' | 'token';

/**
 * Lets an anonymous visitor sign in with OIDC or a pasted JWT, opening on the OIDC tab only when OIDC is configured.
 */
export function SignInPanel({ config, onChanged }: { config: PublicConfig; onChanged: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>(config.oidc ? 'oidc' : 'token');

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Sign in</h2>
      </header>
      <div className="tabs" role="tablist">
        {(
          [
            ['oidc', 'OIDC'],
            ['token', 'Paste JWT'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'tab active' : 'tab'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'oidc' && <OidcSignIn config={config} />}
        {tab === 'token' && <PasteToken onChanged={onChanged} />}
      </div>
    </section>
  );
}

/**
 * Starts the server-side OIDC login, or explains which `.env` settings enable it when OIDC is not configured.
 *
 * Also shows the issuer, client, and which token (id or access) gets forwarded, since a mismatch there is a common cause of PostgREST rejections.
 */
function OidcSignIn({ config }: { config: PublicConfig }) {
  if (!config.oidc) {
    return (
      <div className="muted">
        <p>
          OIDC is not configured. To enable it, set these in <code>infra/docker/.env</code>:
        </p>
        <Json value={'OIDC_ISSUER=https://your-idp\nOIDC_CLIENT_ID=...\nOIDC_AUDIENCE=<client id>'} />
        <p className="small">
          Register <code>{'<APP_URL>/auth/callback'}</code> as a redirect URI, then restart the stack and this app.
        </p>
      </div>
    );
  }
  return (
    <div className="form">
      <dl className="kv">
        <dt>issuer</dt>
        <dd>{config.oidc.issuer}</dd>
        <dt>client</dt>
        <dd>{config.oidc.clientId}</dd>
        <dt>forwards</dt>
        <dd>{config.oidc.forwardToken}</dd>
      </dl>
      <a className="btn primary" href="/auth/login">
        Sign in with OIDC
      </a>
      {config.oidc.isTestServer && <TestServerIdentities />}
    </div>
  );
}

/**
 * Subjects and claims to type into the local test server's login page, which accepts anything.
 *
 * The subjects match the seed data so Alice and Bob see their sample requests, and Dave and Ada match the default admin rules by group and by email.
 */
const TEST_IDENTITIES = [
  {
    label: 'Alice',
    hint: 'regular user',
    subject: 'user-alice',
    claims: { email: 'alice@example.com', name: 'Alice Martin', groups: ['staff'] },
  },
  {
    label: 'Bob',
    hint: 'regular user',
    subject: 'user-bob',
    claims: { email: 'bob@example.com', name: 'Bob Janssens', groups: ['staff'] },
  },
  {
    label: 'Dave',
    hint: 'admin by group',
    subject: 'user-dave',
    claims: {
      email: 'dave@example.com',
      name: 'Dave Peeters',
      groups: ['staff', 'timeoff-admins'],
    },
  },
  {
    label: 'Ada',
    hint: 'admin by email',
    subject: 'user-admin',
    claims: { email: 'admin@example.com', name: 'Ada Admin' },
  },
];

/**
 * Lists the ready-made test identities with copy buttons for their subject and claims JSON.
 */
function TestServerIdentities() {
  const { copied, copy } = useCopy();

  return (
    <div className="test-identities">
      <p className="muted small">
        This is the local test server: its login page accepts any subject and any claims JSON. Use one of these:
      </p>
      {TEST_IDENTITIES.map((id) => (
        <div key={id.label} className="test-identity">
          <div className="test-identity-head">
            <strong>{id.label}</strong>
            <span className="muted small">{id.hint}</span>
          </div>
          {(
            [
              ['subject', id.subject],
              ['claims', JSON.stringify(id.claims)],
            ] as const
          ).map(([what, text]) => {
            const key = `${id.label}:${what}`;
            return (
              <div key={what} className="test-identity-row">
                <code className="small">{text}</code>
                <button type="button" className="btn small" onClick={() => void copy(key, text)}>
                  {copied === key ? 'Copied' : `Copy ${what}`}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Stores any pasted JWT as the session without verifying it, so PostgREST's own verdict shows up in the request log.
 */
function PasteToken({ onChanged }: { onChanged: () => Promise<void> }) {
  const [token, setToken] = useState('');
  const { busy, error, run } = useAction();

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await signInWithToken({ data: { token } });
          await onChanged();
        });
      }}
    >
      <p className="muted small">Use any JWT as-is. PostgREST decides whether it is valid.</p>
      <textarea rows={6} value={token} placeholder="eyJhbGciOi…" onChange={(e) => setToken(e.target.value)} />
      <button className="btn primary" disabled={busy || !token.trim()}>
        Use this token
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

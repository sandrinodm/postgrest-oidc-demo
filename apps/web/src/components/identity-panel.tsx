import { useState } from 'react';
import { signOut } from '#/lib/api';
import { useCopy } from '#/lib/hooks';
import type { Json as JsonValue, PublicConfig, Session, WhoAmI } from '#/lib/types';
import { Json } from './json';
import { Modal } from './modal';
import { SignInPanel } from './sign-in-panel';

/**
 * Renders a claim for display only when it is a string or number, so arrays and objects never leak into a name line.
 */
const claimText = (value: JsonValue | undefined) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/**
 * Whether the token expired before this component first rendered.
 *
 * `Date.now()` is captured once in state so render stays pure and the label does not flip on unrelated re-renders.
 */
function useExpired(expiresAt: string | null) {
  const [renderedAt] = useState(() => Date.now());
  return expiresAt ? new Date(expiresAt).getTime() < renderedAt : false;
}

/**
 * Shows who the current token belongs to, or how to sign in when there is none.
 *
 * Proxy sessions get their own read-only view because the reverse proxy, not this app, owns sign-in and sign-out.
 */
export function IdentityPanel(props: {
  config: PublicConfig;
  session: Session | null;
  whoami: WhoAmI | null;
  onChanged: () => Promise<void>;
}) {
  if (props.session?.source === 'proxy') {
    return <ProxyIdentity session={props.session} whoami={props.whoami} />;
  }
  return props.session ? <SignedIn {...props} session={props.session} /> : <SignInPanel {...props} />;
}

/**
 * Shows an OIDC or pasted-token session: who it is, what Postgres makes of it, the decoded claims and header, and a sign-out button.
 */
function SignedIn({
  session,
  whoami,
  onChanged,
}: {
  session: Session;
  whoami: WhoAmI | null;
  onChanged: () => Promise<void>;
}) {
  const expired = useExpired(session.expiresAt);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Identity</h2>
        <span className="tag">{session.source}</span>
      </header>
      <div className="panel-body">
        <Who session={session} whoami={whoami} />

        <SeenByPostgres whoami={whoami} />

        <h3>
          Token claims
          {session.expiresAt && (
            <span className={expired ? 'error small' : 'muted small'}>
              {expired ? ' expired ' : ' expires '}
              {new Date(session.expiresAt).toLocaleString()}
            </span>
          )}
        </h3>
        <Json value={session.claims ?? {}} />
        <details>
          <summary>Header</summary>
          <Json value={session.header} />
        </details>
        <details>
          <summary>Raw token</summary>
          <textarea className="raw" readOnly rows={5} value={session.token} />
        </details>

        <button
          className="btn"
          onClick={async () => {
            await signOut();
            await onChanged();
          }}
        >
          Sign out
        </button>
      </div>
    </section>
  );
}

/**
 * Names the signed-in user from the friendliest claim available, falling back to the proxy's user header, and flags admins.
 */
function Who({ session, whoami }: { session: Session; whoami: WhoAmI | null }) {
  const claims = session.claims ?? {};
  const name = claimText(claims.name) || claimText(claims.email) || claimText(claims.sub) || 'unknown';
  const email = claimText(claims.email) || session.proxy?.user || '';
  return (
    <div className="who">
      <div className="avatar">{name.slice(0, 1)}</div>
      <div>
        <div className="who-name">{name}</div>
        <div className="muted small">{email}</div>
      </div>
      {whoami?.is_admin && <span className="badge admin">ADMIN</span>}
    </div>
  );
}

/**
 * Shows the role, uid, email, and admin flag Postgres derived from the token via `/rpc/whoami`, which is what row level security actually uses.
 *
 * A missing `whoami` means PostgREST refused the token, so the failing call in the request log holds the reason.
 */
function SeenByPostgres({ whoami }: { whoami: WhoAmI | null }) {
  return (
    <>
      <h3>As seen by Postgres</h3>
      {whoami ? (
        <dl className="kv">
          <dt>current_user</dt>
          <dd>
            <code>{whoami.role}</code>
          </dd>
          <dt>timeoff.uid()</dt>
          <dd>
            <code>{whoami.uid ?? 'null'}</code>
          </dd>
          <dt>timeoff.email()</dt>
          <dd>
            <code>{whoami.email ?? 'null'}</code>
          </dd>
          <dt>timeoff.is_admin()</dt>
          <dd>
            <code className={whoami.is_admin ? 'yes' : 'no'}>{String(whoami.is_admin)}</code>
          </dd>
        </dl>
      ) : (
        <p className="error small">PostgREST rejected this token. See the request log.</p>
      )}
    </>
  );
}

/**
 * Shows a session supplied by an authenticating reverse proxy, with the token details behind a View token dialog.
 *
 * There is no sign-in or sign-out here: the proxy owns the session and sends its token on every request.
 */
function ProxyIdentity({ session, whoami }: { session: Session; whoami: WhoAmI | null }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Identity</h2>
        <span className="tag">reverse proxy</span>
      </header>
      <div className="panel-body">
        <Who session={session} whoami={whoami} />
        <p className="muted small proxy-note">
          Signed in through the reverse proxy
          {session.proxy?.user && (
            <>
              {' '}
              as <strong>{session.proxy.user}</strong>
            </>
          )}
          . Its token is sent to PostgREST as-is.
        </p>
        <SeenByPostgres whoami={whoami} />
        <button className="btn" onClick={() => setOpen(true)}>
          View token
        </button>
      </div>
      {open && <TokenModal session={session} onClose={() => setOpen(false)} />}
    </section>
  );
}

/**
 * Shows the proxy's token in full: expiry, claims, header, the forwarded proxy headers, and the raw token with a copy button.
 *
 * The footer's Close button carries `data-autofocus`, so `Modal` focuses it once `showModal()` has opened the dialog.
 */
function TokenModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const expired = useExpired(session.expiresAt);
  const { copied, copy } = useCopy();

  return (
    <Modal title="Token from the reverse proxy" onClose={onClose} wide>
      <div className="modal-body token-details">
        {session.expiresAt && (
          <p className={expired ? 'error small' : 'muted small'}>
            {expired ? 'Expired ' : 'Expires '}
            {new Date(session.expiresAt).toLocaleString()}
          </p>
        )}
        <h3>Claims</h3>
        <Json value={session.claims ?? {}} />
        <h3>Header</h3>
        <Json value={session.header} />
        {session.proxy && Object.keys(session.proxy.headers).length > 0 && (
          <>
            <h3>Proxy headers</h3>
            <Json value={session.proxy.headers} />
          </>
        )}
        <h3>Raw token</h3>
        <textarea className="raw" readOnly rows={5} value={session.token} />
      </div>
      <footer className="modal-foot">
        <button type="button" className="btn" onClick={() => void copy('token', session.token)}>
          {copied === 'token' ? 'Copied' : 'Copy token'}
        </button>
        <button type="button" className="btn primary" data-autofocus onClick={onClose}>
          Close
        </button>
      </footer>
    </Modal>
  );
}

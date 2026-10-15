import type { AdminRule } from '#/lib/types';

/**
 * Lists the admin rules from `/admin_rules`, highlighting the ones the current token matches.
 *
 * The view returns no rows to non-admins, so the debugger renders this panel for admins only. Matching any enabled rule is what makes `timeoff.is_admin()` true.
 */
export function AdminRulesPanel({ rules }: { rules: AdminRule[] }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Admin rules</h2>
        <span className="muted small">GET /admin_rules</span>
      </header>
      <div className="panel-body">
        <p className="muted small">
          Matching any enabled rule makes you an admin. Rules from <code>.env</code> are re-applied on every{' '}
          <code>pnpm infra:up</code>.
        </p>
        <ul className="rules">
          {rules.map((r) => (
            <li key={r.id} className={r.matches_me ? 'match' : ''}>
              <code>{r.claim}</code> <span className="op">{r.operator.replace('_', ' ')}</span> <code>{r.value}</code>
              <div className="muted small">
                {r.source}
                {r.description ? ` · ${r.description}` : ''}
                {r.require_email_verified ? ' · verified email only' : ''}
                {!r.enabled ? ' · disabled' : ''}
                {r.matches_me ? ' · matches you' : ''}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

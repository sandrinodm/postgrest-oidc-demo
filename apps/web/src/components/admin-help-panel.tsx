import type { AdminCriteria } from '#/lib/types';

/**
 * Explains, for users who are not admins, which token claims would make them one under the configured admin rules.
 *
 * The rules come from the `ADMIN_*` settings, because `/admin_rules` returns no rows to non-admins; rules added directly in the database are not listed.
 */
export function AdminHelpPanel({ criteria, isTestServer }: { criteria: AdminCriteria; isTestServer: boolean }) {
  const rules = [
    ...criteria.emails.map((email) => (
      <>
        your email is <code>{email}</code>
      </>
    )),
    ...criteria.domains.map((domain) => (
      <>
        your email ends with <code>@{domain}</code>
      </>
    )),
    ...criteria.groups.map((group) => (
      <>
        your <code>{criteria.groupsClaim}</code> claim contains <code>{group}</code>
      </>
    )),
    ...criteria.claimRules.map((rule) => (
      <>
        claim <code>{rule.claim}</code> {rule.operator.replace('_', ' ')} <code>{rule.value}</code>
      </>
    )),
  ];

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>How to become an admin</h2>
      </header>
      <div className="panel-body admin-help">
        <p>Admins can see and delete everyone's time off. You are one when your token matches any of these rules:</p>
        {rules.length > 0 ? (
          <ul>
            {rules.map((rule, i) => (
              <li key={i}>{rule}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No admin rules are configured.</p>
        )}
        {isTestServer && (
          <p className="small">
            With the local test server, sign in as <strong>Dave</strong> or <strong>Ada</strong>.
          </p>
        )}
        <p className="muted small">
          Set by the <code>ADMIN_*</code> variables in <code>infra/docker/.env</code> and applied on{' '}
          <code>pnpm infra:up</code>. Rules added directly in the database count too.
        </p>
      </div>
    </section>
  );
}

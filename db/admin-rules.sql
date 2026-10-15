-- Rewrites the setup-managed admin rules (source = 'env'). Rules added by
-- hand (source = 'manual') are left alone.
--
-- psql variables (set by scripts/setup-database.sh), all optional:
--   admin_emails             comma separated, exact match on $.email
--   admin_email_domains      comma separated, $.email ends with "@<domain>"
--   admin_groups             comma separated, any value of admin_groups_claim
--   admin_groups_claim       JSON path to the groups claim (default $.groups)
--   admin_claim_rules        "<jsonpath>|<operator>|<value>", separated by ";"
--   admin_require_email_verified  true: email rules need email_verified=true

\if :{?admin_emails}
\else
  \set admin_emails ''
\endif
\if :{?admin_email_domains}
\else
  \set admin_email_domains ''
\endif
\if :{?admin_groups}
\else
  \set admin_groups ''
\endif
\if :{?admin_groups_claim}
\else
  \set admin_groups_claim '$.groups'
\endif
\if :{?admin_claim_rules}
\else
  \set admin_claim_rules ''
\endif
\if :{?admin_require_email_verified}
\else
  \set admin_require_email_verified false
\endif

delete from timeoff.admin_rules where source = 'env';

insert into timeoff.admin_rules (claim, operator, value, require_email_verified, source, description)
select '$.email', 'equals', trim(v), :'admin_require_email_verified'::boolean, 'env', 'ADMIN_EMAILS'
from unnest(string_to_array(:'admin_emails', ',')) as v
where trim(v) <> '';

insert into timeoff.admin_rules (claim, operator, value, require_email_verified, source, description)
select '$.email', 'ends_with', '@' || ltrim(trim(v), '@'), :'admin_require_email_verified'::boolean, 'env', 'ADMIN_EMAIL_DOMAINS'
from unnest(string_to_array(:'admin_email_domains', ',')) as v
where trim(v) <> '';

insert into timeoff.admin_rules (claim, operator, value, source, description)
select (:'admin_groups_claim')::jsonpath, 'equals', trim(v), 'env', 'ADMIN_GROUPS'
from unnest(string_to_array(:'admin_groups', ',')) as v
where trim(v) <> '';

insert into timeoff.admin_rules (claim, operator, value, source, description)
select trim(split_part(rule, '|', 1))::jsonpath,
       trim(split_part(rule, '|', 2))::timeoff.rule_operator,
       split_part(rule, '|', 3),
       'env',
       'ADMIN_CLAIM_RULES'
from unnest(string_to_array(:'admin_claim_rules', ';')) as rule
where trim(rule) <> '';

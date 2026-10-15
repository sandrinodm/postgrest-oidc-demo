#!/usr/bin/env bash
# Sets up, or updates, the time-off tables in Postgres: the schema with row
# level security and helper functions, plus (optionally) the admin rules and
# sample data. Creates no roles or users: it uses the PostgREST roles that are
# already there (from scripts/setup-postgrest.sh, or an existing PostgREST).
# Safe to run again; it keeps your data and updates everything else in place.
#
# Interactive (asks for the connection string and settings):
#   ./scripts/setup-database.sh
#   ./scripts/setup-database.sh --schema-only   tables, RLS and functions only;
#                                                admin rules and data untouched
#
# Non-interactive (CI, Docker): pass --yes and set:
#   DATABASE_URL                  connection string of a user with CREATE on the
#                                 database (or on its public schema)
#   ANON_ROLE                     PostgREST's anonymous role (default anon); it gets
#                                 no access to the tables
#   AUTHENTICATED_ROLE            role for signed-in requests (default
#                                 authenticated); must differ from ANON_ROLE
#   ALLOW_SHARED_ROLE             true: allow AUTHENTICATED_ROLE = ANON_ROLE, for a
#                                 managed PostgREST whose tokens can't carry a `role`
#                                 claim. Requests without a verified identity are
#                                 still rejected, but RLS becomes the only barrier.
#   ADMIN_EMAILS                  comma separated, exact match on $.email
#   ADMIN_EMAIL_DOMAINS           comma separated, $.email ends with @<domain>
#   ADMIN_GROUPS                  comma separated values of ADMIN_GROUPS_CLAIM
#   ADMIN_GROUPS_CLAIM            JSON path of the groups claim (default $.groups)
#   ADMIN_CLAIM_RULES             "<jsonpath>|<operator>|<value>", separated by ";"
#   ADMIN_REQUIRE_EMAIL_VERIFIED  true: email rules need email_verified=true
#   LOAD_SAMPLE_DATA              true: also load db/sample-data.sql (dev only)
#
# Requires psql 14 or newer.
set -euo pipefail

DB_DIR="$(cd "$(dirname "$0")/../db" && pwd)"
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
schema_only=false
parse_script_arg() { [[ "$1" == --schema-only ]] && schema_only=true; }
parse_common_args "$@"

connect "create schemas (CREATE on the database)"

# -----------------------------------------------------------------------------
# PostgREST roles: must exist; this script doesn't create them.
# -----------------------------------------------------------------------------

anon_role="${ANON_ROLE:-anon}"
authenticated_role="${AUTHENTICATED_ROLE:-authenticated}"
if ! role_exists "$anon_role" || ! role_exists "$authenticated_role"; then
  missing_hint="Run ./scripts/setup-postgrest.sh first (it also adds a signed-in role to an existing PostgREST), or set ANON_ROLE and AUTHENTICATED_ROLE."
  $interactive || die "role '$anon_role' or '$authenticated_role' doesn't exist. $missing_hint"
  echo
  echo "The roles '$anon_role' and/or '$authenticated_role' don't exist."
  echo "If PostgREST isn't set up here yet, or has no role for signed-in requests, stop and run"
  echo "./scripts/setup-postgrest.sh first. Otherwise, enter the roles it uses:"
  ask anon_role "Anonymous role (PostgREST's db-anon-role)" "$anon_role"
  ask authenticated_role "Role for signed-in requests" "$authenticated_role"
  role_exists "$anon_role" || die "role '$anon_role' doesn't exist. $missing_hint"
  role_exists "$authenticated_role" || die "role '$authenticated_role' doesn't exist. $missing_hint"
fi
shared_role=false
if [[ "$anon_role" == "$authenticated_role" ]]; then
  shared_role=true
  if ! is_true "${ALLOW_SHARED_ROLE:-}"; then
    $interactive || die "the anonymous and signed-in roles are both '$anon_role'. That gives the anonymous role table
       access (protected by row level security only). Set ALLOW_SHARED_ROLE=true if your PostgREST can't switch
       roles, e.g. a managed one whose tokens have no role claim."
    echo
    echo "Warning: anonymous and signed-in requests would share '$anon_role', so that role gets table access."
    echo "Requests without a verified identity still see and change nothing, but row level security becomes the"
    echo "only barrier. Only do this if your PostgREST can't switch roles (no role claim, no pre-request hook)."
    ask_yes_no "Share '$anon_role' for signed-in requests?" n || die "stopped; nothing changed"
  fi
fi

# -----------------------------------------------------------------------------
# Privileges and current state
# -----------------------------------------------------------------------------

# The tables go in public (the schema PostgREST exposes); helpers go in timeoff.
IFS="$SEP" read -r can_create installed <<<"$(query "
  select has_schema_privilege('public', 'CREATE')
         and (to_regnamespace('timeoff') is not null or has_database_privilege(current_database(), 'CREATE')),
         to_regclass('public.time_off_requests') is not null")"
[[ "$can_create" == t ]] || die "$admin_user needs CREATE on the public schema of $database (and on the database, to add the timeoff schema)"
[[ "$installed" == t ]] && echo "The time-off tables are already installed; they will be updated in place."

# -----------------------------------------------------------------------------
# Admin rules and sample data (skipped with --schema-only)
# -----------------------------------------------------------------------------

load_sample=false
if ! $schema_only; then
  current_rules=""
  if [[ "$installed" == t ]]; then
    current_rules="$(query "
      select coalesce(string_agg(value, ',' order by id) filter (where description = 'ADMIN_EMAILS'), ''),
             coalesce(string_agg(ltrim(value, '@'), ',' order by id) filter (where description = 'ADMIN_EMAIL_DOMAINS'), ''),
             coalesce(string_agg(value, ',' order by id) filter (where description = 'ADMIN_GROUPS'), ''),
             coalesce(min(claim::text) filter (where description = 'ADMIN_GROUPS'), ''),
             coalesce(string_agg(claim::text || '|' || operator || '|' || value, ';' order by id)
                        filter (where description = 'ADMIN_CLAIM_RULES'), ''),
             coalesce(bool_or(require_email_verified)::text, '')
      from timeoff.admin_rules where source = 'env'")"
  fi
  IFS="$SEP" read -r cur_emails cur_domains cur_groups cur_groups_claim cur_claim_rules cur_verified <<<"$current_rules" || true

  # Defaults: the variables above, otherwise what is installed now.
  admin_emails="${ADMIN_EMAILS-$cur_emails}"
  admin_domains="${ADMIN_EMAIL_DOMAINS-$cur_domains}"
  admin_groups="${ADMIN_GROUPS-$cur_groups}"
  admin_groups_claim="${ADMIN_GROUPS_CLAIM:-${cur_groups_claim:-\$.groups}}"
  admin_claim_rules="${ADMIN_CLAIM_RULES-$cur_claim_rules}"
  admin_verified="${ADMIN_REQUIRE_EMAIL_VERIFIED:-${cur_verified:-}}"
  is_true "${LOAD_SAMPLE_DATA:-}" && load_sample=true

  if $interactive; then
    echo
    echo "Who is an admin? Admins can see and delete everyone's time off."
    echo "Enter values separated by commas; leave a question empty to skip it."
    ask admin_emails "Admin emails" "$admin_emails"
    ask admin_domains "Admin email domains (e.g. acme.com)" "$admin_domains"
    ask admin_groups "Admin groups" "$admin_groups"
    [[ -n "$admin_groups" ]] && ask admin_groups_claim "Claim holding the groups (JSON path)" "$admin_groups_claim"
    ask admin_claim_rules "Other claim rules, as <jsonpath>|<operator>|<value>;..." "$admin_claim_rules"
    if [[ -n "$admin_emails$admin_domains" ]]; then
      default_verified=y
      [[ "$admin_verified" == false ]] && default_verified=n
      if ask_yes_no "Only trust emails the provider marked as verified (email_verified)?" "$default_verified"; then
        admin_verified=true
      else
        admin_verified=false
      fi
    fi
    if [[ -z "${LOAD_SAMPLE_DATA:-}" && "$installed" != t ]]; then
      ask_yes_no "Load sample time-off requests (development only)?" n && load_sample=true
    fi
  fi
  is_true "$admin_verified" && admin_verified=true || admin_verified=false
fi

# -----------------------------------------------------------------------------
# Confirm
# -----------------------------------------------------------------------------

echo
echo "$(bold "About to apply") to $database:"
echo "  tables & RLS   public, timeoff ($([[ "$installed" == t ]] && echo update || echo create))"
if $shared_role; then
  echo "  roles          $anon_role for anonymous AND signed-in requests (shared; RLS is the only barrier)"
else
  echo "  roles          $anon_role (anonymous, no access), $authenticated_role (signed in); not created or changed"
fi
if $schema_only; then
  echo "  admin rules    unchanged (--schema-only)"
else
  echo "  admin emails   ${admin_emails:--}"
  echo "  admin domains  ${admin_domains:--}"
  echo "  admin groups   ${admin_groups:--}$([[ -n "$admin_groups" ]] && echo " (claim $admin_groups_claim)")"
  echo "  other rules    ${admin_claim_rules:--}"
  echo "  verified only  $admin_verified"
  echo "  sample data    $load_sample"
fi
confirm_apply

# -----------------------------------------------------------------------------
# Apply, in one transaction.
# -----------------------------------------------------------------------------

{
  echo "set client_min_messages = warning;"
  echo "\\set anon_role $(psql_quote "$anon_role")"
  echo "\\set authenticated_role $(psql_quote "$authenticated_role")"
  echo "\\i $(psql_quote "$DB_DIR/schema.sql")"
  if ! $schema_only; then
    echo "\\set admin_emails $(psql_quote "$admin_emails")"
    echo "\\set admin_email_domains $(psql_quote "$admin_domains")"
    echo "\\set admin_groups $(psql_quote "$admin_groups")"
    echo "\\set admin_groups_claim $(psql_quote "$admin_groups_claim")"
    echo "\\set admin_claim_rules $(psql_quote "$admin_claim_rules")"
    echo "\\set admin_require_email_verified $admin_verified"
    echo "\\i $(psql_quote "$DB_DIR/admin-rules.sql")"
    $load_sample && echo "\\i $(psql_quote "$DB_DIR/sample-data.sql")"
  fi
  # Let a running PostgREST pick up the schema changes (and re-read its config).
  echo "notify pgrst, 'reload schema';"
  echo "notify pgrst, 'reload config';"
} | run_psql --single-transaction -f - || die "setup failed; nothing was changed"

echo
echo "$(bold "Done.") PostgREST needs:"
echo
echo "  PGRST_DB_SCHEMAS=public"
echo "  PGRST_DB_ANON_ROLE=$anon_role"
if $shared_role; then
  echo "  (no pre-request hook needed: every request runs as $anon_role; RLS tells users apart by the token's sub)"
else
  echo "  PGRST_DB_PRE_REQUEST=timeoff.pre_request"
  echo "      Only for tokens without a role claim (most OIDC tokens): it switches requests with a verified"
  echo "      subject to $authenticated_role. Not needed when your identity provider adds \"role\": \"$authenticated_role\""
  echo "      to tokens, which is how managed PostgREST services pick the role."
fi
echo "  PGRST_JWT_SECRET=<your OIDC provider's JWKS, see the README>"
echo "  PGRST_JWT_AUD=<the client id your tokens are issued for>"

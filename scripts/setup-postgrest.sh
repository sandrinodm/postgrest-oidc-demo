#!/usr/bin/env bash
# Creates the roles PostgREST needs: a login role PostgREST connects as
# (`authenticator`), an anonymous role for requests without a token (`anon`,
# which gets no access to the time-off tables), and a role for signed-in
# requests (`authenticated`). Safe to run again: existing roles are kept as
# they are and only missing ones are created, so it also works on a database
# that already has PostgREST, such as a managed PostgREST service.
#
# Interactive (asks for the connection string and a password):
#   ./scripts/setup-postgrest.sh
#
# Existing PostgREST (keeps its roles, only adds `authenticated`):
#   AUTHENTICATOR_ROLE=postgrest_authenticator ANON_ROLE=web_anon ./scripts/setup-postgrest.sh
#
# Non-interactive (CI, Docker): pass --yes and set:
#   DATABASE_URL            connection string of a user with CREATEROLE (or a
#                           superuser)
#   AUTHENTICATOR_ROLE      PostgREST's login role (default authenticator)
#   ANON_ROLE               PostgREST's anonymous role (default anon)
#   AUTHENTICATED_ROLE      role for signed-in requests (default authenticated)
#   AUTHENTICATOR_PASSWORD  password for a new login role (generated when
#                           empty); for an existing one, empty keeps its password
#
# Requires psql 14 or newer.
set -euo pipefail

DB_DIR="$(cd "$(dirname "$0")/../db" && pwd)"
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
parse_common_args "$@"

authenticator_role="${AUTHENTICATOR_ROLE:-authenticator}"
anon_role="${ANON_ROLE:-anon}"
authenticated_role="${AUTHENTICATED_ROLE:-authenticated}"
[[ "$anon_role" != "$authenticated_role" ]] ||
  die "ANON_ROLE and AUTHENTICATED_ROLE must differ: the anonymous role gets no access to the tables"

connect "create roles (CREATEROLE)"

plan_for() { role_exists "$1" && echo "keep (exists)" || echo "create"; }

[[ "$(query "select rolsuper or rolcreaterole from pg_roles where rolname = current_user")" == t ]] ||
  die "$admin_user needs the CREATEROLE attribute (or superuser) to create roles"

authenticator_exists=f
role_exists "$authenticator_role" && authenticator_exists=t

password_generated=false
password="${AUTHENTICATOR_PASSWORD:-}"
if [[ -z "$password" ]] && $interactive; then
  echo
  if [[ "$authenticator_exists" == t ]]; then
    ask_secret password "New password for '$authenticator_role' (empty keeps the current one)"
  else
    ask_secret password "Password for the new '$authenticator_role' role (empty generates one)"
  fi
  if [[ -n "$password" ]]; then
    ask_secret confirm "Repeat the password"
    [[ "$confirm" == "$password" ]] || die "the passwords don't match"
  fi
fi
if [[ -z "$password" && "$authenticator_exists" != t ]]; then
  password="$(random_password)"
  password_generated=true
fi

if $password_generated; then authenticator_plan="create, with a generated password"
elif [[ "$authenticator_exists" != t ]]; then authenticator_plan="create"
elif [[ -n "$password" ]]; then authenticator_plan="keep, set a new password"
else authenticator_plan="keep as is"
fi

echo
echo "$(bold "About to apply") to $database:"
echo "  login role      $authenticator_role: $authenticator_plan"
echo "  anonymous role  $anon_role: $(plan_for "$anon_role"); no access to the tables"
echo "  signed-in role  $authenticated_role: $(plan_for "$authenticated_role")"
echo "  grants          $anon_role and $authenticated_role to $authenticator_role, so PostgREST can switch to them"
confirm_apply

# Values go in over stdin, so the password doesn't end up on the command line.
{
  echo "set client_min_messages = warning;"
  echo "\\set authenticator_role $(psql_quote "$authenticator_role")"
  echo "\\set anon_role $(psql_quote "$anon_role")"
  echo "\\set authenticated_role $(psql_quote "$authenticated_role")"
  [[ -n "$password" ]] && echo "\\set authenticator_password $(psql_quote "$password")"
  echo "\\i $(psql_quote "$DB_DIR/postgrest-roles.sql")"
} | run_psql --single-transaction -f - || die "setup failed; nothing was changed"

echo
echo "$(bold "Done.") Configure PostgREST with:"
echo
if $password_generated; then
  print_db_uri "$authenticator_role" "$(urlencode "$password")"
else
  print_db_uri "$authenticator_role" "<$authenticator_role password>"
fi
echo "  PGRST_DB_ANON_ROLE=$anon_role"
echo
echo "Signed-in requests run as $authenticated_role when the token has \"role\": \"$authenticated_role\","
echo "or, for tokens without a role claim, when PostgREST uses PGRST_DB_PRE_REQUEST=timeoff.pre_request."
echo
echo "Next, create the tables: ANON_ROLE=$anon_role AUTHENTICATED_ROLE=$authenticated_role ./scripts/setup-database.sh"
if $password_generated; then
  echo
  echo "The '$authenticator_role' password was generated and is shown only once. Store it in your secret manager."
fi

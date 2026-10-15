# Helpers shared by the setup scripts. Source it; don't run it.
#
# Callers run parse_common_args "$@" for --yes / --help handling; a script with
# flags of its own defines parse_script_arg first (see parse_common_args).

MIN_SERVER_VERSION=140000 # PostgREST 16 supports PostgreSQL 14+
SEP=$'\x1f'

interactive=true
[[ -t 0 ]] || interactive=false

bold() { if [[ -t 1 ]]; then printf '\033[1m%s\033[0m' "$*"; else printf '%s' "$*"; fi; }
die() { echo "error: $*" >&2; exit 1; }

# Prints the comment block at the top of the calling script (from line 2 up
# to the first line that isn't a comment).
usage() { awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"; }

# ask VAR "question" [default]
ask() {
  local __var=$1 question=$2 default=${3:-} answer
  [[ -n "$default" ]] && question+=" [$default]"
  read -r -p "$question: " answer </dev/tty
  printf -v "$__var" '%s' "${answer:-$default}"
}
# ask_secret VAR "question"
ask_secret() {
  local __var=$1 question=$2 answer
  read -r -s -p "$question: " answer </dev/tty
  echo >&2
  printf -v "$__var" '%s' "$answer"
}
# ask_yes_no "question" default(y|n) -> exit status
ask_yes_no() {
  local question=$1 default=$2 hint answer
  [[ "$default" == y ]] && hint="Y/n" || hint="y/N"
  read -r -p "$question [$hint]: " answer </dev/tty
  answer="$(tr '[:upper:]' '[:lower:]' <<<"${answer:-$default}")"
  [[ "$answer" == y || "$answer" == yes ]]
}
is_true() { [[ "$(tr '[:upper:]' '[:lower:]' <<<"${1:-}")" =~ ^(true|yes|y|1|on)$ ]]; }

# Quote a value for psql's \set ('' for a quote, \\ for a backslash).
psql_quote() {
  local v=${1//\\/\\\\}
  printf "'%s'" "${v//\'/\'\'}"
}
urlencode() {
  local s=$1 out='' c hex i
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case "$c" in
      [a-zA-Z0-9.~_-]) out+=$c ;;
      *) printf -v hex '%%%02X' "'$c"; out+=$hex ;;
    esac
  done
  printf '%s' "$out"
}
# Reads a fixed amount of randomness, so it doesn't depend on SIGPIPE to stop
# (some CI runners ignore it, which would make an endless pipe hang).
random_password() {
  local chars
  chars="$(head -c 1024 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  printf '%s' "${chars:0:32}"
}

run_psql() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
# query "sql" -> unaligned, fields separated by $SEP
query() { run_psql -At -F "$SEP" -c "$1"; }
# role_exists name -> exit status
role_exists() { [[ "$(query "select exists (select 1 from pg_roles where rolname = $(psql_quote "$1"))")" == t ]]; }

# Handles --yes and --help. Any other argument goes to the caller's
# parse_script_arg, if it defines one, which returns non-zero for arguments it
# doesn't know either.
parse_common_args() {
  for arg in "$@"; do
    case "$arg" in
      -y | --yes) interactive=false ;;
      -h | --help) usage; exit 0 ;;
      *)
        declare -F parse_script_arg >/dev/null && parse_script_arg "$arg" ||
          { echo "Unknown argument: $arg (see --help)" >&2; exit 2; }
        ;;
    esac
  done
}

# Asks before applying the plan the caller just printed; declining exits
# without changes. Non-interactive runs (--yes, no terminal) go ahead.
confirm_apply() {
  $interactive || return 0
  echo
  ask_yes_no "Apply?" n || { echo "Nothing changed."; exit 0; }
}

# Asks for (or reads) DATABASE_URL and checks the server. Sets server_version,
# database and admin_user.
connect() {
  local purpose=$1 info server_version_num
  command -v psql >/dev/null ||
    die "psql is not installed (macOS: brew install libpq; Debian/Ubuntu: apt install postgresql-client)"
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"

  DATABASE_URL="${DATABASE_URL:-}"
  if [[ -z "$DATABASE_URL" ]]; then
    $interactive || die "DATABASE_URL is not set"
    echo "Connection string of a user that can $purpose."
    echo "For example: postgres://admin:secret@db.example.com:5432/timeoff?sslmode=require"
    ask_secret DATABASE_URL "Connection string"
    [[ -n "$DATABASE_URL" ]] || die "no connection string given"
  fi

  info="$(query "select current_setting('server_version_num'), current_setting('server_version'),
                        current_database(), current_user")" ||
    die "could not connect with that connection string"
  IFS="$SEP" read -r server_version_num server_version database admin_user <<<"$info"

  echo "Connected to $(bold "$database") as $(bold "$admin_user") (PostgreSQL $server_version)."
  ((server_version_num >= MIN_SERVER_VERSION)) || die "PostgreSQL 14 or newer is required"
}

# Prints PGRST_DB_URI for the authenticator role, based on DATABASE_URL.
print_db_uri() {
  local role=$1 shown_password=$2 rest authority
  if [[ "$DATABASE_URL" =~ ^postgres(ql)?:// ]]; then
    rest="${DATABASE_URL#*://}"
    authority="${rest%%/*}"
    echo "  PGRST_DB_URI=postgres://${role}:${shown_password}@${authority##*@}${rest#"$authority"}"
  else
    echo "  PGRST_DB_URI=<your connection string, with user ${role} and password ${shown_password}>"
  fi
}

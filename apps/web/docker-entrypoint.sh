#!/bin/sh
# Checks the configuration before starting the app, so a missing setting stops
# the container with a clear message instead of failing on the first request.
set -eu

if [ -z "${POSTGREST_BASE_URI:-}" ]; then
  echo "error: POSTGREST_BASE_URI is not set. Set it to the base URI of your PostgREST API," >&2
  echo "       e.g. docker run -e POSTGREST_BASE_URI=https://postgrest.example.com ..." >&2
  exit 1
fi
case "$POSTGREST_BASE_URI" in
  http://*@* | https://*@*)
    # Credentials in the URI can't be used (fetch rejects them) and would end up in logs and on the page.
    echo "error: POSTGREST_BASE_URI must not contain a username or password; PostgREST authenticates" >&2
    echo "       each request with the user's JWT." >&2
    exit 1
    ;;
  http://* | https://*) ;;
  *)
    echo "error: POSTGREST_BASE_URI must start with http:// or https:// (got '$POSTGREST_BASE_URI')" >&2
    exit 1
    ;;
esac

echo "PostgREST: $POSTGREST_BASE_URI"
exec "$@"

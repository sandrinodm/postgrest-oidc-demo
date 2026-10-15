#!/usr/bin/env bash
# Creates or updates the Auth0 post-login Action that adds the user's roles to
# the id_token (add-roles-to-id-token.js), deploys it, and makes sure it is
# part of the login flow.
#
# Safe to re-run: the Action is found by name and updated in place, and it is
# only added to the post-login flow when it is not there yet. Other Actions in
# the flow are left exactly as they are.
#
# Requires the Auth0 CLI (logged in with `auth0 login`) and jq.
#
#   ./infra/auth0/setup-roles-action.sh
#   ./infra/auth0/setup-roles-action.sh --tenant acme.eu.auth0.com
set -euo pipefail

ACTION_NAME="${ACTION_NAME:-Add roles to ID token}"
TRIGGER=post-login
TRIGGER_VERSION=v3
RUNTIME=node22
CODE_FILE="$(dirname "$0")/add-roles-to-id-token.js"

for cmd in auth0 jq; do
  command -v "$cmd" >/dev/null || { echo "error: '$cmd' is not installed" >&2; exit 1; }
done

# Raw Management API calls through the CLI. Extra arguments (e.g. --tenant) are
# passed to every call.
EXTRA_ARGS=("$@")
# (The ${a[@]+...} form keeps bash 3.2 on macOS happy when there are none.)
mgmt() { auth0 api "$@" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} --no-input; }

code="$(cat "$CODE_FILE")"

# 1. Create the Action, or update the existing one with the same name.
id="$(mgmt get "actions/actions" -q "actionName=$ACTION_NAME" -q "triggerId=$TRIGGER" |
  jq -r --arg name "$ACTION_NAME" '[.actions[]? | select(.name == $name)][0].id // empty')"

if [[ -z "$id" ]]; then
  body="$(jq -n --arg name "$ACTION_NAME" --arg code "$code" --arg trigger "$TRIGGER" \
    --arg version "$TRIGGER_VERSION" --arg runtime "$RUNTIME" \
    '{name: $name, code: $code, runtime: $runtime, supported_triggers: [{id: $trigger, version: $version}]}')"
  id="$(mgmt post "actions/actions" --data "$body" | jq -r '.id')"
  echo "Created action \"$ACTION_NAME\" ($id)"
else
  body="$(jq -n --arg code "$code" --arg runtime "$RUNTIME" '{code: $code, runtime: $runtime}')"
  mgmt patch "actions/actions/$id" --data "$body" >/dev/null
  echo "Updated action \"$ACTION_NAME\" ($id)"
fi

# 2. Wait for Auth0 to build it; deploying before that fails.
status=""
for _ in $(seq 1 30); do
  status="$(mgmt get "actions/actions/$id" | jq -r '.status')"
  [[ "$status" == "built" ]] && break
  [[ "$status" == "failed" ]] && { echo "error: the action failed to build" >&2; exit 1; }
  sleep 2
done
[[ "$status" == "built" ]] || { echo "error: timed out waiting for the build (status: $status)" >&2; exit 1; }

# 3. Deploy. A bound Action always runs its latest deployed version.
mgmt post "actions/actions/$id/deploy" >/dev/null
echo "Deployed"

# 4. Add it to the post-login flow, keeping every existing binding (and their
#    order). Nothing to do when it is already there.
bindings="$(mgmt get "actions/triggers/$TRIGGER/bindings" -q "per_page=100")"
if jq -e --arg id "$id" 'any(.bindings[]?; .action.id == $id)' <<<"$bindings" >/dev/null; then
  echo "Already in the $TRIGGER flow; other Actions untouched"
else
  body="$(jq --arg id "$id" --arg name "$ACTION_NAME" '{
    bindings: (
      [.bindings[]? | {ref: {type: "action_id", value: .action.id}, display_name}]
      + [{ref: {type: "action_id", value: $id}, display_name: $name}]
    )
  }' <<<"$bindings")"
  mgmt patch "actions/triggers/$TRIGGER/bindings" --data "$body" >/dev/null
  echo "Added to the end of the $TRIGGER flow, after $(jq '[.bindings[]?] | length' <<<"$bindings") existing Action(s)"
fi

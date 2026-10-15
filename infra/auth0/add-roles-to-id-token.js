// Auth0 post-login Action: adds the user's Auth0 roles to the id_token, so the
// database's admin rules can match them. Deployed by setup-roles-action.sh.
//
// Custom claims should be namespaced with a URL. It does not have to exist;
// it only has to match ADMIN_GROUPS_CLAIM in infra/docker/.env:
//   ADMIN_GROUPS_CLAIM='$."https://timeoff.example/roles"'
exports.onExecutePostLogin = async (event, api) => {
  api.idToken.setCustomClaim('https://timeoff.example/roles', event.authorization?.roles ?? []);
};

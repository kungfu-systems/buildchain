export function webTokenConfig(env) {
  const client = Boolean(env.PRODUCTION_RELEASE_APP_CLIENT_ID);
  const key = env.PRODUCTION_RELEASE_APP_PRIVATE_KEY_PRESENT === "true";
  return {
    "app-token-status": client
      ? key
        ? "requested"
        : "missing-private-key"
      : key
        ? "missing-client-id"
        : "not-configured",
    "app-token-requested": String(client && key),
    "app-client-id-configured": String(client),
    "app-private-key-configured": String(key),
    "pr-token-configured": env.PRODUCTION_RELEASE_PR_TOKEN_PRESENT,
  };
}
export function webTokenSource(env) {
  let source = "github-token",
    status = env.APP_TOKEN_STATUS,
    unavailable = false;
  if (status === "requested") {
    if (
      env.APP_TOKEN_OUTCOME === "success" &&
      env.APP_TOKEN_PRESENT === "true"
    ) {
      source = "github-app";
      status = "available";
    } else {
      status = "create-failed";
      unavailable = true;
    }
  } else if (status !== "not-configured") unavailable = true;
  if (source === "github-token" && env.PR_TOKEN_CONFIGURED === "true")
    source = "production-release-pr-token";
  return {
    "token-source": source,
    "app-token-status": status,
    "app-token-unavailable": String(unavailable),
  };
}

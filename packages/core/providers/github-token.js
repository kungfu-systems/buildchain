export function admitGithubAccess({
  repository,
  organization = "",
  callerRepository,
  clientConfigured,
  appIdConfigured,
  privateKeyConfigured,
  failurePolicy,
}) {
  if (!["strict", "fallback"].includes(failurePolicy))
    throw new Error(
      "GitHub credential failure policy must be strict or fallback",
    );
  if (
    organization &&
    (repository || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(organization))
  )
    throw new Error(
      "Organization token scope requires exactly one organization and no repository",
    );
  const target = organization
    ? `${organization}/scope`
    : repository || callerRepository || "";
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(target);
  if (
    !match ||
    [".", ".."].includes(match[1]) ||
    [".", ".."].includes(match[2])
  )
    throw new Error("GitHub credential scope must be one owner/repository");
  if (clientConfigured && appIdConfigured)
    throw new Error("Provide either App client ID or App ID");
  const idConfigured = clientConfigured || appIdConfigured;
  if (failurePolicy === "strict" && idConfigured !== privateKeyConfigured)
    throw new Error("App identifier and private key must be provided together");
  return {
    repository: organization ? "" : target,
    owner: match[1],
    name: organization ? "" : match[2],
    requested: idConfigured && privateKeyConfigured,
  };
}

export function admitGithubAccessAction(core, env) {
  const scope = admitGithubAccess({
    repository: core.getInput("repository"),
    organization: core.getInput("organization"),
    callerRepository: env.GITHUB_REPOSITORY,
    clientConfigured: core.getInput("client-configured") === "true",
    appIdConfigured: core.getInput("app-id-configured") === "true",
    privateKeyConfigured: core.getInput("private-key-configured") === "true",
    failurePolicy: core.getInput("failure-policy"),
  });
  for (const [key, value] of Object.entries(scope))
    core.setOutput(key, String(value));
}

export function selectGithubToken({
  clientConfigured,
  privateKeyConfigured,
  appOutcome,
  appToken,
  fallbackToken,
  workflowToken,
  failurePolicy = "fallback",
}) {
  if (!["strict", "fallback"].includes(failurePolicy))
    throw new Error(
      "GitHub credential failure policy must be strict or fallback",
    );
  const requested = clientConfigured && privateKeyConfigured;
  const appStatus = requested
    ? appOutcome === "success" && appToken
      ? "available"
      : "create-failed"
    : clientConfigured
      ? "missing-private-key"
      : privateKeyConfigured
        ? "missing-client-id"
        : "not-configured";
  const source =
    appStatus === "available" ? "app" : fallbackToken ? "fallback" : "workflow";
  if (
    failurePolicy === "strict" &&
    !["available", "not-configured"].includes(appStatus)
  )
    throw new Error(`GitHub App credential unavailable: ${appStatus}`);
  return {
    token:
      source === "app"
        ? appToken
        : source === "fallback"
          ? fallbackToken
          : workflowToken,
    metadata: {
      source,
      appStatus,
      appUnavailable: !["available", "not-configured"].includes(appStatus),
      clientConfigured,
      privateKeyConfigured,
      fallbackConfigured: Boolean(fallbackToken),
    },
  };
}

export function selectGithubTokenAction(core) {
  const { token, metadata } = selectGithubToken({
    clientConfigured: core.getInput("client-configured") === "true",
    privateKeyConfigured: core.getInput("private-key-configured") === "true",
    appOutcome: core.getInput("app-outcome"),
    appToken: core.getInput("app-token"),
    fallbackToken: core.getInput("fallback-token"),
    workflowToken: core.getInput("workflow-token"),
    failurePolicy: core.getInput("failure-policy") || "fallback",
  });
  if (!token && core.getInput("require-token") === "true")
    throw new Error("A scoped GitHub credential is required");
  if (token) core.setSecret(token);
  core.setOutput("token", token || "");
  core.setOutput("metadata-json", JSON.stringify(metadata));
}

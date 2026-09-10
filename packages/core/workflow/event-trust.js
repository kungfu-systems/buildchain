export function admitWorkflowEvent({
  name,
  repository,
  headRepository,
  requireTrusted,
  untrustedPolicy,
}) {
  if (!["skip", "fail"].includes(untrustedPolicy))
    throw new Error("Unsupported untrusted event policy");
  const trusted =
    !requireTrusted || name !== "pull_request" || headRepository === repository;
  if (!trusted && untrustedPolicy === "fail")
    throw new Error("Untrusted pull request event is not admitted");
  return { trusted };
}
export function admitWorkflowEventAction(core, env) {
  const result = admitWorkflowEvent({
    name: env.GITHUB_EVENT_NAME,
    repository: env.GITHUB_REPOSITORY,
    headRepository: core.getInput("head-repository"),
    requireTrusted: core.getInput("require-trusted") === "true",
    untrustedPolicy: core.getInput("untrusted-policy"),
  });
  core.setOutput("trusted", String(result.trusted));
}

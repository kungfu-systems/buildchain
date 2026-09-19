import { getOctokit } from "@actions/github";
export function providerExecutionContext({ token, mutationToken, env }) {
  const apiUrl = env.GITHUB_API_URL || "https://api.github.com";
  return {
    token,
    mutationToken,
    apiUrl,
    actor: env.GITHUB_ACTOR,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    runtimeSelection: env.BUILDCHAIN_RUNTIME_SELECTION,
    octokit: token ? getOctokit(token, { baseUrl: apiUrl }) : undefined,
    mutationOctokit:
      mutationToken || token
        ? getOctokit(mutationToken || token, { baseUrl: apiUrl })
        : undefined,
  };
}

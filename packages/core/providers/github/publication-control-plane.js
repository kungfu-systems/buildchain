import { spawnSyncCommand } from "../../runtime/spawn-command.js";
const GITHUB_JSON_MAX_BUFFER = 16 * 1024 * 1024;
export function createPublicationControlPlaneReader(
  { token, publicReadToken = "", processEnvironment = process.env },
  execute = spawnSyncCommand,
) {
  if (!token)
    throw new Error(
      "Explicit publication control-plane read credential required",
    );
  const env = { ...processEnvironment, GH_TOKEN: token, GITHUB_TOKEN: token };
  function commandJson(
    command,
    args,
    label,
    { publicReadFallback = false } = {},
  ) {
    const options = {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: GITHUB_JSON_MAX_BUFFER,
    };
    let result = execute(command, args, { ...options, env });
    const fallbackToken = String(publicReadToken || "");
    const primaryToken = String(token || "");
    if (
      result.status !== 0 &&
      publicReadFallback &&
      fallbackToken &&
      fallbackToken !== primaryToken
    ) {
      result = execute(command, args, {
        ...options,
        env: { ...env, GH_TOKEN: fallbackToken, GITHUB_TOKEN: fallbackToken },
      });
    }
    if (result.status !== 0) {
      const category = /401|E401|unauthorized/i.test(result.stderr)
        ? "unauthorized"
        : "unavailable";
      throw new Error(
        `${label} is ${category}; publication control-plane audit fails closed`,
      );
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `${label} did not return JSON; publication control-plane audit fails closed`,
      );
    }
  }

  const githubJson = (apiPath, label, { publicReadFallback = false } = {}) =>
    commandJson(
      "gh",
      ["api", apiPath, "-H", "Accept: application/vnd.github+json"],
      label,
      { publicReadFallback },
    );

  const githubPublicJson = (apiPath, label) =>
    githubJson(apiPath, label, { publicReadFallback: true });

  function githubJsonOptional(
    apiPath,
    label,
    fallback,
    fallbackPattern = /404|not found/i,
  ) {
    const result = execute(
      "gh",
      ["api", apiPath, "-H", "Accept: application/vnd.github+json"],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: GITHUB_JSON_MAX_BUFFER,
        env,
      },
    );
    if (result.status !== 0) {
      if (fallbackPattern.test(`${result.stdout}\n${result.stderr}`))
        return fallback;
      const category = /401|403|unauthorized|forbidden/i.test(
        `${result.stdout}\n${result.stderr}`,
      )
        ? "unauthorized"
        : "unavailable";
      throw new Error(
        `${label} is ${category}; publication control-plane audit fails closed`,
      );
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `${label} did not return JSON; publication control-plane audit fails closed`,
      );
    }
  }

  const githubJsonReadLimited = (apiPath, label, fallback) =>
    githubJsonOptional(
      apiPath,
      label,
      fallback,
      /401|403|404|unauthorized|forbidden|not found/i,
    );

  return {
    githubJson,
    githubPublicJson,
    githubJsonOptional,
    githubJsonReadLimited,
  };
}

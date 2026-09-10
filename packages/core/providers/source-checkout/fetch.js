import { createCheckoutGitOperations } from "./git.js";
import { isolatedGitFetchEnv } from "./auth.js";
import { normalizeHistoryMode } from "./values.js";
export function fetchSourceCommit({
  targetPath,
  remoteName,
  remoteUrl,
  sha,
  fetchRef,
  sourceTreeSha = "",
  timeoutMs,
  env = {},
  historyMode = "shallow",
  allowFullFetchRetry = false,
  runGit,
  containsCommit,
  environment = process.env,
}) {
  const operations = createCheckoutGitOperations(environment);
  runGit ||= operations.git;
  containsCommit ||= operations.hasCommit;
  const { retryableGitFetchError } = operations;
  const normalizedHistoryMode = normalizeHistoryMode(historyMode);
  const fetchEnv = isolatedGitFetchEnv(env, targetPath);
  const fetch = (refspec) => {
    const options = { cwd: targetPath, timeoutMs, env: fetchEnv };
    const fetchArgs = ["fetch", "--no-tags"];
    if (normalizedHistoryMode === "shallow") fetchArgs.push("--depth=1");
    fetchArgs.push(remoteName, refspec);
    try {
      runGit(fetchArgs, options);
      return normalizedHistoryMode;
    } catch (error) {
      if (
        normalizedHistoryMode !== "shallow" ||
        !allowFullFetchRetry ||
        !/dumb http transport does not support shallow capabilities/i.test(
          String(error?.message || error || ""),
        )
      ) {
        throw error;
      }
      // Dumb HTTP mirrors are intentionally simple static cache endpoints.
      // Retry only that explicit capability mismatch without --depth; all
      // network fallbacks remain shallow and bounded by their own policy.
      runGit(["fetch", "--no-tags", remoteName, refspec], options);
      return "full";
    }
  };
  try {
    runGit(["remote", "remove", remoteName], {
      cwd: targetPath,
      timeoutMs,
      stdio: "ignore",
    });
  } catch {
    // The remote is optional; a fresh checkout target will not have it yet.
  }
  try {
    runGit(["remote", "add", remoteName, remoteUrl], {
      cwd: targetPath,
      timeoutMs,
    });
  } catch {
    runGit(["remote", "set-url", remoteName, remoteUrl], {
      cwd: targetPath,
      timeoutMs,
    });
  }

  if (fetchRef) {
    try {
      const fetchMode = fetch(`+${fetchRef}:refs/buildchain/source-ref`);
      if (containsCommit(targetPath, sha, timeoutMs)) {
        return { selector: "ref", checkoutSha: sha, fetchMode };
      }
      if (/^refs\/pull\/\d+\/merge$/.test(fetchRef) && sourceTreeSha) {
        const fetchedSha = runGit(
          ["rev-parse", "refs/buildchain/source-ref^{commit}"],
          {
            cwd: targetPath,
            timeoutMs,
          },
        );
        const fetchedTree = runGit(
          ["rev-parse", "refs/buildchain/source-ref^{tree}"],
          {
            cwd: targetPath,
            timeoutMs,
          },
        );
        if (fetchedTree === sourceTreeSha) {
          return { selector: "ref-tree", checkoutSha: fetchedSha, fetchMode };
        }
      }
    } catch (error) {
      // A retryable transport failure belongs to the bounded outer retry. Do
      // not immediately spend the same timeout again on an unadvertised SHA.
      if (retryableGitFetchError(error)) {
        throw error;
      }
    }
  }

  const fetchMode = fetch(`+${sha}:refs/buildchain/source`);
  if (!containsCommit(targetPath, sha, timeoutMs)) {
    throw new Error(`fetched ${fetchRef || sha}, but ${sha} is not available`);
  }
  return { selector: "sha", checkoutSha: sha, fetchMode };
}

export function runBoundedFetch({
  attempts = 1,
  fetch,
  onAttempt = () => {},
  onRetry = () => {},
  shouldRetry = () => true,
}) {
  const limit = Math.max(1, Math.floor(Number(attempts) || 1));
  let lastError;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    onAttempt({ attempt, limit });
    try {
      return { value: fetch({ attempt, limit }), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= limit || !shouldRetry(error)) {
        error.fetchAttempts = attempt;
        throw error;
      }
      onRetry({ attempt, limit, error });
    }
  }
  throw lastError;
}

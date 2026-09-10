import { setTimeout as delay } from "node:timers/promises";
const TRANSIENT_GITHUB_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const retryDelayMs = (attempt) => Math.min(1_000 * 2 ** (attempt - 1), 10_000);
export async function githubRequest(
  url,
  {
    token,
    method = "GET",
    body,
    fetchImpl = fetch,
    delayImpl = delay,
    maxAttempts = 5,
    warnImpl = console.warn,
  } = {},
) {
  const methodName = String(method).toUpperCase();
  const retrySafe = methodName === "GET";
  const requestedAttempts = Number(maxAttempts);
  const attemptLimit =
    retrySafe &&
    Number.isSafeInteger(requestedAttempts) &&
    requestedAttempts > 0
      ? requestedAttempts
      : 1;
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${url}`, {
        method: methodName,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "kungfu-buildchain-artifact-signing",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (retrySafe && attempt < attemptLimit) {
        warnImpl(
          `Buildchain signing authority: GitHub API GET transport failure; retry ${attempt + 1}/${attemptLimit}`,
        );
        await delayImpl(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
    if (!response.ok) {
      const text = await response.text();
      if (
        retrySafe &&
        TRANSIENT_GITHUB_STATUSES.has(response.status) &&
        attempt < attemptLimit
      ) {
        warnImpl(
          `Buildchain signing authority: GitHub API GET returned ${response.status}; retry ${attempt + 1}/${attemptLimit}`,
        );
        await delayImpl(retryDelayMs(attempt));
        continue;
      }
      throw new Error(
        `GitHub API ${methodName} ${url} failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch (error) {
      if (retrySafe && attempt < attemptLimit) {
        warnImpl(
          `Buildchain signing authority: GitHub API GET response failed to decode; retry ${attempt + 1}/${attemptLimit}`,
        );
        await delayImpl(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error("GitHub API retry loop exhausted");
}

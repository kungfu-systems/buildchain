function githubPayload(raw, requestPath, method) {
  const payload = raw ? JSON.parse(raw) : undefined;
  if (
    requestPath === "/graphql" &&
    Array.isArray(payload?.errors) &&
    payload.errors.length
  ) {
    const messages = payload.errors
      .map((error) => String(error?.message || "").trim())
      .filter(Boolean);
    throw new Error(
      `GitHub GraphQL ${method} ${requestPath} failed: ${messages.join("; ") || "unknown GraphQL error"}`,
    );
  }
  return payload;
}

export function githubJsonClient({
  token,
  userAgent,
  fetchImpl = globalThis.fetch,
  attempts = 1,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const headers = {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "user-agent": userAgent,
    "x-github-api-version": "2022-11-28",
  };
  return async function request(
    requestPath,
    { method = "GET", body, allow404 = false } = {},
  ) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const response = await fetchImpl(`https://api.github.com${requestPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      if (allow404 && response.status === 404) return undefined;
      if (response.ok) return githubPayload(raw, requestPath, method);
      const payload = raw ? JSON.parse(raw) : undefined;
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < attempts
      ) {
        const header = response.headers?.get?.("retry-after");
        const seconds = header == null ? Number.NaN : Number(header);
        await sleepImpl(
          Number.isFinite(seconds) && seconds >= 0
            ? Math.min(seconds * 1000, 10_000)
            : attempt * 250,
        );
        continue;
      }
      throw new Error(
        `GitHub API ${method} ${requestPath} failed with ${response.status}: ${payload?.message || raw}`,
      );
    }
    throw new Error(`GitHub API ${method} ${requestPath} exhausted retries`);
  };
}

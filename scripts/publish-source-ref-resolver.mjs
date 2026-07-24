const DEFAULT_GITHUB_API_URL = "https://api.github.com";

function readEnv(env, name, fallback = "") {
  return env[name] || fallback;
}

function assertGitSha(sha, label = "sourceSha") {
  const value = String(sha || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return value;
}

export function normalizeSourceRef(value, fallback = "") {
  return String(value || fallback || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
}

function splitRepository(repository) {
  const value = String(repository || "").trim();
  const match = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`BUILDCHAIN_SOURCE_REPOSITORY must be owner/repo, got: ${value || "<empty>"}`);
  }
  return { owner: match[1], repo: match[2] };
}

function encodeRefPath(ref) {
  return String(ref)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function sourceRefFromEnv(env = process.env) {
  const configured = normalizeSourceRef(readEnv(env, "BUILDCHAIN_PUBLISH_SOURCE_REF"));
  if (configured) {
    return configured;
  }
  const refName = normalizeSourceRef(readEnv(env, "GITHUB_REF_NAME"));
  if (refName.startsWith("publish-gate/") || refName === "major-gate") {
    return refName;
  }
  return "";
}

export function currentGitHubRefSha(sourceRef, env = process.env) {
  const ref = normalizeSourceRef(sourceRef);
  const githubRefName = normalizeSourceRef(readEnv(env, "GITHUB_REF_NAME"));
  const githubRef = String(readEnv(env, "GITHUB_REF")).trim();
  if (ref && ref === githubRefName && githubRef === `refs/heads/${ref}`) {
    return assertGitSha(readEnv(env, "GITHUB_SHA"), "GITHUB_SHA");
  }
  return "";
}

export async function resolveRemoteGitHubRefSha({
  repository,
  sourceRef,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const ref = normalizeSourceRef(sourceRef);
  if (!ref) {
    throw new Error("publish source ref is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required to resolve publish source ref through GitHub REST API");
  }

  const { owner, repo } = splitRepository(repository);
  const apiBase = String(readEnv(env, "GITHUB_API_URL", DEFAULT_GITHUB_API_URL)).replace(/\/+$/, "");
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeRefPath(ref)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "buildchain-publish-source-resolver",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = readEnv(env, "GITHUB_TOKEN");
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchImpl(url, { headers });
  if (!response?.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.message ? `: ${body.message}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`publish source ref not found: ${ref} (GitHub API ${response?.status || "unknown"}${detail})`);
  }
  const body = await response.json();
  return assertGitSha(body?.object?.sha, `GitHub ref ${ref} object.sha`);
}

export async function resolvePublishSourceRefSha({
  repository,
  sourceRef,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const currentSha = currentGitHubRefSha(sourceRef, env);
  if (currentSha) {
    return currentSha;
  }
  return await resolveRemoteGitHubRefSha({ repository, sourceRef, env, fetchImpl });
}

import { exactSha as exactLocalSha } from "../../dev-delivery/warrant/values.js";
export class GitHubTwoPhaseClient {
  constructor({
    repository,
    token,
    apiUrl = "https://api.github.com",
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!token) throw new Error("GITHUB_TOKEN is required");
    this.repository = repository;
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/u, "");
    this.fetch = fetchImpl;
  }

  async request(requestPath, { method = "GET", body } = {}) {
    const response = await this.fetch(`${this.apiUrl}${requestPath}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!response.ok) {
      const error = new Error(data?.message || `${requestPath} failed`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async baseSha(branch) {
    const data = await this.request(
      `/repos/${this.repository}/git/ref/heads/${branch
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
    return exactLocalSha(data?.object?.sha, "protected base SHA");
  }

  async exactPullRequestHead(pullRequestNumber, expectedHead) {
    const data = await this.request(
      `/repos/${this.repository}/pulls/${pullRequestNumber}`,
    );
    const observed = exactLocalSha(data?.head?.sha, "observed PR head");
    if (observed !== expectedHead)
      throw new Error(
        `semantic source head changed: ${observed} != ${expectedHead}`,
      );
    return observed;
  }

  async baseDelta(previousBase, currentBase) {
    if (previousBase === currentBase)
      return {
        graphKnown: true,
        attributionComplete: true,
        changedPaths: [],
        renames: [],
      };
    const data = await this.request(
      `/repos/${this.repository}/compare/${previousBase}...${currentBase}`,
    );
    return attributedGitHubBaseDelta(data, previousBase);
  }

  async wake(eventType, candidate) {
    await this.request(`/repos/${this.repository}/dispatches`, {
      method: "POST",
      body: { event_type: eventType, client_payload: { candidate } },
    });
  }
}

export function attributedGitHubBaseDelta(data, previousBase) {
  const files = Array.isArray(data?.files) ? data.files : [];
  const graphKnown =
    data?.status === "ahead" &&
    data?.merge_base_commit?.sha === previousBase &&
    files.length < 300;
  const renames = files
    .filter((entry) => entry.status === "renamed")
    .map((entry) => ({
      from: String(entry.previous_filename || ""),
      to: String(entry.filename || ""),
    }));
  const attributionComplete =
    graphKnown && renames.every((entry) => entry.from && entry.to);
  return {
    graphKnown,
    attributionComplete,
    changedPaths: attributionComplete
      ? [
          ...new Set(
            files
              .flatMap((entry) => [
                String(entry.filename || ""),
                String(entry.previous_filename || ""),
              ])
              .filter(Boolean),
          ),
        ].sort()
      : [],
    renames: attributionComplete ? renames : [],
  };
}

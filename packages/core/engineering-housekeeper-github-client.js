function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeRepository(value) {
  const normalized = requiredString(value?.fullName || value, "repository");
  const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match)
    throw new Error(`repository must be owner/repo, got: ${normalized}`);
  return { owner: match[1], repo: match[2], fullName: normalized };
}

function refPath(name) {
  return String(name)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function parseLinkHeader(value) {
  const links = {};
  for (const part of String(value || "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

function branchHeadOid(branch) {
  return String(
    branch?.commit?.sha || branch?.object?.sha || branch?.headOid || "",
  ).toLowerCase();
}

export class GitHubHousekeeperProviderError extends Error {
  constructor(message, { operation = "github", status = 0, cause } = {}) {
    super(message, { cause });
    this.name = "GitHubHousekeeperProviderError";
    this.operation = operation;
    this.status = status;
  }
}

function providerError(error, operation) {
  if (error instanceof GitHubHousekeeperProviderError) return error;
  return new GitHubHousekeeperProviderError(
    `${operation} failed: ${error?.message || String(error)}`,
    { operation, cause: error },
  );
}

export class GitHubHousekeeperClient {
  constructor({
    token,
    apiUrl = "https://api.github.com",
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is required");
    this.token = requiredString(token, "GitHub token");
    this.apiUrl = String(apiUrl).replace(/\/+$/, "");
    this.fetch = fetchImpl;
  }

  async request(method, requestPath, { body } = {}) {
    const url = requestPath.startsWith("http")
      ? requestPath
      : `${this.apiUrl}${requestPath}`;
    if (new URL(url).origin !== new URL(this.apiUrl).origin) {
      throw new GitHubHousekeeperProviderError(
        `GitHub pagination cannot leave API origin: ${new URL(url).origin}`,
        { operation: `${method} ${requestPath}` },
      );
    }
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw providerError(error, `${method} ${requestPath}`);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      throw new GitHubHousekeeperProviderError(
        `${method} ${requestPath} returned invalid JSON`,
        {
          operation: `${method} ${requestPath}`,
          status: response.status,
          cause: error,
        },
      );
    }
    if (!response.ok) {
      throw new GitHubHousekeeperProviderError(
        `${method} ${requestPath} failed with ${response.status}: ${data?.message || text}`,
        { operation: `${method} ${requestPath}`, status: response.status },
      );
    }
    return { data, response };
  }

  async paginate(requestPath, { maxPages = 1000 } = {}) {
    const items = [];
    const visited = new Set();
    let next = requestPath;
    while (next) {
      if (visited.has(next)) {
        throw new GitHubHousekeeperProviderError(
          "GitHub pagination cycle detected",
          { operation: `GET ${requestPath}` },
        );
      }
      if (visited.size >= maxPages) {
        throw new GitHubHousekeeperProviderError(
          `GitHub pagination exceeded ${maxPages} pages`,
          { operation: `GET ${requestPath}` },
        );
      }
      visited.add(next);
      const { data, response } = await this.request("GET", next);
      if (!Array.isArray(data)) {
        throw new GitHubHousekeeperProviderError(
          "GitHub paginated response must be an array",
          { operation: `GET ${next}` },
        );
      }
      items.push(...data);
      next = parseLinkHeader(response.headers.get("link")).next || "";
    }
    return items;
  }

  async getRepository(repository) {
    const coordinate = normalizeRepository(repository);
    return (
      await this.request("GET", `/repos/${coordinate.owner}/${coordinate.repo}`)
    ).data;
  }

  async listBranches(repository) {
    const coordinate = normalizeRepository(repository);
    return this.paginate(
      `/repos/${coordinate.owner}/${coordinate.repo}/branches?per_page=100`,
    );
  }

  async listOpenPullRequests(repository) {
    const coordinate = normalizeRepository(repository);
    return this.paginate(
      `/repos/${coordinate.owner}/${coordinate.repo}/pulls?state=open&sort=updated&direction=asc&per_page=100`,
    );
  }

  async listPullRequestsForCommit(repository, commitOid) {
    const coordinate = normalizeRepository(repository);
    return this.paginate(
      `/repos/${coordinate.owner}/${coordinate.repo}/commits/${encodeURIComponent(
        requiredString(commitOid, "commit OID"),
      )}/pulls?per_page=100`,
    );
  }

  async getBranch(repository, name) {
    const coordinate = normalizeRepository(repository);
    return (
      await this.request(
        "GET",
        `/repos/${coordinate.owner}/${coordinate.repo}/branches/${refPath(name)}`,
      )
    ).data;
  }

  async getPullRequest(repository, number) {
    const coordinate = normalizeRepository(repository);
    return (
      await this.request(
        "GET",
        `/repos/${coordinate.owner}/${coordinate.repo}/pulls/${number}`,
      )
    ).data;
  }

  async compareCommits(repository, baseOid, headOid) {
    const coordinate = normalizeRepository(repository);
    return (
      await this.request(
        "GET",
        `/repos/${coordinate.owner}/${coordinate.repo}/compare/${baseOid}...${headOid}`,
      )
    ).data;
  }

  async deleteBranch(repository, name, { expectedHeadOid } = {}) {
    const coordinate = normalizeRepository(repository);
    const currentHeadOid = branchHeadOid(
      await this.getBranch(coordinate.fullName, name),
    );
    if (!expectedHeadOid || currentHeadOid !== expectedHeadOid) {
      throw new GitHubHousekeeperProviderError(
        `branch ${name} changed before delete`,
        { operation: `delete-ref ${name}`, status: 409 },
      );
    }
    await this.request(
      "DELETE",
      `/repos/${coordinate.owner}/${coordinate.repo}/git/refs/heads/${refPath(name)}`,
    );
  }

  async addLabels(repository, number, labels) {
    const coordinate = normalizeRepository(repository);
    return (
      await this.request(
        "POST",
        `/repos/${coordinate.owner}/${coordinate.repo}/issues/${number}/labels`,
        { body: { labels } },
      )
    ).data;
  }
}

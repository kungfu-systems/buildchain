export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseLinkHeader(header) {
  const links = {};
  for (const part of String(header || "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

export class GitHubClient {
  constructor({
    token,
    repository,
    apiUrl = "https://api.github.com",
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!fetchImpl) throw new Error("fetch is required");
    if (!token) throw new Error("GITHUB_TOKEN is required");
    this.token = token;
    this.repository = repository;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
  }

  async request(
    method,
    requestPath,
    { body, accept = "application/vnd.github+json" } = {},
  ) {
    const url = requestPath.startsWith("http")
      ? requestPath
      : `${this.apiUrl}${requestPath}`;
    const response = await this.fetch(url, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = data?.message || text || `${method} ${url} failed`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return { data, response };
  }

  async paginate(requestPath) {
    let next = requestPath;
    const items = [];
    while (next) {
      const { data, response } = await this.request("GET", next);
      items.push(...data);
      next = parseLinkHeader(response.headers.get("link")).next;
    }
    return items;
  }

  async listPullRequests(base) {
    const query = new URLSearchParams({
      state: "open",
      base,
      sort: "updated",
      direction: "asc",
      per_page: "100",
    });
    return this.paginate(
      `/repos/${this.repository.owner}/${this.repository.repo}/pulls?${query}`,
    );
  }

  async getPullRequest(number, { attempts = 3, delayMs = 1000 } = {}) {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const { data } = await this.request(
        "GET",
        `/repos/${this.repository.owner}/${this.repository.repo}/pulls/${number}`,
      );
      last = data;
      if (data.mergeable !== null && data.mergeable !== undefined) return data;
      if (attempt < attempts) await delay(delayMs);
    }
    return last;
  }

  async listReviews(number) {
    return this.paginate(
      `/repos/${this.repository.owner}/${this.repository.repo}/pulls/${number}/reviews?per_page=100`,
    );
  }

  async listCommitChecks(sha) {
    if (!sha) return { statuses: [], checkRuns: [] };
    const [{ data: statusData }, { data: checkRunData }] = await Promise.all([
      this.request(
        "GET",
        `/repos/${this.repository.owner}/${this.repository.repo}/commits/${sha}/status`,
      ),
      this.request(
        "GET",
        `/repos/${this.repository.owner}/${this.repository.repo}/commits/${sha}/check-runs?per_page=100`,
      ),
    ]);
    return {
      statuses: statusData.statuses || [],
      checkRuns: checkRunData.check_runs || [],
    };
  }

  async mergePullRequest(number, { method, sha }) {
    const { data } = await this.request(
      "PUT",
      `/repos/${this.repository.owner}/${this.repository.repo}/pulls/${number}/merge`,
      {
        body: {
          merge_method: method,
          sha,
        },
      },
    );
    return data;
  }

  async getBranchSha(branch) {
    const ref = encodeURIComponent(`heads/${branch}`).replace(/%2F/g, "/");
    const { data } = await this.request(
      "GET",
      `/repos/${this.repository.owner}/${this.repository.repo}/git/ref/${ref}`,
    );
    return data.object?.sha || "";
  }

  async graphql(query, variables = {}) {
    const { data } = await this.request("POST", "/graphql", {
      body: { query, variables },
    });
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      const error = new Error(
        data.errors
          .map((entry) => entry.message)
          .filter(Boolean)
          .join("; ") || "GitHub GraphQL request failed",
      );
      error.data = data;
      throw error;
    }
    return data?.data || {};
  }

  async getMergeQueueState(branch) {
    const data = await this.graphql(
      `query BuildchainMergeQueueState($owner: String!, $repo: String!, $branch: String!) {
        repository(owner: $owner, name: $repo) {
          mergeQueue(branch: $branch) {
            id
            entries(first: 100) {
              nodes {
                id
                position
                state
                baseCommit { oid }
                headCommit { oid }
                pullRequest { number headRefOid }
              }
            }
          }
        }
      }`,
      {
        owner: this.repository.owner,
        repo: this.repository.repo,
        branch,
      },
    );
    const queue = data.repository?.mergeQueue || null;
    return {
      enabled: Boolean(queue),
      id: queue?.id || "",
      entries: (queue?.entries?.nodes || []).map((entry) => ({
        id: entry.id || "",
        position: entry.position,
        state: entry.state || "",
        pullRequestNumber: entry.pullRequest?.number || null,
        pullRequestHeadSha: entry.pullRequest?.headRefOid || "",
        baseSha: entry.baseCommit?.oid || "",
        headSha: entry.headCommit?.oid || "",
      })),
    };
  }

  async enqueuePullRequest({ pullRequestId, expectedHeadOid }) {
    const data = await this.graphql(
      `mutation BuildchainEnqueuePullRequest($input: EnqueuePullRequestInput!) {
        enqueuePullRequest(input: $input) {
          mergeQueueEntry {
            id
            position
            state
            baseCommit { oid }
            headCommit { oid }
            pullRequest { number headRefOid }
          }
        }
      }`,
      {
        input: {
          pullRequestId,
          expectedHeadOid,
        },
      },
    );
    const entry = data.enqueuePullRequest?.mergeQueueEntry;
    if (!entry?.id)
      throw new Error("GitHub did not return a merge queue entry");
    return {
      id: entry.id,
      position: entry.position,
      state: entry.state || "",
      pullRequestNumber: entry.pullRequest?.number || null,
      pullRequestHeadSha: entry.pullRequest?.headRefOid || "",
      baseSha: entry.baseCommit?.oid || "",
      headSha: entry.headCommit?.oid || "",
    };
  }

  async addLabels(number, labels) {
    const { data } = await this.request(
      "POST",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}/labels`,
      { body: { labels } },
    );
    return data;
  }
  async listIssueComments(number) {
    return this.paginate(
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}/comments?per_page=100`,
    );
  }
  async createIssueComment(number, body) {
    const { data } = await this.request(
      "POST",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}/comments`,
      { body: { body } },
    );
    return data;
  }
  async updateIssueComment(commentId, body) {
    const { data } = await this.request(
      "PATCH",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/comments/${commentId}`,
      { body: { body } },
    );
    return data;
  }
  async setCommitStatus(sha, { state, context, description, targetUrl = "" }) {
    const { data } = await this.request(
      "POST",
      `/repos/${this.repository.owner}/${this.repository.repo}/statuses/${sha}`,
      { body: { state, context, description, target_url: targetUrl } },
    );
    return data;
  }
}

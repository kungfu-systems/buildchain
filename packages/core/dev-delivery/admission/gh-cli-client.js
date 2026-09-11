import { spawnSync } from "node:child_process";
import { GitHubClient } from "./github-client.js";
export function ghEnvironment() {
  const environment = { ...process.env };
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  return environment;
}
export function ghAuthToken() {
  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    env: ghEnvironment(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim())
    throw new Error((result.stderr || "gh auth token failed").trim());
  return result.stdout.trim();
}
export function ghJson(args, { input } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    env: ghEnvironment(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(
      (result.stderr || result.stdout || "gh command failed").trim(),
    );
    error.status = result.status;
    throw error;
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
export class GhCliClient extends GitHubClient {
  constructor({ repository, token = "", fetchImpl = globalThis.fetch } = {}) {
    super({ token: token || ghAuthToken(), repository, fetchImpl });
  }
  async request(method, requestPath, { body } = {}) {
    const endpoint = requestPath.replace(/^https:\/\/api\.github\.com/, "");
    const args = ["api", "--method", method, endpoint];
    if (body !== undefined) args.push("--input", "-");
    return {
      data: ghJson(args, {
        input: body === undefined ? undefined : `${JSON.stringify(body)}\n`,
      }),
      response: { headers: { get: () => "" } },
    };
  }
  async paginate(requestPath) {
    return ghJson(["api", "--paginate", requestPath, "--slurp"]).flatMap(
      (page) => page,
    );
  }
  async getMergeQueueState(branch) {
    const query = `query($owner:String!,$repo:String!,$branch:String!){repository(owner:$owner,name:$repo){mergeQueue(branch:$branch){id entries(first:100){nodes{id position state baseCommit{oid} headCommit{oid} pullRequest{number headRefOid}}}}}}`;
    const data = ghJson([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${this.repository.owner}`,
      "-f",
      `repo=${this.repository.repo}`,
      "-f",
      `branch=${branch}`,
    ]).data;
    const queue = data?.repository?.mergeQueue || null;
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
    const query = `mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id position state baseCommit{oid} headCommit{oid} pullRequest{number headRefOid}}}}`;
    const data = ghJson([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `id=${pullRequestId}`,
      "-f",
      `head=${expectedHeadOid}`,
    ]).data;
    const entry = data?.enqueuePullRequest?.mergeQueueEntry;
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
}

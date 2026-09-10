import { ensureCandidateSourceLock } from "../../providers/github/source-lock.js";
import { githubJsonClient } from "../../providers/github/json-client.js";
import { text, repository, autoMergeMethod } from "./options.js";
function encodeRef(ref) {
  return ref.split("/").map(encodeURIComponent).join("/");
}

export function createGitHubStableCandidateClient({
  repository: repositoryInput,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const [owner, repo] = repository(repositoryInput).split("/");
  const api = githubJsonClient({
    token,
    fetchImpl,
    userAgent: "buildchain-stable-candidate-patrol",
  });
  return {
    async listReleases() {
      return api(`/repos/${owner}/${repo}/releases?per_page=100`);
    },
    async listAlphaTags(prefix) {
      const refs = await api(
        `/repos/${owner}/${repo}/git/matching-refs/tags/${encodeRef(`v${prefix}`)}`,
      );
      const candidates = [];
      for (const ref of refs) {
        const tag = text(ref.ref).replace(/^refs\/tags\//, "");
        const version = tag.replace(/^v/, "");
        if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)) continue;
        const candidateSha = await this.resolveTagSha(tag);
        const commit = await api(
          `/repos/${owner}/${repo}/commits/${candidateSha}`,
        );
        candidates.push({
          version,
          sha: candidateSha,
          publishedAt:
            commit.commit?.committer?.date || commit.commit?.author?.date,
          url: ref.url || "",
          actor: commit.committer?.login || commit.author?.login || "",
          releasePublished: false,
        });
      }
      return candidates;
    },
    async resolveTagSha(tag) {
      const ref = await api(
        `/repos/${owner}/${repo}/git/ref/tags/${encodeRef(tag)}`,
      );
      if (ref.object?.type !== "tag") return ref.object?.sha || "";
      const annotated = await api(
        `/repos/${owner}/${repo}/git/tags/${ref.object.sha}`,
      );
      return annotated.object?.sha || "";
    },
    async getCommitEvidence(candidateSha) {
      const [statuses, checks, workflows] = await Promise.all([
        api(
          `/repos/${owner}/${repo}/commits/${candidateSha}/statuses?per_page=100`,
        ),
        api(
          `/repos/${owner}/${repo}/commits/${candidateSha}/check-runs?per_page=100`,
        ),
        api(
          `/repos/${owner}/${repo}/actions/runs?head_sha=${candidateSha}&per_page=100`,
        ),
      ]);
      return {
        statuses,
        checkRuns: checks.check_runs || [],
        workflowRuns: workflows.workflow_runs || [],
      };
    },
    async readLedger(ref, filePath) {
      const value = await api(
        `/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
        { allow404: true },
      );
      if (!value) return undefined;
      return {
        ledger: JSON.parse(
          Buffer.from(value.content, "base64").toString("utf8"),
        ),
        sha: value.sha,
      };
    },
    async writeLedger(ref, filePath, ledger, existingSha) {
      const existingRef = await api(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`,
        { allow404: true },
      );
      if (!existingRef) {
        const metadata = await api(`/repos/${owner}/${repo}`);
        const base = await api(
          `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(metadata.default_branch)}`,
        );
        await api(`/repos/${owner}/${repo}/git/refs`, {
          method: "POST",
          body: { ref: `refs/heads/${ref}`, sha: base.object.sha },
        });
      }
      return api(`/repos/${owner}/${repo}/contents/${filePath}`, {
        method: "PUT",
        body: {
          message: "chore(buildchain): update stable candidate ledger",
          content: Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`).toString(
            "base64",
          ),
          branch: ref,
          ...(existingSha ? { sha: existingSha } : {}),
        },
      });
    },
    ensureBranch: (ref, candidateSha, targetRef) =>
      ensureCandidateSourceLock({
        api,
        owner,
        repo,
        ref,
        candidateSha,
        targetRef,
      }),
    async ensurePromotionPullRequest({ head, base, title, body }) {
      const open = await api(
        `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=20`,
      );
      return (
        open[0] ||
        api(`/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          body: { head, base, title, body },
        })
      );
    },
    async enableAutoMerge(pullRequest, mergeMethod) {
      const query = `mutation($id:ID!,$mergeMethod:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$mergeMethod}){pullRequest{url}}}`;
      return api("/graphql", {
        method: "POST",
        body: {
          query,
          variables: {
            id: pullRequest.node_id,
            mergeMethod: autoMergeMethod(mergeMethod).toUpperCase(),
          },
        },
      });
    },
    async setVariable(name, value) {
      const current = await api(
        `/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
        { allow404: true },
      );
      if (current) {
        return api(
          `/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
          {
            method: "PATCH",
            body: { name, value },
          },
        );
      }
      return api(`/repos/${owner}/${repo}/actions/variables`, {
        method: "POST",
        body: { name, value },
      });
    },
    async deleteVariable(name) {
      const current = await api(
        `/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
        { allow404: true },
      );
      if (!current) return undefined;
      return api(
        `/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
    },
  };
}

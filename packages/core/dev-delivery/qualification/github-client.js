import { ACTIVE_STATUSES, text, repository } from "./model.js";
function encodeRef(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}
export function createGitHubDevQualificationClient({
  repository: repositoryInput,
  token,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const [owner, repo] = repository(repositoryInput).split("/");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: token ? `Bearer ${token}` : undefined,
    "user-agent": "buildchain-dev-qualification-patrol",
    "x-github-api-version": "2022-11-28",
  };
  async function api(requestPath, { method = "GET", body } = {}) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetchImpl(`https://api.github.com${requestPath}`, {
        method,
        headers: Object.fromEntries(
          Object.entries(headers).filter(([, value]) => value),
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      const payload = raw ? JSON.parse(raw) : undefined;
      if (response.ok) return payload;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await sleepImpl(attempt * 250);
        continue;
      }
      throw new Error(
        `GitHub API ${method} ${requestPath} failed with ${response.status}: ${payload?.message || raw}`,
      );
    }
    throw new Error(`GitHub API ${method} ${requestPath} exhausted retries`);
  }
  async function paged(requestPath, key) {
    const rows = [];
    for (let page = 1; page <= 10; page += 1) {
      const separator = requestPath.includes("?") ? "&" : "?";
      const payload = await api(
        `${requestPath}${separator}per_page=100&page=${page}`,
      );
      const pageRows = key ? payload[key] || [] : payload;
      rows.push(...pageRows);
      if (pageRows.length < 100) return rows;
    }
    throw new Error(`${requestPath} history exceeds 1000 rows`);
  }
  return {
    async resolveBranch(ref) {
      const payload = await api(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`,
      );
      return text(payload.object?.sha);
    },
    async listWorkflowRuns(
      workflow,
      sourceBranch,
      { activeOnly = false } = {},
    ) {
      const query = sourceBranch ? `branch=${encodeRef(sourceBranch)}&` : "";
      const runs = await Promise.all(
        [...(activeOnly ? ACTIVE_STATUSES : [""])].map((status) =>
          paged(
            `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}${status ? `status=${status}` : ""}`,
            "workflow_runs",
          ),
        ),
      );
      return runs.flat();
    },
    async listRunJobs(runId, runAttempt) {
      return paged(
        `/repos/${owner}/${repo}/actions/runs/${Number(runId)}/attempts/${Number(runAttempt)}/jobs`,
        "jobs",
      );
    },
    async dispatchWorkflow(workflow, ref, inputs) {
      await api(
        `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
        {
          method: "POST",
          body: { ref, inputs },
        },
      );
      return {
        action: "dispatch",
        workflow,
        ref,
        sourceSha: inputs["source-sha"],
      };
    },
    async rerunFailedJobs(runId) {
      await api(
        `/repos/${owner}/${repo}/actions/runs/${Number(runId)}/rerun-failed-jobs`,
        {
          method: "POST",
        },
      );
      return { action: "rerun-failed-jobs", runId: Number(runId) };
    },
  };
}

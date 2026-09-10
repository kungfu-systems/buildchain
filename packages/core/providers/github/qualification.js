import { validatePublicBuildRun } from "../../release/qualification/public-build.js";
export function createGitHubQualificationClient({
  token,
  attestationToken = token,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const headersFor = (requestToken) => ({
    accept: "application/vnd.github+json",
    authorization: requestToken ? `Bearer ${requestToken}` : undefined,
    "user-agent": "buildchain-stable-candidate-qualification",
    "x-github-api-version": "2022-11-28",
  });
  async function api(
    requestPath,
    { method = "GET", body, requestToken = token } = {},
  ) {
    const response = await fetchImpl(`https://api.github.com${requestPath}`, {
      method,
      headers: Object.fromEntries(
        Object.entries(headersFor(requestToken)).filter(([, value]) => value),
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : undefined;
    if (!response.ok)
      throw new Error(
        `GitHub API ${method} ${requestPath} failed with ${response.status}: ${payload?.message || raw}`,
      );
    return payload;
  }
  const encodeRef = (ref) => ref.split("/").map(encodeURIComponent).join("/");
  async function resolveTagSha(repositoryName, tag) {
    const ref = await api(
      `/repos/${repositoryName}/git/ref/tags/${encodeRef(tag)}`,
    );
    if (ref.object?.type !== "tag") return ref.object?.sha || "";
    const annotated = await api(
      `/repos/${repositoryName}/git/tags/${ref.object.sha}`,
    );
    return annotated.object?.sha || "";
  }
  async function matchingRun(query) {
    const payload = await api(
      `/repos/${query.repository}/actions/workflows/${encodeURIComponent(query.workflowFile)}/runs?per_page=100`,
    );
    return (payload.workflow_runs || [])
      .filter(
        (run) =>
          ((!query.runName &&
            (!query.headSha || run.head_sha === query.headSha)) ||
            (query.runName &&
              (run.display_title === query.runName ||
                run.name === query.runName))) &&
          (!query.sourceSha || run.head_sha === query.sourceSha) &&
          (!query.notBefore ||
            String(run.created_at || "") >= query.notBefore) &&
          (!query.excludeRunId || String(run.id || "") !== query.excludeRunId),
      )
      .sort((left, right) =>
        String(right.created_at).localeCompare(String(left.created_at)),
      )[0];
  }
  return {
    async readPublicBuildRun(repositoryName, runId) {
      if (!/^[1-9][0-9]*$/u.test(String(runId)))
        throw new Error("source run ID must be a positive integer");
      const run = await api(`/repos/${repositoryName}/actions/runs/${runId}`);
      const workflow = await api(
        `/repos/${repositoryName}/actions/workflows/self-build-alpha-dogfood.yml`,
      );
      return validatePublicBuildRun(run, workflow, repositoryName);
    },
    async resolveAlphaRelease(
      repositoryName,
      candidateSha,
      { allowAncestor = false } = {},
    ) {
      const releases = (
        await api(`/repos/${repositoryName}/releases?per_page=100`)
      ).sort((left, right) =>
        right.tag_name.localeCompare(left.tag_name, "en", { numeric: true }),
      );
      for (const release of releases) {
        if (
          !release.prerelease ||
          !/^v\d+\.\d+\.\d+-alpha\.\d+$/.test(release.tag_name || "")
        )
          continue;
        const sha = await resolveTagSha(repositoryName, release.tag_name);
        if (
          sha !== candidateSha &&
          (!allowAncestor ||
            !["ahead", "identical"].includes(
              (
                await api(
                  `/repos/${repositoryName}/compare/${sha}...${candidateSha}`,
                )
              ).status,
            ))
        )
          continue;
        return {
          version: release.tag_name.slice(1),
          tag: release.tag_name,
          sha,
          releaseUrl: release.html_url,
        };
      }
      return undefined;
    },
    async defaultBranch(repositoryName) {
      return (await api(`/repos/${repositoryName}`)).default_branch;
    },
    async resolveCommitSha(repositoryName, ref) {
      return (
        (
          await api(
            `/repos/${repositoryName}/commits/${encodeURIComponent(ref)}`,
          )
        ).sha || ""
      );
    },
    findWorkflowRun: matchingRun,
    async dispatchWorkflow({
      repository: repositoryName,
      workflowFile,
      ref,
      inputs,
    }) {
      await api(
        `/repos/${repositoryName}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
        { method: "POST", body: { ref, inputs } },
      );
    },
    async waitForWorkflowRun(query) {
      let latest;
      for (let attempt = 0; attempt < query.attempts; attempt += 1) {
        latest = await matchingRun(query);
        if (latest?.status === "completed") return latest;
        await sleep(query.intervalMs);
      }
      return latest;
    },
    async findCommitStatus(repositoryName, sha, context) {
      const statuses = await api(
        `/repos/${repositoryName}/commits/${sha}/statuses?per_page=100`,
      );
      return statuses.find((entry) => entry.context === context);
    },
    async createCommitStatus({
      repository: repositoryName,
      sha,
      context,
      targetUrl,
      description,
    }) {
      const created = await api(`/repos/${repositoryName}/statuses/${sha}`, {
        method: "POST",
        requestToken: attestationToken,
        body: { state: "success", context, target_url: targetUrl, description },
      });
      const observed = await api(
        `/repos/${repositoryName}/commits/${sha}/statuses?per_page=100`,
      );
      const status = observed.find(
        (entry) =>
          entry.id === created.id &&
          entry.context === context &&
          entry.target_url === targetUrl &&
          entry.state === "success",
      );
      if (!status)
        throw new Error(
          "Qualification commit status was not confirmed by provider readback",
        );
      return status;
    },
  };
}

#!/usr/bin/env node

const DEFAULTS = {
  buildWorkflowFile: "build-surface-fixture.yml",
  buildWorkflowName: "Build Surface Fixture",
  canaryRepository: "kungfu-systems/site-libkungfu-dev",
  canaryWorkflowFile: "buildchain-stable-canary.yml",
  canaryWorkflowName: "Buildchain Stable Canary",
  canaryStatusContext: "buildchain-canary/site-libkungfu-dev",
  pollAttempts: 80,
  pollIntervalMs: 15_000,
};

function text(value = "") {
  return String(value ?? "").trim();
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function repository(value) {
  const normalized = text(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error(`repository must be owner/repo, got ${value || "<empty>"}`);
  }
  return normalized;
}

export function normalizeStableCandidateQualificationOptions(options = {}) {
  const candidateSha = text(options.candidateSha ?? process.env.BUILDCHAIN_QUALIFICATION_CANDIDATE_SHA);
  if (!/^[0-9a-f]{40}$/i.test(candidateSha)) {
    throw new Error(`candidate SHA must be 40 hexadecimal characters, got ${candidateSha || "<empty>"}`);
  }
  return {
    repository: repository(options.repository ?? process.env.BUILDCHAIN_QUALIFICATION_REPOSITORY ?? process.env.GITHUB_REPOSITORY),
    candidateSha,
    buildWorkflowFile: text(options.buildWorkflowFile ?? process.env.BUILDCHAIN_QUALIFICATION_BUILD_WORKFLOW_FILE) || DEFAULTS.buildWorkflowFile,
    buildWorkflowName: text(options.buildWorkflowName ?? process.env.BUILDCHAIN_QUALIFICATION_BUILD_WORKFLOW_NAME) || DEFAULTS.buildWorkflowName,
    canaryRepository: repository(options.canaryRepository ?? process.env.BUILDCHAIN_QUALIFICATION_CANARY_REPOSITORY ?? DEFAULTS.canaryRepository),
    canaryWorkflowFile: text(options.canaryWorkflowFile ?? process.env.BUILDCHAIN_QUALIFICATION_CANARY_WORKFLOW_FILE) || DEFAULTS.canaryWorkflowFile,
    canaryWorkflowName: text(options.canaryWorkflowName ?? process.env.BUILDCHAIN_QUALIFICATION_CANARY_WORKFLOW_NAME) || DEFAULTS.canaryWorkflowName,
    canaryStatusContext: text(options.canaryStatusContext ?? process.env.BUILDCHAIN_QUALIFICATION_CANARY_STATUS_CONTEXT) || DEFAULTS.canaryStatusContext,
    pollAttempts: integer(options.pollAttempts ?? process.env.BUILDCHAIN_QUALIFICATION_POLL_ATTEMPTS, DEFAULTS.pollAttempts),
    pollIntervalMs: integer(options.pollIntervalMs ?? process.env.BUILDCHAIN_QUALIFICATION_POLL_INTERVAL_MS, DEFAULTS.pollIntervalMs),
    dryRun: bool(options.dryRun ?? process.env.BUILDCHAIN_QUALIFICATION_DRY_RUN, false),
  };
}

function successful(run) {
  return run?.status === "completed" && run?.conclusion === "success";
}

function active(run) {
  return run && run.status !== "completed";
}

async function ensureWorkflowEvidence({ client, repository, workflowFile, workflowName, ref, headSha, runName, options }) {
  let run = await client.findWorkflowRun({ repository, workflowFile, workflowName, headSha, runName });
  if (successful(run)) return { state: "existing", run };

  if (!active(run)) {
    if (options.dryRun) return { state: "planned", run };
    await client.dispatchWorkflow({ repository, workflowFile, ref, inputs: runName ? { buildchain_ref: headSha } : {} });
  }

  if (options.dryRun) return { state: "waiting", run };
  run = await client.waitForWorkflowRun({
    repository,
    workflowFile,
    workflowName,
    headSha,
    runName,
    attempts: options.pollAttempts,
    intervalMs: options.pollIntervalMs,
  });
  if (!successful(run)) {
    throw new Error(`${repository} ${workflowName} did not succeed for ${headSha}: ${run?.conclusion || run?.status || "not-found"}`);
  }
  return { state: "produced", run };
}

export async function runStableCandidateQualification(optionsInput = {}, clientInput) {
  const options = normalizeStableCandidateQualificationOptions(optionsInput);
  const client = clientInput || createGitHubQualificationClient({ token: process.env.GITHUB_TOKEN });
  const candidate = await client.resolveExactAlpha(options.repository, options.candidateSha);
  if (!candidate) {
    return { schemaVersion: 1, contract: "kungfu-buildchain-stable-candidate-qualification", status: "skipped", reason: "exact-alpha-release-not-found", candidateSha: options.candidateSha };
  }

  const build = await ensureWorkflowEvidence({
    client,
    repository: options.repository,
    workflowFile: options.buildWorkflowFile,
    workflowName: options.buildWorkflowName,
    ref: candidate.tag,
    headSha: options.candidateSha,
    runName: "",
    options,
  });

  let status = await client.findCommitStatus(options.repository, options.candidateSha, options.canaryStatusContext);
  let canary = { state: status?.state === "success" ? "existing" : "pending", run: undefined };
  if (status?.state !== "success") {
    const canaryDefaultBranch = await client.defaultBranch(options.canaryRepository);
    canary = await ensureWorkflowEvidence({
      client,
      repository: options.canaryRepository,
      workflowFile: options.canaryWorkflowFile,
      workflowName: options.canaryWorkflowName,
      ref: canaryDefaultBranch,
      headSha: options.candidateSha,
      runName: `${options.canaryWorkflowName} / ${options.candidateSha}`,
      options,
    });
    if (!options.dryRun) {
      status = await client.createCommitStatus({
        repository: options.repository,
        sha: options.candidateSha,
        context: options.canaryStatusContext,
        targetUrl: canary.run.html_url,
        description: `No-apply ${options.canaryRepository} canary passed`,
      });
    }
  }

  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-stable-candidate-qualification",
    status: options.dryRun ? "planned" : "qualified-evidence-ready",
    dryRun: options.dryRun,
    candidate,
    build: { state: build.state, url: build.run?.html_url || "" },
    canary: { state: canary.state, url: canary.run?.html_url || status?.target_url || "" },
    attestation: { context: options.canaryStatusContext, state: options.dryRun ? "planned" : status?.state || "" },
  };
}

export function createGitHubQualificationClient({
  token,
  attestationToken = process.env.BUILDCHAIN_QUALIFICATION_ATTESTATION_TOKEN || token,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const headersFor = (requestToken) => ({
    accept: "application/vnd.github+json",
    authorization: requestToken ? `Bearer ${requestToken}` : undefined,
    "user-agent": "buildchain-stable-candidate-qualification",
    "x-github-api-version": "2022-11-28",
  });
  async function api(requestPath, { method = "GET", body, requestToken = token } = {}) {
    const response = await fetchImpl(`https://api.github.com${requestPath}`, {
      method,
      headers: Object.fromEntries(Object.entries(headersFor(requestToken)).filter(([, value]) => value)),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : undefined;
    if (!response.ok) throw new Error(`GitHub API ${method} ${requestPath} failed with ${response.status}: ${payload?.message || raw}`);
    return payload;
  }
  const encodeRef = (ref) => ref.split("/").map(encodeURIComponent).join("/");
  async function resolveTagSha(repositoryName, tag) {
    const ref = await api(`/repos/${repositoryName}/git/ref/tags/${encodeRef(tag)}`);
    if (ref.object?.type !== "tag") return ref.object?.sha || "";
    const annotated = await api(`/repos/${repositoryName}/git/tags/${ref.object.sha}`);
    return annotated.object?.sha || "";
  }
  async function matchingRun(query) {
    const payload = await api(`/repos/${query.repository}/actions/workflows/${encodeURIComponent(query.workflowFile)}/runs?per_page=100`);
    return (payload.workflow_runs || [])
      .filter((run) => (!query.headSha || run.head_sha === query.headSha) && (!query.runName || run.display_title === query.runName || run.name === query.runName))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0];
  }
  return {
    async resolveExactAlpha(repositoryName, candidateSha) {
      const releases = await api(`/repos/${repositoryName}/releases?per_page=100`);
      for (const release of releases) {
        if (!release.prerelease || !/^v\d+\.\d+\.\d+-alpha\.\d+$/.test(release.tag_name || "")) continue;
        const sha = await resolveTagSha(repositoryName, release.tag_name);
        if (sha === candidateSha) return { version: release.tag_name.slice(1), tag: release.tag_name, sha, releaseUrl: release.html_url };
      }
      return undefined;
    },
    async defaultBranch(repositoryName) {
      return (await api(`/repos/${repositoryName}`)).default_branch;
    },
    findWorkflowRun: matchingRun,
    async dispatchWorkflow({ repository: repositoryName, workflowFile, ref, inputs }) {
      await api(`/repos/${repositoryName}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, { method: "POST", body: { ref, inputs } });
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
      const statuses = await api(`/repos/${repositoryName}/commits/${sha}/statuses?per_page=100`);
      return statuses.find((entry) => entry.context === context);
    },
    async createCommitStatus({ repository: repositoryName, sha, context, targetUrl, description }) {
      return api(`/repos/${repositoryName}/statuses/${sha}`, {
        method: "POST",
        requestToken: attestationToken,
        body: { state: "success", context, target_url: targetUrl, description },
      });
    },
  };
}

async function main() {
  const result = await runStableCandidateQualification();
  const output = `${JSON.stringify(result, null, 2)}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import("node:fs");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Stable candidate qualification\n\n\`\`\`json\n${output}\`\`\`\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

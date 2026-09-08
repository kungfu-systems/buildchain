import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubQualificationClient,
  normalizeStableCandidateQualificationOptions,
  resolveStableCandidateQualificationCandidate,
  runStableCandidateQualification,
  validatePublicBuildRun,
  qualifyPublicBuild,
} from "../scripts/stable-candidate-qualification.mjs";

const SHA = "a".repeat(40);
function publicBuild() {
  const repositoryName = "kungfu-systems/buildchain";
  const sourceRun = { id: 42, run_attempt: 1, head_sha: "b".repeat(40), workflow_id: 7,
    repository: { full_name: repositoryName }, head_repository: { full_name: repositoryName },
    status: "completed", conclusion: "success", name: "Buildchain Alpha Self-Dogfood",
    html_url: "https://github.com/kungfu-systems/buildchain/actions/runs/42" };
  const buildSummary = { contract: "kungfu-buildchain-build-summary", artifactName: "buildchain",
    git: { repository: repositoryName, sha: sourceRun.head_sha, runId: "42", runAttempt: "1" },
    runtime: { ref: "v4-alpha", workflowShellRef: "v4-alpha", sha: SHA, class: "alpha", override: false, trustDecision: "workflow-identity" },
    platformCount: 3, platforms: ["linux-x64", "macos", "windows-x64"].map((id) => ({ platform: { id },
      expectedArtifacts: { ok: true }, summary: { digest: "c".repeat(64) },
      observability: { lifecycle: { stages: Object.fromEntries(["install", "build", "verify"].map((stage) => [stage, { eventCount: 1 }])) } } })) };
  return { repositoryName, sourceRun, buildSummary };
}

test("public qualification binds source run, runtime identity, and all three lifecycle artifacts", () => {
  assert.equal(resolveStableCandidateQualificationCandidate(publicBuild()), SHA);
  for (const mutate of [
    (v) => { v.sourceRun.conclusion = "failure"; },
    (v) => { v.buildSummary.git.sha = SHA; },
    (v) => { v.buildSummary.git.runId = "43"; },
    (v) => { v.buildSummary.git.runAttempt = "2"; },
    (v) => { v.buildSummary.runtime.override = true; },
    (v) => { v.buildSummary.runtime.sha = ""; },
    (v) => { v.buildSummary.runtime.ref = "v4"; },
    (v) => { v.buildSummary.platforms.pop(); },
    (v) => { v.buildSummary.platforms[1].platform.id = "linux-x64"; },
    (v) => { v.buildSummary.platforms[0].expectedArtifacts.ok = false; },
    (v) => { delete v.buildSummary.platforms[0].observability.lifecycle.stages.verify; },
  ]) { const value = publicBuild(); mutate(value); assert.throws(() => resolveStableCandidateQualificationCandidate(value)); }
});

test("source run readback admits only the authoritative successful workflow in this repository", () => {
  const value = publicBuild();
  const workflow = { id: 7, path: ".github/workflows/self-build-alpha-dogfood.yml" };
  assert.equal(validatePublicBuildRun(value.sourceRun, workflow, value.repositoryName), value.sourceRun);
  assert.throws(() => validatePublicBuildRun(value.sourceRun, { ...workflow, id: 8 }, value.repositoryName));
  assert.throws(() => validatePublicBuildRun(value.sourceRun, { ...workflow, path: "another.yml" }, value.repositoryName));
  assert.throws(() => validatePublicBuildRun({ ...value.sourceRun, head_repository: { full_name: "fork/project" } }, workflow, value.repositoryName));
});

test("public qualification never dispatches a workflow or attests a substituted alpha ancestor", async () => {
  const client = fakeClient();
  client.resolveExactAlpha = async () => ({ sha: SHA, tag: "v4.0.9-alpha.1" });
  const result = await qualifyPublicBuild(publicBuild(), client);
  assert.equal(result.candidate.sha, SHA);
  assert.match(result.summaryRoot, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0][0], "status");
  assert.equal(client.calls[0][1].repository, "kungfu-systems/buildchain");
  assert.equal(client.calls[0][1].context, "buildchain-canary/buildchain-zero-input");
  client.calls.length = 0;
  client.resolveExactAlpha = async () => ({ sha: "c".repeat(40) });
  await assert.rejects(qualifyPublicBuild(publicBuild(), client), /never an ancestor/);
  assert.equal(client.calls.length, 0);
});

function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    calls,
    async resolveExactAlpha() { return { version: "2.12.1-alpha.5", tag: "v2.12.1-alpha.5", sha: SHA, releaseUrl: "https://example.test/release" }; },
    async findWorkflowRun({ repository }) {
      if (repository === "kungfu-systems/buildchain") return { status: "completed", conclusion: "success", html_url: "https://example.test/build" };
      return { status: "completed", conclusion: "success", html_url: "https://example.test/canary" };
    },
    async dispatchWorkflow(input) { calls.push(["dispatch", input]); },
    async waitForWorkflowRun() { throw new Error("unexpected wait"); },
    async defaultBranch() { return "dev/v2/v2.7"; },
    async resolveCommitSha() { return "b".repeat(40); },
    async findCommitStatus() { return undefined; },
    async createCommitStatus(input) { calls.push(["status", input]); return { state: "success", target_url: input.targetUrl }; },
    ...overrides,
  };
  return client;
}

test("normalizes exact-SHA qualification options", () => {
  const options = normalizeStableCandidateQualificationOptions({ repository: "kungfu-systems/buildchain", candidateSha: SHA });
  assert.equal(options.canaryRepository, "kungfu-systems/site-libkungfu-dev");
  assert.equal(options.canaryStatusContext, "buildchain-canary/site-libkungfu-dev");
  assert.equal(options.canaryRef, "");
  assert.equal(options.canarySha, "");
});

test("requires a safe canary ref bound to an immutable source SHA", () => {
  assert.throws(
    () => normalizeStableCandidateQualificationOptions({ repository: "kungfu-systems/buildchain", candidateSha: SHA, canaryRef: "evidence/canary" }),
    /canary ref and canary SHA must be provided together/,
  );
  assert.throws(
    () => normalizeStableCandidateQualificationOptions({ repository: "kungfu-systems/buildchain", candidateSha: SHA, canaryRef: "../main", canarySha: "b".repeat(40) }),
    /canary ref must be a safe branch or tag ref/,
  );
});

test("attests only after both exact candidate workflows succeed", async () => {
  const client = fakeClient();
  const result = await runStableCandidateQualification({ repository: "kungfu-systems/buildchain", candidateSha: SHA }, client);
  assert.equal(result.status, "qualified-evidence-ready");
  assert.deepEqual(client.calls, [["status", {
    repository: "kungfu-systems/buildchain",
    sha: SHA,
    context: "buildchain-canary/site-libkungfu-dev",
    targetUrl: "https://example.test/canary",
    description: "No-apply kungfu-systems/site-libkungfu-dev canary passed",
  }]]);
});

test("binds workflow and status evidence to the immutable alpha ancestor", async () => {
  const exactSha = "b".repeat(40);
  const client = fakeClient({
    async resolveExactAlpha() { return { version: "4.0.1-alpha.8", tag: "v4.0.1-alpha.8", sha: exactSha }; },
    async findWorkflowRun({ headSha }) { assert.equal(headSha, exactSha); return { status: "completed", conclusion: "success" }; },
    async findCommitStatus(_repository, sha) { assert.equal(sha, exactSha); return { state: "success" }; },
  });
  const result = await runStableCandidateQualification({ repository: "kungfu-systems/buildchain", candidateSha: SHA }, client);
  assert.equal(result.candidate.sha, exactSha);
});

test("reuses an existing success attestation without dispatching canary", async () => {
  const client = fakeClient({ async findCommitStatus() { return { state: "success", target_url: "https://example.test/existing" }; } });
  const result = await runStableCandidateQualification({ repository: "kungfu-systems/buildchain", candidateSha: SHA }, client);
  assert.equal(result.canary.state, "existing");
  assert.deepEqual(client.calls, []);
});

test("dispatches missing workflows at immutable refs and waits before attesting", async () => {
  let lookup = 0;
  const client = fakeClient({
    async findWorkflowRun() { lookup += 1; return lookup <= 2 ? undefined : { status: "completed", conclusion: "success", html_url: lookup === 3 ? "https://example.test/build" : "https://example.test/canary" }; },
    async waitForWorkflowRun({ repository }) { return { status: "completed", conclusion: "success", html_url: `https://example.test/${repository}` }; },
  });
  await runStableCandidateQualification({ repository: "kungfu-systems/buildchain", candidateSha: SHA }, client);
  assert.equal(client.calls[0][1].ref, "v2.12.1-alpha.5");
  assert.deepEqual(client.calls[0][1].inputs, {});
  assert.equal(client.calls[1][1].ref, "dev/v2/v2.7");
  assert.deepEqual(client.calls[1][1].inputs, { buildchain_ref: SHA });
  assert.equal(client.calls[2][0], "status");
});

test("waits for a run newer than the completed failure that triggered dispatch", async () => {
  const failedAt = "2026-07-30T04:50:00Z";
  const waits = [];
  const client = fakeClient({
    async findWorkflowRun({ repository }) {
      if (repository === "kungfu-systems/buildchain") {
        return { status: "completed", conclusion: "success", html_url: "https://example.test/build" };
      }
      return { id: 41, status: "completed", conclusion: "startup_failure", created_at: failedAt, html_url: "https://example.test/stale" };
    },
    async waitForWorkflowRun(input) {
      waits.push(input);
      return { id: 42, status: "completed", conclusion: "success", created_at: "2026-07-30T05:00:00Z", html_url: "https://example.test/current" };
    },
  });

  const result = await runStableCandidateQualification({ repository: "kungfu-systems/buildchain", candidateSha: SHA }, client);

  assert.equal(waits.length, 1);
  assert.equal(waits[0].notBefore, failedAt);
  assert.equal(waits[0].excludeRunId, "41");
  assert.equal(result.canary.url, "https://example.test/current");
  assert.equal(client.calls.find(([kind]) => kind === "status")[1].targetUrl, "https://example.test/current");
});

test("dispatches a bootstrap canary from an exact consumer commit", async () => {
  const canaryRef = "evidence/stable-canary";
  const canarySha = "b".repeat(40);
  let lookup = 0;
  const client = fakeClient({
    async findWorkflowRun() { lookup += 1; return lookup <= 2 ? undefined : { status: "completed", conclusion: "success", html_url: "https://example.test/run" }; },
    async waitForWorkflowRun() { return { status: "completed", conclusion: "success", html_url: "https://example.test/run" }; },
    async defaultBranch() { throw new Error("exact canary ref must not resolve the default branch"); },
  });
  const result = await runStableCandidateQualification({
    repository: "kungfu-systems/buildchain",
    candidateSha: SHA,
    canaryRef,
    canarySha,
  }, client);
  assert.equal(client.calls[1][1].ref, canaryRef);
  assert.deepEqual(client.calls[1][1].inputs, { buildchain_ref: SHA });
  assert.equal(result.canary.ref, canaryRef);
  assert.equal(result.canary.sha, canarySha);
});

test("fails closed when the dispatchable canary ref moved", async () => {
  const client = fakeClient({ async resolveCommitSha() { return "c".repeat(40); } });
  await assert.rejects(
    runStableCandidateQualification({
      repository: "kungfu-systems/buildchain",
      candidateSha: SHA,
      canaryRef: "evidence/stable-canary",
      canarySha: "b".repeat(40),
    }, client),
    /canary ref evidence\/stable-canary resolved to c{40}, expected b{40}/,
  );
  assert.equal(client.calls.some(([kind]) => kind === "status"), false);
});

test("fails closed when a required workflow does not succeed", async () => {
  const client = fakeClient({
    async findWorkflowRun() { return { status: "completed", conclusion: "failure", html_url: "https://example.test/failure" }; },
    async waitForWorkflowRun() { return { status: "completed", conclusion: "failure", html_url: "https://example.test/failure" }; },
  });
  await assert.rejects(
    runStableCandidateQualification({ repository: "kungfu-systems/buildchain", candidateSha: SHA }, client),
    /did not succeed/,
  );
  assert.equal(client.calls.some(([kind]) => kind === "status"), false);
});

test("non-alpha workflow deliveries are auditable no-ops", async () => {
  const client = fakeClient({ async resolveExactAlpha() { return undefined; } });
  const result = await runStableCandidateQualification({ repository: "kungfu-systems/buildchain", candidateSha: SHA }, client);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "exact-alpha-release-not-found");
});

test("cross-repository canary matching binds the candidate through the exact run name", async () => {
  const response = {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        workflow_runs: [{
          id: 42,
          head_sha: "b".repeat(40),
          display_title: `Buildchain Stable Canary / ${SHA}`,
          status: "completed",
          conclusion: "success",
          created_at: "2026-07-12T07:03:31Z",
        }],
      });
    },
  };
  const client = createGitHubQualificationClient({ token: "dispatch", fetchImpl: async () => response });
  const run = await client.findWorkflowRun({
    repository: "kungfu-systems/site-libkungfu-dev",
    workflowFile: "buildchain-stable-canary.yml",
    workflowName: "Buildchain Stable Canary",
    headSha: SHA,
    runName: `Buildchain Stable Canary / ${SHA}`,
    sourceSha: "b".repeat(40),
  });
  assert.equal(run.id, 42);
});

test("GitHub resolution selects the newest exact alpha ancestor and stops", async () => {
  const releaseSha = "b".repeat(40);
  const runtimeSha = "c".repeat(40);
  const paths = [];
  const releases = [
    { prerelease: true, tag_name: "v4.0.1-alpha.7" },
    { prerelease: true, tag_name: "v4.0.1-alpha.8", html_url: "https://example.test/8" },
  ];
  const client = createGitHubQualificationClient({
    token: "dispatch",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const path = parsed.pathname + parsed.search;
      paths.push(path);
      const payload = path.endsWith("/releases?per_page=100") ? releases
        : path.endsWith("/git/ref/tags/v4.0.1-alpha.8") ? { object: { type: "commit", sha: releaseSha } }
          : path.endsWith(`/compare/${releaseSha}...${runtimeSha}`) ? { status: "ahead", ahead_by: 2 }
            : assert.fail(`unexpected request ${path}`);
      return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
    },
  });

  const result = await client.resolveExactAlpha("kungfu-systems/buildchain", runtimeSha);
  assert.deepEqual(result, { version: "4.0.1-alpha.8", tag: "v4.0.1-alpha.8", sha: releaseSha, releaseUrl: "https://example.test/8" });
  assert.equal(paths.some((path) => path.includes("alpha.7")), false);
});

test("GitHub polling ignores stale completed runs until the dispatched run is visible", async () => {
  const stale = {
    id: 41,
    head_sha: "b".repeat(40),
    display_title: `Buildchain Stable Canary / ${SHA}`,
    status: "completed",
    conclusion: "startup_failure",
    created_at: "2026-07-30T04:50:00Z",
  };
  const current = {
    ...stale,
    id: 42,
    conclusion: "success",
  };
  let request = 0;
  const client = createGitHubQualificationClient({
    token: "dispatch",
    sleep: async () => {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        request += 1;
        return JSON.stringify({ workflow_runs: request === 1 ? [stale] : [current, stale] });
      },
    }),
  });

  const run = await client.waitForWorkflowRun({
    repository: "kungfu-systems/site-libkungfu-dev",
    workflowFile: "buildchain-stable-canary.yml",
    workflowName: "Buildchain Stable Canary",
    headSha: SHA,
    runName: `Buildchain Stable Canary / ${SHA}`,
    sourceSha: "b".repeat(40),
    notBefore: stale.created_at,
    excludeRunId: String(stale.id),
    attempts: 2,
    intervalMs: 0,
  });

  assert.equal(run.id, 42);
  assert.equal(request, 2);
});

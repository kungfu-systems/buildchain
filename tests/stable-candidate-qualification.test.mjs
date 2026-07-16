import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubQualificationClient,
  normalizeStableCandidateQualificationOptions,
  runStableCandidateQualification,
} from "../scripts/stable-candidate-qualification.mjs";

const SHA = "a".repeat(40);

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
});

test("requires an immutable canary source override", () => {
  assert.throws(
    () => normalizeStableCandidateQualificationOptions({ repository: "kungfu-systems/buildchain", candidateSha: SHA, canaryRef: "main" }),
    /canary ref must be an exact 40-character commit SHA/,
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

test("dispatches a bootstrap canary from an exact consumer commit", async () => {
  const canaryRef = "b".repeat(40);
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
  }, client);
  assert.equal(client.calls[1][1].ref, canaryRef);
  assert.deepEqual(client.calls[1][1].inputs, { buildchain_ref: SHA });
  assert.equal(result.canary.ref, canaryRef);
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
  });
  assert.equal(run.id, 42);
});

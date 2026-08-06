// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyRetryableFailure,
  runDevQualificationPatrol,
} from "../scripts/dev-qualification-patrol.mjs";

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const DEV = ".github/workflows/dev-verify-patrol.yml";
const PREFLIGHT = ".github/workflows/alpha-promotion-preflight.yml";
const BUILD = ".github/workflows/build.yml";

function run(overrides = {}) {
  return {
    id: 101,
    run_attempt: 1,
    path: DEV,
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    created_at: "2026-08-03T12:00:00Z",
    html_url: "https://example.invalid/runs/101",
    ...overrides,
  };
}

function fake({
  devRuns = [],
  preflightRuns = [run({ id: 50, path: PREFLIGHT })],
  priorityRuns = [],
  jobs = [],
} = {}) {
  const calls = [];
  return {
    calls,
    resolveBranch: async () => SHA,
    listWorkflowRuns: async (workflow) => {
      if (workflow === DEV) return devRuns;
      if (workflow === PREFLIGHT) return preflightRuns;
      return priorityRuns;
    },
    listRunJobs: async () => jobs,
    dispatchWorkflow: async (...args) => {
      calls.push(["dispatch", ...args]);
      return { action: "dispatch" };
    },
    rerunFailedJobs: async (runId) => {
      calls.push(["rerun", runId]);
      return { action: "rerun-failed-jobs", runId };
    },
  };
}

const options = {
  repository: "kungfu-systems/kungfu",
  sourceBranch: "dev/v4/v4.0",
  devWorkflowPath: DEV,
  preflightWorkflowPath: PREFLIGHT,
  priorityWorkflowPaths: [BUILD],
  dispatchInputs: { "buildchain-ref": "v3-alpha" },
  now: "2026-08-03T12:10:00Z",
};

test("dispatches exactly the latest preflight-qualified source", async () => {
  const client = fake();
  const result = await runDevQualificationPatrol(
    { ...options, mutationAuthorized: true },
    client,
  );
  assert.equal(result.state, "dispatch-ready");
  assert.equal(result.action, "dispatch");
  assert.deepEqual(client.calls, [
    [
      "dispatch",
      DEV,
      "dev/v4/v4.0",
      { "buildchain-ref": "v3-alpha", "source-sha": SHA },
    ],
  ]);
});

test("rapid merges coalesce behind one active run", async () => {
  const result = await runDevQualificationPatrol(
    options,
    fake({
      devRuns: [
        run({ head_sha: OLD_SHA, status: "in_progress", conclusion: null }),
      ],
    }),
  );
  assert.equal(result.state, "running");
  assert.equal(result.reason, "newer-source-coalesced");
  assert.equal(result.pendingSha, SHA);
});

test("duplicate wakeups are no-ops after exact-source success", async () => {
  const result = await runDevQualificationPatrol(
    options,
    fake({ devRuns: [run()] }),
  );
  assert.equal(result.state, "qualified");
  assert.equal(result.action, "none");
});

test("release-priority work defers dispatch", async () => {
  const result = await runDevQualificationPatrol(
    options,
    fake({
      priorityRuns: [
        run({ id: 700, path: BUILD, status: "queued", conclusion: null }),
      ],
    }),
  );
  assert.equal(result.state, "waiting-priority");
  assert.equal(result.pendingSha, SHA);
});

test("missing exact-source preflight fails closed", async () => {
  const result = await runDevQualificationPatrol(
    options,
    fake({ preflightRuns: [run({ path: PREFLIGHT, head_sha: OLD_SHA })] }),
  );
  assert.equal(result.state, "waiting-preflight");
  assert.equal(result.action, "none");
});

test("external setup failure requests only failed-job rerun", async () => {
  const failed = run({ conclusion: "failure" });
  const client = fake({
    devRuns: [failed],
    jobs: [
      {
        name: "Gate profile / Windows x64",
        conclusion: "failure",
        steps: [
          { name: "Setup Rust toolchain on Windows", conclusion: "failure" },
        ],
      },
    ],
  });
  const result = await runDevQualificationPatrol(
    { ...options, mutationAuthorized: true },
    client,
  );
  assert.equal(result.state, "retry-ready");
  assert.deepEqual(client.calls, [["rerun", 101]]);
});

test("cancelled runner attempt is retryable", async () => {
  const result = await runDevQualificationPatrol(
    options,
    fake({ devRuns: [run({ conclusion: "cancelled" })] }),
  );
  assert.equal(result.action, "rerun-failed-jobs");
  assert.equal(result.reason, "run-cancelled");
});

test("deterministic Gate failure never retries", async () => {
  const result = await runDevQualificationPatrol(
    options,
    fake({
      devRuns: [run({ conclusion: "failure" })],
      jobs: [
        {
          name: "Gate profile / Linux x64",
          conclusion: "failure",
          steps: [
            { name: "Enforce Shifu Gate qualification", conclusion: "failure" },
          ],
        },
      ],
    }),
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "deterministic-qualification-step");
});

test("bounded retry stops after the configured attempt", async () => {
  const result = await runDevQualificationPatrol(
    { ...options, maxAttempts: 2 },
    fake({ devRuns: [run({ conclusion: "timed_out", run_attempt: 2 })] }),
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "bounded-retry-exhausted");
});

test("mutation compare-and-swap rejects a changed source", async () => {
  await assert.rejects(
    runDevQualificationPatrol(
      {
        ...options,
        expectedAction: "dispatch",
        expectedSourceSha: OLD_SHA,
        mutationAuthorized: true,
      },
      fake(),
    ),
    /source changed/u,
  );
});

test("unknown failing steps fail closed", () => {
  const classification = classifyRetryableFailure(
    run({ conclusion: "failure" }),
    [
      {
        name: "Gate profile / Linux x64",
        conclusion: "failure",
        steps: [{ name: "Unexpected custom step", conclusion: "failure" }],
      },
    ],
  );
  assert.deepEqual(classification, {
    retryable: false,
    reason: "unclassified-failure",
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertStableReleaseGate,
  evaluateStableReleaseGate,
  loadStableReleasePolicy,
  STABLE_RELEASE_GATE_CONTRACT,
} from "../packages/core/stable-release-gate.js";

const CANDIDATE_SHA = "a".repeat(40);
const PREVIOUS_SHA = "b".repeat(40);

function policy(overrides = {}) {
  return loadStableReleasePolicy({
    input: JSON.stringify({
      schemaVersion: 1,
      contract: "kungfu-buildchain-stable-release-policy",
      enabled: true,
      minimumStableIntervalSeconds: 86_400,
      minimumCanarySoakSeconds: 3_600,
      productPathPrefixes: ["actions/", "packages/", "scripts/", ".github/workflows/", "docs/"],
      requiredCanaries: [
        {
          id: "build-surface-fixture",
          source: "release-candidate",
          repository: "kungfu-systems/buildchain",
          workflow: "Build Surface Fixture",
        },
        {
          id: "site-libkungfu-dev",
          source: "commit-status",
          repository: "kungfu-systems/site-libkungfu-dev",
          context: "buildchain-canary/site-libkungfu-dev",
          allowedAttestors: ["kungfu-origin", "github-actions[bot]"],
        },
      ],
      ...overrides,
    }),
  });
}

function facts(overrides = {}) {
  return {
    policy: policy(),
    channel: "release",
    candidate: {
      tag: "v2.11.14-alpha.1",
      sha: CANDIDATE_SHA,
      publishedAt: "2026-07-09T00:00:00.000Z",
    },
    previousStable: {
      tag: "v2.11.13",
      sha: PREVIOUS_SHA,
      publishedAt: "2026-07-08T00:00:00.000Z",
    },
    changedPaths: ["actions/promote-buildchain-ref/lib.js", "package.json"],
    impact: {
      summary: "Gate stable promotion on canary evidence.",
      surfaceImpacts: [{ id: "stable-release-canary", class: "release-governance", impact: "minor" }],
    },
    canaries: [
      {
        id: "build-surface-fixture",
        status: "success",
        candidateSha: CANDIDATE_SHA,
        completedAt: "2026-07-09T00:10:00.000Z",
        evidenceUrl: "https://github.com/kungfu-systems/buildchain/actions/runs/1",
      },
      {
        id: "site-libkungfu-dev",
        status: "success",
        candidateSha: CANDIDATE_SHA,
        completedAt: "2026-07-09T00:20:00.000Z",
        evidenceUrl: "https://github.com/kungfu-systems/site-libkungfu-dev/actions/runs/2",
        attestor: "kungfu-origin",
      },
    ],
    now: "2026-07-09T01:20:00.000Z",
    ...overrides,
  };
}

test("stable gate accepts a non-empty candidate after named canaries, soak, and cooldown", () => {
  const report = assertStableReleaseGate(facts());
  assert.equal(report.contract, STABLE_RELEASE_GATE_CONTRACT);
  assert.equal(report.ok, true);
  assert.equal(report.summary.decision, "allow");
  assert.deepEqual(report.summary.failedChecks, []);
});

test("stable gate does not throttle alpha promotions", () => {
  const report = evaluateStableReleaseGate(facts({ channel: "alpha", canaries: [] }));
  assert.equal(report.applies, false);
  assert.equal(report.ok, true);
  assert.equal(report.summary.reason, "non-stable-channel");
});

test("stable gate blocks missing, mismatched, stale, or unauthorized canaries", () => {
  const cases = [
    {
      name: "missing",
      canaries: facts().canaries.slice(0, 1),
      expected: "stable.canary.site-libkungfu-dev",
    },
    {
      name: "mismatched sha",
      canaries: facts().canaries.map((entry) => entry.id === "site-libkungfu-dev"
        ? { ...entry, candidateSha: PREVIOUS_SHA }
        : entry),
      expected: "stable.canary.site-libkungfu-dev",
    },
    {
      name: "before alpha",
      canaries: facts().canaries.map((entry) => entry.id === "site-libkungfu-dev"
        ? { ...entry, completedAt: "2026-07-08T23:59:59.000Z" }
        : entry),
      expected: "stable.canary.site-libkungfu-dev",
    },
    {
      name: "unauthorized",
      canaries: facts().canaries.map((entry) => entry.id === "site-libkungfu-dev"
        ? { ...entry, attestor: "untrusted-user" }
        : entry),
      expected: "stable.canary.site-libkungfu-dev",
    },
  ];
  for (const fixture of cases) {
    const report = evaluateStableReleaseGate(facts({ canaries: fixture.canaries }));
    assert.equal(report.ok, false, fixture.name);
    assert.ok(report.summary.failedChecks.includes(fixture.expected), fixture.name);
  }
});

test("stable gate enforces the exact soak boundary", () => {
  const before = evaluateStableReleaseGate(facts({ now: "2026-07-09T01:19:59.000Z" }));
  assert.equal(before.ok, false);
  assert.ok(before.summary.failedChecks.includes("stable.canary_soak"));

  const boundary = evaluateStableReleaseGate(facts({ now: "2026-07-09T01:20:00.000Z" }));
  assert.equal(boundary.ok, true);
});

test("stable gate enforces the stable cooldown and rejects version-only releases", () => {
  const cooldown = evaluateStableReleaseGate(facts({
    previousStable: {
      tag: "v2.11.13",
      sha: PREVIOUS_SHA,
      publishedAt: "2026-07-08T01:20:01.000Z",
    },
  }));
  assert.ok(cooldown.summary.failedChecks.includes("stable.minimum_interval"));

  const empty = evaluateStableReleaseGate(facts({ changedPaths: ["package.json", ".buildchain/release-impact.json"] }));
  assert.ok(empty.summary.failedChecks.includes("stable.product_diff"));
});

test("stable gate requires version-bound surface impact evidence", () => {
  const report = evaluateStableReleaseGate(facts({ impact: { summary: "", surfaceImpacts: [] } }));
  assert.equal(report.ok, false);
  assert.ok(report.summary.failedChecks.includes("stable.impact"));
});

test("stable policy loads from a repository path and fails closed on invalid contracts", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-stable-policy-"));
  const pathname = path.join(cwd, "policy.json");
  fs.writeFileSync(pathname, JSON.stringify({
    schemaVersion: 1,
    contract: "kungfu-buildchain-stable-release-policy",
    minimumStableIntervalSeconds: 1,
    minimumCanarySoakSeconds: 1,
    productPathPrefixes: ["packages/"],
    requiredCanaries: [{ id: "fixture", source: "release-candidate" }],
  }));
  assert.equal(loadStableReleasePolicy({ cwd, input: "policy.json" }).requiredCanaries[0].id, "fixture");
  assert.throws(
    () => loadStableReleasePolicy({ input: JSON.stringify({ schemaVersion: 1, contract: "wrong" }) }),
    /contract must be/,
  );
});

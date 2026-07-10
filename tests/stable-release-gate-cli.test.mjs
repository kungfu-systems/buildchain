import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectStableReleaseGateReport } from "../scripts/stable-release-gate.mjs";

const ALPHA_SHA = "a".repeat(40);
const STABLE_SHA = "b".repeat(40);

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-stable-gate-"));
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".buildchain/stable-release-policy.json"), JSON.stringify({
    schemaVersion: 1,
    contract: "kungfu-buildchain-stable-release-policy",
    minimumStableIntervalSeconds: 3600,
    minimumCanarySoakSeconds: 60,
    productPathPrefixes: ["actions/", "packages/", "scripts/"],
    requiredCanaries: [
      {
        id: "build-surface-fixture",
        source: "release-candidate",
        workflow: "Build Surface Fixture",
        allowedAttestors: ["github-actions[bot]"],
      },
      {
        id: "site-libkungfu-dev",
        source: "commit-status",
        repository: "kungfu-systems/site-libkungfu-dev",
        workflow: "Buildchain Stable Canary",
        context: "buildchain-canary/site-libkungfu-dev",
        allowedAttestors: ["kungfu-origin"],
      },
    ],
  }));
  fs.writeFileSync(path.join(cwd, ".buildchain/release-impact.json"), JSON.stringify({
    summary: "Adds the stable release gate.",
    surfaceImpacts: [{ id: "stable-release-gate", impact: "patch" }],
  }));
  return cwd;
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test("stable gate collector binds the exact alpha to internal and consumer canaries", async () => {
  const cwd = workspace();
  const requests = [];
  const fetchImpl = async (url) => {
    const requestPath = new URL(url).pathname + new URL(url).search;
    requests.push(requestPath);
    if (requestPath.endsWith("/releases/tags/v2.11.14-alpha.0")) {
      return response({ tag_name: "v2.11.14-alpha.0", published_at: "2026-07-10T02:00:00Z" });
    }
    if (requestPath.endsWith("/releases?per_page=100")) {
      return response([{ tag_name: "v2.11.13", published_at: "2026-07-09T00:00:00Z" }]);
    }
    if (requestPath.endsWith("/git/ref/tags/v2.11.14-alpha.0")) {
      return response({ object: { type: "commit", sha: ALPHA_SHA } });
    }
    if (requestPath.endsWith("/git/ref/tags/v2.11.13")) {
      return response({ object: { type: "commit", sha: STABLE_SHA } });
    }
    if (requestPath.includes("/compare/v2.11.13...v2.11.14-alpha.0")) {
      return response({ files: [{ filename: "packages/core/stable-release-gate.js" }] });
    }
    if (requestPath.endsWith("/actions/runs/101")) {
      return response({
        conclusion: "success",
        name: "Build Surface Fixture",
        updated_at: "2026-07-10T02:10:00Z",
        html_url: "https://github.com/kungfu-systems/buildchain/actions/runs/101",
        actor: { login: "github-actions[bot]" },
      });
    }
    if (requestPath.endsWith(`/commits/${ALPHA_SHA}/statuses?per_page=100`)) {
      return response([{
        context: "buildchain-canary/site-libkungfu-dev",
        state: "success",
        updated_at: "2026-07-10T02:20:00Z",
        target_url: "https://github.com/kungfu-systems/site-libkungfu-dev/actions/runs/202",
        creator: { login: "kungfu-origin" },
      }]);
    }
    if (requestPath.endsWith("/repos/kungfu-systems/site-libkungfu-dev/actions/runs/202")) {
      return response({
        conclusion: "success",
        name: "Buildchain Stable Canary",
        updated_at: "2026-07-10T02:20:00Z",
        inputs: { buildchain_ref: "v2.11.14-alpha.0" },
      });
    }
    throw new Error(`unexpected request: ${requestPath}`);
  };

  const report = await collectStableReleaseGateReport({
    cwd,
    repository: "kungfu-systems/buildchain",
    channel: "release",
    candidateVersion: "2.11.14-alpha.0",
    releaseCandidateRunId: "101",
    now: "2026-07-10T02:21:00Z",
    token: "test-token",
    fetchImpl,
  });

  assert.equal(report.ok, true);
  assert.equal(report.candidate.sha, ALPHA_SHA);
  assert.deepEqual(report.policy.requiredCanaries, ["build-surface-fixture", "site-libkungfu-dev"]);
  assert.equal(
    report.checks.find((entry) => entry.id === "stable.canary.site-libkungfu-dev")?.details.runtimeRef,
    "v2.11.14-alpha.0",
  );
  assert.ok(requests.some((entry) => entry.includes("site-libkungfu-dev/actions/runs/202")));
});

test("stable gate collector leaves alpha promotion fast and offline", async () => {
  const cwd = workspace();
  const report = await collectStableReleaseGateReport({
    cwd,
    repository: "kungfu-systems/buildchain",
    channel: "alpha",
    candidateVersion: "not-needed",
    fetchImpl: async () => assert.fail("alpha promotion must not query canary evidence"),
  });
  assert.equal(report.applies, false);
  assert.equal(report.summary.reason, "non-stable-channel");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { materializeCommandShim } from "./helpers/command-shim.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const BRANCH_HEAD_SHA = "c".repeat(40);
const MERGE_SHA = "d".repeat(40);

function fakeGithubCli(requiredCheckConclusion, historicalSource, largeSourceCommit) {
  const workflow = `permissions:\n  contents: read\njobs:\n  promote:\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n      id-token: write\n`;
  const responses = {
    "repos/kungfu-systems/buildchain/contents/.github/workflows/release-candidate-promote.yml": {
      content: Buffer.from(workflow).toString("base64"),
    },
    "repos/kungfu-systems/buildchain": { default_branch: "dev/v2/v2.14" },
    "repos/kungfu-systems/buildchain/branches/alpha%2Fv2%2Fv2.14": {
      protected: true,
      commit: { sha: historicalSource ? BRANCH_HEAD_SHA : SOURCE_SHA },
      protection: {
        required_status_checks: {
          enforcement_level: "everyone",
          contexts: ["check", "verify"],
          checks: [
            { context: "check", app_id: 15368 },
            { context: "verify", app_id: 15368 },
          ],
        },
      },
    },
    "repos/kungfu-systems/buildchain/rulesets?includes_parents=true&per_page=100": [{ id: 42 }],
    "repos/kungfu-systems/buildchain/rulesets/42": {
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/heads/alpha/v2/v2.14"], exclude: [] } },
      rules: [
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 1,
            required_review_thread_resolution: true,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [
              { context: "check", integration_id: 15368 },
              { context: "verify", integration_id: 15368 },
            ],
          },
        },
      ],
    },
    "repos/kungfu-systems/buildchain/actions/oidc/customization/sub": { use_default: true },
    [`repos/kungfu-systems/buildchain/commits/${SOURCE_SHA}`]: {
      parents: [{ sha: HEAD_SHA }],
      files: largeSourceCommit ? [{ filename: "large-change.txt", patch: "x".repeat(2 * 1024 * 1024) }] : [],
      commit: { message: "Merge pull request #7" },
    },
    [`repos/kungfu-systems/buildchain/commits/${SOURCE_SHA}/pulls`]: [{
      number: 7,
      merged_at: "2026-07-24T00:00:00Z",
      merge_commit_sha: historicalSource ? MERGE_SHA : SOURCE_SHA,
      user: { login: "author" },
      base: { ref: "alpha/v2/v2.14" },
      head: {
        sha: historicalSource ? SOURCE_SHA : HEAD_SHA,
        repo: { full_name: "kungfu-systems/buildchain" },
      },
    }],
    "repos/kungfu-systems/buildchain/pulls/7/reviews?per_page=100": [{
      state: "APPROVED",
      user: { login: "reviewer" },
      commit_id: historicalSource ? SOURCE_SHA : HEAD_SHA,
    }],
    [`repos/kungfu-systems/buildchain/commits/${historicalSource ? SOURCE_SHA : HEAD_SHA}/check-runs?per_page=100`]: {
      total_count: 139,
      check_runs: Array.from({ length: 100 }, (_, index) => ({
        name: `decoy-${index}`,
        conclusion: "success",
        app: { id: 15368 },
      })),
    },
    [`repos/kungfu-systems/buildchain/commits/${historicalSource ? SOURCE_SHA : HEAD_SHA}/check-runs?check_name=check&filter=latest&per_page=100`]: {
      check_runs: [{
        name: "check",
        conclusion: requiredCheckConclusion,
        app: { id: 15368 },
      }],
    },
    [`repos/kungfu-systems/buildchain/compare/${SOURCE_SHA}...${BRANCH_HEAD_SHA}`]: {
      status: "ahead",
      merge_base_commit: { sha: SOURCE_SHA },
    },
  };
  return `#!/usr/bin/env node\nconst responses = ${JSON.stringify(responses)};\nconst route = process.argv[3];\nif (process.env.FAIL_PRIMARY_PUBLIC_READ === "1" && route.includes("/contents/") && process.env.GH_TOKEN !== "public-read-token") { console.error("primary public read unavailable"); process.exit(1); }\nif (process.env.FAIL_PRIMARY_AUTHORITY_READ === "1" && route.includes("/rulesets?") && process.env.GH_TOKEN !== "public-read-token") { console.error("primary authority read unavailable"); process.exit(1); }\nif (!(route in responses)) { console.error(\`missing fake route: \${route}\`); process.exit(1); }\nprocess.stdout.write(JSON.stringify(responses[route]));\n`;
}

function runAudit({ requiredCheckConclusion = "success", historicalSource = false, largeSourceCommit = false, failPrimaryPublicRead = false, failPrimaryAuthorityRead = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-control-plane-"));
  const bin = path.join(cwd, "bin");
  fs.mkdirSync(bin);
  const gh = path.join(bin, "gh");
  materializeCommandShim(gh, fakeGithubCli(requiredCheckConclusion, historicalSource, largeSourceCommit));
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts/audit-publication-control-plane.mjs"),
    "--repository", "kungfu-systems/buildchain",
    "--branch", "alpha/v2/v2.14",
    "--source-sha", SOURCE_SHA,
    "--required-status-check", "check",
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
      GH_TOKEN: "governance-app-token",
      BUILDCHAIN_GITHUB_PUBLIC_READ_TOKEN: "public-read-token",
      FAIL_PRIMARY_PUBLIC_READ: failPrimaryPublicRead ? "1" : "",
      FAIL_PRIMARY_AUTHORITY_READ: failPrimaryAuthorityRead ? "1" : "",
    },
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  return result;
}

test("non-strict managed rulesets require and accept exact provider transaction evidence", () => {
  const result = runAudit();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.facts.find((entry) => entry.id === "branch-policy").status, "pass");
});

test("non-strict managed rulesets reject a failed required check", () => {
  const result = runAudit({ requiredCheckConclusion: "failure" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-qualifying: branch-policy/);
});

test("non-strict managed rulesets accept an exact historical pull-request head still contained in the branch", () => {
  const result = runAudit({ historicalSource: true });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.facts.find((entry) => entry.id === "branch-policy").status, "pass");
});

test("publication control-plane audit accepts source commit JSON beyond the default spawn buffer", () => {
  const result = runAudit({ largeSourceCommit: true });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.facts.find((entry) => entry.id === "branch-policy").status, "pass");
});

test("publication control-plane audit queries the exact required check and retries only public metadata", () => {
  const result = runAudit({ failPrimaryPublicRead: true });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.facts.find((entry) => entry.id === "branch-policy").status, "pass");
  const authorityFailure = runAudit({ failPrimaryAuthorityRead: true });
  assert.equal(authorityFailure.status, 1);
  assert.match(authorityFailure.stderr, /repository rulesets is unavailable/);
});

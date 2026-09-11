import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qualifySourceLifecycle, admitSourcePaper } from "../packages/core/build/source/lifecycle.js";
import { fetchSourceProofCoordinates, evaluateSourceProof } from "../packages/core/build/source/proof.js";
import { lookupSourceProof } from "../packages/core/build/source/proof-lookup.js";
import { sourceQualificationStages } from "../packages/core/build/source/controller.js";
const env = { SOURCE_HEAD: "a".repeat(40) };
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-check-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test("proof lookup never selects another workflow or ambiguous artifact", async () => {
  let outputs;
  const context = {
    repo: { owner: "test", repo: "repo" },
    payload: { merge_group: { head_ref: "gh-readonly-queue/dev/pr-7-aa" } },
  };
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: env.SOURCE_HEAD } } }),
      },
      actions: {},
    },
  };
  outputs = await lookupSourceProof({
    github,
    repository: context.repo, mergeGroupHeadRef: context.payload.merge_group.head_ref,
    callerWorkflowRef: "other/repo/.github/workflows/check.yml@dev",
  });
  assert.equal(outputs.reason, "source-proof-caller-coordinate-invalid");
  github.rest.actions.listWorkflowRunsForRepo = async () => ({
    data: {
      workflow_runs: [
        { id: 1, path: ".github/workflows/other.yml", conclusion: "success" },
        { id: 2, path: ".github/workflows/check.yml", conclusion: "success" },
      ],
    },
  });
  github.rest.actions.listWorkflowRunArtifacts = async ({ run_id }) => {
    assert.equal(run_id, 2);
    return {
      data: {
        artifacts: Array(2).fill({
          name: `buildchain-source-qualification-proof-${env.SOURCE_HEAD}`,
        }),
      },
    };
  };
  outputs = await lookupSourceProof({
    github,
    repository: context.repo, mergeGroupHeadRef: context.payload.merge_group.head_ref,
    callerWorkflowRef: "test/repo/.github/workflows/check.yml@dev",
  });
  assert.equal(outputs.found, "false");
});

test("source lifecycle preserves literal paths and phase environment without exposing consumer outputs", async t => {
  const workspace = fixture(t), cwd = path.join(workspace, "project $(touch injected)"), observed = [];
  const output = path.join(workspace, "output"); fs.writeFileSync(output, "");
  const result = await qualifySourceLifecycle({ workspace, cwd, runtimeRoot: workspace, runtimeRef: "dev/v4/v4.1", mode: "source", requireVersionState: true, env: { PATH: process.env.PATH, GITHUB_OUTPUT: output } }, {
    admitPaper: value => { assert.equal(value.cwd, cwd); observed.push("paper"); },
    validate: (directory, options) => { assert.equal(directory, cwd); assert.deepEqual(options, { requireVersionState: true, requireLifecycleStages: ["install", "check"] }); observed.push("validate"); },
    lifecycle: options => { assert.equal(options.cwd, cwd); observed.push(options.stageName); if (options.stageName === "install") { fs.writeFileSync(options.env.GITHUB_ENV, "INSTALLED=yes\n"); fs.writeFileSync(options.env.GITHUB_OUTPUT, "controller-receipt-qualifying=true\n"); } else assert.equal(options.env.INSTALLED, "yes"); },
  });
  assert.deepEqual(observed, ["paper", "validate", "install", "check"]); assert.equal(result.check, "success"); assert.equal(fs.readFileSync(output, "utf8"), "");
});
test("source lifecycle retains original exit and durable failed-stage evidence", async t => {
  const workspace = fixture(t), states = [];
  await assert.rejects(qualifySourceLifecycle({ workspace, cwd: workspace, mode: "verify", env: {}, paperAdmission: false }, {
    validate: () => {}, lifecycle: options => { assert.equal(options.stageName, "install"); throw Object.assign(new Error("install failed"), { status: 37 }); }, observe: state => states.push(state),
  }), error => error.status === 37);
  const journal = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/diagnostics/check-transaction.json")));
  assert.equal(journal.install, "failure"); assert.equal(journal.check, "skipped"); assert.equal(states.at(-1).failure.status, 37);
});
test("Paper admission rejects malformed configuration before it can skip applicability", t => {
  const cwd = fixture(t); fs.writeFileSync(path.join(cwd, "buildchain.toml"), '[project\ntype = "library"');
  assert.throws(() => admitSourcePaper({ cwd, runtimeRoot: cwd, runtimeRef: "dev/v4/v4.1" }));
});
test("source proof rejects inexact commits before fetching and records failed lookup as full qualification", t => {
  const cwd = fixture(t), sourceProofPath = path.join(cwd, "proof.json"); fs.writeFileSync(sourceProofPath, JSON.stringify({ qualifiedBase: "bad" }));
  assert.throws(() => fetchSourceProofCoordinates({ cwd, sourceProofPath }, () => assert.fail("must not fetch")), /exact commit/);
  fs.writeFileSync(sourceProofPath, JSON.stringify({ qualifiedBase: "e".repeat(40) }));
  assert.throws(() => fetchSourceProofCoordinates({ cwd, sourceProofPath, mergeGroupHead: "a".repeat(40), currentBase: "b".repeat(40), sourceHead: "c".repeat(40) }, (_, args) => { assert.ok(args.includes(`+${"e".repeat(40)}:refs/buildchain/source-proof/qualified-base`)); throw Object.assign(new Error("fetch failed"), { status: 128 }); }), error => error.status === 128);
  const result = evaluateSourceProof({ cwd }, {}, { fetch: () => { throw new Error("fetch unavailable"); }, verify: () => assert.fail("must not verify") });
  assert.equal(result.reusable, false); assert.equal(result.reason, "unverifiable-proof"); assert.ok(result.decisionRoot);
});
test("source controller refuses to qualify failed validation or cancelled action", () => {
  const observations = { runtime: { outcome: "success" }, "core-runtime": { outcome: "success" }, "lifecycle-check": { outcome: "failure", outputs: { "validate-outcome": "failure", "selected-check-outcome": "skipped" } } };
  assert.equal(sourceQualificationStages({ observations, request: {}, sourceOutcome: "success" }).find(s => s.id === "check").status, "failure");
  observations["lifecycle-check"] = { outcome: "cancelled", outputs: { "validate-outcome": "success", "selected-check-outcome": "running" } };
  assert.equal(sourceQualificationStages({ observations, request: {}, sourceOutcome: "success" }).find(s => s.id === "check").status, "cancelled");
});

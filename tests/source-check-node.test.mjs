import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import {
  lifecycleArguments,
  sourceProofArguments,
  verifySourceProof,
} from "../packages/core/build/nodes/source-check.mjs";
import { lookupSourceProof } from "../packages/core/build/nodes/source-proof-lookup.mjs";
const root = process.cwd();
const request = {
  "working-directory": "project $(touch injected)",
  "node-version": "22",
  mode: "source",
  "require-version-state": true,
};
const env = {
  BUILDCHAIN_CHECK_REQUEST_JSON: JSON.stringify(request),
  BUILDCHAIN_LIFECYCLE_STAGE: "check",
  PROTECTED_BASE: "refs/heads/dev/v4/v4.1",
  SOURCE_HEAD: "a".repeat(40),
  CURRENT_BASE: "b".repeat(40),
  MERGE_GROUP_HEAD: "c".repeat(40),
  GITHUB_REPOSITORY: "test/repo",
  RUNTIME_REF: "v4-alpha",
  RUNTIME_SHA: "d".repeat(40),
  GITHUB_RUN_ID: "12",
  SOURCE_WORKFLOW_RUN_ID: "11",
};
test("check lifecycle and proof adapters preserve literal request arguments", () => {
  for (const operation of ["validate", "install", "check"]) {
    const args = lifecycleArguments(env, operation);
    assert.equal(args[args.indexOf("--cwd") + 1], request["working-directory"]);
  }
  assert.deepEqual(lifecycleArguments(env, "validate").slice(-2), [
    "--require-lifecycle-stages",
    "install,check",
  ]);
  assert.equal(
    lifecycleArguments(
      { ...env, BUILDCHAIN_LIFECYCLE_STAGE: "verify" },
      "check",
    )[2],
    "verify",
  );
  assert.throws(
    () =>
      lifecycleArguments(
        { ...env, BUILDCHAIN_LIFECYCLE_STAGE: "arbitrary" },
        "check",
      ),
    /Invalid check/,
  );
  for (const operation of ["seal", "verify"]) {
    const args = sourceProofArguments(env, operation);
    assert.equal(args[args.indexOf("--node-version") + 1], "22");
    assert.equal(args[args.indexOf("--branch") + 1], "dev/v4/v4.1");
    assert.equal(
      args[args.indexOf("--source-workflow-run-id") + 1],
      operation === "seal" ? "12" : "11",
    );
  }
});
test("source proof validates commit coordinates before fetch and retains provider failure", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "source-proof-node-"));
  t.after(() => {
    process.chdir(root);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  process.chdir(cwd);
  fs.mkdirSync(".buildchain/source-proof", { recursive: true });
  fs.writeFileSync(
    ".buildchain/source-proof/source-proof.json",
    JSON.stringify({ qualifiedBase: "bad" }),
  );
  assert.throws(
    () => verifySourceProof(env, () => assert.fail("must reject before fetch")),
    /exact commit/,
  );
  fs.writeFileSync(
    ".buildchain/source-proof/source-proof.json",
    JSON.stringify({ qualifiedBase: "e".repeat(40) }),
  );
  const calls = [];
  assert.throws(
    () =>
      verifySourceProof(env, (program, args) => {
        calls.push([program, args]);
        throw Object.assign(new Error("fetch failed"), { status: 128 });
      }),
    (e) => e.status === 128,
  );
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0][1].includes(
      `+${"e".repeat(40)}:refs/buildchain/source-proof/qualified-base`,
    ),
  );
});
test("proof lookup never selects another workflow or ambiguous artifact", async () => {
  const outputs = {};
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
  const core = { setOutput: (k, v) => (outputs[k] = v) };
  await lookupSourceProof({
    github,
    context,
    core,
    env: { CALLER_WORKFLOW_REF: "other/repo/.github/workflows/check.yml@dev" },
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
  await lookupSourceProof({
    github,
    context,
    core,
    env: { CALLER_WORKFLOW_REF: "test/repo/.github/workflows/check.yml@dev" },
  });
  assert.equal(outputs.found, "false");
});
test("Paper admission rejects malformed configuration before applicability can skip it", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "check-paper-policy-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".buildchain"));
  fs.symlinkSync(root, path.join(cwd, ".buildchain/runtime"), "junction");
  fs.writeFileSync(
    path.join(cwd, "buildchain.toml"),
    '[project\ntype = "library"',
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/core/build/nodes/source-check.mjs"),
      "paper-policy",
    ],
    {
      cwd,
      env: {
        ...process.env,
        BUILDCHAIN_CHECK_REQUEST_JSON: JSON.stringify({
          "working-directory": ".",
        }),
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes("not applicable"), false);
});
test("source-check boundaries preserve proof fallback and failed execution receipt", () => {
  const parent = YAML.parse(
    fs.readFileSync(
      path.join(root, "actions/build/source-check/action.yml"),
      "utf8",
    ),
  );
  const proof = YAML.parse(
    fs.readFileSync(
      path.join(root, "actions/build/source-proof/action.yml"),
      "utf8",
    ),
  );
  const execution = YAML.parse(
    fs.readFileSync(
      path.join(root, "actions/build/check-lifecycle/action.yml"),
      "utf8",
    ),
  );
  assert.ok(
    parent.runs.steps.findIndex((s) => s.id === "core-runtime") <
      parent.runs.steps.findIndex((s) => s.id === "plan"),
  );
  assert.match(
    parent.runs.steps.find((s) => s.id === "lifecycle-check").if,
    /verify-reuse != 'true'/,
  );
  assert.match(
    parent.runs.steps.find((s) => s.id === "receipt").if,
    /always\(\)/,
  );
  assert.match(
    parent.runs.steps.find((s) => s.id === "receipt").env
      .BUILDCHAIN_CONTROLLER_STAGES_JSON,
    /steps.lifecycle-check.outputs.validate-outcome == 'failure'/,
  );
  for (const step of proof.runs.steps)
    assert.equal(step["continue-on-error"], true);
  for (const step of execution.runs.steps.filter((s) =>
    s.run?.includes("packages/core/"),
  ))
    assert.equal(step.env.BUILDCHAIN_NODE, "${{ inputs.core-node }}");
});

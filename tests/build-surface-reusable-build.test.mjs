import { assert, assertOrder, readComposite, readRepoText, test, workflowJob } from "./build-surface-reusable-build-harness.mjs";
import { parseReusableWorkflowInterface } from "../packages/core/workflow-yaml-contract.js";
import fs from "node:fs";

test("the build backbone has six jobs, seven owned composites and one optional locator", () => {
  const policy = JSON.parse(readRepoText("architecture/build-orchestration.json"));
  const source = readRepoText(policy.backbone);
  assert.deepEqual([...source.matchAll(/^  ([a-z][a-z-]+):$/gmu)].map((m) => m[1]).filter((name) => name !== "workflow_call"), policy.jobs);
  assert.ok(source.split("\n").length - 1 <= policy.maximumBackboneLines);
  assert.ok(readRepoText(policy.facade).split("\n").length - 1 <= policy.maximumFacadeLines);
  assert.equal(Object.keys(policy.owners).length, 7);
  for (const [file, owner] of Object.entries(policy.owners)) {
    assert.ok(owner);
    assert.ok(readRepoText(file).includes("using: composite"));
    assert.ok(readRepoText(file).split("\n").length - 1 <= policy.maximumCompositeLines);
  }
  for (const file of fs.readdirSync("scripts/build")) assert.ok(readRepoText(`scripts/build/${file}`).split("\n").length - 1 <= policy.maximumModuleLines, file);
  for (const file of [policy.backbone, policy.facade]) {
    assert.deepEqual(parseReusableWorkflowInterface(readRepoText(file)).inputs.map(({ name, required }) => ({ name, required })), [{ name: "config-path", required: false }]);
    assert.doesNotMatch(readRepoText(file), /\brun:|source-json|transfer-json|plan-json|publish-source-/u);
  }
  assert.deepEqual(parseReusableWorkflowInterface(source).outputs, ["result"]);
  const plan = workflowJob("plan");
  assert.match(plan, /ref: \$\{\{ job.workflow_sha \}\}/u);
  assert.match(plan, /ref: \$\{\{ github.sha \}\}/u);
  assert.doesNotMatch(plan, /id-token: write/u);
  assertOrder(readRepoText("scripts/build/plan.mjs"), ["Untrusted source", "resolveBuildConfiguration", "consumer-policy.mjs", "validate-package-manager-contract.mjs", "buildchain-contract-lock.mjs", "verify-publish-channel-ref.mjs"]);
});

test("native and container jobs keep install, build and verify together", () => {
  for (const job of ["build-native", "build-container"]) {
    const source = workflowJob(job);
    assert.deepEqual([...source.matchAll(/stage: (install|build|verify)/gu)].map((m) => m[1]), ["install", "build", "verify"]);
    assert.equal((source.match(/actions\/run-build-stage/gu) || []).length, 3);
    assertOrder(source, ["prepare-build-environment", "stage: install", "stage: build", "stage: verify", "transfer-build-artifact"]);
    assert.match(source, /always\(\)/u);
    assert.doesNotMatch(source, /MACOS_CERTIFICATE|NOTARY_API|PROMOTION_TOKEN/u);
  }
  assert.match(workflowJob("build-container"), /container:\n\s+image:/u);
  const prepare = readComposite("prepare-build-environment");
  assert.match(prepare, /actions\/setup-go@/u);
  assert.match(prepare, /dtolnay\/rust-toolchain@/u);
  assert.match(prepare, /windows-rust/u);
  assert.doesNotMatch(readComposite("run-build-stage"), /command:/u);
});

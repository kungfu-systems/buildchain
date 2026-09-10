import { assert, assertOrder, readComposite, readRepoText, test, workflowJob } from "./build-surface-reusable-build-harness.mjs";
import { parseReusableWorkflowInterface } from "../packages/core/contracts/workflow-yaml-contract.js";

test("the build backbone has six jobs, seven owned actions and one optional locator", () => {
  const policy = JSON.parse(readRepoText("architecture/build-orchestration.json"));
  const source = readRepoText(policy.backbone);
  assert.deepEqual([...source.matchAll(/^  ([a-z][a-z-]+):$/gmu)].map((m) => m[1]).filter((name) => name !== "workflow_call"), policy.jobs);
  assert.ok(source.split("\n").length - 1 <= policy.maximumBackboneLines);
  assert.ok(readRepoText(policy.facade).split("\n").length - 1 <= policy.maximumFacadeLines);
  assert.equal(Object.keys(policy.owners).length, 7);
  for (const [file, owner] of Object.entries(policy.owners)) {
    assert.ok(owner);
    assert.match(readRepoText(file), /using: (composite|node24)/u);
    assert.ok(readRepoText(file).split("\n").length - 1 <= policy.maximumCompositeLines);
  }
  assert.ok(policy.modules.length >= Object.keys(policy.owners).length);
  for (const file of policy.modules) assert.ok(readRepoText(file).split("\n").length - 1 <= policy.maximumModuleLines, file);
  for (const file of [policy.backbone, policy.facade]) {
    assert.deepEqual(parseReusableWorkflowInterface(readRepoText(file)).inputs.map(({ name, required }) => ({ name, required })), [{ name: "config-path", required: false }]);
    assert.doesNotMatch(readRepoText(file), /\brun:|source-json|transfer-json|plan-json|publish-source-/u);
  }
  assert.deepEqual(parseReusableWorkflowInterface(source).outputs, ["result"]);
  const plan = workflowJob("plan");
  assert.match(plan, /ref: \$\{\{ job.workflow_sha \}\}/u);
  assert.match(plan, /ref: \$\{\{ github.sha \}\}/u);
  assert.doesNotMatch(plan, /id-token: write/u);
  assertOrder(readRepoText("packages/core/build/plan/resolve.js"), ["Untrusted source", "const { plan } = resolveBuildConfiguration", "plan.admission = await admitBuildSource", "await resolveBuildReleaseSource", "await resolveBuildRunners"]);
  assertOrder(readRepoText("packages/core/build/plan/admission.js"), ["const policy = scanConsumerPolicy", "validatePackageManagerContract({", "const lock = inspectRuntimeContract", "assertRuntimeContractAccepted(lock)"]);
});

test("native and container jobs keep install, build and verify together", () => {
  for (const job of ["build-native", "build-container"]) {
    const source = workflowJob(job);
    assert.deepEqual([...source.matchAll(/stage: (install|build|verify)/gu)].map((m) => m[1]), ["install", "build", "verify"]);
    assert.equal((source.match(/actions\/build\/lifecycle\/stage/gu) || []).length, 3);
    assertOrder(source, ["actions/build/lifecycle/prepare", "stage: install", "stage: build", "stage: verify", "actions/build/artifact/transfer"]);
    assert.match(source, /always\(\)/u);
    assert.doesNotMatch(source, /MACOS_CERTIFICATE|NOTARY_API|PROMOTION_TOKEN/u);
  }
  assert.match(workflowJob("build-container"), /container:\n\s+image:/u);
  const prepare = readComposite("build/lifecycle/prepare");
  assert.match(prepare, /actions\/setup-go@/u);
  assert.match(prepare, /dtolnay\/rust-toolchain@/u);
  assert.match(prepare, /windows-rust/u);
  assert.doesNotMatch(readComposite("build/lifecycle/stage"), /command:/u);
});

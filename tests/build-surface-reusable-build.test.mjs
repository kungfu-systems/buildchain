import { assert, assertOrder, readComposite, readRepoText, test, workflowJob } from "./build-surface-reusable-build-harness.mjs";
import { parseReusableWorkflowInterface } from "../packages/core/workflow-yaml-contract.js";

test("ordinary build surfaces expose only a locator and derive identity before privileged execution", () => {
  const policy = JSON.parse(readRepoText("architecture/build-orchestration.json"));
  assert.ok(readRepoText(policy.backbone).split("\n").length - 1 <= policy.maximumBackboneLines);
  assert.ok(readRepoText(policy.facade).split("\n").length - 1 <= policy.maximumFacadeLines);
  for (const [file, owner] of Object.entries(policy.owners)) {
    assert.ok(owner && readRepoText(file).includes("using: composite"), file);
  }
  for (const path of [".github/workflows/.build.yml", ".github/workflows/build.yml"]) {
    const source = readRepoText(path);
    const contract = parseReusableWorkflowInterface(source);
    assert.deepEqual(contract.inputs.map(({ name, required }) => ({ name, required })), [{ name: "config-path", required: false }]);
    assert.doesNotMatch(source, /inputs\.(?!config-path)[a-z0-9-]+/u);
    assert.doesNotMatch(source, /universal-request-json|Normalize v3 expected identity aliases/u);
  }
  const configure = workflowJob("configure");
  assert.match(configure, /permissions:\n\s+contents: read/u);
  assert.doesNotMatch(configure, /secrets\.|id-token: write/u);
  assert.match(configure, /ref: \$\{\{ job\.workflow_sha \}\}/u);
  assert.match(configure, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(configure, /--prod --frozen-lockfile --ignore-scripts/u);
  const trust = workflowJob("trust-gate");
  assertOrder(trust, ["Enforce v4 floating consumer policy", "Validate consumer package manager contract", "Check Buildchain contract lock", "Evaluate event trust", "Verify publish target channel ref and PR lineage"]);
  assert.match(trust, /identity\.channel/u);
  assert.match(trust, /BUILDCHAIN_ALLOW_OPAQUE_RUNTIME: false/u);
  for (const job of ["resolve-source", "resolve-contract", "controller-plan", "artifact-transfer", "build-native", "build-linux-container", "summarize"]) {
    assert.match(workflowJob(job), /needs:[\s\S]*?      - trust-gate/u, job);
  }
});

test("lifecycle stages share one implementation while native and container placement stay explicit", () => {
  for (const job of ["build-native", "build-linux-container"]) {
    const source = workflowJob(job);
    assert.deepEqual([...source.matchAll(/          stage: (install|build|verify)/gu)].map((match) => match[1]), ["install", "build", "verify"]);
    assert.equal((source.match(/uses: \.\/\.buildchain\/runtime\/actions\/build-lifecycle-stage/gu) || []).length, 3);
    assert.match(source, /timeout-minutes: \$\{\{ fromJSON\(needs\.configure\.outputs\.plan-json\)\.build\.timeout_minutes \}\}/u);
    assert.match(source, /build-agent-hub-evidence/u);
  }
  const native = workflowJob("build-native");
  assert.match(native, /shell: cmd/u);
  assert.match(native, /--no-modify-path/u);
  assert.match(native, /dtolnay\/rust-toolchain@/u);
  assert.match(workflowJob("build-linux-container"), /container:\n\s+image:/u);
  const stage = readComposite("build-lifecycle-stage");
  assert.doesNotMatch(stage, /\n        command:/u);
  assert.match(stage, /lifecycle\[inputs\.stage\]\.required/u);
  assert.match(stage, /inputs\.stage == 'build' &&.*sample_process_tree/u);
  assert.match(stage, /inputs\.stage == 'verify'.*substage_evidence_path/u);
  assert.match(stage, /process-summary-required: true/u);
  const verification = readComposite("build-verification-evidence");
  assert.match(verification, /always\(\).*verify-outcome != 'success'/u);
  assert.match(verification, /BUILDCHAIN|publish-source-tree-sha/u);
});

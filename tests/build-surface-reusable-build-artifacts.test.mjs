import { assert, assertOrder, readComposite, readRepoText, test, workflowJob } from "./build-surface-reusable-build-harness.mjs";
import { parseReusableWorkflowInterface } from "../packages/core/workflow-yaml-contract.js";

test("both build lanes preserve exact checkout and share deterministic artifact delivery", () => {
  const transfer = readComposite("build-artifact-transfer");
  for (const job of ["build-native", "build-linux-container"]) {
    const source = workflowJob(job);
    assertOrder(source, ["Setup", "Download Buildchain runtime checkout bootstrap", "Checkout Buildchain runtime", "Checkout locked source", "Run install lifecycle", "Run build lifecycle", "Run verify lifecycle", "Simulate artifact transport before upload", "build-artifact-transfer"]);
    assert.match(source, /BUILDCHAIN_SOURCE_TREE_SHA: \$\{\{ needs\.resolve-source\.outputs\.publish-source-tree-sha \}\}/u);
    assert.match(source, /source-json: \$\{\{ toJSON\(needs\.resolve-source\.outputs\) \}\}/u);
    assert.match(source, /transfer-json: \$\{\{ toJSON\(needs\.artifact-transfer\.outputs\) \}\}/u);
    assert.doesNotMatch(source, /artifact-relay-s3\.mjs upload/u);
  }
  assertOrder(transfer, ["Configure AWS credentials", "Upload payload to S3 artifact relay", "Upload artifact relay manifest", "Upload deterministic artifact", "Upload artifact manifest", "Upload diagnostics artifact"]);
  assert.match(transfer, /include-hidden-files: true/u);
  assert.match(transfer, /if-no-files-found: error/u);
  assert.match(transfer, /githubHosted != true/u);
  assert.match(transfer, /githubHosted == true/u);
  for (const artifact of ["manifest.json", "summary.json", "diagnostics.json", "diagnostics-manifest.json", "source-checkout.json", "compiler-cache-preparation.json", "process-summary.json", "process-samples.jsonl", "verify-substages.json"]) assert.ok(transfer.includes(artifact), artifact);
  const relay = workflowJob("relay-artifacts");
  assertOrder(relay, ["artifact-relay-s3.mjs download", "artifact-relay-s3.mjs cleanup"]);
});

test("the public facade forwards every backbone output without duplicating controllers", () => {
  const backbone = readRepoText(".github/workflows/.build.yml");
  const facade = readRepoText(".github/workflows/build.yml");
  const core = parseReusableWorkflowInterface(backbone);
  const names = core.outputs;
  assert.equal(names.length, 45);
  for (const name of names) assert.ok(facade.includes(`value: \${{ jobs.build.outputs.${name} }}`), name);
  assert.match(workflowJob("summarize"), /generate-release-candidate-passport\.mjs/u);
  assert.match(workflowJob("summarize"), /aggregate-diagnostics-summary\.mjs/u);
  assert.match(workflowJob("controller-receipt"), /always\(\)/u);
  assert.equal((facade.match(/uses: \.\/\.github\/workflows\/\.build.yml/gu) || []).length, 1);
});

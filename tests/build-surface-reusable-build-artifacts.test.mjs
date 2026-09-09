import { assert, assertOrder, readComposite, readRepoText, test, workflowJob } from "./build-surface-reusable-build-harness.mjs";
import { parseReusableWorkflowInterface } from "../packages/core/contracts/workflow-yaml-contract.js";

test("transport shares exact artifact references and fails on provider digest mismatch", () => {
  const store = readRepoText("packages/core/build/commands/artifact-store.mjs");
  assert.match(store, /digestMismatch\) throw/u);
  assert.match(store, /ref\.plan_root !== plan\.root/u);
  assert.match(store, /ref\.source_sha !== plan\.source\.sha/u);
  assert.match(store, /matches.length !== 1/u);
  const transfer = readRepoText("packages/core/build/commands/transfer.mjs");
  assert.match(transfer, /uploadRelayArtifacts/u);
  assert.match(transfer, /downloadRelayArtifacts/u);
  assert.match(transfer, /cleanupRelayArtifacts/u);
  assert.match(transfer, /verifyManifest/u);
  assertOrder(readRepoText("packages/core/build/commands/sign.mjs"), ["const payload = await upload", "await publishRecord", "await cleanupRelay"]);
  assert.match(readComposite("build/transfer-artifact"), /environment.transfer.upload_role_arn/u);
});

test("the public facade projects the result and two useful artifact handles", () => {
  const facade = readRepoText(".github/workflows/build.yml");
  assert.deepEqual(parseReusableWorkflowInterface(facade).outputs, ["controller-receipt-artifact", "release-candidate-artifact", "result"]);
  assert.equal((facade.match(/uses: \.\/\.github\/workflows\/\.build.yml/gu) || []).length, 1);
  assert.match(workflowJob("deliver"), /always\(\)/u);
  assert.match(workflowJob("deliver"), /toJSON\(needs\)/u);
  const final = readRepoText("packages/core/build/commands/finalize.mjs");
  assert.match(final, /generate-release-candidate-passport.mjs/u);
  assert.match(final, /aggregate-diagnostics-summary.mjs/u);
  assertOrder(final, ["assertJobResults(jobs, plan);", "verifyExecution(", "loadFinalArtifact(plan", "resolveArtifactCoordinates({"]);
});

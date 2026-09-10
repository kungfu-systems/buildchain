import assert from "node:assert/strict";
import { inspectWorkflowJob, readWorkflow } from "../workflow-action-graph.mjs";

export function assertBinaryInventory(root) {
  const file = ".github/workflows/self-build-binary-distribution.yml";
  const workflow = readWorkflow(file, root);
  assert.equal(workflow.name, "Binary Distribution");
  assert.deepEqual(Object.keys(workflow.jobs), ["preflight", "binary", "passport", "dispatch-publication"]);
  const graphs = Object.keys(workflow.jobs).map(id => inspectWorkflowJob(file, id, root));
  for (const graph of graphs) {
    assert.equal(graph.job.permissions.contents, "read");
    assert.notEqual(graph.job.permissions["id-token"], "write");
    assert.ok(!JSON.stringify(graph.job["runs-on"]).includes("self-hosted"));
    for (const step of graph.steps) assert.ok(!/gh release (?:upload|create)/u.test(step.run || ""));
    assert.ok(graph.actions.has(`actions/build/binary/${["preflight", "build", "passport", "dispatch-publication"][graphs.indexOf(graph)]}`));
  }
  const binary = graphs[1];
  assert.deepEqual(binary.job.strategy.matrix.include.map(entry => entry.os).sort(), ["macos-latest", "ubuntu-24.04", "windows-2022"]);
  const passport = graphs[2];
  const executable = passport.modules.get("packages/core/build/binary/distribution.js");
  for (const command of ["verifyBuildchainLogEvents", "verifyReleasePassport", "verifyArtifactPassport", "createReleaseEvidenceBundle", "buildchain-log-events", "buildchain-log-summary"])
    assert.ok(executable.includes(command), `Binary evidence is missing ${command}`);
  assert.ok(passport.actions.has("actions/build/binary/qualify"));
  const publish = inspectWorkflowJob(".github/workflows/.release-binary-assets.yml", "publish", root);
  assert.equal(publish.workflow.jobs["publication-authority"].uses, "./.github/workflows/.release-authority.yml");
  assert.equal(publish.job.needs, "publication-authority");
  assert.equal(publish.job.environment, "buildchain-release-assets");
  assert.equal(publish.job.permissions.contents, "write");
  assert.ok(publish.actions.has("actions/release/binary/publish"));
  const effect = publish.steps.find(step => step.uses?.endsWith("/publication/binary/publish"));
  assert.ok(effect);
  assert.equal(effect["continue-on-error"], undefined);
  const transaction = publish.modules.get("packages/core/publication/binary/transaction.js");
  assert.match(transaction, /validateBinaryCapability\([\s\S]*await client.publish\(/, "Binary effects must follow capability admission");
  assert.match(publish.modules.get("packages/core/publication/binary/action.js"), /verifySourceRuntimeCheckouts\([\s\S]*await publishBinaryAssets\(/);
}

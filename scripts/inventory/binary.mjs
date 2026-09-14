import assert from "node:assert/strict";
import { checkSelfConsumerContract } from "../check-self-consumer-contract.mjs";
import { inspectWorkflowJob, readWorkflow } from "../workflow-action-graph.mjs";

export function assertBinaryInventory(root) {
  const { plan } = checkSelfConsumerContract(root);
  assert.deepEqual(plan.products.filter(product => product.type === "binary")
    .flatMap(product => product.platforms).sort(), ["linux-x64", "macos-arm64", "windows-x64"]);
  const build = inspectWorkflowJob(".github/workflows/.release-pipeline-products.yml", "build", root);
  assert.equal(build.job.permissions.contents, "read");
  assert.notEqual(build.job.permissions["id-token"], "write");
  assert.ok(!JSON.stringify(build.job["runs-on"]).includes("self-hosted"));
  for (const step of build.steps) assert.ok(!/gh release (?:upload|create)/u.test(step.run || ""));
  const publish = inspectWorkflowJob(".github/workflows/.release-binary-assets.yml", "publish", root);
  assert.equal(publish.workflow.jobs["publication-authority"].uses, "./.github/workflows/.release-authority.yml");
  assert.ok(publish.job.needs.includes("publication-authority"));
  assert.equal(publish.job.environment, "buildchain-release-assets");
  assert.equal(publish.job.permissions.contents, "write");
  assert.ok(publish.actions.has("actions/release/binary/publish"));
  const effect = publish.steps.find(step => step.uses?.endsWith("/publication/binary/publish"));
  assert.ok(effect);
  assert.equal(effect["continue-on-error"], undefined);
  const transaction = publish.modules.get("packages/core/publication/binary/transaction.js");
  assert.match(transaction, /validateBinaryCapability\([\s\S]*await client.publish\(/, "Binary effects must follow capability admission");
  assert.match(publish.modules.get("packages/core/publication/binary/action.js"), /verifyCheckoutIdentity\([\s\S]*await observeBinaryDistribution\([\s\S]*publishBinaryAssets\(/);
}

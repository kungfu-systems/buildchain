import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { inspectWorkflowJob } from "../workflow-action-graph.mjs";
import { generateChannelPromotionWorkflow } from "../generate-channel-promotion-workflow.mjs";

export function assertPromotionInventory(root) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const publicPath = ".github/workflows/public-release-promote.yml";
  const api = YAML.parse(read(publicPath));
  assert.equal(
    read(publicPath),
    generateChannelPromotionWorkflow(
      read(".github/workflows/.release-promote.yml"),
    ),
  );
  assert.deepEqual(Object.keys(api.on.workflow_call.inputs), ["request-json"]);
  assert.equal(
    api.jobs.invoke.uses,
    "./.github/workflows/.release-promote.yml",
  );
  assert.deepEqual(api.jobs.invoke.with, {
    "request-json": "${{ needs.consumer-admission.outputs.invocation-json }}",
  });
  const request = JSON.parse(
    read("contracts/promotion-request-v1.schema.json"),
  );
  assert.equal(request.additionalProperties, false);
  for (const key of [
    "promotion-router-sha",
    "promotion-runtime-authorization-json",
    "branch-protection-bypass-users",
    "publish-command",
  ])
    assert.ok(!request.properties[key]);
  for (const file of [
    "self-release-promote",
    "self-release-tail-dogfood",
    "self-ops-promotion-recovery",
  ]) {
    const caller = YAML.parse(read(`.github/workflows/${file}.yml`));
    const calls = Object.values(caller.jobs).filter(
      (job) => job.uses === `./${publicPath}`,
    );
    assert.equal(calls.length, 1, file);
    assert.deepEqual(Object.keys(calls[0].with), ["request-json"]);
  }
  const component = ".github/workflows/.release-promote.yml";
  const expected = {
    qualify: "promotion/qualify",
    apply: "promotion/apply",
    settle: "promotion/settle",
  };
  for (const [job, node] of Object.entries(expected)) {
    const graph = inspectWorkflowJob(component, job, root);
    assert.ok(
      graph.actions.has(`actions/release/${node}`),
      `${job} must reach its owned node`,
    );
    if (job !== "apply")
      assert.notEqual(graph.job.permissions?.contents, "write");
    if (job === "apply")
      assert.ok(graph.actions.has("actions/release/promotion/candidate"));
    assert.ok(
      [...graph.modules.keys()].every(
        (file) => !file.startsWith("packages/core/release/promote-ref/"),
      ),
      "canonical publisher cannot reach the separate ref-promotion engine",
    );
  }
}

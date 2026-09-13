import assert from "node:assert/strict";
import test from "node:test";
import { readWorkflow } from "../scripts/workflow-action-graph.mjs";

const workflow = (name) => readWorkflow(`.github/workflows/${name}.yml`);

test("normal and recovered delivery forward the canonical provider credential across every reusable edge", () => {
  for (const name of ["public-ops-pipeline", "public-ops-recover"]) {
    const entry = workflow(name);
    assert.equal(entry.jobs.execute.uses, "./.github/workflows/.ops-pipeline-execute.yml");
    assert.equal(entry.jobs.execute.secrets, "inherit");
  }
  const execute = workflow(".ops-pipeline-execute");
  assert.equal(execute.jobs.delivery.uses, "./.github/workflows/.ops-pipeline-delivery.yml");
  assert.deepEqual(execute.jobs.delivery.secrets, {
    BUILDCHAIN_AUTOMATION_TOKEN: "${{ secrets.BUILDCHAIN_AUTOMATION_TOKEN }}",
  });
  const delivery = workflow(".ops-pipeline-delivery");
  assert.equal(delivery.on.workflow_call.secrets.BUILDCHAIN_AUTOMATION_TOKEN.required, false);
  assert.equal(delivery.jobs.delivery.uses, "./.github/workflows/public-ops-dev-auto-merge.yml");
  assert.deepEqual(delivery.jobs.delivery.secrets, {
    "github-token": "${{ secrets.BUILDCHAIN_AUTOMATION_TOKEN || github.token }}",
  });
  const leaf = workflow("public-ops-dev-auto-merge");
  for (const id of ["source", "reserve"]) {
    const step = leaf.jobs.admission.steps.find((item) => item.id === id);
    assert.equal(step.with["github-token"], "${{ secrets.github-token || github.token }}");
  }
});

test("automation credentials remain absent from product builds, native execution and native evidence sealing", () => {
  const execute = workflow(".ops-pipeline-execute");
  const leaf = workflow("public-ops-dev-auto-merge");
  for (const job of [execute.jobs.build, leaf.jobs["native-execution"], leaf.jobs["seal-native-execution"]]) {
    assert.equal(job.secrets, undefined);
    assert.doesNotMatch(JSON.stringify(job), /secrets\.|AUTOMATION_TOKEN/);
    assert.ok(Object.values(job.permissions).every((value) => value === "read"));
  }
});

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
  assert.equal(delivery.jobs.delivery.uses, "./.github/workflows/.ops-dev-auto-merge.yml");
  assert.deepEqual(delivery.jobs.delivery.secrets, {
    "github-token": "${{ secrets.BUILDCHAIN_AUTOMATION_TOKEN || github.token }}",
  });
  const leaf = workflow(".ops-dev-auto-merge");
  for (const id of ["source", "reserve"]) {
    const step = leaf.jobs.admission.steps.find((item) => item.id === id);
    assert.equal(step.with["github-token"], "${{ secrets.github-token || github.token }}");
  }
});

test("automation credentials remain absent from product builds, native execution and native evidence sealing", () => {
  const execute = workflow(".ops-pipeline-execute");
  const leaf = workflow(".ops-dev-auto-merge");
  for (const job of [execute.jobs.build, leaf.jobs["native-execution"], leaf.jobs["seal-native-execution"]]) {
    assert.equal(job.secrets, undefined);
    assert.doesNotMatch(JSON.stringify(job), /secrets\.|AUTOMATION_TOKEN/);
    assert.ok(Object.values(job.permissions).every((value) => value === "read"));
  }
});


test("channel enqueue has an event-producing credential in both central entries", () => {
  for (const name of ["public-ops-pipeline", "public-ops-recover"]) {
    const entry = workflow(name);
    const steps = entry.jobs.control.steps;
    const credential = steps.find((step) => step.id === "queue-credential");
    assert.ok(credential, `${name} lacks the queue credential boundary`);
    assert.equal(credential.uses, "./.buildchain/runtime/actions/providers/github/token");
    assert.equal(credential.with["client-id"], "${{ vars.BUILDCHAIN_APP_CLIENT_ID }}");
    assert.equal(credential.with["private-key"], "${{ secrets.BUILDCHAIN_APP_PRIVATE_KEY }}");
    assert.equal(credential.with["fallback-token"], "${{ secrets.BUILDCHAIN_AUTOMATION_TOKEN }}");
    assert.equal(credential.with["failure-policy"], "strict");
    assert.equal(credential.with["permission-pull-requests"], "write");
    assert.equal(credential.with["workflow-token"], undefined);
    const control = steps.find((step) => step.id === "control");
    assert.ok(steps.indexOf(credential) > 0 && steps.indexOf(credential) < steps.indexOf(control));
    assert.equal(control.with["queue-token"], "${{ steps.queue-credential.outputs.token }}");
    assert.equal(control.with.token, "${{ github.token }}");
    assert.equal(entry.on.workflow_call.inputs["queue-token"], undefined);
  }
});

test("queue reads retain workflow authority while enqueue requires a distinct explicit credential", async () => {
  const { pipelineQueue } = await import("../packages/core/workflow/pipeline/host.js");
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, authorization: options.headers.authorization, body });
    return { ok: true, text: async () => JSON.stringify({ data: {
      repository: { mergeQueue: { id: "queue", entries: { nodes: [] } } },
      enqueuePullRequest: { mergeQueueEntry: { id: "entry" } },
    } }) };
  };
  const options = { repository: { owner: "consumer", repo: "product" }, token: "workflow", fetchImpl };
  const input = { pullRequestId: "exact-pr", expectedHeadOid: "a".repeat(40) };
  for (const queueToken of ["app-installation", "explicit-automation"]) {
    const queue = pipelineQueue({ ...options, queueToken });
    assert.equal((await queue.getMergeQueueState("alpha/v4/v4.1")).id, "queue");
    assert.equal(requests.at(-1).authorization, "Bearer workflow");
    assert.equal((await queue.enqueuePullRequest(input)).id, "entry");
    assert.equal(requests.at(-1).authorization, `Bearer ${queueToken}`);
    assert.deepEqual(requests.at(-1).body.variables.input, input);
  }
  for (const queueToken of [undefined, "", "workflow"]) {
    const queue = pipelineQueue({ ...options, queueToken });
    await queue.getMergeQueueState("alpha/v4/v4.1");
    const before = requests.length;
    await assert.rejects(() => queue.enqueuePullRequest(input), /distinct App or automation credential/);
    assert.equal(requests.length, before, "invalid authority must fail before provider mutation");
  }
});

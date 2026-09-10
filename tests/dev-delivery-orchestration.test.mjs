import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { inspectWorkflowJob, localActionDirectory, readWorkflow, repositoryRoot } from "../scripts/workflow-action-graph.mjs";
const read = file => fs.readFileSync(path.join(repositoryRoot, file), "utf8");
const contract = JSON.parse(read("architecture/dev-delivery-orchestration.json"));
const implementations = contract.nodes.flatMap(node => node.implementations.map(item => ({ ...item, node: node.id })));
function nodeCalls(job, jobId) {
  return job.steps.map(step => {
    const action = localActionDirectory(step.uses);
    if (!action) return null;
    const implementation = implementations.find(item => item.action === `${action}/action.yml` && item.domains.includes(jobId));
    assert.ok(implementation, `Undeclared delivery node ${action} in ${jobId}`);
    return { ...step, implementation };
  }).filter(Boolean);
}
test("six semantic delivery nodes declare exact role-specific interfaces", () => {
  assert.deepEqual(contract.nodes.map(n => n.id).sort(), ["land", "native", "qualify", "reserve", "settle", "source"]);
  for (const item of implementations) {
    const action = readWorkflow(item.action);
    assert.deepEqual(Object.keys(action.inputs || {}).sort(), [...item.inputs].sort());
    assert.deepEqual(Object.keys(action.outputs || {}).sort(), [...item.outputs].sort());
    assert.equal(action.inputs?.phase, undefined);
  }
  assert.equal(fs.existsSync(path.join(repositoryRoot, "actions/dev-delivery/native/dispatch/action.yml")), false);
});
test("native execution, sealing and heartbeat retain distinct credential boundaries", () => {
  for (const [jobId, operation] of [["native-execution", "execute"], ["seal-native-execution", "seal"], ["delivery-heartbeat", "heartbeat"]]) {
    const graph = inspectWorkflowJob(contract.workflow, jobId);
    assert.ok(graph.job.steps.at(-1).uses.endsWith(`/native/${operation}`));
    for (const step of graph.steps) assert.equal(step.run, undefined);
    if (operation !== "heartbeat") {
      assert.deepEqual(graph.job.permissions, operation === "seal" ? { actions: "read", contents: "read" } : { contents: "read" });
      for (const step of graph.steps) {
        assert.equal(step.with?.["github-token"], undefined); assert.equal(step.with?.token, undefined);
        for (const name of Object.keys(step.env || {})) assert.ok(!["GH_TOKEN", "GITHUB_TOKEN"].includes(name));
      }
    }
  }
  const finalizer = inspectWorkflowJob(contract.workflow, "merge-dev-prs");
  assert.equal(finalizer.job.permissions.contents, "write");
  assert.ok(finalizer.modules.has("packages/core/dev-delivery/native/transactions.js"));
});
test("orchestration exposes declared nodes after exact workflow implementation checkout", () => {
  for (const file of [contract.workflow, contract.terminalWorkflow]) {
    assert.ok(read(file).split("\n").length <= contract.maxOrchestrationLines);
    for (const [jobId, job] of Object.entries(readWorkflow(file).jobs)) {
      const checkout = job.steps[0];
      assert.equal(checkout.uses, "actions/checkout@v7.0.0");
      assert.equal(checkout.with.repository, "${{ job.workflow_repository }}");
      assert.equal(checkout.with.ref, "${{ job.workflow_sha }}");
      assert.equal(checkout.with["persist-credentials"], false);
      const calls = nodeCalls(job, jobId);
      assert.deepEqual(calls.map(call => call.implementation.node), contract.jobs[jobId].nodes);
      assert.equal(job.steps.length, calls.length + 1);
      for (const call of calls) for (const port of Object.keys(call.with || {})) assert.ok(call.implementation.inputs.includes(port), `${jobId}: unknown ${port}`);
      for (const step of job.steps) assert.equal(step.run, undefined);
    }
  }
});
test("failed predecessors cannot enter landing and reporting stays unconditional", () => {
  const workflow = readWorkflow(contract.workflow);
  const landing = workflow.jobs["merge-dev-prs"].steps.find(step => step.id === "land");
  assert.equal(landing.if, "always()");
  assert.equal(landing.with["predecessors-ok"], "${{ job.status == 'success' }}");
  assert.equal(landing.with["failure-final-outcome"], "${{ steps.settle.outcome }}");
  const settlement = workflow.jobs["merge-dev-prs"].steps.find(step => step.id === "settle");
  assert.match(settlement.if, /boundary-outcome == 'success'/u);
  assert.match(settlement.if, /boundary-native-outcome == 'failure'/u);
  const reserve = readWorkflow("actions/dev-delivery/candidate/reserve/action.yml");
  assert.equal(reserve.runs.steps[0].with["predecessors-ok"], "${{ inputs.predecessors-ok }}");
  assert.match(reserve.runs.steps.at(-1).if, /always\(\)/u);
  const land = readWorkflow("actions/dev-delivery/queue/land/action.yml");
  assert.match(land.runs.steps[0].if, /inputs.predecessors-ok == 'true'/u);
  assert.equal(land.runs.steps.at(-1).if, "always()");
  assert.ok(land.runs.steps.at(-1).uses.endsWith("/queue/complete"));
});
test("delivery implementations stay bounded and composites only compose actions", () => {
  let total = 0;
  for (const item of implementations) {
    const lines = read(item.action).trimEnd().split("\n").length;
    assert.ok(lines <= contract.maxNodeLines, item.action); total += lines;
    const action = readWorkflow(item.action);
    for (const step of action.runs.steps || []) assert.ok(step.uses && !step.run && !step.shell && !step.with?.script);
  }
  assert.ok(total <= contract.maxTotalNodeLines);
});

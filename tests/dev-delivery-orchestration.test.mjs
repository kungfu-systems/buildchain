import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { inspectWorkflowJob, readWorkflow, repositoryRoot } from "../scripts/workflow-action-graph.mjs";
import { actionText, nodeCalls, workflowJobs } from "../scripts/dev-delivery-workflow-view.mjs";
const read = (file) => fs.readFileSync(path.join(repositoryRoot, file), "utf8");
const contract = JSON.parse(read("architecture/dev-delivery-orchestration.json"));

test("six semantic delivery nodes have exact owned input and output contracts", () => {
  assert.deepEqual(contract.nodes.map(n => n.id).sort(), ["land", "native", "qualify", "reserve", "settle", "source"]);
  for (const node of contract.nodes) {
    const action = readWorkflow(node.action);
    assert.deepEqual(Object.keys(action.inputs || {}).sort(), [...node.inputs].sort(), node.id);
    assert.deepEqual(Object.keys(action.outputs || {}).sort(), [...node.outputs].sort(), node.id);
  }
  for (const retired of ["dev-pr-auto-merge.yml", "dev-delivery-warrant-close.yml"])
    assert.equal(fs.existsSync(path.join(repositoryRoot, ".github/workflows", retired)), false);
});

test("native execution, sealing and provider heartbeat reach distinct adapter domains", () => {
  for (const [jobId, phase] of [["native-execution", "execute"], ["seal-native-execution", "seal"], ["delivery-heartbeat", "heartbeat"]]) {
    const graph = inspectWorkflowJob(contract.workflow, jobId);
    assert.equal(graph.job.steps.at(-1).with.phase, phase);
    const nativeActions = [...graph.actions.keys()].filter(id => id.startsWith("actions/dev-delivery/native-"));
    assert.deepEqual(nativeActions, [`actions/dev-delivery/native-${phase}`]);
    if (phase !== "heartbeat") {
      assert.equal(graph.job.steps.at(-1).with["github-token"], undefined);
      assert.deepEqual(graph.job.permissions, phase === "seal" ? {actions: "read", contents: "read"} : {contents: "read"});
      for (const step of graph.steps) for (const name of Object.keys(step.env || {}))
        assert.ok(!["GH_TOKEN", "GITHUB_TOKEN"].includes(name), `${jobId}: credential leak at ${step.name}`);
    }
    const node = readWorkflow(`actions/dev-delivery/native-${phase}/action.yml`);
    const command = phase === "heartbeat" ? "provider-heartbeat.mjs" : phase === "seal" ? "dev-delivery-process-boundary.mjs" : 'native.mjs" execute';
    assert.ok(node.runs.steps.some(step => step.run?.includes(command)));
  }
  const finalizer = inspectWorkflowJob(contract.workflow, "merge-dev-prs");
  assert.equal(finalizer.job.permissions.contents, "write");
  assert.ok(finalizer.steps.some(step => step.run?.includes('native.mjs" finalize')));
});

test("orchestration contains only exact implementation checkout and six node calls", () => {
  for (const file of [contract.workflow, contract.terminalWorkflow]) {
    const source = read(file);
    assert.ok(source.split("\n").length <= contract.maxOrchestrationLines);
    for (const job of workflowJobs(source)) {
      if (job.id === "universal-bootstrap") continue;
      assert.doesNotMatch(
        job.text,
        /^\s+run:/m,
        "provider commands belong to their node",
      );
      assert.match(job.text, /repository: \$\{\{ job.workflow_repository \}\}/);
      assert.match(job.text, /ref: \$\{\{ job.workflow_sha \}\}/);
      assert.match(job.text, /persist-credentials: false/);
      assert.deepEqual(
        nodeCalls(job).map((c) => c.node),
        contract.jobs[job.id].nodes,
      );
      const uses = [...job.text.matchAll(/^        uses: (.+)$/gm)].map(
        (m) => m[1],
      );
      assert.equal(uses[0], "actions/checkout@v7.0.0");
      assert.equal(uses.length, nodeCalls(job).length + 1);
      for (const call of nodeCalls(job)) {
        const node = contract.nodes.find((n) => n.id === call.node);
        assert.equal(call.inputs["request-json"], "${{ toJSON(inputs) }}");
        for (const port of Object.keys(call.inputs))
          assert.ok(
            node.inputs.includes(port),
            `${call.node}: undeclared input ${port}`,
          );
        if (["native-execution", "seal-native-execution"].includes(job.id))
          assert.equal(call.inputs["github-token"], undefined);
      }
    }
  }
});

test("failure reporting remains unconditional and cannot turn an earlier node failure into a merge", () => {
  const job = workflowJobs(read(contract.workflow)).find(
    (j) => j.id === "merge-dev-prs",
  );
  const calls = nodeCalls(job);
  assert.deepEqual(
    calls.map((c) => c.node),
    ["qualify", "settle", "land"],
  );
  assert.match(calls[2].text, /if: always\(\)/);
  assert.equal(calls[2].inputs["predecessors-ok"], "${{ job.status == 'success' }}");
  assert.equal(
    calls[2].inputs["native-final-outcome"],
    "${{ steps.qualify.outputs.native-final-outcome }}",
  );
  assert.equal(
    calls[2].inputs["failure-final-outcome"],
    "${{ steps.settle.outputs.failure-final-outcome }}",
  );
  const reservation = nodeCalls(workflowJobs(read(contract.workflow)).find((job) => job.id === "admission"))[1];
  assert.equal(reservation.inputs["predecessors-ok"], "${{ job.status == 'success' }}");
  assert.match(reservation.text, /if: always\(\)/);
  assert.match(actionText("reserve"), /if: inputs.predecessors-ok == 'true' &&/);
  assert.match(actionText("land"), /if: inputs.predecessors-ok == 'true' &&/);
  assert.match(
    actionText("land"),
    /name: Enforce targeted admission result\n\s+if: always\(\)/,
  );
  // Native failure settlement and asynchronous provider terminal settlement use
  // one owner, but no queued success can invoke terminal cleanup.
  assert.equal(calls[1].inputs.phase, "native-failure");
  const terminal = nodeCalls(
    workflowJobs(read(contract.terminalWorkflow)).find((j) => j.id === "close"),
  );
  assert.equal(terminal[0].node, "settle");
  assert.equal(terminal[0].inputs.phase, "terminal");
});

test("dev delivery has one canonical execution graph", () => {
  for (const workflow of [contract.workflow, contract.terminalWorkflow]) {
    assert.doesNotMatch(read(workflow), /universal-request-json|universal-bootstrap:/u);
  }
  assert.equal(fs.existsSync(path.join(repositoryRoot, "scripts/generate-universal-workflow-facades.mjs")), false);
});

test("node implementations stay bounded independently of the thin facade budget", () => {
  let total = 0;
  for (const node of contract.nodes) {
    const lines = actionText(node.id).trimEnd().split("\n").length;
    assert.ok(
      lines <= contract.maxNodeLines,
      `${node.id} exceeds its implementation budget`,
    );
    total += lines;
  }
  assert.ok(
    total <= contract.maxTotalNodeLines,
    "total composite implementation exceeds its budget",
  );
});

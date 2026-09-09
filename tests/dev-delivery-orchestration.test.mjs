import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseReusableWorkflowInterface } from "../packages/core/workflow-yaml-contract.js";
import {
  actionText,
  expandDevDeliveryWorkflow,
  nodeCalls,
  normalizeWorkflowOperations,
  repositoryRoot,
  workflowJobs,
} from "../scripts/dev-delivery-workflow-view.mjs";
const contract = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "architecture/dev-delivery-orchestration.json"),
    "utf8",
  ),
);
const baseline = JSON.parse(
  fs.readFileSync(
    path.join(
      import.meta.dirname,
      "fixtures/dev-delivery/orchestration-baseline.json",
    ),
    "utf8",
  ),
);
const digest = (text) =>
  crypto
    .createHash("sha256")
    .update(normalizeWorkflowOperations(text))
    .digest("hex");
const read = (file) => fs.readFileSync(path.join(repositoryRoot, file), "utf8");

test("six owned delivery nodes conserve all pre-refactor operations, contracts and job boundaries", () => {
  assert.deepEqual(contract.nodes.map((n) => n.id).sort(), [
    "land",
    "native",
    "qualify",
    "reserve",
    "settle",
    "source",
  ]);
  for (const [file, root] of Object.entries(baseline.workflows)) {
    assert.equal(
      digest(expandDevDeliveryWorkflow(file)),
      root,
      `${file}: command, condition, evidence, output or permission drift`,
    );
  }
});

test("public compatibility entrypoints retain exactly the same interface and implementation", () => {
  for (const [canonical, alias] of [
    [contract.workflow, ".github/workflows/dev-pr-auto-merge.yml"],
    [
      contract.terminalWorkflow,
      ".github/workflows/dev-delivery-warrant-close.yml",
    ],
  ]) {
    assert.equal(read(canonical), read(alias));
    assert.deepEqual(
      parseReusableWorkflowInterface(read(canonical)),
      parseReusableWorkflowInterface(expandDevDeliveryWorkflow(canonical)),
    );
  }
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

test("each native authority domain selects only its own operations", () => {
  const expanded = workflowJobs(expandDevDeliveryWorkflow(contract.workflow));
  const jobs = Object.fromEntries(expanded.map((j) => [j.id, j.text]));
  assert.match(jobs["native-execution"], /--native-only/);
  assert.doesNotMatch(
    jobs["native-execution"],
    /GITHUB_TOKEN:|GH_TOKEN:|--finalize-only|\.mjs seal|provider-heartbeat\.mjs run/,
  );
  assert.match(jobs["seal-native-execution"], /\.mjs seal/);
  assert.doesNotMatch(
    jobs["seal-native-execution"],
    /GITHUB_TOKEN:|GH_TOKEN:|--native-only|--finalize-only/,
  );
  assert.match(jobs["delivery-heartbeat"], /provider-heartbeat\.mjs run/);
  assert.doesNotMatch(
    jobs["delivery-heartbeat"],
    /--native-only|--finalize-only/,
  );
  assert.match(jobs["merge-dev-prs"], /--finalize-only/);
  const rawJobs = workflowJobs(read(contract.workflow));
  assert.equal(
    nodeCalls(rawJobs.find((j) => j.id === "native-execution"))[0].inputs.phase,
    "execute",
  );
  assert.equal(
    nodeCalls(rawJobs.find((j) => j.id === "seal-native-execution"))[0].inputs
      .phase,
    "seal",
  );
  assert.equal(
    nodeCalls(rawJobs.find((j) => j.id === "delivery-heartbeat"))[0].inputs
      .phase,
    "heartbeat",
  );
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

test("conservation check rejects changed provider effects and missing evidence guards", () => {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "dev-delivery-orchestration-"),
  );
  try {
    fs.cpSync(
      path.join(repositoryRoot, ".github/actions/dev-delivery"),
      path.join(temp, ".github/actions/dev-delivery"),
      { recursive: true },
    );
    fs.mkdirSync(path.join(temp, ".github/workflows"), { recursive: true });
    fs.copyFileSync(
      path.join(repositoryRoot, contract.workflow),
      path.join(temp, contract.workflow),
    );
    const file = path.join(
      temp,
      ".github/actions/dev-delivery/qualify/action.yml",
    );
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      file,
      original.replace("--finalize-only", "--native-only"),
    );
    assert.notEqual(
      digest(expandDevDeliveryWorkflow(contract.workflow, temp)),
      baseline.workflows[contract.workflow],
    );
    fs.writeFileSync(
      file,
      original.replace("steps.proof-verification.outcome == 'success'", "true"),
    );
    assert.notEqual(
      digest(expandDevDeliveryWorkflow(contract.workflow, temp)),
      baseline.workflows[contract.workflow],
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("fresh facade regeneration preserves the owned nodes and exact universal branch", async () => {
  const { facadeGenerationSource, migrateUniversalWorkflowFacade } =
    await import("../scripts/generate-universal-workflow-facades.mjs");
  for (const [canonical, alias] of [
    [contract.workflow, ".github/workflows/dev-pr-auto-merge.yml"],
    [
      contract.terminalWorkflow,
      ".github/workflows/dev-delivery-warrant-close.yml",
    ],
  ]) {
    const source = read(canonical);
    assert.equal(facadeGenerationSource(source, alias, true), source);
    assert.equal(migrateUniversalWorkflowFacade(source, alias), source);
  }
});

test("operation conservation preserves shell whitespace and literal body blank lines", () => {
  const source =
    "    - run: |\n        printf '%s\\n' \\\n          value\n\n        echo done\n      shell: bash\n";
  assert.notEqual(
    normalizeWorkflowOperations(source),
    normalizeWorkflowOperations(source.replace("\\\n", "\\ \n")),
  );
  assert.notEqual(
    normalizeWorkflowOperations(source),
    normalizeWorkflowOperations(source.replace("\n\n", "\n")),
  );
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

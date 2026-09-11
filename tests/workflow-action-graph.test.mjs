import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectWorkflowJob, localActionDirectory } from "../scripts/workflow-action-graph.mjs";

test("source closure follows capability-specific checkout names without admitting escaping paths", () => {
  assert.equal(localActionDirectory("$/actions/runtime/environment/prepare"), "actions/runtime/environment/prepare");
  assert.equal(localActionDirectory("$/actions/runtime/../prepare"), null);
  for (const root of ["workflow-shell", "attester-runtime", "release-tail-runtime"])
    assert.equal(localActionDirectory(`./.buildchain/${root}/actions/release/tail/settle`), "actions/release/tail/settle");
  for (const uses of ["./.buildchain/../actions/release/tail/settle", "./other/actions/release/tail/settle", "./actions/release/../settle"])
    assert.equal(localActionDirectory(uses), null);
});

function fixture(t, phase, extra = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-action-graph-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  const action = steps => ({ runs: { using: "composite", steps } });
  write("workflow.yml", { jobs: { delivery: { steps: [{ uses: "./actions/workflow/fixture/dispatch", with: { phase } }] } } });
  write("actions/workflow/fixture/dispatch/action.yml", action([{ uses: "./actions/workflow/fixture/phase", with: { phase: "${{ inputs.phase }}" } }]));
  write("actions/workflow/fixture/phase/action.yml", action([
    { if: "${{ always() && inputs.phase == 'execute' }}", uses: "./actions/workflow/fixture/execute" },
    { if: "${{ inputs.phase == 'seal' && (success() || failure()) }}", uses: "./actions/workflow/fixture/seal" },
    ...extra,
  ]));
  for (const operation of ["execute", "seal"]) {
    write(`actions/workflow/fixture/${operation}/action.yml`, { runs: { using: "node24", main: "dist/index.js" } });
    write(`actions/workflow/fixture/${operation}/index.js`, `export * from "../../../../packages/core/workflow/${operation}.mjs";\n`);
  }
  write("packages/core/workflow/execute.mjs", "export const execute = true;\n");
  write("packages/core/workflow/seal.mjs", "export const seal = true;\n");
  return root;
}

test("literal phase forwarding follows only the selected node's module closure", t => {
  const graph = inspectWorkflowJob("workflow.yml", "delivery", fixture(t, "execute"));
  assert.deepEqual([...graph.modules.keys()].filter(file => file.startsWith("packages/core/")), ["packages/core/workflow/execute.mjs"]);
  assert.equal(graph.steps.some(step => step.if?.includes("'seal'")), false);
});

test("unknown phase retains both possible closures", t => {
  const graph = inspectWorkflowJob("workflow.yml", "delivery", fixture(t, "${{ inputs.mode }}"));
  assert.deepEqual([...graph.modules.keys()].filter(file => file.startsWith("packages/core/")).sort(), ["packages/core/workflow/execute.mjs", "packages/core/workflow/seal.mjs"]);
});

test("a phase disjunction cannot hide a reachable module", t => {
  const graph = inspectWorkflowJob("workflow.yml", "delivery", fixture(t, "execute", [
    { if: "${{ inputs.phase == 'seal' || success() }}", uses: "./actions/workflow/fixture/seal" },
  ]));
  assert.ok(graph.modules.has("packages/core/workflow/seal.mjs"));
});

test("reachable composite cycles fail without hiding behind a phase", t => {
  const root = fixture(t, "execute", [{ if: "${{ inputs.phase == 'execute' }}", uses: "./actions/workflow/fixture/dispatch", with: { phase: "execute" } }]);
  assert.throws(() => inspectWorkflowJob("workflow.yml", "delivery", root), /Composite action cycle/);
});

test("source closure rejects forbidden executable composite steps", t => {
  const root = fixture(t, "execute", [{ run: "node hidden.mjs" }]);
  assert.throws(() => inspectWorkflowJob("workflow.yml", "delivery", root), /composite must invoke actions/);
});

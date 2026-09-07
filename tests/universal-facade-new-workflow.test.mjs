import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { governUniversalFacadeWorkflowMetrics } from "../scripts/universal-facade-maintainability.mjs";

test("post-migration workflows retain current metrics and cannot hide frozen workflow debt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "facade-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "architecture"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(
    path.join(root, "scripts/generate-universal-workflow-facades.mjs"),
    "// Fixture facade validation entry.\n",
  );
  const policy = {
    bootstrap: { publicWorkflow: "bootstrap" },
    bootstrapGovernedWorkflows: ["old", "new"],
    migration: {
      facadeSourceRevision: "a".repeat(40),
      postMigrationWorkflows: ["new"],
    },
  };
  fs.writeFileSync(
    path.join(root, "architecture/universal-workflow-bootstrap.json"),
    JSON.stringify(policy),
  );
  const current = { workflows: { old: { lines: 120 }, new: { lines: 90 } } };
  const result = governUniversalFacadeWorkflowMetrics({
    root,
    current,
    workflowMetricsAtRevision: () => ({ old: { lines: 100 } }),
  });
  assert.deepEqual(result.governed.workflows, {
    old: { lines: 100 },
    new: { lines: 90 },
  });
  assert.equal(result.migration.paths.has("new"), false);
  assert.throws(
    () =>
      governUniversalFacadeWorkflowMetrics({
        root,
        current,
        workflowMetricsAtRevision: () => ({
          old: { lines: 100 },
          new: { lines: 1 },
        }),
      }),
    /invalid post-migration/u,
  );
});

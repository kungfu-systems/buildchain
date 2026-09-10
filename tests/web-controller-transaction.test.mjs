import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initializeWebController,
  finalizeWebController,
  webControllerStages,
  selectWebControllerPlan,
} from "../packages/core/web/controller.js";
import { finalizeWebControllerAction } from "../packages/core/web/controller-actions.js";

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "web-controller-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const sourceSha = "a".repeat(40);
  initializeWebController({
    workspace,
    runtimeRoot: process.cwd(),
    request: {},
    runtime: { "runtime-ref": "b".repeat(40), "runtime-sha": "b".repeat(40) },
    source: { repository: "example/site", sha: sourceSha },
  });
  return { workspace, sourceSha };
}
test("Web controller preserves failure and cancellation precedence across apply and authority jobs", () => {
  const stages = webControllerStages({
    runtime: { result: "success" },
    plan: {
      result: "success",
      outputs: { "build-outcome": "failure", "verify-outcome": "skipped" },
    },
    "preview-apply": { result: "success" },
    "production-apply": { result: "cancelled" },
    "publication-authority": { result: "failure" },
    "external-publication-authority": { result: "skipped" },
  });
  const values = Object.fromEntries(
    stages.map((stage) => [stage.id, stage.status]),
  );
  assert.equal(values.build, "failure");
  assert.equal(values.verify, "skipped");
  assert.equal(values.apply, "cancelled");
  assert.equal(values.aggregate, "cancelled");
  assert.equal(values["publication-authority"], "failure");
});
test("Non-applicable Web channels produce an honest non-qualifying receipt without claiming a deployment", (t) => {
  const request = fixture(t);
  const result = finalizeWebController({
    ...request,
    observations: {
      runtime: { result: "success" },
      plan: {
        result: "success",
        outputs: { "build-outcome": "success", "verify-outcome": "success" },
      },
    },
  });
  assert.equal(result.requireQualifying, false);
  assert.equal(result.receipt.qualifying, false);
  assert.deepEqual(result.receipt.evidence, []);
});
test("Failed Web execution persists and exposes its receipt before action failure", (t) => {
  const request = fixture(t);
  const outputs = {};
  const observations = {
    runtime: { result: "success" },
    plan: { result: "failure" },
    "release-intent": {
      outputs: { "production-source-sha": request.sourceSha },
    },
  };
  assert.throws(
    () =>
      finalizeWebControllerAction(
        {
          getInput: () => JSON.stringify(observations),
          setOutput: (key, value) => {
            outputs[key] = value;
          },
        },
        { GITHUB_WORKSPACE: request.workspace },
      ),
    /not qualifying/,
  );
  assert.ok(outputs["controller-receipt-digest"]);
  assert.ok(fs.existsSync(outputs["controller-receipt-path"]));
  assert.equal(
    JSON.parse(outputs["controller-receipt-json"]).qualifying,
    false,
  );
});
test("Production controller rejects mixed channel evidence instead of selecting a convenient file", (t) => {
  const { workspace } = fixture(t);
  fs.writeFileSync(
    path.join(workspace, "web-surface-production-plan.json"),
    "{}",
  );
  fs.writeFileSync(path.join(workspace, "web-surface-preview-plan.json"), "{}");
  assert.throws(
    () => selectWebControllerPlan(workspace, { production: true }),
    /exactly one production/,
  );
});

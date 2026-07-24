import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertPublicSurfaceReverseAudit,
  collectPublicSurfaceReverseAudit,
  enumerateActionInputs,
  enumerateCliCommandsFromBin,
  enumerateWorkflowInputs,
} from "@kungfu-tech/buildchain/public-surface-audit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public surface reverse audit passes for the generated Buildchain site bundle", () => {
  const report = collectPublicSurfaceReverseAudit({ root });

  assert.equal(report.status, "passed");
  assert.equal(report.summary.failureCount, 0);
  assert.ok(enumerateCliCommandsFromBin({ root }).some((entry) => entry.id === "release-line-open"));
  const buildWorkflow = enumerateWorkflowInputs({ root }).find((entry) => entry.id === ".build");
  assert.ok(buildWorkflow?.reusable);
  assert.ok(buildWorkflow.inputCount > 0);
  assert.ok(buildWorkflow.outputCount > 0);
  assert.ok(buildWorkflow.secrets.includes("BUILDCHAIN_ARTIFACT_RELAY_S3_ROLE_ARN"));
  assert.ok(enumerateActionInputs({ root }).some((entry) => entry.id === "promote-buildchain-ref" && entry.inputCount > 0));
});

test("public surface reverse audit fails closed when a real CLI command is not registered", () => {
  const realReport = collectPublicSurfaceReverseAudit({ root });
  const cliRegistry = {
    commands: realReport.enumerated.cliCommands.filter((entry) => entry.id !== "release-line-open"),
  };
  const report = collectPublicSurfaceReverseAudit({
    root,
    cliRegistry,
  });

  assert.equal(report.status, "failed");
  assert.ok(report.comparison.missingCliRegistry.some((entry) => entry.id === "release-line-open"));
  assert.throws(() => assertPublicSurfaceReverseAudit(report), /missing CLI registry: release-line-open/);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CROSS_PLATFORM_ADOPTER_PLATFORMS,
  createCrossPlatformAdopterReport,
  qualifyCrossPlatformAdopters,
  summarizeBaselineCapabilityInventory,
  validateCrossPlatformAdopterReport,
} from "../packages/core/cross-platform-adopter-qualification.js";

const root = path.resolve(import.meta.dirname, "..");
const inventory = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture/capability-parity-live-capability-inventory.json"),
    "utf8",
  ),
);
const inventoryEvidence = summarizeBaselineCapabilityInventory(inventory);
const runtimeSha = "a".repeat(40);

function report(platform, consumer = "buildchain") {
  return createCrossPlatformAdopterReport({
    platform,
    consumer,
    sourceBinding: {
      runtimeSha,
      consumerSha: consumer === "buildchain" ? "b".repeat(40) : "c".repeat(40),
      inventoryRoot: inventoryEvidence.inventoryRoot,
      sourceCuts: inventoryEvidence.sourceCuts,
    },
    capabilityMatrix: {
      capabilityCount: inventoryEvidence.summary.capabilityCount,
      categoryCounts: inventoryEvidence.summary.categoryCounts,
      dispositionCounts: inventoryEvidence.summary.dispositionCounts,
      categories: inventoryEvidence.categories,
    },
    execution: {
      initialRun: {
        status: "passed",
        readbackRoot: `sha256:${"1".repeat(64)}`,
      },
      tamperFailure: { status: "failed-as-required", exitCode: 1 },
      retryRun: { status: "passed", readbackRoot: `sha256:${"1".repeat(64)}` },
      terminalVerify: {
        status: "passed",
        readbackRoot: `sha256:${"1".repeat(64)}`,
      },
      bootstrap: { status: "passed", resultRoot: `sha256:${"2".repeat(64)}` },
      neutralDriver: {
        id: "ledger-specification-driver",
        status: "passed",
        kfdDependencyPresent: false,
      },
    },
    authority: {
      productionWrites: false,
      providerEffects: false,
      releaseEffects: false,
      stablePublication: false,
    },
  });
}

test("raw v3 inventory produces the complete exact-source matrix", () => {
  assert.equal(inventoryEvidence.summary.capabilityCount, 4654);
  assert.equal(inventoryEvidence.categories.length, 18);
  assert.deepEqual(inventoryEvidence.summary, inventory.summary);
  const substituted = structuredClone(inventory);
  delete substituted.capabilities[0].v4Route.evidence;
  assert.throws(
    () => summarizeBaselineCapabilityInventory(substituted),
    /does not bind an exact v3 source to a v4 route/,
  );
});

test("two public adopters and the neutral driver reconcile across all platforms", () => {
  const consumers = ["buildchain", "sample-consumer"];
  const reports = consumers.flatMap((consumer) =>
    CROSS_PLATFORM_ADOPTER_PLATFORMS.map((platform) =>
      report(platform, consumer),
    ),
  );
  const qualification = qualifyCrossPlatformAdopters({ reports, consumers });
  assert.equal(qualification.reports.length, 6);
  assert.equal(qualification.capabilityMatrix.capabilityCount, 4654);
  assert.equal(qualification.neutralDriver.status, "passed");
  assert.equal(qualification.authority.stablePublication, false);
});

test("missing platforms, source drift and inferred recovery fail closed", () => {
  const reports = CROSS_PLATFORM_ADOPTER_PLATFORMS.map((platform) =>
    report(platform),
  );
  assert.throws(
    () =>
      qualifyCrossPlatformAdopters({
        reports: reports.slice(0, -1),
        consumers: ["buildchain"],
      }),
    /platform matrix mismatch/,
  );

  const driftBody = structuredClone(reports[2]);
  driftBody.sourceBinding.runtimeSha = "f".repeat(40);
  delete driftBody.schemaVersion;
  delete driftBody.contract;
  delete driftBody.reportRoot;
  const drift = createCrossPlatformAdopterReport(driftBody);
  assert.throws(
    () =>
      qualifyCrossPlatformAdopters({
        reports: [reports[0], reports[1], drift],
        consumers: ["buildchain"],
      }),
    /same exact source/,
  );

  const inferred = structuredClone(reports[0]);
  inferred.execution.tamperFailure.status = "passed";
  assert.throws(
    () => validateCrossPlatformAdopterReport(inferred),
    /failure, retry, terminal or neutral-driver evidence is incomplete/,
  );

  const missingExitCode = structuredClone(reports[0]);
  delete missingExitCode.execution.tamperFailure.exitCode;
  assert.throws(
    () => validateCrossPlatformAdopterReport(missingExitCode),
    /failure, retry, terminal or neutral-driver evidence is incomplete/,
  );
});

test("runner executes public failure, retry and terminal paths", (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "cross-platform-adopter-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, "linux-x64", "qualification-report.json");
  const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const completed = spawnSync(
    process.execPath,
    [
      "scripts/cross-platform-adopter-qualification.mjs",
      "run",
      "--runtime-root",
      root,
      "--consumer-root",
      root,
      "--platform",
      "linux-x64",
      "--consumer",
      "buildchain",
      "--runtime-sha",
      currentSha,
      "--consumer-sha",
      currentSha,
      "--input",
      "contracts/fixtures/v4-adopter-delivery-v1/gate-positive.json",
      "--bootstrap",
      "contracts/fixtures/v4-adopter-delivery-v1/bootstrap-positive.json",
      "--output",
      output,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(completed.status, 0, completed.stderr);
  const observed = validateCrossPlatformAdopterReport(
    JSON.parse(fs.readFileSync(output, "utf8")),
  );
  assert.equal(observed.execution.tamperFailure.status, "failed-as-required");
  assert.equal(
    observed.execution.retryRun.readbackRoot,
    observed.execution.initialRun.readbackRoot,
  );
  assert.equal(observed.execution.neutralDriver.kfdDependencyPresent, false);
});

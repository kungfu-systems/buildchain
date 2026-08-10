import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { V4ContractFault } from "../packages/core/v4-canonical-contracts.js";
import {
  V4_STAGE_CAPSULE_QUALIFICATION_FAULTS,
  V4_STAGE_CAPSULE_WAVE_CHILDREN,
  qualifyV4StageCapsuleCampaign,
  reconcileV4StageCapsuleWave,
  validateV4StageCapsulePlatformQualification,
} from "../packages/core/v4-stage-capsule-qualification.js";

const root = path.resolve(import.meta.dirname, "..");
const runtimeRef = "8ccd88c43fa2f5d78a641b66c8e7fecccdb7b49f";
const platforms = ["linux-x64", "macos-arm64", "windows-x64"];
const consumers = ["buildchain"];
const sha = (digit) => `sha256:${digit.repeat(64)}`;

function temp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

function lifecycleEvidence(
  platform,
  sourceRevision,
  stages = ["install", "build", "verify"],
) {
  const evidenceRoot = temp(`real-lifecycle-${platform}`);
  for (const [index, stage] of stages.entries()) {
    const artifactName = `buildchain-${stage}-${platform}`;
    const summary = {
      contract: "kungfu-buildchain-artifact-summary",
      artifactName,
      platform: { id: platform },
      fileCount: 1,
      totalBytes: index + 1,
    };
    const manifest = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-artifact",
      artifactName,
      platform: { id: platform },
      git: { sha: sourceRevision },
      lifecycle: {
        stage,
        commandSource: "buildchain.toml",
        executed: true,
      },
      summary,
      files: [
        {
          path: stage === "install" ? "node_modules/.modules.yaml" : "dist",
          size: index + 1,
          sha256: String(index + 1).repeat(64),
        },
      ],
    };
    fs.writeFileSync(
      path.join(evidenceRoot, `${stage}-manifest.json`),
      `${JSON.stringify(manifest)}\n`,
    );
    fs.writeFileSync(
      path.join(evidenceRoot, `${stage}-summary.json`),
      `${JSON.stringify(summary)}\n`,
    );
  }
  return evidenceRoot;
}

function externalConsumer() {
  const consumerRoot = temp("external-consumer");
  fs.mkdirSync(path.join(consumerRoot, ".buildchain"));
  fs.writeFileSync(
    path.join(consumerRoot, ".buildchain/buildchain.toml"),
    `schema = 1

[lifecycle.install]
command = "npm ci"

[lifecycle.build]
command = "npm run build"

[lifecycle.verify]
command = "npm run check"

[lifecycle.publish]
command = "npm publish"
`,
  );
  return consumerRoot;
}

function externalCampaign(platform, consumerRoot = externalConsumer()) {
  const workRoot = temp(`qualification-agent-hub-demo-${platform}`);
  const evidenceRoot = lifecycleEvidence(platform, runtimeRef, [
    "install",
    "build",
    "verify",
  ]);
  const args = [
    "scripts/v4-stage-capsule-qualification.mjs",
    "campaign",
    "--work-root",
    workRoot,
    "--platform",
    platform,
    "--consumer",
    "agent-hub-demo",
    "--runtime-ref",
    runtimeRef,
    "--consumer-source-revision",
    runtimeRef,
    "--consumer-root",
    consumerRoot,
    "--lifecycle-evidence-root",
    evidenceRoot,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    args,
    consumerRoot,
    evidenceRoot,
    workRoot,
    report: JSON.parse(result.stdout),
  };
}

let externalCampaignCache = null;
function allExternalCampaigns() {
  externalCampaignCache ??= platforms.map((platform) =>
    externalCampaign(platform),
  );
  return externalCampaignCache;
}

function campaign(platform, consumer) {
  const workRoot = temp(`qualification-${consumer}-${platform}`);
  const sourceRevision = runtimeRef;
  const evidenceRoot = lifecycleEvidence(platform, sourceRevision);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/v4-stage-capsule-qualification.mjs",
      "campaign",
      "--work-root",
      workRoot,
      "--platform",
      platform,
      "--consumer",
      consumer,
      "--runtime-ref",
      runtimeRef,
      "--consumer-source-revision",
      sourceRevision,
      "--consumer-root",
      root,
      "--lifecycle-evidence-root",
      evidenceRoot,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { workRoot, report: JSON.parse(result.stdout) };
}

let campaignCache = null;
function allCampaigns() {
  campaignCache ??= consumers.flatMap((consumer) =>
    platforms.map((platform) => campaign(platform, consumer)),
  );
  return campaignCache;
}

test("clean-process campaigns retain exact stages and rebuild only the missing closure", () => {
  for (const { report } of allCampaigns()) {
    assert.equal(validateV4StageCapsulePlatformQualification(report), report);
    assert.deepEqual(report.resumePlan.requiredRestores, ["build"]);
    assert.deepEqual(report.resumePlan.requiredStages, ["verify"]);
    assert.deepEqual(report.freshBuild, report.resumedBuild);
    assert.equal(report.metrics.fullStageCount, 3);
    assert.equal(report.metrics.retainedStageCount, 2);
    assert.equal(report.metrics.restoredStageCount, 1);
    assert.equal(report.metrics.rebuiltStageCount, 1);
    assert.equal(report.metrics.falseReuseCount, 0);
    assert.equal(report.metrics.falseRebuildCount, 0);
    assert.equal(report.metrics.plannerAccurate, true);
    assert.equal(report.processRuns[0].outcome, "late-failure");
    assert.equal(report.processRuns[1].outcome, "qualified");
  }
});

test("the fault campaign fails closed across every declared invalidation", () => {
  for (const { report } of allCampaigns()) {
    assert.deepEqual(
      report.faultCampaign.map(({ id }) => id),
      V4_STAGE_CAPSULE_QUALIFICATION_FAULTS,
    );
    assert.equal(
      report.faultCampaign.every(({ passed }) => passed),
      true,
    );
    assert.equal(
      report.faultCampaign.some(
        ({ id, actual, reasonCode }) =>
          id === "stale-writer" &&
          actual === "contract-fault" &&
          reasonCode === "invalid-stage-capsule-authority",
      ),
      true,
    );
  }
});

test("public consumer qualification requires exact real lifecycle evidence", () => {
  const workRoot = temp("qualification-missing-lifecycle");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/v4-stage-capsule-qualification.mjs",
      "campaign",
      "--work-root",
      workRoot,
      "--platform",
      "linux-x64",
      "--consumer",
      "buildchain",
      "--runtime-ref",
      runtimeRef,
      "--consumer-source-revision",
      runtimeRef,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-stage-capsule-lifecycle-evidence/u);
});

test("three reports qualify Buildchain through the public consumer identity", () => {
  const reports = allCampaigns().map(({ report }) => report);
  const result = qualifyV4StageCapsuleCampaign(reports);
  assert.equal(result.qualified, true);
  assert.equal(result.productionAuthority, "v3");
  assert.equal(result.productionWrites, false);
  assert.equal(result.falseReuseCount, 0);
  assert.equal(result.falseRebuildCount, 0);
  assert.deepEqual(result.consumers, consumers);
  assert.deepEqual(
    result.platforms.map(({ platform }) => platform),
    platforms,
  );
});

test("a generic external consumer qualifies its real three-stage lifecycle", () => {
  const reports = allExternalCampaigns().map(({ report }) => report);
  for (const report of reports) {
    assert.equal(validateV4StageCapsulePlatformQualification(report), report);
    assert.deepEqual(report.resumePlan.requiredRestores, ["build"]);
    assert.deepEqual(report.resumePlan.requiredStages, ["verify"]);
    assert.deepEqual(report.freshBuild, report.resumedBuild);
    assert.equal(report.metrics.fullStageCount, 3);
    assert.equal(report.metrics.retainedStageCount, 2);
    assert.equal(report.metrics.rebuiltStageCount, 1);
  }
  const qualification = qualifyV4StageCapsuleCampaign(reports, [
    "agent-hub-demo",
  ]);
  assert.equal(qualification.qualified, true);
  assert.deepEqual(qualification.consumers, ["agent-hub-demo"]);
  assert.equal(qualification.productionAuthority, "v3");
  assert.equal(qualification.productionWrites, false);
});

test("external lifecycle and clean-process binding drift fail closed with typed diagnostics", () => {
  for (const [mutate, expected] of [
    [
      (manifest) => (manifest.lifecycle.commandSource = "workflow-input"),
      "invalid-stage-capsule-lifecycle-evidence",
    ],
    [
      (manifest) => (manifest.git.sha = "0".repeat(40)),
      "stage-capsule-lifecycle-source-mismatch",
    ],
    [
      (manifest) => (manifest.files = []),
      "invalid-stage-capsule-lifecycle-output",
    ],
    [
      (manifest) => (manifest.summary.totalBytes += 1),
      "stage-capsule-lifecycle-summary-mismatch",
    ],
  ]) {
    const consumerRoot = externalConsumer();
    const evidenceRoot = lifecycleEvidence("linux-x64", runtimeRef, [
      "install",
      "build",
      "verify",
    ]);
    const manifestPath = path.join(evidenceRoot, "build-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    mutate(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/v4-stage-capsule-qualification.mjs",
        "campaign",
        "--work-root",
        temp("external-drift"),
        "--platform",
        "linux-x64",
        "--consumer",
        "agent-hub-demo",
        "--runtime-ref",
        runtimeRef,
        "--consumer-source-revision",
        runtimeRef,
        "--consumer-root",
        consumerRoot,
        "--lifecycle-evidence-root",
        evidenceRoot,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(expected, "u"));
  }

  const seeded = externalCampaign("linux-x64");
  const resumeArgs = seeded.args.slice();
  resumeArgs[1] = "resume";
  const runtimeIndex = resumeArgs.indexOf("--runtime-ref") + 1;
  resumeArgs[runtimeIndex] = "f".repeat(40);
  const runtimeDrift = spawnSync(process.execPath, resumeArgs, {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(runtimeDrift.status, 0);
  assert.match(
    runtimeDrift.stderr,
    /stage-capsule-campaign-runtime-ref-drift/u,
  );
});

test("aggregate CLI reads clean-run reports and emits the same qualification root", () => {
  const input = temp("qualification-aggregate");
  const reports = allCampaigns().map(({ report }) => report);
  reports.forEach((report, index) => {
    const directory = path.join(input, String(index));
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, "report.json"),
      `${JSON.stringify(report)}\n`,
    );
  });
  const result = spawnSync(
    process.execPath,
    [
      "scripts/v4-stage-capsule-qualification.mjs",
      "aggregate",
      "--input-dir",
      input,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    JSON.parse(result.stdout),
    qualifyV4StageCapsuleCampaign(reports),
  );
});

test("output drift, a failed fault, and incomplete consumer evidence are rejected", () => {
  const reports = allCampaigns().map(({ report }) => structuredClone(report));
  const drifted = structuredClone(reports[0]);
  drifted.resumedBuild.contentRoot = sha("0");
  assert.throws(
    () => validateV4StageCapsulePlatformQualification(drifted),
    (error) =>
      error instanceof V4ContractFault &&
      error.code === "stage-capsule-qualification-output-mismatch",
  );
  const failedFault = structuredClone(reports[0]);
  failedFault.faultCampaign[0].passed = false;
  assert.throws(
    () => validateV4StageCapsulePlatformQualification(failedFault),
    (error) =>
      error instanceof V4ContractFault &&
      error.code === "failed-stage-capsule-fault-campaign",
  );
  assert.throws(
    () => qualifyV4StageCapsuleCampaign(reports.slice(0, 2)),
    (error) =>
      error instanceof V4ContractFault &&
      error.code === "incomplete-stage-capsule-platform-campaign",
  );
});

test("one explicit v3 switch rolls back without destroying retained state", () => {
  const workRoot = path.join(temp("qualification-rollback"), "unused");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/v4-stage-capsule-qualification.mjs",
      "campaign",
      "--work-root",
      workRoot,
      "--platform",
      "linux-x64",
      "--consumer",
      "buildchain",
      "--runtime-ref",
      runtimeRef,
      "--consumer-source-revision",
      runtimeRef,
      "--stage-capsule-mode",
      "v3",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: "buildchain-v4-stage-capsule-rollback/v1",
    switch: "stage-capsule-mode=v3",
    productionAuthority: "v3",
    migrationRequired: false,
    retainedStateDestroyed: false,
    productionWrites: false,
  });
  assert.equal(fs.existsSync(workRoot), false);
});

function reconciliationRequest(qualificationRoot) {
  return {
    schema: "buildchain-v4-stage-capsule-wave-reconciliation/v1",
    qualificationRoot,
    protectedDeliveryDrained: true,
    children: V4_STAGE_CAPSULE_WAVE_CHILDREN.map((id, index) => ({
      id,
      nativeStatus: "terminal",
      nativeGateRoot: sha(String(index + 1)),
      sourceRevision: String(index + 1).repeat(40),
      protectedMergeRevision: String(index + 2).repeat(40),
      reviewRoot: sha(String(index + 2)),
      warrantRoot: sha(String(index + 3)),
    })),
  };
}

test("Wave reconciliation requires five native-terminal protected deliveries", () => {
  const qualification = qualifyV4StageCapsuleCampaign(
    allCampaigns().map(({ report }) => report),
  );
  const request = reconciliationRequest(qualification.qualificationRoot);
  const result = reconcileV4StageCapsuleWave(request);
  assert.equal(result.terminal, true);
  assert.equal(result.productionAuthority, "v3");
  assert.equal(result.productionReuseEnabled, false);
  assert.equal(result.children.length, 5);
  for (const mutate of [
    (value) => value.children.pop(),
    (value) => (value.children[0].nativeStatus = "active"),
    (value) => (value.protectedDeliveryDrained = false),
  ]) {
    const changed = structuredClone(request);
    mutate(changed);
    assert.throws(() => reconcileV4StageCapsuleWave(changed), V4ContractFault);
  }
});

test("architecture freezes the public consumer path, rollback, and authority ceilings", () => {
  const architecture = JSON.parse(
    fs.readFileSync(
      path.join(root, "architecture/v4-stage-capsule-qualification.json"),
      "utf8",
    ),
  );
  assert.equal(architecture.mode, "shadow-only");
  assert.equal(architecture.productionAuthority, "v3");
  assert.deepEqual(architecture.campaign.platforms, platforms);
  assert.deepEqual(architecture.campaign.consumers, consumers);
  assert.deepEqual(architecture.publicConsumerDogfood.executableStages, [
    "install",
    "build",
    "verify",
  ]);
  assert.equal(
    architecture.publicConsumerDogfood.excludedStages["version-state"],
    "source-mutation",
  );
  assert.equal(
    architecture.publicConsumerDogfood.excludedStages.publish,
    "provider-mutation",
  );
  assert.equal(
    architecture.publicConsumerDogfood.validationRef,
    "train/v4/v4.0/public-consumer-self-dogfood",
  );
  assert.equal(
    architecture.publicConsumerDogfood.reusableWorkflow,
    "kungfu-systems/buildchain/.github/workflows/v4-stage-capsule-canary.yml",
  );
  assert.equal(
    architecture.publicConsumerDogfood.recursionRecovery,
    "public-train-ref-only",
  );
  assert.equal(
    architecture.publicConsumerDogfood.consumerOrchestrationCopied,
    false,
  );
  assert.equal(
    architecture.publicConsumerDogfood.relativeOrSelfInvocationAllowed,
    false,
  );
  assert.equal(
    architecture.publicConsumerDogfood.directQualificationInvocationAllowed,
    false,
  );
  assert.equal(
    architecture.publicConsumerDogfood.candidateBranchOverrideAllowed,
    false,
  );
  assert.equal(architecture.authority.providerEffects, false);
  assert.equal(architecture.authority.productionWrites, false);
  assert.equal(architecture.authority.productionReuse, false);
  assert.equal(architecture.authority.aws, false);
  assert.equal(architecture.authority.selfHostedRunners, false);
  assert.equal(architecture.budgets.providerSdkImports, 0);
  assert.equal(architecture.budgets.productionWriteAuthorityChanges, 0);

  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/verify.yml"),
    "utf8",
  );
  assert.doesNotMatch(workflow, /stage-capsule-qualification:/u);
  assert.doesNotMatch(workflow, /v4-stage-capsule-qualification\.mjs/u);
  assert.match(workflow, /needs: stage-capsule-checkpoints/u);
  assert.match(
    workflow,
    /run: node scripts\/check-v4-public-dogfood-contract\.mjs/u,
  );

  const canaryWorkflow = fs.readFileSync(
    path.join(root, ".github/workflows/v4-stage-capsule-canary.yml"),
    "utf8",
  );
  assert.match(canaryWorkflow, /workflow_call:/u);
  assert.match(
    canaryWorkflow,
    /BUILDCHAIN_WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/u,
  );
  assert.doesNotMatch(canaryWorkflow, /\$\{BUILDCHAIN_WORKFLOW_SHA,,\}/u);
  assert.equal(
    canaryWorkflow.match(/tr '\[:upper:\]' '\[:lower:\]'/gu)?.length,
    2,
  );
  assert.match(
    canaryWorkflow,
    /BUILDCHAIN_RUNTIME_SHA: \$\{\{ steps\.runtime\.outputs\.sha \}\}/u,
  );
  assert.match(canaryWorkflow, /CONSUMER_SOURCE_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(canaryWorkflow, /--runtime-ref "\$\{BUILDCHAIN_RUNTIME_SHA\}"/u);
  assert.match(
    canaryWorkflow,
    /--consumer-source-revision "\$\{CONSUMER_SOURCE_SHA\}"/u,
  );
  assert.match(canaryWorkflow, /defaults:\n      run:\n        shell: bash/u);
  for (const stage of ["install", "build", "verify"])
    assert.match(canaryWorkflow, new RegExp(`lifecycle run ${stage}`, "u"));
  assert.doesNotMatch(canaryWorkflow, /lifecycle run publish/u);
  assert.doesNotMatch(canaryWorkflow, /self-hosted|aws/i);
});

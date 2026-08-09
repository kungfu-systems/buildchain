#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  v4CanonicalBytes,
  v4ContentRoot,
} from "../packages/core/v4-canonical-contracts.js";
import { V4StageCapsuleLocalStore } from "../packages/core/v4-stage-capsule-local-store.js";
import {
  restoreV4PlatformStageCheckpoint,
  validateV4PlatformStageCheckpointDeclaration,
} from "../packages/core/v4-platform-stage-checkpoints.js";
import {
  V4_STAGE_CAPSULE_CAMPAIGN_RECORDED_AT,
  createV4StageCapsuleCampaignProfile,
  emitV4StageCapsuleCampaignCheckpoint,
  runV4StageCapsuleFaultCampaign,
  v4StageCapsuleCampaignAggregateRoots,
  v4StageCapsuleCampaignDependencies,
  v4StageCapsuleCampaignStages,
} from "../packages/core/v4-stage-capsule-qualification-campaign.js";
import {
  V4_STAGE_CAPSULE_PLATFORM_QUALIFICATION_CONTRACT,
  qualifyV4StageCapsuleCampaign,
  reconcileV4StageCapsuleWave,
  validateV4StageCapsulePlatformQualification,
} from "../packages/core/v4-stage-capsule-qualification.js";
import { planV4StageCapsuleResume } from "../packages/core/v4-stage-capsule-resume-planner.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptPath = fileURLToPath(import.meta.url);

function option(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, v4CanonicalBytes(value), { flag: "wx" });
}

function declaration() {
  return validateV4PlatformStageCheckpointDeclaration(
    readJson(
      path.join(repoRoot, "architecture/v4-platform-stage-checkpoints.json"),
    ),
  );
}

function contextFromArgs() {
  const context = {
    workRoot: path.resolve(required("work-root")),
    platform: required("platform"),
    consumer: required("consumer"),
    runtimeRef: required("runtime-ref"),
    consumerSourceRevision: required("consumer-source-revision"),
    lifecycleEvidenceRoot: option("lifecycle-evidence-root")
      ? path.resolve(option("lifecycle-evidence-root"))
      : "",
    repoRoot,
    declaration: declaration(),
  };
  if (!context.declaration.platforms.some(({ id }) => id === context.platform))
    throw new Error(`undeclared platform: ${context.platform}`);
  if (!/^[0-9a-f]{40}$/u.test(context.consumerSourceRevision))
    throw new Error("--consumer-source-revision must be an exact commit");
  return context;
}

function prepareContext(context) {
  context.campaignProfile = createV4StageCapsuleCampaignProfile(context);
  return context;
}

function directoryBytes(directory) {
  let total = 0;
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  };
  visit(directory);
  return total;
}

function seed(context) {
  prepareContext(context);
  const campaignStages = v4StageCapsuleCampaignStages(context);
  const retainedStages = campaignStages.slice(
    0,
    context.consumer === "buildchain-self-dogfood" ? 1 : 2,
  );
  const failedStage = "verify";
  const targetStage = campaignStages.at(-1);
  const referenceStore = new V4StageCapsuleLocalStore(
    path.join(context.workRoot, "reference-store"),
  );
  const retainedStore = new V4StageCapsuleLocalStore(
    path.join(context.workRoot, "retained-store"),
  );
  const reference = campaignStages.map((stage) => ({
    stage,
    ...emitV4StageCapsuleCampaignCheckpoint(context, stage, referenceStore),
  }));
  const retained = retainedStages.map((stage) => ({
    stage,
    ...emitV4StageCapsuleCampaignCheckpoint(context, stage, retainedStore),
  }));
  const lateFailure = emitV4StageCapsuleCampaignCheckpoint(
    context,
    failedStage,
    retainedStore,
    "failure",
  );
  if (lateFailure.emitted !== false)
    throw new Error("late failure emitted a capsule");
  const body = {
    schema: "buildchain-v4-stage-capsule-seed-evidence/v1",
    consumer: context.consumer,
    platform: context.platform,
    runtimeRef: context.runtimeRef,
    campaignProfileRoot: context.campaignProfile.profileRoot,
    referenceRoots: v4StageCapsuleCampaignAggregateRoots(reference),
    retainedCapsuleRoots: retained.map(({ stage, capsule }) => ({
      stage,
      capsuleRoot: capsule.capsuleRoot,
    })),
    failedStage,
    failedStageCapsuleEmitted: false,
    retainedBytes: directoryBytes(
      path.join(context.workRoot, "retained-store"),
    ),
    productionAuthority: "v3",
    productionWrites: false,
  };
  const evidence = {
    ...body,
    evidenceRoot: v4ContentRoot("stage-capsule-seed-evidence", body),
  };
  writeJson(path.join(context.workRoot, "seed-evidence.json"), evidence);
  writeJson(path.join(context.workRoot, "campaign-state.json"), {
    schema: "buildchain-v4-stage-capsule-campaign-state/v1",
    consumer: context.consumer,
    platform: context.platform,
    runtimeRef: context.runtimeRef,
    consumerSourceRevision: context.consumerSourceRevision,
    campaignProfileRoot: context.campaignProfile.profileRoot,
    campaignStages,
    dependencies: Object.fromEntries(
      campaignStages.map((stage) => [
        stage,
        v4StageCapsuleCampaignDependencies(context, stage),
      ]),
    ),
    retainedStages,
    failedStage,
    targetStage,
    reference: reference.map(({ stage, capsule, manifest }) => ({
      stage,
      capsule,
      manifest,
    })),
    seedEvidenceRoot: evidence.evidenceRoot,
    retainedBytes: evidence.retainedBytes,
  });
}

function stageNode(state, store, reference) {
  let candidate = null;
  if (state.retainedStages.includes(reference.stage)) {
    const restored = store.restore({
      capsuleRoot: reference.capsule.capsuleRoot,
      recordedAt: V4_STAGE_CAPSULE_CAMPAIGN_RECORDED_AT,
    });
    candidate = {
      capsule: restored.capsule,
      availability: restored.availability,
    };
  }
  return {
    key: reference.stage,
    dependencies: state.dependencies[reference.stage],
    expectedIdentity: reference.capsule.identity,
    expectedRetentionPromise: reference.capsule.retentionPromise,
    candidate,
  };
}

function resumeRequest(state, store) {
  return {
    schema: "buildchain-v4-stage-capsule-resume-request/v1",
    evaluatedAt: V4_STAGE_CAPSULE_CAMPAIGN_RECORDED_AT,
    nodes: state.reference.map((reference) =>
      stageNode(state, store, reference),
    ),
    targets: [state.targetStage],
    effects: [],
  };
}

function emitMissing(context, state, store, stageId) {
  const emitted = emitV4StageCapsuleCampaignCheckpoint(context, stageId, store);
  const expected = state.reference.find(({ stage }) => stage === stageId);
  if (
    emitted.capsule.capsuleRoot !== expected.capsule.capsuleRoot ||
    emitted.manifest.manifestRoot !== expected.manifest.manifestRoot
  )
    throw new Error(`resumed ${stageId} differs from the fresh build`);
  return {
    stage: stageId,
    capsule: emitted.capsule,
    manifest: emitted.manifest,
  };
}

function resume(context) {
  prepareContext(context);
  const state = readJson(path.join(context.workRoot, "campaign-state.json"));
  for (const name of [
    "consumer",
    "platform",
    "runtimeRef",
    "consumerSourceRevision",
  ])
    if (state[name] !== context[name])
      throw new Error(`campaign ${name} mismatch`);
  if (state.campaignProfileRoot !== context.campaignProfile.profileRoot)
    throw new Error("campaign lifecycle profile mismatch");
  const store = new V4StageCapsuleLocalStore(
    path.join(context.workRoot, "retained-store"),
  );
  const request = resumeRequest(state, store);
  const plan = planV4StageCapsuleResume(request);
  const expectedRestores = [state.retainedStages.at(-1)];
  const expectedStages = state.campaignStages.filter(
    (stage) => !state.retainedStages.includes(stage),
  );
  if (
    JSON.stringify(plan.requiredRestores) !==
      JSON.stringify(expectedRestores) ||
    JSON.stringify(plan.requiredStages) !== JSON.stringify(expectedStages)
  )
    throw new Error(
      `resume planner did not select the minimal recovery set: ${JSON.stringify(
        {
          requiredRestores: plan.requiredRestores,
          requiredStages: plan.requiredStages,
          decisions: plan.decisions.map(
            ({ stageKey, decision, reasonCode }) => ({
              stageKey,
              decision,
              reasonCode,
            }),
          ),
        },
      )}`,
    );
  const started = process.hrtime.bigint();
  for (const stageId of plan.requiredRestores) {
    const reference = state.reference.find(({ stage }) => stage === stageId);
    restoreV4PlatformStageCheckpoint({
      declaration: context.declaration,
      expectedPlatform: context.platform,
      expectedStage: stageId,
      capsuleRoot: reference.capsule.capsuleRoot,
      recordedAt: V4_STAGE_CAPSULE_CAMPAIGN_RECORDED_AT,
      targetDirectory: path.join(context.workRoot, "restored", stageId),
      store,
    });
  }
  const restoreOverheadMs = Number(
    (process.hrtime.bigint() - started) / 1000000n,
  );
  const rebuilt = plan.requiredStages.map((stageId) =>
    emitMissing(context, state, store, stageId),
  );
  const retained = state.reference
    .filter(({ stage }) => state.retainedStages.includes(stage))
    .map(({ stage, capsule, manifest }) => ({ stage, capsule, manifest }));
  const resumedEntries = [...retained, ...rebuilt].sort(
    (left, right) =>
      state.campaignStages.indexOf(left.stage) -
      state.campaignStages.indexOf(right.stage),
  );
  const freshBuild = v4StageCapsuleCampaignAggregateRoots(state.reference);
  const resumedBuild = v4StageCapsuleCampaignAggregateRoots(resumedEntries);
  const campaignFaults = runV4StageCapsuleFaultCampaign(request);
  const metrics = {
    fullStageCount: state.campaignStages.length,
    rebuiltStageCount: plan.requiredStages.length,
    retainedStageCount: retained.length,
    restoredStageCount: plan.requiredRestores.length,
    retainedBytes: state.retainedBytes,
    restoreOverheadMs,
    falseReuseCount: campaignFaults.filter(
      ({ expected, actual }) => expected !== "reuse" && actual === "reuse",
    ).length,
    falseRebuildCount: campaignFaults.filter(
      ({ expected, actual }) => expected === "reuse" && actual !== "reuse",
    ).length,
    plannerAccurate: campaignFaults.every(({ passed }) => passed),
  };
  const resumeBody = {
    schema: "buildchain-v4-stage-capsule-resume-evidence/v1",
    platform: context.platform,
    consumer: context.consumer,
    planRoot: plan.planRoot,
    freshBuild,
    resumedBuild,
    faultCampaignRoot: v4ContentRoot(
      "stage-capsule-fault-campaign",
      campaignFaults,
    ),
    metrics,
  };
  const resumeEvidence = {
    ...resumeBody,
    evidenceRoot: v4ContentRoot("stage-capsule-resume-evidence", resumeBody),
  };
  const reportBody = {
    schema: V4_STAGE_CAPSULE_PLATFORM_QUALIFICATION_CONTRACT,
    mode: "shadow-only",
    productionAuthority: "v3",
    consumer: context.consumer,
    platform: context.platform,
    runtimeRef: context.runtimeRef,
    campaignProfileRoot: context.campaignProfile.profileRoot,
    processRuns: [
      {
        id: "seed",
        outcome: "late-failure",
        evidenceRoot: state.seedEvidenceRoot,
      },
      {
        id: "resume",
        outcome: "qualified",
        evidenceRoot: resumeEvidence.evidenceRoot,
      },
    ],
    freshBuild,
    resumedBuild,
    resumePlan: {
      planRoot: plan.planRoot,
      requiredRestores: plan.requiredRestores,
      requiredStages: plan.requiredStages,
    },
    faultCampaign: campaignFaults,
    metrics,
    rollback: {
      switch: "stage-capsule-mode=v3",
      productionAuthority: "v3",
      migrationRequired: false,
      retainedStateDestroyed: false,
    },
    providerEffects: false,
    productionWrites: false,
  };
  const report = validateV4StageCapsulePlatformQualification({
    ...reportBody,
    reportRoot: v4ContentRoot(
      "stage-capsule-platform-qualification",
      reportBody,
    ),
  });
  writeJson(
    path.join(context.workRoot, "resume-evidence.json"),
    resumeEvidence,
  );
  writeJson(path.join(context.workRoot, "report.json"), report);
  process.stdout.write(v4CanonicalBytes(report));
}

function child(action, context) {
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      action,
      "--work-root",
      context.workRoot,
      "--platform",
      context.platform,
      "--consumer",
      context.consumer,
      "--runtime-ref",
      context.runtimeRef,
      "--consumer-source-revision",
      context.consumerSourceRevision,
      ...(context.lifecycleEvidenceRoot
        ? ["--lifecycle-evidence-root", context.lifecycleEvidenceRoot]
        : []),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(
      `${action} child failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

function campaign(context) {
  if (option("stage-capsule-mode", "shadow") === "v3") {
    process.stdout.write(
      v4CanonicalBytes({
        schema: "buildchain-v4-stage-capsule-rollback/v1",
        switch: "stage-capsule-mode=v3",
        productionAuthority: "v3",
        migrationRequired: false,
        retainedStateDestroyed: false,
        productionWrites: false,
      }),
    );
    return;
  }
  fs.mkdirSync(context.workRoot, { recursive: true });
  child("seed", context);
  process.stdout.write(child("resume", context));
}

function reportFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "report.json")
        files.push(target);
    }
  };
  visit(directory);
  return files.sort();
}

function aggregate() {
  const directory = path.resolve(required("input-dir"));
  const reports = reportFiles(directory)
    .map(readJson)
    .sort((left, right) =>
      `${left.consumer}/${left.platform}`.localeCompare(
        `${right.consumer}/${right.platform}`,
        "en",
      ),
    );
  const qualification = qualifyV4StageCapsuleCampaign(reports);
  const output = option("output");
  if (output) writeJson(path.resolve(output), qualification);
  process.stdout.write(v4CanonicalBytes(qualification));
}

function reconcile() {
  const qualification = readJson(path.resolve(required("qualification")));
  const request = readJson(path.resolve(required("wave-evidence")));
  if (request.qualificationRoot !== qualification.qualificationRoot)
    throw new Error("wave evidence does not bind the qualification root");
  const reconciliation = reconcileV4StageCapsuleWave(request);
  const output = option("output");
  if (output) writeJson(path.resolve(output), reconciliation);
  process.stdout.write(v4CanonicalBytes(reconciliation));
}

const action = process.argv[2] || "";
if (action === "seed") seed(contextFromArgs());
else if (action === "resume") resume(contextFromArgs());
else if (action === "campaign") campaign(contextFromArgs());
else if (action === "aggregate") aggregate();
else if (action === "reconcile") reconcile();
else if (action === "smoke") {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-capsule-"),
  );
  const context = contextFromArgs();
  context.workRoot = temporary;
  campaign(context);
} else {
  throw new Error(
    "action must be seed, resume, campaign, aggregate, reconcile, or smoke",
  );
}

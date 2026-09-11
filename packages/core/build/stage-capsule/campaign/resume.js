import path from "node:path";
import {
  ContractFault,
  domainCanonicalBytes,
  domainContentRoot,
} from "../../../contracts/canonical-contracts.js";
import { StageCapsuleLocalStore } from "../../stage-capsule-local-store.js";
import {
  restorePlatformStageCheckpoint,
  validatePlatformStageCheckpointDeclaration,
} from "../../platform-stage-checkpoints.js";
import {
  STAGE_CAPSULE_CAMPAIGN_RECORDED_AT,
  createStageCapsuleCampaignProfile,
  emitStageCapsuleCampaignCheckpoint,
  runStageCapsuleFaultCampaign,
  stageCapsuleCampaignAggregateRoots,
  stageCapsuleCampaignDependencies,
  stageCapsuleCampaignStages,
} from "../../stage-capsule-qualification-campaign.js";
import {
  STAGE_CAPSULE_PLATFORM_QUALIFICATION_CONTRACT,
  qualifyStageCapsuleCampaign,
  reconcileStageCapsuleWave,
  validateStageCapsulePlatformQualification,
} from "../../stage-capsule-qualification.js";
import { planStageCapsuleResume } from "../../stage-capsule-resume-planner.js";

import { prepareCampaignContext, readJson, writeJson } from "./context.js";
function stageNode(state, store, reference) {
  let candidate = null;
  if (state.retainedStages.includes(reference.stage)) {
    const restored = store.restore({
      capsuleRoot: reference.capsule.capsuleRoot,
      recordedAt: STAGE_CAPSULE_CAMPAIGN_RECORDED_AT,
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
    evaluatedAt: STAGE_CAPSULE_CAMPAIGN_RECORDED_AT,
    nodes: state.reference.map((reference) =>
      stageNode(state, store, reference),
    ),
    targets: [state.targetStage],
    effects: [],
  };
}

function checkpointResult(entry) {
  const { runtimeRoot: _runtimeProvenance, ...identity } =
    entry.capsule.identity;
  return domainCanonicalBytes({
    identity,
    manifestRoot: entry.manifest.manifestRoot,
  }).toString("utf8");
}

function emitMissing(context, state, store, stageId) {
  const emitted = emitStageCapsuleCampaignCheckpoint(context, stageId, store);
  const expected = state.reference.find(({ stage }) => stage === stageId);
  if (checkpointResult(emitted) !== checkpointResult(expected))
    throw new Error(`resumed ${stageId} differs from the fresh build`);
  return {
    stage: stageId,
    capsule: emitted.capsule,
    manifest: emitted.manifest,
  };
}

export function resumeStageCapsuleCampaign(context) {
  prepareCampaignContext(context);
  const state = readJson(path.join(context.workRoot, "campaign-state.json"));
  for (const [name, code] of [
    ["consumer", "stage-capsule-campaign-consumer-drift"],
    ["platform", "stage-capsule-campaign-platform-drift"],
    ["consumerSourceRevision", "stage-capsule-campaign-source-revision-drift"],
  ])
    if (state[name] !== context[name])
      throw new ContractFault(code, `$/campaign/${name}`, `${name} differs`);
  if (state.campaignProfileRoot !== context.campaignProfile.profileRoot)
    throw new ContractFault(
      "stage-capsule-campaign-lifecycle-profile-drift",
      "$/campaign/campaignProfileRoot",
      "campaign lifecycle profile differs",
    );
  const store = new StageCapsuleLocalStore(
    path.join(context.workRoot, "retained-store"),
  );
  const request = resumeRequest(state, store);
  const plan = planStageCapsuleResume(request);
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
    restorePlatformStageCheckpoint({
      declaration: context.declaration,
      expectedPlatform: context.platform,
      expectedStage: stageId,
      capsuleRoot: reference.capsule.capsuleRoot,
      recordedAt: STAGE_CAPSULE_CAMPAIGN_RECORDED_AT,
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
  const freshBuild = stageCapsuleCampaignAggregateRoots(state.reference);
  const resumedBuild = stageCapsuleCampaignAggregateRoots(resumedEntries);
  const campaignFaults = runStageCapsuleFaultCampaign(request);
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
    faultCampaignRoot: domainContentRoot(
      "stage-capsule-fault-campaign",
      campaignFaults,
    ),
    metrics,
  };
  const resumeEvidence = {
    ...resumeBody,
    evidenceRoot: domainContentRoot(
      "stage-capsule-resume-evidence",
      resumeBody,
    ),
  };
  const reportBody = {
    schema: STAGE_CAPSULE_PLATFORM_QUALIFICATION_CONTRACT,
    mode: "shadow-only",
    productionAuthority: "v4-native",
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
      switch: "stage-capsule-mode=disabled",
      productionAuthority: "v4-native",
      migrationRequired: false,
      retainedStateDestroyed: false,
    },
    providerEffects: false,
    productionWrites: false,
  };
  const report = validateStageCapsulePlatformQualification({
    ...reportBody,
    reportRoot: domainContentRoot(
      "stage-capsule-platform-qualification",
      reportBody,
    ),
  });
  writeJson(
    path.join(context.workRoot, "resume-evidence.json"),
    resumeEvidence,
  );
  writeJson(path.join(context.workRoot, "report.json"), report);
  return report;
}

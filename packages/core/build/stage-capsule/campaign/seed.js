import fs from "node:fs";
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

import { prepareCampaignContext, writeJson } from "./context.js";
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

export function seedStageCapsuleCampaign(context) {
  prepareCampaignContext(context);
  const campaignStages = stageCapsuleCampaignStages(context);
  const retainedStages = campaignStages.slice(
    0,
    Math.max(1, campaignStages.indexOf("verify")),
  );
  const failedStage = "verify";
  const targetStage = campaignStages.at(-1);
  const referenceStore = new StageCapsuleLocalStore(
    path.join(context.workRoot, "reference-store"),
  );
  const retainedStore = new StageCapsuleLocalStore(
    path.join(context.workRoot, "retained-store"),
  );
  const reference = campaignStages.map((stage) => ({
    stage,
    ...emitStageCapsuleCampaignCheckpoint(context, stage, referenceStore),
  }));
  const retained = retainedStages.map((stage) => ({
    stage,
    ...emitStageCapsuleCampaignCheckpoint(context, stage, retainedStore),
  }));
  const lateFailure = emitStageCapsuleCampaignCheckpoint(
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
    referenceRoots: stageCapsuleCampaignAggregateRoots(reference),
    retainedCapsuleRoots: retained.map(({ stage, capsule }) => ({
      stage,
      capsuleRoot: capsule.capsuleRoot,
    })),
    failedStage,
    failedStageCapsuleEmitted: false,
    retainedBytes: directoryBytes(
      path.join(context.workRoot, "retained-store"),
    ),
    productionAuthority: "v4-native",
    productionWrites: false,
  };
  const evidence = {
    ...body,
    evidenceRoot: domainContentRoot("stage-capsule-seed-evidence", body),
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
        stageCapsuleCampaignDependencies(context, stage),
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

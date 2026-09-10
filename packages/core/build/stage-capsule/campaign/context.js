import fs from "node:fs";
import path from "node:path";
import { domainCanonicalBytes } from "../../../contracts/canonical-contracts.js";
import { validatePlatformStageCheckpointDeclaration } from "../../platform-stage-checkpoints.js";
import { loadBuildchainConfig } from "../../../consumer/buildchain-config.js";
import { createStageCapsuleCampaignProfile } from "../../stage-capsule-qualification-campaign.js";
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, domainCanonicalBytes(value), { flag: "wx" });
}
export function createCampaignContext({
  workRoot,
  platform,
  consumer,
  runtimeRef,
  consumerSourceRevision,
  lifecycleEvidenceRoot = "",
  consumerRoot,
  runtimeRoot,
}) {
  const declaration = validatePlatformStageCheckpointDeclaration(
    readJson(
      path.join(runtimeRoot, "architecture/platform-stage-checkpoints.json"),
    ),
  );
  if (!declaration.platforms.some(({ id }) => id === platform))
    throw new Error(`undeclared platform: ${platform}`);
  if (!/^[0-9a-f]{40}$/u.test(consumerSourceRevision))
    throw new Error("consumer source revision must be an exact commit");
  return {
    workRoot: path.resolve(workRoot),
    platform,
    consumer,
    runtimeRef,
    consumerSourceRevision,
    lifecycleEvidenceRoot: lifecycleEvidenceRoot
      ? path.resolve(lifecycleEvidenceRoot)
      : "",
    consumerRoot: path.resolve(consumerRoot),
    repoRoot: runtimeRoot,
    declaration,
  };
}
export function prepareCampaignContext(context) {
  context.lifecycleConfig = loadBuildchainConfig(context.consumerRoot);
  context.campaignProfile = createStageCapsuleCampaignProfile(context);
  return context;
}

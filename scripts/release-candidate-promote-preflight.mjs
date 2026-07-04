#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  readReleaseCandidateBundle,
  validateReleaseCandidateForPromotion,
} from "./release-candidate-core.mjs";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

export function releaseCandidatePromotePreflightCli() {
  const passportPath = readEnv("BUILDCHAIN_RC_PASSPORT");
  const buildSummaryPath = readEnv("BUILDCHAIN_RC_BUILD_SUMMARY", "");
  const { passport, buildSummary } = readReleaseCandidateBundle({ passportPath, buildSummaryPath });
  const result = validateReleaseCandidateForPromotion({
    passport,
    buildSummary,
    promotionChannelSha: readEnv("BUILDCHAIN_PROMOTION_CHANNEL_SHA"),
    promotionChannelTreeSha: readEnv("BUILDCHAIN_PROMOTION_CHANNEL_TREE_SHA"),
    targetRef: readEnv("BUILDCHAIN_TARGET_REF"),
    publishGateRef: readEnv("BUILDCHAIN_PUBLISH_GATE_REF"),
    publishGateSha: readEnv("BUILDCHAIN_PUBLISH_GATE_SHA"),
    expectedVersion: readEnv("BUILDCHAIN_VERSION"),
    requiredArtifactCount: Number(readEnv("BUILDCHAIN_REQUIRED_ARTIFACT_COUNT", "0")),
  });
  const outputPath = readEnv("BUILDCHAIN_RC_PREFLIGHT_OUTPUT", "");
  if (outputPath) {
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  writeGitHubOutputs({
    "release-candidate-ok": String(result.ok),
    "release-candidate-version": passport.releaseIntent?.version || "",
    "built-source-sha": result.builtSourceSha,
    "built-source-tree-sha": result.builtSourceTreeSha,
    "promotion-channel-sha": result.promotionChannelSha,
    "promotion-channel-tree-sha": result.promotionChannelTreeSha,
    "tree-equivalent": String(result.treeEquivalent),
    "platform-count": String(result.platformCount),
  });
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    releaseCandidatePromotePreflightCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}

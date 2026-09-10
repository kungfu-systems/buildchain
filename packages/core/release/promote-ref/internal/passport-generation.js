import path from "node:path";
import {
  BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
  BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH,
  BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH,
  BUILDCHAIN_KFD2_CLAIMS_DIR,
} from "../../../contracts/buildchain-layout.js";
import {
  createBuildchainKfd1Witness,
  createBuildchainKfd3PrebuildWitness,
  createBuildchainKfd3ArtifactWitness,
  createBuildchainKfd2Claims,
} from "../../../adoption/buildchain-kfd-claims.js";
import {
  writeJsonFile,
  toRepoRelative,
  existingJsonObjectFile,
  verifyCollectedReleasePassport,
  releasePassportArtifactFiles,
  backfillReleasePassportStateSha,
} from "./passport-files.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import {
  resolveMaybeRelative,
  existingFiles,
  platformManifestPathsFromBuildSummary,
} from "./npm-distribution.js";
import {
  loadConfiguredAnchorManifest,
  loadBuildchainConfig,
} from "../../../consumer/buildchain-config.js";
import { stripTagPrefix } from "./promotion-policy.js";
import {
  createTreeEquivalentReleaseImpact,
  resolveReleaseImpactInput,
} from "../../version-state.js";
import { publicReleaseTagForTransaction } from "./transaction-recovery.js";
import { collectGitHubReleasePassport } from "../../passport/collection.js";
import { persistDurableReleaseTransaction } from "./durable-transaction-store.js";
import {
  writeReleaseTransaction,
  transitionReleaseTransaction,
} from "../../publish-transaction.js";
import { persistTransactionResult } from "./publish-transaction.js";
export function generateBuildchainSelfKfdInputs({
  cwd,
  outputDir = ".buildchain/kfd",
  sourceSha = "",
} = {}) {
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const outputPath = (canonicalPath) =>
    path.join(
      resolvedOutputDir,
      path.relative(".buildchain/kfd", canonicalPath),
    );
  const paths = {
    kfd1Witness: outputPath(BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH),
    kfd3PrebuildWitness: outputPath(BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH),
    kfd3ArtifactWitness: outputPath(BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH),
    kfd2ClaimsDir: outputPath(BUILDCHAIN_KFD2_CLAIMS_DIR),
  };
  writeJsonFile(
    paths.kfd1Witness,
    createBuildchainKfd1Witness({ root: cwd, sourceSha }),
  );
  writeJsonFile(
    paths.kfd3PrebuildWitness,
    createBuildchainKfd3PrebuildWitness({ root: cwd, sourceSha }),
  );
  writeJsonFile(
    paths.kfd3ArtifactWitness,
    createBuildchainKfd3ArtifactWitness({ root: cwd, sourceSha }),
  );
  const witnessFiles = {
    "kfd-1-witness": toRepoRelative(cwd, paths.kfd1Witness),
    "kfd-3-prebuild-witness": toRepoRelative(cwd, paths.kfd3PrebuildWitness),
    "kfd-3-artifact-witness": toRepoRelative(cwd, paths.kfd3ArtifactWitness),
  };
  const kfd2ClaimJsons = createBuildchainKfd2Claims({
    root: cwd,
    witnessFiles,
  }).map((claim) => {
    const slug =
      String(claim.id || "claim")
        .replace(/^claim:/, "")
        .replace(/[^0-9A-Za-z._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "claim";
    return writeJsonFile(path.join(paths.kfd2ClaimsDir, `${slug}.json`), claim);
  });
  return {
    kfd1WitnessJsons: [paths.kfd1Witness],
    kfd2ClaimJsons,
    kfd3PrebuildWitnessJsons: [paths.kfd3PrebuildWitness],
    kfd3ArtifactWitnessJsons: [paths.kfd3ArtifactWitness],
  };
}
export function generateReleaseEvidenceInputs({
  command,
  cwd,
  sourceSha,
  tag,
  channel,
  version,
  deploymentCoordinate,
  targetRef,
  outputDir,
  extraEnv = {},
}) {
  if (!command) {
    return [];
  }
  let parsed;
  try {
    const output = execSync(command, {
      cwd,
      env: {
        ...process.env,
        BUILDCHAIN_RELEASE_SOURCE_SHA: sourceSha,
        BUILDCHAIN_RELEASE_TAG: tag,
        BUILDCHAIN_RELEASE_CHANNEL: channel,
        BUILDCHAIN_RELEASE_VERSION: version,
        BUILDCHAIN_RELEASE_DEPLOYMENT_COORDINATE: deploymentCoordinate,
        BUILDCHAIN_RELEASE_TARGET_REF: targetRef,
        BUILDCHAIN_RELEASE_PASSPORT_OUTPUT_DIR: outputDir,
        ...extraEnv,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    parsed = JSON.parse(output);
  } catch (error) {
    const message = error.stderr?.toString?.().trim() || error.message;
    throw new Error(`release passport attachment command failed: ${message}`);
  }
  const files = Array.isArray(parsed) ? parsed : parsed?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      "release passport attachment command must emit a JSON array or an object with a non-empty files array",
    );
  }
  return files.map((file, index) => {
    const normalized = String(file || "").trim();
    const resolved = normalized ? resolveMaybeRelative(cwd, normalized) : "";
    if (
      !resolved ||
      !fs.existsSync(resolved) ||
      !fs.statSync(resolved).isFile()
    ) {
      throw new Error(
        `release passport attachment command files[${index}] does not exist: ${normalized || "<empty>"}`,
      );
    }
    return resolved;
  });
}
export function normalizeReleasePassportOptions(options) {
  const normalized = { ...options };
  const defaults = {
    platformManifestPaths: [],
    impactJson: "",
    promotionRoutingJson: "",
    v4ConsumerPolicyCertificationJson: "",
    v4ConsumerPolicyCertificationRoot: "",
    v4RuntimeResumeEvidenceJson: "",
    v4RuntimeResumeEvidenceCommand: "",
    kfd1WitnessJsons: [],
    kfd2ClaimJsons: [],
    kfd3PrebuildWitnessJsons: [],
    kfd3ArtifactWitnessJsons: [],
    kfd3ArtifactVerifyCommand: "",
    kfdAdopterManifestJson: "",
    kfdSupportMatrixJson: "",
    kfdProductGateJsons: [],
    invariantPassportJsons: [],
    invariantPassportCommand: "",
    releaseEvidenceJsons: [],
    releaseEvidenceCommand: "",
    buildchainSelfKfd: false,
    githubArtifactAttestationPolicyJsons: [],
    enabled: true,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (normalized[key] === undefined) normalized[key] = value;
  }
  if (normalized.v4RuntimeResumeEvidenceCommandCwd === undefined) {
    normalized.v4RuntimeResumeEvidenceCommandCwd = normalized.cwd;
  }
  return normalized;
}
export function parsePromotionRouting(cwd, value) {
  if (!String(value || "").trim()) return undefined;
  const candidate = resolveMaybeRelative(cwd, value);
  return fs.existsSync(candidate)
    ? JSON.parse(fs.readFileSync(candidate, "utf8"))
    : JSON.parse(value);
}
export function configuredOrGenerated(configured, generated = []) {
  return configured.length > 0 ? configured : generated;
}
export function prepareReleasePassport(options) {
  const result = options.result;
  const resolvedOutputDir = path.resolve(
    options.cwd,
    options.outputDir || ".buildchain/release-passport",
  );
  const resolvedBuildSummary = options.buildSummaryPath
    ? resolveMaybeRelative(options.cwd, options.buildSummaryPath)
    : path.resolve(options.cwd, ".buildchain/artifacts/build-summary.json");
  const buildSummaryJson = existingJsonObjectFile(resolvedBuildSummary);
  const configuredManifests = existingFiles(
    options.platformManifestPaths,
    options.cwd,
  );
  const derivedManifests = buildSummaryJson
    ? platformManifestPathsFromBuildSummary(buildSummaryJson, options.cwd)
    : [];
  const platformManifests = [
    ...new Set([...configuredManifests, ...derivedManifests]),
  ];
  const anchorManifest = loadConfiguredAnchorManifest(
    options.cwd,
    loadBuildchainConfig(options.cwd),
  );
  const anchorManifestPath = anchorManifest?.path
    ? path.resolve(options.cwd, anchorManifest.path)
    : "";
  const passportSourceSha = result.transaction.source_sha || options.sourceSha;
  const internalVersion = stripTagPrefix(result.transaction.exact_tag || "");
  const publishedVersion = result.transaction.version || internalVersion;
  const publicReleaseTag = publicReleaseTagForTransaction(result.transaction);
  const releaseCoordinates = {
    sourceSha: passportSourceSha,
    tag: publicReleaseTag,
    channel: options.channel,
    version: publishedVersion,
    deploymentCoordinate: `github-release:${options.owner}/${options.repo}@${publicReleaseTag}`,
    targetRef: options.targetRef,
    outputDir: resolvedOutputDir,
  };
  const generatedReleaseEvidenceJsons = generateReleaseEvidenceInputs({
    command: options.releaseEvidenceCommand,
    cwd: options.cwd,
    ...releaseCoordinates,
  });
  const generatedRuntimeResumeEvidence = generateReleaseEvidenceInputs({
    command: options.v4RuntimeResumeEvidenceCommand,
    cwd: options.v4RuntimeResumeEvidenceCommandCwd,
    ...releaseCoordinates,
    extraEnv: {
      BUILDCHAIN_V4_RUNTIME_RESUME_MATERIAL: path.resolve(
        options.v4RuntimeResumeEvidenceCommandCwd,
        ".buildchain/release-candidate/runtime-resume-material.json",
      ),
      BUILDCHAIN_RELEASE_TRANSACTION_JSON: JSON.stringify(result.transaction),
    },
  });
  if (generatedRuntimeResumeEvidence.length > 1) {
    throw new Error(
      "v4 runtime resume finalization must emit exactly one evidence file",
    );
  }
  const inferredImpactJson = createTreeEquivalentReleaseImpact({
    channel: options.channel,
    version: publishedVersion,
    tag: publicReleaseTag,
    line: options.line,
    releaseCandidateValidation: options.releaseCandidateValidation,
  });
  const resolvedImpactJson = resolveReleaseImpactInput({
    cwd: options.cwd,
    impactJson: String(options.impactJson || "").trim() || inferredImpactJson,
    version: publishedVersion,
    line: options.line,
  });
  const selfKfd = options.buildchainSelfKfd
    ? generateBuildchainSelfKfdInputs({
        cwd: options.cwd,
        sourceSha: passportSourceSha,
      })
    : undefined;
  return {
    resolvedOutputDir,
    buildSummaryJson,
    platformManifests,
    anchorManifestPath,
    passportSourceSha,
    internalVersion,
    publishedVersion,
    publicReleaseTag,
    generatedReleaseEvidenceJsons,
    generatedRuntimeResumeEvidence,
    resolvedImpactJson,
    promotionRouting: parsePromotionRouting(
      options.cwd,
      options.promotionRoutingJson,
    ),
    resolvedKfd1WitnessJsons: configuredOrGenerated(
      options.kfd1WitnessJsons,
      selfKfd?.kfd1WitnessJsons,
    ),
    resolvedKfd2ClaimJsons: configuredOrGenerated(
      options.kfd2ClaimJsons,
      selfKfd?.kfd2ClaimJsons,
    ),
    resolvedKfd3PrebuildWitnessJsons: configuredOrGenerated(
      options.kfd3PrebuildWitnessJsons,
      selfKfd?.kfd3PrebuildWitnessJsons,
    ),
    resolvedKfd3ArtifactWitnessJsons: configuredOrGenerated(
      options.kfd3ArtifactWitnessJsons,
      selfKfd?.kfd3ArtifactWitnessJsons,
    ),
  };
}
export function trustedPublishingJson(result) {
  if (result.publishContract?.auth !== "trusted-publishing") return "";
  return JSON.stringify({
    provider: "npm",
    enabled: true,
    auth: "trusted-publishing",
    workflowRunId: result.transaction.run_id || "",
  });
}
export function releasePassportExtra(options, material) {
  const validation = options.releaseCandidateValidation;
  return JSON.stringify({
    channel: options.channel,
    targetRef: options.targetRef,
    publicTag: material.publicReleaseTag,
    internalTag: options.result.transaction.exact_tag,
    internalVersion: material.internalVersion,
    publishedVersion: material.publishedVersion,
    versionLabel:
      material.publishedVersion || options.result.transaction.exact_tag,
    releaseSha: options.result.transaction.release_sha,
    releaseMaterialSha: options.result.transaction.release_material_sha,
    ...(validation
      ? {
          builtSourceSha: validation.builtSourceSha,
          builtSourceTreeSha: validation.builtSourceTreeSha,
          promotionChannelSha: validation.promotionChannelSha,
          promotionChannelTreeSha: validation.promotionChannelTreeSha,
          treeEquivalent: validation.treeEquivalent,
          ...(validation.gateProfileEvidence
            ? { gateProfileEvidence: validation.gateProfileEvidence }
            : {}),
        }
      : {}),
    publishToolingSha: options.result.transaction.publish_tooling_sha,
    releaseStateRef: `refs/heads/${options.result.transaction.state_ref}`,
    ...(material.promotionRouting
      ? { promotionRouting: material.promotionRouting }
      : {}),
  });
}
export function releasePassportWorkflow(result) {
  return {
    name: process.env.GITHUB_WORKFLOW || "",
    runId: result.transaction.run_id || "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    url:
      process.env.GITHUB_SERVER_URL &&
      process.env.GITHUB_REPOSITORY &&
      result.transaction.run_id
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${result.transaction.run_id}`
        : "",
    runnerKind: process.env.BUILDCHAIN_RUNNER_KIND || "github-hosted",
    runnerOs: process.env.RUNNER_OS || process.platform,
    runnerArch: process.env.RUNNER_ARCH || process.arch,
    runnerImage: process.env.ImageOS || "",
  };
}
export function collectReleasePassport(options, material) {
  const result = options.result;
  const transactionJson = {
    command: "finalize",
    transaction: result.transaction,
    validation: result.validation || { valid: true, errors: [] },
  };
  return collectGitHubReleasePassport({
    cwd: options.cwd,
    tag: material.publicReleaseTag,
    repository: `${options.owner}/${options.repo}`,
    sourceSha: material.passportSourceSha,
    line: options.line,
    outputDir: material.resolvedOutputDir,
    productName: options.productName || "Buildchain",
    packageName:
      options.packageName ||
      result.packageSet?.main?.name ||
      "@kungfu-tech/buildchain",
    packageVersion: result.transaction.version,
    packageSetJson: result.packageSet ? JSON.stringify(result.packageSet) : "",
    publishEvidenceJson: result.evidencePath,
    trustedPublishingJson: trustedPublishingJson(result),
    transactionJson: JSON.stringify(transactionJson),
    anchorManifestJson:
      material.anchorManifestPath && fs.existsSync(material.anchorManifestPath)
        ? material.anchorManifestPath
        : "",
    versionMaterialJson: result.versionMaterial
      ? JSON.stringify(result.versionMaterial)
      : "",
    impactJson: material.resolvedImpactJson,
    kfd1WitnessJsons: material.resolvedKfd1WitnessJsons,
    kfd2ClaimJsons: material.resolvedKfd2ClaimJsons,
    kfd3PrebuildWitnessJsons: material.resolvedKfd3PrebuildWitnessJsons,
    kfd3ArtifactWitnessJsons: material.resolvedKfd3ArtifactWitnessJsons,
    kfd3ArtifactVerifyCommand: options.kfd3ArtifactVerifyCommand,
    kfdAdopterManifestJson: options.kfdAdopterManifestJson,
    kfdSupportMatrixJson: options.kfdSupportMatrixJson,
    kfdProductGateJsons: options.kfdProductGateJsons,
    invariantPassportJsons: options.invariantPassportJsons,
    invariantPassportCommand: options.invariantPassportCommand,
    releaseEvidenceJsons: [
      ...options.releaseEvidenceJsons,
      ...material.generatedReleaseEvidenceJsons,
    ],
    v4ConsumerPolicyCertificationJson:
      options.v4ConsumerPolicyCertificationJson,
    v4ConsumerPolicyCertificationRoot:
      options.v4ConsumerPolicyCertificationRoot,
    v4RuntimeResumeEvidenceJson:
      material.generatedRuntimeResumeEvidence[0] ||
      options.v4RuntimeResumeEvidenceJson,
    githubArtifactAttestationPolicyJsons:
      options.githubArtifactAttestationPolicyJsons,
    buildSummaryJson: material.buildSummaryJson,
    platformManifestJsons: material.platformManifests,
    distTagEvidenceJson: existingJsonObjectFile(result.distTagEvidencePath),
    controllerReceiptReferences:
      options.releaseCandidateValidation?.controllerReceipts || [],
    releaseJsonExtra: releasePassportExtra(options, material),
    publishJson: JSON.stringify({
      auth: result.publishContract?.auth || "",
      distTag: result.publishContract?.distTag || "",
      packageSetOrder: result.publishContract?.packageSetOrder || "",
      registry: "https://registry.npmjs.org/",
    }),
    workflow: releasePassportWorkflow(result),
  });
}
export async function persistReleasePassport(options, material, collected) {
  const result = options.result;
  await verifyCollectedReleasePassport({
    collected,
    cwd: options.cwd,
    phase: "generated",
  });
  const durable = await persistDurableReleaseTransaction({
    octokit: result.octokit,
    owner: result.owner,
    repo: result.repo,
    cwd: result.cwd,
    transaction: result.transaction,
    evidencePath: result.evidencePath,
    extraFiles: releasePassportArtifactFiles(collected.outputDir),
  });
  backfillReleasePassportStateSha(collected.outputDir, durable?.sha || "");
  await verifyCollectedReleasePassport({
    collected,
    cwd: options.cwd,
    phase: "backfilled",
  });
  const finalDurable = await persistDurableReleaseTransaction({
    octokit: result.octokit,
    owner: result.owner,
    repo: result.repo,
    cwd: result.cwd,
    transaction: result.transaction,
    evidencePath: result.evidencePath,
    extraFiles: releasePassportArtifactFiles(collected.outputDir),
  });
  const persistedTransaction = writeReleaseTransaction(
    result.statePath,
    result.transaction,
  );
  return {
    ...result,
    transaction: persistedTransaction,
    publicReleaseTag: material.publicReleaseTag,
    durable: finalDurable || durable,
    releasePassport: {
      outputDir: collected.outputDir,
      passportPath: path.join(collected.outputDir, "buildchain.release.json"),
      durablePath: "release-passport/buildchain.release.json",
      stateSha: finalDurable?.sha || durable?.sha || "",
      files: collected.files,
    },
  };
}
export async function collectAndPersistReleasePassport(rawOptions) {
  const options = normalizeReleasePassportOptions(rawOptions);
  const result = options.result;
  if (
    !options.enabled ||
    !result?.transaction ||
    result.transaction.state !== "complete"
  ) {
    return result;
  }
  if (!result.evidencePath || !fs.existsSync(result.evidencePath))
    return result;
  const material = prepareReleasePassport(options);
  const collected = collectReleasePassport(options, material);
  return persistReleasePassport(options, material, collected);
}
export async function beginTransactionFinalization(result, actor, runId) {
  if (
    !result?.transaction ||
    result.transaction.state === "finalizing" ||
    result.transaction.state === "complete"
  ) {
    return result;
  }
  const transaction = transitionReleaseTransaction(
    result.transaction,
    "finalizing",
    {
      actor,
      runId,
    },
  );
  return persistTransactionResult(result, transaction);
}
export async function completeTransactionFinalization(
  result,
  actor,
  runId,
  persist = true,
) {
  if (!result?.transaction) {
    return result;
  }
  if (result.transaction.state === "complete") {
    if (!result.transaction.failure) {
      return result;
    }
    const cleared = transitionReleaseTransaction(
      result.transaction,
      "complete",
      {
        actor,
        runId,
        failure: "",
      },
    );
    return persist
      ? persistTransactionResult(result, cleared)
      : { ...result, transaction: cleared };
  }
  const current =
    result.transaction.state === "published"
      ? transitionReleaseTransaction(result.transaction, "finalizing", {
          actor,
          runId,
        })
      : result.transaction;
  const transaction = transitionReleaseTransaction(current, "complete", {
    actor,
    runId,
  });
  return persist
    ? persistTransactionResult(result, transaction)
    : { ...result, transaction };
}

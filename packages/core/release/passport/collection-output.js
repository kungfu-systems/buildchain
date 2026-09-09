import { mergeAuthoritativePassportBase } from "./authoritative-base.js";
import { createReleasePassport } from "./assembly.js";
import path from "node:path";
import { createReleaseCheckReport } from "./report.js";
import { writeJsonFile, writeTextFile } from "./files.js";
import { defaultReleaseLlmsText as defaultLlmsText } from "../release-passport-contract.js";
export function assembleCollectedPassport({
  anchorManifest,
  assets,
  basePassportMeta,
  buildFactMetas,
  buildSummaryMeta,
  consumerPolicyCertificationMeta,
  controllerReceiptReferences,
  cwd,
  distTagEvidenceMeta,
  domainConsumerPolicyCertificationRoot,
  domainRuntimeResumeEvidence,
  githubArtifactAttestationPolicies,
  impact,
  invariantPassports,
  kfd1,
  kfd2ClaimMetas,
  kfd3,
  kfdAdopter,
  kfdAgentHubEvidenceMeta,
  kfdSupport,
  line,
  packageName,
  packageSet,
  packageVersion,
  platformManifestMetas,
  productName,
  publish,
  publishEvidenceMeta,
  releaseEvidenceAttachments,
  releaseExtra,
  repository,
  requireBaseKfd,
  resolvedCheckedAt,
  resolvedOutputDir,
  resolvedTag,
  sourceSha,
  transactionMeta,
  trustedPublishing,
  versionMaterial,
  workflow,
}) {
  return mergeAuthoritativePassportBase(
    createReleasePassport({
      cwd,
      repository,
      tag: resolvedTag,
      sourceSha,
      line,
      productName,
      packageName,
      packageVersion,
      assets,
      packageSet,
      anchorManifest,
      versionMaterial,
      publishEvidence: publishEvidenceMeta.value,
      trustedPublishing,
      transaction: transactionMeta.value,
      buildSummary: buildSummaryMeta.value
        ? {
            ...buildSummaryMeta,
            path: buildSummaryMeta.path
              ? path
                  .relative(resolvedOutputDir, buildSummaryMeta.path)
                  .split(path.sep)
                  .join("/")
              : "",
          }
        : undefined,
      buildFacts: buildFactMetas.map((meta) => ({
        ...meta,
        path: meta.path
          ? path
              .relative(resolvedOutputDir, meta.path)
              .split(path.sep)
              .join("/")
          : "",
      })),
      platformArtifactManifests: platformManifestMetas
        .filter((meta) => meta.value)
        .map((meta) => ({
          ...meta,
          path: meta.path
            ? path
                .relative(resolvedOutputDir, meta.path)
                .split(path.sep)
                .join("/")
            : "",
        })),
      distTagPromotionEvidence: distTagEvidenceMeta.value
        ? {
            ...distTagEvidenceMeta,
            path: distTagEvidenceMeta.path
              ? path
                  .relative(resolvedOutputDir, distTagEvidenceMeta.path)
                  .split(path.sep)
                  .join("/")
              : "",
          }
        : undefined,
      release: releaseExtra,
      publish,
      impact,
      kfd1,
      kfd2Claims: kfd2ClaimMetas.map((meta) => meta.value),
      kfd3,
      kfdAdopter,
      kfdAdopterManifestEvidencePath: kfdAdopter
        ? "kfd-adopter-manifest.json"
        : "",
      kfdAdopterGateEvidencePath: kfdAdopter
        ? "kfd-adopter-manifest-gate.json"
        : "",
      kfdSupport,
      kfdSupportEvidencePath: kfdSupport ? "kfd-support.json" : "",
      invariantPassports,
      releaseEvidence: releaseEvidenceAttachments.map(
        ({ reference }) => reference,
      ),
      v4ConsumerPolicyCertification: consumerPolicyCertificationMeta.value,
      v4ConsumerPolicyCertificationRoot: domainConsumerPolicyCertificationRoot,
      domainRuntimeResumeEvidence,
      kfdAgentHubEvidence: kfdAgentHubEvidenceMeta.value
        ? { ...kfdAgentHubEvidenceMeta, path: "kfd-agent-hub-evidence.json" }
        : undefined,
      kfdAgentHubEvidencePath: kfdAgentHubEvidenceMeta.value
        ? "kfd-agent-hub-evidence.json"
        : "",
      controllerReceiptReferences,
      githubArtifactAttestations: githubArtifactAttestationPolicies,
      publishEvidencePath: publishEvidenceMeta.path
        ? path
            .relative(resolvedOutputDir, publishEvidenceMeta.path)
            .split(path.sep)
            .join("/")
        : "",
      transactionStatePath: transactionMeta.path
        ? path
            .relative(resolvedOutputDir, transactionMeta.path)
            .split(path.sep)
            .join("/")
        : "",
      workflow,
      checkedAt: resolvedCheckedAt,
    }),
    basePassportMeta.value,
    { requireKfd: requireBaseKfd },
  );
}
export function writePassportCollection({
  agentIndex,
  anchorManifest,
  artifactEvidence,
  assets,
  basePassportMeta,
  buildFactMetas,
  buildSummaryMeta,
  bundledPublishEvidencePath,
  consumerPolicyCertificationMeta,
  controllerReceiptReferences,
  cwd,
  distTagEvidenceMeta,
  domainConsumerPolicyCertificationRoot,
  domainRuntimeResumeEvidence,
  githubArtifactAttestationPolicies,
  impact,
  invariantPassports,
  kfd1,
  kfd2ClaimMetas,
  kfd3,
  kfdAdopter,
  kfdAdopterManifest,
  kfdAdopterManifestGate,
  kfdAgentHubEvidenceMeta,
  kfdSupport,
  line,
  packageName,
  packageSet,
  packageVersion,
  platformManifestMetas,
  productMechanism,
  productName,
  publish,
  publishEvidenceMeta,
  releaseEvidenceAttachments,
  releaseExtra,
  repository,
  requireBaseKfd,
  resolvedCheckedAt,
  resolvedOutputDir,
  resolvedTag,
  sourceSha,
  transactionMeta,
  trustedPublishing,
  versionMaterial,
  workflow,
}) {
  const passport = assembleCollectedPassport({
    anchorManifest,
    assets,
    basePassportMeta,
    buildFactMetas,
    buildSummaryMeta,
    consumerPolicyCertificationMeta,
    controllerReceiptReferences,
    cwd,
    distTagEvidenceMeta,
    domainConsumerPolicyCertificationRoot,
    domainRuntimeResumeEvidence,
    githubArtifactAttestationPolicies,
    impact,
    invariantPassports,
    kfd1,
    kfd2ClaimMetas,
    kfd3,
    kfdAdopter,
    kfdAgentHubEvidenceMeta,
    kfdSupport,
    line,
    packageName,
    packageSet,
    packageVersion,
    platformManifestMetas,
    productName,
    publish,
    publishEvidenceMeta,
    releaseEvidenceAttachments,
    releaseExtra,
    repository,
    requireBaseKfd,
    resolvedCheckedAt,
    resolvedOutputDir,
    resolvedTag,
    sourceSha,
    transactionMeta,
    trustedPublishing,
    versionMaterial,
    workflow,
  });
  if (bundledPublishEvidencePath) {
    passport.evidence.publishEvidence = bundledPublishEvidencePath;
  }
  const checkReport = createReleaseCheckReport({
    passport,
    artifactEvidence,
    publishEvidence: publishEvidenceMeta.value,
    impact,
    agentIndex,
    productMechanism,
    kfdAgentHubEvidence: kfdAgentHubEvidenceMeta.value,
    kfdSupportEvidence: kfdSupport,
    kfdAdopterManifest,
    kfdAdopterManifestGate,
    releaseEvidenceDocuments: releaseEvidenceAttachments,
    checkedAt: resolvedCheckedAt,
  });
  const files = {
    "product-mechanism.json": productMechanism,
    "artifact-evidence.json": artifactEvidence,
    ...(publishEvidenceMeta.value
      ? { [bundledPublishEvidencePath]: publishEvidenceMeta.value }
      : {}),
    "impact.json": impact,
    "agent-index.json": agentIndex,
    ...(kfdAgentHubEvidenceMeta.value
      ? { "kfd-agent-hub-evidence.json": kfdAgentHubEvidenceMeta.value }
      : {}),
    ...(kfdAdopterManifest
      ? { "kfd-adopter-manifest.json": kfdAdopterManifest }
      : {}),
    ...(kfdAdopterManifestGate
      ? { "kfd-adopter-manifest-gate.json": kfdAdopterManifestGate }
      : {}),
    ...(kfdSupport ? { "kfd-support.json": kfdSupport } : {}),
    "buildchain.release.json": passport,
    "check-report.json": checkReport,
  };
  for (const [fileName, value] of Object.entries(files)) {
    writeJsonFile(path.join(resolvedOutputDir, fileName), value);
  }
  writeTextFile(
    path.join(resolvedOutputDir, "llms.txt"),
    defaultLlmsText({ tag: resolvedTag }),
  );
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-passport-collection",
    outputDir: resolvedOutputDir,
    files: Object.keys(files)
      .concat(releaseEvidenceAttachments.map(({ reference }) => reference.path))
      .concat("llms.txt"),
    passport,
    artifactEvidence,
    checkReport,
  };
}

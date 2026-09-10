import { releaseField, optionalString, firstTruthy } from "./identity.js";
import { createSurfaceTimestampPolicy } from "../../contracts/surface-manifest.js";
import { RELEASE_PASSPORT_CONTRACT } from "../release-passport-contract.js";
export function optionalSections(entries) {
  return Object.fromEntries(
    entries.filter(
      ([, value]) => value && (!Array.isArray(value) || value.length > 0),
    ),
  );
}
export function passportReleaseSection({
  internalVersion,
  line,
  normalizedPublishEvidence,
  normalizedTag,
  normalizedTransaction,
  packageDisplayVersion,
  packageName,
  publish,
  publishedVersion,
  release,
  releaseMaterialSha,
  releaseSha,
  sourceFields,
  sourceSha,
  targetRef,
}) {
  return {
    tag: normalizedTag,
    publicTag: releaseField(release, "publicTag", "public_tag", normalizedTag),
    internalTag: releaseField(
      release,
      "internalTag",
      "internal_tag",
      normalizedTag,
    ),
    internalVersion,
    publishedVersion,
    versionLabel: releaseField(
      release,
      "versionLabel",
      "version_label",
      publishedVersion,
      normalizedTag,
    ),
    line: optionalString(line),
    sourceSha: optionalString(sourceSha),
    channel: optionalString(
      firstTruthy(
        release.channel,
        normalizedPublishEvidence?.channel,
        publish.channel,
      ),
    ),
    targetRef,
    releaseSha,
    releaseMaterialSha,
    builtSourceSha: optionalString(
      release.builtSourceSha || release.built_source_sha,
    ),
    builtSourceTreeSha: sourceFields.builtSourceTreeSha,
    promotionChannelSha: optionalString(
      release.promotionChannelSha || release.promotion_channel_sha,
    ),
    promotionChannelTreeSha: sourceFields.promotionChannelTreeSha,
    treeEquivalent:
      release.treeEquivalent === undefined
        ? undefined
        : Boolean(release.treeEquivalent),
    publishToolingSha: optionalString(
      release.publishToolingSha ||
        release.publish_tooling_sha ||
        normalizedPublishEvidence?.publishToolingSha,
    ),
    releaseStateRef: optionalString(
      release.releaseStateRef ||
        release.release_state_ref ||
        normalizedTransaction?.stateRef ||
        (normalizedTag
          ? `refs/heads/buildchain/release-state/${normalizedTag.replace(/^v/, "").replace(/[^0-9A-Za-z]+/g, "-")}`
          : ""),
    ),
    releaseStateSha: optionalString(
      release.releaseStateSha ||
        release.release_state_sha ||
        normalizedTransaction?.stateSha,
    ),
    package: {
      name: packageName,
      version: packageDisplayVersion,
    },
    exactRef: normalizedTag ? `refs/tags/${normalizedTag}` : "",
  };
}
export function passportTimestampPolicy({
  generatedAt,
  normalizedPublishEvidence,
  normalizedTransaction,
  release,
  releaseSha,
  sourceSha,
}) {
  return createSurfaceTimestampPolicy({
    generatedAt,
    publishedAt: optionalString(
      release.publishedAt ||
        release.published_at ||
        normalizedPublishEvidence?.publishedAt,
    ),
    sourceRevision: optionalString(
      firstTruthy(sourceSha, releaseSha, normalizedTransaction?.releaseSha),
    ),
    timestampPolicy: "ci-injected",
    deterministicInputs: [
      "release.sourceSha",
      "release.releaseSha",
      "release.releaseMaterialSha",
      "artifact-evidence.json",
      "publish evidence",
      "release-state transaction",
      "controller receipt references",
    ],
    timestampFields: [
      "generatedAt",
      "publishedAt",
      "surfaceTimestampPolicy.generatedAt",
      "surfaceTimestampPolicy.publishedAt",
    ],
    timestampFieldsParticipateInArtifactDigest: true,
    artifactDigestScope: "release passport JSON and release evidence bundle",
  });
}
export function passportArtifactReferences({
  artifactEvidence,
  artifactEvidencePath,
  normalizedTag,
  publishArtifacts,
  publishEvidencePath,
}) {
  return [
    ...artifactEvidence.artifacts.map((asset) => ({
      group: "release",
      kind: asset.kind || "release-asset",
      name: asset.name,
      platform: asset.platform,
      ref: normalizedTag,
      sha256: asset.sha256,
      digest: asset.sha256 ? `sha256:${asset.sha256}` : "",
      evidence: artifactEvidencePath,
      url: asset.url,
    })),
    ...publishArtifacts.map((artifact) => ({
      ...artifact,
      evidence:
        publishEvidencePath || artifact.evidence || artifactEvidencePath,
    })),
  ];
}
export function renderReleasePassport({
  agentIndexPath,
  anchorManifest,
  artifactEvidence,
  artifactEvidencePath,
  buildEvidence,
  checkReportPath,
  generatedAt,
  impactPath,
  internalVersion,
  invariantPassports,
  kfdAgentHubEvidencePath,
  kfdParts,
  line,
  normalizedControllerReceipts,
  normalizedGitHubArtifactAttestations,
  normalizedImpact,
  normalizedKfdAgentHub,
  normalizedPackageSet,
  normalizedPublishEvidence,
  normalizedPublishSummary,
  normalizedRuntimeResume,
  normalizedTag,
  normalizedTransaction,
  normalizedTrustedPublishing,
  packageDisplayVersion,
  packageName,
  productMechanismPath,
  productName,
  promotion,
  publish,
  publishArtifacts,
  publishEvidencePath,
  publishedVersion,
  release,
  releaseEvidence,
  releaseMaterialSha,
  releaseSha,
  repository,
  sourceFields,
  sourceSha,
  targetRef,
  transactionStatePath,
  versionMaterial,
  workflow,
}) {
  return {
    schemaVersion: 1,
    contract: RELEASE_PASSPORT_CONTRACT,
    generatedAt,
    surfaceTimestampPolicy: passportTimestampPolicy({
      generatedAt,
      normalizedPublishEvidence,
      normalizedTransaction,
      release,
      releaseSha,
      sourceSha,
    }),
    product: {
      name: optionalString(productName || "Buildchain"),
      repository: optionalString(repository),
      mechanism: productMechanismPath,
    },
    release: passportReleaseSection({
      internalVersion,
      line,
      normalizedPublishEvidence,
      normalizedTag,
      normalizedTransaction,
      packageDisplayVersion,
      packageName,
      publish,
      publishedVersion,
      release,
      releaseMaterialSha,
      releaseSha,
      sourceFields,
      sourceSha,
      targetRef,
    }),
    workflow: {
      name: optionalString(workflow.name),
      runId: optionalString(workflow.runId),
      runAttempt: optionalString(workflow.runAttempt),
      url: optionalString(workflow.url),
    },
    runnerPolicy: {
      productionDefault: "github-hosted",
      compatibilityFixture: "self-hosted",
      note: "Runner facts are recorded in artifact evidence; the protocol does not require self-hosted runners.",
    },
    ...optionalSections([
      ["packageSet", normalizedPackageSet],
      ["publish", normalizedPublishSummary],
      ["anchorManifest", anchorManifest],
      ["versionMaterial", versionMaterial],
      ["trustedPublishing", normalizedTrustedPublishing],
      ["transaction", normalizedTransaction],
      ["promotionRouting", promotion.routing],
      ["buildSummary", buildEvidence.buildSummary],
      ["buildFacts", buildEvidence.buildFacts],
      ["platformArtifactManifests", buildEvidence.platformArtifactManifests],
      ["distTagPromotion", buildEvidence.distTagPromotionEvidence],
      ...kfdParts.sectionEntries,
      ["kfdAgentHub", normalizedKfdAgentHub],
      ["invariantPassports", invariantPassports],
      ["releaseEvidence", releaseEvidence],
      ["v4ConsumerPolicy", promotion.consumerPolicy],
      ["v4RuntimeResume", normalizedRuntimeResume],
      ["controllerReceipts", normalizedControllerReceipts],
      ["githubArtifactAttestations", normalizedGitHubArtifactAttestations],
    ]),
    versionImpact: normalizedImpact.versionImpact,
    surfaceImpacts: normalizedImpact.surfaceImpacts,
    artifacts: passportArtifactReferences({
      artifactEvidence,
      artifactEvidencePath,
      normalizedTag,
      publishArtifacts,
      publishEvidencePath,
    }),
    evidence: {
      artifactEvidence: artifactEvidencePath,
      publishEvidence: publishEvidencePath,
      transactionState: transactionStatePath,
      buildSummary: buildEvidence.buildSummary?.path || "",
      buildFacts: buildEvidence.buildFacts.map((fact) => ({
        path: fact.path || "",
        sha256: fact.sha256 || "",
        contract: fact.fields?.contract || "",
        id: fact.fields?.id || "",
        digest: fact.fields?.digest || "",
      })),
      platformArtifactManifests: buildEvidence.platformArtifactManifests.map(
        (manifest) => ({
          path: manifest.path,
          sha256: manifest.sha256,
          platform: manifest.platform,
          artifactName: manifest.artifactName,
        }),
      ),
      distTagPromotionEvidence:
        buildEvidence.distTagPromotionEvidence?.path || "",
      ...kfdParts.evidence,
      kfdAgentHub: normalizedKfdAgentHub
        ? optionalString(
            kfdAgentHubEvidencePath || "kfd-agent-hub-evidence.json",
          )
        : "",
      invariantPassports: invariantPassports ? "invariantPassports" : "",
      releaseEvidence: releaseEvidence.map((entry) => entry.path),
      impact: impactPath,
      checkReport: checkReportPath,
      agentIndex: agentIndexPath,
    },
    recovery: {
      rollback:
        "Use the previous exact release tag or previous floating channel ref.",
      verify: `buildchain verify release-passport ${normalizedTag ? "buildchain.release.json" : "<passport>"}`,
    },
  };
}

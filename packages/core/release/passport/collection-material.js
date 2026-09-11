import { parseJsonInputWithMeta, parseJsonInput } from "./inputs.js";
import {
  collectKfdAdopterReleaseEvidence,
  defaultReleaseProductMechanism as defaultProductMechanism,
  defaultReleaseAgentIndex as defaultAgentIndex,
} from "../release-passport-contract.js";
import path from "node:path";
import fs from "node:fs";
import { discoverAssetsFromDir } from "./discovery.js";
import { optionalString, nowIso } from "./identity.js";
import { normalizeReleaseEvidenceAttachment } from "./attachments.js";
import { createArtifactEvidence } from "./assembly-artifacts.js";
import { mergeAuthoritativeImpactBase } from "./authoritative-base.js";
import { normalizeImpactLedger } from "./impact.js";
import {
  createKfd1ReleaseGateEvidence,
  createKfd3CollaborationInterfaceReleaseGateEvidence,
} from "../../adoption/kfd-gate.js";
export function collectKfdAdopterReleaseInputs({
  cwd,
  manifestJson,
  supportMatrixJson,
  productGateJsons,
  repository,
  sourceSha,
  checkedAt,
}) {
  const manifestMeta = parseJsonInputWithMeta(manifestJson, undefined, {
    cwd,
    label: "kfdAdopterManifestJson",
  });
  const supportMatrixMeta = parseJsonInputWithMeta(
    supportMatrixJson,
    undefined,
    { cwd, label: "kfdSupportMatrixJson" },
  );
  const productGateMetas = (productGateJsons || [])
    .filter(Boolean)
    .map((gateJson) =>
      parseJsonInputWithMeta(gateJson, undefined, {
        cwd,
        label: "kfdProductGateJsons entry",
      }),
    )
    .filter((meta) => meta.value);
  return collectKfdAdopterReleaseEvidence({
    manifest: manifestMeta.value,
    gateResults: productGateMetas.map((meta) => meta.value),
    comparisonMatrix: supportMatrixMeta.value,
    expectedAdopterId: repository || "kungfu-systems/buildchain",
    expectedSourceRepository: repository,
    sourceSha,
    checkedAt,
  });
}
export function copyReleaseEvidenceAttachments(attachments, outputDir) {
  const ids = new Set();
  for (const { reference } of attachments) {
    if (ids.has(reference.id)) {
      throw new Error(
        `release evidence attachment id must be unique: ${reference.id}`,
      );
    }
    ids.add(reference.id);
  }
  for (const { inputPath, reference } of attachments) {
    const destinationPath = path.join(outputDir, reference.path);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(inputPath, destinationPath);
  }
}
export function preparePassportCollectionMaterial({
  assetsDir,
  assetsFromJson,
  basePassportMeta,
  checkedAt,
  cwd,
  impactMeta,
  kfd1WitnessMetas,
  kfd3ArtifactCommandMeta,
  kfd3ArtifactWitnessMetas,
  kfd3PrebuildWitnessMetas,
  kfdAdopterManifestJson,
  kfdProductGateJsons,
  kfdSupportMatrixJson,
  line,
  outputDir,
  productName,
  publishEvidenceMeta,
  publishJson,
  release,
  releaseEvidenceMetas,
  releaseExtra,
  repository,
  sourceSha,
  tag,
  workflow,
}) {
  const kfd3ArtifactWitnesses = [
    ...kfd3ArtifactWitnessMetas.map((meta) => meta.value),
    ...(kfd3ArtifactCommandMeta.value ? [kfd3ArtifactCommandMeta.value] : []),
  ];
  const publish = parseJsonInput(
    publishJson,
    {},
    { cwd, label: "publishJson" },
  );
  const assets = [
    ...(Array.isArray(release.assets) ? release.assets : []),
    ...(Array.isArray(assetsFromJson) ? assetsFromJson : []),
    ...discoverAssetsFromDir(assetsDir ? path.resolve(cwd, assetsDir) : ""),
  ];
  const resolvedTag = tag || release.tag_name || release.name || "";
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const resolvedChannel = optionalString(
    releaseExtra.channel || publish.channel,
  );
  const releaseEvidenceAttachments = releaseEvidenceMetas.map((meta, index) =>
    normalizeReleaseEvidenceAttachment(meta, {
      cwd,
      expectedSourceSha: sourceSha,
      expectedTag: resolvedTag,
      expectedChannel: resolvedChannel,
      index,
    }),
  );
  copyReleaseEvidenceAttachments(releaseEvidenceAttachments, resolvedOutputDir);
  const resolvedCheckedAt = optionalString(checkedAt) || nowIso();
  const productMechanism = defaultProductMechanism({ repository, productName });
  const kfdAdopterEvidence = collectKfdAdopterReleaseInputs({
    cwd,
    manifestJson: kfdAdopterManifestJson,
    supportMatrixJson: kfdSupportMatrixJson,
    productGateJsons: kfdProductGateJsons,
    repository,
    sourceSha,
    checkedAt: resolvedCheckedAt,
  });
  const {
    manifest: kfdAdopterManifest,
    manifestGate: kfdAdopterManifestGate,
    legacyProjection: kfdSupport,
    binding: kfdAdopter,
  } = kfdAdopterEvidence;
  const artifactEvidence = createArtifactEvidence({
    assets,
    repository,
    tag: resolvedTag,
    sourceSha,
    workflow,
    kfdAdopter,
  });
  const bundledPublishEvidencePath = publishEvidenceMeta.value
    ? "evidence.json"
    : "";
  const impact = mergeAuthoritativeImpactBase(
    normalizeImpactLedger(impactMeta.value, {
      tag: resolvedTag,
      line,
      decision: "unknown",
    }),
    basePassportMeta.value,
  );
  const agentIndex = defaultAgentIndex({ tag: resolvedTag });
  const kfd1 = createKfd1ReleaseGateEvidence({
    cwd,
    artifactRoot: assetsDir ? path.resolve(cwd, assetsDir) : "",
    artifacts: assets,
    witnesses: kfd1WitnessMetas.map((meta) => meta.value),
  });
  const kfd3 = createKfd3CollaborationInterfaceReleaseGateEvidence({
    prebuildWitnesses: kfd3PrebuildWitnessMetas.map((meta) => meta.value),
    artifactWitnesses: kfd3ArtifactWitnesses,
    prebuildWitnessMetas: kfd3PrebuildWitnessMetas,
    artifactWitnessMetas: kfd3ArtifactWitnessMetas,
    artifactCommandMeta: kfd3ArtifactCommandMeta.value
      ? kfd3ArtifactCommandMeta
      : undefined,
  });
  return {
    agentIndex,
    artifactEvidence,
    assets,
    bundledPublishEvidencePath,
    impact,
    kfd1,
    kfd3,
    kfdAdopter,
    kfdAdopterManifest,
    kfdAdopterManifestGate,
    kfdSupport,
    productMechanism,
    publish,
    releaseEvidenceAttachments,
    resolvedCheckedAt,
    resolvedOutputDir,
    resolvedTag,
  };
}

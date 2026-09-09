import { normalizeAsset } from "./assets.js";
import { buildReleaseArtifactEvidence } from "../release-passport-contract.js";
export function createArtifactEvidence({
  assets = [],
  repository = "",
  tag = "",
  sourceSha = "",
  workflow = {},
  kfdAdopter = undefined,
} = {}) {
  const normalizedAssets = assets.map((asset, index) =>
    normalizeAsset(asset, index),
  );
  return buildReleaseArtifactEvidence({
    normalizedAssets,
    repository,
    tag,
    sourceSha,
    workflow,
    kfdAdopter,
  });
}
export function prepareReleaseKfdAdopterArtifacts({
  kfdAdopter,
  assets,
  repository,
  tag,
  sourceSha,
  workflow,
}) {
  const normalized = kfdAdopter ? structuredClone(kfdAdopter) : undefined;
  return {
    normalized,
    artifactEvidence: createArtifactEvidence({
      assets,
      repository,
      tag,
      sourceSha,
      workflow,
      kfdAdopter: normalized,
    }),
  };
}

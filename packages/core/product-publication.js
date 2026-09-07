import { invokeDomainWasm } from "./domain-wasm.js";

export const PRODUCT_PUBLICATION_INTENT_CONTRACT =
  "kungfu-buildchain-v4-product-publication-intent/v1";
export const PRODUCT_PUBLICATION_PLAN_CONTRACT =
  "kungfu-buildchain-v4-product-publication-plan/v1";

export function selectProductPublicationIntent({
  channel,
  targetRef,
  sourceSha,
  sourceTimestamp,
  repository,
  artifactKind = "npm",
  packageName,
  npmPackages,
  distTag,
  sealedBundleRoot,
  requiredArtifactsRoot,
  candidateVersion,
  recoveredVersion = "",
  observedVersions = [],
}) {
  return invokeDomainWasm("product-publication-intent", {
    channel,
    targetRef,
    sourceSha,
    sourceTimestamp,
    repository,
    artifactKind,
    ...(npmPackages === undefined ? {} : { npmPackages }),
    ...(packageName === undefined ? {} : { packageName }),
    ...(distTag === undefined ? {} : { distTag }),
    ...(sealedBundleRoot === undefined ? {} : { sealedBundleRoot }),
    requiredArtifactsRoot,
    candidateVersion,
    recoveredVersion,
    observedVersions,
  });
}

export function createProductPublicationPlan({
  intent,
  invocationRoot,
  transactionRoot,
}) {
  return invokeDomainWasm("product-publication-plan", {
    intent,
    invocationRoot,
    transactionRoot,
  });
}

export function createProductPublicationDeclaration({ intent, plan }) {
  return invokeDomainWasm("product-publication-declaration", {
    intent,
    plan,
  });
}

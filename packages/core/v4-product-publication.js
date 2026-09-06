import { invokeV4DomainWasm } from "./v4-domain-wasm.js";

export const V4_PRODUCT_PUBLICATION_INTENT_CONTRACT =
  "kungfu-buildchain-v4-product-publication-intent/v1";
export const V4_PRODUCT_PUBLICATION_PLAN_CONTRACT =
  "kungfu-buildchain-v4-product-publication-plan/v1";

export function selectV4ProductPublicationIntent({
  channel,
  targetRef,
  sourceSha,
  sourceTimestamp,
  repository,
  artifactKind = "npm",
  packageName,
  distTag,
  sealedBundleRoot,
  requiredArtifactsRoot,
  candidateVersion,
  recoveredVersion = "",
  observedVersions = [],
}) {
  return invokeV4DomainWasm("product-publication-intent", {
    channel,
    targetRef,
    sourceSha,
    sourceTimestamp,
    repository,
    artifactKind,
    ...(packageName === undefined ? {} : { packageName }),
    ...(distTag === undefined ? {} : { distTag }),
    ...(sealedBundleRoot === undefined ? {} : { sealedBundleRoot }),
    requiredArtifactsRoot,
    candidateVersion,
    recoveredVersion,
    observedVersions,
  });
}

export function createV4ProductPublicationPlan({
  intent,
  invocationRoot,
  transactionRoot,
}) {
  return invokeV4DomainWasm("product-publication-plan", {
    intent,
    invocationRoot,
    transactionRoot,
  });
}

export function createV4ProductPublicationDeclaration({ intent, plan }) {
  return invokeV4DomainWasm("product-publication-declaration", {
    intent,
    plan,
  });
}

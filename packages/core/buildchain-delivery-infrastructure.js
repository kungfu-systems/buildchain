import { semanticRoot } from "@kungfu-tech/kfd/scripts/self-conformance-contract.mjs";

import {
  resolvePublishedKfdAdopterCategoryProfiles,
  verifyPublishedKfdAdopterCategoryInstance,
} from "./kfd-adopter-category-driver.js";

export const BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID =
  "kungfu-systems/buildchain";
export const BUILDCHAIN_DELIVERY_INFRASTRUCTURE_PROFILE = Object.freeze({
  id: "kfd.adopter-category/delivery-infrastructure",
  version: "1.0.0",
});

const CATEGORY_INSTANCE_SCHEMA =
  "https://kfd.libkungfu.dev/schemas/kfd-adopter-conformance/category-instance-manifest.schema.json";
const CATEGORY_INSTANCE_CONTRACT = "kfd.adopter-category-instance-manifest/v1";
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CLAIM_BOUNDARY = Object.freeze({
  categoryConformanceIsDeclarationOnly: true,
  evidenceTransfer: false,
  runtimePermission: false,
  releaseAuthorization: false,
  independentCertification: false,
  semanticAuthorityTransfer: false,
});

function exactEvidenceReference(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`evidence[${index}] must be an object`);
  }
  const fields = ["requirementId", "kind", "coordinate", "root", "observedAt"];
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, fieldIndex) => field !== expected[fieldIndex])
  ) {
    throw new TypeError(`evidence[${index}] has an invalid field set`);
  }
  for (const field of ["requirementId", "kind", "coordinate", "observedAt"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new TypeError(`evidence[${index}].${field} must be non-empty`);
    }
  }
  if (!ROOT_PATTERN.test(value.root ?? "")) {
    throw new TypeError(`evidence[${index}].root must be a sha256 root`);
  }
  return structuredClone(value);
}

function releaseBound(adopterManifest, artifact, release) {
  return (adopterManifest?.releaseBindings ?? []).some(
    (binding) =>
      semanticRoot(binding.artifact) === semanticRoot(artifact) &&
      semanticRoot(binding.releasePassport) === semanticRoot(release) &&
      binding.kfdPackageRoot === adopterManifest.kfdCut.package.artifactRoot,
  );
}

export function createBuildchainDeliveryInfrastructureInstanceManifest({
  instanceId,
  adopterManifest,
  source,
  artifact,
  release,
  evidence = [],
} = {}) {
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw new TypeError("instanceId must be non-empty");
  }
  if (
    adopterManifest?.adopter?.id !==
    BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID
  ) {
    throw new TypeError(
      `adopterManifest must identify ${BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID}`,
    );
  }
  if (!releaseBound(adopterManifest, artifact, release)) {
    throw new TypeError(
      "adopterManifest must bind the exact Buildchain artifact and release",
    );
  }

  const selection = {
    schemaVersion: 1,
    contract: "kfd.adopter-category-profile-selection/v1",
    profiles: [structuredClone(BUILDCHAIN_DELIVERY_INFRASTRUCTURE_PROFILE)],
  };
  const resolution = resolvePublishedKfdAdopterCategoryProfiles(selection);
  if (!resolution.valid) {
    throw new Error(
      `published delivery-infrastructure profile did not resolve: ${JSON.stringify(resolution.issues)}`,
    );
  }

  const project = {
    adopterId: BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID,
    source: structuredClone(source),
    artifact: structuredClone(artifact),
    release: structuredClone(release),
  };
  const projectRoot = semanticRoot(project);
  const adopterManifestRoot = semanticRoot(adopterManifest);
  const packageRoot = adopterManifest.kfdCut.package.artifactRoot;
  const requirementIds = new Set(
    resolution.requirements.map((requirement) => requirement.id),
  );
  const suppliedEvidence = evidence.map(exactEvidenceReference);
  for (const [index, entry] of suppliedEvidence.entries()) {
    if (!requirementIds.has(entry.requirementId)) {
      throw new TypeError(
        `evidence[${index}].requirementId is not selected by the published profile`,
      );
    }
  }

  return {
    $schema: CATEGORY_INSTANCE_SCHEMA,
    schemaVersion: 1,
    contract: CATEGORY_INSTANCE_CONTRACT,
    instanceId,
    rootAlgorithm: "sha256-kfd-canonical-json-v1",
    project,
    adopterManifest: {
      contract: adopterManifest.contract,
      manifestId: adopterManifest.manifestId,
      root: adopterManifestRoot,
    },
    kfdCut: {
      packageVersion: adopterManifest.kfdCut.package.version,
      packageRoot,
      categoryCatalogRoot: resolution.catalogRoot,
    },
    selection,
    selectionRoot: resolution.selectionRoot,
    requirements: resolution.requirements.map((requirement) => ({
      id: requirement.id,
      evidence: suppliedEvidence
        .filter((entry) => entry.requirementId === requirement.id)
        .map(({ requirementId: _requirementId, ...entry }) => ({
          ...entry,
          projectInstanceId: instanceId,
          projectRoot,
          adopterManifestRoot,
          kfdPackageRoot: packageRoot,
          categorySelectionRoot: resolution.selectionRoot,
        })),
    })),
    claimBoundary: structuredClone(CLAIM_BOUNDARY),
  };
}

export function verifyBuildchainDeliveryInfrastructureInstance(
  manifest,
  { adopterManifest, verifiedAt, maxAgeSeconds } = {},
) {
  return verifyPublishedKfdAdopterCategoryInstance(manifest, {
    adopterManifest,
    verifiedAt,
    maxAgeSeconds,
  });
}

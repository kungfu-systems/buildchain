import assert from "node:assert/strict";
import test from "node:test";

import {
  initAdopterManifest,
  verifyAdopterManifestFromPackage,
} from "@kungfu-tech/kfd/adopter-conformance/toolchain";
import { semanticRoot } from "@kungfu-tech/kfd/scripts/self-conformance-contract.mjs";

import {
  createAdopterDeliveryGate,
  createPackageArtifactProfile,
} from "../packages/core/adopter-delivery-gate.js";
import {
  KFD_ADOPTER_CATEGORY_PROTOCOL_ID,
  KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION,
  createKfdAdopterCategoryProtocolDriver,
  resolvePublishedKfdAdopterCategoryProfiles,
  verifyPublishedKfdAdopterCategoryInstance,
} from "../packages/core/kfd-adopter-category-driver.js";
import { getAdopterDeliveryVector } from "../packages/core/adopter-delivery-vectors.js";

const checkedAt = "2026-08-12T00:00:00.000Z";
const maxAgeSeconds = 86400;
const packageRoot = `sha256:${"a".repeat(64)}`;
const artifact = {
  kind: "package",
  coordinate: "@example/product@1.0.0",
  root: `sha256:${"b".repeat(64)}`,
};
const release = {
  kind: "release",
  coordinate: "https://example.org/product/releases/1.0.0",
  root: `sha256:${"c".repeat(64)}`,
};
const selection = {
  schemaVersion: 1,
  contract: "kfd.adopter-category-profile-selection/v1",
  profiles: [
    {
      id: "kfd.adopter-category/delivery-infrastructure",
      version: "1.0.0",
    },
  ],
};
const claimBoundary = {
  categoryConformanceIsDeclarationOnly: true,
  evidenceTransfer: false,
  runtimePermission: false,
  releaseAuthorization: false,
  independentCertification: false,
  semanticAuthorityTransfer: false,
};

function fixture() {
  const adopterManifest = initAdopterManifest({
    manifestId: "example-product-full-cut",
    adopterId: "example.org/product",
    artifactKind: artifact.kind,
    artifactCoordinate: artifact.coordinate,
    artifactRoot: artifact.root,
    scope: "Example delivery infrastructure",
    packageArtifactRoot: packageRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds,
  });
  adopterManifest.releaseBindings.push({
    id: "example-product-1.0.0",
    artifact: structuredClone(artifact),
    releasePassport: structuredClone(release),
    kfdPackageRoot: packageRoot,
  });
  const adopterReport = verifyAdopterManifestFromPackage(adopterManifest, {
    packageArtifactRoot: packageRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds,
  });
  assert.equal(adopterReport.valid, true, JSON.stringify(adopterReport.issues));

  const resolution = resolvePublishedKfdAdopterCategoryProfiles(selection);
  assert.equal(resolution.valid, true, JSON.stringify(resolution.issues));
  const project = {
    adopterId: adopterManifest.adopter.id,
    source: {
      kind: "git-commit",
      coordinate:
        "git+https://example.org/product.git#1111111111111111111111111111111111111111",
      root: `sha256:${"1".repeat(64)}`,
    },
    artifact: structuredClone(artifact),
    release: structuredClone(release),
  };
  const instanceId = "example.org/product@1.0.0";
  const projectRoot = semanticRoot(project);
  const adopterManifestRoot = semanticRoot(adopterManifest);
  let evidenceIndex = 1;
  const requirements = resolution.requirements.map((requirement) => ({
    id: requirement.id,
    evidence: requirement.evidenceKinds.flatMap((kind) =>
      Array.from({ length: requirement.minimumEvidencePerKind }, () => ({
        kind,
        coordinate: `evidence://${requirement.id}/${kind}/${evidenceIndex}`,
        root: `sha256:${String(evidenceIndex++).padStart(64, "0")}`,
        observedAt: checkedAt,
        projectInstanceId: instanceId,
        projectRoot,
        adopterManifestRoot,
        kfdPackageRoot: packageRoot,
        categorySelectionRoot: resolution.selectionRoot,
      })),
    ),
  }));
  const instanceManifest = {
    $schema:
      "https://kfd.libkungfu.dev/schemas/kfd-adopter-conformance/category-instance-manifest.schema.json",
    schemaVersion: 1,
    contract: "kfd.adopter-category-instance-manifest/v1",
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
    selection: structuredClone(selection),
    selectionRoot: resolution.selectionRoot,
    requirements,
    claimBoundary: structuredClone(claimBoundary),
  };
  const request = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-adopter-delivery-request",
    protocol: {
      id: KFD_ADOPTER_CATEGORY_PROTOCOL_ID,
      version: KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION,
    },
    artifactProfile: {
      id: "buildchain.artifact/package",
      version: "1.0.0",
    },
    project: { instanceId, adopterId: project.adopterId },
    artifact: structuredClone(artifact),
    declaration: instanceManifest,
  };
  const context = { adopterManifest, verifiedAt: checkedAt, maxAgeSeconds };
  return { adopterManifest, instanceManifest, request, context, resolution };
}

function gate() {
  return createAdopterDeliveryGate({
    drivers: [createKfdAdopterCategoryProtocolDriver()],
    artifactProfiles: [createPackageArtifactProfile()],
  });
}

test("published KFD category profiles resolve without Buildchain policy copies", () => {
  const resolved = resolvePublishedKfdAdopterCategoryProfiles(selection);
  assert.equal(resolved.valid, true, JSON.stringify(resolved.issues));
  assert.equal(resolved.qualifying, false);
  assert.equal(resolved.evidenceInherited, false);
  assert.equal(resolved.authorityTransferred, false);
  assert.deepEqual(
    resolved.selectedProfiles.map(({ id }) => id),
    [
      "kfd.adopter-category/base",
      "kfd.adopter-category/delivery-infrastructure",
    ],
  );
});

test("KFD driver carries the exact published category-instance decision", () => {
  const built = fixture();
  const direct = verifyPublishedKfdAdopterCategoryInstance(
    built.instanceManifest,
    built.context,
  );
  assert.equal(direct.valid, true, JSON.stringify(direct.issues));

  const first = gate().evaluate(built.request, built.context);
  const replay = gate().evaluate(built.request, built.context);
  assert.equal(first.status, "passed", JSON.stringify(first.issues));
  assert.equal(first.qualifying, false);
  assert.equal(first.selfCertified, false);
  assert.deepEqual(first.semanticReport.categoryReport, direct);
  assert.equal(first.semanticReport.qualifying, false);
  assert.equal(first.semanticReport.independentlyCertified, false);
  assert.deepEqual(replay, first);
});

test("KFD driver rejects profile, package, and outer artifact substitution", () => {
  const categoryConflictVector = getAdopterDeliveryVector(
    "negative-category-conflict",
  );
  const categoryConflict = fixture();
  categoryConflict.request.declaration.selection.profiles.push(
    structuredClone(categoryConflict.request.declaration.selection.profiles[0]),
  );
  const categoryConflictResult = gate().evaluate(
    categoryConflict.request,
    categoryConflict.context,
  );
  assert.equal(
    categoryConflictResult.status,
    categoryConflictVector.expected.status,
  );
  for (const code of categoryConflictVector.expected.issueCodes) {
    assert.ok(
      categoryConflictResult.issues.some((entry) => entry.code === code),
    );
  }

  const staleProfile = fixture();
  staleProfile.request.declaration.selection.profiles[0].version = "2.0.0";
  const staleResult = gate().evaluate(
    staleProfile.request,
    staleProfile.context,
  );
  assert.equal(staleResult.status, "failed");
  assert.ok(
    staleResult.issues.some(({ code }) => code === "acp-profile-version-stale"),
  );

  const stalePackage = fixture();
  const stalePackageVector = getAdopterDeliveryVector(
    "negative-stale-package-cut",
  );
  stalePackage.request.declaration.kfdCut.packageVersion = "1.0.0-alpha.999";
  const packageResult = gate().evaluate(
    stalePackage.request,
    stalePackage.context,
  );
  assert.equal(packageResult.status, stalePackageVector.expected.status);
  for (const code of stalePackageVector.expected.issueCodes) {
    assert.ok(packageResult.issues.some((entry) => entry.code === code));
  }

  const substitutedArtifact = fixture();
  substitutedArtifact.request.artifact.root = `sha256:${"f".repeat(64)}`;
  const artifactResult = gate().evaluate(
    substitutedArtifact.request,
    substitutedArtifact.context,
  );
  assert.equal(artifactResult.status, "failed");
  assert.equal(artifactResult.semanticReport.categoryReport.valid, true);
  assert.ok(
    artifactResult.issues.some(
      ({ code }) => code === "delivery-kfd-instance-binding-mismatch",
    ),
  );
});

test("caller catalog overrides and incomplete verifier context fail safely", () => {
  const built = fixture();
  const privateCatalog = {
    claimBoundary: { runtimePermission: true },
    profiles: [],
  };
  const ignoredOverride = gate().evaluate(built.request, {
    ...built.context,
    catalog: privateCatalog,
  });
  assert.equal(
    ignoredOverride.status,
    "passed",
    JSON.stringify(ignoredOverride.issues),
  );

  const missingContext = gate().evaluate(built.request, {});
  assert.equal(missingContext.status, "failed");
  assert.ok(
    missingContext.issues.some(
      ({ code }) => code === "delivery-kfd-verification-context-invalid",
    ),
  );
});

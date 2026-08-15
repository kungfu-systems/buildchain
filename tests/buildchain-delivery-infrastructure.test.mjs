import assert from "node:assert/strict";
import test from "node:test";

import {
  initAdopterManifest,
  verifyAdopterManifestFromPackage,
} from "@kungfu-tech/kfd/adopter-conformance/toolchain";
import { semanticRoot } from "@kungfu-tech/kfd/scripts/self-conformance-contract.mjs";

import {
  BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID,
  BUILDCHAIN_DELIVERY_INFRASTRUCTURE_PROFILE,
  createBuildchainDeliveryInfrastructureInstanceManifest,
  verifyBuildchainDeliveryInfrastructureInstance,
} from "../packages/core/buildchain-delivery-infrastructure.js";
import {
  createAdopterDeliveryGate,
  createPackageArtifactProfile,
} from "../packages/core/adopter-delivery-gate.js";
import {
  KFD_ADOPTER_CATEGORY_PROTOCOL_ID,
  KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION,
  createKfdAdopterCategoryProtocolDriver,
  resolvePublishedKfdAdopterCategoryProfiles,
} from "../packages/core/kfd-adopter-category-driver.js";

const checkedAt = "2026-08-12T00:00:00.000Z";
const maxAgeSeconds = 86400;
const packageRoot = `sha256:${"a".repeat(64)}`;
const source = {
  kind: "git-commit",
  coordinate: `${BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID}@${"1".repeat(40)}`,
  root: `sha256:${"b".repeat(64)}`,
};
const artifact = {
  kind: "package",
  coordinate: "@kungfu-tech/buildchain@3.0.9-alpha.10",
  root: `sha256:${"c".repeat(64)}`,
};
const release = {
  kind: "release",
  coordinate:
    "https://github.com/kungfu-systems/buildchain/releases/tag/v3.0.9-alpha.10",
  root: `sha256:${"d".repeat(64)}`,
};
const instanceId = "kungfu-systems/buildchain@3.0.9-alpha.10";

function fixture() {
  const adopterManifest = initAdopterManifest({
    manifestId: "buildchain-v3-full-cut",
    adopterId: BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID,
    artifactKind: artifact.kind,
    artifactCoordinate: artifact.coordinate,
    artifactRoot: artifact.root,
    scope: "Buildchain delivery infrastructure",
    packageArtifactRoot: packageRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds,
  });
  adopterManifest.releaseBindings.push({
    id: "buildchain-3.0.9-alpha.10",
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

  const resolution = resolvePublishedKfdAdopterCategoryProfiles({
    schemaVersion: 1,
    contract: "kfd.adopter-category-profile-selection/v1",
    profiles: [structuredClone(BUILDCHAIN_DELIVERY_INFRASTRUCTURE_PROFILE)],
  });
  let rootIndex = 1;
  const evidence = resolution.requirements.flatMap((requirement) =>
    requirement.evidenceKinds.flatMap((kind) =>
      Array.from({ length: requirement.minimumEvidencePerKind }, () => ({
        requirementId: requirement.id,
        kind,
        coordinate: `evidence://buildchain/${requirement.id}/${kind}`,
        root: `sha256:${String(rootIndex++).padStart(64, "0")}`,
        observedAt: checkedAt,
      })),
    ),
  );
  const manifest = createBuildchainDeliveryInfrastructureInstanceManifest({
    instanceId,
    adopterManifest,
    source,
    artifact,
    release,
    evidence,
  });
  return { adopterManifest, evidence, manifest };
}

test("Buildchain constructs an exact project-owned delivery-infrastructure instance", () => {
  const built = fixture();
  const report = verifyBuildchainDeliveryInfrastructureInstance(
    built.manifest,
    {
      adopterManifest: built.adopterManifest,
      verifiedAt: checkedAt,
      maxAgeSeconds,
    },
  );

  assert.equal(report.valid, true, JSON.stringify(report.issues));
  assert.deepEqual(built.manifest.selection.profiles, [
    BUILDCHAIN_DELIVERY_INFRASTRUCTURE_PROFILE,
  ]);
  assert.equal(built.manifest.project.adopterId, "kungfu-systems/buildchain");
  assert.ok(
    built.manifest.requirements.every((requirement) =>
      requirement.evidence.every(
        (entry) =>
          entry.projectInstanceId === instanceId &&
          entry.projectRoot === semanticRoot(built.manifest.project) &&
          entry.adopterManifestRoot === semanticRoot(built.adopterManifest) &&
          entry.kfdPackageRoot === packageRoot &&
          entry.categorySelectionRoot === built.manifest.selectionRoot,
      ),
    ),
  );
  assert.equal(built.manifest.claimBoundary.releaseAuthorization, false);
  assert.equal(built.manifest.claimBoundary.evidenceTransfer, false);
});

test("the released pluggable gate carries the published KFD decision", () => {
  const built = fixture();
  const result = createAdopterDeliveryGate({
    drivers: [createKfdAdopterCategoryProtocolDriver()],
    artifactProfiles: [createPackageArtifactProfile()],
  }).evaluate(
    {
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
      project: {
        instanceId,
        adopterId: BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID,
      },
      artifact: structuredClone(artifact),
      declaration: built.manifest,
    },
    {
      adopterManifest: built.adopterManifest,
      verifiedAt: checkedAt,
      maxAgeSeconds,
    },
  );

  assert.equal(result.status, "passed", JSON.stringify(result.issues));
  assert.equal(result.semanticReport.categoryReport.valid, true);
  assert.equal(result.qualifying, false);
  assert.equal(result.selfCertified, false);
});

test("missing, reused, or unselected project evidence fails closed", () => {
  const missing = fixture();
  missing.manifest.requirements.find(
    ({ id }) => id === "protected-delivery",
  ).evidence = [];
  const missingReport = verifyBuildchainDeliveryInfrastructureInstance(
    missing.manifest,
    {
      adopterManifest: missing.adopterManifest,
      verifiedAt: checkedAt,
      maxAgeSeconds,
    },
  );
  assert.equal(missingReport.valid, false);
  assert.ok(
    missingReport.issues.some(({ code }) => code === "acp-evidence-missing"),
  );

  const reused = fixture();
  reused.manifest.requirements[0].evidence[0].projectRoot = `sha256:${"f".repeat(64)}`;
  const reusedReport = verifyBuildchainDeliveryInfrastructureInstance(
    reused.manifest,
    {
      adopterManifest: reused.adopterManifest,
      verifiedAt: checkedAt,
      maxAgeSeconds,
    },
  );
  assert.equal(reusedReport.valid, false);
  assert.ok(
    reusedReport.issues.some(({ code }) => code === "acp-evidence-reuse"),
  );

  assert.throws(
    () =>
      createBuildchainDeliveryInfrastructureInstanceManifest({
        instanceId,
        adopterManifest: reused.adopterManifest,
        source,
        artifact,
        release,
        evidence: [
          {
            requirementId: "private-buildchain-policy",
            kind: "verification",
            coordinate: "evidence://buildchain/private-policy",
            root: `sha256:${"e".repeat(64)}`,
            observedAt: checkedAt,
          },
        ],
      }),
    /not selected by the published profile/,
  );
});

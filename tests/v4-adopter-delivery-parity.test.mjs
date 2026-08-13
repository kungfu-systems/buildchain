import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  initAdopterManifest,
  verifyAdopterManifestFromPackage,
} from "@kungfu-tech/kfd/adopter-conformance/toolchain";
import kfdPackage from "@kungfu-tech/kfd/package.json" with { type: "json" };
import { semanticRoot } from "@kungfu-tech/kfd/scripts/self-conformance-contract.mjs";

import {
  ADOPTER_PROTOCOL_DRIVER_INTERFACE,
  adopterDeliveryGateDigest,
  createGitCommitArtifactProfile,
  createPackageArtifactProfile,
  defineAdopterProtocolDriver,
} from "../packages/core/adopter-delivery-gate.js";
import {
  KFD_ADOPTER_CATEGORY_PROTOCOL_ID,
  KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION,
  createKfdAdopterCategoryProtocolDriver,
  resolvePublishedKfdAdopterCategoryProfiles,
} from "../packages/core/kfd-adopter-category-driver.js";
import {
  V4_ADOPTER_DELIVERY_PARITY_PROJECTION_CONTRACT,
  V4_ADOPTER_DELIVERY_PARITY_SOURCE,
  assertV4AdopterDeliveryParity,
  createV4AdopterDeliveryParityInput,
  runV4AdopterDeliveryParity,
} from "../packages/core/v4-adopter-delivery-parity.js";

const parityPlan = JSON.parse(
  fs.readFileSync(
    new URL("../architecture/v4-adopter-delivery-parity.json", import.meta.url),
    "utf8",
  ),
);
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

function driver(id, { throws = false } = {}) {
  return defineAdopterProtocolDriver({
    interface: ADOPTER_PROTOCOL_DRIVER_INTERFACE,
    id,
    version: "1.0.0",
    verify({ request }) {
      if (throws) throw new Error("private parity fixture detail");
      const report = { protocol: id, declaration: request.declaration };
      return {
        valid: true,
        report,
        reportRoot: adopterDeliveryGateDigest(report),
        issues: [],
      };
    },
  });
}

function request(protocol = "example.protocol/alpha") {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-adopter-delivery-request",
    protocol: { id: protocol, version: "1.0.0" },
    artifactProfile: {
      id: "buildchain.artifact/git-commit",
      version: "1.0.0",
    },
    project: { instanceId: "example-instance", adopterId: "example/project" },
    artifact: {
      kind: "git-commit",
      coordinate: `example/project@${"1".repeat(40)}`,
      root: `sha256:${"2".repeat(64)}`,
    },
    declaration: { accepted: true },
  };
}

function kfdFixture() {
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
  return {
    request: {
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
    },
    context: { adopterManifest, verifiedAt: checkedAt, maxAgeSeconds },
  };
}

function project(input) {
  const projection = assertV4AdopterDeliveryParity(input);
  assert.equal(
    projection.schema,
    V4_ADOPTER_DELIVERY_PARITY_PROJECTION_CONTRACT,
  );
  assert.equal(projection.effectMode, "disabled");
  assert.match(projection.projectionRoot, /^sha256:[0-9a-f]{64}$/u);
  return projection;
}

test("v4 parity plan binds the protected v3 vector suite and excludes writer authority", () => {
  assert.deepEqual(parityPlan.sourceAuthority, {
    branch: "dev/v3/v3.0",
    commit: V4_ADOPTER_DELIVERY_PARITY_SOURCE.v3Commit,
    vectorSuiteRoot: V4_ADOPTER_DELIVERY_PARITY_SOURCE.vectorSuiteRoot,
    kfdPackage: V4_ADOPTER_DELIVERY_PARITY_SOURCE.kfdPackage,
  });
  assert.equal(kfdPackage.version, "1.0.0-alpha.62");
  assert.equal(parityPlan.target.mode, "effect-disabled");
  assert.equal(parityPlan.target.productionWriterAuthority, false);
  assert.deepEqual(
    new Set(parityPlan.vectors.map(({ id }) => id)),
    new Set([
      "golden-two-driver-offline-replay",
      "negative-driver-mismatch",
      "negative-category-conflict",
      "negative-evidence-substitution",
      "negative-stale-package-cut",
      "fault-driver-throw",
    ]),
  );
});

test("effect-disabled v4 core reproduces two isolated drivers and offline replay", () => {
  const drivers = [
    driver("example.protocol/alpha"),
    driver("example.protocol/beta"),
  ];
  const artifactProfiles = [createGitCommitArtifactProfile()];
  const alpha = createV4AdopterDeliveryParityInput({
    vectorId: "golden-two-driver-offline-replay",
    request: request(),
    drivers,
    artifactProfiles,
  });
  const beta = createV4AdopterDeliveryParityInput({
    vectorId: "golden-two-driver-offline-replay",
    request: request("example.protocol/beta"),
    drivers,
    artifactProfiles,
  });
  const alphaFirst = project(alpha);
  const alphaReplay = project(alpha);
  const betaFirst = project(beta);
  assert.equal(alphaFirst.result.status, "passed");
  assert.equal(betaFirst.result.status, "passed");
  assert.equal(alphaFirst.projectionRoot, alphaReplay.projectionRoot);
  assert.equal(alphaFirst.result.qualifying, false);
  assert.equal(betaFirst.result.selfCertified, false);
});

test("unknown drivers and driver faults preserve exact fail-closed decisions", () => {
  const artifactProfiles = [createGitCommitArtifactProfile()];
  const unknown = createV4AdopterDeliveryParityInput({
    vectorId: "negative-driver-mismatch",
    request: request("example.protocol/unknown"),
    drivers: [driver("example.protocol/alpha")],
    artifactProfiles,
  });
  const fault = createV4AdopterDeliveryParityInput({
    vectorId: "fault-driver-throw",
    request: request("example.protocol/broken"),
    drivers: [driver("example.protocol/broken", { throws: true })],
    artifactProfiles,
  });
  assert.deepEqual(
    project(unknown).result.issues.map(({ code }) => code),
    ["delivery-driver-unknown"],
  );
  const faultResult = project(fault).result;
  assert.deepEqual(
    faultResult.issues.map(({ code }) => code),
    ["delivery-driver-error"],
  );
  assert.equal(JSON.stringify(faultResult).includes("private parity"), false);
});

test("published KFD category conflict and stale package decisions match v3 exactly", () => {
  const driver = createKfdAdopterCategoryProtocolDriver();
  const artifactProfile = createPackageArtifactProfile();
  const conflict = kfdFixture();
  conflict.request.declaration.selection.profiles.push(
    structuredClone(conflict.request.declaration.selection.profiles[0]),
  );
  const conflictInput = createV4AdopterDeliveryParityInput({
    vectorId: "negative-category-conflict",
    ...conflict,
    drivers: [driver],
    artifactProfiles: [artifactProfile],
  });
  const conflictResult = project(conflictInput).result;
  assert.equal(conflictResult.status, "failed");
  assert.ok(
    conflictResult.issues.some(
      ({ code }) => code === "acp-composition-invalid",
    ),
  );

  const stale = kfdFixture();
  stale.request.declaration.kfdCut.packageVersion = "1.0.0-alpha.999";
  const staleInput = createV4AdopterDeliveryParityInput({
    vectorId: "negative-stale-package-cut",
    ...stale,
    drivers: [driver],
    artifactProfiles: [artifactProfile],
  });
  assert.ok(
    project(staleInput).result.issues.some(
      ({ code }) => code === "delivery-kfd-package-cut-mismatch",
    ),
  );
});

test("substituted expected decisions and authority roots fail closed", () => {
  const input = createV4AdopterDeliveryParityInput({
    vectorId: "negative-driver-mismatch",
    request: request("example.protocol/unknown"),
    drivers: [driver("example.protocol/alpha")],
    artifactProfiles: [createGitCommitArtifactProfile()],
  });
  const substitutedDecision = structuredClone(input);
  substitutedDecision.expectedResult.status = "passed";
  assert.throws(
    () => runV4AdopterDeliveryParity(substitutedDecision),
    /adopter-delivery-parity-mismatch/,
  );
  const substitutedAuthority = structuredClone(input);
  substitutedAuthority.sourceAuthority.vectorSuiteRoot = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => runV4AdopterDeliveryParity(substitutedAuthority),
    /invalid-adopter-delivery-parity-input/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ADOPTER_DELIVERY_GATE_REQUEST_CONTRACT,
  ADOPTER_PROTOCOL_DRIVER_INTERFACE,
  adopterDeliveryGateDigest,
  createAdopterDeliveryGate,
  createPackageArtifactProfile,
  defineAdopterProtocolDriver,
} from "../packages/core/adopter-delivery-gate.js";
import {
  createArtifactEvidence,
  createReleaseCheckReport,
  createReleasePassport,
} from "../packages/core/release-passport.js";
import {
  createAdopterDeliveryPassportBinding,
  validateAdopterDeliveryPassportBinding,
} from "../packages/core/adopter-delivery-passport.js";
import {
  defaultReleaseAgentIndex,
  defaultReleaseImpact,
  defaultReleaseProductMechanism,
} from "../packages/core/release-passport-contract.js";

const repository = "example/project";
const sourceSha = "a".repeat(40);
const checkedAt = "2026-08-12T00:00:00.000Z";
const artifact = {
  kind: "package",
  coordinate: "@example/tool@1.2.3",
  root: adopterDeliveryGateDigest("package-artifact"),
};
const assets = [
  {
    name: "example-tool.tgz",
    kind: "package",
    size: 7,
    sha256: "b".repeat(64),
  },
];

function categoryDriver() {
  return defineAdopterProtocolDriver({
    interface: ADOPTER_PROTOCOL_DRIVER_INTERFACE,
    id: "example.category/instance-manifest",
    version: "1.0.0",
    verify({ request }) {
      const report = {
        schemaVersion: 1,
        contract: "example-category-driver-report",
        valid: true,
        qualifying: false,
        selfCertified: false,
        categoryReport: structuredClone(request.declaration),
      };
      return {
        valid: true,
        report,
        reportRoot: adopterDeliveryGateDigest(report),
        issues: [],
      };
    },
  });
}

function gateResult({ coordinate = artifact.coordinate } = {}) {
  const gate = createAdopterDeliveryGate({
    drivers: [categoryDriver()],
    artifactProfiles: [createPackageArtifactProfile()],
  });
  return gate.evaluate({
    schemaVersion: 1,
    contract: ADOPTER_DELIVERY_GATE_REQUEST_CONTRACT,
    protocol: {
      id: "example.category/instance-manifest",
      version: "1.0.0",
    },
    artifactProfile: {
      id: "buildchain.artifact/package",
      version: "1.0.0",
    },
    project: { instanceId: "example-instance", adopterId: repository },
    artifact: { ...artifact, coordinate },
    declaration: {
      selectionRoot: adopterDeliveryGateDigest("category-selection"),
      requirementsRoot: adopterDeliveryGateDigest("category-requirements"),
    },
  });
}

function releaseEvidence(
  result = gateResult(),
  releaseRepository = repository,
) {
  const passport = createReleasePassport({
    repository: releaseRepository,
    tag: "v1.2.3",
    sourceSha,
    packageName: "@example/tool",
    packageVersion: "1.2.3",
    assets,
    adopterDelivery: result,
    checkedAt,
  });
  const artifactEvidence = createArtifactEvidence({
    repository: releaseRepository,
    tag: "v1.2.3",
    sourceSha,
    assets,
    adopterDelivery: result,
  });
  return { passport, artifactEvidence };
}

function check({ passport, artifactEvidence }) {
  return createReleaseCheckReport({
    passport,
    artifactEvidence,
    impact: defaultReleaseImpact({ tag: "v1.2.3", decision: "unknown" }),
    agentIndex: defaultReleaseAgentIndex({ tag: "v1.2.3" }),
    productMechanism: defaultReleaseProductMechanism({
      repository,
      productName: "Example",
    }),
    checkedAt,
  });
}

test("release passport and artifact evidence bind one exact category gate closure", () => {
  const result = gateResult();
  const first = createAdopterDeliveryPassportBinding(result);
  const replay = createAdopterDeliveryPassportBinding(result);
  const evidence = releaseEvidence(result);
  const report = check(evidence);

  assert.equal(result.status, "passed");
  assert.deepEqual(replay, first);
  assert.deepEqual(evidence.passport.adopterDelivery, first);
  assert.deepEqual(evidence.artifactEvidence.adopterDelivery, first);
  assert.deepEqual(
    validateAdopterDeliveryPassportBinding(first, {
      expectedProjectRepository: repository,
    }),
    [],
  );
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.completeness.adopterDeliveryPresent, true);
  assert.equal(first.qualifying, false);
  assert.equal(first.selfCertified, false);
});

test("release verification rejects gate, artifact evidence, and project substitution", () => {
  const original = releaseEvidence();

  const changedGate = structuredClone(original);
  changedGate.passport.adopterDelivery.gateResult.semanticReport.categoryReport.selectionRoot =
    adopterDeliveryGateDigest("substituted-selection");
  const gateReport = check(changedGate);
  assert.equal(gateReport.ok, false);
  assert.ok(
    gateReport.issues.some(
      ({ code }) => code === "adopterDelivery.binding.bindingRoot",
    ),
  );

  const changedArtifactEvidence = structuredClone(original);
  changedArtifactEvidence.artifactEvidence.adopterDelivery.gateResult.artifact.root =
    adopterDeliveryGateDigest("substituted-artifact");
  const artifactReport = check(changedArtifactEvidence);
  assert.equal(artifactReport.ok, false);
  assert.ok(
    artifactReport.issues.some(
      ({ code }) => code === "adopterDelivery.artifactEvidence",
    ),
  );

  const changedProject = releaseEvidence(gateResult(), "example/other-project");
  const projectReport = check(changedProject);
  assert.equal(projectReport.ok, false);
  assert.ok(
    projectReport.issues.some(({ code }) => code === "adopterDelivery.project"),
  );
});

test("a failed artifact profile remains explicit evidence but cannot pass release verification", () => {
  const failed = gateResult({ coordinate: "@example/tool@latest" });
  const binding = createAdopterDeliveryPassportBinding(failed);
  const report = check(releaseEvidence(failed));

  assert.equal(failed.status, "failed");
  assert.equal(binding.valid, false);
  assert.equal(binding.qualifying, false);
  assert.equal(report.ok, false);
  assert.ok(
    report.issues.some(({ code }) => code === "adopterDelivery.status"),
  );
});

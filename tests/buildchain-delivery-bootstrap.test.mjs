import assert from "node:assert/strict";
import test from "node:test";

import {
  ADOPTER_DELIVERY_GATE_RESULT_CONTRACT,
  adopterDeliveryGateDigest,
} from "../packages/core/adopter-delivery-gate.js";
import {
  BUILDCHAIN_DELIVERY_BOOTSTRAP_CONTRACT,
  qualifyBuildchainDeliveryInfrastructureBootstrap,
} from "../packages/core/buildchain-delivery-bootstrap.js";

const root = (value) => adopterDeliveryGateDigest(value);
const source = (character) => character.repeat(40);

function cut({
  version,
  sourceCommit,
  packageRoot,
  gateRoot = root("released-gate"),
  protocolRoot = root("kfd-category-driver"),
  profileRoot = root("delivery-infrastructure-profile"),
} = {}) {
  return {
    version,
    sourceCommit,
    packageRoot,
    gateRoot,
    protocol: {
      id: "kfd.adopter-category/instance-manifest",
      version: "1.0.0",
      root: protocolRoot,
    },
    profile: {
      id: "kfd.adopter-category/delivery-infrastructure",
      version: "1.0.0",
      root: profileRoot,
    },
  };
}

function fixture() {
  const authority = {
    ...cut({
      version: "3.0.9-alpha.9",
      sourceCommit: source("a"),
      packageRoot: root("buildchain-alpha.9"),
    }),
    protected: true,
    published: true,
  };
  const candidate = {
    ...cut({
      version: "3.0.9-alpha.10",
      sourceCommit: source("b"),
      packageRoot: root("buildchain-alpha.10"),
    }),
    authorityVersion: authority.version,
  };
  const gateResultBody = {
    schemaVersion: 1,
    contract: ADOPTER_DELIVERY_GATE_RESULT_CONTRACT,
    status: "passed",
    project: {
      instanceId: "kungfu-systems/buildchain@3.0.9-alpha.10",
      adopterId: "kungfu-systems/buildchain",
    },
    artifact: {
      kind: "package",
      coordinate: "@kungfu-tech/buildchain@3.0.9-alpha.10",
      root: candidate.packageRoot,
    },
    protocol: {
      id: "kfd.adopter-category/instance-manifest",
      version: "1.0.0",
      loaded: true,
      reportRoot: root("published-kfd-report"),
    },
    artifactProfile: {
      id: "buildchain.artifact/package",
      version: "1.0.0",
      loaded: true,
      valid: true,
    },
    semanticReport: {
      valid: true,
      categoryReport: { valid: true, issues: [] },
    },
    issues: [],
    qualifying: false,
    selfCertified: false,
  };
  const gateResult = {
    ...gateResultBody,
    gateRoot: adopterDeliveryGateDigest(gateResultBody),
  };
  const warrant = {
    outcome: "merged",
    sourceHead: candidate.sourceCommit,
    sourceProofRoot: root("source-proof"),
    nativeProofRoot: root("native-proof"),
    integrationProofRoot: root("integration-proof"),
  };
  return { authority, candidate, gateResult, warrant };
}

test("a protected released N-1 cut qualifies an exact distinct candidate", () => {
  const input = fixture();
  const result = qualifyBuildchainDeliveryInfrastructureBootstrap(input);

  assert.equal(result.contract, BUILDCHAIN_DELIVERY_BOOTSTRAP_CONTRACT);
  assert.equal(result.status, "passed", JSON.stringify(result.issues));
  assert.equal(result.authority.version, "3.0.9-alpha.9");
  assert.equal(result.candidate.version, "3.0.9-alpha.10");
  assert.equal(result.transitionRequired, false);
  assert.equal(result.qualifying, false);
  assert.equal(result.selfCertified, false);
  assert.equal(result.releaseAuthorized, false);
  assert.match(result.bootstrapRoot, /^sha256:[0-9a-f]{64}$/);
});

test("self-authorization, stale authority, artifact substitution, and an unmerged Warrant fail closed", () => {
  for (const [mutate, code] of [
    [
      (input) => {
        input.authority.sourceCommit = input.candidate.sourceCommit;
      },
      "bootstrap.self-authorization",
    ],
    [
      (input) => {
        input.candidate.authorityVersion = "3.0.9-alpha.8";
      },
      "bootstrap.authority.stale",
    ],
    [
      (input) => {
        input.gateResult.artifact.root = root("substituted-package");
        const body = structuredClone(input.gateResult);
        delete body.gateRoot;
        input.gateResult.gateRoot = adopterDeliveryGateDigest(body);
      },
      "bootstrap.gate.candidate",
    ],
    [
      (input) => {
        input.warrant.outcome = "qualified";
      },
      "bootstrap.warrant",
    ],
  ]) {
    const input = fixture();
    mutate(input);
    const result = qualifyBuildchainDeliveryInfrastructureBootstrap(input);
    assert.equal(result.status, "failed");
    assert.ok(
      result.issues.some((entry) => entry.code === code),
      code,
    );
    assert.equal(result.releaseAuthorized, false);
  }
});

test("protocol transitions require an exact independently reviewed proof", () => {
  const missing = fixture();
  missing.candidate.protocol = {
    ...missing.candidate.protocol,
    version: "2.0.0",
    root: root("kfd-category-driver-v2"),
  };
  const failed = qualifyBuildchainDeliveryInfrastructureBootstrap(missing);
  assert.equal(failed.status, "failed");
  assert.ok(failed.issues.some(({ code }) => code === "bootstrap.transition"));

  const transitionBody = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-delivery-bootstrap-transition/v1",
    fromGateRoot: missing.authority.gateRoot,
    toGateRoot: missing.candidate.gateRoot,
    fromProtocolRoot: missing.authority.protocol.root,
    toProtocolRoot: missing.candidate.protocol.root,
    fromProfileRoot: missing.authority.profile.root,
    toProfileRoot: missing.candidate.profile.root,
    compatibilityProofRoot: root("compatibility-proof"),
    independentReviewRoot: root("independent-review"),
  };
  missing.transitionEvidence = {
    ...transitionBody,
    transitionRoot: adopterDeliveryGateDigest(transitionBody),
  };
  const passed = qualifyBuildchainDeliveryInfrastructureBootstrap(missing);
  assert.equal(passed.status, "passed", JSON.stringify(passed.issues));
  assert.equal(passed.transitionRequired, true);

  missing.transitionEvidence.independentReviewRoot = root("substitution");
  const tampered = qualifyBuildchainDeliveryInfrastructureBootstrap(missing);
  assert.equal(tampered.status, "failed");
  assert.ok(
    tampered.issues.some(({ code }) => code === "bootstrap.transition"),
  );
});

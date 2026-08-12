import assert from "node:assert/strict";
import test from "node:test";

import {
  ADOPTER_ARTIFACT_PROFILE_INTERFACE,
  ADOPTER_DELIVERY_GATE_REQUEST_CONTRACT,
  ADOPTER_PROTOCOL_DRIVER_INTERFACE,
  adopterDeliveryGateDigest,
  createAdopterDeliveryGate,
  createGitCommitArtifactProfile,
  createPackageArtifactProfile,
  defineAdopterArtifactProfile,
  defineAdopterProtocolDriver,
} from "../packages/core/adopter-delivery-gate.js";

const root = (value) => adopterDeliveryGateDigest(value);

function driver(id) {
  return defineAdopterProtocolDriver({
    interface: ADOPTER_PROTOCOL_DRIVER_INTERFACE,
    id,
    version: "1.0.0",
    verify({ request }) {
      const report = { protocol: id, declaration: request.declaration };
      return { valid: true, report, reportRoot: root(report), issues: [] };
    },
  });
}

function request({
  protocol = "example.protocol/alpha",
  profile = "buildchain.artifact/git-commit",
  artifact = {
    kind: "git-commit",
    coordinate: `example/project@${"a".repeat(40)}`,
    root: root("artifact"),
  },
} = {}) {
  return {
    schemaVersion: 1,
    contract: ADOPTER_DELIVERY_GATE_REQUEST_CONTRACT,
    protocol: { id: protocol, version: "1.0.0" },
    artifactProfile: { id: profile, version: "1.0.0" },
    project: { instanceId: "example-instance", adopterId: "example/project" },
    artifact,
    declaration: { accepted: true },
  };
}

test("one protocol-neutral gate loads isolated drivers without project branches", () => {
  const gate = createAdopterDeliveryGate({
    drivers: [
      driver("example.protocol/alpha"),
      driver("example.protocol/beta"),
    ],
    artifactProfiles: [createGitCommitArtifactProfile()],
  });

  const alpha = gate.evaluate(request());
  const beta = gate.evaluate(request({ protocol: "example.protocol/beta" }));

  assert.equal(alpha.status, "passed");
  assert.equal(beta.status, "passed");
  assert.equal(alpha.semanticReport.protocol, "example.protocol/alpha");
  assert.equal(beta.semanticReport.protocol, "example.protocol/beta");
  assert.equal(alpha.qualifying, false);
  assert.equal(beta.selfCertified, false);
});

test("git commit and package coordinates use explicit isolated profiles", () => {
  const gate = createAdopterDeliveryGate({
    drivers: [driver("example.protocol/alpha")],
    artifactProfiles: [
      createGitCommitArtifactProfile(),
      createPackageArtifactProfile(),
    ],
  });
  const packageResult = gate.evaluate(
    request({
      profile: "buildchain.artifact/package",
      artifact: {
        kind: "package",
        coordinate: "@example/tool@1.2.3",
        root: root("package"),
      },
    }),
  );
  const mismatched = gate.evaluate(
    request({
      profile: "buildchain.artifact/package",
    }),
  );

  assert.equal(packageResult.status, "passed");
  assert.deepEqual(
    mismatched.issues.map(({ code }) => code),
    ["delivery-artifact-kind-mismatch"],
  );

  const mutableTag = gate.evaluate(
    request({
      profile: "buildchain.artifact/package",
      artifact: {
        kind: "package",
        coordinate: "@example/tool@latest",
        root: root("package"),
      },
    }),
  );
  assert.deepEqual(
    mutableTag.issues.map(({ code }) => code),
    ["delivery-artifact-invalid"],
  );
});

test("a declared custom immutable artifact kind does not widen the core", () => {
  const archiveProfile = defineAdopterArtifactProfile({
    interface: ADOPTER_ARTIFACT_PROFILE_INTERFACE,
    id: "example.artifact/archive",
    version: "1.0.0",
    kinds: ["archive"],
    verify(artifact) {
      const valid = artifact.coordinate.endsWith(".tar.zst");
      return {
        valid,
        issues: valid
          ? []
          : [
              {
                code: "archive-coordinate-invalid",
                path: "/artifact/coordinate",
                message: "Archive coordinate must name a tar.zst object.",
              },
            ],
      };
    },
  });
  const gate = createAdopterDeliveryGate({
    drivers: [driver("example.protocol/alpha")],
    artifactProfiles: [archiveProfile],
  });
  const result = gate.evaluate(
    request({
      profile: "example.artifact/archive",
      artifact: {
        kind: "archive",
        coordinate: "artifact.tar.zst",
        root: root("archive"),
      },
    }),
  );

  assert.equal(result.status, "passed");
  assert.equal(result.artifact.kind, "archive");
});

test("unknown and malformed states fail closed with deterministic diagnostics", () => {
  const gate = createAdopterDeliveryGate({
    drivers: [driver("example.protocol/alpha")],
    artifactProfiles: [createGitCommitArtifactProfile()],
  });
  const unknownDriver = gate.evaluate(
    request({ protocol: "example.protocol/unknown" }),
  );
  const unknownProfile = gate.evaluate(
    request({ profile: "example.artifact/unknown" }),
  );
  const malformed = gate.evaluate({ ...request(), unexpected: true });
  const replay = gate.evaluate({ ...request(), unexpected: true });

  assert.deepEqual(
    unknownDriver.issues.map(({ code }) => code),
    ["delivery-driver-unknown"],
  );
  assert.deepEqual(
    unknownProfile.issues.map(({ code }) => code),
    ["delivery-artifact-profile-unknown"],
  );
  assert.deepEqual(malformed.issues, replay.issues);
  assert.equal(malformed.gateRoot, replay.gateRoot);
  assert.equal(malformed.status, "failed");
});

test("non-JSON declarations and driver reports fail closed without unstable cloning", () => {
  const invalidReport = defineAdopterProtocolDriver({
    interface: ADOPTER_PROTOCOL_DRIVER_INTERFACE,
    id: "example.protocol/non-json",
    version: "1.0.0",
    verify() {
      return {
        valid: true,
        report: { observed: Number.NaN },
        reportRoot: root("invalid-report"),
        issues: [],
      };
    },
  });
  const gate = createAdopterDeliveryGate({
    drivers: [driver("example.protocol/alpha"), invalidReport],
    artifactProfiles: [createGitCommitArtifactProfile()],
  });
  const cyclic = { accepted: true };
  cyclic.self = cyclic;

  const invalidDeclaration = gate.evaluate({
    ...request(),
    declaration: cyclic,
  });
  const invalidDriverReport = gate.evaluate(
    request({ protocol: "example.protocol/non-json" }),
  );

  assert.deepEqual(
    invalidDeclaration.issues.map(({ code }) => code),
    ["delivery-input-invalid"],
  );
  assert.deepEqual(
    invalidDriverReport.issues.map(({ code }) => code),
    ["delivery-driver-result-invalid"],
  );
  assert.throws(
    () => adopterDeliveryGateDigest({ value: undefined }),
    /finite acyclic JSON values/,
  );
});

test("driver exceptions and invalid results fail closed", () => {
  const broken = defineAdopterProtocolDriver({
    interface: ADOPTER_PROTOCOL_DRIVER_INTERFACE,
    id: "example.protocol/broken",
    version: "1.0.0",
    verify() {
      throw new Error("private detail");
    },
  });
  const gate = createAdopterDeliveryGate({
    drivers: [broken],
    artifactProfiles: [createGitCommitArtifactProfile()],
  });
  const result = gate.evaluate(
    request({ protocol: "example.protocol/broken" }),
  );

  assert.deepEqual(
    result.issues.map(({ code }) => code),
    ["delivery-driver-error"],
  );
  assert.equal(JSON.stringify(result).includes("private detail"), false);
});

test("silent profile rejection becomes an explicit stable failure", () => {
  const silent = defineAdopterArtifactProfile({
    interface: ADOPTER_ARTIFACT_PROFILE_INTERFACE,
    id: "example.artifact/silent",
    version: "1.0.0",
    kinds: ["archive"],
    verify() {
      return { valid: false, issues: [] };
    },
  });
  const gate = createAdopterDeliveryGate({
    drivers: [driver("example.protocol/alpha")],
    artifactProfiles: [silent],
  });
  const result = gate.evaluate(
    request({
      profile: "example.artifact/silent",
      artifact: {
        kind: "archive",
        coordinate: "opaque://artifact",
        root: root("archive"),
      },
    }),
  );

  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.issues.map(({ code }) => code),
    ["delivery-artifact-rejected"],
  );
});

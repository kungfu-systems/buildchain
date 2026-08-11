import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KFD_PRODUCT_GATE_CONTRACT,
  KFD_PRODUCT_GATE_INPUT_CONTRACT,
  evaluateKfdProductGate,
  kfdProductGateDigest,
  validateKfdProductGateResult,
  verifyKfdRecord,
} from "../packages/core/kfd-product-gates.js";
import {
  KFD_ADOPTER_MANIFEST_GATE_CONTRACT,
  createKfdAdopterManifestGate,
  createKfdLegacySupportMatrixProjection,
  validateKfdAdopterManifestGate,
  validateKfdLegacySupportMatrixProjection,
} from "../packages/core/kfd-adopter-manifest.js";
import {
  addAdopterWitness,
  initAdopterManifest,
} from "@kungfu-tech/kfd/adopter-conformance/toolchain";
import { generateBuildchainKfdAdopterRelease } from "../scripts/generate-buildchain-kfd-witnesses.mjs";
import {
  collectGitHubReleasePassport,
  verifyReleasePassport,
} from "../packages/core/release-passport.js";
import { collectKfdAdopterReleaseEvidence } from "../packages/core/release-passport-contract.js";

const require = createRequire(import.meta.url);
const kfdRoot = path.dirname(require.resolve("@kungfu-tech/kfd/package.json"));
const standardsPath = require.resolve("@kungfu-tech/kfd/standards.json");
const standards = JSON.parse(fs.readFileSync(standardsPath, "utf8"));
const sourceSha = "a".repeat(40);
const checkedAt = "2026-07-26T12:00:00.000Z";
const kfdPackageArtifactRoot = "sha256:07bea3dacab8cba10901539a5acb958db1ee09738fd424c9933f9baa2187675b";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-kfd-product-gate-"));
}

function writeJson(cwd, relativePath, value) {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return {
    path: relativePath,
    sha256: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`,
  };
}

function copyPackageJson(cwd, packageRelativePath, outputRelativePath, transform = (value) => value) {
  const value = JSON.parse(fs.readFileSync(path.join(kfdRoot, packageRelativePath), "utf8"));
  return writeJson(cwd, outputRelativePath, transform(value));
}

function evidence(cwd, id, kind) {
  return {
    id,
    kind,
    ...writeJson(cwd, `evidence/${id}.json`, { id, kind, status: "passed" }),
  };
}

function gateInput(standard, records, gateEvidence) {
  return {
    schemaVersion: 1,
    contract: KFD_PRODUCT_GATE_INPUT_CONTRACT,
    standard,
    standardRevision: standards.standards[standard].revision,
    source: { repository: "kungfu-systems/kungfu", sha: sourceSha },
    evidenceCut: {
      generatedAt: "2026-07-26T11:00:00.000Z",
      expiresAt: "2026-07-27T11:00:00.000Z",
    },
    records,
    evidence: gateEvidence,
    responsibility: {
      owner: "kungfu-systems/kungfu",
      evidenceOwner: "Kungfu maintainers",
      proofOwner: "Buildchain",
    },
    nonClaims: ["A passed gate is not KFD certification or an automatic shipped-support claim."],
  };
}

function kfd4Records(cwd) {
  const perspective = {
    schemaVersion: 1,
    contract: "kfd-4-observer-perspective",
    standard: "kfd-4",
    id: "release-maintainer-view",
    observer: { id: "release-maintainer", kind: "human" },
    acceptedFacts: [{ sourceId: "release-source", sourceKind: "repository" }],
    projectionPolicy: {
      policyVersion: "1",
      causalDominance: true,
      tieBreaker: "source-coordinate",
    },
    verification: { result: "pass" },
  };
  const replay = {
    schemaVersion: 1,
    contract: "kfd-4-perspective-replay",
    standard: "kfd-4",
    replayId: "release-product-contrast",
    mode: "contrastive",
    sourceViews: [
      {
        id: "maintainer",
        kind: "observer-view",
        coordinate: "view://maintainer",
        observer: "release-maintainer",
        perspective: "release-integrity",
        acceptedFactCut: "git://source",
        naturalObjects: ["release"],
        consequences: ["published artifact"],
        knownGaps: [],
      },
      {
        id: "consumer",
        kind: "observer-view",
        coordinate: "view://consumer",
        observer: "release-consumer",
        perspective: "artifact-consumption",
        acceptedFactCut: "artifact://release",
        naturalObjects: ["package"],
        consequences: ["installed product"],
        knownGaps: ["local environment"],
      },
    ],
    replayObserver: {
      id: "buildchain",
      kind: "service",
      purpose: "retain product and consumer fact boundaries",
    },
    reconstruction: {
      policyVersion: "1",
      sharedContext: "same source-bound release",
      preservedElements: ["observer", "accepted-fact-cut", "evidence-boundary"],
      declaredLoss: ["local runtime state"],
      degradedState: "none",
    },
    contrast: {
      dimensions: ["evidence-boundary"],
      mismatches: [{
        sourceViewIds: ["maintainer", "consumer"],
        observation: "source and artifact evidence have different custody",
        primitiveSignal: "inconclusive",
      }],
    },
    verification: { result: "pass", evidence: ["evidence/projection.json"] },
  };
  return [
    { role: "observer-perspective", ...writeJson(cwd, "records/kfd-4-perspective.json", perspective) },
    { role: "perspective-replay", ...writeJson(cwd, "records/kfd-4-replay.json", replay) },
  ];
}

function kfd5Records(cwd) {
  return [{
    role: "primitive-discovery",
    ...copyPackageJson(
      cwd,
      "cases/live/software-work-perspective-settlement/cuts/0001-assignment.json",
      "records/kfd-5-primitive-discovery.json",
    ),
  }];
}

function kfd7Records(cwd) {
  return [{
    role: "domain-profile",
    ...copyPackageJson(
      cwd,
      "verifier/fixtures/kfd-7/valid-domain-profile.json",
      "records/kfd-7-domain-profile.json",
      (profile) => ({
        ...profile,
        evidenceObligations: profile.evidenceObligations.map((entry) => ({
          ...entry,
          status: "passed",
          artifactRefs: ["qualification-proof"],
          residualRisk: "Bound to the retained product qualification cut.",
        })),
        activation: {
          decision: "activate",
          evidenceCut: "sha256:qualified-product-cut",
          independentReview: "review://independent-release-review",
          productWitnesses: ["qualification-proof"],
          residualRisk: "Independent transfer remains outside this product release.",
        },
        domainProfile: {
          ...profile.domainProfile,
          product: "Kungfu",
          implementation: `git+https://github.com/kungfu-systems/kungfu@${sourceSha}`,
          qualificationStatus: "qualified",
        },
      }),
    ),
  }];
}

async function passingGate(cwd, standard) {
  const records = standard === "kfd-4"
    ? kfd4Records(cwd)
    : standard === "kfd-5"
      ? kfd5Records(cwd)
      : kfd7Records(cwd);
  const gateEvidence = standard === "kfd-4"
    ? [evidence(cwd, "projection-fsck", "projection-fsck"), evidence(cwd, "negative", "negative-fixture")]
    : standard === "kfd-5"
      ? [evidence(cwd, "negative", "negative-fixture")]
      : [
          evidence(cwd, "qualification-proof", "qualification-proof"),
          evidence(cwd, "independent-review", "independent-review"),
          evidence(cwd, "negative", "negative-fixture"),
        ];
  return evaluateKfdProductGate({
    cwd,
    input: gateInput(standard, records, gateEvidence),
    expectedSourceSha: sourceSha,
    checkedAt,
  });
}

function manifestEvidence(id, kind, root) {
  return {
    kind,
    coordinate: `git+https://github.com/kungfu-systems/buildchain@${sourceSha}#${id.toLowerCase()}`,
    root,
    observedAt: checkedAt,
    kfdPackageRoot: kfdPackageArtifactRoot,
  };
}

function buildchainAdopterManifest(gates) {
  const gateById = new Map(gates.map((gate) => [gate.standard.toUpperCase(), gate]));
  const manifest = initAdopterManifest({
    manifestId: "buildchain-v3-full-cut",
    adopterId: "kungfu-systems/buildchain",
    artifactKind: "git-commit",
    artifactCoordinate: `kungfu-systems/buildchain@${sourceSha}`,
    artifactRoot: `sha256:${"b".repeat(64)}`,
    scope: "Buildchain v3 release and protected delivery authority",
    packageArtifactRoot: kfdPackageArtifactRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds: 86400,
  });
  for (const id of ["KFD-1", "KFD-2", "KFD-3", "KFD-4", "KFD-5", "KFD-7"]) {
    const row = manifest.decisions.find((entry) => entry.id === id);
    const suffix = String(row.number).padStart(2, "0");
    row.state = "candidate";
    row.usage = "used";
    row.implementationEvidence = [manifestEvidence(id, "implementation", `sha256:${suffix.repeat(32)}`)];
    row.verificationEvidence = [manifestEvidence(
      id,
      "verification",
      gateById.get(id)?.gateRoot || `sha256:${String(row.number + 20).padStart(2, "0").repeat(32)}`,
    )];
    row.gaps = ["Independent decision-specific assessment remains external."];
  }
  const kfd6 = manifest.decisions.find((entry) => entry.id === "KFD-6");
  kfd6.state = "unsupported";
  kfd6.gaps = ["Buildchain does not claim KFD-6 support in this cut."];
  return addAdopterWitness(manifest, {
    decisionId: "KFD-10",
    profileId: "kfd-warrant-evidence",
    witnessCoordinate: `kungfu-systems/buildchain@${sourceSha}#dev-delivery-warrant`,
    witnessRoot: `sha256:${"c".repeat(64)}`,
    packageArtifactRoot: kfdPackageArtifactRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds: 86400,
  });
}

test("KFD-4/5/7 product gates bind real KFD records and retained evidence", async () => {
  for (const standard of ["kfd-4", "kfd-5", "kfd-7"]) {
    const cwd = tempDir();
    const gate = await passingGate(cwd, standard);
    assert.equal(gate.status, "passed", JSON.stringify(gate.issues));
    assert.equal(gate.qualifying, false);
    assert.equal(gate.selfCertified, false);
    assert.equal(validateKfdProductGateResult(gate, { expectedSourceSha: sourceSha, checkedAt }).valid, true);
    for (const record of gate.records) {
      assert.equal(record.verifier.valid, true);
    }
  }
});

test("product gates fail closed on evidence drift and stale cuts", async () => {
  const cwd = tempDir();
  const records = kfd4Records(cwd);
  const gateEvidence = [
    evidence(cwd, "projection-fsck", "projection-fsck"),
    evidence(cwd, "negative", "negative-fixture"),
  ];
  fs.appendFileSync(path.join(cwd, records[0].path), "\n");
  const gate = await evaluateKfdProductGate({
    cwd,
    input: gateInput("kfd-4", records, gateEvidence),
    expectedSourceSha: sourceSha,
    checkedAt: "2026-07-28T12:00:00.000Z",
  });
  assert.equal(gate.status, "failed");
  assert.ok(gate.issues.some((entry) => entry.code === "evidence-drift"));
  assert.ok(gate.issues.some((entry) => entry.code === "stale-evidence"));
});

test("standard adopter manifest is the sole authority for the legacy support projection", async () => {
  const gates = [];
  for (const standard of ["kfd-4", "kfd-5", "kfd-7"]) {
    gates.push(await passingGate(tempDir(), standard));
  }
  const manifest = buildchainAdopterManifest(gates);
  const manifestGate = createKfdAdopterManifestGate({
    manifest,
    packageArtifactRoot: kfdPackageArtifactRoot,
    gateResults: gates,
    expectedSourceSha: sourceSha,
    checkedAt,
  });
  assert.equal(manifestGate.contract, KFD_ADOPTER_MANIFEST_GATE_CONTRACT);
  assert.equal(manifestGate.status, "passed", JSON.stringify(manifestGate.issues));
  assert.equal(manifestGate.qualifying, false);
  assert.equal(manifestGate.selfCertified, false);
  assert.equal(validateKfdAdopterManifestGate(manifestGate, { expectedSourceSha: sourceSha, checkedAt }).valid, true);

  const legacy = createKfdLegacySupportMatrixProjection({ manifest, manifestGate });
  assert.equal(legacy.authority.contract, "kfd.adopter-conformance-manifest/v1");
  assert.equal(legacy.authority.root, manifestGate.authority.manifestRoot);
  assert.equal(legacy.rows.find((row) => row.id === "KFD-6").supportStatus, "unsupported");
  assert.equal(legacy.rows.find((row) => row.id === "KFD-10").supportStatus, "draft-adopter-evidence");
  assert.equal(validateKfdLegacySupportMatrixProjection(legacy, { manifest, manifestGate }).valid, true);

  const cliCwd = tempDir();
  writeJson(cliCwd, "manifest.json", manifest);
  writeJson(cliCwd, "manifest-gate.json", manifestGate);
  const projected = JSON.parse(execFileSync(process.execPath, [
    path.resolve("bin/buildchain.mjs"), "kfd", "support", "project",
    "--cwd", cliCwd, "--manifest-json", "manifest.json",
    "--manifest-gate-json", "manifest-gate.json", "--json",
  ], { encoding: "utf8" }));
  assert.deepEqual(projected, legacy);
  writeJson(cliCwd, "projection.json", projected);
  const cliVerification = JSON.parse(execFileSync(process.execPath, [
    path.resolve("bin/buildchain.mjs"), "kfd", "support", "verify",
    "--cwd", cliCwd, "--projection-json", "projection.json",
    "--manifest-json", "manifest.json", "--manifest-gate-json", "manifest-gate.json", "--json",
  ], { encoding: "utf8" }));
  assert.equal(cliVerification.ok, true, JSON.stringify(cliVerification.issues));

  const drifted = structuredClone(legacy);
  drifted.rows.find((row) => row.id === "KFD-1").supportStatus = "adopted";
  const drift = validateKfdLegacySupportMatrixProjection(drifted, { manifest, manifestGate });
  assert.equal(drift.valid, false);
  assert.ok(drift.issues.some((entry) => entry.code === "legacy-projection-drift"));

  const substitutedManifest = structuredClone(manifest);
  substitutedManifest.decisions.find((row) => row.id === "KFD-1").gaps.push("Sibling manifest content.");
  assert.throws(
    () => createKfdLegacySupportMatrixProjection({ manifest: substitutedManifest, manifestGate }),
    /manifest does not match the exact gate authority closure/,
  );

  const incompleteGate = structuredClone(manifestGate);
  incompleteGate.gateResults.pop();
  delete incompleteGate.gateRoot;
  incompleteGate.gateRoot = kfdProductGateDigest(incompleteGate);
  const incomplete = validateKfdAdopterManifestGate(incompleteGate, { expectedSourceSha: sourceSha, checkedAt });
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.issues.some((entry) => entry.code === "adopter-gate-result-set"));
});

test("Buildchain self release emits one exact full-cut adopter authority", async () => {
  const generated = await generateBuildchainKfdAdopterRelease({
    cwd: process.cwd(), outputDir: tempDir(), sourceSha, checkedAt, emitOutputs: false,
  });
  const load = (key) => JSON.parse(fs.readFileSync(path.resolve(generated.outputs[key]), "utf8"));
  const manifest = load("kfd-adopter-manifest-json");
  const gate = load("kfd-adopter-manifest-gate-json");
  const support = load("kfd-support-matrix-json");
  assert.equal(manifest.adopter.artifact.coordinate, `kungfu-systems/buildchain@${sourceSha}`);
  assert.equal(gate.authority.manifestRoot, generated.outputs["kfd-adopter-manifest-root"]);
  assert.equal(validateKfdAdopterManifestGate(gate, { expectedSourceSha: sourceSha, checkedAt }).valid, true);
  assert.equal(validateKfdLegacySupportMatrixProjection(support, { manifest, manifestGate: gate }).valid, true);
  assert.deepEqual(gate.gateResults.map((entry) => entry.standard), ["kfd-4", "kfd-5", "kfd-7"]);

  const releaseEvidence = collectKfdAdopterReleaseEvidence({
    manifest,
    gateResults: generated.outputs["kfd-product-gate-jsons"]
      .split(",")
      .map((filePath) => JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"))),
    comparisonMatrix: support,
    sourceSha,
    checkedAt,
  });
  assert.equal(releaseEvidence.manifestGate.authority.path, "kfd-adopter-manifest.json");
  assert.equal(releaseEvidence.legacyProjection.authority.root, gate.authority.manifestRoot);
});

test("adopter manifest gate fails closed on package, row, gate, and Warrant witness substitution", async () => {
  const gates = [];
  for (const standard of ["kfd-4", "kfd-5", "kfd-7"]) {
    gates.push(await passingGate(tempDir(), standard));
  }
  const manifest = buildchainAdopterManifest(gates);
  const cases = [
    {
      name: "package root",
      manifest,
      packageArtifactRoot: `sha256:${"d".repeat(64)}`,
      code: "adopter-manifest-invalid",
    },
    {
      name: "missing row",
      manifest: { ...manifest, decisions: manifest.decisions.filter((row) => row.id !== "KFD-3") },
      packageArtifactRoot: kfdPackageArtifactRoot,
      code: "adopter-manifest-invalid",
    },
    {
      name: "unbound product gate",
      manifest: structuredClone(manifest),
      packageArtifactRoot: kfdPackageArtifactRoot,
      code: "adopter-gate-unbound",
      mutate(value) {
        value.decisions.find((row) => row.id === "KFD-4").verificationEvidence[0].root = `sha256:${"e".repeat(64)}`;
      },
    },
    {
      name: "Warrant witness",
      manifest: structuredClone(manifest),
      packageArtifactRoot: kfdPackageArtifactRoot,
      code: "adopter-manifest-invalid",
      mutate(value) {
        value.decisions.find((row) => row.id === "KFD-10").witnessBindings[0].verifierRoot = `sha256:${"f".repeat(64)}`;
      },
    },
  ];
  for (const fixture of cases) {
    fixture.mutate?.(fixture.manifest);
    const gate = createKfdAdopterManifestGate({
      manifest: fixture.manifest,
      packageArtifactRoot: fixture.packageArtifactRoot,
      gateResults: gates,
      expectedSourceSha: sourceSha,
      checkedAt,
    });
    assert.equal(gate.status, "failed", fixture.name);
    assert.ok(gate.issues.some((entry) => entry.code === fixture.code), `${fixture.name}: ${JSON.stringify(gate.issues)}`);
  }
});

test("release passport and artifact evidence bind the exact standard adopter closure", async () => {
  const cwd = tempDir();
  const gates = [];
  for (const standard of ["kfd-4", "kfd-5", "kfd-7"]) {
    gates.push(await passingGate(cwd, standard));
  }
  const manifest = buildchainAdopterManifest(gates);
  const manifestPath = writeJson(cwd, "adopter-manifest.json", manifest).path;
  const gatePaths = gates.map((gate, index) => writeJson(cwd, `gate-${index + 1}.json`, gate).path);
  fs.mkdirSync(path.join(cwd, "assets"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "assets/buildchain.tgz"), "buildchain artifact\n");

  const output = collectGitHubReleasePassport({
    cwd,
    repository: "kungfu-systems/buildchain",
    tag: "v3.0.0-alpha.1",
    sourceSha,
    outputDir: "release-passport",
    assetsDir: "assets",
    kfdAdopterManifestJson: manifestPath,
    kfdProductGateJsons: gatePaths,
    checkedAt,
  });
  assert.equal(output.passport.kfdAdopter.status, "passed");
  assert.equal(output.passport.kfdAdopter.qualifying, false);
  assert.equal(output.passport.kfdAdopter.standardPackage.artifactRoot, kfdPackageArtifactRoot);
  assert.match(output.passport.kfdAdopter.standardPackage.registryRoot, /^sha256:[0-9a-f]{64}$/);
  assert.match(output.passport.kfdAdopter.standardPackage.verifierSetRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(output.passport.kfdAdopter.witness.decisionRoot, output.artifactEvidence.kfdAdopter.witness.decisionRoot);
  assert.equal(output.passport.kfdAdopter.bindingRoot, output.artifactEvidence.kfdAdopter.bindingRoot);
  assert.equal(output.passport.kfdSupport.authority.root, output.passport.kfdAdopter.authority.manifestRoot);
  assert.equal(output.checkReport.ok, true, JSON.stringify(output.checkReport.issues));

  const passportPath = path.join(cwd, "release-passport/buildchain.release.json");
  const verified = await verifyReleasePassport({ passportLocation: passportPath, checkedAt });
  assert.equal(verified.ok, true, JSON.stringify(verified.issues));

  const manifestSiblingPath = path.join(cwd, "release-passport/kfd-adopter-manifest.json");
  const manifestSibling = JSON.parse(fs.readFileSync(manifestSiblingPath, "utf8"));
  manifestSibling.decisions.find((row) => row.id === "KFD-1").gaps.push("substituted sibling");
  fs.writeFileSync(manifestSiblingPath, `${JSON.stringify(manifestSibling, null, 2)}\n`);
  const manifestTampered = await verifyReleasePassport({ passportLocation: passportPath, checkedAt });
  assert.equal(manifestTampered.ok, false);
  assert.ok(manifestTampered.issues.some((entry) => entry.code.startsWith("kfdAdopter.")));

  fs.writeFileSync(manifestSiblingPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  passport.kfdAdopter.standardPackage.registryRoot = `sha256:${"e".repeat(64)}`;
  fs.writeFileSync(passportPath, `${JSON.stringify(passport, null, 2)}\n`);
  const passportTampered = await verifyReleasePassport({ passportLocation: passportPath, checkedAt });
  assert.equal(passportTampered.ok, false);
  assert.ok(passportTampered.issues.some((entry) => entry.code === "kfdAdopter.bindingRoot"));

  fs.writeFileSync(passportPath, `${JSON.stringify(output.passport, null, 2)}\n`);
  const artifactEvidencePath = path.join(cwd, "release-passport/artifact-evidence.json");
  const artifactEvidence = JSON.parse(fs.readFileSync(artifactEvidencePath, "utf8"));
  artifactEvidence.kfdAdopter.witness.bundleRoot = `sha256:${"f".repeat(64)}`;
  fs.writeFileSync(artifactEvidencePath, `${JSON.stringify(artifactEvidence, null, 2)}\n`);
  const artifactTampered = await verifyReleasePassport({ passportLocation: passportPath, checkedAt });
  assert.equal(artifactTampered.ok, false);
  assert.ok(artifactTampered.issues.some((entry) => entry.code === "kfdAdopter.artifactEvidence"));

  const substitutedPackageManifest = structuredClone(manifest);
  substitutedPackageManifest.kfdCut.package.artifactRoot = `sha256:${"d".repeat(64)}`;
  const substitutedPackagePath = writeJson(cwd, "substituted-package-manifest.json", substitutedPackageManifest).path;
  assert.throws(
    () => collectGitHubReleasePassport({
      cwd,
      repository: "kungfu-systems/buildchain",
      tag: "v3.0.0-alpha.1",
      sourceSha,
      outputDir: "substituted-package-passport",
      assetsDir: "assets",
      kfdAdopterManifestJson: substitutedPackagePath,
      kfdProductGateJsons: gatePaths,
      checkedAt,
    }),
    /legacy support projection requires the exact passing standard adopter manifest authority/,
  );
  assert.throws(
    () => collectGitHubReleasePassport({
      cwd,
      repository: "kungfu-systems/buildchain",
      tag: "v3.0.0-alpha.1",
      sourceSha: "b".repeat(40),
      outputDir: "substituted-source-passport",
      assetsDir: "assets",
      kfdAdopterManifestJson: manifestPath,
      kfdProductGateJsons: gatePaths,
      checkedAt,
    }),
    /legacy support projection requires the exact passing standard adopter manifest authority/,
  );

  const gate = createKfdAdopterManifestGate({
    manifest,
    packageArtifactRoot: kfdPackageArtifactRoot,
    gateResults: gates,
    expectedSourceSha: sourceSha,
    checkedAt,
  });
  const driftedLegacy = createKfdLegacySupportMatrixProjection({ manifest, manifestGate: gate });
  driftedLegacy.rows.find((row) => row.id === "KFD-1").supportStatus = "adopted";
  const driftedLegacyPath = writeJson(cwd, "drifted-support-matrix.json", driftedLegacy).path;
  assert.throws(
    () => collectGitHubReleasePassport({
      cwd,
      repository: "kungfu-systems/buildchain",
      tag: "v3.0.0-alpha.1",
      sourceSha,
      outputDir: "drifted-release-passport",
      assetsDir: "assets",
      kfdAdopterManifestJson: manifestPath,
      kfdSupportMatrixJson: driftedLegacyPath,
      kfdProductGateJsons: gatePaths,
      checkedAt,
    }),
    /legacy KFD support matrix drifted from the standard adopter manifest/,
  );
});

test("KFD package verifier rejects structurally invalid records independently of product gates", async () => {
  const report = await verifyKfdRecord({
    schemaVersion: 1,
    contract: "kfd-4-observer-perspective",
    standard: "kfd-4",
  });
  assert.equal(report.valid, false);
});

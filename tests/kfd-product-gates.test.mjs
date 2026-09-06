import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
  collectGitHubReleasePassport,
  verifyReleasePassport,
} from "../packages/core/release-passport.js";

import { sourceSha, checkedAt, kfdPackageArtifactRoot, tempDir, writeJson, evidence, gateInput, kfd4Records, passingGate, buildchainAdopterManifest } from "./helpers/kfd-product-gates.mjs";

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

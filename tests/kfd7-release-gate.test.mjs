import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import {
  KFD7_EVIDENCE_REPORT_CONTRACT,
  KFD7_RELEASE_GATE_INPUT_CONTRACT,
  createKfd7ReleaseGateEvidence,
  validateKfd7ReleaseGateEvidence,
} from "../packages/core/kfd7-release-gate.js";
import { createReleasePassport } from "../packages/core/release-passport.js";

const require = createRequire(import.meta.url);

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-kfd7-${name}-`));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return { path: relativePath, sha256: sha256File(filePath) };
}

function validKfd7ActionContract() {
  const packageRoot = path.dirname(require.resolve("@kungfu-tech/kfd/package.json"));
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "verifier/fixtures/kfd-7/valid-action-contract.json"), "utf8"));
}

function evidenceReport({ sourceSha, kind = "", category = "", outcome = "pass" }) {
  return {
    schemaVersion: 1,
    contract: KFD7_EVIDENCE_REPORT_CONTRACT,
    profileId: "example-action-profile",
    profileVersion: "0.1.0",
    stateMachineVersion: "0.1.0",
    sourceSha,
    ...(kind ? { kind } : {}),
    ...(category ? { category } : {}),
    outcome,
    matchedExpectation: true,
    checks: [{ id: `${kind || category}-retained`, status: "pass" }],
  };
}

function createFixture(name) {
  const cwd = tempDir(name);
  const sourceSha = "a".repeat(40);
  const actionContract = writeJson(cwd, "contracts/action-contract.json", validKfd7ActionContract());
  const verifierReport = writeJson(cwd, "evidence/kfd-verifier.json", {
    schemaVersion: 1,
    contract: "kfd.verification-report/v1",
    profile: "https://kfd.libkungfu.dev/schemas/kfd-7/action-contract.schema.json",
    valid: true,
    qualifying: false,
    selfCertified: false,
    offline: true,
    checks: [{ id: "json-schema", status: "pass" }],
    issues: [],
  });
  const positive = writeJson(cwd, "evidence/positive.json", evidenceReport({ sourceSha, kind: "positive" }));
  const negative = writeJson(cwd, "evidence/negative.json", evidenceReport({ sourceSha, kind: "negative", outcome: "fail" }));
  const experiments = [
    "role-deletion-or-fusion",
    "export-import-rebuild",
    "backend-migration",
    "concurrency-retry-compensation",
    "warrant-decay-revocation",
    "atlas-staleness-loss",
    "pursuit-continuity-settlement",
    "episode-replay-contraction",
    "cold-start-continuation",
  ].map((category) => ({
    id: category,
    category,
    expectedOutcome: "pass",
    ...writeJson(cwd, `evidence/${category}.json`, evidenceReport({ sourceSha, category })),
  }));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/profile.json"), "profile-surface\n");
  fs.writeFileSync(path.join(cwd, "dist/profile.json"), "profile-surface\n");
  const surfaceSha = sha256File(path.join(cwd, "src/profile.json"));
  const declaration = {
    schemaVersion: 1,
    contract: KFD7_RELEASE_GATE_INPUT_CONTRACT,
    standard: "kfd-7",
    profile: {
      id: "example-action-profile",
      version: "0.1.0",
      stateMachineVersion: "0.1.0",
      actionContract,
      verifierReport,
    },
    source: { sha: sourceSha },
    surfaces: [{ id: "profile-contract", sourcePath: "src/profile.json", artifactPath: "dist/profile.json", sha256: surfaceSha }],
    testEvidence: [
      { id: "positive-transition", kind: "positive", expectedOutcome: "pass", ...positive },
      { id: "invalid-transition", kind: "negative", expectedOutcome: "fail", ...negative },
    ],
    experiments,
    residualRisk: [{
      id: "semantic-review-required",
      definedBy: "https://kfd.libkungfu.dev/schemas/kfd-2/trust-taxonomy.schema.json#/$defs/residualRisk",
      riskType: "natural-language-semantic-risk",
      trustImpact: "downgrade-warning",
      machineProvability: "not-machine-verifiable",
      agentAction: "semantic-review-required",
      reason: "The release gate does not judge real-world work quality.",
      owner: "example-product",
    }],
    responsibility: {
      profileOwner: "example-product",
      evidenceOwner: "example-product-tests",
      proofOwner: "buildchain-release-passport",
    },
    nonClaims: ["A passing release gate does not prove real-world work quality."],
  };
  return { cwd, declaration };
}

test("KFD-7 release gate records a schema-valid provisional Profile as a downgraded warning", () => {
  const { cwd, declaration } = createFixture("warning");
  const gate = createKfd7ReleaseGateEvidence({ cwd, artifactRoot: cwd, declarations: [declaration] });
  assert.equal(gate.passportSection.status, "downgraded", JSON.stringify(gate.passportSection.profiles[0].issues));
  assert.equal(gate.passportSection.gateResult, "warning");
  assert.deepEqual(validateKfd7ReleaseGateEvidence(gate.passportSection), []);

  const passport = createReleasePassport({ tag: "v2.12.2-alpha.0", kfd7: gate });
  assert.equal(passport["kfd-7"].profiles[0].verifierReport.value.valid, true);
  assert.equal(passport.evidence.kfd7, "kfd-7");
  assert.deepEqual(validateKfd7ReleaseGateEvidence(passport["kfd-7"]), []);
});

test("collect github-release accepts repeated KFD-7 declaration inputs", () => {
  const { cwd, declaration } = createFixture("cli-collect");
  writeJson(cwd, "declarations/profile.json", declaration);
  const cliPath = path.resolve("bin/buildchain.mjs");
  const output = execFileSync(process.execPath, [
    cliPath,
    "collect",
    "github-release",
    "--cwd",
    cwd,
    "--tag",
    "v0.1.0-alpha.0",
    "--source-sha",
    declaration.source.sha,
    "--assets-dir",
    ".",
    "--output-dir",
    ".buildchain/release-passport",
    "--kfd-7-declaration-json",
    "declarations/profile.json",
    "--json",
  ], { cwd, encoding: "utf8" });
  const result = JSON.parse(output);
  assert.equal(result.passport["kfd-7"].status, "downgraded");
  assert.equal(result.passport["kfd-7"].profiles[0].id, declaration.profile.id);
  assert.deepEqual(validateKfd7ReleaseGateEvidence(result.passport["kfd-7"]), []);
});

test("KFD-7 release gate fails closed on unknown state-machine version", () => {
  const { cwd, declaration } = createFixture("unknown-version");
  declaration.profile.stateMachineVersion = "99";
  const gate = createKfd7ReleaseGateEvidence({ cwd, declarations: [declaration] });
  assert.equal(gate.passportSection.status, "failed");
  assert.ok(gate.passportSection.profiles[0].issues.some((entry) => entry.code === "kfd-7.profile.version"));
});

test("KFD-7 release gate fails closed when negative transition evidence is absent", () => {
  const { cwd, declaration } = createFixture("negative-missing");
  declaration.testEvidence = declaration.testEvidence.filter((entry) => entry.kind !== "negative");
  const gate = createKfd7ReleaseGateEvidence({ cwd, declarations: [declaration] });
  assert.equal(gate.passportSection.status, "failed");
  assert.ok(gate.passportSection.profiles[0].issues.some((entry) => entry.code === "kfd-7.test-evidence.negative.missing"));
});

test("KFD-7 release gate fails closed on missing artifact surface", () => {
  const { cwd, declaration } = createFixture("artifact-missing");
  fs.unlinkSync(path.join(cwd, "dist/profile.json"));
  const gate = createKfd7ReleaseGateEvidence({ cwd, declarations: [declaration] });
  assert.equal(gate.passportSection.status, "failed");
  assert.ok(gate.passportSection.profiles[0].issues.some((entry) => entry.code === "kfd-7.surface.profile-contract"));
});

test("KFD-7 release gate fails closed on stale migration evidence", () => {
  const { cwd, declaration } = createFixture("migration-stale");
  const migration = declaration.experiments.find((entry) => entry.category === "backend-migration");
  const reportPath = path.join(cwd, migration.path);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.sourceSha = "b".repeat(40);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  migration.sha256 = sha256File(reportPath);
  const gate = createKfd7ReleaseGateEvidence({ cwd, declarations: [declaration] });
  assert.equal(gate.passportSection.status, "failed");
  assert.ok(gate.passportSection.profiles[0].issues.some((entry) => entry.code === "experiment[2].sourceSha"));
});

test("KFD-7 release gate fails closed when role counterfactual evidence is absent", () => {
  const { cwd, declaration } = createFixture("role-counterfactual-missing");
  declaration.experiments = declaration.experiments.filter((entry) => entry.category !== "role-deletion-or-fusion");
  const gate = createKfd7ReleaseGateEvidence({ cwd, declarations: [declaration] });
  assert.equal(gate.passportSection.status, "failed");
  assert.ok(gate.passportSection.profiles[0].issues.some((entry) => entry.code === "kfd-7.experiment.role-deletion-or-fusion.missing"));
});

test("KFD-7 release gate fails closed on KFD verifier mismatch", () => {
  const { cwd, declaration } = createFixture("verifier-mismatch");
  const reportPath = path.join(cwd, declaration.profile.verifierReport.path);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.valid = false;
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  declaration.profile.verifierReport.sha256 = sha256File(reportPath);
  const gate = createKfd7ReleaseGateEvidence({ cwd, declarations: [declaration] });
  assert.equal(gate.passportSection.status, "failed");
  assert.ok(gate.passportSection.profiles[0].issues.some((entry) => entry.code === "kfd-7.verifier.mismatch"));
});

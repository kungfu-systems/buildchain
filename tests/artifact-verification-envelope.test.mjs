import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_VERIFICATION_ENVELOPE_CONTRACT,
  artifactVerificationEnvelopeDigest,
  projectArtifactVerificationEnvelopeToKfx,
  sealArtifactVerificationReport,
  verifyArtifactVerificationEnvelope,
} from "../packages/core/artifact-verification-envelope.js";

const root = (value) => `sha256:${value.repeat(64)}`;

function kfdAssessment({ state = "fresh" } = {}) {
  const assessmentKey = artifactVerificationEnvelopeDigest({
    claim: "kfx-package-admission",
    purpose: "workspace-install",
    cut: "cut:fixture",
  });
  const report = {
    assessment_key: assessmentKey,
    claim_id: "kfx-package-admission",
    claim_type: "artifact-fitness",
    purpose: "workspace-install",
    state,
    work_episode_id: 42,
    work_episode_root: root("8"),
    query_definition_root: root("9"),
    query_proof_root: root("b"),
    contract_world: { id: "kungfu.kfx", version: "1", root: root("c") },
    fact_surfaces: [{ id: "kungfu.kfx.package", version: "1", root: root("e") }],
    policy: { id: "kungfu.kfx.install", version: "1", root: root("d") },
    evidence: { canonical_fact_count: 1 },
    responsibility: "kungfu-kfx-runtime",
    residual_risks: ["provenance does not prove universal safety"],
    deterministic: true,
  };
  report.report_hash = artifactVerificationEnvelopeDigest(report);
  return {
    schema: "kungfu.trust.assessment/v1",
    state,
    assessment_key: assessmentKey,
    report,
  };
}

function fixture({ assessmentState = "fresh", revoked = false } = {}) {
  const assessment = kfdAssessment({ state: assessmentState });
  const artifactRoot = root("5");
  const report = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-verification",
    outcome: "pass",
    ok: true,
    trust: "pass",
    subject: { kind: "kfx-package", digest: artifactRoot },
    discovery: { status: "found", method: "explicit-passport" },
    passport: {
      location: "fixture/buildchain.release.json",
      product: { name: "Kungfu", repository: "kungfu-systems/kungfu" },
      release: { tag: "v4.0.0-alpha.1", sourceSha: "a".repeat(40) },
      verification: { ok: true, trust: "pass", completeness: {}, issues: [] },
    },
    match: {
      source: "passport.artifacts",
      reason: "digest",
      artifact: { kind: "kfx-package", name: "optional-view.kfx", digest: artifactRoot },
    },
    issues: [],
  };
  const bindings = {
    schema: "kungfu.kfx-trust-inputs/v1",
    packageRoot: root("0"),
    sourceRoot: root("1"),
    dependencyRoot: root("2"),
    buildPlanRoot: root("3"),
    toolchainRoot: root("4"),
    artifactRoot,
    qualificationRoot: assessment.report.report_hash,
    verifierRoot: root("7"),
    issuer: "buildchain.libkungfu.dev",
    publisher: "kungfu-systems",
    contractVersion: "buildchain.release/v1",
  };
  const revocation = {
    status: revoked ? "revoked" : "active",
    revoked,
    checkedAt: 150,
    source: "buildchain.release/revocations/v1",
    root: artifactVerificationEnvelopeDigest({
      artifactRoot,
      status: revoked ? "revoked" : "active",
      checkedAt: 150,
    }),
  };
  return { report, bindings, assessment, revocation };
}

function sealFixture(options = {}) {
  const input = fixture(options);
  return sealArtifactVerificationReport({
    report: input.report,
    bindings: input.bindings,
    kfdAssessment: input.assessment,
    issuedAt: 100,
    expiresAt: 200,
    revocation: input.revocation,
  });
}

function resealTampered(envelope) {
  envelope.envelope.root = "";
  const basis = structuredClone(envelope);
  delete basis.envelope.root;
  envelope.envelope.root = artifactVerificationEnvelopeDigest(basis);
  return envelope;
}

test("seals exact artifact and KFD lifecycle roots into KFX admission inputs", () => {
  const envelope = sealFixture();
  const check = verifyArtifactVerificationEnvelope({
    envelope,
    assessmentTime: 150,
    expectedEnvelopeRoot: envelope.envelope.root,
    expectedIssuer: "buildchain.libkungfu.dev",
    expectedPublisher: "kungfu-systems",
    expectedContractVersion: "buildchain.release/v1",
  });
  const projection = projectArtifactVerificationEnvelopeToKfx({
    envelope,
    assessmentTime: 150,
  });

  assert.equal(envelope.envelope.contract, ARTIFACT_VERIFICATION_ENVELOPE_CONTRACT);
  assert.equal(check.ok, true);
  assert.equal(check.envelopeRoot, envelope.envelope.root);
  assert.deepEqual(projection.attestation, envelope);
  assert.deepEqual(projection.trustInputs, envelope.bindings);
  assert.deepEqual(projection.kfdAssessment, envelope.kfdAssessment);
  assert.equal(projection.trustInputs.qualificationRoot, projection.kfdAssessment.report.report_hash);
});

test("CLI verifies and projects the exact envelope root produced by the Node API", () => {
  const envelope = sealFixture();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-kfx-envelope-"));
  const envelopePath = path.join(cwd, "envelope.json");
  const bin = path.resolve(import.meta.dirname, "../bin/buildchain.mjs");
  fs.writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`);
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
  }));

  const check = run(
    "verify",
    "artifact-envelope",
    envelopePath,
    "--assessment-time",
    "150",
    "--expected-root",
    envelope.envelope.root,
    "--json",
  );
  const projection = run(
    "project",
    "kfx-admission",
    envelopePath,
    "--assessment-time",
    "150",
    "--json",
  );

  assert.equal(check.ok, true);
  assert.equal(check.envelopeRoot, envelope.envelope.root);
  assert.equal(projection.envelopeRoot, envelope.envelope.root);
  assert.deepEqual(projection.attestation, envelope);
});

test("fails closed for a sibling artifact even when the tampered envelope is re-rooted", () => {
  const envelope = sealFixture();
  envelope.match.artifact.digest = root("f");
  resealTampered(envelope);
  const check = verifyArtifactVerificationEnvelope({ envelope, assessmentTime: 150 });
  assert.equal(check.ok, false);
  assert.match(JSON.stringify(check.issues), /bindings\.artifactRoot/);
});

test("fails closed when any sealed root is tampered", () => {
  const envelope = sealFixture();
  envelope.bindings.sourceRoot = root("f");
  const check = verifyArtifactVerificationEnvelope({ envelope, assessmentTime: 150 });
  assert.equal(check.ok, false);
  assert.match(JSON.stringify(check.issues), /envelope\.root/);
});

test("fails closed for issuer or publisher drift", () => {
  const envelope = sealFixture();
  const check = verifyArtifactVerificationEnvelope({
    envelope,
    assessmentTime: 150,
    expectedIssuer: "other.example",
    expectedPublisher: "other-publisher",
  });
  assert.equal(check.ok, false);
  assert.match(JSON.stringify(check.issues), /bindings\.issuer/);
  assert.match(JSON.stringify(check.issues), /bindings\.publisher/);
});

test("fails closed for expired and revoked envelopes", () => {
  const expired = verifyArtifactVerificationEnvelope({
    envelope: sealFixture(),
    assessmentTime: 200,
  });
  assert.equal(expired.ok, false);
  assert.match(JSON.stringify(expired.issues), /lifecycle\.invalid/);

  const revokedInput = fixture({ revoked: true });
  const revokedEnvelope = {
    ...revokedInput.report,
    issuedAt: 100,
    expiresAt: 200,
    revoked: true,
    revocation: revokedInput.revocation,
    bindings: revokedInput.bindings,
    kfdAssessment: revokedInput.assessment,
    envelope: {
      schemaVersion: 1,
      contract: ARTIFACT_VERIFICATION_ENVELOPE_CONTRACT,
      canonicalization: "buildchain-stable-json/v1",
      root: "",
    },
  };
  resealTampered(revokedEnvelope);
  const revoked = verifyArtifactVerificationEnvelope({
    envelope: revokedEnvelope,
    assessmentTime: 150,
  });
  assert.equal(revoked.ok, false);
  assert.match(JSON.stringify(revoked.issues), /lifecycle\.revoked/);
});

test("fails closed for stale assessments and altered KFD report roots", () => {
  const staleInput = fixture({ assessmentState: "stale" });
  const staleEnvelope = {
    ...staleInput.report,
    issuedAt: 100,
    expiresAt: 200,
    revoked: false,
    revocation: staleInput.revocation,
    bindings: staleInput.bindings,
    kfdAssessment: staleInput.assessment,
    envelope: {
      schemaVersion: 1,
      contract: ARTIFACT_VERIFICATION_ENVELOPE_CONTRACT,
      canonicalization: "buildchain-stable-json/v1",
      root: "",
    },
  };
  resealTampered(staleEnvelope);
  const stale = verifyArtifactVerificationEnvelope({
    envelope: staleEnvelope,
    assessmentTime: 150,
  });
  assert.equal(stale.ok, false);
  assert.match(JSON.stringify(stale.issues), /kfd\.assessment\.state/);

  const altered = sealFixture();
  altered.kfdAssessment.report.purpose = "workspace-activate";
  resealTampered(altered);
  const alteredCheck = verifyArtifactVerificationEnvelope({
    envelope: altered,
    assessmentTime: 150,
  });
  assert.equal(alteredCheck.ok, false);
  assert.match(JSON.stringify(alteredCheck.issues), /kfd\.report\.root/);
});

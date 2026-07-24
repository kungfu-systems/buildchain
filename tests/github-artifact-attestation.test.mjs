import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GITHUB_ARTIFACT_ATTESTATION_EVIDENCE_CONTRACT,
  GITHUB_ARTIFACT_ATTESTATION_PREDICATE_TYPE,
  createGitHubArtifactAttestationEvidence,
  createGitHubArtifactAttestationPolicy,
  createGitHubArtifactAttestationVerificationPlan,
  githubArtifactAttestationSha256File,
  prepareGitHubArtifactAttestation,
  verifyGitHubArtifactAttestationEvidence,
} from "../packages/core/github-artifact-attestation.js";
import { createReleasePassport } from "../packages/core/release-passport.js";

const SOURCE_SHA = "1".repeat(40);
const SOURCE_TREE_SHA = "2".repeat(40);
const BUILDCHAIN_SHA = "3".repeat(40);
const SIGNER_SHA = "4".repeat(40);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-attestation-"));
  const subjectPath = path.join(root, "subject", "dist", "kungfu-linux-x64.tar.gz");
  fs.mkdirSync(path.dirname(subjectPath), { recursive: true });
  fs.writeFileSync(subjectPath, "qualified kungfu linux cli\n");
  const subjectDigest = githubArtifactAttestationSha256File(subjectPath);
  const subjectSize = fs.statSync(subjectPath).size;
  const manifestPath = path.join(root, "manifest", "manifest.json");
  writeJson(manifestPath, {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact",
    artifactName: "kungfu-cli",
    platform: { id: "linux-x64", name: "Linux x64" },
    git: {
      repository: "kungfu-systems/kungfu",
      sha: SOURCE_SHA,
      ref: "refs/tags/v4.0.0-alpha.1",
      runId: "42",
      runAttempt: "1",
    },
    files: [{
      path: "dist/kungfu-linux-x64.tar.gz",
      size: subjectSize,
      sha256: subjectDigest.replace(/^sha256:/, ""),
    }],
  });
  const manifestDigest = githubArtifactAttestationSha256File(manifestPath);
  const policy = createGitHubArtifactAttestationPolicy({
    subject: {
      name: "kungfu-linux-x64.tar.gz",
      path: "dist/kungfu-linux-x64.tar.gz",
      size: subjectSize,
      digest: subjectDigest,
    },
    caller: {
      repository: "kungfu-systems/kungfu",
      sourceSha: SOURCE_SHA,
      sourceTreeSha: SOURCE_TREE_SHA,
    },
    signer: {
      repository: "kungfu-systems/buildchain",
      workflowPath: ".github/workflows/github-artifact-attestation.yml",
      workflowDigest: SIGNER_SHA,
    },
    build: {
      platform: "linux-x64",
      platformManifestDigest: manifestDigest,
      runnerReceiptRoot: manifestDigest,
      buildchainRuntimeSha: BUILDCHAIN_SHA,
    },
  });
  const passportPath = path.join(root, "passport", "buildchain.release.json");
  writeJson(passportPath, createReleasePassport({
    repository: "kungfu-systems/kungfu",
    tag: "v4.0.0-alpha.1",
    sourceSha: SOURCE_SHA,
    assets: [{
      name: policy.subject.name,
      size: subjectSize,
      sha256: subjectDigest.replace(/^sha256:/, ""),
    }],
    release: { builtSourceTreeSha: SOURCE_TREE_SHA },
    githubArtifactAttestations: [policy],
  }));
  const preparation = prepareGitHubArtifactAttestation({
    subjectPath,
    platformManifestPath: manifestPath,
    releasePassportPath: passportPath,
    policy,
    expectedBuildchainRef: SIGNER_SHA,
    expectedCallerRepository: "kungfu-systems/kungfu",
    expectedSourceSha: SOURCE_SHA,
  });
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{
      name: policy.subject.name,
      digest: { sha256: subjectDigest.replace(/^sha256:/, "") },
    }],
    predicateType: GITHUB_ARTIFACT_ATTESTATION_PREDICATE_TYPE,
    predicate: preparation.predicate,
  };
  const bundlePath = path.join(root, "bundle", "attestation.json");
  writeJson(bundlePath, {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {},
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ sig: "fixture" }],
    },
  });
  const evidence = createGitHubArtifactAttestationEvidence({
    preparation,
    attestationId: "12345",
    attestationUrl: "https://github.com/kungfu-systems/kungfu/attestations/12345",
    bundlePath,
    workflow: {
      repository: "kungfu-systems/kungfu",
      runId: "42",
      runAttempt: "1",
      job: "attest",
      url: "https://github.com/kungfu-systems/kungfu/actions/runs/42",
    },
  });
  return {
    root,
    subjectPath,
    manifestPath,
    passportPath,
    bundlePath,
    policy,
    preparation,
    statement,
    evidence,
  };
}

test("policy fixes keyless permissions, Linux builder evidence, and immutable signer identity", () => {
  const { policy } = fixture();
  assert.deepEqual(policy.permissions, [
    "actions:read",
    "artifact-metadata:write",
    "attestations:write",
    "contents:read",
    "id-token:write",
  ]);
  assert.equal(policy.signer.workflowDigest, SIGNER_SHA);
  assert.equal(policy.build.buildchainRuntimeSha, BUILDCHAIN_SHA);
  assert.notEqual(policy.signer.workflowDigest, policy.build.buildchainRuntimeSha);
  assert.equal(policy.claims.kind, "artifact-attestation-and-provenance");
  assert.ok(policy.claims.excludes.includes("embedded-elf-signing"));
});

test("reusable signer verifies the actual certificate identity before retaining evidence", () => {
  const workflow = fs.readFileSync(
    path.resolve(".github/workflows/github-artifact-attestation.yml"),
    "utf8",
  );
  const verifyIndex = workflow.indexOf("gh attestation verify");
  const finalizeIndex = workflow.indexOf("name: Seal retained attestation evidence");
  assert.ok(verifyIndex > 0 && verifyIndex < finalizeIndex);
  for (const flag of [
    "--repo",
    "--signer-workflow",
    "--signer-digest",
    "--source-digest",
    "--predicate-type",
    "--bundle",
    "--deny-self-hosted-runners",
  ]) {
    assert.ok(workflow.includes(flag), `missing exact provider verification flag ${flag}`);
  }
});

test("preparation binds exact subject, original runner manifest, source tree, Buildchain SHA, and Release Passport", () => {
  const { preparation, passportPath } = fixture();
  assert.equal(preparation.predicate.subject.name, "kungfu-linux-x64.tar.gz");
  assert.equal(preparation.predicate.caller.sourceTreeSha, SOURCE_TREE_SHA);
  assert.equal(preparation.predicate.signer.workflowDigest, SIGNER_SHA);
  assert.equal(preparation.predicate.build.buildchainRuntimeSha, BUILDCHAIN_SHA);
  assert.equal(
    preparation.predicate.releasePassport.digest,
    githubArtifactAttestationSha256File(passportPath),
  );
});

test("retained evidence and explicit gh policy verify the matching bundle", () => {
  const value = fixture();
  assert.equal(value.evidence.contract, GITHUB_ARTIFACT_ATTESTATION_EVIDENCE_CONTRACT);
  const plan = createGitHubArtifactAttestationVerificationPlan({
    artifactPath: value.subjectPath,
    bundlePath: value.bundlePath,
    evidence: value.evidence,
  });
  assert.deepEqual(plan.args.slice(0, 2), ["attestation", "verify"]);
  assert.ok(plan.args.includes("--deny-self-hosted-runners"));
  assert.equal(plan.args[plan.args.indexOf("--repo") + 1], "kungfu-systems/kungfu");
  assert.equal(plan.args[plan.args.indexOf("--signer-digest") + 1], SIGNER_SHA);
  assert.equal(plan.args[plan.args.indexOf("--source-digest") + 1], SOURCE_SHA);
  const report = verifyGitHubArtifactAttestationEvidence({
    artifactPath: value.subjectPath,
    platformManifestPath: value.manifestPath,
    releasePassportPath: value.passportPath,
    bundlePath: value.bundlePath,
    evidence: value.evidence,
    verificationResults: [{ verificationResult: { statement: value.statement } }],
  });
  assert.equal(report.ok, true);
});

test("one-byte subject tamper fails closed with a deterministic digest diagnostic", () => {
  const value = fixture();
  fs.appendFileSync(value.subjectPath, "x");
  const report = verifyGitHubArtifactAttestationEvidence({
    artifactPath: value.subjectPath,
    platformManifestPath: value.manifestPath,
    releasePassportPath: value.passportPath,
    bundlePath: value.bundlePath,
    evidence: value.evidence,
    verificationResults: [{ verificationResult: { statement: value.statement } }],
  });
  assert.equal(report.ok, false);
  assert.match(report.issues[0].message, /artifact digest mismatch/);
});

test("wrong source, signer digest, Passport root, or missing verified statement fails closed", () => {
  const value = fixture();
  assert.throws(
    () => prepareGitHubArtifactAttestation({
      subjectPath: value.subjectPath,
      platformManifestPath: value.manifestPath,
      releasePassportPath: value.passportPath,
      policy: value.policy,
      expectedSourceSha: "4".repeat(40),
    }),
    /policy caller source SHA mismatch/,
  );
  assert.throws(
    () => prepareGitHubArtifactAttestation({
      subjectPath: value.subjectPath,
      platformManifestPath: value.manifestPath,
      releasePassportPath: value.passportPath,
      policy: value.policy,
      expectedBuildchainRef: "5".repeat(40),
    }),
    /policy signer workflow digest mismatch/,
  );
  const substitutedPassport = path.join(value.root, "substituted-passport.json");
  fs.copyFileSync(value.passportPath, substitutedPassport);
  fs.appendFileSync(substitutedPassport, " ");
  const passportReport = verifyGitHubArtifactAttestationEvidence({
    artifactPath: value.subjectPath,
    platformManifestPath: value.manifestPath,
    releasePassportPath: substitutedPassport,
    bundlePath: value.bundlePath,
    evidence: value.evidence,
    verificationResults: [{ verificationResult: { statement: value.statement } }],
  });
  assert.equal(passportReport.ok, false);
  assert.match(passportReport.issues[0].message, /release passport digest mismatch/);
  const missingStatement = verifyGitHubArtifactAttestationEvidence({
    artifactPath: value.subjectPath,
    platformManifestPath: value.manifestPath,
    releasePassportPath: value.passportPath,
    bundlePath: value.bundlePath,
    evidence: value.evidence,
    verificationResults: [],
  });
  assert.equal(missingStatement.ok, false);
  assert.match(missingStatement.issues[0].message, /no matching verified statement/);
});

import assert from "node:assert/strict";
import childProcess from "node:child_process";
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
  stageGitHubArtifactAttestationInputs,
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

test("final Linux build manifest creates the exact v3 attestation policy", () => {
  const value = fixture();
  const output = path.join(value.root, "created", "github-artifact-attestation-policy.json");
  const result = childProcess.spawnSync(
    process.execPath,
    ["scripts/create-github-artifact-attestation-policy.mjs"],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        BUILDCHAIN_SOURCE_CWD: path.join(value.root, "subject"),
        BUILDCHAIN_GITHUB_ATTESTATION_SUBJECT_PATH: "dist/kungfu-linux-x64.tar.gz",
        BUILDCHAIN_GITHUB_ATTESTATION_PLATFORM_MANIFEST: value.manifestPath,
        BUILDCHAIN_GITHUB_ATTESTATION_POLICY_OUTPUT: output,
        BUILDCHAIN_SOURCE_REPOSITORY: "kungfu-systems/kungfu",
        BUILDCHAIN_SOURCE_SHA: SOURCE_SHA,
        BUILDCHAIN_SOURCE_TREE_SHA: SOURCE_TREE_SHA,
        BUILDCHAIN_RUNTIME_SHA: BUILDCHAIN_SHA,
        BUILDCHAIN_GITHUB_ATTESTATION_SIGNER_SHA: SIGNER_SHA,
        BUILDCHAIN_PLATFORM_ID: "linux-x64",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), value.policy);
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

test("promotion stages one digest-selected subject, manifest, policy, and Passport without consumer execution", () => {
  const value = fixture();
  const staged = stageGitHubArtifactAttestationInputs({
    policy: value.policy,
    subjectRoots: [path.dirname(path.dirname(value.subjectPath))],
    platformManifestPaths: [value.manifestPath],
    releasePassportPath: value.passportPath,
    outputDir: path.join(value.root, "staged"),
  });
  assert.equal(staged.relativePaths.subject, "subject/kungfu-linux-x64.tar.gz");
  assert.equal(
    githubArtifactAttestationSha256File(staged.paths.subject),
    value.policy.subject.digest,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(staged.paths.policy, "utf8")), value.policy);
});

test("promotion stages a policy bound to a tree-equivalent promotion source", () => {
  const value = fixture();
  const promotionSourceSha = "5".repeat(40);
  const policy = createGitHubArtifactAttestationPolicy({
    ...value.policy,
    caller: { ...value.policy.caller, sourceSha: promotionSourceSha },
  });
  const manifest = JSON.parse(fs.readFileSync(value.manifestPath, "utf8"));
  manifest.git.sha = promotionSourceSha;
  writeJson(value.manifestPath, manifest);
  const manifestDigest = githubArtifactAttestationSha256File(value.manifestPath);
  const treeEquivalentPolicy = createGitHubArtifactAttestationPolicy({
    ...policy,
    build: {
      ...policy.build,
      platformManifestDigest: manifestDigest,
      runnerReceiptRoot: manifestDigest,
    },
  });
  writeJson(value.passportPath, createReleasePassport({
    repository: "kungfu-systems/kungfu",
    tag: "v4.0.0-alpha.1",
    sourceSha: SOURCE_SHA,
    assets: [{
      name: treeEquivalentPolicy.subject.name,
      size: treeEquivalentPolicy.subject.size,
      sha256: treeEquivalentPolicy.subject.digest.replace(/^sha256:/, ""),
    }],
    release: {
      builtSourceSha: SOURCE_SHA,
      builtSourceTreeSha: SOURCE_TREE_SHA,
      promotionChannelSha: promotionSourceSha,
      promotionChannelTreeSha: SOURCE_TREE_SHA,
      treeEquivalent: true,
    },
    githubArtifactAttestations: [treeEquivalentPolicy],
  }));

  const staged = stageGitHubArtifactAttestationInputs({
    policy: treeEquivalentPolicy,
    subjectRoots: [path.dirname(path.dirname(value.subjectPath))],
    platformManifestPaths: [value.manifestPath],
    releasePassportPath: value.passportPath,
    outputDir: path.join(value.root, "tree-equivalent-staged"),
  });
  assert.equal(staged.policy.caller.sourceSha, promotionSourceSha);
});

test("promotion refuses a digest-identical subject at the wrong declared path", () => {
  const value = fixture();
  const wrongRoot = path.join(value.root, "wrong-subject-root");
  const wrongPath = path.join(wrongRoot, "different", value.policy.subject.name);
  fs.mkdirSync(path.dirname(wrongPath), { recursive: true });
  fs.copyFileSync(value.subjectPath, wrongPath);
  assert.throws(() => stageGitHubArtifactAttestationInputs({
    policy: value.policy,
    subjectRoots: [wrongRoot],
    platformManifestPaths: [value.manifestPath],
    releasePassportPath: value.passportPath,
    outputDir: path.join(value.root, "wrong-staged"),
  }), /attestation subject must resolve to exactly one digest-matching file, got 0/);
});

test("policy rejects path-like subject names before staging", () => {
  const value = fixture();
  assert.throws(() => createGitHubArtifactAttestationPolicy({
    ...value.policy,
    subject: { ...value.policy.subject, name: "../escaped.tar.gz" },
  }), /policy.subject.name must be a safe file name/);
});

test("policy rejects an ungrounded runner receipt root", () => {
  const value = fixture();
  assert.throws(() => createGitHubArtifactAttestationPolicy({
    ...value.policy,
    build: { ...value.policy.build, runnerReceiptRoot: `sha256:${"9".repeat(64)}` },
  }), /runner receipt root and platform manifest digest mismatch/);
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

test("wrong caller repository and missing bundle or evidence fail closed", () => {
  const value = fixture();
  assert.throws(
    () => prepareGitHubArtifactAttestation({
      subjectPath: value.subjectPath,
      platformManifestPath: value.manifestPath,
      releasePassportPath: value.passportPath,
      policy: value.policy,
      expectedCallerRepository: "kungfu-systems/substituted",
    }),
    /policy caller repository mismatch/,
  );
  const missingBundle = verifyGitHubArtifactAttestationEvidence({
    artifactPath: value.subjectPath,
    platformManifestPath: value.manifestPath,
    releasePassportPath: value.passportPath,
    bundlePath: path.join(value.root, "missing", "bundle.json"),
    evidence: value.evidence,
    verificationResults: [{ verificationResult: { statement: value.statement } }],
  });
  assert.equal(missingBundle.ok, false);
  assert.match(missingBundle.issues[0].message, /ENOENT/);
  const missingEvidence = verifyGitHubArtifactAttestationEvidence({
    artifactPath: value.subjectPath,
    platformManifestPath: value.manifestPath,
    releasePassportPath: value.passportPath,
    bundlePath: value.bundlePath,
    verificationResults: [{ verificationResult: { statement: value.statement } }],
  });
  assert.equal(missingEvidence.ok, false);
  assert.match(missingEvidence.issues[0].message, /evidence must be a JSON object/);
});

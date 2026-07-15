import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT,
  controllerEvidenceDigest,
} from "../packages/core/controller-evidence.js";
import {
  createPublicationArtifactCandidate,
  resolvePublicationCandidateFile,
} from "../packages/core/publication-artifact-candidate.js";
import {
  createPublicationAdmission,
  createPublicationAuthorityRegistry,
  createPublicationControlPlaneAudit,
  createPublicationGateDecision,
  createRunnerProvenance,
  verifyPublicationAdmission,
} from "../packages/core/publication-authority.js";

const sourceSha = "1".repeat(40);
const sourceTreeSha = "2".repeat(40);
const runtimeSha = "3".repeat(40);

function fixture() {
  const controllerPayload = {
    schemaVersion: 1,
    contract: BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT,
    kind: "receipt",
    controller: { id: "publication-artifact" },
    source: { repository: "kungfu-systems/paper-fixture", sha: sourceSha },
    runtime: { ref: "v2-alpha", sha: runtimeSha, contractDigest: `sha256:${"4".repeat(64)}` },
    planDigest: `sha256:${"5".repeat(64)}`,
    status: "passed",
    qualifying: true,
    stages: [],
    evidence: [
      { kind: "publication-manifest", digest: `sha256:${"6".repeat(64)}` },
      { kind: "publication-passport", digest: `sha256:${"7".repeat(64)}` },
    ],
    issues: [],
  };
  const controllerReceipt = { ...controllerPayload, digest: controllerEvidenceDigest(controllerPayload) };
  const manifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-publication-artifact-manifest",
    source: { sha: sourceSha, treeSha: sourceTreeSha },
    artifacts: [{ path: "_build/paper.pdf", bytes: 3, sha256: "a".repeat(64) }],
  };
  const manifestDigest = crypto.createHash("sha256").update(JSON.stringify(manifest, null, 2)).digest("hex");
  const passport = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-publication-artifact-passport",
    status: "passed",
    manifestDigest: `sha256:${manifestDigest}`,
    source: { sha: sourceSha, treeSha: sourceTreeSha },
  };
  const evidence = {
    repository: "kungfu-systems/paper-fixture",
    sourceSha,
    sourceTreeSha,
    runtimeSha,
    manifest,
    passport,
    controllerReceipt,
    files: [
      { path: ".buildchain/publication/npm-package/package.json", size: 7, sha256: "b".repeat(64) },
      { path: "_build/paper.pdf", size: 3, sha256: "a".repeat(64) },
    ],
  };
  return { evidence, candidate: createPublicationArtifactCandidate(evidence) };
}

test("publication candidate binds declared PDFs and prepared npm package bytes", () => {
  const { evidence, candidate } = fixture();
  assert.equal(candidate.files.length, 2);
  assert.match(candidate.candidateDigest, /^[0-9a-f]{64}$/);
  const substituted = structuredClone(evidence);
  substituted.files[1].sha256 = "e".repeat(64);
  assert.throws(() => createPublicationArtifactCandidate(substituted), /bytes do not match manifest/);
});

test("publisher resolves manifest paths exactly when the npm package repeats an artifact suffix", () => {
  const files = [
    { path: "_build/paper.pdf" },
    { path: ".buildchain/publication/npm-package/_build/paper.pdf" },
  ];
  assert.equal(resolvePublicationCandidateFile(files, "_build/paper.pdf"), "_build/paper.pdf");
  assert.throws(
    () => resolvePublicationCandidateFile(files, "paper.pdf"),
    /expected exactly one publication candidate file at paper\.pdf, found 0/,
  );
});

test("sealed authority accepts exact publication-artifact evidence and rejects byte drift", () => {
  const { evidence, candidate } = fixture();
  const registry = createPublicationAuthorityRegistry({
    descriptors: [{
      workflowPath: ".github/workflows/paper-release-sealed.yml",
      authorityClass: "product-publication",
      publicationCapable: true,
      capabilityIds: ["npm-publish", "github-release"],
      credentialMode: "trusted-publishing",
      publisherWorkflowMode: "caller-bound",
      environment: "none",
      runnerPolicy: "ephemeral",
    }],
    workflows: [{
      path: ".github/workflows/paper-release-sealed.yml",
      text: "permissions:\n  contents: write\n  id-token: write\n",
    }],
  });
  const gateAggregate = createPublicationGateDecision({
    sourceSha,
    profile: "managed-paper-publication",
    rationale: "No project-specific Shifu Gate registry is declared.",
    policy: { scope: "managed-paper-publication" },
  });
  const runnerProvenance = createRunnerProvenance({
    runnerClass: "ephemeral",
    os: "linux",
    architecture: "x64",
    imageDigest: "8".repeat(64),
    measurementDigest: "9".repeat(64),
    isolation: "fresh-vm-per-job",
  });
  const controlPlaneAudit = createPublicationControlPlaneAudit({
    repository: evidence.repository,
    workflowPath: ".github/workflows/paper-release-sealed.yml",
    publisherWorkflowPath: ".github/workflows/paper-release.yml",
    environment: "none",
    facts: ["actions-policy", "branch-policy", "environment-policy", "oidc-policy", "publisher-policy", "runner-policy"]
      .map((id, index) => ({ id, status: "pass", digest: String(index + 1).repeat(64) })),
    observedAt: "2026-07-15T00:00:00.000Z",
    expiresAt: "2026-07-15T00:12:00.000Z",
  });
  const admission = createPublicationAdmission({
    registryDigest: registry.registryDigest,
    workflowPath: ".github/workflows/paper-release-sealed.yml",
    publisherWorkflowPath: ".github/workflows/paper-release.yml",
    repository: evidence.repository,
    sourceSha,
    runtimeSha,
    contractDigest: evidence.controllerReceipt.runtime.contractDigest,
    policyDigest: gateAggregate.policyDigest,
    controllerReceiptDigest: evidence.controllerReceipt.digest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: gateAggregate.digest,
    environment: "none",
    product: "Paper fixture",
    target: "npm:@kungfu-tech/paper-fixture",
    version: "0.1.0-alpha.1",
    channel: "alpha",
    artifactDigest: candidate.candidateDigest,
    nonce: "run:attempt:paper",
    issuedAt: "2026-07-15T00:01:00.000Z",
    expiresAt: "2026-07-15T00:10:00.000Z",
  });
  const expected = Object.fromEntries([
    "repository", "publisherWorkflowPath", "sourceSha", "runtimeSha", "contractDigest", "policyDigest",
    "controllerReceiptDigest", "gateAggregateDigest", "environment", "product", "target", "version", "channel",
    "artifactDigest",
  ].map((key) => [key, admission[key]]));
  const verify = (publicationArtifactCandidate) => verifyPublicationAdmission({
    admission,
    registry,
    runnerProvenance,
    controlPlaneAudit,
    publicationEvidence: { publicationArtifactCandidate, gateAggregate },
    expected,
    now: new Date("2026-07-15T00:05:00.000Z"),
  });
  assert.equal(verify(evidence).artifactDigest, candidate.candidateDigest);
  const drifted = structuredClone(evidence);
  drifted.files[0].sha256 = "f".repeat(64);
  assert.throws(() => verify(drifted), /candidate evidence binding mismatch/);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT,
  controllerEvidenceDigest,
} from "../packages/core/controller-evidence.js";
import {
  PUBLICATION_ADMISSION_CONTRACT,
  createPublicationArtifactManifestSet,
  createPublicationAuthorityRegistry,
  createPublicationAdmission,
  createPublicationControlPlaneAudit,
  createPublicationGateDecision,
  createRunnerProvenance,
  detectPublicationAuthoritySignals,
  publicationAuthorityDigest,
  verifyPublicationAdmission,
} from "../packages/core/publication-authority.js";
import { evaluatePublicationControlPlaneSnapshot } from "../packages/core/publication-control-plane-audit.js";
import { sha256Json } from "../packages/core/release-candidate.js";

const DIGESTS = Object.freeze({
  sourceSha: "1".repeat(40),
  runtimeSha: "2".repeat(40),
  contractDigest: "3".repeat(64),
  policyDigest: "4".repeat(64),
  controllerReceiptDigest: "5".repeat(64),
  gateAggregateDigest: "9".repeat(64),
  artifactDigest: "6".repeat(64),
  imageDigest: "7".repeat(64),
  measurementDigest: "8".repeat(64),
  sourceTreeSha: "a".repeat(40),
});

function fixture({ runnerClass = "ephemeral", factStatus = "pass" } = {}) {
  const registry = createPublicationAuthorityRegistry({
    descriptors: [
      {
        workflowPath: ".github/workflows/sealed-publish.yml",
        authorityClass: "product-publication",
        publicationCapable: true,
        capabilityIds: ["npm-publish"],
        credentialMode: "trusted-publishing",
        publisherWorkflowMode: "caller-bound",
        environment: "npm-production",
        runnerPolicy: "ephemeral",
      },
      {
        workflowPath: ".github/workflows/evidence.yml",
        authorityClass: "evidence-publication",
        publicationCapable: false,
      },
    ],
    workflows: [
      { path: ".github/workflows/sealed-publish.yml", text: "permissions:\n  id-token: write\n  contents: write\n" },
      { path: ".github/workflows/evidence.yml", text: "permissions:\n  contents: write\n" },
    ],
  });
  const runnerProvenance = createRunnerProvenance({
    runnerClass,
    os: "linux",
    architecture: "x64",
    imageDigest: DIGESTS.imageDigest,
    measurementDigest: DIGESTS.measurementDigest,
    isolation: "fresh-vm-per-job",
  });
  const facts = [
    "actions-policy",
    "branch-policy",
    "environment-policy",
    "oidc-policy",
    "publisher-policy",
    "runner-policy",
  ].map((id, index) => ({
    id,
    status: id === "oidc-policy" ? factStatus : "pass",
    digest: String(index + 1).repeat(64),
  }));
  const controlPlaneAudit = createPublicationControlPlaneAudit({
    repository: "kungfu-systems/buildchain",
    workflowPath: ".github/workflows/sealed-publish.yml",
    publisherWorkflowPath: ".github/workflows/release.yml",
    environment: "npm-production",
    facts,
    observedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:12:00.000Z",
  });
  const controllerPayload = {
    schemaVersion: 1,
    contract: BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT,
    kind: "receipt",
    controller: { id: "build-lifecycle" },
    source: { repository: "kungfu-systems/buildchain", sha: DIGESTS.sourceSha },
    runtime: {
      ref: DIGESTS.runtimeSha,
      sha: DIGESTS.runtimeSha,
      contractDigest: `sha256:${DIGESTS.contractDigest}`,
    },
    planDigest: `sha256:${"b".repeat(64)}`,
    status: "passed",
    qualifying: true,
    stages: [],
    evidence: [],
    issues: [],
  };
  const controllerReceipt = {
    ...controllerPayload,
    digest: controllerEvidenceDigest(controllerPayload),
  };
  const gateAggregate = createPublicationGateDecision({
    sourceSha: DIGESTS.sourceSha,
    profile: "publication-fixture",
    rationale: "This fixture declares no project-specific Shifu Gates.",
    policy: { requiredGateCount: 0 },
  });
  const buildSummary = {};
  const artifactManifests = [{
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact",
    artifactName: "fixture-linux-x64",
    platform: { id: "linux-x64" },
    git: { repository: "kungfu-systems/buildchain", sha: DIGESTS.sourceSha },
    summary: {
      contract: "kungfu-buildchain-artifact-summary",
      artifactName: "fixture-linux-x64",
      platform: { id: "linux-x64" },
      fileCount: 2,
      totalBytes: 7,
      digest: sha256Json("placeholder"),
    },
    expectedArtifacts: { ok: true },
    files: [
      { path: ".buildchain/artifacts/linux-x64/diagnostics.json", size: 4, sha256: "b".repeat(64) },
      { path: "dist/addon.node", size: 3, sha256: DIGESTS.artifactDigest },
    ],
  }];
  artifactManifests[0].summary.digest = (() => {
    const hash = crypto.createHash("sha256");
    for (const file of artifactManifests[0].files) {
      hash.update([file.path, String(file.size), file.sha256].join("\0") + "\n");
    }
    return hash.digest("hex");
  })();
  const artifactPayloads = [{
    artifactName: "fixture-linux-x64",
    files: [{ path: "dist/addon.node", size: 3, sha256: DIGESTS.artifactDigest }],
  }];
  const artifactManifestSet = createPublicationArtifactManifestSet({
    repository: "kungfu-systems/buildchain",
    sourceSha: DIGESTS.sourceSha,
    sourceTreeSha: DIGESTS.sourceTreeSha,
    manifests: artifactManifests,
    payloads: artifactPayloads,
  });
  const releaseCandidatePassport = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-candidate-passport",
    repository: "kungfu-systems/buildchain",
    target: { channel: "alpha" },
    source: {
      headSha: DIGESTS.sourceSha,
      mergeRefSha: DIGESTS.sourceSha,
      treeHash: DIGESTS.sourceTreeSha,
    },
    buildchain: { sha: DIGESTS.runtimeSha },
    platformMatrix: [{ platformId: "linux-x64", artifactName: "fixture-linux-x64" }],
    diagnostics: { buildSummaryHash: sha256Json(buildSummary) },
    controllerReceipts: [{
      controllerId: "build-lifecycle",
      planDigest: controllerReceipt.planDigest,
      receiptDigest: controllerReceipt.digest,
      sourceSha: DIGESTS.sourceSha,
      runtimeSha: DIGESTS.runtimeSha,
      status: "passed",
    }],
  };
  releaseCandidatePassport.candidateHash = sha256Json({
    repository: releaseCandidatePassport.repository,
    target: releaseCandidatePassport.target,
    source: releaseCandidatePassport.source,
    platformMatrix: releaseCandidatePassport.platformMatrix,
    buildchain: releaseCandidatePassport.buildchain,
    controllerReceipts: releaseCandidatePassport.controllerReceipts,
  });
  const publicationEvidence = {
    sourceTreeSha: DIGESTS.sourceTreeSha,
    releaseCandidatePassport,
    buildSummary,
    controllerReceipt,
    gateAggregate,
    artifactManifests,
    artifactPayloads,
  };
  const admissionPayload = {
    schemaVersion: 1,
    contract: PUBLICATION_ADMISSION_CONTRACT,
    registryDigest: registry.registryDigest,
    workflowPath: ".github/workflows/sealed-publish.yml",
    publisherWorkflowPath: ".github/workflows/release.yml",
    repository: "kungfu-systems/buildchain",
    sourceSha: DIGESTS.sourceSha,
    runtimeSha: DIGESTS.runtimeSha,
    contractDigest: DIGESTS.contractDigest,
    policyDigest: gateAggregate.policyDigest,
    controllerReceiptDigest: controllerReceipt.digest.replace(/^sha256:/, ""),
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: gateAggregate.digest,
    environment: "npm-production",
    product: "@kungfu-tech/buildchain",
    target: "registry.npmjs.org",
    version: "2.12.7-alpha.0",
    channel: "alpha",
    artifactDigest: artifactManifestSet.manifestSetDigest,
    nonce: "run-123:attempt-1:publish",
    issuedAt: "2026-07-14T00:01:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
  };
  const admission = {
    ...admissionPayload,
    admissionDigest: publicationAuthorityDigest(admissionPayload),
  };
  const expectedBindings = Object.fromEntries([
    "repository",
    "publisherWorkflowPath",
    "sourceSha",
    "runtimeSha",
    "contractDigest",
    "policyDigest",
    "controllerReceiptDigest",
    "gateAggregateDigest",
    "environment",
    "product",
    "target",
    "version",
    "channel",
    "artifactDigest",
  ].map((key) => [key, admission[key]]));
  return { registry, runnerProvenance, controlPlaneAudit, publicationEvidence, admission, expectedBindings };
}

function verify(values, overrides = {}) {
  return verifyPublicationAdmission({
    ...values,
    expected: {
      ...values.expectedBindings,
      ...(overrides.expected || {}),
    },
    usedNonces: overrides.usedNonces || [],
    now: overrides.now || new Date("2026-07-14T00:05:00.000Z"),
  });
}

test("publication authority signal detection covers credentials and write surfaces", () => {
  assert.deepEqual(
    detectPublicationAuthoritySignals("permissions:\n  contents: write\n  id-token: write\nrun: npm publish"),
    ["write-permission", "oidc", "npm-publish"],
  );
});

test("publication authority registry denies unclassified authority-bearing workflows", () => {
  assert.throws(
    () => createPublicationAuthorityRegistry({ workflows: [{ path: ".github/workflows/new.yml", text: "permissions: write-all" }] }),
    /not classified/,
  );
});

test("independent verifier issues an exact short-lived publication capability", () => {
  const values = fixture();
  const capability = verify(values);
  assert.equal(capability.decision, "allow");
  assert.equal(capability.artifactDigest, values.admission.artifactDigest);
  assert.equal(capability.nonce, values.admission.nonce);
  assert.deepEqual(capability.capabilityIds, ["npm-publish"]);
});

test("publication admission constructor canonicalizes every sealed binding", () => {
  const values = fixture();
  const { admissionDigest: _digest, schemaVersion: _schemaVersion, contract: _contract, ...input } = values.admission;
  assert.deepEqual(createPublicationAdmission(input), values.admission);
});

test("unknown and evidence-only workflows cannot obtain product publication capability", () => {
  for (const workflowPath of [".github/workflows/unknown.yml", ".github/workflows/evidence.yml"]) {
    const values = fixture();
    values.admission.workflowPath = workflowPath;
    const { admissionDigest: _old, ...payload } = values.admission;
    values.admission.admissionDigest = publicationAuthorityDigest(payload);
    assert.throws(() => verify(values), /unknown publication workflow|not product-publication capable/);
  }
});

test("verifier rejects source, runtime, channel, and artifact substitution", () => {
  for (const key of ["sourceSha", "runtimeSha", "channel", "artifactDigest"]) {
    const values = fixture();
    values.admission[key] = key === "channel" ? "latest" : "a".repeat(64);
    const { admissionDigest: _old, ...payload } = values.admission;
    values.admission.admissionDigest = publicationAuthorityDigest(payload);
    assert.throws(() => verify(values), new RegExp(`${key} binding mismatch`));
  }
});

test("independent verifier rejects substituted controller, Gate, and artifact evidence", () => {
  const controller = fixture();
  controller.publicationEvidence.controllerReceipt.status = "failed";
  assert.throws(() => verify(controller), /controller receipt did not qualify|receipt digest mismatch/);

  const gate = fixture();
  gate.publicationEvidence.gateAggregate.qualifying = true;
  gate.publicationEvidence.gateAggregate.required = true;
  assert.throws(() => verify(gate), /Gate decision digest mismatch|required Gate policy must supply/);

  const artifact = fixture();
  artifact.publicationEvidence.artifactManifests[0].summary.digest = "f".repeat(64);
  assert.throws(() => verify(artifact), /summary digest mismatch|artifact manifest evidence binding mismatch/);

  const payload = fixture();
  payload.publicationEvidence.artifactPayloads[0].files[0].sha256 = "e".repeat(64);
  assert.throws(() => verify(payload), /payload bytes do not match/);
});

test("independent verifier rejects a producer-supplied source tree that is not the admitted commit tree", () => {
  const values = fixture();
  values.publicationEvidence.sourceTreeSha = "d".repeat(40);
  assert.throws(() => verify(values), /source tree does not match/);
});

test("independent verifier recomputes the candidate hash and preserves the platform set", () => {
  const candidate = fixture();
  candidate.publicationEvidence.releaseCandidatePassport.candidateHash = "d".repeat(64);
  assert.throws(() => verify(candidate), /candidate hash mismatch/);

  const platform = fixture();
  platform.publicationEvidence.releaseCandidatePassport.platformMatrix[0].platformId = "darwin-arm64";
  platform.publicationEvidence.releaseCandidatePassport.candidateHash = sha256Json({
    repository: platform.publicationEvidence.releaseCandidatePassport.repository,
    target: platform.publicationEvidence.releaseCandidatePassport.target,
    source: platform.publicationEvidence.releaseCandidatePassport.source,
    platformMatrix: platform.publicationEvidence.releaseCandidatePassport.platformMatrix,
    buildchain: platform.publicationEvidence.releaseCandidatePassport.buildchain,
    controllerReceipts: platform.publicationEvidence.releaseCandidatePassport.controllerReceipts,
  });
  assert.throws(() => verify(platform), /does not match the release-candidate platform matrix/);
});

test("verifier rejects stale, overlong, and replayed admission", () => {
  const stale = fixture();
  assert.throws(() => verify(stale, { now: new Date("2026-07-14T00:11:00.000Z") }), /stale/);

  const overlong = fixture();
  overlong.admission.expiresAt = "2026-07-14T00:30:00.000Z";
  const { admissionDigest: _old, ...payload } = overlong.admission;
  overlong.admission.admissionDigest = publicationAuthorityDigest(payload);
  assert.throws(() => verify(overlong), /lifetime exceeds/);

  const replayed = fixture();
  assert.throws(() => verify(replayed, { usedNonces: [replayed.admission.nonce] }), /replayed/);
});

test("runner downgrade and control-plane drift fail closed", () => {
  assert.throws(() => verify(fixture({ runnerClass: "unqualified" })), /runner provenance is not qualified/);
  const persistent = fixture({ runnerClass: "persistent-measured" });
  assert.equal(persistent.runnerProvenance.qualificationStatus, "unqualified");
  assert.throws(() => verify(persistent), /qualification floor was not met/);
  assert.throws(() => verify(fixture({ factStatus: "fail" })), /control-plane audit fact did not pass: oidc-policy/);
});

test("persistent runners qualify only with a measured clean baseline and isolation contract", () => {
  const receipt = createRunnerProvenance({
    runnerClass: "persistent-measured",
    os: "windows",
    architecture: "x64",
    imageDigest: DIGESTS.imageDigest,
    measurementDigest: DIGESTS.measurementDigest,
    baselineDigest: "a".repeat(64),
    toolchainDigest: "b".repeat(64),
    cacheContractDigest: "c".repeat(64),
    taskIsolationDigest: "d".repeat(64),
    cleanBaselineProven: true,
    isolation: "single-use-workspace-with-post-task-reimage-proof",
  });
  assert.equal(receipt.qualificationStatus, "qualifying");
  assert.equal(receipt.cleanBaselineProven, true);
});

test("producer decision is not trusted by the independent verifier", () => {
  const values = fixture();
  values.admission.producerDecision = "deny";
  const capability = verify(values);
  assert.equal(capability.decision, "allow");
});

test("control-plane snapshot audit covers all external publication authorities", () => {
  const receipt = evaluatePublicationControlPlaneSnapshot({
    repository: "kungfu-systems/buildchain",
    workflowPath: ".github/workflows/sealed-publish.yml",
    publisherWorkflowPath: ".github/workflows/release.yml",
    environment: "npm-production",
    branch: "release/v2/v2.12",
    packageName: "@kungfu-tech/buildchain",
    observedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
    snapshot: {
      actions: { defaultWorkflowPermissions: "read", canApprovePullRequestReviews: false },
      branch: { ref: "release/v2/v2.12", strict: true, requiredApprovals: 1, requireConversationResolution: true, enforceAdmins: true },
      environment: { name: "npm-production", declared: true, exists: true, protected: true, preventSelfReview: true },
      oidc: { workflowPath: ".github/workflows/release.yml", environment: "npm-production", idTokenJobScoped: true, longLivedCredentialPresent: false },
      publisher: { packageName: "@kungfu-tech/buildchain", provider: "github", repository: "kungfu-systems/buildchain", workflowFilename: "release.yml", environment: "npm-production", allowPublish: true, enforcement: "audited-control-plane", longLivedWorkflowCredentialPresent: false },
      runner: { class: "ephemeral", label: "ubuntu-24.04", githubHosted: true, selfHostedAuthorized: false },
    },
  });
  assert.equal(receipt.facts.length, 6);
  assert.equal(receipt.facts.every((entry) => entry.status === "pass"), true);

  const drifted = structuredClone(receipt);
  drifted.facts.find((entry) => entry.id === "publisher-policy").status = "fail";
  const values = fixture();
  values.controlPlaneAudit = drifted;
  values.admission.controlPlaneAuditDigest = receipt.receiptDigest;
  const { admissionDigest: _old, ...payload } = values.admission;
  values.admission.admissionDigest = publicationAuthorityDigest(payload);
  assert.throws(() => verify(values), /control-plane audit fact did not pass: publisher-policy/);
});

test("control-plane snapshot explicitly qualifies caller-bound npm publishing without an Environment", () => {
  const receipt = evaluatePublicationControlPlaneSnapshot({
    repository: "kungfu-systems/buildchain",
    workflowPath: ".github/workflows/release-candidate-promote.yml",
    publisherWorkflowPath: ".github/workflows/buildchain-ref-promotion.yml",
    environment: "none",
    branch: "dev/v2/v2.12",
    packageName: "@kungfu-tech/buildchain",
    observedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
    snapshot: {
      actions: { defaultWorkflowPermissions: "read", canApprovePullRequestReviews: false },
      branch: { ref: "dev/v2/v2.12", strict: true, requiredApprovals: 1, requireConversationResolution: true, enforceAdmins: true },
    environment: { name: "none", declared: false, exists: false, protected: false },
    oidc: { workflowPath: ".github/workflows/buildchain-ref-promotion.yml", environment: "", idTokenJobScoped: true, longLivedCredentialPresent: false },
    publisher: { packageName: "@kungfu-tech/buildchain", provider: "github", repository: "kungfu-systems/buildchain", workflowFilename: "buildchain-ref-promotion.yml", environment: "", allowPublish: false, enforcement: "provider-at-transaction", authorizationDeferred: true, configurationRead: false, longLivedWorkflowCredentialPresent: false },
    runner: { class: "ephemeral", label: "ubuntu-24.04", githubHosted: true, selfHostedAuthorized: false },
    },
  });
  assert.equal(receipt.facts.every((entry) => entry.status === "pass"), true);
});

test("control-plane snapshot qualifies an exact provider-enforced protected-branch transaction", () => {
  const sourceSha = "a".repeat(40);
  const common = {
    repository: "kungfu-systems/buildchain",
    workflowPath: ".github/workflows/release-candidate-promote.yml",
    publisherWorkflowPath: ".github/workflows/buildchain-ref-promotion.yml",
    environment: "none",
    branch: "alpha/v2/v2.12",
    packageName: "@kungfu-tech/buildchain",
    observedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
  };
  const snapshot = {
    actions: { defaultWorkflowPermissions: "read", canApprovePullRequestReviews: false },
    branch: {
      ref: "alpha/v2/v2.12",
      policyMode: "provider-enforced-transaction",
      protected: true,
      enforcementLevel: "everyone",
      requiredStatusChecks: ["check"],
      requiredCheckPassed: true,
      sourceSha,
      headSha: sourceSha,
      mergedPullRequest: true,
      baseRef: "alpha/v2/v2.12",
      headRepository: "kungfu-systems/buildchain",
      approvalCount: 1,
      independentApproval: true,
      configurationRead: false,
    },
      environment: { name: "none", declared: false, exists: false, protected: false },
      oidc: { workflowPath: ".github/workflows/buildchain-ref-promotion.yml", environment: "", idTokenJobScoped: true, longLivedCredentialPresent: false },
      publisher: { packageName: "@kungfu-tech/buildchain", provider: "github", repository: "kungfu-systems/buildchain", workflowFilename: "buildchain-ref-promotion.yml", environment: "", allowPublish: false, enforcement: "provider-at-transaction", authorizationDeferred: true, configurationRead: false, longLivedWorkflowCredentialPresent: false },
      runner: { class: "ephemeral", label: "ubuntu-24.04", githubHosted: true, selfHostedAuthorized: false },
  };
  const receipt = evaluatePublicationControlPlaneSnapshot({ ...common, snapshot });
  assert.equal(receipt.facts.every((entry) => entry.status === "pass"), true);

  const drifted = evaluatePublicationControlPlaneSnapshot({
    ...common,
    snapshot: {
      ...snapshot,
      branch: { ...snapshot.branch, approvalCount: 0, independentApproval: false },
    },
  });
  assert.equal(drifted.facts.find((entry) => entry.id === "branch-policy").status, "fail");
});

test("control-plane snapshot audit supports scoped GitHub tokens and sanitized OIDC roles", () => {
  const base = {
    actions: { defaultWorkflowPermissions: "read", canApprovePullRequestReviews: false },
    branch: { ref: "release/v2/v2.12", strict: true, requiredApprovals: 1, requireConversationResolution: true, enforceAdmins: true },
    environment: { name: "release-assets", declared: true, exists: true, protected: true, preventSelfReview: true },
    runner: { class: "ephemeral", label: "ubuntu-24.04", githubHosted: true, selfHostedAuthorized: false },
  };
  const common = {
    repository: "kungfu-systems/buildchain",
    workflowPath: ".github/workflows/.binary-release-assets.yml",
    environment: "release-assets",
    branch: "release/v2/v2.12",
    observedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
  };
  const githubToken = evaluatePublicationControlPlaneSnapshot({
    ...common,
    publisherMode: "github-token",
    snapshot: {
      ...base,
      oidc: { githubTokenJobScoped: true, longLivedCredentialPresent: false },
      publisher: {
        provider: "github-token",
        repository: common.repository,
        workflowPath: common.workflowPath,
        permissionScoped: true,
        longLivedWorkflowCredentialPresent: false,
      },
    },
  });
  assert.equal(githubToken.facts.every((entry) => entry.status === "pass"), true);

  const oidcRole = evaluatePublicationControlPlaneSnapshot({
    ...common,
    publisherWorkflowPath: ".github/workflows/deploy.yml",
    publisherMode: "oidc-role",
    snapshot: {
      ...base,
      oidc: {
        workflowPath: ".github/workflows/deploy.yml",
        environment: common.environment,
        idTokenJobScoped: true,
        longLivedCredentialPresent: false,
      },
      publisher: {
        provider: "aws",
        repository: common.repository,
        workflowPath: ".github/workflows/deploy.yml",
        environment: common.environment,
        trustQualifying: true,
        roleDigest: "a".repeat(64),
        longLivedWorkflowCredentialPresent: false,
      },
    },
  });
  assert.equal(oidcRole.facts.every((entry) => entry.status === "pass"), true);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLICATION_ADMISSION_CONTRACT,
  createPublicationAuthorityRegistry,
  createPublicationControlPlaneAudit,
  createRunnerProvenance,
  detectPublicationAuthoritySignals,
  publicationAuthorityDigest,
  verifyPublicationAdmission,
} from "../packages/core/publication-authority.js";
import { evaluatePublicationControlPlaneSnapshot } from "../packages/core/publication-control-plane-audit.js";

const DIGESTS = Object.freeze({
  sourceSha: "1".repeat(64),
  runtimeSha: "2".repeat(64),
  contractDigest: "3".repeat(64),
  policyDigest: "4".repeat(64),
  controllerReceiptDigest: "5".repeat(64),
  artifactDigest: "6".repeat(64),
  imageDigest: "7".repeat(64),
  measurementDigest: "8".repeat(64),
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
    environment: "npm-production",
    facts,
    observedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:12:00.000Z",
  });
  const admissionPayload = {
    schemaVersion: 1,
    contract: PUBLICATION_ADMISSION_CONTRACT,
    registryDigest: registry.registryDigest,
    workflowPath: ".github/workflows/sealed-publish.yml",
    repository: "kungfu-systems/buildchain",
    sourceSha: DIGESTS.sourceSha,
    runtimeSha: DIGESTS.runtimeSha,
    contractDigest: DIGESTS.contractDigest,
    policyDigest: DIGESTS.policyDigest,
    controllerReceiptDigest: DIGESTS.controllerReceiptDigest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    product: "@kungfu-tech/buildchain",
    target: "registry.npmjs.org",
    version: "2.12.7-alpha.0",
    channel: "alpha",
    artifactDigest: DIGESTS.artifactDigest,
    nonce: "run-123:attempt-1:publish",
    issuedAt: "2026-07-14T00:01:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
  };
  const admission = {
    ...admissionPayload,
    admissionDigest: publicationAuthorityDigest(admissionPayload),
  };
  return { registry, runnerProvenance, controlPlaneAudit, admission };
}

function verify(values, overrides = {}) {
  return verifyPublicationAdmission({
    ...values,
    expected: {
      repository: "kungfu-systems/buildchain",
      sourceSha: DIGESTS.sourceSha,
      runtimeSha: DIGESTS.runtimeSha,
      contractDigest: DIGESTS.contractDigest,
      policyDigest: DIGESTS.policyDigest,
      controllerReceiptDigest: DIGESTS.controllerReceiptDigest,
      product: "@kungfu-tech/buildchain",
      target: "registry.npmjs.org",
      version: "2.12.7-alpha.0",
      channel: "alpha",
      artifactDigest: DIGESTS.artifactDigest,
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
  assert.equal(capability.artifactDigest, DIGESTS.artifactDigest);
  assert.equal(capability.nonce, values.admission.nonce);
  assert.deepEqual(capability.capabilityIds, ["npm-publish"]);
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
  assert.throws(() => verify(fixture({ factStatus: "fail" })), /control-plane audit fact did not pass: oidc-policy/);
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
    environment: "npm-production",
    branch: "release/v2/v2.12",
    packageName: "@kungfu-tech/buildchain",
    observedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-14T00:10:00.000Z",
    snapshot: {
      actions: { defaultWorkflowPermissions: "read", canApprovePullRequestReviews: false },
      branch: { ref: "release/v2/v2.12", strict: true, requiredApprovals: 1, requireConversationResolution: true, enforceAdmins: true },
      environment: { name: "npm-production", exists: true, protected: true, preventSelfReview: true },
      oidc: { workflowPath: ".github/workflows/sealed-publish.yml", environment: "npm-production", idTokenJobScoped: true, longLivedCredentialPresent: false },
      publisher: { packageName: "@kungfu-tech/buildchain", provider: "github", repository: "kungfu-systems/buildchain", workflowFilename: "sealed-publish.yml", environment: "npm-production", allowPublish: true, tokensDisallowed: true },
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

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  createControllerPlan,
  createControllerReceipt,
} from "../packages/core/controller-evidence.js";
import {
  createWebSurfaceProductionDecision,
  createWebSurfacePublicationCandidate,
} from "../packages/core/web-surface-publication-candidate.js";
import {
  createPublicationAdmission,
  createPublicationAuthorityRegistry,
  createPublicationControlPlaneAudit,
  createPublicationGateDecision,
  createRunnerProvenance,
  publicationGateAggregateBindings,
  verifyPublicationAdmission,
} from "../packages/core/publication-authority.js";
import { resolveWebSurfaceProductionDecision } from "../scripts/web-surface-production-decision.mjs";

const SOURCE_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);
const RUNTIME_SHA = "3".repeat(40);

function fixture() {
  const descriptor = JSON.parse(fs.readFileSync("dist/site/controller-registry.json", "utf8"))
    .controllers.find((entry) => entry.id === "web-surface");
  const controllerPlan = createControllerPlan({
    descriptor,
    source: { repository: "kungfu-systems/site", sha: SOURCE_SHA },
    runtime: {
      ref: RUNTIME_SHA,
      sha: RUNTIME_SHA,
      contractDigest: `sha256:${"4".repeat(64)}`,
    },
    inputs: {},
  });
  const plan = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-deploy-plan",
    dryRun: true,
    channel: "production",
    artifact: { path: "dist", hash: "5".repeat(64), files: [] },
    manifest: {
      site: "site",
      sourceSha: SOURCE_SHA,
      runtimeId: RUNTIME_SHA,
      deployTarget: "site-production",
      artifactHash: "5".repeat(64),
    },
  };
  const planFileDigest = crypto
    .createHash("sha256")
    .update(`${JSON.stringify(plan, null, 2)}\n`)
    .digest("hex");
  const controllerReceipt = createControllerReceipt({
    plan: controllerPlan,
    stages: [
      { id: "resolve-runtime", status: "passed" },
      { id: "plan", status: "passed" },
      { id: "build", status: "passed" },
      { id: "verify", status: "passed" },
      { id: "publication-authority", status: "skipped" },
      { id: "apply", status: "skipped" },
      { id: "aggregate", status: "passed" },
    ],
    evidence: [{ kind: "web-surface-plan", digest: `sha256:${planFileDigest}` }],
  });
  const decision = createWebSurfaceProductionDecision({
    approved: true,
    kind: "manual-dispatch",
    repository: "kungfu-systems/site",
    sourceSha: SOURCE_SHA,
    actor: "maintainer",
    actorPermission: "write",
    reason: "trusted-manual-dispatch",
  });
  return { plan, planFileDigest, controllerReceipt, decision };
}

test("trusted manual and reviewed release PR paths both authorize production", () => {
  const manual = resolveWebSurfaceProductionDecision({
    eventName: "workflow_dispatch",
    refName: "main",
    repository: "kungfu-systems/site",
    sourceSha: SOURCE_SHA,
    actor: "maintainer",
    productionApply: true,
    productionApproved: true,
    actorPermission: "write",
  });
  const release = resolveWebSurfaceProductionDecision({
    eventName: "push",
    refName: "main",
    repository: "kungfu-systems/site",
    sourceSha: SOURCE_SHA,
    actor: "maintainer",
    productionApply: true,
    productionReleaseOnMain: true,
    releaseApproved: true,
    releasePr: 98,
    releaseSource: "release/production/site",
  });
  assert.equal(manual.approved, true);
  assert.equal(manual.kind, "manual-dispatch");
  assert.equal(release.approved, true);
  assert.equal(release.kind, "release-pr");
});

test("manual production rejects an actor without write permission", () => {
  const decision = resolveWebSurfaceProductionDecision({
    eventName: "workflow_dispatch",
    repository: "kungfu-systems/site",
    sourceSha: SOURCE_SHA,
    actor: "reader",
    productionApply: true,
    productionApproved: true,
    actorPermission: "read",
  });
  assert.equal(decision.approved, false);
  assert.equal(decision.reason, "manual-actor-permission-insufficient");
});

test("web publication candidate seals source, runtime, plan, artifact, receipt, and decision", () => {
  const values = fixture();
  const candidate = createWebSurfacePublicationCandidate({
    repository: "kungfu-systems/site",
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    runtimeSha: RUNTIME_SHA,
    ...values,
  });
  assert.equal(candidate.artifactHash, "5".repeat(64));
  assert.equal(candidate.controllerReceiptDigest, values.controllerReceipt.digest.slice(7));
  assert.equal(candidate.decisionDigest, values.decision.decisionDigest);
  assert.match(candidate.candidateDigest, /^[0-9a-f]{64}$/);
});

test("web publication candidate rejects plan and decision substitution", () => {
  const values = fixture();
  assert.throws(
    () => createWebSurfacePublicationCandidate({
      repository: "kungfu-systems/site",
      sourceSha: SOURCE_SHA,
      sourceTreeSha: TREE_SHA,
      runtimeSha: RUNTIME_SHA,
      ...values,
      plan: { ...values.plan, channel: "staging" },
    }),
    /production dry-run plan/,
  );
  assert.throws(
    () => createWebSurfacePublicationCandidate({
      repository: "kungfu-systems/site",
      sourceSha: SOURCE_SHA,
      sourceTreeSha: TREE_SHA,
      runtimeSha: RUNTIME_SHA,
      ...values,
      decision: { ...values.decision, approved: false },
    }),
    /decision is not approved/,
  );
});

test("independent authority emits web-production capability from the managed candidate", () => {
  const values = fixture();
  const candidateEvidence = {
    repository: "kungfu-systems/site",
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    runtimeSha: RUNTIME_SHA,
    ...values,
  };
  const candidate = createWebSurfacePublicationCandidate(candidateEvidence);
  const registry = createPublicationAuthorityRegistry({
    descriptors: [{
      workflowPath: ".github/workflows/.web-surface.yml",
      authorityClass: "product-publication",
      publicationCapable: true,
      capabilityIds: ["web-production"],
      credentialMode: "oidc",
      publisherWorkflowMode: "caller-bound",
      environmentMode: "caller-bound",
      runnerPolicy: "qualified-measured",
    }],
    workflows: [{
      path: ".github/workflows/.web-surface.yml",
      text: "permissions:\n  contents: read\njobs:\n  production-apply:\n    environment: production\n    permissions:\n      id-token: write\n",
    }],
  });
  const runnerProvenance = createRunnerProvenance({
    runnerClass: "ephemeral",
    os: "Linux",
    architecture: "X64",
    imageDigest: "6".repeat(64),
    measurementDigest: "7".repeat(64),
    isolation: "github-hosted-single-job",
  });
  const facts = [
    "actions-policy",
    "branch-policy",
    "environment-policy",
    "oidc-policy",
    "publisher-policy",
    "runner-policy",
  ].map((id, index) => ({ id, status: "pass", digest: String(index + 1).repeat(64) }));
  const controlPlaneAudit = createPublicationControlPlaneAudit({
    repository: "kungfu-systems/site",
    workflowPath: ".github/workflows/.web-surface.yml",
    publisherWorkflowPath: ".github/workflows/.web-surface.yml",
    environment: "production",
    facts,
    observedAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-16T00:10:00.000Z",
  });
  const gateAggregate = createPublicationGateDecision({
    sourceSha: SOURCE_SHA,
    profile: "managed-web-surface-production",
    rationale: "This fixture declares no project-specific Gate registry.",
    policy: { scope: "managed-web-surface-production" },
  });
  const gate = publicationGateAggregateBindings(gateAggregate);
  const admission = createPublicationAdmission({
    registryDigest: registry.registryDigest,
    workflowPath: ".github/workflows/.web-surface.yml",
    publisherWorkflowPath: ".github/workflows/.web-surface.yml",
    repository: "kungfu-systems/site",
    sourceSha: SOURCE_SHA,
    runtimeSha: RUNTIME_SHA,
    contractDigest: values.controllerReceipt.runtime.contractDigest,
    policyDigest: gate.policyDigest,
    gateRegistryDigest: gate.registryDigest,
    controllerReceiptDigest: values.controllerReceipt.digest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: gate.gateAggregateDigest,
    environment: "production",
    product: "site",
    target: "aws-role:arn:aws:iam::123456789012:role/site#deploy:site-production",
    version: SOURCE_SHA,
    channel: "production",
    artifactDigest: candidate.candidateDigest,
    nonce: "run:attempt:web-production",
    issuedAt: "2026-07-16T00:01:00.000Z",
    expiresAt: "2026-07-16T00:09:00.000Z",
  });
  const expected = Object.fromEntries([
    "repository", "publisherWorkflowPath", "sourceSha", "runtimeSha", "contractDigest", "policyDigest",
    "gateRegistryDigest", "controllerReceiptDigest", "gateAggregateDigest", "environment", "product", "target",
    "version", "channel", "artifactDigest",
  ].map((name) => [name, admission[name]]));
  const capability = verifyPublicationAdmission({
    admission,
    registry,
    runnerProvenance,
    controlPlaneAudit,
    publicationEvidence: { webSurfaceCandidate: candidateEvidence, gateAggregate },
    expected,
    now: new Date("2026-07-16T00:05:00.000Z"),
  });
  assert.deepEqual(capability.capabilityIds, ["web-production"]);
  assert.equal(capability.artifactDigest, candidate.candidateDigest);
});

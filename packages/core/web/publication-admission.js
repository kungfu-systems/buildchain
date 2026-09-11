import crypto from "node:crypto";
import {
  createPublicationAdmission,
  createPublicationControlPlaneAudit,
  createPublicationGateDecision,
  createRunnerProvenance,
  publicationGateAggregateBindings,
  verifyPublicationAdmission,
} from "../publication/publication-authority.js";
import { createWebSurfacePublicationCandidate } from "./web-surface-publication-candidate.js";

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
const auditFact = (id, value) => ({
  id,
  status: "pass",
  digest: sha256(JSON.stringify(value)),
});

export function assembleWebPublicationAdmission({
  repository,
  sourceSha,
  sourceTreeSha,
  runtimeSha,
  plan,
  planFileDigest,
  controllerReceipt,
  decision,
  environment,
  roleArn,
  runner,
  run,
  registry,
  issuedAt = new Date(),
}) {
  const candidate = createWebSurfacePublicationCandidate({
    repository,
    sourceSha,
    sourceTreeSha,
    runtimeSha,
    plan,
    planFileDigest,
    controllerReceipt,
    decision,
  });
  if (!/^arn:[^:]+:iam::[0-9]{12}:role\/.+/.test(roleArn)) {
    throw new Error(
      "BUILDCHAIN_PRODUCTION_ROLE_ARN must be an AWS IAM role ARN",
    );
  }
  if (
    runner.githubActions !== "true" ||
    runner.environment !== "github-hosted"
  ) {
    throw new Error(
      "managed web-surface publication requires an ephemeral GitHub-hosted Actions runner",
    );
  }
  const workflowPath = ".github/workflows/public-release-web.yml";
  const publisherWorkflowPath = workflowPath;
  const controlPlaneAudit = createPublicationControlPlaneAudit({
    repository,
    workflowPath,
    publisherWorkflowPath,
    environment,
    observedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString(),
    facts: [
      auditFact("actions-policy", { githubActions: true, sourceSha }),
      auditFact("branch-policy", {
        decisionKind: decision.kind,
        decisionDigest: decision.decisionDigest,
      }),
      auditFact("environment-policy", { environment }),
      auditFact("oidc-policy", {
        roleArnDigest: sha256(roleArn),
        authorization: "provider-at-transaction",
      }),
      auditFact("publisher-policy", { workflowPath, publisherWorkflowPath }),
      auditFact("runner-policy", {
        runnerEnvironment: runner.environment,
        runnerOs: runner.os,
      }),
    ],
  });
  const runnerProvenance = createRunnerProvenance({
    runnerClass: "ephemeral",
    os: runner.os,
    architecture: runner.architecture,
    imageDigest: sha256(
      `${runner.imageOs || "unknown"}|${runner.imageVersion || "unknown"}`,
    ),
    measurementDigest: sha256(
      [run.workflow, run.job, run.id, run.attempt, runner.environment].join(
        "|",
      ),
    ),
    isolation: "github-hosted-single-job",
  });
  const gateAggregate = createPublicationGateDecision({
    sourceSha,
    profile: "managed-web-surface-production",
    required: false,
    rationale:
      "The managed web-surface production lane has no project-specific Shifu Gate registry.",
    policy: { scope: "managed-web-surface-production", repository },
  });
  const gateBindings = publicationGateAggregateBindings(gateAggregate);
  const target = `aws-role:${roleArn}#deploy:${candidate.deployTarget}`;
  const admission = createPublicationAdmission({
    registryDigest: registry.registryDigest,
    workflowPath,
    publisherWorkflowPath,
    repository,
    sourceSha,
    runtimeSha,
    contractDigest: controllerReceipt.runtime.contractDigest,
    policyDigest: gateBindings.policyDigest,
    gateRegistryDigest: gateBindings.registryDigest,
    controllerReceiptDigest: controllerReceipt.digest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: gateBindings.gateAggregateDigest,
    environment,
    product: candidate.site,
    target,
    version: sourceSha,
    channel: "production",
    artifactDigest: candidate.candidateDigest,
    nonce: `${run.id}:${run.attempt}:${sourceSha}:web-production`,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString(),
  });
  const bindingNames = [
    "repository",
    "publisherWorkflowPath",
    "sourceSha",
    "runtimeSha",
    "contractDigest",
    "policyDigest",
    "gateRegistryDigest",
    "controllerReceiptDigest",
    "gateAggregateDigest",
    "environment",
    "product",
    "target",
    "version",
    "channel",
    "artifactDigest",
  ];
  const expected = Object.fromEntries(
    bindingNames.map((name) => [name, admission[name]]),
  );
  const capability = verifyPublicationAdmission({
    admission,
    registry,
    runnerProvenance,
    controlPlaneAudit,
    publicationEvidence: {
      webSurfaceCandidate: {
        repository,
        sourceSha,
        sourceTreeSha,
        runtimeSha,
        plan,
        planFileDigest,
        controllerReceipt,
        decision,
      },
      gateAggregate,
    },
    expected,
  });
  return {
    admission,
    runner_provenance: runnerProvenance,
    control_plane_audit: controlPlaneAudit,
    gate_aggregate: gateAggregate,
    expected,
    candidate,
    capability,
  };
}

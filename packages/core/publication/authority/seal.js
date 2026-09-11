import {
  createPublicationAdmission,
  publicationGateAggregateBindings,
} from "../publication-authority.js";
import { publicationRunnerProvenance } from "./runner.js";
import { admissionGateDecision } from "./gate.js";
export function sealManagedPublicationAdmission({
  request,
  evidence,
  registry,
  controlPlaneAudit,
  runner,
  now = new Date(),
}) {
  const kind = request.autoAdmissionKind,
    binary = kind === "binary-release-assets",
    paper = kind === "publication-artifact";
  const gateAggregate = admissionGateDecision(request),
    gateBindings = publicationGateAggregateBindings(gateAggregate),
    runnerProvenance = publicationRunnerProvenance(runner);
  const version = request.publicationVersion,
    repository = request.evidenceRepository;
  if (!version || !runner.runId || !runner.runAttempt)
    throw new Error(
      "Exact planned publication version and run identity required",
    );
  const suffix = binary ? ":binary-release-assets" : paper ? ":paper" : "";
  const defaults = {
    "release-candidate": ".github/workflows/public-release-promote.yml",
    "publication-artifact": ".github/workflows/public-release-paper-sealed.yml",
    "binary-release-assets": ".github/workflows/.release-binary-assets.yml",
  };
  const admission = createPublicationAdmission({
    registryDigest: registry.registryDigest,
    workflowPath: request.authorityWorkflowPath || defaults[kind],
    publisherWorkflowPath: request.publisherWorkflowPath,
    repository,
    sourceSha: request.sourceSha,
    runtimeSha: evidence.runtimeSha,
    contractDigest: evidence.controllerReceipt.runtime?.contractDigest,
    policyDigest: gateBindings.policyDigest,
    gateRegistryDigest: gateBindings.registryDigest,
    controllerReceiptDigest: evidence.controllerReceipt.digest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: binary
      ? gateBindings.gateAggregateDigest
      : gateAggregate.digest,
    environment: binary ? "buildchain-release-assets" : "none",
    product: binary ? "Buildchain standalone binary" : request.product,
    target: binary
      ? `github-release:${repository}@v${version}`
      : request.publicationTarget,
    version,
    channel: binary
      ? "release-assets"
      : request.targetRef.startsWith("release/")
        ? "release"
        : request.targetRef.startsWith("alpha/") || paper
          ? "alpha"
          : "major",
    artifactDigest: evidence.artifactDigest,
    nonce: `${runner.runId}:${runner.runAttempt}:${request.sourceSha}${suffix}`,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    qualification: {
      required: !binary && request.consumerQualificationRequired === true,
      predicateId: binary ? "" : request.consumerPredicateId || "",
      predicateDigest: binary ? "" : request.consumerPredicateDigest || "",
    },
  });
  const keys = [
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
  return {
    admission,
    runner_provenance: runnerProvenance,
    control_plane_audit: controlPlaneAudit,
    gate_aggregate: gateAggregate,
    expected: Object.fromEntries(keys.map((key) => [key, admission[key]])),
    ...(evidence.candidate ? { candidate: evidence.candidate } : {}),
  };
}

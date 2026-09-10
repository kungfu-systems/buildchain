import test from "node:test";
import assert from "node:assert/strict";
import { sealManagedPublicationAdmission } from "../packages/core/publication/authority/seal.js";
import {
  createPublicationGateDecision,
  publicationAuthorityDigest,
} from "../packages/core/publication/publication-authority.js";
const sha = "a".repeat(40),
  runtimeSha = "b".repeat(40),
  digest = "c".repeat(64);
function fixture(kind) {
  return {
    request: {
      autoAdmissionKind: kind,
      sourceSha: sha,
      evidenceRepository: "acme/project",
      publicationVersion: "4.1.0-alpha.0",
      targetRef: "alpha/v4/v4.1",
      publisherWorkflowPath: ".github/workflows/publisher.yml",
      autoNoGate: true,
      product: "Paper",
      publicationTarget: "npm:@acme/project",
      consumerQualificationRequired: true,
      consumerPredicateId: "fixture",
      consumerPredicateDigest: digest,
    },
    evidence: {
      runtimeSha,
      controllerReceipt: { runtime: { contractDigest: digest }, digest },
      artifactDigest: digest,
    },
    registry: { registryDigest: digest },
    controlPlaneAudit: { receiptDigest: digest },
    runner: {
      os: "Linux",
      architecture: "X64",
      imageOs: "ubuntu24",
      imageVersion: "20260910",
      workflow: "Publish",
      job: "verify",
      runId: "42",
      runAttempt: "2",
      environment: "github-hosted",
    },
    now: new Date("2026-09-10T00:00:00Z"),
  };
}
test("three evidence kinds share sealing while preserving publisher, runtime and qualification contracts", () => {
  for (const kind of [
    "release-candidate",
    "publication-artifact",
    "binary-release-assets",
  ]) {
    const input = fixture(kind),
      bundle = sealManagedPublicationAdmission(input),
      admission = bundle.admission;
    assert.equal(admission.sourceSha, sha);
    assert.equal(admission.runtimeSha, runtimeSha);
    assert.equal(admission.expiresAt, "2026-09-10T00:10:00.000Z");
    assert.equal(
      admission.publisherWorkflowPath,
      input.request.publisherWorkflowPath,
    );
    assert.equal(admission.artifactDigest, digest);
    assert.equal(bundle.expected.runtimeSha, runtimeSha);
    assert.equal(
      bundle.expected.gateAggregateDigest,
      admission.gateAggregateDigest,
    );
    assert.equal(
      admission.runnerProvenanceDigest,
      bundle.runner_provenance.receiptDigest,
    );
    assert.equal(
      admission.qualification.required,
      kind !== "binary-release-assets",
    );
    assert.equal(
      admission.environment,
      kind === "binary-release-assets" ? "buildchain-release-assets" : "none",
    );
    assert.equal(
      admission.channel,
      kind === "binary-release-assets" ? "release-assets" : "alpha",
    );
    assert.equal(
      admission.nonce,
      `42:2:${sha}${kind === "binary-release-assets" ? ":binary-release-assets" : kind === "publication-artifact" ? ":paper" : ""}`,
    );
    const { admissionDigest, ...payload } = admission;
    assert.equal(admissionDigest, publicationAuthorityDigest(payload));
  }
});
test("managed candidate preserves the complete supplied Gate and cannot invent a no-Gate decision", () => {
  const input = fixture("release-candidate");
  input.request.autoNoGate = false;
  assert.throws(
    () => sealManagedPublicationAdmission(input),
    /explicit no-Gate/,
  );
  const gate = createPublicationGateDecision({
    sourceSha: sha,
    profile: "fixture",
    required: false,
    rationale: "Fixture policy declares no Gate",
    policy: { scope: "fixture" },
  });
  input.request.gateAggregate = gate;
  const result = sealManagedPublicationAdmission(input);
  assert.deepEqual(result.gate_aggregate, gate);
  assert.equal(result.admission.gateAggregateDigest, gate.digest);
});
test("major candidate and paper admission retain distinct channel semantics", () => {
  const candidate = fixture("release-candidate"),
    paper = fixture("publication-artifact");
  candidate.request.targetRef = paper.request.targetRef = "publish-gate/major";
  assert.equal(
    sealManagedPublicationAdmission(candidate).admission.channel,
    "major",
  );
  assert.equal(
    sealManagedPublicationAdmission(paper).admission.channel,
    "alpha",
  );
});

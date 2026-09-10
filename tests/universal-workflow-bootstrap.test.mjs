import assert from "node:assert/strict";
import test from "node:test";
import { admitUniversalWorkflow, completeUniversalWorkflow, validateUniversalWorkflowRequest, universalWorkflowAdmissionRoot, universalWorkflowRequestRoot } from "../packages/core/workflow/universal-workflow-bootstrap.js";
import { sha, root, policy, request, reviewEvidence, consumerObservation } from "./universal-workflow-harness.mjs";

test("an admitted Train resolves once to an exact execution identity", () => {
  const policyValue = policy();
  const admission = admitUniversalWorkflow({
    ...consumerObservation(),
    request: request(policyValue),
    policy: policyValue,
    observedRefSha: sha("1"),
    reviewEvidence: reviewEvidence(),
    now: "2026-08-30T12:00:00.000Z",
  });
  assert.equal(admission.status, "admitted");
  assert.deepEqual(admission.runtime, {
    repository: "kungfu-systems/buildchain",
    sha: sha("1"),
  });
  assert.equal(JSON.stringify(admission).includes("train/v4"), false);

  const receipt = completeUniversalWorkflow({
    admission,
    status: "succeeded",
    resultRoot: root("c"),
  });
  assert.equal(receipt.status, "succeeded");
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(receipt).includes("train/v4"), false);
});

test("a protected Alpha merge binds reviewed head to the exact runtime", () => {
  const policyValue = policy(),
    requestValue = request(policyValue, { mode: "alpha" });
  requestValue.candidate.discoveryRef = "v4-alpha";
  const binding = {
    kind: "protected-alpha-merge",
    runtimeSha: sha("1"),
    parentShas: [sha("0"), sha("3")],
    mergedAt: "2026-08-30T11:30:00.000Z",
  };
  const evidence = reviewEvidence({
    headSha: sha("3"),
    baseRef: "alpha/v4/v4.0",
    approvals: [
      {
        reviewer: "kungfu-origin",
        commitSha: sha("3"),
        submittedAt: "2026-08-30T11:00:00.000Z",
      },
    ],
    checks: [
      {
        name: "Verify",
        status: "completed",
        conclusion: "success",
        commitSha: sha("1"),
      },
    ],
    runtimeBinding: binding,
  });
  const admit = (
    candidateRequest = requestValue,
    candidateEvidence = evidence,
  ) =>
    admitUniversalWorkflow({
      ...consumerObservation(),
      request: candidateRequest,
      policy: policyValue,
      observedRefSha: sha("1"),
      reviewEvidence: candidateEvidence,
      now: "2026-08-30T12:00:00.000Z",
    });
  assert.equal(admit().runtime.sha, sha("1"));
  for (const invalid of [
    { ...evidence, baseRef: "dev/v4/v4.0" },
    { ...evidence, runtimeBinding: { ...binding, runtimeSha: sha("9") } },
    {
      ...evidence,
      runtimeBinding: { ...binding, parentShas: [sha("0"), sha("9")] },
    },
    {
      ...evidence,
      runtimeBinding: { ...binding, mergedAt: "2026-08-30T12:30:00.000Z" },
    },
    { ...evidence, checks: [{ ...evidence.checks[0], commitSha: sha("9") }] },
  ])
    assert.throws(() => admit(requestValue, invalid));
  assert.throws(() => admit(request(policyValue), evidence));
});

test("any exact verified caller is admitted without a repository allowlist", () => {
  const policyValue = policy();
  const requestValue = request(policyValue);
  requestValue.consumer.repository = "example/downstream";
  requestValue.consumer.workflow = ".github/workflows/publish.yml";
  requestValue.candidate.admissionRoot =
    universalWorkflowAdmissionRoot(policyValue);
  const admission = admitUniversalWorkflow({
    request: requestValue,
    policy: policyValue,
    observedRefSha: sha("1"),
    observedConsumerRepository: "example/downstream",
    observedConsumerSha: sha("2"),
    observedConsumerWorkflowRef:
      "example/downstream/.github/workflows/publish.yml@refs/heads/main",
    reviewEvidence: reviewEvidence(),
    now: "2026-08-30T12:00:00.000Z",
  });
  assert.equal(admission.status, "admitted");
});

test("legacy repository allowlists cannot replace verified-caller admission", () => {
  const legacyPolicy = policy();
  delete legacyPolicy.consumerAdmission;
  legacyPolicy.allowedConsumers = ["kungfu-systems/taolu"];
  assert.throws(() => universalWorkflowAdmissionRoot(legacyPolicy), {
    code: "invalid-field-set",
  });
});

test("verified-caller admission rejects repository, workflow, and source spoofing", () => {
  const policyValue = policy();
  for (const observation of [
    { ...consumerObservation(), observedConsumerRepository: "example/other" },
    { ...consumerObservation(), observedConsumerSha: sha("9") },
    {
      ...consumerObservation(),
      observedConsumerWorkflowRef:
        "kungfu-systems/taolu/.github/workflows/other.yml@refs/heads/main",
    },
  ]) {
    assert.throws(
      () =>
        admitUniversalWorkflow({
          ...observation,
          request: request(policyValue),
          policy: policyValue,
          observedRefSha: sha("1"),
          reviewEvidence: reviewEvidence(),
          now: "2026-08-30T12:00:00.000Z",
        }),
      { code: "consumer-identity-mismatch" },
    );
  }
});

test("moved refs fail before candidate execution", () => {
  const policyValue = policy();
  assert.throws(
    () =>
      admitUniversalWorkflow({
        ...consumerObservation(),
        request: request(policyValue),
        policy: policyValue,
        observedRefSha: sha("3"),
        reviewEvidence: reviewEvidence(),
        now: "2026-08-30T12:00:00.000Z",
      }),
    { code: "candidate-ref-moved" },
  );
});

test("stale admission and permission widening fail closed", () => {
  const policyValue = policy();
  assert.throws(
    () =>
      admitUniversalWorkflow({
        ...consumerObservation(),
        request: request(policyValue),
        policy: policyValue,
        observedRefSha: sha("1"),
        reviewEvidence: reviewEvidence(),
        now: "2026-09-01T00:00:00.000Z",
      }),
    { code: "stale-admission" },
  );

  const widened = request(policyValue);
  widened.capability.permissions.checks = "write";
  assert.throws(
    () =>
      admitUniversalWorkflow({
        ...consumerObservation(),
        request: widened,
        policy: policyValue,
        observedRefSha: sha("1"),
        reviewEvidence: reviewEvidence(),
        now: "2026-08-30T12:00:00.000Z",
      }),
    { code: "permission-widening" },
  );
});

test("review and exact-head checks gate write-authority admission", () => {
  const policyValue = policy();
  for (const evidence of [
    reviewEvidence({ approvals: [] }),
    reviewEvidence({ headSha: sha("8") }),
    reviewEvidence({
      checks: [{ name: "Verify", status: "completed", conclusion: "failure" }],
    }),
  ]) {
    assert.throws(() =>
      admitUniversalWorkflow({
        ...consumerObservation(),
        request: request(policyValue),
        policy: policyValue,
        observedRefSha: sha("1"),
        reviewEvidence: evidence,
        now: "2026-08-30T12:00:00.000Z",
      }),
    );
  }
});

test("fork candidates and unsupported Train selectors are rejected", () => {
  const policyValue = policy();
  const fork = request(policyValue);
  fork.candidate.repository = "example/buildchain";
  assert.throws(
    () => admitUniversalWorkflow({ request: fork, policy: policyValue }),
    {
      code: "untrusted-candidate-repository",
    },
  );

  const branch = request(policyValue);
  branch.candidate.discoveryRef = "feature/unreviewed";
  assert.throws(
    () => admitUniversalWorkflow({ request: branch, policy: policyValue }),
    { code: "invalid-train-ref" },
  );
});

test("schema-evolution data crosses one envelope without typed facade changes", () => {
  const policyValue = policy();
  const baseline = request(policyValue);
  const evolved = request(policyValue);
  evolved.payload = {
    schema: "kungfu-buildchain-consumer-release-payload/v2",
    nested: { newProviderField: true },
    releaseTailCapabilities: ["artifact.publish", "release.activate"],
  };
  assert.deepEqual(
    validateUniversalWorkflowRequest(evolved).payload,
    evolved.payload,
  );
  assert.notEqual(
    universalWorkflowRequestRoot(evolved),
    universalWorkflowRequestRoot(baseline),
  );
  assert.throws(
    () =>
      validateUniversalWorkflowRequest({ ...evolved, newFacadeInput: true }),
    { code: "invalid-field-set" },
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { admitUniversalWorkflow, completeUniversalWorkflow, validateUniversalWorkflowRequest, universalWorkflowAdmissionRoot, universalWorkflowRequestRoot } from "../packages/core/workflow/universal-workflow-bootstrap.js";
import { sha, root, policy, request, consumerObservation } from "./universal-workflow-harness.mjs";

test("capability admission consumes the runtime already selected by the entry", () => {
  const policyValue = policy();
  const admission = admitUniversalWorkflow({
    ...consumerObservation(),
    request: request(policyValue),
    policy: policyValue,


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

test("any exact verified caller is admitted without a repository allowlist", () => {
  const policyValue = policy();
  const requestValue = request(policyValue);
  requestValue.consumer.repository = "example/downstream";
  requestValue.consumer.workflow = ".github/workflows/publish.yml";
  const admission = admitUniversalWorkflow({
    ...consumerObservation(),
    request: requestValue,
    policy: policyValue,

    observedConsumerRepository: "example/downstream",
    observedConsumerSha: sha("2"),
    observedConsumerWorkflowRef:
      "example/downstream/.github/workflows/publish.yml@refs/heads/main",

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


          now: "2026-08-30T12:00:00.000Z",
        }),
      { code: "consumer-identity-mismatch" },
    );
  }
});

test("stale admission and permission widening fail closed", () => {
  const policyValue = policy();
  assert.throws(
    () =>
      admitUniversalWorkflow({
        ...consumerObservation(),
        request: request(policyValue),
        policy: policyValue,


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


        now: "2026-08-30T12:00:00.000Z",
      }),
    { code: "permission-widening" },
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

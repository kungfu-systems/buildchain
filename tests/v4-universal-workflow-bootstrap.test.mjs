import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  V4_UNIVERSAL_WORKFLOW_ADMISSION_POLICY,
  V4_UNIVERSAL_WORKFLOW_REQUEST,
  admitV4UniversalWorkflow,
  completeV4UniversalWorkflow,
  validateV4UniversalWorkflowRequest,
  v4UniversalWorkflowAdmissionRoot,
  v4UniversalWorkflowRequestRoot,
} from "../packages/core/v4-universal-workflow-bootstrap.js";

const sha = (character) => character.repeat(40);
const root = (character) => `sha256:${character.repeat(64)}`;

function policy(overrides = {}) {
  return {
    schema: V4_UNIVERSAL_WORKFLOW_ADMISSION_POLICY,
    sourceRepository: "kungfu-systems/buildchain",
    allowedConsumers: ["kungfu-systems/taolu"],
    allowedCapabilities: ["consumer-release"],
    permissionCeiling: {
      contents: "write",
      "id-token": "write",
      packages: "write",
    },
    contractRoots: [root("a"), root("b")],
    targetRef: "dev/v4/v4.0",
    allowedReviewers: ["kungfu-origin"],
    minimumApprovals: 1,
    requiredChecks: ["Verify"],
    validFrom: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function request(policyValue = policy(), overrides = {}) {
  return {
    schema: V4_UNIVERSAL_WORKFLOW_REQUEST,
    mode: "train",
    candidate: {
      repository: "kungfu-systems/buildchain",
      discoveryRef: "train/v4/v4.0/universal-reusable-workflow-bootstrap",
      expectedSha: sha("1"),
      admissionRoot: v4UniversalWorkflowAdmissionRoot(policyValue),
      reviewPullRequest: 42,
    },
    consumer: {
      repository: "kungfu-systems/taolu",
      workflow: ".github/workflows/release.yml",
      sourceSha: sha("2"),
    },
    capability: {
      id: "consumer-release",
      contractRoots: [root("a"), root("b")],
      permissions: {
        contents: "write",
        "id-token": "write",
        packages: "read",
      },
    },
    payload: { channel: "alpha", dryRun: false },
    ...overrides,
  };
}

function reviewEvidence(overrides = {}) {
  return {
    repository: "kungfu-systems/buildchain",
    pullRequest: 42,
    headSha: sha("1"),
    baseRef: "dev/v4/v4.0",
    approvals: [
      {
        reviewer: "kungfu-origin",
        commitSha: sha("1"),
        submittedAt: "2026-08-30T11:00:00.000Z",
      },
    ],
    checks: [{ name: "Verify", status: "completed", conclusion: "success" }],
    observedAt: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

const consumerObservation = () => ({
  observedConsumerRepository: "kungfu-systems/taolu",
  observedConsumerSha: sha("2"),
});

test("an admitted Train resolves once to an exact execution identity", () => {
  const policyValue = policy();
  const admission = admitV4UniversalWorkflow({
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

  const receipt = completeV4UniversalWorkflow({
    admission,
    status: "succeeded",
    resultRoot: root("c"),
  });
  assert.equal(receipt.status, "succeeded");
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(receipt).includes("train/v4"), false);
});

test("moved refs fail before candidate execution", () => {
  const policyValue = policy();
  assert.throws(
    () =>
      admitV4UniversalWorkflow({
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
      admitV4UniversalWorkflow({
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
      admitV4UniversalWorkflow({
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
      admitV4UniversalWorkflow({
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
    () => admitV4UniversalWorkflow({ request: fork, policy: policyValue }),
    {
      code: "untrusted-candidate-repository",
    },
  );

  const branch = request(policyValue);
  branch.candidate.discoveryRef = "feature/unreviewed";
  assert.throws(
    () => admitV4UniversalWorkflow({ request: branch, policy: policyValue }),
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
    validateV4UniversalWorkflowRequest(evolved).payload,
    evolved.payload,
  );
  assert.notEqual(
    v4UniversalWorkflowRequestRoot(evolved),
    v4UniversalWorkflowRequestRoot(baseline),
  );
  assert.throws(
    () =>
      validateV4UniversalWorkflowRequest({ ...evolved, newFacadeInput: true }),
    { code: "invalid-field-set" },
  );
});

test("the fixed CLI executes only the exact admitted candidate", () => {
  const policyValue = policy({
    allowedCapabilities: ["bootstrap-conformance"],
  });
  const requestValue = request(policyValue);
  requestValue.capability.id = "bootstrap-conformance";
  requestValue.payload = {
    schema: "kungfu-buildchain-v4-universal-bootstrap-conformance/v1",
    expectedGovernedWorkflowCount: 40,
  };
  const engine = fileURLToPath(
    new URL("../scripts/v4-universal-workflow-engine.mjs", import.meta.url),
  );
  const run = (command, environment) =>
    JSON.parse(
      execFileSync(process.execPath, [engine, command], {
        encoding: "utf8",
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  const admission = run("admit", {
    BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(requestValue),
    BUILDCHAIN_UNIVERSAL_ADMISSION_POLICY_JSON: JSON.stringify(policyValue),
    BUILDCHAIN_UNIVERSAL_OBSERVED_SHA: sha("1"),
    BUILDCHAIN_UNIVERSAL_CONSUMER_REPOSITORY: "kungfu-systems/taolu",
    BUILDCHAIN_UNIVERSAL_CONSUMER_SHA: sha("2"),
    BUILDCHAIN_UNIVERSAL_OBSERVED_AT: "2026-08-30T12:00:00.000Z",
    BUILDCHAIN_UNIVERSAL_REVIEW_EVIDENCE_JSON: JSON.stringify(reviewEvidence()),
  });
  const result = run("execute", {
    BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(requestValue),
    BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
    BUILDCHAIN_UNIVERSAL_ENGINE_SHA: sha("1"),
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.output.status, "candidate-engine-executed");
  assert.equal(result.output.governedWorkflowCount, 40);
  assert.match(result.output.engineRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.runtime.sha, sha("1"));
  const receipt = run("terminal", {
    BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
    BUILDCHAIN_UNIVERSAL_RESULT_JSON: JSON.stringify(result),
  });
  assert.equal(receipt.status, "succeeded");

  assert.throws(
    () =>
      run("execute", {
        BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(requestValue),
        BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
        BUILDCHAIN_UNIVERSAL_ENGINE_SHA: sha("9"),
      }),
    /candidate engine checkout does not match/u,
  );
  const tamperedRequest = structuredClone(requestValue);
  tamperedRequest.payload = { tampered: true };
  assert.throws(
    () =>
      run("execute", {
        BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(tamperedRequest),
        BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
        BUILDCHAIN_UNIVERSAL_ENGINE_SHA: sha("1"),
      }),
    /does not match the admitted request root/u,
  );
});

test("the shared candidate engine owns canonical ReleaseInvocation projection", () => {
  const policyValue = policy({ allowedCapabilities: ["release-invocation"] });
  const requestValue = request(policyValue);
  requestValue.capability.id = "release-invocation";
  requestValue.payload = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-release-invocation-fixtures.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).invocations.alpha;
  const engine = fileURLToPath(
    new URL("../scripts/v4-universal-workflow-engine.mjs", import.meta.url),
  );
  const run = (command, environment) =>
    JSON.parse(
      execFileSync(process.execPath, [engine, command], {
        encoding: "utf8",
        env: { ...process.env, ...environment },
      }),
    );
  const admission = run("admit", {
    BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(requestValue),
    BUILDCHAIN_UNIVERSAL_ADMISSION_POLICY_JSON: JSON.stringify(policyValue),
    BUILDCHAIN_UNIVERSAL_OBSERVED_SHA: sha("1"),
    BUILDCHAIN_UNIVERSAL_CONSUMER_REPOSITORY: "kungfu-systems/taolu",
    BUILDCHAIN_UNIVERSAL_CONSUMER_SHA: sha("2"),
    BUILDCHAIN_UNIVERSAL_OBSERVED_AT: "2026-08-30T12:00:00.000Z",
    BUILDCHAIN_UNIVERSAL_REVIEW_EVIDENCE_JSON: JSON.stringify(reviewEvidence()),
  });
  const result = run("execute", {
    BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(requestValue),
    BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
    BUILDCHAIN_UNIVERSAL_ENGINE_SHA: sha("1"),
  });
  assert.equal(result.status, "succeeded");
  assert.match(
    result.output.releaseRoots.invocationRoot,
    /^sha256:[0-9a-f]{64}$/u,
  );
});

test("release promotion inputs are schema-derived and dry-run before provider effects", () => {
  const policyValue = policy({
    allowedCapabilities: ["release-candidate-promote"],
  });
  const requestValue = request(policyValue);
  requestValue.capability.id = "release-candidate-promote";
  requestValue.payload = {
    schema: "kungfu-buildchain-v4-universal-release-promotion/v1",
    inputs: {
      channel: "alpha",
      "dry-run": true,
      "target-ref": "alpha/v1/v1.0",
      "target-sha": sha("2"),
    },
    dryRunObservation: {
      observedSha: sha("2"),
      comparisonStatus: "identical",
    },
  };
  const admission = admitV4UniversalWorkflow({
    ...consumerObservation(),
    request: requestValue,
    policy: policyValue,
    observedRefSha: sha("1"),
    reviewEvidence: reviewEvidence(),
    now: "2026-08-30T12:00:00.000Z",
  });
  const engine = fileURLToPath(
    new URL("../scripts/v4-universal-workflow-engine.mjs", import.meta.url),
  );
  const result = JSON.parse(
    execFileSync(process.execPath, [engine, "execute"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(requestValue),
        BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
        BUILDCHAIN_UNIVERSAL_ENGINE_SHA: sha("1"),
      },
    }),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.output.dryRun, true);
  assert.equal(result.output.route.decision, "Fresh");
});

test("candidate capability failures still produce one rooted terminal receipt", () => {
  const policyValue = policy({ allowedCapabilities: ["future-capability"] });
  const requestValue = request(policyValue);
  requestValue.capability.id = "future-capability";
  const admission = admitV4UniversalWorkflow({
    ...consumerObservation(),
    request: requestValue,
    policy: policyValue,
    observedRefSha: sha("1"),
    reviewEvidence: reviewEvidence(),
    now: "2026-08-30T12:00:00.000Z",
  });
  const engine = fileURLToPath(
    new URL("../scripts/v4-universal-workflow-engine.mjs", import.meta.url),
  );
  const result = JSON.parse(
    execFileSync(process.execPath, [engine, "execute"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(requestValue),
        BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
        BUILDCHAIN_UNIVERSAL_ENGINE_SHA: sha("1"),
      },
    }),
  );
  assert.equal(result.status, "failed");
  const receipt = JSON.parse(
    execFileSync(process.execPath, [engine, "terminal"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
        BUILDCHAIN_UNIVERSAL_RESULT_JSON: JSON.stringify(result),
      },
    }),
  );
  assert.equal(receipt.status, "failed");
});

test("production admission rejects contract-only false success", () => {
  const policyValue = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-universal-workflow-train-admission.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    policyValue.allowedCapabilities.includes("workflow-contract"),
    false,
  );
  const requestValue = request(policyValue);
  requestValue.capability.id = "workflow-contract";
  requestValue.capability.contractRoots = policyValue.contractRoots;
  requestValue.candidate.admissionRoot =
    v4UniversalWorkflowAdmissionRoot(policyValue);
  assert.throws(
    () =>
      admitV4UniversalWorkflow({
        ...consumerObservation(),
        request: requestValue,
        policy: policyValue,
        observedRefSha: sha("1"),
        reviewEvidence: reviewEvidence(),
        now: "2026-08-30T12:00:00.000Z",
      }),
    { code: "capability-not-admitted" },
  );
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { candidateResultOutputs } from "../packages/core/workflow/nodes/bootstrap-io.mjs";
import { admitUniversalWorkflow } from "../packages/core/workflow/universal-workflow-bootstrap.js";
import { sha, root, policy, request, reviewEvidence, consumerObservation } from "./universal-workflow-harness.mjs";

test("the fixed CLI executes only the exact admitted candidate", () => {
  const policyValue = policy({
    allowedCapabilities: ["bootstrap-conformance"],
  });
  const requestValue = request(policyValue);
  requestValue.capability.id = "bootstrap-conformance";
  requestValue.payload = {
    schema: "kungfu-buildchain-v4-universal-bootstrap-conformance/v1",
    expectedGovernedWorkflowCount: 1,
  };
  const engine = fileURLToPath(
    new URL(
      "../packages/core/workflow/commands/universal-workflow-engine.mjs",
      import.meta.url,
    ),
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
    BUILDCHAIN_UNIVERSAL_CONSUMER_WORKFLOW_REF:
      "kungfu-systems/taolu/.github/workflows/release.yml@refs/heads/main",
    BUILDCHAIN_UNIVERSAL_OBSERVED_AT: "2026-08-30T12:00:00.000Z",
    BUILDCHAIN_UNIVERSAL_REVIEW_EVIDENCE_JSON: JSON.stringify(reviewEvidence()),
  });
  const result = run("execute", {
    BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(requestValue),
    BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
    BUILDCHAIN_UNIVERSAL_ENGINE_SHA: sha("1"),
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.output.status, "candidate-engine-executed");
  assert.equal(result.output.governedWorkflowCount, 1);
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
        "../architecture/release-invocation-fixtures.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).invocations.alpha;
  const engine = fileURLToPath(
    new URL(
      "../packages/core/workflow/commands/universal-workflow-engine.mjs",
      import.meta.url,
    ),
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
    BUILDCHAIN_UNIVERSAL_CONSUMER_WORKFLOW_REF:
      "kungfu-systems/taolu/.github/workflows/release.yml@refs/heads/main",
    BUILDCHAIN_UNIVERSAL_OBSERVED_AT: "2026-08-30T12:00:00.000Z",
    BUILDCHAIN_UNIVERSAL_REVIEW_EVIDENCE_JSON: JSON.stringify(reviewEvidence()),
  });
  const result = run("execute", {
    BUILDCHAIN_UNIVERSAL_REQUEST_JSON: JSON.stringify(requestValue),
    BUILDCHAIN_UNIVERSAL_ADMISSION_JSON: JSON.stringify(admission),
    BUILDCHAIN_UNIVERSAL_ENGINE_SHA: sha("1"),
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.match(
    result.output.releaseRoots.invocationRoot,
    /^sha256:[0-9a-f]{64}$/u,
  );
});

for (const [label, mutation, expectedStatus] of [
  ["current typed request", {}, "succeeded"],
  ["retired command", { "publish-command": "touch forbidden-provider-effect" }, "failed"],
  ["untyped dry-run", { "dry-run": "true" }, "failed"],
  ["unknown field", { unknown: true }, "failed"],
]) test(`universal promotion admits ${label} through the shared request schema`, () => {
  const policyValue = policy({
    allowedCapabilities: ["release-candidate-promote"],
  });
  const requestValue = request(policyValue);
  requestValue.capability.id = "release-candidate-promote";
  requestValue.payload = {
    schema: "kungfu-buildchain-v4-universal-release-promotion/v1",
    inputs: {
      schema: "buildchain.promotion-request/v1",
      channel: "alpha",
      "dry-run": true,
      "target-ref": "alpha/v1/v1.0",
      "target-sha": sha("2"),
      ...mutation,
    },
    dryRunObservation: {
      observedSha: sha("2"),
      comparisonStatus: "identical",
    },
  };
  const admission = admitUniversalWorkflow({
    ...consumerObservation(),
    request: requestValue,
    policy: policyValue,
    observedRefSha: sha("1"),
    reviewEvidence: reviewEvidence(),
    now: "2026-08-30T12:00:00.000Z",
  });
  const engine = fileURLToPath(
    new URL(
      "../packages/core/workflow/commands/universal-workflow-engine.mjs",
      import.meta.url,
    ),
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
  assert.equal(result.status, expectedStatus, JSON.stringify(result));
  if (expectedStatus === "succeeded") {
    assert.equal(result.output.dryRun, true);
    assert.equal(result.output.route.decision, "Fresh");
  } else {
    assert.equal(result.error.code, "candidate-execution-failed");
    assert.equal(result.output, undefined);
  }
});

test("candidate action logs cannot corrupt the rooted result channel", () => {
  const engine = fs.readFileSync(
    new URL(
      "../packages/core/workflow/commands/universal-workflow-engine.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(engine, /stdio: \["ignore", 2, 2\]/u);
  const result = {
    schema: "kungfu-buildchain-v4-universal-workflow-result/v1",
    status: "succeeded",
    resultRoot: root("a"),
  };
  assert.equal(
    candidateResultOutputs(result)["result-root"],
    result.resultRoot,
  );
  for (const changed of [
    { ...result, resultRoot: "unrooted" },
    { ...result, status: "pending" },
    { ...result, schema: "log" },
  ])
    assert.throws(() => candidateResultOutputs(changed));
});

test("candidate capability failures still produce one rooted terminal receipt", () => {
  const policyValue = policy({ allowedCapabilities: ["future-capability"] });
  const requestValue = request(policyValue);
  requestValue.capability.id = "future-capability";
  const admission = admitUniversalWorkflow({
    ...consumerObservation(),
    request: requestValue,
    policy: policyValue,
    observedRefSha: sha("1"),
    reviewEvidence: reviewEvidence(),
    now: "2026-08-30T12:00:00.000Z",
  });
  const engine = fileURLToPath(
    new URL(
      "../packages/core/workflow/commands/universal-workflow-engine.mjs",
      import.meta.url,
    ),
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

#!/usr/bin/env node
import crypto from "node:crypto";
import {
  admitV4UniversalWorkflow,
  completeV4UniversalWorkflow,
  validateV4UniversalWorkflowRequest,
  v4UniversalWorkflowRequestRoot,
} from "../packages/core/v4-universal-workflow-bootstrap.js";
import { createV4ReleaseInvocation } from "../packages/core/v4-release-invocation.js";

function fail(message) {
  throw new Error(message);
}

function readJsonEnvironment(name) {
  const source = process.env[name];
  if (!source) fail(`${name} is required`);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${name} is not valid JSON`, { cause: error });
  }
}

function exactRuntime(admission) {
  const runtime = admission?.runtime;
  if (
    admission?.status !== "admitted" ||
    runtime?.repository !== "kungfu-systems/buildchain" ||
    !/^[0-9a-f]{40}$/u.test(runtime?.sha || "")
  )
    fail("an exact admitted Buildchain runtime is required");
  return runtime;
}

function contentRoot(domain, value) {
  const hash = crypto.createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(`${JSON.stringify(value)}\n`, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function capabilityResult(request, admission) {
  if (request.capability.id === "bootstrap-conformance")
    return { payload: request.payload };
  if (request.capability.id === "release-invocation") {
    const release = createV4ReleaseInvocation(request.payload);
    return {
      releaseInvocation: release.invocation,
      releaseRoots: release.roots,
    };
  }
  fail(`candidate capability is not implemented: ${request.capability.id}`);
}

function executeCandidate(request, admission) {
  const runtime = exactRuntime(admission);
  const engineSha = String(process.env.BUILDCHAIN_UNIVERSAL_ENGINE_SHA || "")
    .trim()
    .toLowerCase();
  if (engineSha !== runtime.sha)
    fail("candidate engine checkout does not match the admitted runtime SHA");
  try {
    return {
      status: "succeeded",
      output: capabilityResult(request, admission),
    };
  } catch (error) {
    return {
      status: "failed",
      error: {
        code: String(error?.code || "candidate-execution-failed"),
        message: "candidate capability execution failed",
      },
    };
  }
}

function assertResultLineage(admission, result) {
  if (
    result?.schema !== "kungfu-buildchain-v4-universal-workflow-result/v1" ||
    result.requestRoot !== admission.requestRoot ||
    result.capabilityRoot !== admission.capabilityRoot ||
    result.runtime?.repository !== admission.runtime?.repository ||
    result.runtime?.sha !== admission.runtime?.sha ||
    !["succeeded", "failed"].includes(result.status)
  )
    fail("candidate result does not match the admitted lineage");
}

const command = process.argv[2];
if (!command) fail("a command is required");

if (command === "inspect") {
  const request = validateV4UniversalWorkflowRequest(
    readJsonEnvironment("BUILDCHAIN_UNIVERSAL_REQUEST_JSON"),
  );
  emit({
    schema: "kungfu-buildchain-v4-universal-workflow-inspection/v1",
    requestRoot: v4UniversalWorkflowRequestRoot(request),
    candidate: request.candidate,
    consumer: request.consumer,
    capability: request.capability,
  });
} else if (command === "admit") {
  emit(
    admitV4UniversalWorkflow({
      request: readJsonEnvironment("BUILDCHAIN_UNIVERSAL_REQUEST_JSON"),
      policy: readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_POLICY_JSON"),
      observedRefSha: process.env.BUILDCHAIN_UNIVERSAL_OBSERVED_SHA,
      observedConsumerRepository:
        process.env.BUILDCHAIN_UNIVERSAL_CONSUMER_REPOSITORY,
      observedConsumerSha: process.env.BUILDCHAIN_UNIVERSAL_CONSUMER_SHA,
      reviewEvidence: readJsonEnvironment(
        "BUILDCHAIN_UNIVERSAL_REVIEW_EVIDENCE_JSON",
      ),
      now: process.env.BUILDCHAIN_UNIVERSAL_OBSERVED_AT,
    }),
  );
} else if (command === "execute") {
  const request = validateV4UniversalWorkflowRequest(
    readJsonEnvironment("BUILDCHAIN_UNIVERSAL_REQUEST_JSON"),
  );
  const admission = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_JSON");
  const runtime = exactRuntime(admission);
  const execution = executeCandidate(request, admission);
  const result = {
    schema: "kungfu-buildchain-v4-universal-workflow-result/v1",
    status: execution.status,
    requestRoot: admission.requestRoot,
    runtime,
    capabilityRoot: admission.capabilityRoot,
    enginePath: "scripts/v4-universal-workflow-engine.mjs",
    ...execution,
  };
  emit({
    ...result,
    resultRoot: contentRoot("universal-workflow-result", result),
  });
} else if (command === "terminal") {
  const admission = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_JSON");
  const result = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_RESULT_JSON");
  assertResultLineage(admission, result);
  emit(
    completeV4UniversalWorkflow({
      admission,
      status: result.status,
      resultRoot: result.resultRoot,
    }),
  );
} else {
  fail(`unsupported command: ${command}`);
}

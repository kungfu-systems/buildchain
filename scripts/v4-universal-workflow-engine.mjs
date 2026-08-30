#!/usr/bin/env node
import crypto from "node:crypto";
import {
  admitV4UniversalWorkflow,
  completeV4UniversalWorkflow,
  validateV4UniversalWorkflowRequest,
  v4UniversalWorkflowRequestRoot,
} from "../packages/core/v4-universal-workflow-bootstrap.js";

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
  const engineSha = String(process.env.BUILDCHAIN_UNIVERSAL_ENGINE_SHA || "")
    .trim()
    .toLowerCase();
  if (engineSha !== runtime.sha)
    fail("candidate engine checkout does not match the admitted runtime SHA");
  if (request.capability.id !== "bootstrap-conformance")
    fail(`candidate capability is not implemented: ${request.capability.id}`);
  const result = {
    schema: "kungfu-buildchain-v4-universal-workflow-result/v1",
    status: "succeeded",
    requestRoot: admission.requestRoot,
    runtime,
    capabilityRoot: admission.capabilityRoot,
    enginePath: "scripts/v4-universal-workflow-engine.mjs",
    payload: request.payload,
  };
  emit({
    ...result,
    resultRoot: contentRoot("universal-workflow-result", result),
  });
} else if (command === "terminal") {
  const admission = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_JSON");
  const result = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_RESULT_JSON");
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

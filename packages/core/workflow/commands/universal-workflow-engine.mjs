#!/usr/bin/env node
import { admitUniversalWorkflow, completeUniversalWorkflow, validateUniversalWorkflowRequest, universalWorkflowRequestRoot } from "../universal-workflow-bootstrap.js";
import { executeAdmittedWorkflow, assertResultLineage } from "../engine/execution.js";
import { providerExecutionContext } from "../engine/provider-context.js";
import { installationRoot } from "../../runtime/installation-root.js";
import { fail } from "../engine/identity.js";
function readJsonEnvironment(name) {
  const source = process.env[name];
  if (!source) fail(`${name} is required`);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${name} is not valid JSON`, { cause: error });
  }
}
function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
const command = process.argv[2];
if (!command) fail("a command is required");

if (command === "inspect") {
  const request = validateUniversalWorkflowRequest(
    readJsonEnvironment("BUILDCHAIN_UNIVERSAL_REQUEST_JSON"),
  );
  emit({
    schema: "kungfu-buildchain-v4-universal-workflow-inspection/v1",
    requestRoot: universalWorkflowRequestRoot(request),
    mode: request.mode,
    candidate: request.candidate,
    consumer: request.consumer,
    capability: request.capability,
  });
} else if (command === "admit") {
  emit(
    admitUniversalWorkflow({
      request: readJsonEnvironment("BUILDCHAIN_UNIVERSAL_REQUEST_JSON"),
      policy: readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_POLICY_JSON"),
      observedRefSha: process.env.BUILDCHAIN_UNIVERSAL_OBSERVED_SHA,
      observedConsumerRepository:
        process.env.BUILDCHAIN_UNIVERSAL_CONSUMER_REPOSITORY,
      observedConsumerSha: process.env.BUILDCHAIN_UNIVERSAL_CONSUMER_SHA,
      observedConsumerWorkflowRef:
        process.env.BUILDCHAIN_UNIVERSAL_CONSUMER_WORKFLOW_REF,
      reviewEvidence: readJsonEnvironment(
        "BUILDCHAIN_UNIVERSAL_REVIEW_EVIDENCE_JSON",
      ),
      now: process.env.BUILDCHAIN_UNIVERSAL_OBSERVED_AT,
    }),
  );
} else if (command === "execute") {
  const request = validateUniversalWorkflowRequest(
    readJsonEnvironment("BUILDCHAIN_UNIVERSAL_REQUEST_JSON"),
  );
  const admission = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_JSON");
  emit(await executeAdmittedWorkflow(request, admission, {
    engineSha: process.env.BUILDCHAIN_UNIVERSAL_ENGINE_SHA, runtimeRoot: installationRoot(import.meta.url),
    ...providerExecutionContext({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "", mutationToken: process.env.BUILDCHAIN_PROMOTION_TOKEN || "", env: process.env }),
  }));
} else if (command === "terminal") {
  const admission = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_JSON");
  const result = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_RESULT_JSON");
  assertResultLineage(admission, result);
  emit(
    completeUniversalWorkflow({
      admission,
      status: result.status,
      resultRoot: result.resultRoot,
    }),
  );
} else {
  fail(`unsupported command: ${command}`);
}

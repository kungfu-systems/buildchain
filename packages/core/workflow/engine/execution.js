import { exactRuntime, contentRoot, fail } from "./identity.js";
import {
  universalWorkflowRequestRoot,
  validateUniversalWorkflowRequest,
} from "../universal-workflow-bootstrap.js";
import { createReleaseInvocation } from "../../release/release-invocation.js";
import { executeBootstrapConformance } from "./conformance.js";
import { executeReleasePromotion } from "./release-promotion.js";
async function capabilityResult(request, admission, context) {
  if (request.capability.id === "bootstrap-conformance")
    return executeBootstrapConformance(request, admission, context);
  if (request.capability.id === "release-invocation") {
    const release = createReleaseInvocation(request.payload);
    return {
      releaseInvocation: release.invocation,
      releaseRoots: release.roots,
    };
  }
  if (request.capability.id === "release-candidate-promote")
    return executeReleasePromotion(request, admission, context);
  fail(`candidate capability is not implemented: ${request.capability.id}`);
}
async function executeCandidate(request, admission, context) {
  const runtime = exactRuntime(admission);
  if (universalWorkflowRequestRoot(request) !== admission.requestRoot)
    fail("candidate request does not match the admitted request root");
  try {
    return {
      status: "succeeded",
      output: await capabilityResult(request, admission, context),
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

export async function executeAdmittedWorkflow(request, admission, context) {
  request = validateUniversalWorkflowRequest(request);
  const runtime = exactRuntime(admission);
  const execution = await executeCandidate(request, admission, context);
  const result = {
    schema: "kungfu-buildchain-v4-universal-workflow-result/v1",
    status: execution.status,
    requestRoot: admission.requestRoot,
    runtime,
    capabilityRoot: admission.capabilityRoot,
    enginePath: "packages/core/workflow/engine/execution.js",
    ...execution,
  };
  return {
    ...result,
    resultRoot: contentRoot("universal-workflow-result", result),
  };
}

export function assertResultLineage(admission, result) {
  const { resultRoot, ...body } = result || {};
  if (resultRoot !== contentRoot("universal-workflow-result", body)) fail("candidate result root mismatch");
  if (
    result?.schema !== "kungfu-buildchain-v4-universal-workflow-result/v1" ||
    result.requestRoot !== admission.requestRoot ||
    result.capabilityRoot !== admission.capabilityRoot ||
    result.runtime?.repository !== admission.runtime?.repository ||
    !["succeeded", "failed"].includes(result.status)
  )
    fail("candidate result does not match the admitted lineage");
}

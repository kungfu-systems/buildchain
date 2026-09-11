import { controllerCheckoutIdentity } from "../../observability/controller/identity.js";
import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import {
  planControllerEvidence,
  receiptControllerEvidence,
} from "../../observability/controller-evidence-io.js";
import { sourceProofRequest, sealSourceProof } from "./proof.js";

export function initializeSourceQualification(
  { workspace, runtimeRoot, runtimeRef, repository, request },
  execute = command,
) {
  const identities = controllerCheckoutIdentity(
    { workspace, runtimeRoot },
    execute,
  );
  const sourceSha = identities["source-sha"],
    runtimeSha = identities["runtime-sha"],
    contract = { contractDigest: identities["contract-digest"] };
  const plan = planControllerEvidence({
    registryPath: path.join(runtimeRoot, "dist/site/controller-registry.json"),
    outputPath: path.join(workspace, ".buildchain/controller/plan.json"),
    controllerId: "source-check",
    source: { repository, sha: sourceSha },
    runtime: {
      ref: runtimeRef,
      sha: runtimeSha,
      contractDigest: contract.contractDigest,
    },
    inputs: request,
    inputBoundary: "workflow-call",
  });
  return {
    identities: {
      "source-sha": sourceSha,
      "runtime-sha": runtimeSha,
      "contract-digest": contract.contractDigest,
    },
    plan,
  };
}
function aggregate(required) {
  if (required.includes("failure")) return "failure";
  if (required.includes("cancelled")) return "cancelled";
  return required.every((value) => value === "success") ? "success" : "skipped";
}
export function sourceQualificationStages({
  observations,
  request,
  sourceOutcome,
}) {
  const lifecycle = observations["lifecycle-check"]?.outputs || {};
  const reused =
    observations["source-proof"]?.outputs?.["verify-reuse"] === "true";
  const check = reused
    ? "success"
    : aggregate([
        lifecycle["validate-outcome"],
        lifecycle["selected-check-outcome"],
        observations["lifecycle-check"]?.outcome,
      ]);
  return [
    {
      id: "resolve-runtime",
      status: "success",
    },
    { id: "checkout-source", status: sourceOutcome },
    {
      id: "install",
      status: reused ? "success" : lifecycle["install-outcome"] || "skipped",
    },
    { id: "check", status: check },
    {
      id: "aggregate",
      status: aggregate([
        check,
        ...(request["upload-artifacts"]
          ? [observations["evidence-upload"]?.outcome]
          : []),
      ]),
    },
  ];
}
export function finalizeSourceQualification(
  {
    workspace,
    observations,
    request,
    sourceOutcome,
    identities,
    runtimeRef,
    repository,
    eventName,
    event,
    runId,
    qualifiedAt,
  },
  { seal = sealSourceProof, observe = () => {} } = {},
) {
  const stages = sourceQualificationStages({
    observations,
    request,
    sourceOutcome,
  });
  const reused =
    observations["source-proof"]?.outputs?.["verify-reuse"] === "true";
  const checked =
    stages.find((stage) => stage.id === "check").status === "success";
  const evidenceFiles = checked
    ? [
        {
          kind: "lifecycle-manifest",
          path: ".buildchain/artifacts/check-manifest.json",
        },
        {
          kind: "lifecycle-summary",
          path: ".buildchain/artifacts/check-summary.json",
        },
      ]
    : [];
  if (reused)
    evidenceFiles.push(
      {
        kind: "source-qualification-proof",
        path: ".buildchain/source-proof/source-proof.json",
      },
      {
        kind: "source-proof-reuse-decision",
        path: ".buildchain/source-proof/reuse-decision.json",
      },
    );
  const receipt = receiptControllerEvidence({
    planPath: path.join(workspace, ".buildchain/controller/plan.json"),
    outputPath: path.join(workspace, ".buildchain/controller/receipt.json"),
    stages,
    evidenceFiles: evidenceFiles.map((entry) => ({
      ...entry,
      path: path.join(workspace, entry.path),
    })),
    artifact: `buildchain-check-controller-receipt-${identities["source-sha"]}`,
    ...(!checked
      ? {
          reason: {
            code: "check-incomplete",
            summary: "Source check did not complete successfully",
          },
        }
      : {}),
  });
  observe(receipt);
  if (!receipt.qualifying)
    throw new Error(
      `Source-check controller receipt is not qualifying: ${receipt.status}`,
    );
  let proof;
  if (
    request.mode === "source" &&
    request["source-proof-reuse"] === true &&
    eventName === "pull_request"
  ) {
    proof = seal({
      ...sourceProofRequest({
        workspace,
        request,
        identities,
        runtimeRef,
        repository,
        protectedBase: event.pull_request.base.ref,
        sourceHead: identities["source-sha"],
        sourceWorkflowRunId: runId,
      }),
      qualifiedBase: event.pull_request.base.sha,
      qualifiedAt,
    });
  }
  return { receipt, proof };
}

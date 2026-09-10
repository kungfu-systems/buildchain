import path from "node:path";
import { createDeliveryWarrantService } from "./service.js";
import { GitHubTwoPhaseClient } from "../../providers/dev-delivery/candidate.js";
import { createIntegrationDeliveryProof } from "../dev-delivery-warrant.js";
import { writeJson } from "../native/files.js";
import { exactRoot } from "./values.js";
import {
  settlementMode,
  successorDispatchPayload,
  validateTerminalIntent,
} from "./terminal-policy.js";
export async function settleTerminalDelivery(
  {
    workspace,
    request,
    connection,
    observedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  },
  dependencies = {},
) {
  validateTerminalIntent(request);
  const service =
    dependencies.service ||
    createDeliveryWarrantService({ ...connection, branch: request.branch });
  const writeEvidence = (name, value) =>
    writeJson(path.join(workspace, ".buildchain/dev-delivery", name), value);
  const observation = await service.observe();
  writeEvidence("observation.json", observation);
  const mode = settlementMode(observation.observation, request);
  let evidenceRoot = "";
  let integrationProofRoot = "";
  if (mode === "active" || request.outcome !== "merged") {
    evidenceRoot = request.evidenceRoot;
    if (request.outcome === "merged") {
      const proof = createIntegrationDeliveryProof({
        repository: connection.repository,
        protectedBase: request.branch,
        sourceProofRoot: exactRoot(
          observation.observation.activeCandidate.sourceProofRoot,
          "Active source proof root",
        ),
        warrant: observation.observation.activeWarrant,
        currentBase: request.currentBase,
        replayTree: request.replayTree,
        mergeGroupHead: request.mergeGroupHead,
        mergeGroupTree: request.mergeGroupTree,
        requiredContextRoots: request.requiredContextRoots,
        verifiedAt: observedAt,
      });
      writeEvidence("integration-proof.json", proof);
      evidenceRoot = integrationProofRoot = proof.proofRoot;
    }
    exactRoot(evidenceRoot, "terminal closeout evidence");
  }
  const warrant = observation.observation.activeWarrant;
  const result = await service.settle({
    pullRequestNumber: request.pullRequestNumber,
    expectedSourceHead: request.expectedSourceHead,
    outcome: request.outcome,
    reason: request.reason,
    ...(mode === "active"
      ? {
          fencingToken: warrant.fencingToken,
          leaseGeneration: warrant.generation,
        }
      : {}),
    ...(evidenceRoot ? { evidenceRoot } : {}),
    execute: true,
  });
  writeEvidence("close.json", result);
  const outputs = {
    "integration-proof-root": integrationProofRoot,
    "close-receipt-root": result.receiptRoot,
    "final-state-root": result.after.stateRoot,
    "successor-wake-json": JSON.stringify(result.receipt.successorWake ?? null),
  };
  dependencies.onSettlement?.(outputs);
  if (result.receipt.successorWake != null) {
    const payload = successorDispatchPayload(result.receipt.successorWake);
    writeEvidence("successor-dispatch.json", payload);
    const provider =
      dependencies.provider || new GitHubTwoPhaseClient(connection);
    await provider.request(`/repos/${connection.repository}/dispatches`, {
      method: "POST",
      body: payload,
    });
  }
  return outputs;
}

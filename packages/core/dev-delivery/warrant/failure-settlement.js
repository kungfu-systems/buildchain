import path from "node:path";
import { requireValue } from "../../runtime/action-process.mjs";
import { readJson, writeJson } from "../native/files.js";
import { exactRoot } from "./values.js";
import { createDeliveryWarrantService } from "./service.js";
export function verifyFailureSettlement(result, settlement, stateRoot) {
  requireValue(
    result.ok === true &&
      result.receipt?.outcome === "terminal-failure" &&
      result.receipt.expectedOldStateRoot === stateRoot &&
      result.receipt.evidenceRoot === settlement.evidenceRoot,
    "Failure settlement receipt does not bind its exact evidence and prior state",
  );
  const candidate = result.observation?.candidates?.find(
    (item) =>
      item.pullRequestNumber === settlement.pullRequestNumber &&
      item.sourceHead === settlement.sourceHead &&
      item.terminal?.evidenceRoot === settlement.evidenceRoot,
  );
  requireValue(candidate, "Failure settlement terminal candidate is missing");
  for (const key of [
    "transferRoot",
    "finalizerBoundaryRoot",
    "nativeJobId",
    "sealJobId",
  ]) {
    requireValue(
      settlement[key] != null &&
        result.receipt[key] === settlement[key] &&
        candidate.terminal[key] === settlement[key],
      `Failure settlement ${key} readback drift`,
    );
  }
  requireValue(
    result.observation.activeWarrant === null,
    "Failure settlement retained an active Warrant",
  );
}
export async function settleNativeFailure(
  { workspace, repository, branch, token, apiUrl },
  service = createDeliveryWarrantService({ repository, branch, token, apiUrl }),
) {
  const settlement = readJson(
    path.join(workspace, ".buildchain/provider-failure-settlement.json"),
    "failure settlement",
  );
  const stateRoot = readJson(
    path.join(workspace, ".buildchain/provider-heartbeat-verification.json"),
    "heartbeat verification",
  ).latestStateRoot;
  for (const key of [
    "pullRequestNumber",
    "sourceHead",
    "fencingToken",
    "leaseGeneration",
    "evidenceRoot",
    "reason",
    "transferRoot",
    "finalizerBoundaryRoot",
    "nativeJobId",
    "sealJobId",
  ]) {
    requireValue(
      settlement[key] != null,
      `Failure settlement ${key} is missing`,
    );
  }
  exactRoot(stateRoot, "latest heartbeat state root");
  const result = await service.settle({
    pullRequestNumber: settlement.pullRequestNumber,
    expectedSourceHead: settlement.sourceHead,
    fencingToken: settlement.fencingToken,
    leaseGeneration: settlement.leaseGeneration,
    evidenceRoot: settlement.evidenceRoot,
    reason: settlement.reason,
    transferRoot: settlement.transferRoot,
    finalizerBoundaryRoot: settlement.finalizerBoundaryRoot,
    nativeJobId: settlement.nativeJobId,
    sealJobId: settlement.sealJobId,
    expectedOldStateRoot: stateRoot,
    outcome: "terminal-failure",
    execute: true,
  });
  writeJson(
    path.join(
      workspace,
      ".buildchain/finalizer-evidence/failure-settlement-result.json",
    ),
    result,
  );
  verifyFailureSettlement(result, settlement, stateRoot);
  return result;
}

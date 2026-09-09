import fs from "node:fs";
import { runtimeCommand } from "./io.mjs";
import { requireValue } from "../../runtime/action-process.mjs";

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
export function settleNativeFailure(env) {
  const settlement = JSON.parse(
    fs.readFileSync(".buildchain/provider-failure-settlement.json", "utf8"),
  );
  const state = JSON.parse(
    fs.readFileSync(".buildchain/provider-heartbeat-verification.json", "utf8"),
  ).latestStateRoot;
  const fields = {
    "pull-request": "pullRequestNumber",
    "expected-source-head": "sourceHead",
    "fencing-token": "fencingToken",
    "lease-generation": "leaseGeneration",
    "evidence-root": "evidenceRoot",
    reason: "reason",
    "transfer-root": "transferRoot",
    "finalizer-boundary-root": "finalizerBoundaryRoot",
    "native-job-id": "nativeJobId",
    "seal-job-id": "sealJobId",
  };
  for (const key of Object.values(fields))
    requireValue(
      settlement[key] != null,
      `Failure settlement ${key} is missing`,
    );
  runtimeCommand("dev-delivery-warrant", [
    "settle",
    "--repository",
    env.GITHUB_REPOSITORY,
    "--branch",
    env.TARGET_BRANCH,
    "--expected-old",
    state,
    ...Object.entries(fields).flatMap(([flag, key]) => [
      `--${flag}`,
      String(settlement[key]),
    ]),
    "--outcome",
    "terminal-failure",
    "--execute",
    "--output",
    ".buildchain/finalizer-evidence/failure-settlement-result.json",
  ]);
  verifyFailureSettlement(
    JSON.parse(
      fs.readFileSync(
        ".buildchain/finalizer-evidence/failure-settlement-result.json",
        "utf8",
      ),
    ),
    settlement,
    state,
  );
}

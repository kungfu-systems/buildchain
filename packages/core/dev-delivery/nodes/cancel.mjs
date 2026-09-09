import { pathToFileURL } from "node:url";
import { outputs, readEvidence, runtimeCommand } from "./io.mjs";
import {
  environmentArguments,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";

export function validateCancellation(env) {
  requireValue(
    /^dev\/v\d+\/v\d+\.\d+$/u.test(env.TARGET_BRANCH || ""),
    "target-branch must be a semver dev branch",
  );
  requireValue(
    ["closed:cancelled", "cancelled:cancelled", "dequeued:dequeued"].includes(
      `${env.EVENT_ACTION}:${env.OUTCOME}`,
    ),
    "event-action and outcome do not form a supported queued cancellation",
  );
  requireValue(
    /^[1-9]\d*$/u.test(env.EXPECTED_PR || ""),
    "expected-pr-number must be positive",
  );
  for (const key of ["EXPECTED_SOURCE_HEAD", "OBSERVED_SOURCE_HEAD"])
    requireValue(
      /^[0-9a-f]{40}$/u.test(env[key] || ""),
      "source heads must be exact lowercase Git SHAs",
    );
  for (const key of [
    "EXPECTED_CANDIDATE_ID",
    "EXPECTED_OLD_STATE_ROOT",
    "TERMINAL_EVIDENCE_ROOT",
  ])
    requireValue(
      /^sha256:[0-9a-f]{64}$/u.test(env[key] || ""),
      "candidate, expected-old, and evidence roots must be exact sha256 roots",
    );
}
export function cancelQueuedCandidate(env) {
  validateCancellation(env);
  runtimeCommand("dev-delivery-warrant", [
    "cancel-queued",
    ...environmentArguments(
      {
        repository: "GITHUB_REPOSITORY",
        branch: "TARGET_BRANCH",
        "candidate-id": "EXPECTED_CANDIDATE_ID",
        "pull-request": "EXPECTED_PR",
        "expected-source-head": "EXPECTED_SOURCE_HEAD",
        "observed-source-head": "OBSERVED_SOURCE_HEAD",
        "expected-old": "EXPECTED_OLD_STATE_ROOT",
        "event-action": "EVENT_ACTION",
        outcome: "OUTCOME",
        "evidence-root": "TERMINAL_EVIDENCE_ROOT",
        reason: "REASON",
      },
      env,
    ),
    "--execute",
    "--output",
    ".buildchain/dev-delivery/cancel.json",
  ]);
  const result = readEvidence("cancel.json");
  outputs({
    "cancellation-action": result.receipt.action,
    "cancellation-receipt-root": result.receiptRoot,
    "final-state-root": result.after.stateRoot,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({
    intent: validateCancellation,
    cancel: cancelQueuedCandidate,
  });

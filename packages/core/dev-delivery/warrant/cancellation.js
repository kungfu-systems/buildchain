import path from "node:path";
import { requireValue } from "../../runtime/action-process.mjs";
import { writeJson } from "../native/files.js";
import { createDeliveryWarrantService } from "./service.js";
export function validateQueuedCancellation(request) {
  requireValue(
    /^dev\/v\d+\/v\d+\.\d+$/u.test(request.branch || ""),
    "target-branch must be a semver dev branch",
  );
  requireValue(
    ["closed:cancelled", "cancelled:cancelled", "dequeued:dequeued"].includes(
      `${request.eventAction}:${request.outcome}`,
    ),
    "event-action and outcome do not form a supported queued cancellation",
  );
  requireValue(
    /^[1-9]\d*$/u.test(request.pullRequestNumber || ""),
    "expected-pr-number must be positive",
  );
  for (const key of ["expectedSourceHead", "observedSourceHead"])
    requireValue(
      /^[0-9a-f]{40}$/u.test(request[key] || ""),
      "source heads must be exact lowercase Git SHAs",
    );
  for (const key of ["candidateId", "expectedOldStateRoot", "evidenceRoot"])
    requireValue(
      /^sha256:[0-9a-f]{64}$/u.test(request[key] || ""),
      "candidate, expected-old, and evidence roots must be exact sha256 roots",
    );
}
export async function cancelQueuedDelivery(
  { workspace, request, connection },
  service = createDeliveryWarrantService({
    ...connection,
    branch: request.branch,
  }),
) {
  validateQueuedCancellation(request);
  const result = await service.cancelQueued({ ...request, execute: true });
  writeJson(
    path.join(workspace, ".buildchain/dev-delivery/cancel.json"),
    result,
  );
  return {
    "cancellation-action": result.receipt.action,
    "cancellation-receipt-root": result.receiptRoot,
    "final-state-root": result.after.stateRoot,
  };
}

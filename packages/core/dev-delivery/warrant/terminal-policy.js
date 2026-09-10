import { requireValue } from "../../runtime/action-process.mjs";
export function settlementMode(
  observation,
  { pullRequestNumber, expectedSourceHead },
) {
  const warrant = observation.activeWarrant;
  if (!warrant) return "inactive";
  const candidate = observation.activeCandidate;
  requireValue(
    warrant.pullRequestNumber === pullRequestNumber &&
      warrant.sourceHead === expectedSourceHead &&
      candidate?.pullRequestNumber === pullRequestNumber &&
      candidate.sourceHead === expectedSourceHead &&
      candidate.candidateId === warrant.candidateId,
    "Active terminal Warrant does not bind the exact requested candidate",
  );
  return "active";
}
export function successorDispatchPayload(wake) {
  const candidate = { ...wake };
  if (
    Number.isSafeInteger(candidate.sourceWorkflowRunId) &&
    candidate.sourceWorkflowRunId > 0
  )
    candidate.affectedPaths = [];
  const payload = {
    event_type: "buildchain-dev-delivery-wake",
    client_payload: { candidate },
  };
  requireValue(
    JSON.stringify(payload.client_payload).length <= 65535,
    "Successor dispatch exceeds the provider payload limit",
  );
  return payload;
}
export function validateTerminalIntent({
  outcome,
  branch,
  expectedSourceHead,
}) {
  requireValue(
    ["merged", "terminal-failure", "dequeued", "cancelled"].includes(outcome),
    "unsupported terminal Warrant outcome",
  );
  requireValue(
    /^dev\/v\d+\/v\d+\.\d+$/u.test(branch || ""),
    "target-branch must be a semver dev branch",
  );
  requireValue(
    /^[0-9a-f]{40}$/u.test(expectedSourceHead || ""),
    "expected-head-sha must be an exact lowercase Git SHA",
  );
}

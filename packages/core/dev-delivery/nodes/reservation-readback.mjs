import { isDeepStrictEqual } from "node:util";
import { requireValue } from "../../runtime/action-process.mjs";

export function verifyReservationReadback(result) {
  const warrant = result.observation?.activeWarrant;
  const candidate = result.observation?.activeCandidate;
  requireValue(
    result.schema === "kungfu.buildchain.dev-delivery-command-result/v1" &&
      result.mode === "execute",
    "Warrant reservation is not an executed command result",
  );
  requireValue(
    /^[0-9a-f]{40}$/u.test(result.after?.commitSha || "") &&
      /^sha256:[0-9a-f]{64}$/u.test(result.after?.stateRoot || "") &&
      result.after.stateRoot === result.observation?.stateRoot,
    "Warrant reservation state readback drift",
  );
  requireValue(
    warrant && isDeepStrictEqual(result.warrant, warrant),
    "Warrant reservation active readback drift",
  );
  requireValue(
    ["ready", "provisional", "qualified"].includes(warrant.phase),
    "Active Warrant must declare its current phase",
  );
  requireValue(
    candidate &&
      candidate.candidateId === warrant.candidateId &&
      candidate.pullRequestNumber === warrant.pullRequestNumber &&
      candidate.sourceHead === warrant.sourceHead,
    "Warrant reservation candidate identity drift",
  );
  if (warrant.phase === "ready")
    requireValue(
      candidate.deliveryClass === "non-native-fast" &&
        !candidate.environmentRoot &&
        !candidate.nativeCommandContract,
      "Ready Warrant cannot skip required native qualification",
    );
  if (warrant.phase === "qualified") {
    requireValue(
      candidate.status === "qualified",
      "Qualified Warrant candidate status drift",
    );
    for (const key of [
      "nativeProofRoot",
      "nativeProofReuseRoot",
      "qualificationReceiptRoot",
    ])
      requireValue(
        /^sha256:[0-9a-f]{64}$/u.test(warrant[key] || ""),
        `Qualified Warrant ${key} is missing`,
      );
  }
  return warrant;
}
export function reservationOutputs(result, warrant) {
  return {
    "handoff-required": "false",
    "already-qualified": String(warrant.phase !== "provisional"),
    "warrant-receipt-root": result.receiptRoot,
    "warrant-state-root": result.after.stateRoot,
    "warrant-state-commit": result.after.commitSha,
    ...(warrant.phase === "qualified"
      ? {
          "native-proof-root": warrant.nativeProofRoot,
          "decision-root": warrant.nativeProofReuseRoot,
          "qualification-receipt-root": warrant.qualificationReceiptRoot,
        }
      : {}),
  };
}

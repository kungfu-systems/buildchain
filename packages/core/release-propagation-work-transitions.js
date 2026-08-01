import {
  normalizeWorkAuthority,
  normalizeTypedReference,
} from "./release-propagation-work-control.js";
import { FAILURE_DISPOSITIONS } from "./release-propagation-work-constants.js";
import {
  RELEASE_PROPAGATION_WORK_STAGES,
  assertExpectedWorkRoot,
  nextWorkAction,
  normalizeStageReceipt,
  successorWork,
  verifyReleasePropagationWork,
  withWorkRoot,
} from "./release-propagation-work.js";

export function claimReleasePropagationWork({ work, expectedWorkRoot, authority } = {}) {
  const current = verifyReleasePropagationWork(work).work;
  assertExpectedWorkRoot(current, expectedWorkRoot);
  if (current.state.lifecycle !== "paused" || current.state.nextAction.action !== "claim") {
    throw new Error("only paused capture-only propagation work can be claimed");
  }
  const normalizedAuthority = normalizeWorkAuthority(authority, current.workControl.familyState);
  if (normalizedAuthority.mode !== "execute") {
    throw new Error("claim requires execute authority");
  }
  const successor = successorWork(current);
  successor.authority = normalizedAuthority;
  successor.intent.publishToProduction = normalizedAuthority.publishToProduction;
  successor.state.lifecycle = "ready";
  successor.state.nextAction = nextWorkAction(successor, "record", successor.state.currentStage);
  return verifyReleasePropagationWork(withWorkRoot(successor)).work;
}

export function recordReleasePropagationStage({ work, expectedWorkRoot, receipt } = {}) {
  const current = verifyReleasePropagationWork(work).work;
  assertExpectedWorkRoot(current, expectedWorkRoot);
  if (current.authority.mode !== "execute") {
    throw new Error("propagation work must be claimed before recording execution");
  }
  if (!new Set(["ready", "retryable-failure"]).has(current.state.lifecycle)) {
    throw new Error(`propagation work cannot record from lifecycle ${current.state.lifecycle}`);
  }
  if (current.state.currentStage === "complete") {
    throw new Error("the complete stage requires a Work Control completion decision");
  }
  const normalizedReceipt = normalizeStageReceipt(receipt, {
    workId: current.workId,
    expectedWorkRoot: current.contentRoot,
    expectedStage: current.state.currentStage,
    allowedOutcomes: new Set(["success", "failure"]),
  });
  const successor = successorWork(current);
  successor.stageReceipts.push(normalizedReceipt);
  successor.state.recoveryCursor.lastReceiptRoot = normalizedReceipt.receiptRoot;
  if (normalizedReceipt.outcome === "failure") {
    const disposition = FAILURE_DISPOSITIONS.get(normalizedReceipt.failure.class);
    successor.state.lifecycle = disposition === "retry" ? "retryable-failure" : disposition;
    successor.state.nextAction = disposition === "retry"
      ? nextWorkAction(successor, "repair", successor.state.currentStage, normalizedReceipt.failure.code)
      : nextWorkAction(successor, disposition, successor.state.currentStage, normalizedReceipt.failure.code);
    return verifyReleasePropagationWork(withWorkRoot(successor)).work;
  }
  const nextIndex = successor.state.recoveryCursor.index + 1;
  successor.state.recoveryCursor = {
    stage: RELEASE_PROPAGATION_WORK_STAGES[nextIndex],
    index: nextIndex,
    attempt: 1,
    lastReceiptRoot: normalizedReceipt.receiptRoot,
  };
  successor.state.currentStage = RELEASE_PROPAGATION_WORK_STAGES[nextIndex];
  successor.state.lifecycle = "ready";
  successor.state.nextAction = nextWorkAction(successor, "record", successor.state.currentStage);
  return verifyReleasePropagationWork(withWorkRoot(successor)).work;
}

export function repairReleasePropagationWork({ work, expectedWorkRoot, receipt } = {}) {
  const current = verifyReleasePropagationWork(work).work;
  assertExpectedWorkRoot(current, expectedWorkRoot);
  if (current.state.lifecycle !== "retryable-failure") {
    throw new Error("only retryable propagation failures can be repaired automatically");
  }
  const normalizedReceipt = normalizeStageReceipt(receipt, {
    workId: current.workId,
    expectedWorkRoot: current.contentRoot,
    expectedStage: current.state.currentStage,
    allowedOutcomes: new Set(["repair"]),
  });
  const successor = successorWork(current);
  successor.stageReceipts.push(normalizedReceipt);
  successor.state.lifecycle = "ready";
  successor.state.recoveryCursor.attempt += 1;
  successor.state.recoveryCursor.lastReceiptRoot = normalizedReceipt.receiptRoot;
  successor.state.nextAction = nextWorkAction(successor, "record", successor.state.currentStage);
  return verifyReleasePropagationWork(withWorkRoot(successor)).work;
}

export function completeReleasePropagationWork({
  work,
  expectedWorkRoot,
  receipt,
  completionDecision,
} = {}) {
  const current = verifyReleasePropagationWork(work).work;
  assertExpectedWorkRoot(current, expectedWorkRoot);
  if (current.state.currentStage !== "complete" || current.state.lifecycle !== "ready") {
    throw new Error("propagation work is not ready for completion");
  }
  const decision = normalizeTypedReference(completionDecision, {
    kind: "decision",
    status: "accepted",
    factWorld: current.workControl.familyState.factWorld,
    cutRoot: current.workControl.familyState.cutRoot,
    label: "completionDecision",
  });
  const normalizedReceipt = normalizeStageReceipt(receipt, {
    workId: current.workId,
    expectedWorkRoot: current.contentRoot,
    expectedStage: "complete",
    allowedOutcomes: new Set(["success"]),
  });
  const successor = successorWork(current);
  successor.stageReceipts.push(normalizedReceipt);
  successor.completionDecision = decision;
  successor.state.lifecycle = "complete";
  successor.state.recoveryCursor.lastReceiptRoot = normalizedReceipt.receiptRoot;
  successor.state.nextAction = nextWorkAction(successor, "none", "", "production-visible-and-work-control-accepted");
  return verifyReleasePropagationWork(withWorkRoot(successor)).work;
}


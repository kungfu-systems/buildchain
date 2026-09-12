import {
  recordDigest,
  validateRuntime,
} from "../../release/discussion/envelope.js";
import { object, text, choice } from "../../consumer/contract/shape.js";
import { RECOVERY_ENTRY } from "../../consumer/contract/entries.js";

export const PIPELINE_RECOVERY_PLAN = "buildchain.pipeline-recovery-plan/v1";
const ROOT = /^sha256:[0-9a-f]{64}$/u;

export function recoveryRequestKey(predecessor, runtime, entry) {
  text(predecessor, "predecessor", /^attempt-[0-9a-f]{64}$/u);
  object(runtime, ["repository", "sha", "readerDigest"]);
  validateRuntime(runtime);
  object(entry, ["repository", "workflow", "sha"]);
  if (
    runtime.repository !== "kungfu-systems/buildchain" ||
    entry.repository !== "kungfu-systems/buildchain" ||
    entry.workflow !== RECOVERY_ENTRY ||
    !/^[0-9a-f]{40}$/u.test(entry.sha)
  )
    throw new Error(
      "Recovery requires an exact canonical runtime and recovery entry",
    );
  return `recover:${recordDigest({ predecessor, runtime, entry })}`;
}

// Provider adapters must qualify each node before this pure plan is admitted.
// A reused node names its actual evidence; omission never means rebuild-all.
export function planPipelineRecovery({
  observed,
  runtime,
  entry,
  nodes,
  evidenceRoot,
}) {
  const current = observed.history.at(-1);
  if (!current || observed.status === "complete" || !observed.missing.length)
    throw new Error(
      "Completed or absent attempts have no remaining recovery work",
    );
  if (!["failure", "cancelled", "superseded"].includes(observed.status))
    throw new Error(
      "Recovery requires terminal predecessor execution and ownership",
    );
  text(evidenceRoot, "recovery.evidenceRoot", ROOT);
  if (
    !Array.isArray(nodes) ||
    nodes.length !== observed.intent.expectedNodes.length
  )
    throw new Error("Recovery must explicitly classify every required node");
  let pending = false;
  for (const [index, node] of nodes.entries()) {
    object(node, ["phase", "operation", "reason", "evidenceRoots"]);
    if (node.phase !== observed.intent.expectedNodes[index])
      throw new Error("Recovery node order differs from the original intent");
    choice(
      node.operation,
      ["reuse", "reconcile", "execute"],
      "recovery.operation",
    );
    text(node.reason, "recovery.reason");
    if (
      node.reason.length > 1000 ||
      !Array.isArray(node.evidenceRoots) ||
      node.evidenceRoots.length > 100 ||
      new Set(node.evidenceRoots).size !== node.evidenceRoots.length
    )
      throw new Error("Recovery node evidence exceeds its exact bound");
    node.evidenceRoots.forEach((root) =>
      text(root, "recovery.nodeEvidence", ROOT),
    );
    if (node.operation === "reuse" && (!node.evidenceRoots.length || pending))
      throw new Error(
        "Only an independently qualified contiguous prefix can be replayed",
      );
    if (node.operation !== "reuse") pending = true;
  }
  const body = {
    schema: PIPELINE_RECOVERY_PLAN,
    intent: observed.intent.id,
    predecessor: observed.attempt,
    predecessorHead: observed.head,
    generation: current.generation.id,
    sourceRoot: recordDigest(current.generation.source),
    runtime,
    entry,
    requestKey: recoveryRequestKey(observed.attempt, runtime, entry),
    nodes: structuredClone(nodes),
    evidenceRoot,
  };
  return { ...body, root: recordDigest(body) };
}

export function verifyRecoveryPlan(plan, observed) {
  object(plan, [
    "schema",
    "intent",
    "predecessor",
    "predecessorHead",
    "generation",
    "sourceRoot",
    "runtime",
    "entry",
    "requestKey",
    "nodes",
    "evidenceRoot",
    "root",
  ]);
  if (
    recordDigest(plan) !==
    recordDigest(
      planPipelineRecovery({
        observed,
        runtime: plan.runtime,
        entry: plan.entry,
        nodes: plan.nodes,
        evidenceRoot: plan.evidenceRoot,
      }),
    )
  )
    throw new Error(
      "Recovery plan changed its exact predecessor or qualified evidence",
    );
  return plan;
}

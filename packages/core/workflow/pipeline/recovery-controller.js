import {
  recoveryExecution,
  admitRecoverySource,
  recoveryPredecessorRuns,
} from "./recovery-admission.js";
import {
  selectRecoveryAttempt,
  openRecoveryAttempt,
  retainedRecoveryPlan,
} from "./recovery-session.js";
import { qualifyRecoveryBuild } from "./recovery-build.js";
import { observeRecoveryOwnership } from "./recovery-ownership.js";
import {
  terminateRecoveryPredecessor,
  recoveryNodePlan,
  replayRecoveryAdmission,
} from "./recovery-transition.js";
import { qualifyRecoveryIntegration } from "./recovery-integration.js";
import { beginRecoveryBuild } from "./recovery-build-control.js";

async function duplicateRecovery(session, host) {
  await retainedRecoveryPlan(session, host);
  // Root CAS can commit before the immutable lookup index acknowledgement.
  await host.index.retain(session.intent, session.observed.attempt);
  await host.project(session);
  return {
    operation: "wait",
    attempt: session.observed.attempt,
    reason: `Recovery already selected this successor (${session.observed.status}); any further recovery must select its exact attempt`,
  };
}

export async function controlPipelineRecovery(attempt, definitionSha, host) {
  const execution = await recoveryExecution(host, definitionSha);
  let session = await selectRecoveryAttempt(attempt, host, execution.entry);
  if (session.duplicate) return duplicateRecovery(session, host);
  const admitted = await admitRecoverySource(session, execution, host);
  const executions = await recoveryPredecessorRuns(session, host);
  if (!executions.terminal) {
    await host.project(session);
    return {
      operation: "wait",
      attempt,
      reason:
        "Predecessor provider executions are still active; wait for completion or cancel their actual runs before recovery",
    };
  }
  const build = await qualifyRecoveryBuild(session, admitted.source, host);
  // Post-merge recovery must qualify the retained publication transaction before
  // opening a successor. Its adapter preserves signed bytes and completed effects.
  const integration = admitted.admission.live.merged
    ? await qualifyRecoveryIntegration(session, admitted.admission, host)
    : null;
  const publication =
    admitted.admission.live.merged &&
    session.intent.expectedNodes.includes("publish")
      ? await host.recoverPublication(session, admitted, execution)
      : null;
  const ownership = await observeRecoveryOwnership(session, executions, host);
  session = await terminateRecoveryPredecessor(
    session,
    executions,
    ownership,
    host,
  );
  const evidence = {
    admitted,
    executions,
    ownership,
    build,
    publication,
    integration,
  };
  const plan = recoveryNodePlan(session, evidence, execution.entry, host);
  session = await openRecoveryAttempt(session, plan, host, evidence);
  await replayRecoveryAdmission(session, host);
  const context = await beginRecoveryBuild(session, host);
  await host.project(session);
  if (!context)
    return {
      operation: "wait",
      attempt: session.observed.attempt,
      reason: "Recovery build already has an execution owner",
    };
  return {
    operation: context.platforms.length ? "build" : "qualify-build",
    context,
    attempt: context.attempt,
    reason: build.reason,
  };
}

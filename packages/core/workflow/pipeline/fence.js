import { recordDigest } from "../../release/discussion/envelope.js";

export const STOP_REQUESTED = "pipeline-stop-requested:";

// Credentialed controllers observe this source/attempt fence before Warrant
// renewal and finalization. The isolated native job receives no read token.
// Stopping renewal does not release its Warrant: provider-terminal native/seal
// evidence is still required before a separate controller can transfer ownership.
export function assertPipelineExecution(observed, expected) {
  if (
    observed.attempt !== expected.attempt ||
    observed.generation !== expected.generation ||
    observed.intent.id !== expected.intent
  )
    throw new Error("Pipeline execution lost its current attempt fence");
  const current = observed.history.at(-1);
  if (
    !current ||
    recordDigest(current.generation.source) !== expected.sourceRoot
  )
    throw new Error("Pipeline execution source fence changed");
  if (
    ["cancelled", "superseded", "failure", "complete"].includes(
      observed.status,
    ) ||
    Object.values(observed.phases).some((record) =>
      record.payload.reason.startsWith(STOP_REQUESTED),
    )
  )
    throw new Error("Pipeline execution has a terminal or requested stop");
  return true;
}

export function pipelineHeartbeat(journal, expected, warrantHeartbeat) {
  return async () => {
    assertPipelineExecution(await journal.read(), expected);
    await warrantHeartbeat();
    // Catch cancellation that raced the provider heartbeat without granting
    // another controller interval from the stale pre-heartbeat read.
    assertPipelineExecution(await journal.read(), expected);
  };
}

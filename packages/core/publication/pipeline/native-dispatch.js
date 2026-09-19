import { setTimeout } from "node:timers/promises";
import { recordDigest } from "../../release/discussion/envelope.js";

// The immutable pending record precedes POST. An unknown response, timeout or
// resumed controller only observes that operation; it never dispatches again.
export async function executePipelineNativeDispatch({
  operation,
  journal,
  provider,
  wait = setTimeout,
  maximumReads = 721,
}) {
  if (
    !Number.isSafeInteger(maximumReads) ||
    maximumReads < 1 ||
    maximumReads > 721
  )
    throw new Error("Native dispatch polling exceeds its two-hour bound");
  const operationRoot = recordDigest(operation);
  const prefix = `publication/native-dispatch/${operationRoot.slice(7)}`;
  await journal.fence();
  const prior = await journal.materials(`${prefix}/`);
  if (
    prior.some(
      (value) =>
        value.operationRoot !== operationRoot ||
        recordDigest(value.operation) !== operationRoot,
    )
  )
    throw new Error("Native dispatch recovery changed its immutable operation");
  const executions = prior.filter((value) => value.runId !== undefined);
  let known = executions[0];
  if (
    executions.some(
      (value) =>
        value.runId !== known.runId || value.runAttempt !== known.runAttempt,
    )
  )
    throw new Error("Native dispatch recovery has conflicting executions");
  let observed = await provider.observe(operation, known);
  if (!prior.length) {
    await journal.fence();
    await journal.record(prefix, {
      schema: "buildchain.pipeline-native-dispatch/v1",
      operationRoot,
      operation,
      state: "pending",
    });
    if (observed.state === "absent") {
      await journal.fence();
      try {
        await provider.dispatch(operation);
      } catch {
        /* An ambiguous POST is resolved only by independent readback. */
      }
    }
  }
  const completed = prior.filter((value) => value.state === "completed");
  for (let attempt = 0; attempt < maximumReads; attempt++) {
    if (attempt) await wait(10000);
    await journal.fence();
    observed = await provider.observe(operation, known);
    if (observed.state !== "absent" && !known) {
      known = {
        schema: "buildchain.pipeline-native-dispatch/v1",
        operationRoot,
        operation,
        state: "observed",
        runId: observed.runId,
        runAttempt: observed.runAttempt,
      };
      await journal.fence();
      await journal.record(prefix, known);
    }
    if (observed.state !== "completed") continue;
    if (observed.conclusion !== "success")
      throw new Error("Native signing authority did not complete successfully");
    const value = {
      schema: "buildchain.pipeline-native-dispatch/v1",
      operationRoot,
      operation,
      state: "completed",
      runId: observed.runId,
      runAttempt: observed.runAttempt,
    };
    if (
      completed.some(
        (previous) => recordDigest(previous) !== recordDigest(value),
      )
    )
      throw new Error("Native authority execution changed after completion");
    await journal.fence();
    await journal.record(prefix, value);
    return value;
  }
  throw new Error(
    "Native signing outcome is unresolved; recovery must observe the retained dispatch without repeating it",
  );
}

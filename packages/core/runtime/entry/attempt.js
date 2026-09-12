import { validateRuntime } from "../../release/discussion/envelope.js";
import { selectExecutionRuntime } from "./selection.js";

// This input is read from the canonical current attempt, never from workflow
// inputs. Continuation retains its admitted repair without reopening an override.
export async function selectAttemptRecoveryRuntime(recovery, provider) {
  validateRuntime(recovery.runtime);
  if (
    !/^attempt-[0-9a-f]{64}$/u.test(recovery.attempt || "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(recovery.recordRoot || "") ||
    recovery.runtime.repository !== "kungfu-systems/buildchain"
  )
    throw new Error(
      "Attempt runtime continuation requires its canonical recovery admission",
    );
  const selected = await selectExecutionRuntime(
    { runtimeRef: recovery.runtime.sha },
    {
      ...provider,
      authorize: (input) =>
        provider.authorize({ ...input, origin: "attempt-recovery" }),
    },
  );
  return { ...selected, origin: "attempt-recovery", recovery };
}

import { pipelineIntent } from "../attempt/identity.js";
import { atomicAttemptJournal } from "../attempt/journal.js";
import { pipelineProgress } from "./progress.js";

export function pipelinePhases(operation) {
  if (operation === "develop")
    return ["admission", "build", "review", "warrant", "merge"];
  if (["alpha", "stable", "major"].includes(operation))
    return [
      "admission",
      "build",
      "review",
      "merge",
      "publish",
      "distribution",
      "next-development",
    ];
  throw new Error("Unsupported pipeline channel operation");
}

export async function openPipelineSession(
  { admission, runtime, writer, successor = false },
  { provider, index },
) {
  if (!admission.eligible || !admission.route || !admission.live.source)
    throw new Error(
      "A new pipeline attempt requires an admitted source and channel",
    );
  const { live } = admission;
  const retained = await provider.lookup(
    live.source.repository,
    live.pullRequest,
    admission.route.to,
  );
  const intent =
    retained?.snapshot.intent ||
    pipelineIntent({
      repository: live.source.repository,
      repositoryId: admission.repositoryId,
      pullRequest: live.pullRequest,
      targetBranch: admission.route.to,
      phases: pipelinePhases(admission.route.operation),
      runtime,
    });
  const journal = atomicAttemptJournal(provider, intent);
  const progress = pipelineProgress(journal, { intent, writer, runtime });
  const observed = await progress.open(live.source, live.baseCommit, {
    successor,
  });
  await index.retain(intent, observed.attempt);
  return { intent, journal, progress, observed };
}

export async function resumePipelineSession(
  { attempt, runtime, writer },
  { provider, index },
) {
  const retained = await index.resolve(attempt);
  const intent = retained.snapshot.intent;
  const journal = atomicAttemptJournal(provider, intent);
  const observed = await journal.read();
  if (observed.attempt !== attempt)
    throw new Error(
      "Selected attempt is historical; it cannot regain current write authority",
    );
  return {
    intent,
    journal,
    observed,
    progress: pipelineProgress(journal, { intent, writer, runtime }),
  };
}

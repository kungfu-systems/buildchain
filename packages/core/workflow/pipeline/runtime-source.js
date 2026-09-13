import { githubAttemptJournal } from "../../providers/github/attempt-journal.js";
import { githubAttemptIndex } from "../../providers/github/attempt-index.js";
import { githubJsonClient } from "../../providers/github/json-client.js";
import { readBusinessAttempt } from "../attempt/reader.js";

async function retainedAttempt(attempt, repository, token, lookup) {
  const request = githubJsonClient({
    token,
    userAgent: "buildchain-pipeline-runtime-source",
  });
  const index =
    lookup ||
    githubAttemptIndex(request, githubAttemptJournal(request), repository);
  const loaded = await index.resolve(attempt);
  const observed = readBusinessAttempt(loaded.snapshot);
  if (observed.intent.repository !== repository)
    throw new Error(
      "Foreign pipeline selector cannot select the runtime source",
    );
  return observed;
}

function sourceOf(observed) {
  const current = observed.history.at(-1);
  return {
    repository: observed.intent.repository,
    sha: current.generation.source.commit,
    ref: `refs/pull/${observed.intent.source.pullRequest}/head`,
  };
}

export async function pipelineRuntimeSource(
  attempt,
  repository,
  token,
  lookup,
) {
  return (await pipelineRuntimeContinuation(attempt, repository, token, lookup))
    .source;
}

export async function pipelineRuntimeContinuation(
  attempt,
  repository,
  token,
  lookup,
) {
  const observed = await retainedAttempt(attempt, repository, token, lookup);
  if (observed.attempt !== attempt)
    throw new Error(
      "Historical or foreign pipeline selector cannot select the runtime source",
    );
  const current = observed.history.at(-1);
  return {
    source: sourceOf(observed),
    recovery: current.identity.requestKey.startsWith("recover:")
      ? {
          attempt,
          recordRoot: current.events[0].id,
          runtime: current.events[0].runtime,
        }
      : null,
  };
}

// Read-only bootstrap can locate a directly recovered successor after a lost
// response. The credentialed recovery controller independently admits its exact
// entry/runtime request before any replay or provider effect.
export async function pipelineRecoveryRuntimeSource(
  attempt,
  repository,
  token,
  lookup,
) {
  return (
    await pipelineRecoveryContinuation(attempt, repository, token, lookup)
  ).source;
}

export async function pipelineRecoveryContinuation(
  attempt,
  repository,
  token,
  lookup,
) {
  const observed = await retainedAttempt(attempt, repository, token, lookup);
  const current = observed.history.at(-1);
  const selected = observed.history.find(
    (item) => item.identity.id === attempt,
  );
  if (
    !selected ||
    (observed.attempt !== attempt &&
      (current.identity.predecessor !== attempt ||
        !current.identity.requestKey.startsWith("recover:") ||
        current.generation.id !== selected.generation.id))
  )
    throw new Error(
      "Historical recovery selector is not the direct current recovery predecessor",
    );
  return {
    source: sourceOf(observed),
    recovery: current.identity.requestKey.startsWith("recover:")
      ? {
          attempt: current.identity.id,
          recordRoot: current.events[0].id,
          runtime: current.events[0].runtime,
        }
      : null,
  };
}

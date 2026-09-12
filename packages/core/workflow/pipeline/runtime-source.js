import { githubAttemptJournal } from "../../providers/github/attempt-journal.js";
import { githubAttemptIndex } from "../../providers/github/attempt-index.js";
import { githubJsonClient } from "../../providers/github/json-client.js";
import { readBusinessAttempt } from "../attempt/reader.js";

export async function pipelineRuntimeSource(
  attempt,
  repository,
  token,
  lookup,
) {
  const request = githubJsonClient({
    token,
    userAgent: "buildchain-pipeline-runtime-source",
  });
  const index =
    lookup ||
    githubAttemptIndex(request, githubAttemptJournal(request), repository);
  const loaded = await index.resolve(attempt);
  const observed = readBusinessAttempt(loaded.snapshot);
  if (observed.attempt !== attempt || observed.intent.repository !== repository)
    throw new Error(
      "Historical or foreign pipeline selector cannot select the runtime source",
    );
  const current = observed.history.at(-1);
  return {
    repository,
    sha: current.generation.source.commit,
    ref: `refs/pull/${observed.intent.source.pullRequest}/head`,
  };
}

import { githubJsonClient } from "../../providers/github/json-client.js";
import { githubAttemptJournal } from "../../providers/github/attempt-journal.js";
import { readBusinessAttempt } from "../attempt/reader.js";
import { pipelineCandidateRoot } from "./reconcile.js";

export async function wakePipelineCandidate(candidate, connection, ports = {}) {
  const repository = connection.repository;
  const request =
    ports.request ||
    githubJsonClient({
      token: connection.token,
      userAgent: "buildchain-pipeline-wake",
    });
  const provider = ports.provider || githubAttemptJournal(request);
  const branch = candidate.protectedBase || connection.branch;
  const loaded = await provider.lookup(
    repository,
    candidate.pullRequestNumber,
    branch,
  );
  if (!loaded)
    throw new Error("Warrant handoff has no admitted business intent");
  const observed = readBusinessAttempt(loaded.snapshot);
  const current = { ...observed.history.at(-1), intent: observed.intent };
  if (
    candidate.sourceHead !== current.generation.source.commit ||
    candidate.sourceRoot !== pipelineCandidateRoot(current)
  )
    throw new Error("Warrant handoff changed its admitted business attempt");
  await request(`/repos/${repository}/dispatches`, {
    method: "POST",
    body: {
      event_type: "buildchain-attempt-wake",
      client_payload: { attempt: observed.attempt },
    },
  });
  return observed.attempt;
}

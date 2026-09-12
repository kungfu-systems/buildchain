import {
  createIntent,
  recordDigest,
} from "../../release/discussion/envelope.js";
import {
  object,
  text,
  list,
  choice,
  unique,
  relativePath,
} from "../../consumer/contract/shape.js";
import { CONSUMER_CONTRACT } from "../../consumer/contract/plan.js";

export const PIPELINE_PHASES = [
  "admission",
  "build",
  "review",
  "warrant",
  "merge",
  "publish",
  "distribution",
  "next-development",
];
export const SOURCE_GENERATION = "buildchain.source-generation/v1";
export const BUSINESS_ATTEMPT = "buildchain.business-attempt/v1";
const ROOT = /^sha256:[0-9a-f]{64}$/u;

export function pipelineIntent({
  repository,
  repositoryId,
  pullRequest,
  targetBranch,
  phases,
  runtime,
}) {
  text(repository, "repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  text(repositoryId, "repositoryId");
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
    throw new Error("Invalid PR intent number");
  text(
    targetBranch,
    "targetBranch",
    /^(?:dev|alpha|release|publish-gate)\/[A-Za-z0-9/._-]+$/u,
  );
  list(phases, "phases", (phase, field) =>
    choice(phase, PIPELINE_PHASES, field),
  );
  unique(phases, "phases");
  if (
    phases.some(
      (phase, i) =>
        i &&
        PIPELINE_PHASES.indexOf(phase) <=
          PIPELINE_PHASES.indexOf(phases[i - 1]),
    )
  )
    throw new Error("Intent phases must follow pipeline order");
  if (phases[0] !== "admission")
    throw new Error("Intent must begin with admission");
  return createIntent({
    repository,
    key: `pr-${pullRequest}:${targetBranch}`,
    expectedNodes: phases,
    runtime,
    source: { kind: "pipeline", repositoryId, pullRequest, targetBranch },
  });
}

export function sourceGeneration(intent, source, baseCommit) {
  object(
    source,
    [
      "schema",
      "repository",
      "commit",
      "tree",
      "configPath",
      "configBlob",
      "configDigest",
      "contract",
    ],
    [],
    "source",
  );
  if (
    source.schema !== "buildchain.consumer-source/v1" ||
    source.contract !== CONSUMER_CONTRACT ||
    source.repository !== intent.repository
  )
    throw new Error("Generation requires the admitted consumer source");
  for (const key of ["commit", "tree", "configBlob"])
    text(source[key], `source.${key}`, /^[0-9a-f]{40}$/u);
  relativePath(source.configPath, "source.configPath");
  text(source.configDigest, "source.configDigest", ROOT);
  text(baseCommit, "baseCommit", /^[0-9a-f]{40}$/u);
  const value = {
    schema: SOURCE_GENERATION,
    intent: intent.id,
    source: structuredClone(source),
    baseCommit,
  };
  return { ...value, id: recordDigest(value) };
}

export function validateGeneration(value, intent) {
  object(
    value,
    ["schema", "intent", "source", "baseCommit", "id"],
    [],
    "generation",
  );
  const expected = sourceGeneration(intent, value.source, value.baseCommit);
  if (recordDigest(value) !== recordDigest(expected))
    throw new Error("Generation identity mismatch");
  return value;
}

export function businessAttempt({
  intent,
  generation,
  predecessor = "",
  requestKey,
}) {
  validateGeneration(generation, intent);
  text(requestKey, "requestKey");
  if (requestKey.length > 240)
    throw new Error("Attempt request key exceeds its bound");
  if (predecessor) text(predecessor, "predecessor", /^attempt-[0-9a-f]{64}$/u);
  const value = {
    schema: BUSINESS_ATTEMPT,
    intent: intent.id,
    generation: generation.id,
    predecessor,
    requestKey,
  };
  return { ...value, id: `attempt-${recordDigest(value).slice(7)}` };
}

export function validateAttempt(value, intent, generation) {
  object(
    value,
    ["schema", "intent", "generation", "predecessor", "requestKey", "id"],
    [],
    "attempt",
  );
  const expected = businessAttempt({
    intent,
    generation,
    predecessor: value.predecessor,
    requestKey: value.requestKey,
  });
  if (recordDigest(value) !== recordDigest(expected))
    throw new Error("Business attempt identity mismatch");
  return value;
}

export function providerWriter(value, repository) {
  object(value, ["repository", "runId", "runAttempt", "jobId"], [], "writer");
  if (value.repository !== repository)
    throw new Error("Writer belongs to a different repository");
  for (const key of ["runId", "runAttempt", "jobId"])
    text(value[key], `writer.${key}`, /^[1-9][0-9]*$/u);
  return `${value.runId}:${value.runAttempt}:${value.jobId}`;
}

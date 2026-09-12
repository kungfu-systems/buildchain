import { githubJsonClient } from "../../providers/github/json-client.js";
import { githubAttemptJournal } from "../../providers/github/attempt-journal.js";
import { githubAttemptIndex } from "../../providers/github/attempt-index.js";
import { readBusinessAttempt } from "../attempt/reader.js";
import { assertPipelineExecution } from "./fence.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { githubPipelineSource } from "../../providers/github/pipeline-source.js";
import { githubPipelinePolicy } from "../../providers/github/pipeline-policy.js";
import { getOctokit } from "@actions/github";
import { discussionMaterials } from "../../providers/github/discussions/materials.js";
import { pipelineMaterials } from "./materials.js";

async function assertRetainedRequest(input, connection, observed) {
  const current = observed.history.at(-1);
  const event = [...current.events]
    .reverse()
    .find((entry) =>
      entry.payload.materials.some((material) =>
        material.id.startsWith("delivery/execution-"),
      ),
    );
  const reference = event?.payload.materials.find((material) =>
    material.id.startsWith("delivery/execution-"),
  );
  if (!reference)
    throw new Error("Pipeline delivery has no admitted execution request");
  const archive = discussionMaterials({
    octokit: getOctokit(connection.token),
    repository: connection.repository,
    intentId: observed.intent.id,
  });
  const material = pipelineMaterials(archive, {
    repository: connection.repository,
    attempt: current.identity,
  });
  const execution = await material.read(reference);
  validatePipelineExecutionRequest(execution, input, observed, {
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  });
}

export function validatePipelineExecutionRequest(
  execution,
  input,
  observed,
  coordinates,
) {
  if (execution.schema !== "buildchain.pipeline-delivery-execution/v1")
    throw new Error("Pipeline delivery request schema is unsupported");
  if (
    execution.attempt !== observed.attempt ||
    execution.generation !== observed.generation ||
    execution.runId !== coordinates.runId ||
    execution.runAttempt !== coordinates.runAttempt
  )
    throw new Error(
      "Pipeline delivery is not the exact admitted provider execution",
    );
  for (const [key, value] of Object.entries(execution.request))
    if (
      !Object.hasOwn(input, key) ||
      recordDigest(input[key]) !== recordDigest(value)
    )
      throw new Error(
        `Pipeline delivery changed its retained request field: ${key}`,
      );
}

export async function guardPipelineAdmission(input, connection) {
  const observed = await guardPipelineDelivery(input, connection);
  if (!observed) return null;
  await assertRetainedRequest(input, connection, observed);
  const request = githubJsonClient({
    token: connection.token,
    userAgent: "buildchain-pipeline-admission",
  });
  const current = { ...observed.history.at(-1), intent: observed.intent };
  const source = githubPipelineSource(request, connection.repository);
  const admission = await source.observeIntent(
    observed.intent,
    current.generation,
    { "config-path": current.generation.source.configPath },
  );
  const { live } = admission;
  if (
    admission.cleanupOnly ||
    !live.source ||
    live.state !== "open" ||
    live.draft ||
    !live.ready ||
    live.baseCommit !== current.generation.baseCommit ||
    recordDigest(live.source) !== recordDigest(current.generation.source)
  )
    throw new Error(
      "Pipeline source is no longer admitted for a delivery effect",
    );
  const policy = await githubPipelinePolicy(
    request,
    connection.repository,
  ).observe(current, admission.protectedPlan.review);
  if (!policy.review || !policy.checksPassing)
    throw new Error(
      "Pipeline protected review or required checks changed before delivery effect",
    );
  return observed;
}

export async function guardPipelineDelivery(input, connection, lookup) {
  const attempt = input["pipeline-attempt"];
  // Existing advanced delivery callers retain their domain authority. The new
  // normal entry always supplies its internally selected business attempt.
  if (!attempt) return null;
  if (!connection.token)
    throw new Error("Pipeline controller requires its scoped read credential");
  const request = githubJsonClient({
    token: connection.token,
    userAgent: "buildchain-pipeline",
  });
  const index =
    lookup ||
    githubAttemptIndex(
      request,
      githubAttemptJournal(request),
      connection.repository,
    );
  const loaded = await index.resolve(attempt);
  const observed = readBusinessAttempt(loaded.snapshot);
  const current = observed.history.at(-1);
  if (
    !current ||
    observed.intent.repository !== connection.repository ||
    observed.intent.source.targetBranch !== input["target-branch"] ||
    observed.intent.source.pullRequest !==
      Number(input["expected-pr-number"]) ||
    current.generation.source.commit !== input["expected-head-sha"]
  )
    throw new Error(
      "Pipeline delivery request changed its admitted source intent",
    );
  assertPipelineExecution(observed, {
    attempt,
    intent: observed.intent.id,
    generation: current.generation.id,
    sourceRoot: recordDigest(current.generation.source),
  });
  return observed;
}

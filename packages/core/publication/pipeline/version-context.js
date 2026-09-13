import { recordDigest } from "../../release/discussion/envelope.js";
import { resumePipelineSession } from "../../workflow/pipeline/session.js";
import { pipelinePlatforms } from "../../workflow/pipeline/platforms.js";
import { githubPipelineVersion } from "../../providers/github/pipeline-version.js";
import { githubPipelineVersionArtifacts } from "../../providers/github/pipeline-version-artifacts.js";
import { pipelinePublicationJournal } from "./journal.js";
import {
  planPipelineVersionPreparation,
  verifyPipelineVersionPreparation,
} from "./version-preparation.js";
import { collectPipelineVersionMaterial } from "./version-regeneration.js";

const phaseOf = (purpose) =>
  purpose === "publication" ? "publish" : "next-development";

export async function preparePipelineVersionContext(
  parent,
  purpose,
  publication,
  host,
  journal,
  definitionSha,
) {
  const admitted = await host.source.source(
    parent.source.commit,
    parent.source.configPath,
  );
  if (
    recordDigest(admitted.identity) !== recordDigest(parent.source) ||
    recordDigest(admitted.plan) !== publication.plan.contractRoot
  )
    throw new Error(
      "Version preparation source or contract differs from its retained parent",
    );
  const preparation = planPipelineVersionPreparation({
    attempt: publication.attempt,
    generation: publication.generation,
    source: parent.source,
    contract: admitted.plan,
    version: parent.version,
    runtime: host.runtime,
    purpose,
    parentRoot: parent.root,
  });
  const context = {
    schema: "buildchain.pipeline-version-context/v1",
    attempt: publication.attempt,
    generation: publication.generation,
    preparation,
    definitionSha,
    runId: host.runId,
    runAttempt: host.runAttempt,
    platforms: pipelinePlatforms(admitted.plan),
    publication,
  };
  await journal.record(`publication/version-${purpose}-context`, context, {
    phase: phaseOf(purpose),
  });
  return context;
}

export async function qualifyPipelineVersionContext(
  context,
  host,
  directory,
  artifactClient,
) {
  if (
    context.schema !== "buildchain.pipeline-version-context/v1" ||
    context.runId !== host.runId ||
    context.runAttempt !== host.runAttempt
  )
    throw new Error(
      "Version context belongs to a different provider execution",
    );
  const session = await resumePipelineSession(
    { ...host, attempt: context.attempt },
    host,
  );
  const journal = pipelinePublicationJournal(session, host);
  await journal.fence();
  const { preparation } = context;
  if (
    context.generation !== session.observed.generation ||
    preparation.attempt !== context.attempt ||
    preparation.generation !== context.generation ||
    recordDigest(preparation.runtime) !== recordDigest(host.runtime)
  )
    throw new Error(
      "Version context changed its admitted attempt, generation or runtime",
    );
  const retained = await journal.materials(
    `publication/version-${preparation.purpose}-context/`,
  );
  if (!retained.some((value) => recordDigest(value) === recordDigest(context)))
    throw new Error(
      "Version context is not retained in the authoritative attempt",
    );
  const admitted = await host.source.source(
    preparation.source.commit,
    preparation.source.configPath,
  );
  if (recordDigest(admitted.identity) !== recordDigest(preparation.source))
    throw new Error("Version context source changed before qualification");
  verifyPipelineVersionPreparation(preparation, admitted.plan);
  const artifacts = githubPipelineVersionArtifacts(host, artifactClient);
  const observed = await artifacts.download(context, directory);
  const adapter = githubPipelineVersion(host.request, host.repository);
  const before = await adapter.inspect(
    preparation.source,
    preparation.versionPolicy,
  );
  collectPipelineVersionMaterial(preparation, before.files, observed.results);
  const regeneration = { context, ...observed };
  await journal.fence();
  await journal.record(
    `publication/version-${preparation.purpose}-qualified`,
    regeneration,
    { phase: phaseOf(preparation.purpose) },
  );
  return { session, journal, regeneration };
}

export async function retainedPipelineVersionRegeneration(
  journal,
  parent,
  purpose,
  runtime,
) {
  const values = (
    await journal.materials(`publication/version-${purpose}-qualified/`)
  ).filter(
    ({ context }) =>
      context.preparation.parentRoot === parent.root &&
      recordDigest(context.preparation.runtime) === recordDigest(runtime),
  );
  if (
    values.length > 1 &&
    new Set(values.map(({ results }) => recordDigest(results))).size !== 1
  )
    throw new Error("Version regeneration has conflicting qualified bytes");
  return values.at(-1);
}

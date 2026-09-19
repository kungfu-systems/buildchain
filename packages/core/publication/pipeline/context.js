import { recordDigest } from "../../release/discussion/envelope.js";
import { resumePipelineSession } from "../../workflow/pipeline/session.js";
import { pipelinePublicationJournal } from "./journal.js";

export async function publicationContext(context, host) {
  if (
    context.schema !== "buildchain.pipeline-publication-context/v1" ||
    context.runId !== host.runId ||
    context.runAttempt !== host.runAttempt
  )
    throw new Error(
      "Publication context is not from this exact provider execution",
    );
  const session = await resumePipelineSession(
    { ...host, attempt: context.attempt },
    host,
  );
  if (session.observed.generation !== context.generation)
    throw new Error(
      "Publication context belongs to a superseded source generation",
    );
  const journal = pipelinePublicationJournal(session, host);
  await journal.fence();
  const contexts = await journal.materials("publication/context/");
  if (!contexts.some((value) => recordDigest(value) === recordDigest(context)))
    throw new Error(
      "Publication context is not retained in the authoritative attempt",
    );
  return { session, journal, archive: host.productArchive(session) };
}

export async function uniquePublicationMaterial(journal, prefix) {
  const values = await journal.materials(prefix);
  if (values.length !== 1)
    throw new Error(
      `Publication requires one exact retained material: ${prefix}`,
    );
  return values[0];
}

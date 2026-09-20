import { recordDigest } from "../../release/discussion/envelope.js";
import { resumePipelineSession } from "../../workflow/pipeline/session.js";
import { pipelinePublicationJournal } from "./journal.js";
import { createReleaseReceipt } from "../../release/release-invocation.js";

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

export async function completedPublicationRecovery(context, journal) {
  if (!context.recovery?.preserveTransaction) return null;
  const values = await journal.materials("publication/predecessor-complete/");
  if (!values.length) return null;
  const complete = values[0];
  const retained = await uniquePublicationMaterial(
    journal,
    "publication/qualified/",
  );
  const receipt = complete.release?.receipt;
  if (
    values.length !== 1 ||
    complete.schema !== "buildchain.pipeline-publication-complete/v1" ||
    !Number.isFinite(Date.parse(complete.completedAt)) ||
    receipt?.outcome !== "complete" ||
    retained.qualified.planRoot !== context.plan.root ||
    receipt.transactionRoot !==
      retained.documents.transaction.transactionRoot ||
    receipt.releasePassportRoot !== retained.documents.passport.passportRoot ||
    recordDigest(createReleaseReceipt(receipt)) !==
      recordDigest(complete.release)
  )
    throw new Error(
      "Completed publication recovery changed its retained signed transaction",
    );
  return complete;
}

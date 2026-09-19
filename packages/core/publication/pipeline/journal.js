import { recordDigest } from "../../release/discussion/envelope.js";
import { assertPipelineExecution } from "../../workflow/pipeline/fence.js";
import {
  PUBLICATION_IMPORT,
  publicationImportedValues,
} from "./imported-materials.js";

export function pipelinePublicationJournal(session, host) {
  const initial = session.observed;
  const expected = {
    attempt: initial.attempt,
    generation: initial.generation,
    intent: session.intent.id,
    sourceRoot: recordDigest(initial.history.at(-1).generation.source),
  };
  const store = host.materialStore(session);
  async function fence() {
    const observed = await session.journal.read();
    assertPipelineExecution(observed, expected);
    const writer = observed.history
      .at(-1)
      .events.filter((event) =>
        event.payload.materials.some((material) =>
          material.id.startsWith("publication/worker/"),
        ),
      )
      .at(-1)?.payload.writer;
    if (
      writer &&
      (writer.runId !== String(host.runId) ||
        writer.runAttempt !== String(host.runAttempt))
    )
      throw new Error(
        "Publication worker lost its exact provider execution reservation",
      );
    return observed;
  }
  async function materials(prefix) {
    const observed = await session.journal.read();
    if (observed.attempt !== initial.attempt)
      throw new Error("Publication journal is no longer the current attempt");
    const references = observed.history
      .at(-1)
      .events.flatMap((event) => event.payload.materials)
      .filter(
        (reference) =>
          reference.id.startsWith(prefix) ||
          reference.id.startsWith("publication/recovery-import/"),
      );
    const unique = [
      ...new Map(
        references.map((reference) => [reference.digest, reference]),
      ).values(),
    ];
    const values = [];
    for (const reference of unique) {
      const value = await store.read(reference);
      if (value.schema === PUBLICATION_IMPORT)
        values.push(
          ...publicationImportedValues(value)
            .filter((item) => item.id.startsWith(prefix))
            .map((item) => item.value),
        );
      else if (reference.id.startsWith(prefix)) values.push(value);
    }
    return [
      ...new Map(values.map((value) => [recordDigest(value), value])).values(),
    ];
  }
  async function record(
    id,
    value,
    { phase = "publish", state = "running", expectedHead } = {},
  ) {
    const root = recordDigest(value);
    const observed = await session.journal.read();
    const eventKey = `publication:${id}:${root}`;
    const prior = observed.history
      .at(-1)
      .events.find((event) => event.payload.eventKey === eventKey);
    if (prior) {
      if (
        observed.attempt !== initial.attempt ||
        prior.node !== phase ||
        prior.payload.state !== state ||
        prior.payload.materials.length !== 1 ||
        recordDigest(await store.read(prior.payload.materials[0])) !== root
      )
        throw new Error(
          "Publication retry changed its immutable recorded result",
        );
      return value;
    }
    const reference = await store.retain(
      `${id}/${root.slice(7)}`,
      value,
      "receipt",
    );
    await session.progress.progress({
      attempt: initial.attempt,
      phase,
      state,
      eventKey,
      materials: [reference],
      ...(expectedHead !== undefined ? { expectedHead } : {}),
    });
    return value;
  }
  async function recordImport(value, phase) {
    publicationImportedValues(value);
    const observed = await fence();
    const id = "publication/recovery-import";
    const eventKey = `publication:${id}:${recordDigest(value)}`;
    const prior = observed.history
      .at(-1)
      .events.find((event) => event.payload.eventKey === eventKey);
    // Import is one atomic append, not a new result for each resumed phase.
    // Replay still verifies the original event, state and retained bytes.
    return record(id, value, { phase: prior?.node || phase });
  }
  return { fence, materials, record, recordImport };
}

import { recordDigest } from "../../release/discussion/envelope.js";
import { assertPipelineExecution } from "../../workflow/pipeline/fence.js";

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
      .filter((reference) => reference.id.startsWith(prefix));
    const unique = [
      ...new Map(
        references.map((reference) => [reference.digest, reference]),
      ).values(),
    ];
    return Promise.all(unique.map((reference) => store.read(reference)));
  }
  async function record(
    id,
    value,
    { phase = "publish", state = "running", expectedHead } = {},
  ) {
    const root = recordDigest(value);
    const reference = await store.retain(
      `${id}/${root.slice(7)}`,
      value,
      "receipt",
    );
    await session.progress.progress({
      attempt: initial.attempt,
      phase,
      state,
      eventKey: `publication:${id}:${root}`,
      materials: [reference],
      ...(expectedHead !== undefined ? { expectedHead } : {}),
    });
    return value;
  }
  return { fence, materials, record };
}

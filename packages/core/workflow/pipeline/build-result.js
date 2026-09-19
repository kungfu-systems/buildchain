import { publishPipelineBuildCheck } from "./build-evidence.js";
import { PIPELINE_BUILD_QUALIFICATION } from "./build-qualification.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { replayRecoveryIntegration } from "./recovery-integration.js";

async function resultReference(context, readback, session, host) {
  const observed = await session.journal.read();
  if (observed.attempt !== context.attempt)
    throw new Error("Late build result belongs to a superseded attempt");
  const prior = observed.history
    .at(-1)
    .events.find(
      (event) =>
        event.payload.eventKey ===
        `build-result:${context.runId}:${context.runAttempt}`,
    );
  const store = host.materialStore(session);
  if (prior) {
    const references = prior.payload.materials;
    if (
      references.length !== 1 ||
      recordDigest(await store.read(references[0])) !== recordDigest(readback)
    )
      throw new Error("Repeated build callback changed its immutable result");
    return references[0];
  }
  return store.retain(
    `build/${readback.schema === PIPELINE_BUILD_QUALIFICATION ? "qualified" : "provider"}-${context.runId}-${context.runAttempt}`,
    readback,
    "provider-readback",
  );
}

export async function retainPipelineBuildResult(
  context,
  readback,
  session,
  host,
) {
  if (
    readback.outcome === "success" &&
    session.intent.expectedNodes.includes("publish")
  )
    await host.qualifyChannel(
      context.source,
      session.intent.source.targetBranch,
    );
  const reference = await resultReference(context, readback, session, host);
  await session.progress.progress({
    attempt: context.attempt,
    phase: "build",
    state: readback.outcome === "success" ? "success" : "failure",
    eventKey: `build-result:${context.runId}:${context.runAttempt}`,
    reason: readback.outcome === "success" ? "" : "product-build-failed",
    materials: [reference],
  });
  await host.project(session);
  await publishPipelineBuildCheck(
    context,
    readback,
    host.request,
    host.repository,
  );
  await host.publishBuildStatus?.(context, readback);
  if (
    readback.schema === PIPELINE_BUILD_QUALIFICATION &&
    readback.outcome === "success"
  )
    await replayRecoveryIntegration(session, host);
  try {
    await host.wake(context.attempt);
    return { outcome: readback.outcome, wakePending: false };
  } catch {
    // The source build remains qualified if only notification failed. Its
    // durable result is reobserved on the next PR event or exact attempt wake.
    return { outcome: readback.outcome, wakePending: true };
  }
}

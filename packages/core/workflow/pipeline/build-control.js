import { recordDigest } from "../../release/discussion/envelope.js";
import { object } from "../../consumer/contract/shape.js";
import { pipelinePlatforms } from "./platforms.js";
import { resumePipelineSession } from "./session.js";
import { publishPipelineBuildCheck } from "./build-evidence.js";

export async function beginPipelineBuild(session, admission, host) {
  const observed = await session.journal.read();
  const attempt = observed.attempt;
  const previous = observed.phases.build;
  if (
    previous &&
    (previous.payload.writer.runId !== String(host.runId) ||
      previous.payload.writer.runAttempt !== String(host.runAttempt))
  ) {
    const { run } = await host.runs.read(
      Number(previous.payload.writer.runId),
      Number(previous.payload.writer.runAttempt),
    );
    if (run.status !== "completed") return null;
    const material = await host
      .materialStore(session)
      .retain(
        `build/incomplete-${run.id}-${run.run_attempt}`,
        run,
        "provider-readback",
      );
    await session.progress.progress({
      attempt,
      phase: "build",
      state: "failure",
      eventKey: `build-incomplete:${run.id}:${run.run_attempt}`,
      reason: "build-recording-incomplete",
      materials: [material],
      expectedHead: observed.head,
    });
    return null;
  }
  if (!observed.phases.admission) {
    const receipt = {
      schema: "buildchain.pipeline-source-observation/v1",
      repositoryId: admission.repositoryId,
      source: admission.live.source,
      baseCommit: admission.live.baseCommit,
      protectedSource: admission.protectedSource,
      route: admission.route,
      runtime: host.runtime,
    };
    const reference = await host
      .materialStore(session)
      .retain("source/admission", receipt, "provider-readback");
    await session.progress.progress({
      attempt,
      phase: "admission",
      state: "success",
      eventKey: `admission:${observed.generation}`,
      materials: [reference],
    });
  }
  const scheduling = await session.journal.read();
  const scheduled = scheduling.phases.build?.payload.writer;
  if (
    scheduled &&
    (scheduled.runId !== String(host.runId) ||
      scheduled.runAttempt !== String(host.runAttempt))
  )
    return null;
  await session.progress.progress({
    attempt,
    phase: "build",
    state: "running",
    eventKey: `build-start:${host.runId}:${host.runAttempt}`,
    expectedHead: scheduling.head,
  });
  return {
    schema: "buildchain.pipeline-build-context/v1",
    attempt,
    generation: observed.generation,
    source: admission.live.source,
    runId: host.runId,
    runAttempt: host.runAttempt,
    platforms: pipelinePlatforms(admission.plan),
  };
}

export function validatePipelineBuildContext(context) {
  object(context, [
    "schema",
    "attempt",
    "generation",
    "source",
    "runId",
    "runAttempt",
    "platforms",
  ]);
  if (
    context.schema !== "buildchain.pipeline-build-context/v1" ||
    !/^attempt-[0-9a-f]{64}$/u.test(context.attempt) ||
    !/^sha256:[0-9a-f]{64}$/u.test(context.generation) ||
    ![context.runId, context.runAttempt].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("Invalid internal pipeline build context");
  return context;
}

export async function recordPipelineBuild(context, host) {
  validatePipelineBuildContext(context);
  if (context.runId !== host.runId || context.runAttempt !== host.runAttempt)
    throw new Error("Build callback belongs to another provider execution");
  const session = await resumePipelineSession(
    { ...host, attempt: context.attempt },
    host,
  );
  const current = session.observed.history.at(-1);
  if (
    context.generation !== current.generation.id ||
    recordDigest(context.source) !== recordDigest(current.generation.source)
  )
    throw new Error("Build callback changed its admitted source generation");
  const admitted = await host.source.source(
    context.source.commit,
    context.source.configPath,
  );
  if (
    recordDigest(context.platforms) !==
    recordDigest(pipelinePlatforms(admitted.plan))
  )
    throw new Error(
      "Build callback omitted or changed a declared product platform",
    );
  const readback = await host.runs.build(
    context.runId,
    context.runAttempt,
    context.source,
    context.platforms.map((platform) => platform.platform),
  );
  const reference = await host
    .materialStore(session)
    .retain(
      `build/provider-${context.runId}-${context.runAttempt}`,
      readback,
      "provider-readback",
    );
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
  try {
    await host.wake(context.attempt);
    return { outcome: readback.outcome, wakePending: false };
  } catch {
    // The source build remains qualified if only notification failed. Its
    // durable result is reobserved on the next PR event or exact attempt wake.
    return { outcome: readback.outcome, wakePending: true };
  }
}

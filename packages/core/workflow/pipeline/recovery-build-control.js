import { object } from "../../consumer/contract/shape.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { resumePipelineSession } from "./session.js";
import { recoveryBuildEvidence } from "./recovery-build-evidence.js";
import { qualifyPipelineBuild } from "./build-qualification.js";
import { retainPipelineBuildResult } from "./build-result.js";

export const RECOVERY_BUILD_CONTEXT =
  "buildchain.pipeline-recovery-build-context/v1";

export async function beginRecoveryBuild(session, host) {
  session.observed = await session.journal.read();
  const { plan, build } = await recoveryBuildEvidence(session, host);
  const observed = session.observed;
  const previous = observed.phases.build;
  if (
    previous &&
    (previous.payload.writer.runId !== String(host.runId) ||
      previous.payload.writer.runAttempt !== String(host.runAttempt))
  )
    return null;
  await session.progress.progress({
    attempt: observed.attempt,
    phase: "build",
    state: "running",
    eventKey: `build-start:${host.runId}:${host.runAttempt}`,
    expectedHead: observed.head,
    reason: build.reason,
  });
  return {
    schema: RECOVERY_BUILD_CONTEXT,
    attempt: observed.attempt,
    generation: observed.generation,
    source: build.source,
    runId: host.runId,
    runAttempt: host.runAttempt,
    platforms: build.scheduled,
    recoveryPlanRoot: plan.root,
  };
}

export async function recordRecoveryBuild(context, host) {
  object(context, [
    "schema",
    "attempt",
    "generation",
    "source",
    "runId",
    "runAttempt",
    "platforms",
    "recoveryPlanRoot",
  ]);
  if (
    context.schema !== RECOVERY_BUILD_CONTEXT ||
    context.runId !== host.runId ||
    context.runAttempt !== host.runAttempt
  )
    throw new Error("Recovery build callback belongs to another execution");
  const session = await resumePipelineSession(
    { ...host, attempt: context.attempt },
    host,
  );
  const { plan, build } = await recoveryBuildEvidence(session, host);
  const writer = session.observed.phases.build?.payload.writer;
  if (
    context.generation !== session.observed.generation ||
    context.recoveryPlanRoot !== plan.root ||
    recordDigest(context.source) !== recordDigest(build.source) ||
    recordDigest(context.platforms) !== recordDigest(build.scheduled) ||
    writer?.runId !== String(host.runId) ||
    writer?.runAttempt !== String(host.runAttempt)
  )
    throw new Error(
      "Recovery build callback changed its reserved work or admission",
    );
  const segments = structuredClone(build.segments);
  if (build.scheduled.length) {
    const platforms = build.scheduled.map((item) => item.platform);
    const readback = await host.runs.build(
      host.runId,
      host.runAttempt,
      build.source,
      platforms,
    );
    segments.push({ readback, platforms, runtime: host.runtime });
  }
  const result = qualifyPipelineBuild({
    source: build.source,
    platforms: build.platforms.map((item) => item.platform),
    segments,
    runId: host.runId,
    runAttempt: host.runAttempt,
  });
  return retainPipelineBuildResult(context, result, session, host);
}

import { recordDigest } from "../../release/discussion/envelope.js";
import { pipelinePlatforms } from "./platforms.js";
import { qualifyRecoveryRuntime } from "./recovery-runtime.js";
import { unrecordedRecoveryBuild } from "./recovery-unrecorded-build.js";
import {
  PIPELINE_BUILD_QUALIFICATION,
  buildReadbackPlatforms,
  verifyPipelineBuildQualification,
  qualifyPipelineBuild,
} from "./build-qualification.js";

async function retainedSegments(session, source, platforms, host) {
  const phase = session.observed.history.at(-1).phases.build;
  const references = (phase?.payload.materials || []).filter(
    (item) =>
      item.id.startsWith("build/provider-") ||
      item.id.startsWith("build/qualified-"),
  );
  if (!references.length && phase?.payload.state !== "success")
    return unrecordedRecoveryBuild(session, source, platforms, host);
  if (references.length !== 1)
    throw new Error(
      "Recovery cannot qualify the unique retained build receipt",
    );
  const value = await host.materialStore(session).read(references[0]);
  if (value.schema === PIPELINE_BUILD_QUALIFICATION) {
    await verifyPipelineBuildQualification(value, source, platforms, host.runs);
    return value.segments;
  }
  const inventory = buildReadbackPlatforms(value);
  if (
    recordDigest(value.source) !== recordDigest(source) ||
    recordDigest([...inventory].sort()) !== recordDigest([...platforms].sort())
  )
    throw new Error(
      "Recovery build receipt changed its original platform inventory",
    );
  const fresh = await host.runs.build(
    value.runId,
    value.runAttempt,
    source,
    inventory,
  );
  if (recordDigest(fresh) !== recordDigest(value))
    throw new Error("Recovery build receipt changed during provider readback");
  const segments = [{ readback: value, platforms, runtime: phase.runtime }];
  qualifyPipelineBuild({
    source,
    platforms,
    segments,
    runId: value.runId,
    runAttempt: value.runAttempt,
  });
  return segments;
}

// Every retained segment is independently observed, even when its old overall
// workflow failed elsewhere. Only successful jobs with an unchanged execution
// implementation qualify for reuse. Missing evidence is not invented.
export async function qualifyRecoveryBuild(session, admission, host) {
  const source = session.observed.history.at(-1).generation.source;
  if (recordDigest(admission.identity) !== recordDigest(source))
    throw new Error("Recovery build admission changed its exact source");
  const platforms = pipelinePlatforms(admission.plan);
  const prior = await retainedSegments(
    session,
    source,
    platforms.map((item) => item.platform),
    host,
  );
  const segments = [],
    runtimes = [],
    selected = new Set();
  for (const segment of prior) {
    const runtime = await qualifyRecoveryRuntime(
      segment.runtime,
      host.runtime,
      "build",
      host.request,
    );
    runtimes.push(runtime);
    const inventory = buildReadbackPlatforms(segment.readback);
    const reusable = segment.platforms.filter((platform) => {
      const job = segment.readback.jobs[inventory.indexOf(platform)];
      return (
        runtime.compatible &&
        job.status === "completed" &&
        job.conclusion === "success"
      );
    });
    if (reusable.length) {
      for (const platform of reusable) {
        if (
          selected.has(platform) ||
          !platforms.some((item) => item.platform === platform)
        )
          throw new Error(
            "Recovery build has duplicate or undeclared retained platforms",
          );
        selected.add(platform);
      }
      segments.push({ ...segment, platforms: reusable });
    }
  }
  const body = {
    schema: "buildchain.pipeline-recovery-build/v1",
    predecessor: session.observed.attempt,
    predecessorHead: session.observed.head,
    source,
    platforms,
    scheduled: platforms.filter((item) => !selected.has(item.platform)),
    segments,
    runtimes,
    reason: !prior.length
      ? "No retained product result; execute declared platforms"
      : runtimes.some((item) => !item.compatible)
        ? "Changed stage implementation requires affected platform execution"
        : "Reuse independently verified successful platforms; execute only missing results",
  };
  return { ...body, root: recordDigest(body) };
}

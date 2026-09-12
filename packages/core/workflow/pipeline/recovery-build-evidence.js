import { recordDigest } from "../../release/discussion/envelope.js";
import { retainedRecoveryEvidence } from "./recovery-session.js";
import { pipelinePlatforms } from "./platforms.js";
import { buildReadbackPlatforms } from "./build-qualification.js";
import { qualifyRecoveryRuntime } from "./recovery-runtime.js";

export async function recoveryBuildEvidence(session, host) {
  const { plan, evidence } = await retainedRecoveryEvidence(session, host);
  const build = evidence.build;
  if (!build) throw new Error("Recovery admission has no qualified build plan");
  const { root, ...body } = build;
  const current = session.observed.history.at(-1);
  const source = await host.source.source(
    current.generation.source.commit,
    current.generation.source.configPath,
  );
  if (
    root !== recordDigest(body) ||
    body.schema !== "buildchain.pipeline-recovery-build/v1" ||
    body.predecessor !== plan.predecessor ||
    recordDigest(body.source) !== recordDigest(current.generation.source) ||
    recordDigest(source.identity) !== recordDigest(body.source) ||
    recordDigest(pipelinePlatforms(source.plan)) !==
      recordDigest(body.platforms) ||
    recordDigest(host.runtime) !== recordDigest(plan.runtime)
  )
    throw new Error(
      "Recovery build plan changed its source, platform inventory or executor",
    );
  const selected = new Set();
  for (const segment of build.segments) {
    const old = segment.readback;
    const inventory = buildReadbackPlatforms(old);
    const fresh = await host.runs.build(
      old.runId,
      old.runAttempt,
      build.source,
      inventory,
    );
    const runtime = await qualifyRecoveryRuntime(
      segment.runtime,
      host.runtime,
      "build",
      host.request,
    );
    if (recordDigest(fresh) !== recordDigest(old) || !runtime.compatible)
      throw new Error(
        "Recovered platform changed during execution requalification",
      );
    for (const platform of segment.platforms) {
      const job = old.jobs[inventory.indexOf(platform)];
      if (
        selected.has(platform) ||
        job?.status !== "completed" ||
        job.conclusion !== "success"
      )
        throw new Error(
          "Recovery cannot reuse duplicate or unsuccessful platform results",
        );
      selected.add(platform);
    }
  }
  if (
    recordDigest(build.scheduled) !==
    recordDigest(build.platforms.filter((item) => !selected.has(item.platform)))
  )
    throw new Error(
      "Recovery scheduling differs from the qualified remaining platform set",
    );
  return { plan, build };
}

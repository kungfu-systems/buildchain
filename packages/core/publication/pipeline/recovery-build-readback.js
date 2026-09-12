import { PUBLICATION_BUILD_AGGREGATE } from "./build-segments.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { readPipelineCaller } from "../../providers/github/pipeline-run-entry.js";

export async function reobservePublicationBuild(
  build,
  source,
  host,
  depth = 0,
) {
  const { root, ...body } = build;
  if (
    depth > 100 ||
    root !== recordDigest(body) ||
    recordDigest(build.source) !== recordDigest(source)
  )
    throw new Error(
      "Publication recovery build lineage changed its source or exceeds its bound",
    );
  if (build.schema === PUBLICATION_BUILD_AGGREGATE) {
    if (
      !Array.isArray(build.segments) ||
      !build.segments.length ||
      build.segments.length > 100
    )
      throw new Error("Publication producer segment history exceeds its bound");
    for (const segment of build.segments)
      await reobservePublicationBuild(segment.build, source, host, depth + 1);
    return build;
  }
  if (build.schema === "buildchain.pipeline-publication-requalification/v1")
    return reobservePublicationBuild(
      build.predecessorBuild,
      source,
      host,
      depth + 1,
    );
  if (
    build.schema !== "buildchain.pipeline-publication-build-readback/v1" ||
    !Array.isArray(build.jobs) ||
    !build.jobs.length ||
    build.outcome !== "success"
  )
    throw new Error(
      "Publication recovery requires actual retained successful product jobs",
    );
  const { run, jobs } = await host.runs.read(build.runId, build.runAttempt);
  if (run.head_sha !== build.providerSource)
    throw new Error("Publication producer changed its exact provider source");
  await readPipelineCaller(
    run,
    source.configPath,
    host.request,
    host.repository,
  );
  for (const old of build.jobs)
    if (
      old.status !== "completed" ||
      old.conclusion !== "success" ||
      old.run_id !== build.runId ||
      old.run_attempt !== build.runAttempt ||
      !jobs.some((job) => recordDigest(job) === recordDigest(old))
    )
      throw new Error(
        "Retained publication product job changed during requalification",
      );
  return build;
}

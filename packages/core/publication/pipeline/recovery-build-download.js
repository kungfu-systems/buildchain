import path from "node:path";
import { readPipelineCaller } from "../../providers/github/pipeline-run-entry.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { qualifyRecoveryRuntime } from "../../workflow/pipeline/recovery-runtime.js";
import { githubPipelinePublicationArtifacts } from "../../providers/github/pipeline-publication-artifacts.js";
import { qualifyPublicationBuildSegments } from "./build-segments.js";

export async function downloadRecoveryPublicationBuild(
  context,
  host,
  directory,
) {
  const recovery = context.recovery.build;
  const { root, ...body } = recovery;
  if (
    root !== recordDigest(body) ||
    recordDigest(recovery.source) !==
      recordDigest(context.materialization.source)
  )
    throw new Error(
      "Recovery publication build changed its retained source evidence",
    );
  const provider = githubPipelinePublicationArtifacts(host),
    segments = [],
    bundles = [];
  for (const [index, segment] of recovery.segments.entries()) {
    const comparison = await qualifyRecoveryRuntime(
      segment.runtime,
      host.runtime,
      "publication-build",
      host.request,
    );
    if (!comparison.compatible)
      throw new Error(
        "Recovered publication producer changed after runtime admission",
      );
    const original = {
      plan: segment.plan,
      materialization: segment.materialization,
      runId: segment.build.runId,
      runAttempt: segment.build.runAttempt,
    };
    const downloaded = await provider.download(
      original,
      path.join(directory, `predecessor-${index}`),
      segment.build.platforms,
    );
    if (recordDigest(downloaded.build) !== recordDigest(segment.build))
      throw new Error(
        "Recovered publication artifact evidence changed after admission",
      );
    segments.push(segment);
    bundles.push(...downloaded.bundles);
  }
  if (recovery.scheduled.length) {
    const downloaded = await provider.download(
      context,
      path.join(directory, "current"),
      recovery.scheduled,
    );
    segments.push({
      plan: context.plan,
      materialization: context.materialization,
      runtime: host.runtime,
      build: downloaded.build,
    });
    bundles.push(...downloaded.bundles);
  }
  const { run } = await host.runs.read(context.runId, context.runAttempt);
  await readPipelineCaller(
    run,
    context.materialization.source.configPath,
    host.request,
    host.repository,
  );
  return {
    build: qualifyPublicationBuildSegments(context, segments, run.head_sha),
    bundles,
  };
}

import { recordDigest } from "../../release/discussion/envelope.js";
import { assertRecoveryProductContract } from "./recovery-build-plan.js";

export const PUBLICATION_BUILD_AGGREGATE =
  "buildchain.pipeline-publication-build-qualification/v1";

export function qualifyPublicationBuildSegments(
  context,
  segments,
  providerSource,
) {
  if (!/^[0-9a-f]{40}$/u.test(providerSource || ""))
    throw new Error(
      "Publication qualification requires the actual current signing execution source",
    );
  if (!segments.length || segments.length > 100)
    throw new Error("Publication build segments exceed their exact bound");
  const platforms = [],
    artifactIds = [];
  for (const segment of segments) {
    const { build, plan, materialization } = segment;
    assertRecoveryProductContract(
      plan,
      context.plan,
      materialization.source,
      context.materialization,
    );
    const { root, ...body } = build;
    if (
      root !== recordDigest(body) ||
      build.schema !== "buildchain.pipeline-publication-build-readback/v1" ||
      build.outcome !== "success" ||
      build.planRoot !== plan.root ||
      recordDigest(build.source) !== recordDigest(materialization.source) ||
      build.platforms.length !== build.jobs.length ||
      build.platforms.length !== build.artifactIds.length
    )
      throw new Error(
        "Publication segment lacks exact independently observed build evidence",
      );
    for (const [index, platform] of build.platforms.entries()) {
      const job = build.jobs[index],
        name = `Build publication (${platform})`;
      if (
        job.run_id !== build.runId ||
        job.run_attempt !== build.runAttempt ||
        job.status !== "completed" ||
        job.conclusion !== "success" ||
        !(job.name === name || job.name.endsWith(` / ${name}`))
      )
        throw new Error("Publication segment producer job or platform changed");
    }
    platforms.push(...build.platforms);
    artifactIds.push(...build.artifactIds);
  }
  const expected = [
    ...new Set(context.plan.outputs.map(({ platform }) => platform)),
  ].sort();
  if (
    recordDigest([...platforms].sort()) !== recordDigest(expected) ||
    new Set(artifactIds).size !== artifactIds.length
  )
    throw new Error(
      "Publication segments must cover each declared platform and artifact exactly once",
    );
  const body = {
    schema: PUBLICATION_BUILD_AGGREGATE,
    operation: "requalify-original-product-segments",
    outcome: "success",
    planRoot: context.plan.root,
    source: context.materialization.source,
    providerSource,
    runId: context.runId,
    runAttempt: context.runAttempt,
    platforms: expected,
    artifactIds: artifactIds.sort((a, b) => a - b),
    segments,
  };
  return { ...body, root: recordDigest(body) };
}

export function publicationArtifactProducer(build, artifactId) {
  if (build.schema !== PUBLICATION_BUILD_AGGREGATE)
    return { build, plan: null };
  const selected = build.segments.filter((segment) =>
    segment.build.artifactIds.includes(artifactId),
  );
  if (selected.length !== 1)
    throw new Error("Publication artifact has no unique original producer");
  return selected[0];
}

export function verifyPublicationBuildAggregate(build, context) {
  if (
    recordDigest(build) !==
    recordDigest(
      qualifyPublicationBuildSegments(
        context,
        build.segments,
        build.providerSource,
      ),
    )
  )
    throw new Error(
      "Publication aggregate changed its exact source or original segments",
    );
}

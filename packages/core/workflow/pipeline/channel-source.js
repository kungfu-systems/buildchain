import { recordDigest } from "../../release/discussion/envelope.js";
import { selectProductPublicationIntent } from "../../release/product-publication.js";
import { pipelineExpectedProducts } from "../../publication/pipeline/plan.js";
import { githubPipelineVersion } from "../../providers/github/pipeline-version.js";

// This read-only qualification must precede both required checks and queue
// admission. Publication repeats the Rust-owned decision after protected merge.
export async function qualifyPipelineChannelSource(source, branch, host) {
  if (branch.startsWith("dev/")) return null;
  const admitted = await host.source.source(source.commit, source.configPath);
  if (recordDigest(admitted.identity) !== recordDigest(source))
    throw new Error("Channel qualification source identity drift");
  const { plan } = admitted;
  const routes = plan.channels.filter(
    (route) => route.to === branch && route.operation !== "develop",
  );
  if (routes.length !== 1)
    throw new Error("Channel qualification requires one publication route");
  const route = routes[0];
  const from = `${route.operation === "alpha" ? "dev" : "alpha"}/${branch.split("/").slice(1).join("/")}`;
  if (["alpha", "stable"].includes(route.operation) && route.from !== from)
    throw new Error("Channel source and target version lines must match");
  const version = await githubPipelineVersion(
    host.request,
    host.repository,
  ).inspect(source, plan.version);
  const selection = selectProductPublicationIntent({
    channel: route.operation === "alpha" ? "alpha" : "stable",
    targetRef: branch,
    sourceSha: source.commit,
    sourceTimestamp: version.sourceTimestamp,
    repository: source.repository,
    artifactKind: "custom",
    requiredArtifactsRoot: recordDigest(pipelineExpectedProducts(plan)),
    candidateVersion: version.version,
    observedVersions: [],
  });
  if (
    plan.version.strategy === "anchored" &&
    selection.version !== version.version
  )
    throw new Error("Anchored channel source requires a materialized version");
  const body = {
    schema: "buildchain.pipeline-channel-source-qualification/v1",
    source,
    route,
    contractRoot: recordDigest(plan),
    version: version.version,
    versionFilesRoot: recordDigest(version.files),
    selection,
  };
  return { ...body, root: recordDigest(body) };
}

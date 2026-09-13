import { recordDigest } from "../../release/discussion/envelope.js";
import { selectProductPublicationIntent } from "../../release/product-publication.js";

export function pipelineExpectedProducts(plan) {
  const outputs = plan.products
    .flatMap((product) =>
      product.platforms.flatMap((platform) =>
        product.artifacts.map((artifact) => ({
          id: `${product.id}/${platform}/${artifact.id}`,
          product: product.id,
          platform,
          artifact: artifact.id,
          kind: artifact.kind,
          directory: product.directory || ".",
          path: artifact.path,
          targets: product.targets
            .filter((target) => target.artifacts.includes(artifact.id))
            .map(({ provider, access }) => ({
              provider,
              ...(access ? { access } : {}),
            })),
        })),
      ),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    !outputs.length ||
    outputs.length > 256 ||
    new Set(outputs.map(({ id }) => id)).size !== outputs.length
  )
    throw new Error(
      "Publication requires a bounded unique product/platform/artifact inventory",
    );
  return outputs;
}

export function planPipelinePublication({
  attempt,
  generation,
  source,
  intentSource = source,
  runtime,
  publisher,
  contract,
  route,
  version,
  sourceTimestamp,
  expectedTagSha = null,
  previousChannelCommit = null,
}) {
  if (route.operation === "develop")
    throw new Error("Development delivery cannot publish products");
  const developmentRoutes = contract.channels.filter(
    (entry) =>
      entry.operation === "alpha" &&
      entry.to === (route.operation === "alpha" ? route.to : route.from),
  );
  if (developmentRoutes.length !== 1)
    throw new Error(
      "Publication requires one declared protected development channel",
    );
  const outputs = pipelineExpectedProducts(contract);
  // The Rust-owned version/route decision operates on a declaration here.
  // Actual sealed artifact roots are admitted independently after the build.
  const selection = selectProductPublicationIntent({
    channel: route.operation === "alpha" ? "alpha" : "stable",
    targetRef: route.to,
    sourceSha: source.commit,
    sourceTimestamp,
    repository: source.repository,
    artifactKind: "custom",
    requiredArtifactsRoot: recordDigest(outputs),
    candidateVersion: version,
    observedVersions: [],
  });
  if (contract.version.strategy === "anchored" && selection.version !== version)
    throw new Error(
      "Anchored publication requires an explicitly materialized version; inference is forbidden",
    );
  const body = {
    schema: "buildchain.pipeline-publication-plan/v1",
    attempt,
    generation,
    source,
    intentSource,
    runtime,
    publisher,
    contractRoot: recordDigest(contract),
    version: selection.version,
    candidateVersion: version,
    tag: selection.exactTag,
    channel: selection.channel,
    route,
    sourceTimestamp,
    versionPolicy: contract.version,
    developmentBranch: developmentRoutes[0].from,
    expectedTagSha,
    previousChannelCommit,
    outputs,
    versionSelection: selection,
    phases: ["QUALIFY", "APPLY", "SETTLE"],
  };
  return { ...body, root: recordDigest(body) };
}

export function verifyPipelinePublicationPlan(plan) {
  const { root, ...body } = plan || {};
  if (
    body.schema !== "buildchain.pipeline-publication-plan/v1" ||
    root !== recordDigest(body)
  )
    throw new Error("Publication plan bytes do not match their retained root");
  return plan;
}

import { recordDigest } from "../../release/discussion/envelope.js";
import { selectProductPublicationIntent } from "../../release/product-publication.js";
import { pipelineNativeSigning } from "./native-plan.js";

function publicationFilename(template, platform, version) {
  if (!template) return undefined;
  const name = template.replaceAll("{platform}", platform);
  const resolved =
    version === undefined ? name : name.replaceAll("{version}", version);
  if (
    resolved !== resolved.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._+ -]{0,254}$/u.test(
      version === undefined
        ? resolved.replaceAll("{version}", "version")
        : resolved,
    )
  )
    throw new Error(
      "Publication filename expansion is unsafe or exceeds its bound",
    );
  return resolved;
}

export function pipelineExpectedProducts(plan, version) {
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
          ...(artifact.filename
            ? {
                filename: publicationFilename(
                  artifact.filename,
                  platform,
                  version,
                ),
              }
            : {}),
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
  const filenames = outputs.map(
    (output) =>
      output.filename ||
      `${output.product}-${output.platform}-${output.artifact}${
        output.kind === "npm-package"
          ? ".tgz"
          : output.kind === "pdf"
            ? ".pdf"
            : [
                ".tar.gz",
                ".tar.xz",
                ".tgz",
                ".zip",
                ".tar",
                ".dmg",
                ".exe",
                ".AppImage",
              ].find((suffix) => output.path.endsWith(suffix))
      }`,
  );
  if (new Set(filenames).size !== filenames.length)
    throw new Error(
      "Publication artifact filenames must be unique across every declared platform",
    );
  return outputs;
}

// Rust owns version selection. Bind its final decision to the exact resolved
// output names, including stable promotion from an alpha source version.
export function selectPipelinePublicationProducts(contract, intent) {
  const declaration = pipelineExpectedProducts(contract);
  const preliminary = selectProductPublicationIntent({
    ...intent,
    requiredArtifactsRoot: recordDigest(declaration),
  });
  const outputs = pipelineExpectedProducts(contract, preliminary.version);
  const selection =
    recordDigest(outputs) === recordDigest(declaration)
      ? preliminary
      : selectProductPublicationIntent({
          ...intent,
          requiredArtifactsRoot: recordDigest(outputs),
        });
  if (selection.version !== preliminary.version)
    throw new Error("Publication version changed while binding output names");
  return { outputs, selection, declarationRoot: recordDigest(declaration) };
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
  // The Rust-owned version/route decision operates on a declaration here.
  // Actual sealed artifact roots are admitted independently after the build.
  const { outputs, selection, declarationRoot } =
    selectPipelinePublicationProducts(contract, {
      channel: route.operation === "alpha" ? "alpha" : "stable",
      targetRef: route.to,
      sourceSha: source.commit,
      sourceTimestamp,
      repository: source.repository,
      artifactKind: "custom",
      candidateVersion: version,
      observedVersions: [],
    });
  if (contract.version.strategy === "anchored" && selection.version !== version)
    throw new Error(
      "Anchored publication requires an explicitly materialized version; inference is forbidden",
    );
  const nativeSigning = pipelineNativeSigning(contract);
  const body = {
    schema: `buildchain.pipeline-publication-plan/v${nativeSigning.length ? 2 : 1}`,
    evidenceVersion: nativeSigning.length ? 2 : 1,
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
    ...(contract.stable
      ? { stablePolicy: structuredClone(contract.stable) }
      : {}),
    developmentBranch: developmentRoutes[0].from,
    expectedTagSha,
    previousChannelCommit,
    outputs,
    ...(declarationRoot !== recordDigest(outputs)
      ? { outputDeclarationRoot: declarationRoot }
      : {}),
    ...(nativeSigning.length ? { nativeSigning } : {}),
    versionSelection: selection,
    phases: ["QUALIFY", "APPLY", "SETTLE"],
  };
  return { ...body, root: recordDigest(body) };
}

export function verifyPipelinePublicationPlan(plan) {
  const { root, ...body } = plan || {};
  const native =
    Array.isArray(body.nativeSigning) && body.nativeSigning.length > 0;
  if (
    body.schema !== `buildchain.pipeline-publication-plan/v${native ? 2 : 1}` ||
    (Object.hasOwn(body, "nativeSigning") &&
      (!native || body.evidenceVersion !== 2)) ||
    (body.outputDeclarationRoot !== undefined &&
      !/^sha256:[0-9a-f]{64}$/u.test(body.outputDeclarationRoot)) ||
    root !== recordDigest(body)
  )
    throw new Error("Publication plan bytes do not match their retained root");
  return plan;
}

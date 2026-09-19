import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import { githubPipelinePublicationArtifacts } from "../../providers/github/pipeline-publication-artifacts.js";
import { githubPipelineNativeResults } from "../../providers/github/pipeline-native-results.js";
import { publicationContext } from "./context.js";
import { publicationArtifactProducer } from "./build-segments.js";
import { downloadRecoveryPublicationBuild } from "./recovery-build-download.js";
import { restorePipelineNativeResult } from "./native-retention.js";
import { finalizePipelineNativeProducts } from "./native-finalize.js";

function controlledResult(values, bundle, producerPlan) {
  const matches = values.filter(
    (value) =>
      value.unsignedManifestRoot === bundle.manifest.root &&
      value.unsignedProviderArtifact.id === bundle.providerArtifact.id &&
      value.producerPlan.root === producerPlan.root,
  );
  if (
    matches.length !== 1 ||
    matches[0].schema !== "buildchain.pipeline-native-controlled/v1" ||
    recordDigest(matches[0].unsignedProviderArtifact) !==
      recordDigest(bundle.providerArtifact)
  )
    throw new Error(
      "Native publication requires one exact retained controller result",
    );
  return matches[0];
}

export async function finalizeControlledPipelineProducts({
  context,
  host,
  directory,
  cwd,
  platform,
  environment,
}) {
  const { journal, archive } = await publicationContext(context, host);
  const provider = githubPipelinePublicationArtifacts(host);
  const raw = context.recovery?.build
    ? await downloadRecoveryPublicationBuild(
        context,
        host,
        path.join(directory, "unsigned"),
      )
    : await provider.download(context, path.join(directory, "unsigned"), [
        platform,
      ]);
  const bundles = raw.bundles.filter(
    (bundle) => bundle.manifest.platform === platform,
  );
  if (bundles.length !== 1)
    throw new Error("Native finalizer requires one exact unsigned platform");
  const bundle = bundles[0];
  const producer = publicationArtifactProducer(
    raw.build,
    bundle.providerArtifact.id,
  );
  const producerPlan = producer.plan || context.plan;
  const values = await journal.materials("publication/native-result/");
  const controlled = controlledResult(values, bundle, producerPlan);
  const signedDirectory = await restorePipelineNativeResult(
    archive,
    controlled.retained,
    path.join(directory, "signed"),
  );
  const output = path.join(directory, "final-products");
  const manifest = await finalizePipelineNativeProducts({
    cwd,
    output,
    plan: context.plan,
    producerPlan,
    source: context.materialization.source,
    bundle,
    signedDirectory,
    operation: controlled.operation,
    authority: controlled.authority,
    environment,
  });
  await journal.fence();
  await githubPipelinePublicationArtifacts({
    ...host,
    stage: "finalized",
  }).upload(context.plan, manifest, output);
  return manifest;
}

export async function observePipelineNativePublication({
  context,
  host,
  signingHost,
  directory,
  raw,
  journal,
}) {
  const values = await journal.materials("publication/native-result/");
  const signers = [];
  const provider = githubPipelineNativeResults(signingHost);
  for (const bundle of raw.bundles) {
    const platform = bundle.manifest.platform;
    if (!context.plan.nativeSigning.some((rule) => rule.platform === platform))
      continue;
    const producer = publicationArtifactProducer(
      raw.build,
      bundle.providerArtifact.id,
    );
    const controlled = controlledResult(
      values,
      bundle,
      producer.plan || context.plan,
    );
    const signer = await provider.download(
      controlled.operation,
      controlled.authority.runId,
      controlled.authority.runAttempt,
      path.join(directory, "authority", platform),
    );
    if (signer.proof.root !== controlled.authority.root)
      throw new Error(
        "Native signing authority changed after product finalization",
      );
    signers.push({ ...signer, operation: controlled.operation, platform });
  }
  const finalized = await githubPipelinePublicationArtifacts({
    ...host,
    stage: "finalized",
  }).download(context, path.join(directory, "finalized"));
  return { finalized, signers };
}

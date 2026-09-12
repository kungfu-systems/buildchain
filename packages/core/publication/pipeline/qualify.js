import fs from "node:fs";
import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import { githubPipelinePublicationArtifacts } from "../../providers/github/pipeline-publication-artifacts.js";
import { publicationContext, uniquePublicationMaterial } from "./context.js";
import { qualifyPipelineProducts } from "./qualification.js";
import { pipelineProductCapsules } from "./capsules.js";
import { retainPipelineProducts } from "./sealed-products.js";
import { preparePipelineSigning, verifyPipelineSigning } from "./signing.js";
import { pipelineReleaseDocuments } from "./documents.js";

export async function preparePipelineQualification(context, host, directory) {
  const { journal, archive } = await publicationContext(context, host);
  const products = githubPipelinePublicationArtifacts(host);
  const { build, bundles } = await products.download(
    context,
    path.join(directory, "products"),
  );
  const { plan, materialization } = context;
  const qualified = qualifyPipelineProducts({
    plan,
    source: materialization.source,
    bundles,
    build,
    policyRoot: plan.contractRoot,
  });
  const capsules = pipelineProductCapsules({
    plan,
    materialization,
    qualified,
    bundles,
  });
  const sealed = await retainPipelineProducts(archive, qualified, bundles);
  const prepared = {
    schema: "buildchain.pipeline-qualification-preparation/v1",
    contextRoot: recordDigest(context),
    qualified,
    capsules,
    sealed,
  };
  await journal.fence();
  await journal.record(
    `publication/qualification-prepared/${context.runId}-${context.runAttempt}`,
    prepared,
  );
  return preparePipelineSigning({
    plan,
    materialization,
    qualified,
    directory: path.join(directory, "signing"),
  });
}

export async function sealPipelineQualification(
  context,
  host,
  directory,
  bundlePath,
) {
  const { journal, archive } = await publicationContext(context, host);
  const prepared = await uniquePublicationMaterial(
    journal,
    `publication/qualification-prepared/${context.runId}-${context.runAttempt}/`,
  );
  if (prepared.contextRoot !== recordDigest(context))
    throw new Error("Signing preparation changed provider context");
  const { plan, materialization } = context;
  const signing = verifyPipelineSigning({
    plan,
    materialization,
    qualified: prepared.qualified,
    directory: path.join(directory, "verify-signing"),
    bundlePath,
    token: host.token,
  });
  const bundle = await archive.put(fs.readFileSync(bundlePath), {
    name: "attestation.json",
    mediaType: "application/json",
  });
  if (bundle.digest !== signing.bundleDigest)
    throw new Error("Retained attestation differs from verified signing bytes");
  await archive.read(bundle);
  const documents = pipelineReleaseDocuments({
    plan,
    materialization,
    qualified: prepared.qualified,
    capsules: prepared.capsules,
    signing,
  });
  const result = {
    ...prepared,
    schema: "buildchain.pipeline-qualified-products/v1",
    signing,
    bundle,
    documents,
  };
  await journal.fence();
  await journal.record("publication/qualified", result);
  return result;
}

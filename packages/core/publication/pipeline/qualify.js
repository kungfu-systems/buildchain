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
import { downloadRecoveryPublicationBuild } from "./recovery-build-download.js";
import { prepareRecoveredSigning } from "./recovery-signing.js";
import { observePipelineNativePublication } from "./native-publish.js";

export async function preparePipelineQualification(
  context,
  host,
  directory,
  signingHost,
) {
  const { journal, archive } = await publicationContext(context, host);
  if (context.recovery?.mode === "prepared")
    return prepareRecoveredSigning(
      context,
      host,
      journal,
      archive,
      directory,
      signingHost,
    );
  const products = githubPipelinePublicationArtifacts(host);
  const productDirectory = path.join(directory, "products");
  const { build, bundles } = context.recovery?.build
    ? await downloadRecoveryPublicationBuild(context, host, productDirectory)
    : await products.download(context, productDirectory);
  const { plan, materialization } = context;
  const native = plan.nativeSigning?.length
    ? await observePipelineNativePublication({
        context,
        host,
        signingHost,
        directory,
        raw: { build, bundles },
        journal,
      })
    : undefined;
  const qualified = qualifyPipelineProducts({
    plan,
    source: materialization.source,
    bundles,
    build,
    policyRoot: plan.contractRoot,
    ...(native ? { native } : {}),
  });
  const finalBundles = native
    ? [
        ...bundles.filter(
          (bundle) =>
            !plan.nativeSigning.some(
              (rule) => rule.platform === bundle.manifest.platform,
            ),
        ),
        ...native.finalized.bundles,
      ]
    : bundles;
  const capsules = pipelineProductCapsules({
    plan,
    materialization,
    qualified,
    bundles: finalBundles,
  });
  const sealed = await retainPipelineProducts(archive, qualified, finalBundles);
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

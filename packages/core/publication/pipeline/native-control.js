import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import { githubPipelinePublicationArtifacts } from "../../providers/github/pipeline-publication-artifacts.js";
import { githubPipelineNativeDispatch } from "../../providers/github/pipeline-native-dispatch.js";
import { githubPipelineNativeResults } from "../../providers/github/pipeline-native-results.js";
import { publicationContext } from "./context.js";
import { publicationArtifactProducer } from "./build-segments.js";
import { downloadRecoveryPublicationBuild } from "./recovery-build-download.js";
import { verifyPipelineNativeInputs } from "./native-inputs.js";
import { verifyPipelineNativeResults } from "./native-results.js";
import { executePipelineNativeDispatch } from "./native-dispatch.js";
import {
  retainPipelineNativeResult,
  restorePipelineNativeResult,
} from "./native-retention.js";

async function signingOperation({
  producer,
  manifest,
  providerArtifact,
  input,
  journal,
  dispatch,
}) {
  const identity = {
    planRoot: producer.plan.root,
    manifestRoot: manifest.root,
    artifactId: providerArtifact.id,
    artifactDigest: providerArtifact.digest,
    source: {
      repository: manifest.source.repository,
      runId: producer.build.runId,
      runAttempt: producer.build.runAttempt,
    },
    platform: manifest.platform,
    requestRoot: input.indexRoot,
  };
  const key = recordDigest(identity).slice(7);
  const prefix = `publication/native-operation/${key}`;
  const existing = await journal.materials(`${prefix}/`);
  if (existing.length > 1)
    throw new Error("Native signing has conflicting retained operations");
  const authority = existing[0]?.authority || (await dispatch.entry("v4"));
  const operation = {
    schema: "buildchain.pipeline-native-operation/v1",
    authority,
    producer: identity,
    source: identity.source,
    runtimeSha: producer.plan.runtime.commit,
    requestRoot: input.indexRoot,
    requestArtifact: providerArtifact.name,
    requestIds: input.index.requests.map((request) => request.id),
    correlationId: `pipeline-${key}`,
    resultArtifact: `buildchain-native-result-${key}`,
  };
  if (existing.length && recordDigest(existing[0]) !== recordDigest(operation))
    throw new Error(
      "Native signing recovery changed its exact unsigned producer",
    );
  await journal.fence();
  await journal.record(prefix, operation);
  return operation;
}

// Runs in a controller with a narrowly scoped dispatch credential. It executes
// no consumer commands and never passes credentials to the product finalizer.
export async function controlPipelineNativeSigning(
  context,
  host,
  directory,
  signingHost,
) {
  const { journal, archive } = await publicationContext(context, host);
  const products = githubPipelinePublicationArtifacts(host);
  const downloaded = context.recovery?.build
    ? await downloadRecoveryPublicationBuild(
        context,
        host,
        path.join(directory, "unsigned"),
      )
    : await products.download(context, path.join(directory, "unsigned"));
  const dispatch = githubPipelineNativeDispatch(signingHost.request);
  const results = githubPipelineNativeResults(signingHost);
  const controlled = [];
  for (const bundle of downloaded.bundles) {
    const { manifest, providerArtifact } = bundle;
    if (
      !(context.plan.nativeSigning || []).some(
        (rule) => rule.platform === manifest.platform,
      )
    )
      continue;
    const original = publicationArtifactProducer(
      downloaded.build,
      providerArtifact.id,
    );
    const producer = { ...original, plan: original.plan || context.plan };
    if (
      recordDigest(producer.plan.nativeSigning) !==
      recordDigest(context.plan.nativeSigning)
    )
      throw new Error("Native recovery changed its signing declaration");
    const input = verifyPipelineNativeInputs({
      directory: bundle.directory,
      manifest,
      plan: producer.plan,
      source: context.materialization.source,
    });
    const operation = await signingOperation({
      producer,
      manifest,
      providerArtifact,
      input,
      journal,
      dispatch,
    });
    const completed = await executePipelineNativeDispatch({
      operation,
      journal,
      provider: dispatch,
    });
    const result = await results.download(
      operation,
      completed.runId,
      completed.runAttempt,
      path.join(directory, manifest.platform),
    );
    const verified = verifyPipelineNativeResults({
      input,
      directory: result.directory,
      operation,
      authority: result.proof,
      plan: producer.plan,
      platform: manifest.platform,
    });
    const value = {
      schema: "buildchain.pipeline-native-controlled/v1",
      platform: manifest.platform,
      producerPlan: producer.plan,
      producerBuild: producer.build,
      unsignedManifestRoot: manifest.root,
      unsignedProviderArtifact: providerArtifact,
      operation,
      authority: result.proof,
      verified,
    };
    const resultKey = `publication/native-result/${recordDigest(operation).slice(7)}`;
    const previous = await journal.materials(`${resultKey}/`);
    if (previous.length > 1)
      throw new Error(
        "Native signing recovery has conflicting retained results",
      );
    let retained;
    if (previous.length) {
      const { retained: files, ...original } = previous[0];
      if (recordDigest(original) !== recordDigest(value))
        throw new Error(
          "Native signing recovery changed its independently verified result",
        );
      await restorePipelineNativeResult(
        archive,
        files,
        path.join(directory, "retained-readback", manifest.platform),
      );
      retained = files;
    } else
      retained = await retainPipelineNativeResult(archive, result.directory);
    value.retained = retained;
    await journal.fence();
    await journal.record(resultKey, value);
    controlled.push(value);
  }
  return controlled;
}

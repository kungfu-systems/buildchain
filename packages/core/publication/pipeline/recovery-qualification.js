import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import { createDomainPublicationQualificationReceipt } from "../publication-qualification.js";
import { restorePipelineProducts } from "./sealed-products.js";
import { inspectPipelinePublicationArtifacts } from "./qualification.js";
import { verifyPipelineQualification } from "./documents.js";
import { reobservePublicationBuild } from "./recovery-build-readback.js";
import { requalifyPublicationCapsules } from "./recovery-capsules.js";
import { readPipelineCaller } from "../../providers/github/pipeline-run-entry.js";
import { reobservePipelineNativeQualification } from "./native-recovery.js";

function originalManifests(qualified) {
  return [...new Set(qualified.artifacts.map((item) => item.manifestRoot))].map(
    (root) => {
      const native = qualified.native?.platforms.find(
        (proof) => proof.finalManifest.root === root,
      );
      if (native) return native.finalManifest;
      const artifacts = qualified.artifacts
        .filter((item) => item.manifestRoot === root)
        .map(({ manifestRoot, providerArtifactId, ...item }) => item);
      const body = {
        schema: "buildchain.pipeline-publication-products/v1",
        planRoot: qualified.planRoot,
        source: qualified.source,
        platform: artifacts[0].platform,
        artifacts,
      };
      if (recordDigest(body) !== root)
        throw new Error(
          "Recovered artifact descriptors cannot reconstruct their original manifest bytes",
        );
      return { ...body, root };
    },
  );
}

export async function requalifySealedPublication({
  context,
  prepared,
  originalPlan,
  originalMaterialization,
  archive,
  host,
  signingHost,
  directory,
  now = new Date(),
}) {
  const previous = prepared.qualified;
  verifyPipelineQualification({
    plan: originalPlan,
    materialization: originalMaterialization,
    qualified: previous,
    evaluatedAt: previous.qualification.issuedAt,
  });
  const { plan, materialization } = context;
  if (
    recordDigest(plan.outputs) !== recordDigest(originalPlan.outputs) ||
    plan.version !== originalPlan.version ||
    plan.contractRoot !== originalPlan.contractRoot ||
    recordDigest(materialization.source) !== recordDigest(previous.source)
  )
    throw new Error(
      "Signing recovery cannot change the already sealed product contract or source",
    );
  await reobservePublicationBuild(previous.build, previous.source, host);
  await reobservePipelineNativeQualification(
    previous,
    originalPlan,
    host,
    signingHost,
  );
  const products = await restorePipelineProducts(
    archive,
    previous,
    prepared.sealed,
    path.join(directory, "requalified-products"),
  );
  for (const manifest of originalManifests(previous))
    inspectPipelinePublicationArtifacts(products, manifest, plan);
  const { run } = await host.runs.read(context.runId, context.runAttempt);
  await readPipelineCaller(
    run,
    previous.source.configPath,
    host.request,
    host.repository,
  );
  const buildBody = {
    schema: "buildchain.pipeline-publication-requalification/v1",
    operation: "requalify-sealed-bytes",
    outcome: "success",
    planRoot: plan.root,
    source: previous.source,
    runId: context.runId,
    runAttempt: context.runAttempt,
    providerSource: run.head_sha,
    predecessorBuild: previous.build,
    sealedRoot: prepared.sealed.root,
  };
  const build = { ...buildBody, root: recordDigest(buildBody) };
  const qualification = createDomainPublicationQualificationReceipt({
    ...previous.qualification,
    candidateRoot: recordDigest({
      planRoot: plan.root,
      source: previous.source,
      artifacts: previous.artifacts,
      ...(previous.native ? { nativeRoot: previous.native.root } : {}),
    }),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const body = {
    schema: `buildchain.pipeline-publication-qualification/v${previous.native ? 2 : 1}`,
    planRoot: plan.root,
    source: previous.source,
    artifacts: previous.artifacts,
    build,
    qualification,
    predecessorRoot: previous.root,
    ...(previous.native ? { native: previous.native } : {}),
  };
  const qualified = { ...body, root: recordDigest(body) };
  const capsules = requalifyPublicationCapsules(
    prepared.capsules,
    qualified,
    plan,
  );
  const { root, ...sealedBody } = prepared.sealed;
  const sealedValue = {
    ...sealedBody,
    qualificationRoot: qualified.root,
    predecessorRoot: root,
  };
  const sealed = { ...sealedValue, root: recordDigest(sealedValue) };
  return {
    schema: "buildchain.pipeline-qualification-preparation/v1",
    contextRoot: recordDigest(context),
    qualified,
    capsules,
    sealed,
  };
}

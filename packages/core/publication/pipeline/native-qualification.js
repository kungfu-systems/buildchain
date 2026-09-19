import fs from "node:fs";
import { recordDigest } from "../../release/discussion/envelope.js";
import { publicationPath, verifyPipelineProductFiles } from "./files.js";
import { verifyPipelineNativeInputs } from "./native-inputs.js";
import { verifyPipelineNativeResults } from "./native-results.js";

export function verifyNativeFinalizationReadback(plan, source, finalized) {
  const { build, bundles } = finalized;
  const { root, ...body } = build;
  const platforms = [
    ...new Set(plan.nativeSigning.map((rule) => rule.platform)),
  ].sort();
  if (
    build.schema !== "buildchain.pipeline-native-finalization-readback/v1" ||
    root !== recordDigest(body) ||
    build.outcome !== "success" ||
    build.planRoot !== plan.root ||
    recordDigest(build.source) !== recordDigest(source) ||
    recordDigest(build.platforms) !== recordDigest(platforms) ||
    recordDigest(bundles.map((bundle) => bundle.manifest.platform).sort()) !==
      recordDigest(platforms) ||
    recordDigest(
      bundles.map((bundle) => bundle.providerArtifact.id).sort((a, b) => a - b),
    ) !== recordDigest(build.artifactIds) ||
    new Set(build.artifactIds).size !== platforms.length ||
    build.jobs.length !== platforms.length
  )
    throw new Error(
      "Native publication requires exact independent finalization readback",
    );
  for (const [position, platform] of platforms.entries()) {
    const job = build.jobs[position],
      name = `Finalize publication (${platform})`;
    if (
      job.run_id !== build.runId ||
      job.run_attempt !== build.runAttempt ||
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      !(job.name === name || job.name.endsWith(` / ${name}`))
    )
      throw new Error(
        "Native publication finalizer job differs from its declared platform",
      );
  }
}

export function qualifyNativeFinalizedBundle({
  plan,
  source,
  producerPlan,
  unsigned,
  finalized,
  signer,
}) {
  verifyNativeFinalizationReadback(plan, source, finalized);
  const platform = unsigned.manifest.platform;
  const matches = finalized.bundles.filter(
    (bundle) => bundle.manifest.platform === platform,
  );
  if (matches.length !== 1)
    throw new Error("Native publication has no unique finalized platform");
  const bundle = matches[0],
    { manifest, providerArtifact } = bundle;
  verifyPipelineProductFiles(bundle.directory, manifest);
  if (
    manifest.planRoot !== plan.root ||
    recordDigest(manifest.source) !== recordDigest(source) ||
    manifest.nativeSigning?.phase !== "finalized" ||
    manifest.nativeSigning.unsignedManifestRoot !== unsigned.manifest.root ||
    manifest.nativeSigning.files.length !== 1 ||
    manifest.nativeSigning.files[0].file !==
      `native-finalization-${platform}.json` ||
    providerArtifact.expired ||
    providerArtifact.workflow_run?.id !== finalized.build.runId ||
    providerArtifact.workflow_run?.head_sha !== finalized.build.providerSource
  )
    throw new Error(
      "Native finalized artifact differs from its admitted producer",
    );
  const lineage = JSON.parse(
    fs.readFileSync(
      publicationPath(bundle.directory, `native-finalization-${platform}.json`),
      "utf8",
    ),
  );
  const input = verifyPipelineNativeInputs({
    directory: unsigned.directory,
    manifest: unsigned.manifest,
    plan: producerPlan,
    source,
  });
  const verified = verifyPipelineNativeResults({
    input,
    directory: signer.directory,
    operation: signer.operation,
    authority: signer.proof,
    plan: producerPlan,
    platform,
  });
  const expected = {
    schema: "buildchain.pipeline-native-finalization/v1",
    unsignedManifestRoot: unsigned.manifest.root,
    producerPlanRoot: producerPlan.root,
    operation: signer.operation,
    authority: signer.proof,
    verified,
  };
  if (
    recordDigest(lineage) !== recordDigest(expected) ||
    manifest.nativeSigning.authorityRoot !== signer.proof.root ||
    manifest.nativeSigning.operationRoot !== recordDigest(signer.operation)
  )
    throw new Error(
      "Native finalization evidence differs from independently verified signing",
    );
  for (const signed of verified.replacements) {
    const artifact = manifest.artifacts.find((item) => item.id === signed.id);
    if (
      !artifact ||
      artifact.digest !== signed.digest ||
      artifact.size !== signed.size
    )
      throw new Error(
        "Native final publication changed its required signed bytes",
      );
  }
  const signedProducts = new Set(
    plan.nativeSigning
      .filter((rule) => rule.platform === platform)
      .map((rule) => rule.product),
  );
  for (const artifact of manifest.artifacts.filter(
    (item) => !signedProducts.has(item.product),
  )) {
    const original = unsigned.manifest.artifacts.find(
      (item) => item.id === artifact.id,
    );
    if (recordDigest(original) !== recordDigest(artifact))
      throw new Error(
        "Native finalization changed an unrelated sealed product",
      );
  }
  const proof = {
    platform,
    producerPlan,
    unsignedManifest: unsigned.manifest,
    finalManifest: manifest,
    finalizer: finalized.build,
    providerArtifact,
    lineage,
  };
  return { bundle, proof };
}

function rooted(value, schema) {
  const { root, ...body } = value || {};
  if (body.schema !== schema || root !== recordDigest(body))
    throw new Error(
      "Native retained qualification has invalid rooted evidence",
    );
}

function verifyNativeSignedArtifacts(qualified, proof, rules) {
  const { lineage, finalManifest } = proof;
  const expectedIds = rules
    .filter((rule) => rule.platform === proof.platform)
    .map((rule) => rule.id);
  const expectedArtifacts = rules
    .filter((rule) => rule.platform === proof.platform)
    .flatMap((rule) =>
      [rule.artifact, ...(rule.installer ? [rule.installer] : [])].map(
        (artifact) => `${rule.product}/${proof.platform}/${artifact}`,
      ),
    )
    .sort();
  if (
    recordDigest(
      lineage.verified.replacements.map((item) => item.id).sort(),
    ) !== recordDigest(expectedArtifacts)
  )
    throw new Error(
      "Native retained qualification omitted a required signed output",
    );
  if (
    recordDigest(lineage.verified.receipts.map((item) => item.id)) !==
    recordDigest(expectedIds)
  )
    throw new Error(
      "Native retained qualification omitted a required signing receipt",
    );
  for (const replacement of lineage.verified.replacements) {
    const artifact = qualified.artifacts.find(
      (item) => item.id === replacement.id,
    );
    if (
      !artifact ||
      artifact.digest !== replacement.digest ||
      artifact.size !== replacement.size ||
      artifact.manifestRoot !== finalManifest.root ||
      artifact.providerArtifactId !== proof.providerArtifact.id
    )
      throw new Error(
        "Native retained qualification changed its final signed artifact",
      );
  }
}

export function verifyRetainedNativeQualification(qualified, plan) {
  const rules = plan.nativeSigning || [];
  if (!rules.length) {
    if (qualified.native !== undefined)
      throw new Error(
        "Unsigned qualification contains undeclared native evidence",
      );
    return;
  }
  const native = qualified.native;
  rooted(native, "buildchain.pipeline-native-qualification/v1");
  const platforms = [...new Set(rules.map((rule) => rule.platform))].sort();
  if (
    recordDigest(native.platforms.map((proof) => proof.platform)) !==
    recordDigest(platforms)
  )
    throw new Error(
      "Native retained qualification changed its platform inventory",
    );
  for (const proof of native.platforms) {
    rooted(proof.finalManifest, "buildchain.pipeline-publication-products/v2");
    rooted(
      proof.unsignedManifest,
      "buildchain.pipeline-publication-products/v2",
    );
    rooted(
      proof.finalizer,
      "buildchain.pipeline-native-finalization-readback/v1",
    );
    rooted(
      proof.lineage.authority,
      "buildchain.pipeline-native-authority-readback/v1",
    );
    const { lineage, finalManifest, unsignedManifest } = proof;
    if (
      finalManifest.nativeSigning?.phase !== "finalized" ||
      finalManifest.nativeSigning.unsignedManifestRoot !==
        unsignedManifest.root ||
      lineage.unsignedManifestRoot !== unsignedManifest.root ||
      lineage.authority.operationRoot !== recordDigest(lineage.operation) ||
      lineage.authority.root !== finalManifest.nativeSigning.authorityRoot ||
      lineage.verified.authorityRoot !== lineage.authority.root ||
      lineage.verified.requestRoot !==
        unsignedManifest.nativeSigning.indexRoot ||
      lineage.operation.requestRoot !==
        unsignedManifest.nativeSigning.indexRoot ||
      lineage.authority.runtimeSha !== proof.producerPlan.runtime.commit ||
      lineage.producerPlanRoot !== proof.producerPlan.root ||
      proof.finalizer.planRoot !== finalManifest.planRoot ||
      recordDigest(finalManifest.source) !== recordDigest(qualified.source) ||
      !proof.finalizer.artifactIds.includes(proof.providerArtifact.id)
    )
      throw new Error(
        "Native retained qualification changed its producer or signing lineage",
      );
    verifyNativeSignedArtifacts(qualified, proof, rules);
  }
  return native;
}

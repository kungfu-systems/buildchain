import fs from "node:fs";
import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import { inspectPipelineSource } from "../../workflow/pipeline/build.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
import { createNativeChildEnvironment } from "../../dev-delivery/native/execution.js";
import { verifyPipelineNativeInputs } from "./native-inputs.js";
import { verifyPipelineNativeResults } from "./native-results.js";
import { nativeResultFiles } from "./native-retention.js";
import { inspectPipelineFileArtifact } from "./pack.js";
import {
  publicationPath,
  publicationFile,
  writeImmutablePublicationFile,
} from "./files.js";

function outputTarget(cwd, artifact) {
  const root = fs.realpathSync(cwd);
  const target = path.resolve(root, artifact.directory, artifact.path);
  if (!target.startsWith(`${root}${path.sep}`))
    throw new Error("Native finalization output escapes its source checkout");
  return target;
}

function restoreUnsignedOutputs(cwd, bundle) {
  for (const artifact of bundle.manifest.artifacts) {
    if (artifact.kind === "npm-package") continue;
    const bytes = publicationFile(
      publicationPath(bundle.directory, artifact.file),
    );
    writeImmutablePublicationFile(outputTarget(cwd, artifact), bytes.bytes);
  }
}

function importSignedOutputs(cwd, bundle, signed, verified) {
  for (const replacement of verified.replacements) {
    const artifact = bundle.manifest.artifacts.find(
      (item) => item.id === replacement.id,
    );
    const file = publicationPath(
      cwd,
      path.relative(cwd, outputTarget(cwd, artifact)),
    );
    const unsigned = publicationFile(file);
    if (unsigned.digest !== artifact.digest || unsigned.size !== artifact.size)
      throw new Error(
        "Native finalization cannot replace an unrecognized unsigned artifact",
      );
    const bytes = publicationFile(publicationPath(signed, replacement.file));
    if (bytes.digest !== replacement.digest || bytes.size !== replacement.size)
      throw new Error("Native signed bytes changed before finalization import");
    fs.writeFileSync(file, bytes.bytes);
  }
}

function preserveSignedOutputs(cwd, bundle, verified) {
  for (const replacement of verified.replacements) {
    const artifact = bundle.manifest.artifacts.find(
      (item) => item.id === replacement.id,
    );
    const observed = publicationFile(
      publicationPath(cwd, path.relative(cwd, outputTarget(cwd, artifact))),
    );
    if (
      observed.digest !== replacement.digest ||
      observed.size !== replacement.size
    )
      throw new Error(
        "Product finalization changed required native signed bytes",
      );
  }
}

function sealFinalizedProducts({ cwd, output, plan, bundle, lineage }) {
  fs.mkdirSync(output, { recursive: true });
  const finalizedProducts = new Set(
    plan.nativeSigning
      .filter((rule) => rule.platform === bundle.manifest.platform)
      .map((rule) => rule.product),
  );
  const artifacts = bundle.manifest.artifacts.map((artifact) => {
    const file =
      artifact.kind === "npm-package" ||
      !finalizedProducts.has(artifact.product)
        ? publicationPath(bundle.directory, artifact.file)
        : inspectPipelineFileArtifact(
            publicationPath(cwd, artifact.directory, "directory"),
            artifact,
          ).file;
    const observed = publicationFile(file);
    writeImmutablePublicationFile(
      path.join(output, artifact.file),
      observed.bytes,
    );
    return { ...artifact, digest: observed.digest, size: observed.size };
  });
  const file = `native-finalization-${bundle.manifest.platform}.json`;
  writeImmutablePublicationFile(
    path.join(output, file),
    `${JSON.stringify(lineage, null, 2)}\n`,
  );
  const observed = publicationFile(path.join(output, file));
  const body = {
    schema: "buildchain.pipeline-publication-products/v2",
    planRoot: plan.root,
    source: bundle.manifest.source,
    platform: bundle.manifest.platform,
    artifacts,
    nativeSigning: {
      phase: "finalized",
      unsignedManifestRoot: bundle.manifest.root,
      authorityRoot: lineage.authority.root,
      operationRoot: recordDigest(lineage.operation),
      files: [{ file, digest: observed.digest, size: observed.size }],
    },
  };
  const manifest = { ...body, root: recordDigest(body) };
  writeImmutablePublicationFile(
    path.join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

// Only a credentialless product job invokes these declared consumer commands.
// The signed bytes remain immutable; independent qualification admits the job
// and re-reads the original signing authority before publication.
export async function finalizePipelineNativeProducts(
  {
    cwd,
    output,
    plan,
    source,
    bundle,
    signedDirectory,
    operation,
    authority,
    producerPlan = plan,
    environment = process.env,
  },
  { inspect = inspectPipelineSource, session = consumerCommandSession } = {},
) {
  const contract = inspect(cwd, source);
  if (recordDigest(contract) !== plan.contractRoot)
    throw new Error(
      "Native finalization source changed its declared product contract",
    );
  const input = verifyPipelineNativeInputs({
    directory: bundle.directory,
    manifest: bundle.manifest,
    plan: producerPlan,
    source,
  });
  const verified = verifyPipelineNativeResults({
    input,
    directory: signedDirectory,
    operation,
    authority,
    plan: producerPlan,
    platform: bundle.manifest.platform,
  });
  restoreUnsignedOutputs(cwd, bundle);
  importSignedOutputs(cwd, bundle, signedDirectory, verified);
  for (const relative of nativeResultFiles(signedDirectory)) {
    const bytes = publicationFile(publicationPath(signedDirectory, relative));
    writeImmutablePublicationFile(
      path.join(
        cwd,
        ".buildchain",
        "native-signing",
        bundle.manifest.platform,
        relative,
      ),
      bytes.bytes,
    );
  }
  for (const product of contract.products.filter(
    (item) =>
      item.signing?.length && item.platforms.includes(bundle.manifest.platform),
  )) {
    const commands = session(createNativeChildEnvironment(environment));
    const directory = publicationPath(
      cwd,
      product.directory || ".",
      "directory",
    );
    for (const phase of ["install", "finalize"])
      for (const script of product[phase] || [])
        await commands.run({ script, cwd: directory, strict: true });
  }
  inspect(cwd, source);
  preserveSignedOutputs(cwd, bundle, verified);
  const lineage = {
    schema: "buildchain.pipeline-native-finalization/v1",
    unsignedManifestRoot: bundle.manifest.root,
    producerPlanRoot: producerPlan.root,
    operation,
    authority,
    verified,
  };
  return sealFinalizedProducts({ cwd, output, plan, bundle, lineage });
}

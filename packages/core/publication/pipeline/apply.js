import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { recordDigest } from "../../release/discussion/envelope.js";
import { canonicalJson } from "../../release/discussion/envelope.js";
import {
  createReleaseReceipt,
  RELEASE_RECEIPT_CONTRACT,
} from "../../release/release-invocation.js";
import { githubPipelineProductRelease } from "../../providers/github/pipeline-product-release.js";
import { pipelineNpmProvider } from "../npm/pipeline-provider.js";
import { publicationContext, uniquePublicationMaterial } from "./context.js";
import { restorePipelineProducts } from "./sealed-products.js";
import { pipelineReleaseDocuments } from "./documents.js";
import { writeImmutablePublicationFile } from "./files.js";
import { verifyPipelineSigning } from "./signing.js";
import { pipelinePublicationEffects, applyPipelineEffects } from "./effects.js";

export async function applyPipelinePublication(
  context,
  host,
  directory,
  environment,
) {
  const { journal, archive } = await publicationContext(context, host);
  const retained = await uniquePublicationMaterial(
    journal,
    "publication/qualified/",
  );
  const { plan, materialization } = context;
  const { qualified, capsules, sealed } = retained;
  const products = await restorePipelineProducts(
    archive,
    qualified,
    sealed,
    path.join(directory, "sealed-products"),
  );
  const bundlePath = writeImmutablePublicationFile(
    path.join(directory, "attestation.json"),
    await archive.read(retained.bundle),
  );
  const signing = verifyPipelineSigning({
    plan,
    materialization,
    qualified,
    bundlePath,
    directory: path.join(directory, "signing-readback"),
    token: host.token,
  });
  const documents = pipelineReleaseDocuments({
    plan,
    materialization,
    qualified,
    capsules,
    signing,
  });
  if (
    recordDigest(documents) !== recordDigest(retained.documents) ||
    recordDigest(signing) !== recordDigest(retained.signing)
  )
    throw new Error(
      "Retained release documents changed during publisher admission",
    );
  const npm = pipelineNpmProvider({
    directory: products,
    artifacts: qualified.artifacts,
    environment,
  });
  const evidence = Object.entries({
    qualification: Buffer.from(`${canonicalJson(qualified)}\n`),
    capsules: Buffer.from(`${canonicalJson(capsules)}\n`),
    invocation: Buffer.from(
      `${canonicalJson(documents.invocation.invocation)}\n`,
    ),
    attestation: fs.readFileSync(bundlePath),
  }).map(([id, bytes]) => ({
    id,
    name: `buildchain.${id}.json`,
    bytes,
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  }));
  const github = githubPipelineProductRelease({
    ...host,
    plan,
    qualified,
    documents,
    directory: products,
    evidence,
  });
  const providerFor = (effect) =>
    effect.kind === "npm-package" ? npm : github;
  const provider = {
    observe: (effect) => providerFor(effect).observe(effect),
    matches: (effect, value) => providerFor(effect).matches(effect, value),
    apply: (effect) => providerFor(effect).apply(effect),
  };
  const effects = pipelinePublicationEffects({
    plan,
    qualified,
    documents,
    evidence: evidence.map(({ bytes, ...asset }) => asset),
  });
  const results = await applyPipelineEffects({
    effects,
    transactionRoot: documents.transaction.transactionRoot,
    receipts: await journal.materials("publication/effect/"),
    provider,
    fence: journal.fence,
    retain: (receipt) => journal.record("publication/effect", receipt),
  });
  const receipt = createReleaseReceipt({
    schema: RELEASE_RECEIPT_CONTRACT,
    transactionRoot: documents.transaction.transactionRoot,
    outcome: "complete",
    releasePassportRoot: documents.passport.passportRoot,
    providerTransactionRoot: recordDigest(effects),
    providerStateRoot: recordDigest(results),
    providerReceiptRoots: [...new Set(results.map(({ root }) => root))].sort(),
  });
  // This is publication success only. Distribution and next-development remain
  // separate mandatory nodes of the same business attempt.
  const complete = {
    schema: "buildchain.pipeline-publication-complete/v1",
    release: receipt,
    completedAt: new Date().toISOString(),
  };
  await journal.record("publication/complete", complete, { state: "success" });
  return complete;
}

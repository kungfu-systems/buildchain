import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicationFixture } from "./pipeline-publication-session.mjs";
import { preparePipelinePublication } from "../../packages/core/publication/pipeline/prepare.js";
import { publicationContext } from "../../packages/core/publication/pipeline/context.js";
import { buildPipelineProducts } from "../../packages/core/workflow/pipeline/build.js";
import { packPipelineProducts } from "../../packages/core/publication/pipeline/pack.js";
import { qualifyPipelineProducts } from "../../packages/core/publication/pipeline/qualification.js";
import { pipelineProductCapsules } from "../../packages/core/publication/pipeline/capsules.js";
import { retainPipelineProducts } from "../../packages/core/publication/pipeline/sealed-products.js";
import {
  preparePipelineSigning,
  verifyPipelineSigning,
} from "../../packages/core/publication/pipeline/signing.js";
import { pipelineReleaseDocuments } from "../../packages/core/publication/pipeline/documents.js";
import { recordDigest } from "../../packages/core/release/discussion/envelope.js";

export async function signedPublicationFixture(t, { jobs, issuedAt } = {}) {
  const f = await publicationFixture(),
    host = f.f.host;
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-apply-recovery-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { context } = await preparePipelinePublication(
    f.attempt,
    f.publisher,
    host,
  );
  const { session, journal, archive } = await publicationContext(context, host);
  const cwd = path.join(root, "source"),
    directory = path.join(root, "packed");
  fs.cpSync("templates/minimal-consumer/npm", cwd, { recursive: true });
  await buildPipelineProducts({
    cwd,
    plan: f.f.admission.plan,
    platform: "linux-x64",
  });
  const source = context.materialization.source;
  const manifest = packPipelineProducts({
    cwd,
    output: directory,
    plan: context.plan,
    source,
    platform: "linux-x64",
  });
  const body = {
    schema: "buildchain.pipeline-publication-build-readback/v1",
    outcome: "success",
    planRoot: context.plan.root,
    source,
    platforms: ["linux-x64"],
    artifactIds: [1],
    runId: 200,
    runAttempt: 1,
    providerSource: "6".repeat(40),
    ...(jobs ? { jobs } : {}),
  };
  const bundles = [
    {
      directory,
      manifest,
      providerArtifact: {
        id: 1,
        expired: false,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        workflow_run: { id: 200 },
      },
    },
  ];
  // Deliberately expired original authorization. Recovery must preserve the
  // signed transaction while obtaining a fresh current runtime admission.
  const issued = issuedAt ? new Date(issuedAt) : new Date(Date.now() - 7200000);
  const qualified = qualifyPipelineProducts({
    plan: context.plan,
    source,
    bundles,
    build: { ...body, root: recordDigest(body) },
    policyRoot: context.plan.contractRoot,
    now: issued,
  });
  const capsules = pipelineProductCapsules({
    ...context,
    qualified,
    bundles,
    evaluatedAt: issued.toISOString(),
  });
  const sealed = await retainPipelineProducts(archive, qualified, bundles);
  const signing = signedObservation(context, qualified, root, issued);
  const bundle = await archive.put(Buffer.from("injected signature bundle"));
  const documents = pipelineReleaseDocuments({
    ...context,
    qualified,
    capsules,
    signing: signing.value,
    evaluatedAt: issued.toISOString(),
  });
  const retained = {
    schema: "buildchain.pipeline-qualified-products/v1",
    contextRoot: recordDigest(context),
    qualified,
    capsules,
    sealed,
    signing: signing.value,
    bundle,
    documents,
  };
  await journal.record("publication/qualified", retained);
  return {
    ...f,
    host,
    root,
    context,
    session,
    journal,
    archive,
    retained,
    verifySigning: signing.verify,
  };
}

function signedObservation(context, qualified, root, issued) {
  const input = {
    ...context,
    qualified,
    directory: path.join(root, "signing"),
    evaluatedAt: issued.toISOString(),
  };
  const prepared = preparePipelineSigning(input);
  const bundlePath = path.join(root, "fixture-bundle.json");
  fs.writeFileSync(bundlePath, "injected signature bundle");
  // Signature-verifier IO is injected; all original predicate, subject,
  // publisher and source bindings are still checked by the real adapter.
  const execute = () =>
    JSON.stringify([
      {
        verificationResult: {
          statement: {
            predicateType: prepared.predicateType,
            predicate: prepared.predicate,
            subject: [{ digest: { sha256: prepared.subjectDigest } }],
          },
        },
      },
    ]);
  const verify = (options) => verifyPipelineSigning({ ...options, execute });
  return { value: verify({ ...input, bundlePath, token: "fixture" }), verify };
}

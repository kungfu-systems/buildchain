import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import { verifyPipelinePublicationPlan } from "./plan.js";
import {
  verifyPipelineQualification,
  pipelineReleaseDocuments,
} from "./documents.js";
import { restorePipelineProducts } from "./sealed-products.js";
import { verifyPipelineSigning } from "./signing.js";
import { writeImmutablePublicationFile } from "./files.js";
import {
  readRecoveryPublicationMaterials,
  recoveryPublicationMaterial,
  publicationLineageMaterial,
} from "./recovery-materials.js";
import { planRecoveryPublicationBuild } from "./recovery-build-plan.js";
import { qualifyRecoveryIntegration } from "../../workflow/pipeline/recovery-integration.js";

async function inspectRetainedBytes(
  { plan, materialization, retained, archive, host },
  verifySigning,
) {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "buildchain-publication-recovery-"),
  );
  try {
    // Historical validation proves the original document's integrity only.
    // Fresh execution authorization is a separate admission before any effect.
    const evaluatedAt = retained.qualified.qualification.issuedAt;
    verifyPipelineQualification({
      plan,
      materialization,
      qualified: retained.qualified,
      evaluatedAt,
    });
    await restorePipelineProducts(
      archive,
      retained.qualified,
      retained.sealed,
      path.join(directory, "products"),
    );
    if (!retained.signing)
      return { sealed: retained.sealed.root, signing: null };
    const bundlePath = writeImmutablePublicationFile(
      path.join(directory, "attestation.json"),
      await archive.read(retained.bundle),
    );
    const signing = verifySigning({
      plan,
      materialization,
      qualified: retained.qualified,
      bundlePath,
      directory: path.join(directory, "signing"),
      token: host.token,
      evaluatedAt,
    });
    const documents = pipelineReleaseDocuments({
      plan,
      materialization,
      qualified: retained.qualified,
      capsules: retained.capsules,
      signing,
      evaluatedAt,
    });
    if (
      recordDigest(signing) !== recordDigest(retained.signing) ||
      recordDigest(documents) !== recordDigest(retained.documents)
    )
      throw new Error(
        "Recovery signature or original release documents changed",
      );
    return {
      sealed: retained.sealed.root,
      signing: recordDigest(signing),
      documents: recordDigest(documents),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function inspectRecoveryPublication(
  session,
  admitted,
  host,
  { verifySigning = verifyPipelineSigning } = {},
) {
  const integration = await qualifyRecoveryIntegration(
    session,
    admitted.admission,
    host,
  );
  const materials = await readRecoveryPublicationMaterials(session, host);
  const plan = recoveryPublicationMaterial(materials, "publication/plan/");
  if (!plan) {
    if (materials.some((item) => !item.id.startsWith("publication/worker/")))
      throw new Error(
        "Publication recovery has materials without their authoritative plan",
      );
    return {
      schema: "buildchain.pipeline-recovery-publication/v1",
      mode: "unprepared",
      integration,
      materials,
    };
  }
  verifyPipelinePublicationPlan(plan);
  const original = session.observed.history.find(
    (item) => item.identity.id === plan.attempt,
  );
  if (
    !original ||
    plan.generation !== session.observed.generation ||
    recordDigest(plan.intentSource) !==
      recordDigest(original.generation.source) ||
    plan.source.commit !== integration.integration.mergeCommit
  )
    throw new Error(
      "Recovered publication plan changed its original source or protected integration",
    );
  const materialization = recoveryPublicationMaterial(
    materials,
    "publication/materialization/",
  );
  if (!materialization)
    return {
      schema: "buildchain.pipeline-recovery-publication/v1",
      mode: "materialize",
      integration,
      materials,
    };
  const source = await host.source.source(
    materialization.source.commit,
    plan.source.configPath,
  );
  if (
    recordDigest(source.identity) !== recordDigest(materialization.source) ||
    recordDigest(source.plan) !== plan.contractRoot
  )
    throw new Error(
      "Recovered publication materialization changed its exact source or contract",
    );
  const qualified = recoveryPublicationMaterial(
    materials,
    "publication/qualified/",
  );
  const prepared =
    materials
      .filter((item) =>
        item.id.startsWith("publication/qualification-prepared/"),
      )
      .at(-1)?.value ||
    recoveryPublicationMaterial(materials, "publication/predecessor-prepared/");
  const retained = qualified || prepared;
  if (
    !qualified &&
    materials.some((item) => item.id.startsWith("publication/effect/"))
  )
    throw new Error(
      "Partial publication lost its original signed qualification; rebuilding cannot replace published bytes",
    );
  const originalPlan = retained
    ? publicationLineageMaterial(
        materials,
        "buildchain.pipeline-publication-plan/v1",
        (value) => value.root === retained.qualified.planRoot,
      )
    : plan;
  const originalMaterialization = retained
    ? publicationLineageMaterial(
        materials,
        "buildchain.pipeline-version-materialization/v1",
        (value) =>
          value.planRoot === originalPlan.root &&
          recordDigest(value.source) ===
            recordDigest(retained.qualified.source),
      )
    : materialization;
  if (
    originalPlan.version !== plan.version ||
    originalPlan.contractRoot !== plan.contractRoot ||
    recordDigest(originalPlan.outputs) !== recordDigest(plan.outputs)
  )
    throw new Error(
      "Recovered publication lineage changed the sealed product contract",
    );
  const readback = retained
    ? await inspectRetainedBytes(
        {
          plan: originalPlan,
          materialization: originalMaterialization,
          retained,
          archive: host.productArchive(session),
          host,
        },
        verifySigning,
      )
    : null;
  return {
    schema: "buildchain.pipeline-recovery-publication/v1",
    mode: qualified ? "qualified" : prepared ? "prepared" : "build",
    integration,
    materials,
    readback,
    preparedRoot: prepared ? recordDigest(prepared) : null,
    build: retained
      ? null
      : await planRecoveryPublicationBuild(
          session,
          plan,
          materialization,
          materials,
          host,
        ),
  };
}
